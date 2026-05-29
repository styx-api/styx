import type {
  BindingId,
  BoundType,
  GateAtom,
  ResolvedOutput,
  ResolvedToken,
} from "../../bindings/index.js";
import { outputGate } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { PY_KEYWORDS, emitDocstring } from "./emit.js";
import { pyStr } from "./typemap.js";

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
  for (const scope of ctx.outputScopes) {
    const scopeBinding = ctx.bindings.get(scope.scope);
    const scopeGate = scopeBinding?.gate ?? [];
    for (const output of scope.outputs) {
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
    }
  }
  return [...byId.values()];
}

/** Has any scope in the context attached at least one output? */
export function hasAnyOutputs(ctx: CodegenContext): boolean {
  return ctx.outputScopes.some((s) => s.outputs.length > 0);
}

/** Emit `@dataclasses.dataclass\nclass <outputsType>:` declaration. */
export function emitOutputsClass(ctx: CodegenContext, outputsType: string, cb: CodeBuilder): void {
  cb.line("@dataclasses.dataclass");
  cb.line(`class ${outputsType}:`);
  cb.indent(() => {
    emitDocstring(cb, "Output paths produced by the tool.");
    const fields = collectOutputFields(ctx);
    if (fields.length === 0) {
      cb.line("pass");
      return;
    }
    for (const field of fields) {
      cb.line(`${field.id}: ${outputTypeExpr(field.shape)}`);
      if (field.doc) emitDocstring(cb, field.doc);
    }
  });
}

/** Per-binding access-path map. */
type AccessMap = Map<BindingId, string>;

/**
 * Scope state threaded through `walkAccess`, mirroring the arg-builder's
 * `ArgContext`. A binding's access path is `paramsVar["<name>"]` (its name
 * within the enclosing struct scope), not its structural position - so a named
 * binding buried in a collapsed `seq(lit, T)` still resolves correctly.
 * `paramsVar` only changes when entering a nested struct scope (struct
 * sequence, struct-in-optional, complex-union variant).
 */
interface AccessCtx {
  paramsVar: string;
  /** Set when a wrapper collapsed a value onto its own path (see arg-builder). */
  directValue?: string;
  /** The struct type at the current scope level (prevents double-scoping). */
  currentStructType?: BoundType;
}

function hasStructScope(type: BoundType): boolean {
  switch (type.kind) {
    case "optional":
      return hasStructScope(type.inner);
    case "list":
      return hasStructScope(type.item);
    case "struct":
      return true;
    default:
      return false;
  }
}

function unwrapToStruct(type: BoundType): Extract<BoundType, { kind: "struct" }> | undefined {
  switch (type.kind) {
    case "optional":
      return unwrapToStruct(type.inner);
    case "list":
      return unwrapToStruct(type.item);
    case "struct":
      return type;
    default:
      return undefined;
  }
}

function resolveAccess(arg: AccessCtx, name: string): string {
  return arg.directValue ?? `${arg.paramsVar}[${pyStr(name)}]`;
}

function buildAccessMap(ctx: CodegenContext): AccessMap {
  const out: AccessMap = new Map();
  const rootBinding = ctx.resolve(ctx.expr);
  walkAccess(ctx.expr, ctx, { paramsVar: "params", currentStructType: rootBinding?.type }, out);
  return out;
}

function walkAccess(node: Expr, ctx: CodegenContext, arg: AccessCtx, out: AccessMap): void {
  const binding = ctx.resolve(node);

  switch (node.kind) {
    case "literal":
      return;
    case "int":
    case "float":
    case "str":
    case "path": {
      if (binding) out.set(binding.id, resolveAccess(arg, binding.name));
      return;
    }
    case "sequence": {
      let childArg = arg;
      if (binding && hasStructScope(binding.type) && binding.type !== arg.currentStructType) {
        const access = `${arg.paramsVar}[${pyStr(binding.name)}]`;
        out.set(binding.id, access);
        childArg = {
          paramsVar: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding) {
        out.set(binding.id, arg.directValue ?? arg.paramsVar);
      }
      for (const child of node.attrs.nodes) walkAccess(child, ctx, childArg, out);
      return;
    }
    case "optional": {
      if (!binding) {
        walkAccess(node.attrs.node, ctx, arg, out);
        return;
      }
      const access = `${arg.paramsVar}[${pyStr(binding.name)}]`;
      out.set(binding.id, access);
      let childArg: AccessCtx;
      if (hasStructScope(binding.type)) {
        childArg = {
          paramsVar: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding.type.kind === "optional" || binding.type.kind === "bool") {
        childArg = { ...arg, directValue: access };
      } else {
        childArg = arg;
      }
      walkAccess(node.attrs.node, ctx, childArg, out);
      return;
    }
    case "repeat": {
      // List/count binding lives at its own access path. Inner bindings are
      // iteration-scoped (the `iter` gate atom binds a loop variable at emit
      // time), so they have no stable path here.
      if (binding) out.set(binding.id, resolveAccess(arg, binding.name));
      return;
    }
    case "alternative": {
      if (!binding) {
        for (const alt of node.attrs.alts) walkAccess(alt, ctx, arg, out);
        return;
      }
      const access = resolveAccess(arg, binding.name);
      out.set(binding.id, access);
      const isComplexUnion =
        binding.type.kind === "union" &&
        !binding.type.variants.every((v) => v.type.kind === "literal");
      node.attrs.alts.forEach((alt, i) => {
        if (isComplexUnion && binding.type.kind === "union") {
          // A complex-union variant's fields are accessed via the union's path
          // (the discriminant check narrows it), so scope into `access`.
          const variantType = binding.type.variants[i]?.type;
          walkAccess(
            alt,
            ctx,
            {
              paramsVar: access,
              currentStructType:
                variantType?.kind === "struct" ? variantType : arg.currentStructType,
            },
            out,
          );
        } else {
          walkAccess(alt, ctx, arg, out);
        }
      });
      return;
    }
  }
}

type IterScope = Map<BindingId, string>;

interface OutputEmitCtx {
  ctx: CodegenContext;
  access: AccessMap;
  iter: IterScope;
}

interface WrapperRender {
  open: string;
  loopVar?: string;
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

function bindingAccess(id: BindingId, ec: OutputEmitCtx): string {
  const subst = ec.iter.get(id);
  if (subst) return subst;
  const access = ec.access.get(id);
  if (access) return access;
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
  output: ResolvedOutput,
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
      const call = `execution.output_file(${pathExpr})`;
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
    cb.line(wrapper.open);
    cb.indent(() => {
      const inner =
        head.kind === "iter"
          ? { ...child, iter: new Map(child.iter).set(head.binding, wrapper.loopVar!) }
          : child;
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
      access: buildAccessMap(ctx),
      iter: new Map(),
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

    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) {
        const gate = outputGate(scopeGate, output, ctx.bindings);
        const id = pyId(output.name);
        const field = fields.find((f) => f.id === id)!;
        emitOneOutput(output, gate, field.shape, localVarOf.get(id)!, ec, cb);
      }
    }

    if (fields.length === 0) {
      cb.line(`return ${outputsType}()`);
    } else {
      cb.line(`return ${outputsType}(`);
      cb.indent(() => {
        for (const f of fields) cb.line(`${f.id}=${localVarOf.get(f.id)},`);
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
