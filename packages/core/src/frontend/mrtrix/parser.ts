import { alt, float, int, lit, opt, path, rep, repJoin, seq, str } from "../../ir/builders.js";
import { nodeRef } from "../../ir/meta.js";
import type { AppMeta, NodeMeta, Output } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Sequence } from "../../ir/node.js";
import { snakeCase } from "../../backend/string-case.js";
import type {
  Frontend,
  ParseError,
  ParseResult,
  ParseWarning,
  SourceLocation,
} from "../frontend.js";

// Type guards

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

/** Coerce a possibly-missing list field to an array. */
function asArray(x: unknown): unknown[] {
  return isArray(x) ? x : [];
}

/** Input file types: each maps to a plain path terminal. */
const INPUT_TYPES = new Set<string>(["file in", "image in", "directory in", "tracks in"]);

/** Output file types: each maps to a `str` (the user-supplied filename) + an `Output`. */
const OUTPUT_TYPES = new Set<string>(["file out", "image out", "directory out", "tracks out"]);

/** A fresh empty root sequence for error returns (IR passes mutate in place,
 * so callers must not share a single instance). */
function emptyExpr(): Sequence {
  return { kind: "sequence", attrs: { nodes: [] } };
}

/**
 * Parser for MRtrix3 C++ command definitions (`mrtrix.json`), as dumped by the
 * `__print_usage_json__` hook (see niwrap `extraction/mrtrix/`).
 *
 * The format is flat: positional `arguments`, plus `option_groups[].options`
 * where each option is a single-dash switch (`-id`) carrying 0..N positional
 * `arguments`. There are no unions, conditionals, or nested options. We lower
 * it onto the same `Expr` shapes the Boutiques/Workbench parsers emit:
 *
 *   <command> <positionals...> [-option ...] ...
 *
 *   - argument (input type)  -> typed terminal
 *   - argument (`* out`)     -> str terminal + an Output entry referencing it
 *   - option, 0 args         -> opt(lit(-switch))                  (bool flag)
 *   - option, 1 arg          -> opt(seq(lit(-switch), value))      (flat optional)
 *   - option, >1 arg / multi -> opt|rep(seq(lit(-switch), ...))    (sub-struct)
 *
 * Type mapping mirrors the v1 `mrt2bt.js` converter's `set_type`. The dump does
 * not carry choice values, so a `choice` argument degrades to a plain string
 * (as it did in v1). Per-command quirks v1 hand-coded (e.g. dwi2fod/mtnormalise
 * paired in/out args, mrconvert comma lists) are intentionally NOT special-cased
 * here - they are patched on the niwrap side post-dump, keeping this frontend
 * format-general.
 */
export class MrtrixParser implements Frontend {
  readonly name = "mrtrix";
  readonly extensions = ["json"];

  private errors: ParseError[] = [];
  private warnings: ParseWarning[] = [];
  // Root-level sibling names (positionals + options). MRtrix reuses an id
  // across the positional and option namespaces (e.g. amp2response's `directions`
  // is both), which would collide as struct field names once flattened. Unlike
  // Boutiques/argdump/workbench, this format does not guarantee unique ids, so
  // the frontend disambiguates. The flag token keeps the raw `-id`; only the
  // binding name is suffixed.
  private usedNames = new Set<string>();

  private reset(): void {
    this.errors = [];
    this.warnings = [];
    this.usedNames = new Set<string>();
  }

  /** Reserve a unique sibling name, suffixing `_2`, `_3`, ... on collision. */
  private uniqueName(base: string): string {
    if (!this.usedNames.has(base)) {
      this.usedNames.add(base);
      return base;
    }
    let n = 2;
    while (this.usedNames.has(`${base}_${n}`)) n++;
    const name = `${base}_${n}`;
    this.usedNames.add(name);
    this.warn(`Duplicate id '${base}'; renamed a sibling binding to '${name}'`);
    return name;
  }

  private error(message: string, location?: SourceLocation): void {
    this.errors.push({ message, location });
  }

  private warn(message: string, location?: SourceLocation): void {
    this.warnings.push({ message, location });
  }

  private parseJSON(source: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (e) {
      this.error(e instanceof SyntaxError ? e.message : "Invalid JSON");
      return null;
    }
    if (!isObject(parsed)) {
      this.error("JSON source is not an object");
      return null;
    }
    return parsed;
  }

  // -- Metadata --

  private docFrom(description: unknown): Documentation | undefined {
    return isString(description) && description.length > 0 ? { description } : undefined;
  }

  private buildAppMeta(cmd: Record<string, unknown>): AppMeta | undefined {
    const name = cmd.name;
    if (!isString(name) || name.length === 0) {
      this.error("MRtrix descriptor missing required 'name' string");
      return undefined;
    }

    const synopsis = cmd.synopsis;
    const paragraphs = asArray(cmd.description).filter(isString).join("\n\n");
    const author = cmd.author;
    const references = asArray(cmd.references).filter(isString);
    const version = cmd.version;

    const doc: Documentation = {
      ...(isString(synopsis) && synopsis.length > 0 && { title: synopsis }),
      ...(paragraphs.length > 0 && { description: paragraphs }),
      ...(isString(author) && author.length > 0 && { authors: [author] }),
      ...(references.length > 0 && { literature: references }),
      urls: [`https://mrtrix.readthedocs.io/en/latest/reference/commands/${name}.html`],
    };

    return {
      id: name,
      ...(isString(version) && version.length > 0 && { version }),
      doc,
    };
  }

  // -- Terminals --

  /**
   * Lower one MRtrix argument to its terminal node (carrying name + doc) and,
   * for output types, an accompanying `Output`. `commaText` is the description
   * used to decide whether a numeric sequence is comma-joined (v1 heuristic).
   */
  private buildArgTerminal(
    arg: Record<string, unknown>,
    meta: NodeMeta,
    commaText: string,
  ): { node: Expr; output?: Output } | null {
    const argType = arg.type;
    if (!isString(argType)) {
      this.error(`MRtrix argument '${String(arg.id)}' missing 'type'`);
      return null;
    }

    const commaJoined = commaText.includes("comma-separated");
    const name = meta.name!;

    switch (argType) {
      case "integer":
        return { node: int(meta) };
      case "float":
        return { node: float(meta) };
      case "text":
      case "choice": // choice values are not emitted in the dump; treat as string
      case "undefined":
        return { node: str(meta) };
      case "int seq": {
        const node = commaJoined ? repJoin(",", int()) : rep(int());
        node.meta = meta;
        return { node };
      }
      case "float seq": {
        const node = commaJoined ? repJoin(",", float()) : rep(float());
        node.meta = meta;
        return { node };
      }
      case "various": {
        // Anything: a bare string or a file. Mirror v1's `VariousString`/
        // `VariousFile` union so a path can be mounted while a plain literal is
        // still accepted. Union arms must be single-field structs (a bare scalar
        // arm has no data key for the backend to read); the `variantTag` keeps
        // the two `@type`s distinct after each single-field struct collapses.
        const stringArm = seq(str({ name: "obj" }));
        stringArm.meta = { name: "VariousString", variantTag: "VariousString" };
        const fileArm = seq(path({ name: "obj" }));
        fileArm.meta = { name: "VariousFile", variantTag: "VariousFile" };
        const node = alt(stringArm, fileArm);
        node.meta = meta;
        return { node };
      }
      default: {
        if (INPUT_TYPES.has(argType)) {
          return { node: path(meta) };
        }
        if (OUTPUT_TYPES.has(argType)) {
          const node = str(meta);
          const output: Output = {
            name,
            ...(meta.doc && { doc: meta.doc }),
            tokens: [{ kind: "ref", target: nodeRef(name) }],
            mediaTypes: [`mrtrix/${argType}`],
          };
          return { node, output };
        }
        this.error(`Unknown MRtrix type '${argType}' for '${name}'`);
        return null;
      }
    }
  }

  /**
   * A positional argument: typed terminal, wrapped for cardinality. Output-type
   * positionals push their `Output` onto the root's `outputs` collector.
   */
  private buildPositional(arg: unknown, commaText: string, rootOutputs: Output[]): Expr | null {
    if (!isObject(arg)) {
      this.warn("Skipping non-object argument");
      return null;
    }
    const id = arg.id;
    if (!isString(id)) {
      this.error("MRtrix argument missing 'id'");
      return null;
    }
    const meta: NodeMeta = {
      name: this.uniqueName(snakeCase(id)),
      ...this.docMeta(arg.description),
    };
    const built = this.buildArgTerminal(arg, meta, commaText);
    if (!built) return null;
    if (built.output) rootOutputs.push(built.output);

    return this.applyCardinality(built.node, arg, built.output !== undefined);
  }

  /** Wrap a terminal for `allow_multiple` (repeat) and `optional` (optional). */
  private applyCardinality(node: Expr, arg: Record<string, unknown>, isOutput: boolean): Expr {
    let result = node;
    if (arg.allow_multiple === true && !isOutput && result.kind !== "repeat") {
      result = rep(result);
    } else if (arg.allow_multiple === true && isOutput) {
      // Styx cannot rewrite a repeated output filename argument; v1 demoted
      // these to a single output. Keep the single str + warn.
      this.warn(`Output argument '${String(arg.id)}' is allow_multiple; treating as single`);
    }
    if (arg.optional === true) {
      result = opt(result);
    }
    return result;
  }

  private docMeta(description: unknown): { doc?: Documentation } {
    const doc = this.docFrom(description);
    return doc ? { doc } : {};
  }

  // -- Options --

  /**
   * An option `-{id}` with 0..N arguments. Returns the node plus any outputs
   * that must live on the ROOT (collapsing single-value options); sub-struct
   * options carry their own outputs on the struct sequence's meta.
   */
  private buildOption(option: unknown): { node: Expr; rootOutputs: Output[] } | null {
    if (!isObject(option)) {
      this.warn("Skipping non-object option");
      return null;
    }
    const id = option.id;
    if (!isString(id)) {
      this.error("MRtrix option missing 'id'");
      return null;
    }
    const flag = `-${id}`;
    const name = this.uniqueName(snakeCase(id));
    const optDoc = this.docFrom(option.description);
    const optDescText = isString(option.description) ? option.description : "";
    const args = asArray(option.arguments);

    // Bool flag: no arguments.
    if (args.length === 0) {
      const meta: NodeMeta = { name, ...(optDoc && { doc: optDoc }), defaultValue: false };
      return { node: opt(lit(flag), meta), rootOutputs: [] };
    }

    // Single value, single occurrence: flat optional scalar named by the option.
    // The argument's own id is usually a generic metavar ("number"/"image"), so
    // the binding takes the option's id + description (matches v1).
    if (args.length === 1 && option.allow_multiple !== true) {
      const arg = args[0];
      if (!isObject(arg)) {
        this.error(`MRtrix option '${id}' has a non-object argument`);
        return null;
      }
      const meta: NodeMeta = { name, ...(optDoc && { doc: optDoc }) };
      const built = this.buildArgTerminal(arg, meta, optDescText);
      if (!built) return null;
      const valueNode = this.applyCardinality(built.node, arg, built.output !== undefined);
      const node = opt(seq(lit(flag), valueNode));
      return { node, rootOutputs: built.output ? [built.output] : [] };
    }

    // Sub-struct: multiple arguments and/or a repeatable option.
    const inner: Expr[] = [lit(flag)];
    const structOutputs: Output[] = [];
    for (const rawArg of args) {
      if (!isObject(rawArg)) {
        this.warn(`Skipping non-object argument of option '${id}'`);
        continue;
      }
      const argId = rawArg.id;
      if (!isString(argId)) {
        this.error(`MRtrix option '${id}' has an argument missing 'id'`);
        continue;
      }
      // Fall back to the option's doc when the argument carries none.
      const argDoc = this.docFrom(rawArg.description) ?? optDoc;
      const meta: NodeMeta = { name: snakeCase(argId), ...(argDoc && { doc: argDoc }) };
      const built = this.buildArgTerminal(rawArg, meta, optDescText);
      if (!built) continue;
      const valueNode = this.applyCardinality(built.node, rawArg, built.output !== undefined);
      inner.push(valueNode);
      if (built.output) structOutputs.push(built.output);
    }

    const structSeq = seq(...inner);
    structSeq.meta = { name, ...(structOutputs.length > 0 && { outputs: structOutputs }) };
    const wrapperMeta: NodeMeta | undefined = optDoc ? { doc: optDoc } : undefined;
    const node =
      option.allow_multiple === true ? rep(structSeq, wrapperMeta) : opt(structSeq, wrapperMeta);
    return { node, rootOutputs: [] };
  }

  // -- Public API --

  parse(source: string, _filename?: string): ParseResult {
    this.reset();

    const cmd = this.parseJSON(source);
    if (!cmd) {
      return { expr: emptyExpr(), errors: this.errors, warnings: this.warnings };
    }

    const meta = this.buildAppMeta(cmd);
    if (!meta || !isString(cmd.name)) {
      return { expr: emptyExpr(), errors: this.errors, warnings: this.warnings };
    }

    // Combined tool description drives comma-join detection for positionals,
    // matching v1's `obj.description.includes("comma-separated")`.
    const toolText = [
      isString(cmd.synopsis) ? cmd.synopsis : "",
      asArray(cmd.description).filter(isString).join("\n"),
    ].join("\n");

    const nodes: Expr[] = [lit(cmd.name)];
    const rootOutputs: Output[] = [];

    // Positionals first (ergonomic signature; MRtrix parses options anywhere).
    for (const arg of asArray(cmd.arguments)) {
      const node = this.buildPositional(arg, toolText, rootOutputs);
      if (node) nodes.push(node);
    }

    // Then options, in declaration order across all groups (incl. __standard_options).
    for (const group of asArray(cmd.option_groups)) {
      if (!isObject(group)) continue;
      for (const option of asArray(group.options)) {
        const built = this.buildOption(option);
        if (!built) continue;
        nodes.push(built.node);
        rootOutputs.push(...built.rootOutputs);
      }
    }

    const rootSeq = seq(...nodes);
    rootSeq.meta = { name: meta.id, ...(rootOutputs.length > 0 && { outputs: rootOutputs }) };

    return { meta, expr: rootSeq, errors: this.errors, warnings: this.warnings };
  }
}
