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
import { emitJsDoc, tsPropAccess } from "./emit.js";

/**
 * Field shape for a single resolved output.
 *
 * - `single`: emitted at most once. Optional iff any `present`/`variant` atom
 *   appears in the gate -> `OutputPathType | null`.
 * - `list`: emitted once per element of an iterated binding (any `iter`
 *   atom in the gate) -> `OutputPathType[]`. Gated lists still type as
 *   `OutputPathType[]` - the empty array stands for "nothing produced".
 */
type OutputShape = { kind: "single"; optional: boolean } | { kind: "list" };

function outputShape(gate: GateAtom[]): OutputShape {
  const iter = gate.some((a) => a.kind === "iter");
  if (iter) return { kind: "list" };
  const optional = gate.some((a) => a.kind === "present" || a.kind === "variant");
  return { kind: "single", optional };
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
  /** Emitted field identifier (already quoted/escaped via `jsId`). */
  id: string;
  shape: OutputShape;
  doc?: string;
}

/**
 * Collect the unique Outputs fields in first-seen order, merging the shape and
 * doc of any outputs that resolve to the same field id. Multiple scopes (e.g.
 * the arms of a union output) routinely declare the same output name; without
 * deduping, the interface and initializer would emit duplicate members.
 */
function collectOutputFields(ctx: CodegenContext): OutputField[] {
  const byId = new Map<string, OutputField>();
  for (const scope of ctx.outputScopes) {
    const scopeBinding = ctx.bindings.get(scope.scope);
    const scopeGate = scopeBinding?.gate ?? [];
    for (const output of scope.outputs) {
      const gate = outputGate(scopeGate, output, ctx.bindings);
      const shape = outputShape(gate);
      const id = jsId(output.name);
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

function outputTypeExpr(shape: OutputShape): string {
  if (shape.kind === "list") return "OutputPathType[]";
  return shape.optional ? "OutputPathType | null" : "OutputPathType";
}

function initialValue(shape: OutputShape): string {
  if (shape.kind === "list") return "[]";
  // Required fields get a non-null assertion placeholder; the linear-flow
  // assignment below makes the placeholder unobservable.
  return shape.optional ? "null" : "null!";
}

/**
 * The set of binding ids that are referenced by ANY output in the context.
 * We use this to decide whether the Outputs machinery is worth emitting at
 * all (and to skip outputs work entirely when there are none).
 */
export function hasAnyOutputs(ctx: CodegenContext): boolean {
  return ctx.outputScopes.some((s) => s.outputs.length > 0);
}

/** Emit the `export interface <outputsType> { ... }` declaration. */
export function emitOutputsInterface(
  ctx: CodegenContext,
  outputsType: string,
  cb: CodeBuilder,
): void {
  cb.line(`export interface ${outputsType} {`);
  cb.indent(() => {
    for (const field of collectOutputFields(ctx)) {
      emitJsDoc(cb, field.doc);
      cb.line(`${field.id}: ${outputTypeExpr(field.shape)};`);
    }
  });
  cb.line(`}`);
}

/**
 * Per-binding access-path map. Built by walking the IR with the same
 * context-threading logic the arg-builder uses, so output codegen sees the
 * same paths arg-building does for any given binding.
 *
 * Bindings inside `repeat`-driven lists are NOT in this map; their access is
 * a loop variable introduced by the surrounding `iter` gate atom.
 */
type AccessMap = Map<BindingId, string>;

/**
 * Scope state threaded through `walkAccess`, mirroring the arg-builder's
 * `ArgContext`. A binding's access path is `paramsVar.<name>` (its name within
 * the enclosing struct scope), not its structural position - so a named binding
 * buried in a collapsed `seq(lit, T)` still resolves correctly. `paramsVar`
 * only changes when entering a nested struct scope (struct sequence,
 * struct-in-optional, complex-union variant).
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
  return arg.directValue ?? tsPropAccess(arg.paramsVar, name);
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
        const access = tsPropAccess(arg.paramsVar, binding.name);
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
      const access = tsPropAccess(arg.paramsVar, binding.name);
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

/**
 * Substitutions for ref access while inside an iteration loop. When emitting
 * `for (const item of foo)`, refs to `foo` inside should resolve to `item`.
 */
type IterScope = Map<BindingId, string>;

interface OutputEmitCtx {
  ctx: CodegenContext;
  access: AccessMap;
  iter: IterScope;
}

/**
 * Render one output's wrapper stack and emit the assignment inside the
 * innermost wrapper. Nesting is done via recursive callbacks so the
 * CodeBuilder's auto-indentation tracks correctly.
 */
function emitOneOutput(
  output: ResolvedOutput,
  gate: GateAtom[],
  ec: OutputEmitCtx,
  cb: CodeBuilder,
): void {
  const shape = outputShape(gate);
  const fieldName = jsId(output.name);

  function nest(remaining: GateAtom[], child: OutputEmitCtx): void {
    if (remaining.length === 0) {
      const pathExpr = renderPathExpr(output.tokens, child);
      const optionalArg = shape.kind === "single" && shape.optional ? ", true" : "";
      const call = `execution.outputFile(${pathExpr}${optionalArg})`;
      if (shape.kind === "list") {
        cb.line(`outputs.${fieldName}.push(${call});`);
      } else {
        cb.line(`outputs.${fieldName} = ${call};`);
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
    cb.line(wrapper.close);
  }

  nest(gate, ec);
}

interface WrapperRender {
  open: string;
  close: string;
  loopVar?: string;
}

let loopCounter = 0;

function renderWrapperOpen(atom: GateAtom, ec: OutputEmitCtx): WrapperRender {
  if (atom.kind === "iter") {
    const access = bindingAccess(atom.binding, ec);
    const v = `__o${loopCounter++}`;
    return { open: `for (const ${v} of ${access}) {`, close: `}`, loopVar: v };
  }
  if (atom.kind === "variant") {
    const access = bindingAccess(atom.binding, ec);
    return {
      open: `if (${access}["@type"] === ${JSON.stringify(atom.variant)}) {`,
      close: `}`,
    };
  }
  // present
  const binding = ec.ctx.bindings.get(atom.binding);
  const access = bindingAccess(atom.binding, ec);
  const cond = presentCondition(binding?.type, access);
  return { open: `if (${cond}) {`, close: `}` };
}

function presentCondition(type: BoundType | undefined, access: string): string {
  if (!type) return access;
  switch (type.kind) {
    case "optional":
      return `${access} !== null && ${access} !== undefined`;
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
  // Fallback: shouldn't happen for well-formed IR, but emit a comment-style
  // placeholder so the generated code surfaces the issue.
  return `/* unresolved binding ${id} */ null as any`;
}

function renderPathExpr(tokens: ResolvedToken[], ec: OutputEmitCtx): string {
  if (tokens.length === 0) return `""`;
  if (tokens.length === 1) return renderToken(tokens[0]!, ec);
  // Template-literal join: \`${...}${...}\`
  let result = "`";
  for (const tok of tokens) {
    if (tok.kind === "literal") {
      result += tok.value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    } else {
      result += "${";
      result += renderRefValue(tok, ec);
      result += "}";
    }
  }
  result += "`";
  return result;
}

function renderToken(tok: ResolvedToken, ec: OutputEmitCtx): string {
  if (tok.kind === "literal") return JSON.stringify(tok.value);
  return renderRefValue(tok, ec);
}

function renderRefValue(tok: Extract<ResolvedToken, { kind: "ref" }>, ec: OutputEmitCtx): string {
  let expr = bindingAccess(tok.binding, ec);
  // Optional refs with a fallback substitute the fallback on null/undefined.
  if (tok.fallback !== undefined) {
    expr = `(${expr} ?? ${JSON.stringify(tok.fallback)})`;
  }
  // stripExtensions: cut listed suffixes from the value (longest match first).
  if (tok.stripExtensions && tok.stripExtensions.length > 0) {
    const sorted = [...tok.stripExtensions].sort((a, b) => b.length - a.length);
    const lits = sorted.map((s) => JSON.stringify(s)).join(", ");
    expr = `stripExtensions(${expr}, [${lits}])`;
  }
  return expr;
}

function jsId(name: string): string {
  // Output ids may contain characters that aren't valid JS identifier chars.
  // Quote when needed.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  return JSON.stringify(name);
}

/**
 * Emit a standalone `_outputs(params, execution)` function that builds and
 * returns the `Outputs` object. Mirrors the `_cargs` function structurally so
 * the wrapper can just call both.
 */
export function emitBuildOutputs(
  ctx: CodegenContext,
  paramsType: string,
  outputsType: string,
  funcName: string,
  cb: CodeBuilder,
): void {
  cb.line(
    `export function ${funcName}(params: ${paramsType}, execution: Execution): ${outputsType} {`,
  );
  cb.indent(() => {
    loopCounter = 0;
    const ec: OutputEmitCtx = {
      ctx,
      access: buildAccessMap(ctx),
      iter: new Map(),
    };

    // Initialize the outputs object with defaults so wrapper code can assign or
    // push into it without conditional construction. Deduped by field id so
    // same-named outputs (e.g. union arms) yield one initializer entry.
    cb.line(`const outputs: ${outputsType} = {`);
    cb.indent(() => {
      for (const field of collectOutputFields(ctx)) {
        cb.line(`${field.id}: ${initialValue(field.shape)},`);
      }
    });
    cb.line(`};`);

    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) {
        const gate = outputGate(scopeGate, output, ctx.bindings);
        emitOneOutput(output, gate, ec, cb);
      }
    }

    cb.line(`return outputs;`);
  });
  cb.line(`}`);
}

/**
 * Whether the generated module needs a `stripExtensions` helper (any ref
 * token has stripExtensions set).
 */
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

/** Emit a small `stripExtensions` helper used by ref tokens that strip suffixes. */
export function emitStripExtensionsHelper(cb: CodeBuilder): void {
  cb.line(`function stripExtensions(value: string, exts: string[]): string {`);
  cb.indent(() => {
    cb.line(`for (const ext of exts) {`);
    cb.indent(() => {
      cb.line(`if (value.endsWith(ext)) return value.slice(0, value.length - ext.length);`);
    });
    cb.line(`}`);
    cb.line(`return value;`);
  });
  cb.line(`}`);
}
