/**
 * argtype backend: emit argtype sugar-DSL source text from Styx IR + `AppMeta`.
 *
 * This is the inverse of the argtype frontend's lowering (`frontend/argtype/
 * lower.ts`): it walks the `Expr` tree and prints surface syntax, mirroring each
 * lowering decision in reverse. Unlike the typed-language backends it needs only
 * the IR and `AppMeta`, never the solver, so it is a pure pretty-printer.
 *
 * Intentional lossiness (the frontend already collapses these, so the IR holds
 * no record of them and emitting the collapsed form is correct):
 * - `set` -> `sequence` and `any` -> first branch: the IR has no such nodes, so
 *   we emit `seq` / `alt`.
 * - Output ops `strip_prefix` / `basename` and output-level `.or()` are not in
 *   the IR's `OutputToken`, so there is nothing to emit.
 *
 * `path.attrs.mutable` / `resolveParent` emit as the `paths` extension's
 * `.mutable()` / `.resolveParent()`. A `doc.title` + `doc.description` emit as a
 * `///` block using the summary-line convention (title, blank `///`, description).
 *
 * IR features with no argtype surface are handled explicitly (always a backend
 * warning): output media types, stream `doc.title`,
 * `AppMeta.doc.literature/comment`, and a union arm's `variantTag` when it
 * differs from the arm name (the frontend re-derives the `@type` discriminator
 * from the name on re-parse).
 */

import type { AppMeta, Output, StreamOutput } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Optional, Repeat } from "../../ir/node.js";
import type { EmitWarning } from "../backend.js";

const INDENT = "  ";

function pad(level: number): string {
  return INDENT.repeat(level);
}

function num(n: number): string {
  return String(n);
}

/** Escape a string for a double-quoted argtype literal (matches the lexer). */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

function quote(s: string): string {
  return `"${escapeString(s)}"`;
}

/** A value terminal kind whose `meta.defaultValue` argtype can express. */
function isValueTerminal(
  node: Expr,
): node is Extract<Expr, { kind: "int" | "float" | "str" | "path" }> {
  return (
    node.kind === "int" || node.kind === "float" || node.kind === "str" || node.kind === "path"
  );
}

/**
 * Find the single value terminal a wrapper's default should attach to. Descends
 * through optional/repeat and a sequence with exactly one non-literal child
 * (the flag-value pattern `seq(lit, value)`). Returns undefined when the value
 * slot is ambiguous (multiple non-literal children) or absent (a bare literal
 * flag), in which case the wrapper default has no terminal to sink onto.
 */
function findValueTerminal(node: Expr): Expr | undefined {
  switch (node.kind) {
    case "int":
    case "float":
    case "str":
    case "path":
      return node;
    case "optional":
      return findValueTerminal(node.attrs.node);
    case "repeat":
      return findValueTerminal(node.attrs.node);
    case "sequence": {
      const nonLiteral = node.attrs.nodes.filter((n) => n.kind !== "literal");
      return nonLiteral.length === 1 ? findValueTerminal(nonLiteral[0]!) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Push a wrapper's `meta.defaultValue` down onto its inner value terminal so it
 * can be emitted as `int = 5` / `.default(...)`. Boutiques (and argparse) hoist
 * an input's default onto the outermost wrapper (`optional` / `sequence`); the
 * argtype surface only carries `.default()` on a terminal, so we relocate it.
 * Boolean defaults are left in place: those are the `opt(literal)` flag-false
 * convention, which the frontend regenerates for free and which has no terminal.
 */
function sinkDefaults(expr: Expr): Expr {
  const clone = structuredClone(expr);
  const visit = (node: Expr): void => {
    switch (node.kind) {
      case "optional":
        visit(node.attrs.node);
        sinkInto(node);
        break;
      case "repeat":
        visit(node.attrs.node);
        sinkInto(node);
        break;
      case "sequence":
        for (const c of node.attrs.nodes) visit(c);
        sinkInto(node);
        break;
      case "alternative":
        for (const c of node.attrs.alts) visit(c);
        break;
      default:
        break;
    }
  };
  visit(clone);
  return clone;
}

function sinkInto(wrapper: Expr): void {
  const dv = wrapper.meta?.defaultValue;
  if (dv === undefined || typeof dv === "boolean") return;
  const terminal = findValueTerminal(wrapper);
  if (!terminal || !isValueTerminal(terminal) || terminal.meta?.defaultValue !== undefined) return;
  terminal.meta = { ...terminal.meta, defaultValue: dv };
  const meta = { ...wrapper.meta };
  delete meta.defaultValue;
  wrapper.meta = Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Detect the synthetic single-child sequence the frontend wraps a non-sequence
 * root in. Such a wrapper carries only `name` (matching the child's name) plus
 * any collected `outputs`; the doc/default live on the inner node. Returns the
 * inner node and the wrapper's outputs so the caller can emit the inner node as
 * the definition body (the frontend re-wraps it identically on re-parse).
 */
function syntheticWrap(root: Expr): { child: Expr; outputs?: Output[] } | undefined {
  if (root.kind !== "sequence" || root.attrs.nodes.length !== 1 || root.attrs.join !== undefined) {
    return undefined;
  }
  const meta = root.meta;
  if (meta?.doc || meta?.defaultValue !== undefined || meta?.variantTag !== undefined) {
    return undefined;
  }
  const child = root.attrs.nodes[0]!;
  if (child.kind === "sequence") return undefined; // the frontend only wraps non-sequences
  if ((child.meta?.name ?? undefined) !== (meta?.name ?? undefined)) return undefined;
  return { child, ...(meta?.outputs && { outputs: meta.outputs }) };
}

function hasOutputs(expr: Expr): boolean {
  return walkSome(expr, (n) => (n.meta?.outputs?.length ?? 0) > 0);
}

function hasMediaTypes(expr: Expr): boolean {
  return walkSome(expr, (n) => n.kind === "path" && (n.attrs.mediaTypes?.length ?? 0) > 0);
}

function hasPaths(expr: Expr): boolean {
  return walkSome(expr, (n) => n.kind === "path" && (!!n.attrs.mutable || !!n.attrs.resolveParent));
}

function walkSome(node: Expr, pred: (n: Expr) => boolean): boolean {
  if (pred(node)) return true;
  switch (node.kind) {
    case "sequence":
      return node.attrs.nodes.some((n) => walkSome(n, pred));
    case "alternative":
      return node.attrs.alts.some((n) => walkSome(n, pred));
    case "optional":
      return walkSome(node.attrs.node, pred);
    case "repeat":
      return walkSome(node.attrs.node, pred);
    default:
      return false;
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name rendered where an identifier is expected: bare when it is a valid
 * identifier, otherwise a double-quoted form preserving it exactly. Used for
 * both `label:` prefixes and output-template `{ref}` targets (templates accept a
 * quoted name, `{"4d_output"}`), so the two always agree and no lossy
 * sanitization is needed. */
function identOrQuoted(name: string): string {
  return IDENT_RE.test(name) ? name : quote(name);
}

class ArgtypeEmitter {
  readonly warnings: EmitWarning[] = [];

  private warn(message: string): void {
    this.warnings.push({ message });
  }

  /** Render a name as it appears before a `:` label (bare identifier or quoted
   * label, e.g. `"1deval":`, `"1D":`). */
  private labelFor(name: string): string {
    return identOrQuoted(name);
  }

  /**
   * `///` doc lines for a `Documentation`. A title is written as a leading
   * Markdown H1 (`# Title`); the description follows after a blank `///` line.
   * Either alone emits just that part.
   */
  private docLines(doc: Documentation | undefined): string[] {
    if (!doc) return [];
    const out: string[] = [];
    const push = (text: string): void => {
      for (const line of text.split("\n")) out.push(`/// ${line}`);
    };
    if (doc.title) push(`# ${doc.title}`);
    if (doc.title && doc.description) out.push("///");
    if (doc.description) push(doc.description);
    return out;
  }

  /**
   * Whether a `///` block would be misread by the title convention on re-parse,
   * so the doc must instead be emitted as `.title()` / `.description()` chaining
   * (which sets the fields verbatim). Two cases: a multi-line title (only its
   * first line would survive `splitDocText`), and a title-less description whose
   * first line looks like an H1 heading (`# ...`, which would be promoted to a
   * spurious title). A description under a title is safe - `splitDocText` only
   * consumes the very first line as the title.
   */
  private docNeedsChain(doc: Documentation | undefined): boolean {
    if (!doc) return false;
    if (doc.title?.includes("\n")) return true;
    if (!doc.title && doc.description) {
      return (doc.description.split("\n")[0] ?? "").trim().startsWith("# ");
    }
    return false;
  }

  /** `.title(...)` / `.description(...)` chaining for a doc that cannot round-trip
   * as a `///` block (see `docNeedsChain`). */
  private docChain(doc: Documentation | undefined): string {
    if (!doc) return "";
    let chain = "";
    if (doc.title) chain += `.title(${quote(doc.title)})`;
    if (doc.description) chain += `.description(${quote(doc.description)})`;
    return chain;
  }

  /**
   * Warn for `Documentation` fields a node's `///` comment cannot carry. `title`
   * and `description` are emitted (see `docLines`); literature / comment /
   * authors / urls attached to an inner node have no surface, so surface them
   * rather than dropping silently.
   */
  private warnUnrepresentableDoc(
    doc:
      | {
          literature?: string[];
          comment?: string;
          authors?: string[];
          urls?: string[];
        }
      | undefined,
    where: string,
  ): void {
    if (!doc) return;
    const lost: string[] = [];
    if (doc.literature?.length) lost.push("literature");
    if (doc.comment) lost.push("comment");
    if (doc.authors?.length) lost.push("authors");
    if (doc.urls?.length) lost.push("urls");
    if (lost.length > 0) {
      this.warn(`Documentation ${lost.join("/")} on ${where} has no argtype node surface; ignored`);
    }
  }

  emit(expr: Expr, app?: AppMeta): string {
    const raw = sinkDefaults(expr);
    const lines: string[] = [];

    // argtype describes arguments only; the executable (argv[0]) belongs in
    // frontmatter. Strip a leading command literal into `exe` so the body reads
    // as arguments (the frontend re-prepends it on parse). The tool id stays the
    // root label, which for a `wb_command <sub>` tool differs from the exe.
    let exe: string | undefined;
    let root = raw;
    if (raw.kind === "sequence" && raw.attrs.nodes[0]?.kind === "literal") {
      exe = raw.attrs.nodes[0].attrs.str;
      root = { kind: "sequence", attrs: { ...raw.attrs, nodes: raw.attrs.nodes.slice(1) } };
      if (raw.meta) root.meta = raw.meta;
    }

    const frontmatter = this.emitFrontmatter(
      app,
      exe,
      hasOutputs(root),
      hasMediaTypes(root),
      hasPaths(root),
    );
    if (frontmatter) {
      lines.push(frontmatter, "");
    }

    // The frontend wraps a non-sequence root in a synthetic single-child
    // sequence (carrying only name + collected outputs). Emit the logical inner
    // node as the definition body so the frontend re-wraps it identically;
    // emitting the wrapper instead would re-attach the root doc to the wrapper.
    const synthetic = syntheticWrap(root);
    const defNode = synthetic ? synthetic.child : root;
    const wrapperOutputs = synthetic ? synthetic.outputs : undefined;

    // The tool's title + description live in the root `///` block (from the
    // root node's doc, or the app metadata for a converted descriptor) - unless
    // the title convention would misread that block, in which case it round-trips
    // as `.title()` / `.description()` chaining on the body instead.
    const rootDoc = defNode.meta?.doc ?? app?.doc;
    const rootChain = this.docNeedsChain(rootDoc);
    if (!rootChain) lines.push(...this.docLines(rootDoc));
    // Only the node's own doc is checked here; an app doc's authors/urls are
    // representable (frontmatter) and its literature/comment are warned there.
    this.warnUnrepresentableDoc(defNode.meta?.doc, "the root node");

    const rootName = this.labelFor(defNode.meta?.name || app?.id || "tool");
    let body = this.emitNode(defNode, 0);
    if (rootChain) body += this.docChain(rootDoc);
    if (wrapperOutputs?.length) body += this.emitOutputs(wrapperOutputs, 0);
    lines.push(`${rootName}: ${body}`);

    return lines.join("\n") + "\n";
  }

  // -- Expression emission --

  /**
   * Emit a node's core expression plus its node-local chains (value
   * constraints, default, join, count, media types) and any `.output(...)`.
   * The first line is not indented (the caller places it after a label or pad);
   * continuation lines are indented relative to `level`.
   */
  private emitNode(expr: Expr, level: number): string {
    let core: string;
    switch (expr.kind) {
      case "literal":
        core = quote(expr.attrs.str);
        break;
      case "str":
        core = "str" + this.defaultSuffix(expr, false);
        break;
      case "int":
      case "float": {
        core = expr.kind;
        let chained = false;
        const min = this.finiteNum(expr.attrs.minValue, "min");
        if (min !== undefined) {
          core += `.min(${min})`;
          chained = true;
        }
        const max = this.finiteNum(expr.attrs.maxValue, "max");
        if (max !== undefined) {
          core += `.max(${max})`;
          chained = true;
        }
        core += this.defaultSuffix(expr, chained);
        break;
      }
      case "path": {
        core = "path";
        const media = expr.attrs.mediaTypes ?? [];
        for (const m of media) core += `.mediaType(${quote(m)})`;
        // `.mutable()` / `.resolveParent()` are the `paths` extension.
        if (expr.attrs.mutable) core += ".mutable()";
        if (expr.attrs.resolveParent) core += ".resolveParent()";
        const chained = media.length > 0 || !!expr.attrs.mutable || !!expr.attrs.resolveParent;
        core += this.defaultSuffix(expr, chained);
        break;
      }
      case "sequence":
        core = this.emitCombinator("seq", expr.attrs.nodes, level, expr.attrs.join);
        core += this.structuralDefaultSuffix(expr);
        break;
      case "optional":
        core = this.emitOptional(expr, level) + this.structuralDefaultSuffix(expr);
        break;
      case "repeat":
        core = this.emitRepeat(expr, level) + this.structuralDefaultSuffix(expr);
        break;
      case "alternative":
        // argtype has no surface for an explicit union discriminator: the
        // frontend re-derives an arm's `@type` tag from its label (name). That
        // reproduces the discriminant whenever `variantTag` equals the emitted
        // name (the common case), but a `variantTag` that was set to something
        // else (to disambiguate a collapsed subcommand) would change on
        // re-parse, so warn.
        for (const arm of expr.attrs.alts) {
          const tag = arm.meta?.variantTag;
          if (tag !== undefined && tag !== arm.meta?.name) {
            this.warn(
              `Union arm discriminator '${tag}' has no argtype surface and will be re-derived ` +
                `from the arm name '${arm.meta?.name ?? "<unnamed>"}' on re-parse`,
            );
          }
        }
        core =
          this.emitCombinator("alt", expr.attrs.alts, level) + this.structuralDefaultSuffix(expr);
        break;
      default: {
        const _exhaustive: never = expr;
        core = "";
      }
    }

    if (expr.meta?.outputs?.length) {
      core += this.emitOutputs(expr.meta.outputs, level);
    }
    return core;
  }

  /** `String(n)` when `n` is finite; otherwise undefined with a warning, since
   * `Infinity`/`NaN` have no argtype number literal (emitting them would produce
   * an identifier that fails to re-parse). */
  private finiteNum(n: number | undefined, where: string): string | undefined {
    if (n === undefined) return undefined;
    if (!Number.isFinite(n)) {
      this.warn(`Non-finite number (${String(n)}) on ${where} has no argtype literal; ignored`);
      return undefined;
    }
    return num(n);
  }

  /** `= value` on a bare terminal, else `.default(value)` once a chain started. */
  private defaultSuffix(expr: Expr, chained: boolean): string {
    const dv = expr.meta?.defaultValue;
    if (dv === undefined || typeof dv === "boolean") return "";
    let value: string;
    if (typeof dv === "number") {
      const n = this.finiteNum(dv, "default");
      if (n === undefined) return "";
      value = n;
    } else {
      value = quote(dv);
    }
    return chained ? `.default(${value})` : ` = ${value}`;
  }

  /**
   * A `.default(value)` chained onto a structural node (e.g. an enum
   * `alternative`, or a wrapper whose default could not sink onto an inner
   * terminal). Booleans have no argtype value literal: the only legitimate one
   * is the `opt(literal)` flag-false convention, which the frontend regenerates,
   * so it is silently dropped; any other boolean default is warned and dropped.
   */
  private structuralDefaultSuffix(expr: Expr): string {
    const dv = expr.meta?.defaultValue;
    if (dv === undefined) return "";
    if (typeof dv === "boolean") {
      const isFlagFalse =
        expr.kind === "optional" && expr.attrs.node.kind === "literal" && dv === false;
      if (!isFlagFalse) {
        this.warn(`Boolean default on a ${expr.kind} cannot be expressed in argtype; ignored`);
      }
      return "";
    }
    if (typeof dv === "number") {
      const n = this.finiteNum(dv, "default");
      return n === undefined ? "" : `.default(${n})`;
    }
    return `.default(${quote(dv)})`;
  }

  private emitOptional(expr: Optional, level: number): string {
    const inner = expr.attrs.node;
    if (inner.kind === "sequence" && !inner.meta && inner.attrs.join === undefined) {
      return this.emitCombinator("opt", inner.attrs.nodes, level);
    }
    return this.emitCombinator("opt", [inner], level);
  }

  private emitRepeat(expr: Repeat, level: number): string {
    const node = expr.attrs.node;
    let core: string;
    if (node.kind === "sequence" && !node.meta && node.attrs.join === undefined) {
      core = this.emitCombinator("rep", node.attrs.nodes, level);
    } else {
      core = this.emitCombinator("rep", [node], level);
    }
    if (expr.attrs.join !== undefined) {
      core += `.join(${expr.attrs.join === "" ? "" : quote(expr.attrs.join)})`;
    }
    // `.count(n)` for an exact count; otherwise the composable `.countMin()` /
    // `.countMax()` primitives, which express one-sided bounds too.
    const { countMin, countMax } = expr.attrs;
    if (countMin !== undefined && countMin === countMax) {
      core += `.count(${countMin})`;
    } else {
      if (countMin !== undefined) core += `.countMin(${countMin})`;
      if (countMax !== undefined) core += `.countMax(${countMax})`;
    }
    return core;
  }

  private emitCombinator(keyword: string, children: Expr[], level: number, join?: string): string {
    let core: string;
    if (children.length === 0) {
      core = `${keyword}()`;
    } else {
      const items = children.map((c) => this.emitDecorated(c, level + 1));
      // Stay on one line when no child carries a doc or spans lines and the
      // result is short, so simple groups read like hand-written argtype.
      const inline = `${keyword}(${items.join(", ")})`;
      if (!items.some((i) => i.includes("\n")) && inline.length + level * INDENT.length <= 80) {
        core = inline;
      } else {
        const padded = items.map((i) => pad(level + 1) + i);
        core = `${keyword}(\n${padded.join(",\n")},\n${pad(level)})`;
      }
    }
    if (join !== undefined) {
      core += `.join(${join === "" ? "" : quote(join)})`;
    }
    return core;
  }

  /**
   * A list item: leading `///` doc lines, an optional `label:` prefix, then the
   * node. The first line is unindented (the caller pads it); continuation lines
   * are indented to `level`.
   */
  private emitDecorated(expr: Expr, level: number): string {
    const doc = expr.meta?.doc;
    // A doc the title convention would misread is emitted as chaining on the node
    // instead of a leading `///` block (see `docNeedsChain`).
    const useChain = this.docNeedsChain(doc);
    const parts: string[] = useChain ? [] : [...this.docLines(doc)];
    this.warnUnrepresentableDoc(doc, `node '${expr.meta?.name ?? expr.kind}'`);
    // An empty name is dropped by the frontend on re-parse, so emit no label.
    const label = expr.meta?.name ? `${this.labelFor(expr.meta.name)}: ` : "";
    let node = this.emitNode(expr, level);
    if (useChain) node += this.docChain(doc);
    parts.push(label + node);
    return parts.join("\n" + pad(level));
  }

  // -- Outputs --

  private emitOutputs(outputs: Output[], level: number): string {
    const items = outputs.map((o) => {
      // A `///` doc block precedes the output entry (title-convention split),
      // unless that block would be misread - then it round-trips as `.title()` /
      // `.description()` chaining on the template, as node docs do.
      const useChain = this.docNeedsChain(o.doc);
      const docs = useChain ? [] : this.docLines(o.doc).map((l) => pad(level + 1) + l);
      let template = pad(level + 1) + this.emitOutputTemplate(o);
      if (useChain) template += this.docChain(o.doc);
      return [...docs, template].join("\n");
    });
    return `.output(\n${items.join(",\n")},\n${pad(level)})`;
  }

  private emitOutputTemplate(output: Output): string {
    if (output.mediaTypes?.length) {
      this.warn(
        `Output '${output.name ?? "<anon>"}' has media types, which have no argtype surface; ignored`,
      );
    }
    const label = output.name ? `${this.labelFor(output.name)}: ` : "";
    let body = "";
    for (const token of output.tokens) {
      if (token.kind === "literal") {
        // Escape template-significant characters so a literal `{`/`}`/backtick
        // in the path round-trips (the frontend unescapes them).
        body += token.value.replace(/[\\{}`]/g, (c) => `\\${c}`);
        continue;
      }
      // Emit the ref name the same way as the target node's `label:` (bare
      // identifier or quoted), so the `{ref}` and its `label:` stay in agreement.
      let ref = identOrQuoted(token.target.name);
      for (const ext of token.stripExtensions ?? []) ref += `.strip_suffix(${quote(ext)})`;
      if (token.fallback !== undefined) ref += `.or(${quote(token.fallback)})`;
      body += `{${ref}}`;
    }
    return `${label}\`${body}\``;
  }

  // -- Frontmatter --

  /** Quote a frontmatter scalar (double-quoted, backslash-escaped). The
   * frontmatter parser unescapes symmetrically, so quotes/newlines round-trip. */
  private fmScalar(value: string): string {
    return quote(value);
  }

  private emitFrontmatter(
    app: AppMeta | undefined,
    exe: string | undefined,
    outputs: boolean,
    mediaTypes: boolean,
    paths: boolean,
  ): string | undefined {
    const lines: string[] = [];

    // `exe` is the executable stripped from the command (argv[0]); emit it only
    // when one was present, so the frontend's re-prepend stays symmetric.
    if (exe !== undefined) lines.push(`exe: ${this.fmScalar(exe)}`);

    if (app) {
      if (app.version) lines.push(`version: ${this.fmScalar(app.version)}`);

      const authors = app.doc?.authors ?? [];
      if (authors.length > 0) {
        lines.push("authors:");
        for (const a of authors) lines.push(`  - ${this.fmScalar(a)}`);
      }

      const urls = app.doc?.urls ?? [];
      if (urls.length > 0) {
        lines.push("urls:");
        for (const u of urls) lines.push(`  - ${this.fmScalar(u)}`);
      }

      const references = app.doc?.literature ?? [];
      if (references.length > 0) {
        lines.push("references:");
        for (const rf of references) lines.push(`  - ${this.fmScalar(rf)}`);
      }

      if (app.container) {
        lines.push("container:");
        lines.push(`  image: ${this.fmScalar(app.container.image)}`);
        if (app.container.type) lines.push(`  type: ${this.fmScalar(app.container.type)}`);
      }

      if (app.stdout) this.emitStream(lines, "stdout", app.stdout);
      if (app.stderr) this.emitStream(lines, "stderr", app.stderr);

      // app.doc.title is emitted in the root `///` block, not frontmatter.
      if (app.doc?.comment) {
        this.warn("AppMeta.doc.comment has no argtype surface; ignored");
      }
    }

    const extensions: string[] = [];
    if (outputs) extensions.push("outputs");
    if (mediaTypes) extensions.push("mediatypes");
    if (paths) extensions.push("paths");
    if (extensions.length > 0) {
      lines.push("extensions:");
      for (const e of extensions) lines.push(`  - ${e}`);
    }

    if (lines.length === 0) return undefined;
    return ["---", ...lines, "---"].join("\n");
  }

  private emitStream(lines: string[], key: string, stream: StreamOutput): void {
    lines.push(`${key}:`);
    lines.push(`  name: ${this.fmScalar(stream.name)}`);
    if (stream.doc?.description)
      lines.push(`  description: ${this.fmScalar(stream.doc.description)}`);
    if (stream.doc?.title) {
      this.warn(`${key} stream title has no argtype surface; ignored`);
    }
  }
}

/** Emit argtype sugar-DSL source from an IR expression tree and optional `AppMeta`. */
export function generateArgtype(
  expr: Expr,
  app?: AppMeta,
): { source: string; warnings: EmitWarning[] } {
  const emitter = new ArgtypeEmitter();
  const source = emitter.emit(expr, app);
  return { source, warnings: emitter.warnings };
}
