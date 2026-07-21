/**
 * Lower an `AstDocument` to Styx IR (`Expr` + `AppMeta`).
 *
 * Mapping highlights:
 * - Combinators map 1:1 except `set` -> `sequence` (order-not-meaningful is not
 *   modeled in the IR) and `any` -> its first branch (the spec's "emit branch 0"
 *   rule; the interchangeable alternatives are dropped with a warning).
 * - Aliases are resolved by substitution with cycle detection.
 * - `.output(...)` declarations attach to the nearest enclosing sequence scope,
 *   so an output nested in a repeat / subcommand keeps its list / struct shape
 *   (per-output gating is recovered downstream from each ref binding's gate).
 */

import { alt, float, int, lit, opt, path as pathTerm, rep, seq, str } from "../../ir/builders.js";
import { nodeRef } from "../../ir/meta.js";
import type { AppMeta, NodeMeta, Output, OutputToken, StreamOutput } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Sequence } from "../../ir/node.js";
import type { AstAlias, AstDocument, AstNode, AstOutput, SourceSpan } from "./ast.js";

/** A lowering diagnostic, optionally located at a source position. The location
 * comes from the offending AST node's span, so an error like a misplaced
 * `.join()` points at the node it was chained onto (parser/lexer diagnostics
 * already carry positions; this extends the same to the lowering stage). */
export interface LowerDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface LowerResult {
  meta?: AppMeta;
  expr: Sequence;
  errors: LowerDiagnostic[];
  warnings: LowerDiagnostic[];
}

/** Spread a node's span into a diagnostic (no-op when the node has no span). */
function at(span: SourceSpan | undefined): { line?: number; column?: number } {
  return span ? { line: span.line, column: span.column } : {};
}

/** Build IR `Documentation` from an AST node's already-split title/description. */
function docFrom(node: { title?: string; description?: string }): Documentation | undefined {
  const doc: Documentation = {
    ...(node.title && { title: node.title }),
    ...(node.description && { description: node.description }),
  };
  return Object.keys(doc).length > 0 ? doc : undefined;
}

class Lowerer {
  readonly errors: LowerDiagnostic[] = [];
  readonly warnings: LowerDiagnostic[] = [];
  private aliases = new Map<string, AstNode>();

  constructor(aliases: AstAlias[]) {
    for (const a of aliases) {
      if (this.aliases.has(a.name))
        this.warn(`Duplicate alias '${a.name}'; last definition wins`, a.expr);
      this.aliases.set(a.name, a.expr);
    }
  }

  /** Record an error, located at `node`'s span when one is available. */
  private err(message: string, node?: AstNode): void {
    this.errors.push({ message, ...at(node?.span) });
  }

  /** Record a warning, located at `node`'s span when one is available. */
  private warn(message: string, node?: AstNode): void {
    this.warnings.push({ message, ...at(node?.span) });
  }

  lower(doc: AstDocument): LowerResult {
    // Each output attaches to its nearest enclosing sequence scope (via the
    // `sink`), preserving nesting so a per-repeat / per-subcommand output keeps
    // its list/struct shape. `rootSink` catches outputs declared directly on a
    // non-sequence root (a sequence root manages its own outputs).
    const rootSink: Output[] = [];
    const expr = this.lowerNode(doc.root, new Set(), undefined, rootSink);

    const root: Sequence = expr.kind === "sequence" ? expr : seq(expr);
    if (root !== expr) {
      root.meta = { ...(doc.root.name && { name: doc.root.name }) };
    }
    if (rootSink.length > 0) {
      root.meta = { ...root.meta, outputs: [...(root.meta?.outputs ?? []), ...rootSink] };
    }

    return { expr: root, errors: this.errors, warnings: this.warnings };
  }

  /**
   * @param expanding - alias names currently being expanded (cycle guard).
   * @param selfName - nearest enclosing named node, for `{}` self-references.
   * @param sink - outputs array of the nearest enclosing sequence; a `.output()`
   *   on this node attaches here (seq/set nodes instead own their outputs).
   */
  private lowerNode(
    node: AstNode,
    expanding: Set<string>,
    selfName: string | undefined,
    sink: Output[],
  ): Expr {
    // Alias reference: substitute then lower.
    if (node.kind === "ref") {
      return this.lowerRef(node, expanding, selfName, sink);
    }

    const name = node.name ?? selfName;

    // `.join` collapses a node's subtree into one argv element. It is carried on
    // sequence/repeat in the IR directly, and on `opt` by pushing it onto the
    // wrapped content (`lowerComb`). On any other node it would be silently
    // dropped, changing command-line correctness with no failure signal (a tool
    // gets `["A","B"]` instead of `"AB"`), so a misplaced modifier is a hard
    // error, not a warning. Refs are already resolved above, so by here the
    // node's concrete kind is known and these checks are accurate.
    const joinable =
      node.kind === "comb" &&
      (node.op === "seq" || node.op === "set" || node.op === "rep" || node.op === "opt");
    if (node.join !== undefined && !joinable) {
      this.err("`.join()` is only supported on seq/set/rep/opt", node);
    }

    // A type-specific modifier that lands on an incompatible node is silently
    // dropped downstream (only the matching lower* case reads it), which quietly
    // discards a value/arity constraint - so, like `.join()`, it is a hard error.
    const isNumericTerminal =
      node.kind === "terminal" && (node.terminal === "int" || node.terminal === "float");
    const isRep = node.kind === "comb" && node.op === "rep";
    const isPath = node.kind === "terminal" && node.terminal === "path";
    if ((node.min !== undefined || node.max !== undefined) && !isNumericTerminal) {
      this.err("`.min()`/`.max()` is only supported on int/float terminals", node);
    }
    if ((node.countMin !== undefined || node.countMax !== undefined) && !isRep) {
      this.err("`.count()`/`.countMin()`/`.countMax()` is only supported on rep", node);
    }
    if ((node.mutable || node.resolveParent) && !isPath) {
      this.err("`.mutable()`/`.resolveParent()` is only supported on path", node);
    }
    if (node.mediaTypes?.length && !isPath) {
      this.err("`.mediaType()` is only supported on path", node);
    }

    // `.default()` / `= value` is meaningful on a terminal, and also on the
    // combinators that model a defaultable value: `opt` (its default when
    // omitted), `alt` (a union's default variant), `rep` (a default list). Only a
    // `seq`/`set` struct has no scalar to default - a default there is nonsensical
    // and, left in place, would flow to the node's `defaultValue` (which backends
    // read) as a bogus value, so drop it and warn. It never changes which argv is
    // valid, so this is a warning, not an error.
    const isStruct = node.kind === "comb" && (node.op === "seq" || node.op === "set");
    if (node.default !== undefined && isStruct) {
      this.warn("`= value` / `.default()` is not supported on a seq/set struct; ignored", node);
      node.default = undefined;
    }

    // A `.output()` on a non-sequence node attaches to the enclosing sequence
    // scope (`sink`); seq/set own their outputs (handled in `lowerComb`).
    const isSeqSet = node.kind === "comb" && (node.op === "seq" || node.op === "set");
    if (node.outputs?.length && !isSeqSet) {
      for (const o of node.outputs) sink.push(this.toOutput(o, name));
    }

    switch (node.kind) {
      case "literal": {
        const e = lit(node.value ?? "");
        this.applyMeta(e, node);
        return e;
      }
      case "terminal":
        return this.lowerTerminal(node);
      case "comb":
        return this.lowerComb(node, expanding, name, sink);
      default: {
        this.err(`Unknown AST node kind '${(node as AstNode).kind}'`, node);
        return seq();
      }
    }
  }

  private lowerRef(
    node: AstNode,
    expanding: Set<string>,
    selfName: string | undefined,
    sink: Output[],
  ): Expr {
    const target = node.refName!;
    const aliasExpr = this.aliases.get(target);
    if (!aliasExpr) {
      this.err(`Unknown alias '${target}'`, node);
      return seq();
    }
    if (expanding.has(target)) {
      this.err(`Recursive alias '${target}' is not allowed`, node);
      return seq();
    }
    const clone = structuredClone(aliasExpr);
    // Overlay use-site decorations onto the inlined alias. The use site wins for
    // each scalar decoration it specifies; outputs and media types accumulate.
    // Without this, `size: Dimension.join(",")` would silently drop the join.
    // Point any diagnostic about the resolved node at the use site (a misplaced
    // modifier there, not in the alias definition, is what the author must fix).
    clone.span = node.span ?? clone.span;
    clone.name = node.name ?? clone.name;
    clone.title = node.title ?? clone.title;
    clone.description = node.description ?? clone.description;
    if (node.default !== undefined) clone.default = node.default;
    if (node.min !== undefined) clone.min = node.min;
    if (node.max !== undefined) clone.max = node.max;
    if (node.join !== undefined) clone.join = node.join;
    if (node.countMin !== undefined) clone.countMin = node.countMin;
    if (node.countMax !== undefined) clone.countMax = node.countMax;
    if (node.mediaTypes?.length)
      clone.mediaTypes = [...(clone.mediaTypes ?? []), ...node.mediaTypes];
    if (node.mutable) clone.mutable = true;
    if (node.resolveParent) clone.resolveParent = true;
    if (node.outputs?.length) clone.outputs = [...(clone.outputs ?? []), ...node.outputs];

    const next = new Set(expanding);
    next.add(target);
    return this.lowerNode(clone, next, selfName, sink);
  }

  private lowerTerminal(node: AstNode): Expr {
    switch (node.terminal) {
      case "int": {
        const e = int();
        this.checkBounds(node.min, node.max, "value", "min", "max", node);
        if (node.min !== undefined) e.attrs.minValue = node.min;
        if (node.max !== undefined) e.attrs.maxValue = node.max;
        this.applyMeta(e, node);
        return e;
      }
      case "float": {
        const e = float();
        this.checkBounds(node.min, node.max, "value", "min", "max", node);
        if (node.min !== undefined) e.attrs.minValue = node.min;
        if (node.max !== undefined) e.attrs.maxValue = node.max;
        this.applyMeta(e, node);
        return e;
      }
      case "str": {
        // A `str.mediaType(...)` is rejected generically in `lowerNode` (media
        // types are a `path`-only annotation), so nothing to do here.
        const e = str();
        this.applyMeta(e, node);
        return e;
      }
      case "path": {
        const e = pathTerm();
        if (node.mediaTypes?.length) e.attrs.mediaTypes = node.mediaTypes;
        if (node.mutable) e.attrs.mutable = true;
        if (node.resolveParent) e.attrs.resolveParent = true;
        this.applyMeta(e, node);
        return e;
      }
      default: {
        this.err(`Unknown terminal '${String(node.terminal)}'`, node);
        return str();
      }
    }
  }

  private lowerComb(
    node: AstNode,
    expanding: Set<string>,
    name: string | undefined,
    sink: Output[],
  ): Expr {
    const children = node.children ?? [];
    const lowerChildren = (s: Output[]): Expr[] =>
      children.map((c) => this.lowerNode(c, expanding, name, s));

    switch (node.op) {
      case "seq":
      case "set": {
        // `set` is lowered to a sequence: the IR does not model "order not
        // meaningful". A sequence is an output scope, so its own `.output()`s
        // and any outputs its children declare attach here (not the parent).
        const selfOutputs: Output[] = [];
        for (const o of node.outputs ?? []) selfOutputs.push(this.toOutput(o, name));
        const lowered = lowerChildren(selfOutputs);
        this.dedupeSiblingNames(lowered, node);
        const e = seq(...lowered);
        if (node.join !== undefined) e.attrs.join = node.join;
        this.applyMeta(e, node);
        if (selfOutputs.length > 0) {
          e.meta = { ...e.meta, outputs: [...(e.meta?.outputs ?? []), ...selfOutputs] };
        }
        return e;
      }
      case "alt": {
        // An alt arm's name is its discriminant, scoped to the union. Two arms
        // with the same label would collide the same way two same-named seq/set
        // fields do (the solver keys variants by name), so disambiguate them the
        // same way. `any` is exempt: it emits branch 0 and its branches are
        // deliberately binding-compatible (same names by design).
        const arms = lowerChildren(sink);
        this.dedupeSiblingNames(arms, node);
        const e = alt(...arms);
        this.applyMeta(e, node);
        return e;
      }
      case "any": {
        // Emit the first branch only. The `any` branches are interchangeable
        // spellings of one token (`--output` / `-output` / `-o`), and the spec
        // makes branch 0 authoritative for builders - so for a generator this
        // is lossless and expected, not a degradation worth warning about.
        // (Only a parser/validator would need to accept the other spellings.)
        if (children.length === 0) {
          this.err("`any(...)` requires at least one branch", node);
          return seq();
        }
        const e = this.lowerNode(children[0]!, expanding, name, sink);
        // Overlay the any's own name/doc onto the emitted branch.
        if (node.name) e.meta = { ...e.meta, name: node.name };
        {
          const d = docFrom(node);
          if (d) e.meta = { ...e.meta, doc: d };
        }
        return e;
      }
      case "opt": {
        const inner = this.wrapChildren(children, expanding, name, sink);
        // `.join()` on the opt collapses its content into one argv element; push
        // it onto the inner sequence/repeat (a single terminal is already one
        // element, so a join there is a harmless no-op).
        if (node.join !== undefined && (inner.kind === "sequence" || inner.kind === "repeat")) {
          inner.attrs.join = node.join;
        }
        const e = opt(inner);
        this.applyMeta(e, node);
        // A bare-literal flag resolves to a bool; give it a false default to
        // match the other frontends' flag convention.
        if (inner.kind === "literal") e.meta = { ...e.meta, defaultValue: false };
        return e;
      }
      case "rep": {
        const inner = this.wrapChildren(children, expanding, name, sink);
        const e = rep(inner);
        if (node.join !== undefined) e.attrs.join = node.join;
        this.checkBounds(
          node.countMin,
          node.countMax,
          "repetition count",
          "countMin",
          "countMax",
          node,
        );
        if (node.countMin !== undefined) e.attrs.countMin = node.countMin;
        if (node.countMax !== undefined) e.attrs.countMax = node.countMax;
        this.applyMeta(e, node);
        return e;
      }
      default: {
        this.err(`Unknown combinator '${String(node.op)}'`, node);
        return seq();
      }
    }
  }

  /** Warn on an inverted `[min, max]` pair (a lower bound above its upper
   * bound), which yields an unsatisfiable constraint downstream. */
  private checkBounds(
    min: number | undefined,
    max: number | undefined,
    what: string,
    minLabel: string,
    maxLabel: string,
    node?: AstNode,
  ): void {
    if (min !== undefined && max !== undefined && min > max) {
      this.warn(`Inverted ${what} bounds: ${minLabel} (${min}) > ${maxLabel} (${max})`, node);
    }
  }

  /**
   * Disambiguate duplicate explicit names among the direct children of a
   * sequence/set (struct fields) or the arms of an alternative (union
   * discriminants). The solver turns each named child into a struct field / union
   * variant keyed by its name; two siblings with the same name would silently
   * collapse (the second overwrites the first, dropping a parameter). argtype is
   * hand-authored
   * and gives no uniqueness guarantee, so - like the mrtrix frontend - we rename
   * collisions (`name_2`, `name_3`, ...) and warn. (This catches duplicate
   * explicit labels; it does not detect collisions between solver-derived names
   * of otherwise-unnamed children, which the solver also does not guard.)
   */
  private dedupeSiblingNames(children: Expr[], parent?: AstNode): void {
    const used = new Set<string>();
    for (const child of children) {
      const nm = child.meta?.name;
      if (nm === undefined) continue;
      if (!used.has(nm)) {
        used.add(nm);
        continue;
      }
      let n = 2;
      while (used.has(`${nm}_${n}`)) n++;
      const renamed = `${nm}_${n}`;
      used.add(renamed);
      child.meta = { ...child.meta, name: renamed };
      // Locate at the enclosing seq/set/alt node (the collision is between its
      // direct children, which are lowered IR nodes without their own AST span).
      this.warn(`Duplicate sibling name '${nm}'; renamed one occurrence to '${renamed}'`, parent);
    }
  }

  /** `opt`/`rep` with multiple children implicitly wrap them in a sequence,
   * which - like any sequence - is the output scope for those children. */
  private wrapChildren(
    children: AstNode[],
    expanding: Set<string>,
    name: string | undefined,
    sink: Output[],
  ): Expr {
    if (children.length === 1) return this.lowerNode(children[0]!, expanding, name, sink);
    const selfOutputs: Output[] = [];
    const e = seq(...children.map((c) => this.lowerNode(c, expanding, name, selfOutputs)));
    if (selfOutputs.length > 0) e.meta = { ...e.meta, outputs: selfOutputs };
    return e;
  }

  /** Fold an AST node's name/doc/default decorations onto an IR node's meta. */
  private applyMeta(e: Expr, node: AstNode): void {
    const meta: NodeMeta = {};
    if (node.name) meta.name = node.name;
    const doc = docFrom(node);
    if (doc) meta.doc = doc;
    if (node.default !== undefined) meta.defaultValue = node.default;
    if (Object.keys(meta).length > 0) e.meta = { ...e.meta, ...meta };
  }

  private toOutput(o: AstOutput, selfName: string | undefined): Output {
    const tokens: OutputToken[] = [];
    for (const t of o.tokens) {
      if (t.kind === "literal") {
        tokens.push({ kind: "literal", value: t.value });
        continue;
      }
      const targetName = t.name ?? selfName;
      if (!targetName) {
        this.warn("Output self-reference '{}' has no named node to resolve to; emitting empty");
        tokens.push({ kind: "literal", value: "" });
        continue;
      }
      if (t.stripPrefix?.length)
        this.warn("Output ref op 'strip_prefix' is not supported by the IR; ignored");
      if (t.basename) this.warn("Output ref op 'basename' is not supported by the IR; ignored");
      tokens.push({
        kind: "ref",
        target: nodeRef(targetName),
        ...(t.stripSuffix?.length && { stripExtensions: t.stripSuffix }),
        ...(t.or !== undefined && { fallback: t.or }),
      });
    }
    if (o.fallback !== undefined) {
      this.warn("Output-level '.or(...)' fallback is not supported by the IR; ignored");
    }
    const doc = docFrom(o);
    return { ...(o.name && { name: o.name }), ...(doc && { doc }), tokens };
  }
}

export function buildAppMeta(
  fm: Record<string, unknown> | undefined,
  rootDoc: { title?: string; description?: string },
  rootName: string | undefined,
): { meta?: AppMeta; warnings: string[] } {
  const warnings: string[] = [];
  const rootTitleDesc = docFrom(rootDoc);
  if (!fm) {
    // No frontmatter: id is the root definition name; still surface the root doc.
    const meta: AppMeta = {
      ...(rootName && { id: rootName }),
      ...(rootTitleDesc && { doc: rootTitleDesc }),
    };
    return Object.keys(meta).length > 0 ? { meta, warnings } : { warnings };
  }

  const asStr = (x: unknown): string | undefined =>
    typeof x === "string" && x.length > 0 ? x : undefined;
  // The tool id is the root definition name; `exe` is the executable (argv[0]),
  // which can differ (e.g. a `wb_command <sub>` tool has id `<sub>`, exe
  // `wb_command`). Fall back to `exe`/`id` frontmatter only if the root is unnamed.
  const id = asStr(rootName) ?? asStr(fm.exe) ?? asStr(fm.id);
  // An unquoted numeric version (`version: 6.0`) is parsed as a number by the
  // frontmatter reader; accept it by stringifying rather than dropping it.
  const version =
    asStr(fm.version) ?? (typeof fm.version === "number" ? String(fm.version) : undefined);
  const strList = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((a): a is string => typeof a === "string") : [];
  const authors = strList(fm.authors);
  const urls = strList(fm.urls);
  const references = strList(fm.references);

  // Validate the shape of known keys. A present-but-wrong-shape value is almost
  // always an authoring mistake, and silently coercing it (dropping a scalar
  // author, ignoring a malformed container) hides that - so warn rather than
  // drop in silence. An empty key (`authors:` with no value, parsed as null) is
  // left alone; only a non-null non-list scalar is flagged.
  const checkList = (key: string, v: unknown): void => {
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      warnings.push(`Frontmatter '${key}' should be a list; got a scalar - ignored`);
    }
  };
  checkList("authors", fm.authors);
  checkList("urls", fm.urls);
  checkList("references", fm.references);
  if (fm.version !== undefined && fm.version !== null && version === undefined) {
    warnings.push(`Frontmatter 'version' should be a string or number; ignored`);
  }
  if (fm.container !== undefined && fm.container !== null) {
    if (!isRecord(fm.container)) {
      warnings.push(`Frontmatter 'container' should be a mapping with an 'image'; ignored`);
    } else if (!asStr(fm.container.image)) {
      warnings.push(`Frontmatter 'container' is missing an 'image'; ignored`);
    }
  }

  const doc: Documentation = {
    ...rootTitleDesc,
    ...(authors.length > 0 && { authors }),
    ...(urls.length > 0 && { urls }),
    ...(references.length > 0 && { literature: references }),
  };

  const meta: AppMeta = {
    ...(id && { id }),
    ...(version && { version }),
    ...(Object.keys(doc).length > 0 && { doc }),
  };

  // container: { image, type }
  if (isRecord(fm.container)) {
    const image = asStr(fm.container.image);
    const type = asStr(fm.container.type);
    if (image) {
      meta.container = {
        image,
        ...(type === "docker" || type === "singularity" ? { type } : {}),
      };
    }
  }

  meta.stdout = streamFrom(fm.stdout, warnings, "stdout");
  meta.stderr = streamFrom(fm.stderr, warnings, "stderr");
  if (!meta.stdout) delete meta.stdout;
  if (!meta.stderr) delete meta.stderr;

  return { meta, warnings };
}

function streamFrom(x: unknown, warnings: string[], key: string): StreamOutput | undefined {
  if (x === undefined || x === null) return undefined;
  if (isRecord(x)) {
    const name = typeof x.name === "string" ? x.name : undefined;
    if (!name) {
      warnings.push(`Frontmatter '${key}' is missing a 'name'; ignored`);
      return undefined;
    }
    const description = typeof x.description === "string" ? x.description : undefined;
    return { name, ...(description && { doc: { description } }) };
  }
  if (typeof x === "string") return { name: x };
  warnings.push(`Frontmatter '${key}' has an unexpected shape; ignored`);
  return undefined;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function lowerDocument(doc: AstDocument): LowerResult {
  const lowerer = new Lowerer(doc.aliases);
  const result = lowerer.lower(doc);

  // argtype describes the arguments only (everything after argv[0]); the
  // executable lives in frontmatter. Prepend it as the command's first token so
  // the IR is a complete command line (the backend strips it back out).
  const exe = typeof doc.frontmatter?.exe === "string" ? doc.frontmatter.exe : undefined;
  if (exe) result.expr.attrs.nodes.unshift(lit(exe));

  const { meta, warnings } = buildAppMeta(
    doc.frontmatter,
    { title: doc.root.title, description: doc.root.description },
    doc.rootName,
  );

  return {
    ...(meta && { meta }),
    expr: result.expr,
    errors: result.errors,
    // Frontmatter warnings are location-less (the reader blanks those lines and
    // does not track per-key positions), so they carry no line/column.
    warnings: [...result.warnings, ...warnings.map((message) => ({ message }))],
  };
}
