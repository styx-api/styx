import type {
  BindingId,
  BoundType,
  GateAtom,
  ResolvedOutput,
  ResolvedToken,
} from "../../bindings/index.js";
import { outputGate } from "../../bindings/index.js";
import type { Documentation, Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { PY_KEYWORDS, emitDocstring } from "./emit.js";
import { pyStr, renderAccess } from "./typemap.js";

/**
 * A `ResolvedOutput` plus a `mutable` marker. A mutable input file is surfaced
 * as an output: its single ref token points at the input binding, and the
 * builder emits `execution.mutable_copy(<value>)` (the host path of the writable
 * copy the runner staged for the matching `input_file(..., mutable=True)` call)
 * instead of `execution.output_file(...)`.
 */
type EmittedOutput = ResolvedOutput & { mutable?: boolean };

/**
 * Field shape for a single resolved output.
 *
 * - `single`: emitted at most once. Optional iff any `present`/`variant` atom
 *   appears in the gate -> `OutputPathType | None`.
 * - `list`: emitted once per element of an iterated binding (any `iter`
 *   atom in the gate) -> `list[OutputPathType]`. Gated lists still type as
 *   `list[OutputPathType]` - the empty list stands for "nothing produced".
 */
type OutputShape = { kind: "single"; optional: boolean } | { kind: "list" };

function outputShape(gate: GateAtom[]): OutputShape {
  const iter = gate.some((a) => a.kind === "iter");
  if (iter) return { kind: "list" };
  const optional = gate.some((a) => a.kind === "present" || a.kind === "variant");
  return { kind: "single", optional };
}

function outputTypeExpr(shape: OutputShape): string {
  if (shape.kind === "list") return "list[OutputPathType]";
  return shape.optional ? "OutputPathType | None" : "OutputPathType";
}

/**
 * Merge two shapes for outputs that share a field name across scopes/variants.
 * Any iterated contributor makes the field a list; otherwise it is a single
 * field that is optional if any contributor is gated.
 */
function mergeShape(a: OutputShape, b: OutputShape): OutputShape {
  if (a.kind === "list" || b.kind === "list") return { kind: "list" };
  return { kind: "single", optional: a.optional || b.optional };
}

/** One emitted Outputs field, deduped across same-named outputs. */
interface OutputField {
  /** Sanitized Python field identifier. */
  id: string;
  shape: OutputShape;
  doc?: string;
}

/**
 * Collect the unique Outputs fields in first-seen order, merging the shape and
 * doc of any outputs that resolve to the same field id. Multiple scopes (e.g.
 * the arms of a union output) routinely declare the same output name; without
 * deduping, the dataclass would emit duplicate fields and the constructor
 * duplicate keyword arguments (a Python SyntaxError).
 */
function collectOutputFields(ctx: CodegenContext): OutputField[] {
  const byId = new Map<string, OutputField>();
  const add = (output: EmittedOutput, scopeGate: GateAtom[]): void => {
    const gate = outputGate(scopeGate, output, ctx.bindings);
    const shape = outputShape(gate);
    const id = pyId(output.name);
    const doc = output.doc?.description ?? output.doc?.title;
    const existing = byId.get(id);
    if (existing) {
      existing.shape = mergeShape(existing.shape, shape);
      if (!existing.doc && doc) existing.doc = doc;
    } else {
      byId.set(id, { id, shape, doc });
    }
  };
  for (const scope of ctx.outputScopes) {
    const scopeBinding = ctx.bindings.get(scope.scope);
    const scopeGate = scopeBinding?.gate ?? [];
    for (const output of scope.outputs) add(output, scopeGate);
  }
  // Mutable inputs surface as outputs; their binding gate is absolute (rooted),
  // so the scope gate is empty.
  for (const output of collectMutableOutputs(ctx)) add(output, []);
  return [...byId.values()];
}

/** Has any scope in the context attached at least one output? */
export function hasAnyOutputs(ctx: CodegenContext): boolean {
  return ctx.outputScopes.some((s) => s.outputs.length > 0);
}

/** A captured stream (stdout/stderr) surfaced as a `list[str]` Outputs field. */
interface StreamField {
  id: string;
  doc?: string;
}

/**
 * The stdout/stderr fields declared by the app metadata, in declaration order
 * (stdout before stderr). Stream outputs are app-level: they are never gated
 * (always present when the tool runs), so they bypass the solver/gating
 * machinery and surface as plain `list[str]` fields the wrapper appends to via
 * `handle_stdout` / `handle_stderr`.
 */
function streamFields(ctx: CodegenContext): StreamField[] {
  const out: StreamField[] = [];
  // Seed with the file/mutable output field ids so a stream whose name collides
  // with a real output (e.g. an output literally named "stdout") is bumped
  // rather than emitting a duplicate dataclass field / repeated constructor kwarg.
  const used = new Set<string>(collectOutputFields(ctx).map((f) => f.id));
  const add = (name: string, doc?: string): void => {
    let id = pyId(name);
    while (used.has(id)) id += "_";
    used.add(id);
    out.push({ id, doc });
  };
  const so = ctx.app?.stdout;
  const se = ctx.app?.stderr;
  if (so) add(so.name, so.doc?.description ?? so.doc?.title);
  if (se) add(se.name, se.doc?.description ?? se.doc?.title);
  return out;
}

/** Does the app declare any stdout/stderr stream output? */
export function hasStreamOutputs(ctx: CodegenContext): boolean {
  return !!(ctx.app?.stdout || ctx.app?.stderr);
}

/** Field ids for stdout/stderr (in declaration order), for wrapper wiring. */
export function streamFieldIds(ctx: CodegenContext): { stdout?: string; stderr?: string } {
  const fields = streamFields(ctx);
  const res: { stdout?: string; stderr?: string } = {};
  let idx = 0;
  if (ctx.app?.stdout) res.stdout = fields[idx++]!.id;
  if (ctx.app?.stderr) res.stderr = fields[idx++]!.id;
  return res;
}

/**
 * Synthesize one output per mutable file input. Each is a `ResolvedOutput` with
 * a single ref token to the input binding and the `mutable` marker. The input
 * binding's solver-assigned gate fully encodes its ancestry (optional/variant/
 * iterated), so `outputGate([], ...)` yields the correct shape and gating for
 * free - no scope bucket needed.
 */
export function collectMutableOutputs(ctx: CodegenContext): EmittedOutput[] {
  const out: EmittedOutput[] = [];
  const seen = new Set<BindingId>();
  const walk = (node: Expr, inheritedDoc?: Documentation): void => {
    if (node.kind === "path") {
      if (node.attrs.mutable) {
        const binding = ctx.resolve(node);
        if (binding && !seen.has(binding.id)) {
          seen.add(binding.id);
          const doc = node.meta?.doc ?? inheritedDoc;
          out.push({
            name: binding.name,
            tokens: [{ kind: "ref", binding: binding.id }],
            ...(doc && { doc }),
            mutable: true,
          });
        }
      }
      return;
    }
    switch (node.kind) {
      case "sequence":
        for (const child of node.attrs.nodes) walk(child);
        break;
      case "optional":
      case "repeat":
        walk(node.attrs.node, node.meta?.doc ?? inheritedDoc);
        break;
      case "alternative":
        for (const alt of node.attrs.alts) walk(alt, node.meta?.doc ?? inheritedDoc);
        break;
    }
  };
  walk(ctx.expr);
  return out;
}

/** Does the tool have any mutable file input (surfaced as an output)? */
export function hasMutableInputs(ctx: CodegenContext): boolean {
  return collectMutableOutputs(ctx).length > 0;
}

/** Emit `@dataclasses.dataclass\nclass <outputsType>:` declaration. */
export function emitOutputsClass(ctx: CodegenContext, outputsType: string, cb: CodeBuilder): void {
  cb.line("@dataclasses.dataclass");
  cb.line(`class ${outputsType}:`);
  cb.indent(() => {
    emitDocstring(cb, "Output paths produced by the tool.");
    const fields = collectOutputFields(ctx);
    const streams = streamFields(ctx);
    if (fields.length === 0 && streams.length === 0) {
      cb.line("pass");
      return;
    }
    for (const field of fields) {
      cb.line(`${field.id}: ${outputTypeExpr(field.shape)}`);
      if (field.doc) emitDocstring(cb, field.doc);
    }
    for (const s of streams) {
      cb.line(`${s.id}: list[str]`);
      if (s.doc) emitDocstring(cb, s.doc);
    }
  });
}

/**
 * Substitutions for ref access while inside an iteration loop, and how `iter`
 * segments in a binding's access path are resolved at emit time.
 */
type IterScope = Map<BindingId, string>;

interface OutputEmitCtx {
  ctx: CodegenContext;
  iter: IterScope;
  /**
   * Prefix substitutions for optional fields narrowed by an enclosing presence
   * gate: maps a rendered access prefix to the `.get()`-narrowed local holding
   * it. Threaded into `renderAccess` so reads use the local (one lookup, absent-
   * safe, mypy-narrowable) - mirrors the cargs builder's `valueSubst`.
   */
  subst: ReadonlyMap<string, string>;
}

interface WrapperRender {
  open: string;
  loopVar?: string;
  /** A `local = params.get(...)` line emitted before `open` (optional gates). */
  bindLine?: string;
  /** `[accessPrefix, local]` to add to the child scope's `subst` map. */
  subst?: [string, string];
}

let loopCounter = 0;

function renderWrapperOpen(atom: GateAtom, ec: OutputEmitCtx): WrapperRender {
  if (atom.kind === "iter") {
    const access = bindingAccess(atom.binding, ec);
    const v = `__o${loopCounter++}`;
    return { open: `for ${v} in ${access}:`, loopVar: v };
  }
  if (atom.kind === "variant") {
    const access = bindingAccess(atom.binding, ec);
    return { open: `if ${access}["@type"] == ${pyStr(atom.variant)}:` };
  }
  // present
  const binding = ec.ctx.bindings.get(atom.binding);
  if (binding?.type.kind === "optional") {
    // Optional fields are NotRequired - the factory omits absent ones. Bind the
    // value to a narrowed local read via `.get()` (a bare subscript would
    // KeyError) and redirect inner reads to it via `subst`. Mirrors walkOptional.
    const subscriptAccess = bindingAccess(atom.binding, ec);
    const getAccess = bindingAccess(atom.binding, ec, true);
    const local = `__v${loopCounter++}`;
    return {
      open: `if ${local} is not None:`,
      bindLine: `${local} = ${getAccess}`,
      subst: [subscriptAccess, local],
    };
  }
  const access = bindingAccess(atom.binding, ec);
  const cond = presentCondition(binding?.type, access);
  return { open: `if ${cond}:` };
}

function presentCondition(type: BoundType | undefined, access: string): string {
  if (!type) return access;
  switch (type.kind) {
    case "optional":
      return `${access} is not None`;
    case "bool":
      return access;
    case "count":
      return `${access} > 0`;
    default:
      return access;
  }
}

function bindingAccess(id: BindingId, ec: OutputEmitCtx, finalGet = false): string {
  // The binding is itself the currently-iterated element (a ref to the list
  // being looped, or a scalar list element): use its loop variable directly.
  const iterVar = ec.iter.get(id);
  if (iterVar) return iterVar;
  const binding = ec.ctx.bindings.get(id);
  if (binding) {
    // Solver-assigned path; `iter` segments resolve to the loop variable bound
    // by the surrounding `iter` gate atom. `finalGet` renders the last field
    // segment as `.get()` when binding an optional's value; `subst` redirects an
    // optional prefix to the narrowed local bound by its presence gate.
    return renderAccess(
      binding.access,
      (b) => ec.iter.get(b) ?? `None  # unresolved loop var ${b}`,
      {
        finalFieldGet: finalGet,
        subst: ec.subst,
      },
    );
  }
  return `None  # unresolved binding ${id}`;
}

/** Render the path expression for an output's tokens. */
function renderPathExpr(tokens: ResolvedToken[], ec: OutputEmitCtx): string {
  if (tokens.length === 0) return `""`;
  if (tokens.length === 1) return renderToken(tokens[0]!, ec);
  // f-string interpolation. Use a single-quoted outer so embedded subscript
  // expressions like `params["key"]` (with double quotes) don't collide with
  // the outer quote - PEP 701 (Python 3.12+) lifts this restriction, but we
  // target 3.10+.
  let result = "f'";
  for (const tok of tokens) {
    if (tok.kind === "literal") {
      // Escape backslashes, single quotes, and braces (the latter are f-string
      // metacharacters).
      result += tok.value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\{/g, "{{")
        .replace(/\}/g, "}}");
    } else {
      result += "{";
      result += renderRefValue(tok, ec);
      result += "}";
    }
  }
  result += "'";
  return result;
}

function renderToken(tok: ResolvedToken, ec: OutputEmitCtx): string {
  if (tok.kind === "literal") return pyStr(tok.value);
  return renderRefValue(tok, ec);
}

function renderRefValue(tok: Extract<ResolvedToken, { kind: "ref" }>, ec: OutputEmitCtx): string {
  let expr = bindingAccess(tok.binding, ec);
  if (tok.fallback !== undefined) {
    expr = `(${expr} if ${expr} is not None else ${pyStr(tok.fallback)})`;
  }
  if (tok.stripExtensions && tok.stripExtensions.length > 0) {
    const sorted = [...tok.stripExtensions].sort((a, b) => b.length - a.length);
    const lits = sorted.map((s) => pyStr(s)).join(", ");
    expr = `_strip_extensions(${expr}, [${lits}])`;
  }
  return expr;
}

/**
 * Emit one contributor's assignment into the field's shared local var,
 * wrapped in its gate. The local var's init is emitted upfront by the caller
 * (except for required-single fields, which declare at the assignment).
 */
function emitOneOutput(
  output: EmittedOutput,
  gate: GateAtom[],
  fieldShape: OutputShape,
  localVar: string,
  ec: OutputEmitCtx,
  cb: CodeBuilder,
): void {
  const typeAnnot = outputTypeExpr(fieldShape);

  function nest(remaining: GateAtom[], child: OutputEmitCtx): void {
    if (remaining.length === 0) {
      const pathExpr = renderPathExpr(output.tokens, child);
      // A mutable input's writable copy is surfaced via mutable_copy (its host
      // path); a regular output resolves a local path via output_file.
      const call = output.mutable
        ? `execution.mutable_copy(${pathExpr})`
        : `execution.output_file(${pathExpr})`;
      if (fieldShape.kind === "list") {
        cb.line(`${localVar}.append(${call})`);
      } else if (fieldShape.optional) {
        cb.line(`${localVar} = ${call}`);
      } else {
        // Required single: the (sole, ungated) contributor declares the var here.
        cb.line(`${localVar}: ${typeAnnot} = ${call}`);
      }
      return;
    }
    const [head, ...rest] = remaining;
    if (!head) return;
    const wrapper = renderWrapperOpen(head, child);
    if (wrapper.bindLine) cb.line(wrapper.bindLine);
    cb.line(wrapper.open);
    cb.indent(() => {
      let inner = child;
      if (head.kind === "iter") {
        inner = { ...child, iter: new Map(child.iter).set(head.binding, wrapper.loopVar!) };
      } else if (wrapper.subst) {
        inner = { ...child, subst: new Map(child.subst).set(wrapper.subst[0], wrapper.subst[1]) };
      }
      nest(rest, inner);
    });
  }

  nest(gate, ec);
}

/**
 * Emit a standalone `_outputs(params, execution)` function that builds and
 * returns the `Outputs` dataclass. Mirrors the `_cargs` function so the
 * wrapper can just call both. Same-named outputs share one local var (init
 * once, then every contributor assigns into it under its own gate), and the
 * constructor receives one keyword argument per unique field.
 */
export function emitBuildOutputs(
  ctx: CodegenContext,
  paramsType: string,
  outputsType: string,
  funcName: string,
  cb: CodeBuilder,
): void {
  cb.line(`def ${funcName}(params: ${paramsType}, execution: Execution) -> ${outputsType}:`);
  cb.indent(() => {
    cb.line(`"""Build the ${outputsType} object for this tool."""`);
    loopCounter = 0;
    const ec: OutputEmitCtx = {
      ctx,
      iter: new Map(),
      subst: new Map(),
    };

    const fields = collectOutputFields(ctx);
    const localVarOf = new Map<string, string>();
    for (const f of fields) {
      const localVar = `${f.id}_v`;
      localVarOf.set(f.id, localVar);
      // Initialize lists and gated singles upfront so each contributor only
      // assigns or appends. Required-singles are declared at their (sole)
      // ungated assignment - no init line here would leave the name unbound.
      if (f.shape.kind === "list") cb.line(`${localVar}: list[OutputPathType] = []`);
      else if (f.shape.optional) cb.line(`${localVar}: OutputPathType | None = None`);
    }

    const emitContributor = (output: EmittedOutput, scopeGate: GateAtom[]): void => {
      const gate = outputGate(scopeGate, output, ctx.bindings);
      const id = pyId(output.name);
      const field = fields.find((f) => f.id === id)!;
      emitOneOutput(output, gate, field.shape, localVarOf.get(id)!, ec, cb);
    };
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) emitContributor(output, scopeGate);
    }
    for (const output of collectMutableOutputs(ctx)) emitContributor(output, []);

    const streams = streamFields(ctx);
    if (fields.length === 0 && streams.length === 0) {
      cb.line(`return ${outputsType}()`);
    } else {
      cb.line(`return ${outputsType}(`);
      cb.indent(() => {
        for (const f of fields) cb.line(`${f.id}=${localVarOf.get(f.id)},`);
        // Stream fields start empty; the wrapper appends to them via the
        // handle_stdout / handle_stderr callbacks passed to execution.run.
        for (const s of streams) cb.line(`${s.id}=[],`);
      });
      cb.line(")");
    }
  });
}

/** Sanitize an output name to a valid Python identifier. */
function pyId(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^\d/.test(s)) s = "_" + s;
  if (s === "") s = "_";
  if (PY_KEYWORDS.has(s)) s = s + "_";
  return s;
}

/** Whether any output reference has stripExtensions set. */
export function needsStripExtensionsHelper(ctx: CodegenContext): boolean {
  for (const scope of ctx.outputScopes) {
    for (const output of scope.outputs) {
      for (const tok of output.tokens) {
        if (tok.kind === "ref" && tok.stripExtensions?.length) return true;
      }
    }
  }
  return false;
}

/** Emit a small `_strip_extensions` helper used by ref tokens that strip suffixes. */
export function emitStripExtensionsHelper(cb: CodeBuilder): void {
  cb.line("def _strip_extensions(value: str, exts: list[str]) -> str:");
  cb.indent(() => {
    cb.line("for ext in exts:");
    cb.indent(() => {
      cb.line("if value.endswith(ext):");
      cb.indent(() => {
        cb.line("return value[: -len(ext)]");
      });
    });
    cb.line("return value");
  });
}
