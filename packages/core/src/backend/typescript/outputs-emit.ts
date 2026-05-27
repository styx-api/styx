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
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) {
        const gate = outputGate(scopeGate, output, ctx.bindings);
        const shape = outputShape(gate);
        emitJsDoc(cb, output.doc?.description ?? output.doc?.title);
        cb.line(`${jsId(output.name)}: ${outputTypeExpr(shape)};`);
      }
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

function buildAccessMap(ctx: CodegenContext): AccessMap {
  const out: AccessMap = new Map();
  walkAccess(ctx.expr, ctx, "params", out);
  return out;
}

function walkAccess(node: Expr, ctx: CodegenContext, base: string, out: AccessMap): void {
  const binding = ctx.resolve(node);

  switch (node.kind) {
    case "literal":
    case "int":
    case "float":
    case "str":
    case "path": {
      if (binding) out.set(binding.id, base);
      return;
    }
    case "sequence": {
      // Sequence may be a struct binding (scope) or a transparent collapse.
      // For a struct binding, children are accessed via `base.<fieldName>`.
      // Without a struct binding (collapsed seq), children inherit `base`.
      if (binding && binding.type.kind === "struct") {
        out.set(binding.id, base);
        for (const child of node.attrs.nodes) {
          const childBinding = ctx.resolve(child);
          if (childBinding) {
            walkAccess(child, ctx, tsPropAccess(base, childBinding.name), out);
          } else {
            walkAccess(child, ctx, base, out);
          }
        }
      } else {
        if (binding) out.set(binding.id, base);
        for (const child of node.attrs.nodes) walkAccess(child, ctx, base, out);
      }
      return;
    }
    case "optional": {
      // The optional binding's own value lives at `base.<name>` when nested in
      // a struct, or at `base` when collapsed. The arg-builder threads
      // paramsVar through; here we mirror that by appending the binding name
      // only when the optional has a distinct binding.
      const access = binding ? base : base;
      if (binding) {
        out.set(binding.id, access);
        // Children unwrap "through" the optional - same access path.
        walkAccess(node.attrs.node, ctx, access, out);
      } else {
        walkAccess(node.attrs.node, ctx, base, out);
      }
      return;
    }
    case "repeat": {
      // Repeat creates a list binding. The list itself lives at `base`. Inner
      // bindings have no stable access (they're iteration variables), so we
      // skip them here.
      if (binding) out.set(binding.id, base);
      return;
    }
    case "alternative": {
      // Union binding lives at `base`. For each variant arm, children's
      // access depends on whether the variant is a complex struct. We
      // record paths only for the union binding itself here; per-variant
      // navigation happens at emit time via the `variant` gate atom.
      if (binding) out.set(binding.id, base);
      for (const alt of node.attrs.alts) {
        const altBinding = ctx.resolve(alt);
        if (altBinding && altBinding.type.kind === "struct") {
          // Inside a variant arm, fields are accessed via the union's path
          // (the discriminant check narrows the type).
          walkAccess(alt, ctx, base, out);
        } else {
          walkAccess(alt, ctx, base, out);
        }
      }
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
    // push into it without conditional construction.
    cb.line(`const outputs: ${outputsType} = {`);
    cb.indent(() => {
      for (const scope of ctx.outputScopes) {
        const scopeBinding = ctx.bindings.get(scope.scope);
        const scopeGate = scopeBinding?.gate ?? [];
        for (const output of scope.outputs) {
          const gate = outputGate(scopeGate, output, ctx.bindings);
          const shape = outputShape(gate);
          cb.line(`${jsId(output.name)}: ${initialValue(shape)},`);
        }
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
