import { lit, opt, rep, seq, str, int, float, alt } from "../../ir/builders.js";
import { nodeRef } from "../../ir/meta.js";
import type { AppMeta, NodeMeta, Output } from "../../ir/meta.js";
import type { Documentation } from "../../ir/types.js";
import type { Expr, Path, Sequence } from "../../ir/node.js";
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

// Workbench scalar/file type strings. See the v1 loader's model.py.
const TYPE_STRING = "String";
const TYPE_FLOATING_POINT = "Floating Point";
const TYPE_INTEGER = "Integer";
const TYPE_BOOLEAN = "Boolean";

const FILE_TYPES = new Set<string>([
  "Surface File",
  "Border File",
  "Metric File",
  "Annotation File",
  "Cifti File",
  "Volume File",
  "Label File",
  "Foci File",
]);

/** A fresh empty root sequence for error returns (IR passes mutate in place,
 * so callers must not share a single instance). */
function emptyExpr(): Sequence {
  return { kind: "sequence", attrs: { nodes: [] } };
}

/**
 * Parser for Connectome Workbench command definitions (`workbench.json`).
 *
 * The format is recursive but flat in expressivity: positional `params`,
 * positional `outputs`, optional `options`, and `repeatable_options`, where an
 * option may nest its own options/repeatable_options arbitrarily deep. There
 * are no unions, constraints, or conditionals. We lower it onto the same `Expr`
 * shapes the Boutiques parser already emits for flagged sub-sequences:
 *
 *   wb_command <command> <positionals...> [option ...] ...
 *
 *   - param            -> typed terminal (required)
 *   - output           -> str terminal (the user-supplied filename) + an Output
 *                         entry on the enclosing struct's meta, referencing it
 *   - option           -> opt(seq(lit(switch), ...))  (or opt(lit(switch)) flag)
 *   - repeatable_option-> rep(seq(lit(switch), ...))   (or rep(lit(switch)) count)
 *
 * v1 reference: ../niwrap/tooling/src/wrap/apps/build/loaders/workbench/.
 */
export class WorkbenchParser implements Frontend {
  readonly name = "workbench";
  readonly extensions = ["json"];

  private errors: ParseError[] = [];
  private warnings: ParseWarning[] = [];

  private reset(): void {
    this.errors = [];
    this.warnings = [];
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
    const command = cmd.command;
    if (!isString(command)) {
      this.error("Workbench descriptor missing required 'command' string");
      return undefined;
    }

    const id = normalizeName(command);
    const title = cmd.short_description;
    const description = cmd.help_text;
    const doc: Documentation = {
      ...(isString(title) && { title }),
      ...(isString(description) && { description }),
    };

    const version = extractVersion(cmd.version_info);
    return {
      id,
      ...(version && { version }),
      ...(Object.keys(doc).length > 0 && { doc }),
    };
  }

  // -- Terminals --

  /** Map a workbench scalar/file type string to an IR terminal node. */
  private buildTerminal(type: string, meta: NodeMeta, ctx: string): Expr | null {
    switch (type) {
      case TYPE_STRING:
        return str(meta);
      case TYPE_INTEGER:
        return int(meta);
      case TYPE_FLOATING_POINT:
        return float(meta);
      case TYPE_BOOLEAN: {
        // A positional boolean emits the literal token "true" or "false". The
        // idiomatic styx2 representation is a two-literal choice (v1 used a
        // value_true/value_false Bool, which produces the same tokens).
        const node = alt(lit("true"), lit("false"));
        node.meta = meta;
        return node;
      }
      default: {
        if (FILE_TYPES.has(type)) {
          const node: Path = {
            kind: "path",
            attrs: { mediaTypes: [`workbench/${type}`] },
            meta,
          };
          return node;
        }
        this.error(`Unknown workbench type '${type}' for '${ctx}'`);
        return null;
      }
    }
  }

  // -- Params / outputs --

  /** Positional parameter -> required typed terminal. */
  private buildParam(param: unknown): Expr | null {
    if (!isObject(param)) {
      this.warn("Skipping non-object param");
      return null;
    }
    const shortName = param.short_name;
    const type = param.type;
    if (!isString(shortName) || !isString(type)) {
      this.error("Workbench param missing 'short_name'/'type'");
      return null;
    }
    const doc = this.docFrom(param.description);
    const meta: NodeMeta = { name: snakeCase(shortName), ...(doc && { doc }) };
    return this.buildTerminal(type, meta, shortName);
  }

  /**
   * Positional/option output -> a `str` terminal (the user-supplied output
   * filename) plus an `Output` declaration referencing it by name. Mirrors v1's
   * `_load_output`, which emits both a String param and an OutputParamReference.
   */
  private buildOutput(output: unknown): { node: Expr; output: Output } | null {
    if (!isObject(output)) {
      this.warn("Skipping non-object output");
      return null;
    }
    const shortName = output.short_name;
    const type = output.type;
    if (!isString(shortName) || !isString(type)) {
      this.error("Workbench output missing 'short_name'/'type'");
      return null;
    }
    if (!FILE_TYPES.has(type)) {
      this.error(`Workbench output '${shortName}' has non-file type '${type}'`);
      return null;
    }
    const name = snakeCase(shortName);
    const doc = this.docFrom(output.description);
    const node = str({ name, ...(doc && { doc }) });
    const out: Output = {
      name,
      ...(doc && { doc }),
      tokens: [{ kind: "ref", target: nodeRef(name) }],
      mediaTypes: [`workbench/${type}`],
    };
    return { node, output: out };
  }

  // -- Options --

  /**
   * An option/repeatable_option -> an optional (or repeated) switch group.
   *
   * With no sub-content it collapses to a bare flag (`opt(lit(switch))` ->
   * bool, `rep(lit(switch))` -> count). With content it is a struct sequence
   * `seq(lit(switch), ...)`; the struct's name + any outputs live on that
   * sequence's meta, the option's doc on the optional/repeat wrapper (matching
   * the Boutiques metadata-hoisting convention).
   */
  private buildOption(option: unknown, repeatable: boolean): Expr | null {
    if (!isObject(option)) {
      this.warn("Skipping non-object option");
      return null;
    }
    const sw = option.option_switch;
    if (!isString(sw)) {
      this.error("Workbench option missing 'option_switch'");
      return null;
    }
    const name = normalizeName(sw);
    const doc = this.docFrom(option.description);

    const inner: Expr[] = [lit(sw)];
    const outputs: Output[] = [];

    for (const p of asArray(option.params)) {
      const node = this.buildParam(p);
      if (node) inner.push(node);
    }
    for (const o of asArray(option.outputs)) {
      const built = this.buildOutput(o);
      if (built) {
        inner.push(built.node);
        outputs.push(built.output);
      }
    }
    for (const o of asArray(option.options)) {
      const node = this.buildOption(o, false);
      if (node) inner.push(node);
    }
    for (const o of asArray(option.repeatable_options)) {
      const node = this.buildOption(o, true);
      if (node) inner.push(node);
    }

    const wrapperMeta: NodeMeta = { ...(doc && { doc }) };

    if (inner.length === 1) {
      // Pure flag: no parameters or sub-options.
      const flagMeta: NodeMeta = { name, ...wrapperMeta };
      if (!repeatable) flagMeta.defaultValue = false;
      return repeatable ? rep(lit(sw), flagMeta) : opt(lit(sw), flagMeta);
    }

    const structSeq = seq(...inner);
    structSeq.meta = { name, ...(outputs.length > 0 && { outputs }) };
    return repeatable ? rep(structSeq, wrapperMeta) : opt(structSeq, wrapperMeta);
  }

  // -- Public API --

  parse(source: string, _filename?: string): ParseResult {
    this.reset();

    const cmd = this.parseJSON(source);
    if (!cmd) {
      return { expr: emptyExpr(), errors: this.errors, warnings: this.warnings };
    }

    const meta = this.buildAppMeta(cmd);
    if (!meta || !isString(cmd.command)) {
      return { expr: emptyExpr(), errors: this.errors, warnings: this.warnings };
    }

    const nodes: Expr[] = [lit("wb_command"), lit(cmd.command)];
    const rootOutputs: Output[] = [];

    for (const p of asArray(cmd.params)) {
      const node = this.buildParam(p);
      if (node) nodes.push(node);
    }
    for (const o of asArray(cmd.outputs)) {
      const built = this.buildOutput(o);
      if (built) {
        nodes.push(built.node);
        rootOutputs.push(built.output);
      }
    }
    for (const o of asArray(cmd.options)) {
      const node = this.buildOption(o, false);
      if (node) nodes.push(node);
    }
    for (const o of asArray(cmd.repeatable_options)) {
      const node = this.buildOption(o, true);
      if (node) nodes.push(node);
    }

    const rootSeq = seq(...nodes);
    rootSeq.meta = { name: meta.id, ...(rootOutputs.length > 0 && { outputs: rootOutputs }) };

    return { meta, expr: rootSeq, errors: this.errors, warnings: this.warnings };
  }
}

// -- Helpers --

/** Strip a leading dash from a switch/command and snake_case it. */
function normalizeName(name: string): string {
  return snakeCase(name.replace(/^-+/, ""));
}

/** Coerce a possibly-missing list field to an array. */
function asArray(x: unknown): unknown[] {
  return isArray(x) ? x : [];
}

/**
 * Pull a clean version out of workbench's noisy `version_info` lines
 * (e.g. "Version: 2.1.0"). Returns undefined if none is present.
 */
function extractVersion(versionInfo: unknown): string | undefined {
  if (!isArray(versionInfo)) return undefined;
  for (const line of versionInfo) {
    if (isString(line)) {
      const m = /^Version:\s*(.+)$/.exec(line.trim());
      if (m && m[1]) return m[1].trim();
    }
  }
  return undefined;
}
