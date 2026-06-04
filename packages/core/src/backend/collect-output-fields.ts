import type { BindingId, GateAtom, ResolvedOutput } from "../bindings/index.js";
import { outputGate } from "../bindings/index.js";
import type { Documentation, Expr } from "../ir/index.js";
import type { CodegenContext } from "../manifest/index.js";

/**
 * Language-agnostic collection of a tool's Outputs object: the set of output
 * files it produces (resolved outputs + mutable inputs surfaced as outputs)
 * plus its captured stdout/stderr streams. Both the Python and TypeScript
 * backends, and the JSON Schema backend, consume this single source of truth so
 * the three describe the same Outputs shape (previously this logic was
 * near-duplicated between the two `outputs-emit.ts` files). Identifier
 * sanitization is the one language-specific concern, so callers pass an `idOf`
 * mapping a raw output name to their target language's field identifier; the
 * dedup space is keyed by that id, matching each backend's own field set.
 */

/**
 * A `ResolvedOutput` plus a `mutable` marker. A mutable input file is surfaced
 * as an output: its single ref token points at the input binding, and the
 * backend emits a writable-copy call (`mutable_copy` / `mutableCopy`) - the
 * host path of the copy the runner staged for the matching mutable input -
 * instead of `output_file` / `outputFile`.
 */
export type EmittedOutput = ResolvedOutput & { mutable?: boolean };

/**
 * The synthetic `root` output: the runner's output directory itself, surfaced as
 * an always-present, non-gated `OutputPathType` field. Modeled as a regular
 * `ResolvedOutput` with a single literal `"."` token so it flows through the
 * exact same collection and emit machinery as every declared output - its empty
 * gate makes it a required single, rendered as `output_file(".")` /
 * `outputFile(".")`. Because every tool emits it, every tool returns a
 * non-empty Outputs object (matching styx v1, which always carried `root`).
 */
export function rootOutput(ctx: CodegenContext, idOf: (name: string) => string): EmittedOutput {
  // Reserve a non-colliding field id. If a tool genuinely declares an output (or
  // a mutable input surfaced as an output) whose id sanitizes to "root", the
  // synthetic output-dir field dodges with a trailing "_" so it never silently
  // clobbers that real output (or flips it optional via shape merging).
  const taken = new Set<string>();
  for (const scope of ctx.outputScopes) for (const o of scope.outputs) taken.add(idOf(o.name));
  for (const o of collectMutableOutputs(ctx)) taken.add(idOf(o.name));
  let name = "root";
  while (taken.has(idOf(name))) name += "_";
  return { name, tokens: [{ kind: "literal", value: "." }] };
}

/**
 * Field shape for a single resolved output.
 *
 * - `single`: emitted at most once. Optional iff any `present`/`variant` atom
 *   appears in the gate (the value may be absent under that gate).
 * - `list`: emitted once per element of an iterated binding (any `iter` atom in
 *   the gate). A gated list still types as a list - the empty list stands for
 *   "nothing produced".
 */
export type OutputShape = { kind: "single"; optional: boolean } | { kind: "list" };

export function outputShape(gate: GateAtom[]): OutputShape {
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
export function mergeShape(a: OutputShape, b: OutputShape): OutputShape {
  if (a.kind === "list" || b.kind === "list") return { kind: "list" };
  return { kind: "single", optional: a.optional || b.optional };
}

/** One collected Outputs field, deduped across same-named outputs. */
export interface OutputField {
  /** Backend-sanitized field identifier (via the caller's `idOf`). */
  id: string;
  /** First-seen raw output name (the descriptor's output id). */
  name: string;
  shape: OutputShape;
  doc?: string;
}

/**
 * Collect the unique Outputs fields in first-seen order, merging the shape and
 * doc of any outputs that resolve to the same field id. Multiple scopes (e.g.
 * the arms of a union output) routinely declare the same output name; without
 * deduping a backend would emit duplicate fields (a Python SyntaxError, a TS
 * duplicate member). `idOf` maps a raw output name to the target language's
 * sanitized identifier, so two raw names that collapse to the same identifier
 * merge into one field - exactly the field set the backend will emit.
 */
export function collectOutputFields(
  ctx: CodegenContext,
  idOf: (name: string) => string,
): OutputField[] {
  const byId = new Map<string, OutputField>();
  const add = (output: EmittedOutput, scopeGate: GateAtom[]): void => {
    const gate = outputGate(scopeGate, output, ctx.bindings);
    const shape = outputShape(gate);
    const id = idOf(output.name);
    const doc = output.doc?.description ?? output.doc?.title;
    const existing = byId.get(id);
    if (existing) {
      existing.shape = mergeShape(existing.shape, shape);
      if (!existing.doc && doc) existing.doc = doc;
    } else {
      byId.set(id, { id, name: output.name, shape, doc });
    }
  };
  // The output directory itself, always present and ungated, listed first.
  add(rootOutput(ctx, idOf), []);
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

/** A captured stream (stdout/stderr), surfaced as a list-of-lines Outputs field. */
export interface StreamField {
  /** First-seen raw stream name, bumped with a trailing `_` to dodge collisions. */
  name: string;
  /** Backend-sanitized identifier for `name` (via the caller's `idOf`). */
  id: string;
  doc?: string;
}

/**
 * The stdout/stderr fields declared by the app metadata, in declaration order
 * (stdout before stderr). Stream outputs are app-level: never gated (always
 * present when the tool runs), so they bypass the solver/gating machinery and
 * surface as plain list-of-string fields the wrapper appends to via the
 * `handle_stdout` / `handle_stderr` (Python) or `handleStdout` / `handleStderr`
 * (TS) callbacks. A stream whose sanitized id collides with a real output's id
 * is bumped (raw name gains a trailing `_`, re-sanitized) so it never shadows a
 * file output / emits a duplicate field.
 */
export function streamFields(ctx: CodegenContext, idOf: (name: string) => string): StreamField[] {
  const out: StreamField[] = [];
  // Seed with the file/mutable output field ids so a stream whose name collides
  // with a real output (e.g. an output literally named "stdout") is bumped
  // rather than emitting a duplicate field / repeated constructor argument.
  const used = new Set<string>(collectOutputFields(ctx, idOf).map((f) => f.id));
  const add = (rawName: string, doc?: string): void => {
    let name = rawName;
    while (used.has(idOf(name))) name += "_";
    used.add(idOf(name));
    out.push({ name, id: idOf(name), doc });
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
