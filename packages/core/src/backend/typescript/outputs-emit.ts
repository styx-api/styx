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
  outputShape,
  rootOutput,
  streamFields,
} from "../collect-output-fields.js";
import { emitJsDoc, renderAccess, tsPropAccess } from "./emit.js";
import { renderTsLiteral } from "./typemap.js";

// The output-field/stream/mutable collection is language-agnostic and shared
// with the Python and JSON Schema backends; re-export the predicates the
// backend entry point consumes so its import surface stays `./outputs-emit.js`.
export { hasAnyOutputs, hasMutableInputs, hasStreamOutputs } from "../collect-output-fields.js";

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

/** Raw field names for stdout/stderr (in declaration order), for wrapper wiring. */
export function streamFieldIds(ctx: CodegenContext): { stdout?: string; stderr?: string } {
  const fields = streamFields(ctx, jsId);
  const res: { stdout?: string; stderr?: string } = {};
  let idx = 0;
  if (ctx.app?.stdout) res.stdout = fields[idx++]!.name;
  if (ctx.app?.stderr) res.stderr = fields[idx++]!.name;
  return res;
}

/** Emit the `export interface <outputsType> { ... }` declaration. */
export function emitOutputsInterface(
  ctx: CodegenContext,
  outputsType: string,
  cb: CodeBuilder,
): void {
  cb.line(`export interface ${outputsType} {`);
  cb.indent(() => {
    for (const field of collectOutputFields(ctx, jsId)) {
      emitJsDoc(cb, field.doc);
      cb.line(`${field.id}: ${outputTypeExpr(field.shape)};`);
    }
    for (const s of streamFields(ctx, jsId)) {
      emitJsDoc(cb, s.doc);
      cb.line(`${s.id}: string[];`);
    }
  });
  cb.line(`}`);
}

/**
 * Substitutions for ref access while inside an iteration loop. When emitting
 * `for (const item of foo)`, refs to `foo` inside should resolve to `item`.
 * This is also how `iter` segments in a binding's access path are resolved.
 */
type IterScope = Map<BindingId, string>;

interface OutputEmitCtx {
  ctx: CodegenContext;
  iter: IterScope;
  /**
   * Merged shape per emitted field id (jsId of the output name), across every
   * contributing scope. An output name can be declared in several scopes with
   * different shapes - e.g. a list scope (repeatable option) and a single scope
   * (plain option) both writing `volume_out`. The field's type follows the
   * merged shape (a list if any contributor iterates), so the *write* must too:
   * a single-scope contributor pushes one element into a list field rather than
   * assigning. Keyed identically to `collectOutputFields`.
   */
  fieldShapes: Map<string, OutputShape>;
  /**
   * Rendered TS default literals for root-level defaulted fields, keyed by field
   * name. An output path interpolating such a field (e.g. an output basename
   * `maskfile`) reads it via `(access ?? default)` so an absent key substitutes
   * the default rather than stringifying `undefined`. Mirrors the cargs builder.
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
    out.set(name, renderTsLiteral(fi.defaultValue));
  }
  return out;
}

/**
 * Render one output's wrapper stack and emit the assignment inside the
 * innermost wrapper. Nesting is done via recursive callbacks so the
 * CodeBuilder's auto-indentation tracks correctly.
 */
function emitOneOutput(
  output: EmittedOutput,
  gate: GateAtom[],
  ec: OutputEmitCtx,
  cb: CodeBuilder,
): void {
  const occShape = outputShape(gate);
  // Push-vs-assign follows the *field's* merged shape, not this occurrence's:
  // when the same name is a list in one scope and single in another, the field
  // is a list, so a single-scope contributor must push (one element) rather
  // than assign a scalar into the array. Falls back to the occurrence shape for
  // a name that somehow has no merged entry.
  const shape = ec.fieldShapes.get(jsId(output.name)) ?? occShape;
  // Bracket-access for non-identifier field names (e.g. `in-file`, `4d`); dot
  // for valid identifiers. The interface key is jsId-quoted to match.
  const fieldRef = tsPropAccess("outputs", output.name);

  function nest(remaining: GateAtom[], child: OutputEmitCtx): void {
    if (remaining.length === 0) {
      const pathExpr = renderPathExpr(output.tokens, child);
      // A mutable input's writable copy is surfaced via mutableCopy (its host
      // path); a regular output resolves a local path via outputFile. The
      // optional `, true` arg only applies to a single (non-list) field.
      const optionalArg =
        !output.mutable &&
        shape.kind === "single" &&
        occShape.kind === "single" &&
        occShape.optional
          ? ", true"
          : "";
      const call = output.mutable
        ? `execution.mutableCopy(${pathExpr})`
        : `execution.outputFile(${pathExpr}${optionalArg})`;
      if (shape.kind === "list") {
        cb.line(`${fieldRef}.push(${call});`);
      } else {
        cb.line(`${fieldRef} = ${call};`);
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
  // The binding is itself the currently-iterated element (a `ref` to the list
  // being looped, or a scalar list element): use its loop variable directly.
  const subst = ec.iter.get(id);
  if (subst) return subst;
  const binding = ec.ctx.bindings.get(id);
  if (binding) {
    // Solver-assigned path; `iter` segments resolve to the loop variable bound
    // by the surrounding `iter` gate atom (always open by the time a ref to a
    // binding under that repeat renders).
    return renderAccess(binding.access, (b) => ec.iter.get(b) ?? unresolvedLoopVar(b));
  }
  // Fallback: shouldn't happen for well-formed IR, but emit a comment-style
  // placeholder so the generated code surfaces the issue.
  return `/* unresolved binding ${id} */ null as any`;
}

function unresolvedLoopVar(binding: BindingId): string {
  return `/* unresolved loop var ${binding} */ (null as any)`;
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
  // A defaulted root field interpolated into an output path is read absent-safe
  // via `(access ?? default)` (it is `?:`); other refs render normally.
  const def = rootFieldDefault(ec.ctx.bindings.get(tok.binding), ec.defaults);
  let expr =
    def !== undefined && !ec.iter.has(tok.binding)
      ? `(${bindingAccess(tok.binding, ec)} ?? ${def})`
      : bindingAccess(tok.binding, ec);
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
    const fields = collectOutputFields(ctx, jsId);
    const ec: OutputEmitCtx = {
      ctx,
      iter: new Map(),
      fieldShapes: new Map(fields.map((f) => [f.id, f.shape])),
      defaults: collectDefaults(ctx),
    };

    // Initialize the outputs object with defaults so wrapper code can assign or
    // push into it without conditional construction. Deduped by field id so
    // same-named outputs (e.g. union arms) yield one initializer entry.
    cb.line(`const outputs: ${outputsType} = {`);
    cb.indent(() => {
      for (const field of fields) {
        cb.line(`${field.id}: ${initialValue(field.shape)},`);
      }
      // Stream fields start empty; the wrapper pushes onto them via the
      // handleStdout / handleStderr callbacks passed to execution.run.
      for (const s of streamFields(ctx, jsId)) {
        cb.line(`${s.id}: [],`);
      }
    });
    cb.line(`};`);

    const emitContributor = (output: EmittedOutput, scopeGate: GateAtom[]): void => {
      const gate = outputGate(scopeGate, output, ctx.bindings);
      emitOneOutput(output, gate, ec, cb);
    };
    // The always-present root output directory, assigned before any declared
    // output (matches its first position in collectOutputFields).
    emitContributor(rootOutput(), []);
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) emitContributor(output, scopeGate);
    }
    for (const output of collectMutableOutputs(ctx)) emitContributor(output, []);

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
