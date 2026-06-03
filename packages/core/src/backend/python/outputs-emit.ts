import type {
  Binding,
  BindingId,
  BoundType,
  GateAtom,
  ResolvedToken,
} from "../../bindings/index.js";
import { outputGate } from "../../bindings/index.js";
import { collectFieldInfo } from "../collect-field-info.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import {
  type EmittedOutput,
  type OutputShape,
  collectMutableOutputs,
  collectOutputFields,
  streamFields,
} from "../collect-output-fields.js";
import { PY_KEYWORDS, emitDocstring } from "./emit.js";
import { pyStr, renderAccess, renderPyLiteral } from "./typemap.js";

// The output-field/stream/mutable collection is language-agnostic and shared
// with the TypeScript and JSON Schema backends; re-export the predicates the
// backend entry point consumes so its import surface stays `./outputs-emit.js`.
export { hasAnyOutputs, hasMutableInputs, hasStreamOutputs } from "../collect-output-fields.js";

function outputTypeExpr(shape: OutputShape): string {
  if (shape.kind === "list") return "list[OutputPathType]";
  return shape.optional ? "OutputPathType | None" : "OutputPathType";
}

/** Field ids for stdout/stderr (in declaration order), for wrapper wiring. */
export function streamFieldIds(ctx: CodegenContext): { stdout?: string; stderr?: string } {
  const fields = streamFields(ctx, pyId);
  const res: { stdout?: string; stderr?: string } = {};
  let idx = 0;
  if (ctx.app?.stdout) res.stdout = fields[idx++]!.id;
  if (ctx.app?.stderr) res.stderr = fields[idx++]!.id;
  return res;
}

/** Emit `@dataclasses.dataclass\nclass <outputsType>:` declaration. */
export function emitOutputsClass(ctx: CodegenContext, outputsType: string, cb: CodeBuilder): void {
  cb.line("@dataclasses.dataclass");
  cb.line(`class ${outputsType}:`);
  cb.indent(() => {
    emitDocstring(cb, "Output paths produced by the tool.");
    const fields = collectOutputFields(ctx, pyId);
    const streams = streamFields(ctx, pyId);
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
  /**
   * Rendered Python default literals for root-level defaulted fields, keyed by
   * field name. An output path that interpolates such a field (e.g. an output
   * basename `maskfile`) reads it via `.get(key, <default>)` so an absent key
   * substitutes the default rather than raising `KeyError`. Mirrors the cargs
   * builder's `defaults`.
   */
  defaults: ReadonlyMap<string, string>;
}

/** The rendered default for a binding iff it is a root-level defaulted field. */
function rootFieldDefault(
  binding: Binding | undefined,
  defaults: ReadonlyMap<string, string>,
): string | undefined {
  if (!binding) return undefined;
  const a = binding.access;
  if (a.length === 1 && a[0]?.kind === "field") return defaults.get(binding.name);
  return undefined;
}

/** Build the field-name -> rendered-default map for the struct root (else empty).
 * Includes only non-optional defaulted fields (optional fields are
 * presence-guarded; their default comes from the factory's kwarg signature). */
function collectDefaults(ctx: CodegenContext): Map<string, string> {
  const out = new Map<string, string>();
  const rootType = ctx.resolve(ctx.expr)?.type;
  if (rootType?.kind !== "struct") return out;
  for (const [name, fi] of collectFieldInfo(ctx, rootType)) {
    if (fi.defaultValue === undefined) continue;
    if (rootType.fields[name]?.kind === "optional") continue;
    out.set(name, renderPyLiteral(fi.defaultValue));
  }
  return out;
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
  // A bool flag / count gating an output is NotRequired (a hand-authored config
  // may omit it), so read absence-safe via `.get()` - a bare subscript would
  // KeyError. `presentCondition` coerces the possibly-None `.get()` result.
  const t = binding?.type.kind;
  const absentSafe = t === "bool" || t === "count";
  const access = bindingAccess(atom.binding, ec, absentSafe);
  const cond = presentCondition(binding?.type, access);
  return { open: `if ${cond}:` };
}

function presentCondition(type: BoundType | undefined, access: string): string {
  if (!type) return access;
  switch (type.kind) {
    case "optional":
      return `${access} is not None`;
    case "bool":
      // `access` is a `.get()` read: None (absent) is falsy -> flag off.
      return access;
    case "count":
      // `access` is a `.get()` read: coerce None (absent) to 0 before comparing.
      return `(${access} or 0) > 0`;
    default:
      return access;
  }
}

function bindingAccess(
  id: BindingId,
  ec: OutputEmitCtx,
  finalGet = false,
  finalDefault?: string,
): string {
  // The binding is itself the currently-iterated element (a ref to the list
  // being looped, or a scalar list element): use its loop variable directly.
  const iterVar = ec.iter.get(id);
  if (iterVar) return iterVar;
  const binding = ec.ctx.bindings.get(id);
  if (binding) {
    // Solver-assigned path; `iter` segments resolve to the loop variable bound
    // by the surrounding `iter` gate atom. `finalGet` renders the last field
    // segment as `.get()` when binding an optional's value; `finalDefault`
    // renders it as `.get(key, default)` for a defaulted field; `subst` redirects
    // an optional prefix to the narrowed local bound by its presence gate.
    return renderAccess(
      binding.access,
      (b) => ec.iter.get(b) ?? `None  # unresolved loop var ${b}`,
      {
        finalFieldGet: finalGet,
        finalFieldDefault: finalDefault,
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
  // A defaulted root field interpolated into an output path is read absent-safe
  // via `.get(key, default)` (it is `NotRequired`); other refs render normally.
  const def = rootFieldDefault(ec.ctx.bindings.get(tok.binding), ec.defaults);
  let expr =
    def !== undefined && !ec.iter.has(tok.binding)
      ? bindingAccess(tok.binding, ec, false, def)
      : bindingAccess(tok.binding, ec);
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
 * (except for required-single fields, which declare at their first ungated
 * assignment; `reassign` marks a later same-named contributor that must assign
 * into the already-declared local rather than re-annotate it).
 */
function emitOneOutput(
  output: EmittedOutput,
  gate: GateAtom[],
  fieldShape: OutputShape,
  localVar: string,
  reassign: boolean,
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
      } else if (fieldShape.optional || reassign) {
        // Optional fields init upfront; a required-single's second-or-later
        // ungated contributor reassigns the already-declared local (a second
        // annotated declaration would be a mypy `no-redef`).
        cb.line(`${localVar} = ${call}`);
      } else {
        // Required single: the first ungated contributor declares the var here.
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
      defaults: collectDefaults(ctx),
    };

    const fields = collectOutputFields(ctx, pyId);
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

    // Required-single fields declare their local at the first ungated
    // contributor; a same-named ungated contributor seen later must reassign
    // (a second annotated declaration is a mypy `no-redef`). Some afni
    // descriptors give two output-files the same id with no gate.
    const declared = new Set<string>();
    const emitContributor = (output: EmittedOutput, scopeGate: GateAtom[]): void => {
      const gate = outputGate(scopeGate, output, ctx.bindings);
      const id = pyId(output.name);
      const field = fields.find((f) => f.id === id)!;
      const reassign = declared.has(id);
      declared.add(id);
      emitOneOutput(output, gate, field.shape, localVarOf.get(id)!, reassign, ec, cb);
    };
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) emitContributor(output, scopeGate);
    }
    for (const output of collectMutableOutputs(ctx)) emitContributor(output, []);

    const streams = streamFields(ctx, pyId);
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
