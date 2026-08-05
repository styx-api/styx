/**
 * Lower a resolved argtype document to Styx IR (`Expr` + `AppMeta`).
 *
 * Parsing, alias inlining and decoration resolution all happen upstream in
 * `@argtype/core`; what is left here is only what a *generator* decides, which
 * is deliberately not what the language says:
 * - Combinators map 1:1 except `set` -> `sequence` (order-not-meaningful is not
 *   modeled in the IR) and `any` -> its first branch (the spec's "emit branch 0"
 *   rule). Both are lossless when emitting a single invocation and lossy for
 *   anything that parses argv, which is exactly why they are not upstream.
 * - `.output(...)` declarations attach to the nearest enclosing sequence scope,
 *   so an output nested in a repeat / subcommand keeps its list / struct shape
 *   (per-output gating is recovered downstream from each ref binding's gate).
 *
 * Annotations the IR has no room for (`.requires()`, `strip_prefix`, output
 * media types) are reported here rather than dropped silently.
 */

import { alt, float, int, lit, opt, path as pathTerm, rep, seq, str } from "../../ir/builders.js";
import { nodeRef } from "../../ir/meta.js";
import type { AppMeta, NodeMeta, Output, OutputToken, StreamOutput } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Sequence } from "../../ir/node.js";
import {
  CORE_METHODS,
  MEDIA_TYPE_METHODS,
  OUTPUT_METHODS,
  PATH_METHODS,
  visitResolved,
} from "@argtype/core";
import type {
  PathContract,
  ResolvedComb,
  ResolvedDocument,
  ResolvedNode,
  ResolvedTerminal,
  ResolvedOutput,
  SourceSpan,
} from "@argtype/core";

/**
 * The extension results Styx implements, keyed by the node that declared them.
 *
 * `@argtype/core` keeps every extension out of `ResolvedNode` - a node carries
 * the language core and nothing else - so a consumer runs the extension modules
 * it implements and passes their maps in here. Styx implements `outputs`,
 * `mediatypes` and `paths`; `constraints` has no IR representation.
 */
export interface LoweringExtensions {
  outputs: ReadonlyMap<ResolvedNode, ResolvedOutput[]>;
  mediaTypes: ReadonlyMap<ResolvedNode, string[]>;
  paths: ReadonlyMap<ResolvedNode, PathContract>;
}

/** Method names something in this pipeline gives meaning to. An annotation
 * outside this set reached the IR with nowhere to go, and is reported. */
const IMPLEMENTED_METHODS: ReadonlySet<string> = new Set([
  ...CORE_METHODS,
  ...OUTPUT_METHODS,
  ...MEDIA_TYPE_METHODS,
  ...PATH_METHODS,
]);

/** A lowering diagnostic, optionally located at a source position. The location
 * comes from the offending node's span, so an error about an IR limitation
 * points at the construct that hit it. */
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

/** Spread a span into a diagnostic (no-op when there is none). */
function at(span: SourceSpan | undefined): { line?: number; column?: number } {
  return span ? { line: span.start.line, column: span.start.column } : {};
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
  /** Nodes that reached the IR. Everything else is a branch lowering dropped. */
  private readonly visited = new Set<ResolvedNode>();

  constructor(private readonly ext: LoweringExtensions) {}

  /** Record an error, located at `node`'s head span when one is available. */
  private err(message: string, node?: ResolvedNode): void {
    this.errors.push({ message, ...at(node?.headSpan) });
  }

  /** Record a warning, located at `node`'s head span when one is available. */
  private warn(message: string, node?: ResolvedNode): void {
    this.warnings.push({ message, ...at(node?.headSpan) });
  }

  /** Record a warning at an exact span - for a diagnostic about one annotation
   * rather than about the node it sits on. */
  private warnAt(message: string, span?: SourceSpan): void {
    this.warnings.push({ message, ...at(span) });
  }

  lower(doc: ResolvedDocument): LowerResult {
    // Each output attaches to its nearest enclosing sequence scope (via the
    // `sink`), preserving nesting so a per-repeat / per-subcommand output keeps
    // its list/struct shape. `rootSink` catches outputs declared directly on a
    // non-sequence root (a sequence root manages its own outputs).
    const rootSink: Output[] = [];
    const expr = this.lowerNode(doc.root, undefined, rootSink);

    const root: Sequence = expr.kind === "sequence" ? expr : seq(expr);
    if (root !== expr) {
      root.meta = { ...(doc.root.name && { name: doc.root.name }) };
    }
    if (rootSink.length > 0) {
      root.meta = { ...root.meta, outputs: [...(root.meta?.outputs ?? []), ...rootSink] };
    }

    this.reportUnconsumed(doc);
    return { expr: root, errors: this.errors, warnings: this.warnings };
  }

  /**
   * Report every annotation the generated wrapper does not carry.
   *
   * This walks the whole resolved document, not the subtree lowering visited.
   * Living inside `lowerNode` meant it only ever saw nodes that reached the IR,
   * so an annotation on an `any` branch past the first - the branches lowering
   * discards by design - was dropped in the silence the check exists to break.
   *
   * Two distinct things go wrong, and they read differently to an author:
   *
   * - the method belongs to an extension Styx does not implement, so it would
   *   be ignored wherever it appeared; or
   * - Styx does implement it, but it sits on a node that is not part of the
   *   wrapper, so it is ignored *here* and would work if moved.
   *
   * Iterating `node.ast.annotations` rather than the grouped `annotations` map
   * keeps the report in source order: the map groups by method name, so its
   * iteration order is first-occurrence-of-each-name, which reads as shuffled
   * once a node carries more than one unimplemented method.
   */
  private reportUnconsumed(doc: ResolvedDocument): void {
    visitResolved(doc, (node) => {
      const lowered = this.visited.has(node);
      for (const ann of node.ast.annotations) {
        if (!IMPLEMENTED_METHODS.has(ann.name)) {
          this.warnAt(
            `argtype method '.${ann.name}()' has no Styx IR representation; ignored`,
            ann.span,
          );
        } else if (!lowered) {
          this.warnAt(
            `argtype method '.${ann.name}()' is on a node the generated wrapper does not include ` +
              `(only the first branch of an 'any' is emitted); ignored`,
            ann.span,
          );
        }
      }
    });
  }

  /**
   * @param selfName - nearest enclosing named node, for `{}` self-references.
   * @param sink - outputs array of the nearest enclosing sequence; a `.output()`
   *   on this node attaches here (seq/set nodes instead own their outputs).
   */
  private lowerNode(node: ResolvedNode, selfName: string | undefined, sink: Output[]): Expr {
    const name = node.name ?? selfName;
    // Which nodes reached the IR, so `reportUnconsumed` can tell "Styx cannot
    // represent this method" from "this node is not in the wrapper at all".
    this.visited.add(node);

    // A `.output()` on a non-sequence node attaches to the enclosing sequence
    // scope (`sink`); seq/set own their outputs (handled in `lowerComb`).
    const isSeqSet = node.kind === "comb" && (node.op === "seq" || node.op === "set");
    const outputs = this.ext.outputs.get(node);
    if (outputs?.length && !isSeqSet) {
      for (const o of outputs) sink.push(this.toOutput(o, name, node));
    }

    switch (node.kind) {
      case "literal": {
        const e = lit(node.value);
        this.applyMeta(e, node);
        return e;
      }
      case "terminal":
        return this.lowerTerminal(node);
      case "comb":
        return this.lowerComb(node, name, sink);
      case "ref":
        // `resolveAnnotations()` leaves a `ref` in place when aliases were not
        // inlined. `ResolvedNode` is a discriminated union, so this is the last
        // kind rather than a `default:` the compiler cannot prove unreachable.
        this.err(
          `Unresolved alias reference '${node.refName}' (inline aliases before lowering)`,
          node,
        );
        return seq();
    }
  }

  private lowerTerminal(node: ResolvedTerminal): Expr {
    switch (node.terminal) {
      case "int": {
        const e = int();
        if (node.min !== undefined) e.attrs.minValue = node.min;
        if (node.max !== undefined) e.attrs.maxValue = node.max;
        this.applyMeta(e, node);
        return e;
      }
      case "float": {
        const e = float();
        if (node.min !== undefined) e.attrs.minValue = node.min;
        if (node.max !== undefined) e.attrs.maxValue = node.max;
        this.applyMeta(e, node);
        return e;
      }
      case "str": {
        // A `str.mediaType(...)` is rejected upstream by `resolveMediaTypes()`
        // (media
        // types are a `path`-only annotation), so nothing to do here.
        const e = str();
        this.applyMeta(e, node);
        return e;
      }
      case "path": {
        const e = pathTerm();
        const mediaTypes = this.ext.mediaTypes.get(node);
        const contract = this.ext.paths.get(node);
        if (mediaTypes?.length) e.attrs.mediaTypes = mediaTypes;
        if (contract?.mutable) e.attrs.mutable = true;
        if (contract?.resolveParent) e.attrs.resolveParent = true;
        this.applyMeta(e, node);
        return e;
      }
    }
  }

  private lowerComb(node: ResolvedComb, name: string | undefined, sink: Output[]): Expr {
    const children = node.children;
    const lowerChildren = (s: Output[]): Expr[] => children.map((c) => this.lowerNode(c, name, s));

    switch (node.op) {
      case "seq":
      case "set": {
        // `set` is lowered to a sequence: the IR does not model "order not
        // meaningful". A sequence is an output scope, so its own `.output()`s
        // and any outputs its children declare attach here (not the parent).
        const selfOutputs: Output[] = [];
        for (const o of this.ext.outputs.get(node) ?? []) {
          selfOutputs.push(this.toOutput(o, name, node));
        }
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
        const e = this.lowerNode(children[0]!, name, sink);
        // No check for a default on the `any` itself: `resolveAnnotations`
        // rejects one upstream (the spec lists terminals plus `opt`/`alt`/`rep`)
        // and clears it, so it never arrives here. The language rule belongs
        // upstream - it holds for every consumer, not just this generator.
        //
        // Overlay the any's own name/doc onto the emitted branch.
        if (node.name) e.meta = { ...e.meta, name: node.name };
        {
          const d = docFrom(node);
          if (d) e.meta = { ...e.meta, doc: d };
        }
        return e;
      }
      case "opt": {
        const inner = this.wrapChildren(children, name);
        // `.join()` on the opt collapses its content into one argv element; push
        // it onto the inner sequence/repeat (a single terminal is already one
        // element, so a join there is a harmless no-op).
        if (node.join !== undefined) {
          if (inner.kind === "sequence" || inner.kind === "repeat") {
            inner.attrs.join = node.join;
          } else if (inner.kind === "alternative" || inner.kind === "optional") {
            // Only `sequence` and `repeat` carry a join in the IR. An `alt` or a
            // nested `opt` inner (`opt(alt(...)).join(",")`,
            // `opt(opt(...)).join(",")`) has nowhere to hold it, so the wrapper
            // emits separate argv elements - a real difference in the command
            // line, and exactly the kind of drop that must not be silent. Every
            // other inner kind is a single terminal or literal, already one argv
            // element, where a join is a harmless no-op.
            this.warn(
              `\`.join()\` on an \`opt\` wrapping ${
                inner.kind === "optional" ? "another optional" : "an alternative"
              } is not carried into the IR; the contents emit separate argv elements`,
              node,
            );
          }
        }
        const e = opt(inner);
        this.applyMeta(e, node);
        // A bare-literal flag resolves to a bool; give it a false default to
        // match the other frontends' flag convention.
        if (inner.kind === "literal") e.meta = { ...e.meta, defaultValue: false };
        return e;
      }
      case "rep": {
        const inner = this.wrapChildren(children, name);
        const e = rep(inner);
        if (node.join !== undefined) e.attrs.join = node.join;
        if (node.countMin !== undefined) e.attrs.countMin = node.countMin;
        if (node.countMax !== undefined) e.attrs.countMax = node.countMax;
        this.applyMeta(e, node);
        return e;
      }
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
  private dedupeSiblingNames(children: Expr[], parent?: ResolvedNode): void {
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

  /**
   * The contents of an `opt`/`rep`, as one expression that owns their outputs.
   *
   * Multiple children implicitly wrap in a sequence, which - like any sequence -
   * is the output scope for them. A lone child used to be returned as-is with
   * the *enclosing* sink passed through, so it opened no scope at all and its
   * outputs landed outside the wrapper that gates them: the generated wrapper
   * promised them unconditionally and typed them non-nullable. Adding one
   * unrelated literal to the same `opt` flipped the generated type, which is how
   * this reads as a bug rather than a convention -
   * `opt(m: "-m".output(mask: \`{in}_mask.nii\`))` gave `mask: OutputPathType`
   * where `opt(m: "-m".output(...), "-x")` gave `mask: OutputPathType | null`.
   * The gating that did survive came from templates that happened to reference a
   * binding inside the wrapper, which is not gating.
   *
   * So a lone child that collected outputs gets the same sequence wrapper the
   * multi-child path builds. It has to be a sequence and not just `meta.outputs`
   * on the child: only a sequence is force-bound as an output scope
   * (`solver.ts`), and `simplify` keeps a single-literal sequence alive
   * precisely when it carries outputs - park them on a bare literal and they are
   * dropped instead of merely misplaced.
   */
  private wrapChildren(children: ResolvedNode[], name: string | undefined): Expr {
    const selfOutputs: Output[] = [];
    const lowered = children.map((c) => this.lowerNode(c, name, selfOutputs));
    // A lone child with nothing to scope needs no wrapper. Its own outputs, if
    // it is a seq/set, are already its own (`lowerNode` never fills the sink for
    // those), so this is the common path and the IR stays as flat as before.
    if (lowered.length === 1 && selfOutputs.length === 0) return lowered[0]!;
    const e = seq(...lowered);
    if (selfOutputs.length > 0) e.meta = { ...e.meta, outputs: selfOutputs };
    return e;
  }

  /** Fold a resolved node's name/doc/default decorations onto an IR node's meta. */
  private applyMeta(e: Expr, node: ResolvedNode): void {
    const meta: NodeMeta = {};
    if (node.name) meta.name = node.name;
    const doc = docFrom(node);
    if (doc) meta.doc = doc;
    if (node.default !== undefined) meta.defaultValue = node.default;
    if (Object.keys(meta).length > 0) e.meta = { ...e.meta, ...meta };
  }

  private toOutput(o: ResolvedOutput, selfName: string | undefined, node?: ResolvedNode): Output {
    const tokens: OutputToken[] = [];
    for (const t of o.tokens) {
      if (t.kind === "literal") {
        tokens.push({ kind: "literal", value: t.value });
        continue;
      }
      const targetName = t.name ?? selfName;
      if (!targetName) {
        this.warn(
          "Output self-reference '{}' has no named node to resolve to; emitting empty",
          node,
        );
        tokens.push({ kind: "literal", value: "" });
        continue;
      }
      if (t.stripPrefix?.length)
        this.warn("Output ref op 'strip_prefix' is not supported by the IR; ignored", node);
      if (t.basename)
        this.warn("Output ref op 'basename' is not supported by the IR; ignored", node);
      tokens.push({
        kind: "ref",
        target: nodeRef(targetName),
        ...(t.stripSuffix?.length && { stripExtensions: t.stripSuffix }),
        ...(t.or !== undefined && { fallback: t.or }),
      });
    }
    if (o.fallback !== undefined) {
      this.warn("Output-level '.or(...)' fallback is not supported by the IR; ignored", node);
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

export function lowerDocument(doc: ResolvedDocument, ext: LoweringExtensions): LowerResult {
  const lowerer = new Lowerer(ext);
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
