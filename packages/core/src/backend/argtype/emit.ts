/**
 * argtype backend: emit argtype source from Styx IR + `AppMeta`.
 *
 * This is the inverse of the argtype frontend's lowering (`frontend/argtype/
 * lower.ts`): it walks the `Expr` tree and mirrors each lowering decision in
 * reverse. Unlike the typed-language backends it needs only the IR and
 * `AppMeta`, never the solver.
 *
 * It builds an `AstDocument` and hands it to `@argtype/core`'s `printArgtype`
 * rather than assembling text itself. That split keeps every fact about argtype
 * *syntax* - quoting, escaping, template metacharacters, indentation, when a
 * group fits on one line - in the package that defines the language, so this
 * file only has to answer the question it is actually qualified to answer:
 * which argtype construct corresponds to a given piece of IR.
 *
 * Intentional lossiness (the frontend already collapses these, so the IR holds
 * no record of them and emitting the collapsed form is correct):
 * - `set` -> `sequence` and `any` -> first branch: the IR has no such nodes, so
 *   we emit `seq` / `alt`.
 * - Output ops `strip_prefix` / `basename` and output-level `.or()` are not in
 *   the IR's `OutputToken`, so there is nothing to emit.
 *
 * IR features with no argtype surface are handled explicitly (always a backend
 * warning): output media types, stream `doc.title`,
 * `AppMeta.doc.literature/comment`, and a union arm's `variantTag` when it
 * differs from the arm name (the frontend re-derives the `@type` discriminator
 * from the name on re-parse).
 */

import {
  build,
  printArgtype,
  type Annotation,
  type AnnotationArg,
  type AstDocument,
  type AstNode,
  type TemplateToken,
} from "@argtype/core";
import type { AppMeta, Output, StreamOutput } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Optional, Repeat, Sequence } from "../../ir/node.js";
import type { EmitWarning } from "../backend.js";

// Node and annotation construction comes from `@argtype/core`'s `build`
// namespace, so this file states only the IR correspondence.
const { annotation: ann, string: str, number: numArg } = build;

/** Target content width for a `///` description line, excluding the prefix. */
const DOC_WIDTH = 80;

/**
 * Word-wrap a description to `width`, keeping blank-line paragraph breaks.
 *
 * The printer deliberately emits a `///` block line for line, because it has to
 * reproduce the source it was given. Here there is no source to reproduce: the
 * description is a semantic string that arrived from a descriptor, so choosing
 * its layout is this file's job. Wrapping round-trips exactly - the frontend
 * reflows a block as prose, rejoining a single line break with a space - and it
 * keeps a long Boutiques description from emitting as one enormous line.
 */
function wrapDoc(text: string, width: number): string {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue; // leading/trailing blank paragraph
    if (out.length > 0) out.push(""); // blank line between paragraphs
    let cur = "";
    for (const word of words) {
      if (cur === "") cur = word;
      else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
      else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur !== "") out.push(cur);
  }
  return out.join("\n");
}

// -- IR pre-passes ----------------------------------------------------------

/** A value terminal kind whose `meta.defaultValue` argtype can express. */
function isValueTerminal(n: Expr): n is Extract<Expr, { kind: "int" | "float" | "str" | "path" }> {
  return n.kind === "int" || n.kind === "float" || n.kind === "str" || n.kind === "path";
}

/**
 * Find the single value terminal a wrapper's default should attach to. Descends
 * through optional/repeat and a sequence with exactly one non-literal child
 * (the flag-value pattern `seq(lit, value)`). Returns undefined when the value
 * slot is ambiguous (multiple non-literal children) or absent (a bare literal
 * flag), in which case the wrapper default has no terminal to sink onto.
 */
function findValueTerminal(n: Expr): Expr | undefined {
  switch (n.kind) {
    case "int":
    case "float":
    case "str":
    case "path":
      return n;
    case "optional":
      return findValueTerminal(n.attrs.node);
    case "repeat":
      return findValueTerminal(n.attrs.node);
    case "sequence": {
      const nonLiteral = n.attrs.nodes.filter((c) => c.kind !== "literal");
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
  const visit = (n: Expr): void => {
    switch (n.kind) {
      case "optional":
        visit(n.attrs.node);
        sinkInto(n);
        break;
      case "repeat":
        visit(n.attrs.node);
        sinkInto(n);
        break;
      case "sequence":
        for (const c of n.attrs.nodes) visit(c);
        sinkInto(n);
        break;
      case "alternative":
        for (const c of n.attrs.alts) visit(c);
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

// -- Emitter ----------------------------------------------------------------

class ArgtypeEmitter {
  readonly warnings: EmitWarning[] = [];

  private warn(message: string): void {
    this.warnings.push({ message });
  }

  /**
   * The raw text of a `///` block for a `Documentation`. A title becomes a
   * leading Markdown H1 (`# Title`); the description follows after a blank line.
   * The printer emits the text line for line and `resolve()` splits it back, so
   * this is exactly the inverse of the title convention.
   */
  private docText(doc: Documentation | undefined): string | undefined {
    if (!doc) return undefined;
    const parts: string[] = [];
    if (doc.title) parts.push(`# ${doc.title}`);
    if (doc.description) parts.push(wrapDoc(doc.description, DOC_WIDTH));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /**
   * Whether a `///` block would not round-trip, so the doc must instead be
   * emitted as `.title()` / `.description()` chaining (which sets the fields
   * verbatim). Three cases:
   * - a multi-line title (only its first line would survive `splitDocText`);
   * - a description with a lone line break (a single `\n`, not a blank-line
   *   paragraph break), which a `///` block reflows to a space - chaining keeps
   *   the hard break intact;
   * - a title-less description whose first line looks like an H1 heading
   *   (`# ...`), which would be promoted to a spurious title.
   * A blank-line paragraph break is safe: the frontend reflows a `///` block back
   * into the same paragraphs, and a description under a title is safe too
   * (`splitDocText` consumes only the very first line as the title).
   */
  private docNeedsChain(doc: Documentation | undefined): boolean {
    if (!doc) return false;
    if (doc.title?.includes("\n")) return true;
    const desc = doc.description;
    if (desc) {
      if (desc.split(/\n{2,}/).some((para) => para.includes("\n"))) return true;
      if (!doc.title && (desc.split("\n")[0] ?? "").trim().startsWith("# ")) return true;
    }
    return false;
  }

  /** `.title(...)` / `.description(...)` for a doc that cannot round-trip as a
   * `///` block (see `docNeedsChain`). */
  private docChain(doc: Documentation | undefined): Annotation[] {
    if (!doc) return [];
    const out: Annotation[] = [];
    if (doc.title) out.push(ann("title", str(doc.title)));
    if (doc.description) out.push(ann("description", str(doc.description)));
    return out;
  }

  /** Apply a node's documentation, as a `///` block or as chaining. */
  private applyDoc(target: AstNode, doc: Documentation | undefined, where: string): void {
    this.warnUnrepresentableDoc(doc, where);
    if (this.docNeedsChain(doc)) target.annotations.push(...this.docChain(doc));
    else {
      const text = this.docText(doc);
      if (text !== undefined) target.docComment = text;
    }
  }

  /**
   * Warn for `Documentation` fields a node's `///` comment cannot carry. `title`
   * and `description` are emitted; literature / comment / authors / urls attached
   * to an inner node have no surface, so surface them rather than dropping
   * silently.
   */
  private warnUnrepresentableDoc(
    doc:
      | { literature?: string[]; comment?: string; authors?: string[]; urls?: string[] }
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

    // argtype describes arguments only; the executable (argv[0]) belongs in
    // frontmatter. Strip a leading command literal into `exe` so the body reads
    // as arguments (the frontend re-prepends it on parse). The tool id stays the
    // root label, which for a `wb_command <sub>` tool differs from the exe.
    let exe: string | undefined;
    let root = raw;
    if (raw.kind === "sequence" && raw.attrs.nodes[0]?.kind === "literal") {
      const head = raw.attrs.nodes[0];
      exe = head.attrs.str;
      // `exe` is a bare string in frontmatter, so a name or documentation on the
      // command literal has nowhere to go. It is nearly always absent (the
      // frontend synthesizes this node from `exe` and gives it neither), but
      // when a descriptor did carry one, dropping it in silence is the failure
      // this pipeline reports everywhere else.
      if (head.meta?.name) {
        this.warn(`Command literal name '${head.meta.name}' has no argtype surface; ignored`);
      }
      if (head.meta?.doc) {
        this.warn(`Documentation on the command literal has no argtype surface; ignored`);
      }
      root = { kind: "sequence", attrs: { ...raw.attrs, nodes: raw.attrs.nodes.slice(1) } };
      if (raw.meta) root.meta = raw.meta;
    }

    // The frontend wraps a non-sequence root in a synthetic single-child
    // sequence (carrying only name + collected outputs). Emit the logical inner
    // node as the definition body so the frontend re-wraps it identically;
    // emitting the wrapper instead would re-attach the root doc to the wrapper.
    const synthetic = syntheticWrap(root);
    const defNode = synthetic ? synthetic.child : root;
    const wrapperOutputs = synthetic ? synthetic.outputs : undefined;

    const body = this.buildNode(defNode);

    // The tool's title + description live in the root `///` block (from the root
    // node's doc, or the app metadata for a converted descriptor).
    const rootDoc = defNode.meta?.doc ?? app?.doc;
    // Only the node's own doc is checked for unrepresentable fields; an app
    // doc's authors/urls are representable (frontmatter) and its
    // literature/comment are warned about in `buildFrontmatter`.
    this.warnUnrepresentableDoc(defNode.meta?.doc, "the root node");
    if (this.docNeedsChain(rootDoc)) body.annotations.push(...this.docChain(rootDoc));
    else {
      const text = this.docText(rootDoc);
      if (text !== undefined) body.docComment = text;
    }

    if (wrapperOutputs?.length) body.annotations.push(this.buildOutputs(wrapperOutputs));

    // The root's name is carried by the document's `rootName`, not a label.
    delete body.label;
    delete body.labelQuoted;

    const rootName = defNode.meta?.name || app?.id || "tool";
    const frontmatter = this.buildFrontmatter(app, exe);

    const doc: AstDocument = {
      ...(frontmatter && { frontmatter }),
      aliases: [],
      rootName,
      ...(!build.isIdentifier(rootName) && { rootNameQuoted: true }),
      root: body,
    };
    return printArgtype(doc);
  }

  // -- Expressions --

  /** Build the AST node for an IR expression, including its decorations. */
  private buildNode(expr: Expr): AstNode {
    let out: AstNode;
    switch (expr.kind) {
      case "literal":
        out = build.literal(expr.attrs.str);
        break;
      case "str":
        out = build.terminal("str");
        this.addDefault(out, expr);
        break;
      case "int":
      case "float": {
        out = build.terminal(expr.kind);
        const min = this.finiteNum(expr.attrs.minValue, "min");
        if (min !== undefined) out.annotations.push(ann("min", numArg(min)));
        const max = this.finiteNum(expr.attrs.maxValue, "max");
        if (max !== undefined) out.annotations.push(ann("max", numArg(max)));
        this.addDefault(out, expr);
        break;
      }
      case "path": {
        out = build.terminal("path");
        for (const m of expr.attrs.mediaTypes ?? []) {
          out.annotations.push(ann("mediaType", str(m)));
        }
        // `.mutable()` / `.resolveParent()` are the `paths` extension.
        if (expr.attrs.mutable) out.annotations.push(ann("mutable"));
        if (expr.attrs.resolveParent) out.annotations.push(ann("resolveParent"));
        this.addDefault(out, expr);
        break;
      }
      case "sequence":
        out = build.seq(...expr.attrs.nodes.map((c) => this.buildChild(c)));
        if (expr.attrs.join !== undefined) out.annotations.push(joinAnn(expr.attrs.join));
        // No `addStructuralDefault`: a `seq`/`set` struct has no scalar to
        // default, so the frontend warns and drops one. Emitting it anyway made
        // the round trip unstable - the text we wrote did not survive being read
        // back - and produced a warning on a document nobody hand-wrote.
        this.warnDroppedDefault(expr, "seq");
        break;
      case "optional":
        out = this.buildOptional(expr);
        this.addStructuralDefault(out, expr);
        break;
      case "repeat":
        out = this.buildRepeat(expr);
        this.addStructuralDefault(out, expr);
        break;
      case "alternative": {
        // argtype has no surface for an explicit union discriminator: the
        // frontend re-derives an arm's `@type` tag from its label (name). That
        // reproduces the discriminant whenever `variantTag` equals the emitted
        // name (the common case), but a `variantTag` set to something else (to
        // disambiguate a collapsed subcommand) would change on re-parse.
        for (const arm of expr.attrs.alts) {
          const tag = arm.meta?.variantTag;
          if (tag !== undefined && tag !== arm.meta?.name) {
            this.warn(
              `Union arm discriminator '${tag}' has no argtype surface and will be re-derived ` +
                `from the arm name '${arm.meta?.name ?? "<unnamed>"}' on re-parse`,
            );
          }
        }
        // Always the `alt(...)` call form, never the `|` operator: the operator
        // form cannot carry a decoration, and a union routinely has a default.
        out = build.alt(...expr.attrs.alts.map((c) => this.buildChild(c)));
        this.addStructuralDefault(out, expr);
        break;
      }
      default: {
        const _exhaustive: never = expr;
        out = build.seq();
      }
    }

    if (expr.meta?.outputs?.length) {
      out.annotations.push(this.buildOutputs(expr.meta.outputs));
    }
    // `= value` sugar is only spellable in last position, and `addDefault`
    // decides it before the outputs above (and the doc chain in `buildChild`)
    // are appended. The printer already refuses to emit sugar that is no longer
    // last, so this is about the AST telling the truth: a node flagged `sugar`
    // in a position where sugar cannot be written is a tree that does not
    // describe the text it prints as.
    const last = out.annotations[out.annotations.length - 1];
    for (const annotation of out.annotations) {
      if (annotation.sugar && annotation !== last) delete annotation.sugar;
    }
    return out;
  }

  /** A list item: the node plus its `label:` and documentation. */
  private buildChild(expr: Expr): AstNode {
    const out = this.buildNode(expr);
    this.applyDoc(out, expr.meta?.doc, `node '${expr.meta?.name ?? expr.kind}'`);
    // An empty name is dropped by the frontend on re-parse, so emit no label.
    if (expr.meta?.name) build.labelled(out, expr.meta.name);
    return out;
  }

  /**
   * Whether an `opt`/`rep`'s inner sequence should spread into the wrapper's
   * argument list rather than be emitted as a nested `seq(...)`.
   *
   * The frontend's `wrapChildren` returns a lone child unwrapped, so emitting
   * `opt(seq("-a"))` for a sequence carrying nothing re-parses as `opt("-a")`
   * and the next emit disagrees with this one. The condition is whether the
   * sequence carries anything that spreading would lose - and an empty `meta`
   * object carries nothing, so testing for the object's *presence* got this
   * wrong (a `{}` blocked the spread and broke idempotence).
   */
  private buildOptional(expr: Optional): AstNode {
    const inner = expr.attrs.node;
    const children = spreadsIntoWrapper(inner)
      ? (inner as Sequence).attrs.nodes.map((c) => this.buildChild(c))
      : [this.buildChild(inner)];
    return build.opt(...children);
  }

  private buildRepeat(expr: Repeat): AstNode {
    const inner = expr.attrs.node;
    const children = spreadsIntoWrapper(inner)
      ? (inner as Sequence).attrs.nodes.map((c) => this.buildChild(c))
      : [this.buildChild(inner)];
    const out = build.rep(...children);
    if (expr.attrs.join !== undefined) out.annotations.push(joinAnn(expr.attrs.join));
    // `.count(n)` for an exact count; otherwise the composable `.countMin()` /
    // `.countMax()` primitives, which express one-sided bounds too.
    const { countMin, countMax } = expr.attrs;
    if (countMin !== undefined && countMin === countMax) {
      out.annotations.push(ann("count", numArg(countMin)));
    } else {
      if (countMin !== undefined) out.annotations.push(ann("countMin", numArg(countMin)));
      if (countMax !== undefined) out.annotations.push(ann("countMax", numArg(countMax)));
    }
    return out;
  }

  /** `String(n)` when `n` is finite; otherwise undefined with a warning, since
   * `Infinity`/`NaN` have no argtype number literal (emitting them would produce
   * an identifier that fails to re-parse). */
  private finiteNum(n: number | undefined, where: string): number | undefined {
    if (n === undefined) return undefined;
    if (!Number.isFinite(n)) {
      this.warn(`Non-finite number (${String(n)}) on ${where} has no argtype literal; ignored`);
      return undefined;
    }
    return n;
  }

  /** A terminal's default: `= value` when nothing else is chained (the sugar a
   * hand-author would write), `.default(value)` once a chain has started. */
  private addDefault(target: AstNode, expr: Expr): void {
    const dv = expr.meta?.defaultValue;
    if (dv === undefined || typeof dv === "boolean") return;
    let value: AnnotationArg["value"];
    if (typeof dv === "number") {
      const n = this.finiteNum(dv, "default");
      if (n === undefined) return;
      value = numArg(n);
    } else {
      value = str(dv);
    }
    // `= value` is the sugar a hand-author would write; once a chain has
    // started it has to be `.default(value)`.
    const sugar = target.annotations.length === 0;
    target.annotations.push(sugar ? build.defaultSugar(value) : ann("default", value));
  }

  /**
   * A `.default(value)` on a structural node (e.g. an enum `alternative`, or a
   * wrapper whose default could not sink onto an inner terminal). Booleans have
   * no argtype value literal: the only legitimate one is the `opt(literal)`
   * flag-false convention, which the frontend regenerates, so it is silently
   * dropped; any other boolean default is warned and dropped.
   */
  /**
   * Report a default the emitter deliberately does not write, because the
   * frontend's target rules would reject it on the node it would land on.
   *
   * Mirroring the upstream rule here rather than emitting and letting the
   * frontend complain is what keeps `IR -> argtype -> IR` stable: the corpus
   * round-trip asserts the emitted text re-parses cleanly, so any annotation the
   * reader is going to refuse must not be written in the first place.
   */
  private warnDroppedDefault(expr: Expr, target: string): void {
    if (expr.meta?.defaultValue === undefined) return;
    this.warn(`Default on a ${expr.kind} has no argtype surface on a '${target}'; ignored`);
  }

  private addStructuralDefault(target: AstNode, expr: Expr): void {
    const dv = expr.meta?.defaultValue;
    if (dv === undefined) return;
    if (typeof dv === "boolean") {
      const isFlagFalse =
        expr.kind === "optional" && expr.attrs.node.kind === "literal" && dv === false;
      if (!isFlagFalse) {
        this.warn(`Boolean default on a ${expr.kind} cannot be expressed in argtype; ignored`);
      }
      return;
    }
    if (typeof dv === "number") {
      const n = this.finiteNum(dv, "default");
      if (n !== undefined) target.annotations.push(ann("default", numArg(n)));
      return;
    }
    target.annotations.push(ann("default", str(dv)));
  }

  // -- Outputs --

  private buildOutputs(outputs: Output[]): Annotation {
    return { ...ann("output"), args: outputs.map((o) => this.buildOutputArg(o)) };
  }

  private buildOutputArg(output: Output): AnnotationArg {
    if (output.mediaTypes?.length) {
      this.warn(
        `Output '${output.name ?? "<anon>"}' has media types, which have no argtype surface; ignored`,
      );
    }

    const tokens: TemplateToken[] = output.tokens.map((token) => {
      if (token.kind === "literal") return build.templateText(token.value);
      const chain: Annotation[] = [];
      for (const ext of token.stripExtensions ?? []) {
        chain.push(ann("strip_suffix", str(ext)));
      }
      if (token.fallback !== undefined) chain.push(ann("or", str(token.fallback)));
      // `interpolation` mirrors the target node's `label:` quoting rule, so the
      // reference and the label it points at always agree.
      return build.interpolation(token.target.name, ...chain);
    });

    const out: AnnotationArg = build.argument(build.template(tokens));
    if (output.name) {
      out.label = output.name;
      if (!build.isIdentifier(output.name)) out.labelQuoted = true;
    }

    // A `///` block precedes the entry, unless the title convention would misread
    // it - then it round-trips as chaining on the template, as node docs do.
    this.warnUnrepresentableDoc(output.doc, `output '${output.name ?? "<anon>"}'`);
    if (this.docNeedsChain(output.doc)) out.chain.push(...this.docChain(output.doc));
    else {
      const text = this.docText(output.doc);
      if (text !== undefined) out.docComment = text;
    }
    return out;
  }

  // -- Frontmatter --

  private buildFrontmatter(
    app: AppMeta | undefined,
    exe: string | undefined,
  ): Record<string, unknown> | undefined {
    const fm: Record<string, unknown> = {};

    // `exe` is the executable stripped from the command (argv[0]); emit it only
    // when one was present, so the frontend's re-prepend stays symmetric.
    if (exe !== undefined) fm.exe = exe;

    if (app) {
      if (app.version) fm.version = app.version;
      if (app.doc?.authors?.length) fm.authors = app.doc.authors;
      if (app.doc?.urls?.length) fm.urls = app.doc.urls;
      if (app.doc?.literature?.length) fm.references = app.doc.literature;

      if (app.container) {
        fm.container = {
          image: app.container.image,
          ...(app.container.type && { type: app.container.type }),
        };
      }

      const stream = (key: "stdout" | "stderr", value: StreamOutput | undefined): void => {
        if (!value) return;
        fm[key] = {
          name: value.name,
          ...(value.doc?.description && { description: value.doc.description }),
        };
        if (value.doc?.title) {
          this.warn(`${key} stream title has no argtype surface; ignored`);
        }
      };
      stream("stdout", app.stdout);
      stream("stderr", app.stderr);

      // app.doc.title is emitted in the root `///` block, not frontmatter.
      if (app.doc?.comment) {
        this.warn("AppMeta.doc.comment has no argtype surface; ignored");
      }
    }

    return Object.keys(fm).length > 0 ? fm : undefined;
  }
}

/** `.join()` with an empty separator takes no argument. */
/** A sequence that carries nothing of its own spreads into its `opt`/`rep`. */
function spreadsIntoWrapper(inner: Expr): inner is Sequence {
  if (inner.kind !== "sequence" || inner.attrs.join !== undefined) return false;
  const meta = inner.meta;
  return meta === undefined || Object.values(meta).every((v) => v === undefined);
}

function joinAnn(separator: string): Annotation {
  return separator === "" ? ann("join") : ann("join", str(separator));
}

/** Emit argtype source from an IR expression tree and optional `AppMeta`. */
export function generateArgtype(
  expr: Expr,
  app?: AppMeta,
): { source: string; warnings: EmitWarning[] } {
  const emitter = new ArgtypeEmitter();
  const source = emitter.emit(expr, app);
  return { source, warnings: emitter.warnings };
}
