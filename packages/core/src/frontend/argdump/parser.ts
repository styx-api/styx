import type { AppMeta, NodeMeta } from "../../ir/meta.js";
import type {
  Alternative,
  Expr,
  Float,
  Int,
  Literal,
  Optional,
  Path,
  Repeat,
  Sequence,
  Str,
} from "../../ir/node.js";
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

function isNumber(x: unknown): x is number {
  return typeof x === "number";
}

function isArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

// Argdump types

type AdAction = Record<string, unknown>;
type AdDescriptor = Record<string, unknown>;

interface ArgparseMarker {
  __argparse__: string;
}

function isArgparseMarker(x: unknown): x is ArgparseMarker {
  return isObject(x) && isString(x.__argparse__);
}

function isSuppressed(x: unknown): boolean {
  return isArgparseMarker(x) && x.__argparse__ === "SUPPRESS";
}

// Parser

export class ArgdumpParser implements Frontend {
  readonly name = "argdump";
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

  // JSON parsing

  private parseJSON(source: string): AdDescriptor | null {
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

  // Metadata building

  private buildAppMeta(descriptor: AdDescriptor): AppMeta | undefined {
    const prog = descriptor.prog;
    if (!isString(prog)) return undefined;

    // Use prog as id, fall back to first word of description
    let id = prog || undefined;
    if (!id) {
      const desc = descriptor.description;
      if (isString(desc)) {
        // Extract tool name: first word, strip trailing punctuation
        const match = desc.match(/^(\S+)/);
        if (match) id = match[1]!.replace(/[:;,]+$/, "") || undefined;
      }
    }
    if (!id) return undefined;

    const description = descriptor.description;
    const epilog = descriptor.epilog;
    // Try to extract version from a version action
    let versionStr: string | undefined;
    const actions = descriptor.actions;
    if (isArray(actions)) {
      for (const action of actions) {
        if (isObject(action) && action.action_type === "version" && isString(action.version)) {
          // Strip %(prog)s prefix if present
          versionStr = action.version.replace(/%%?\(prog\)s\s*/g, "").trim();
          if (!versionStr) versionStr = undefined;
          break;
        }
      }
    }

    return {
      id,
      ...(versionStr && { version: versionStr }),
      ...((isString(description) || isString(epilog)) && {
        doc: {
          ...(isString(description) && { description }),
          ...(isString(epilog) && { comment: epilog }),
        },
      }),
    };
  }

  // Terminal node building

  private resolveTerminal(action: AdAction): Expr | null {
    const typeInfo = action.type_info;
    const fileTypeInfo = action.file_type_info;
    const choices = action.choices;

    // Choices -> enum alternative
    if (isArray(choices) && choices.length > 0) {
      const alts: Literal[] = [];
      for (const choice of choices) {
        if (isString(choice) || isNumber(choice)) {
          alts.push({ kind: "literal", attrs: { str: String(choice) } });
        } else {
          this.warn(`Ignoring non-string/number choice: ${JSON.stringify(choice)}`);
        }
      }
      if (alts.length === 0) return null;
      return { kind: "alternative", attrs: { alts } };
    }

    // FileType -> path
    if (isObject(fileTypeInfo)) {
      return { kind: "path", attrs: {} } satisfies Path;
    }

    // type_info-based resolution
    if (isObject(typeInfo)) {
      const name = typeInfo.name;

      if (!isString(name)) {
        return { kind: "str", attrs: {} } satisfies Str;
      }

      // Non-serializable type -> str + warning
      if (typeInfo.serializable === false) {
        this.warn(
          `Non-serializable type '${name}' for '${action.dest}', treating as string`,
        );
        return { kind: "str", attrs: {} } satisfies Str;
      }

      switch (name) {
        case "int":
          return { kind: "int", attrs: {} } satisfies Int;
        case "float":
          return { kind: "float", attrs: {} } satisfies Float;
        case "Path":
          return { kind: "path", attrs: {} } satisfies Path;
        default: {
          // Check module for known path types
          const mod = typeInfo.module;
          if (isString(mod) && (mod === "pathlib" || mod.includes("path"))) {
            return { kind: "path", attrs: {} } satisfies Path;
          }
          // Unknown type -> str
          if (name !== "str") {
            this.warn(`Unknown type '${name}' for '${action.dest}', treating as string`);
          }
          return { kind: "str", attrs: {} } satisfies Str;
        }
      }
    }

    // No type_info -> str (argparse default)
    return { kind: "str", attrs: {} } satisfies Str;
  }

  // Nargs wrapping

  private wrapWithNargs(node: Expr, nargs: unknown): Expr {
    if (nargs === null || nargs === undefined) {
      // No nargs -> bare value
      return node;
    }

    if (isArgparseMarker(nargs)) {
      if (nargs.__argparse__ === "REMAINDER") {
        // REMAINDER -> rep(str())
        const rep: Repeat = {
          kind: "repeat",
          attrs: { node: { kind: "str", attrs: {} }, countMin: 0 },
        };
        return rep;
      }
      if (nargs.__argparse__ === "SUPPRESS") {
        return node;
      }
    }

    if (nargs === "?") {
      const opt: Optional = { kind: "optional", attrs: { node } };
      return opt;
    }

    if (nargs === "*") {
      const rep: Repeat = { kind: "repeat", attrs: { node, countMin: 0 } };
      return rep;
    }

    if (nargs === "+") {
      const rep: Repeat = { kind: "repeat", attrs: { node, countMin: 1 } };
      return rep;
    }

    if (isNumber(nargs) && Number.isInteger(nargs) && nargs >= 0) {
      if (nargs === 1) return node;
      const rep: Repeat = {
        kind: "repeat",
        attrs: { node, countMin: nargs, countMax: nargs },
      };
      return rep;
    }

    return node;
  }

  // Action building

  private buildNodeMeta(action: AdAction): NodeMeta | undefined {
    const dest = action.dest;
    const help = action.help;
    const defaultVal = action.default;

    const hasName = isString(dest);
    const hasHelp = isString(help) && !isSuppressed(help);
    const hasDefault =
      (isString(defaultVal) || isNumber(defaultVal) || typeof defaultVal === "boolean") &&
      !isSuppressed(defaultVal);

    if (!hasName && !hasHelp && !hasDefault) return undefined;

    return {
      ...(hasName && { name: dest }),
      ...(hasHelp && { doc: { description: help } }),
      ...(hasDefault && { defaultValue: defaultVal }),
    };
  }

  private getOptionFlag(action: AdAction): string | null {
    const optionStrings = action.option_strings;
    if (!isArray(optionStrings) || optionStrings.length === 0) return null;

    // Prefer long option, fallback to first
    for (const opt of optionStrings) {
      if (isString(opt) && opt.startsWith("--")) return opt;
    }
    const first = optionStrings[0];
    return isString(first) ? first : null;
  }

  private isPositional(action: AdAction): boolean {
    const optionStrings = action.option_strings;
    return !isArray(optionStrings) || optionStrings.length === 0;
  }

  private buildAction(action: AdAction): Expr | null {
    const actionType = action.action_type ?? "store";

    switch (actionType) {
      case "store":
        return this.buildStore(action);
      case "store_true":
        return this.buildStoreTrue(action);
      case "store_false":
        return this.buildStoreFalse(action);
      case "store_const":
        return this.buildStoreConst(action);
      case "boolean_optional":
        return this.buildBooleanOptional(action);
      case "count":
        return this.buildCount(action);
      case "append":
      case "extend":
        return this.buildAppendExtend(action);
      case "append_const":
        return this.buildAppendConst(action);
      case "parsers":
        return this.buildSubparsers(action);
      case "help":
      case "version":
        // Skip help/version actions - not part of the tool interface
        return null;
      case "unknown":
        this.warn(
          `Unknown action type for '${action.dest}'` +
            (isString(action.custom_action_class)
              ? ` (custom class: ${action.custom_action_class})`
              : "") +
            ", treating as store",
        );
        return this.buildStore(action);
      default:
        this.warn(`Unrecognized action_type '${actionType}' for '${action.dest}', skipping`);
        return null;
    }
  }

  private buildStore(action: AdAction): Expr | null {
    const terminal = this.resolveTerminal(action);
    if (!terminal) return null;

    const meta = this.buildNodeMeta(action);
    if (meta) terminal.meta = meta;

    const node: Expr = this.wrapWithNargs(terminal, action.nargs);

    if (this.isPositional(action)) {
      // Hoist metadata from terminal to outermost wrapper
      if (node !== terminal && terminal.meta) {
        const { name, ...rest } = terminal.meta;
        if (Object.keys(rest).length > 0) {
          node.meta = { ...node.meta, ...rest };
          terminal.meta = name ? { name } : undefined;
        }
      }
      return node;
    }

    // Optional argument: seq(lit(flag), value)
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`Optional argument '${action.dest}' has no option strings`);
      return null;
    }

    const flagLit: Literal = { kind: "literal", attrs: { str: flag } };
    const seq: Sequence = { kind: "sequence", attrs: { nodes: [flagLit, node] } };

    // Wrap in optional unless explicitly required
    const isRequired = action.required === true;
    let result: Expr;
    if (isRequired) {
      result = seq;
    } else {
      const opt: Optional = { kind: "optional", attrs: { node: seq } };
      result = opt;
    }

    // Hoist metadata to outermost node
    if (terminal.meta) {
      const { name, ...rest } = terminal.meta;
      if (Object.keys(rest).length > 0) {
        result.meta = { ...result.meta, ...rest };
        terminal.meta = name ? { name } : undefined;
      }
    }

    return result;
  }

  private buildStoreTrue(action: AdAction): Expr | null {
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`store_true action '${action.dest}' has no option strings`);
      return null;
    }

    const literal: Literal = { kind: "literal", attrs: { str: flag } };
    const opt: Optional = { kind: "optional", attrs: { node: literal } };

    const meta = this.buildNodeMeta(action);
    const flagMeta = meta ?? {};
    if (flagMeta.defaultValue === undefined) flagMeta.defaultValue = false;
    opt.meta = flagMeta;

    return opt;
  }

  private buildStoreFalse(action: AdAction): Expr | null {
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`store_false action '${action.dest}' has no option strings`);
      return null;
    }

    const literal: Literal = { kind: "literal", attrs: { str: flag } };
    const opt: Optional = { kind: "optional", attrs: { node: literal } };

    const meta = this.buildNodeMeta(action);
    const flagMeta = meta ?? {};
    if (flagMeta.defaultValue === undefined) flagMeta.defaultValue = true;
    opt.meta = flagMeta;

    return opt;
  }

  private buildStoreConst(action: AdAction): Expr | null {
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`store_const action '${action.dest}' has no option strings`);
      return null;
    }

    const literal: Literal = { kind: "literal", attrs: { str: flag } };
    const opt: Optional = { kind: "optional", attrs: { node: literal } };

    const meta = this.buildNodeMeta(action);
    if (meta) opt.meta = meta;

    return opt;
  }

  private buildBooleanOptional(action: AdAction): Expr | null {
    const optionStrings = action.option_strings;
    if (!isArray(optionStrings) || optionStrings.length === 0) {
      this.error(`boolean_optional action '${action.dest}' has no option strings`);
      return null;
    }

    // Find --flag and --no-flag forms
    let posFlag: string | null = null;
    let negFlag: string | null = null;

    for (const opt of optionStrings) {
      if (!isString(opt)) continue;
      if (opt.startsWith("--no-")) {
        negFlag = opt;
      } else if (opt.startsWith("--")) {
        posFlag = opt;
      }
    }

    if (!posFlag) {
      // Fallback: use first two option strings
      posFlag = isString(optionStrings[0]) ? optionStrings[0] : null;
      negFlag = isString(optionStrings[1]) ? optionStrings[1] : null;
    }

    if (!posFlag) {
      this.error(`boolean_optional action '${action.dest}' has no valid option strings`);
      return null;
    }

    const posLit: Literal = { kind: "literal", attrs: { str: posFlag } };

    let innerNode: Expr;
    if (negFlag) {
      const negLit: Literal = { kind: "literal", attrs: { str: negFlag } };
      const alt: Alternative = { kind: "alternative", attrs: { alts: [posLit, negLit] } };
      innerNode = alt;
    } else {
      innerNode = posLit;
    }

    const opt: Optional = { kind: "optional", attrs: { node: innerNode } };

    const meta = this.buildNodeMeta(action);
    const flagMeta = meta ?? {};
    if (flagMeta.defaultValue === undefined) flagMeta.defaultValue = false;
    opt.meta = flagMeta;

    return opt;
  }

  private buildCount(action: AdAction): Expr | null {
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`count action '${action.dest}' has no option strings`);
      return null;
    }

    const literal: Literal = { kind: "literal", attrs: { str: flag } };
    const rep: Repeat = { kind: "repeat", attrs: { node: literal, countMin: 0 } };

    const meta = this.buildNodeMeta(action);
    if (meta) rep.meta = meta;

    return rep;
  }

  private buildAppendExtend(action: AdAction): Expr | null {
    const terminal = this.resolveTerminal(action);
    if (!terminal) return null;

    const meta = this.buildNodeMeta(action);
    if (meta) terminal.meta = meta;

    // Inner value may have nargs
    const nargsWrapped: Expr = this.wrapWithNargs(terminal, action.nargs);

    // Always wrap in repeat (append/extend accumulates)
    const inner: Expr =
      nargsWrapped.kind === "repeat"
        ? nargsWrapped
        : ({ kind: "repeat", attrs: { node: nargsWrapped, countMin: 0 } } satisfies Repeat);

    if (this.isPositional(action)) {
      // Hoist metadata
      if (inner !== terminal && terminal.meta) {
        const { name, ...rest } = terminal.meta;
        if (Object.keys(rest).length > 0) {
          inner.meta = { ...inner.meta, ...rest };
          terminal.meta = name ? { name } : undefined;
        }
      }
      return inner;
    }

    // Optional argument with flag
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`append/extend action '${action.dest}' has no option strings`);
      return null;
    }

    // For append with flag: rep(seq(lit(flag), value))
    // Unwrap the repeat we just added
    const valueNode = inner.kind === "repeat" ? inner.attrs.node : inner;
    const flagLit: Literal = { kind: "literal", attrs: { str: flag } };
    const flagSeq: Sequence = { kind: "sequence", attrs: { nodes: [flagLit, valueNode] } };
    const outerRep: Repeat = { kind: "repeat", attrs: { node: flagSeq, countMin: 0 } };

    // Hoist metadata
    if (terminal.meta) {
      const { name, ...rest } = terminal.meta;
      if (Object.keys(rest).length > 0) {
        outerRep.meta = { ...outerRep.meta, ...rest };
        terminal.meta = name ? { name } : undefined;
      }
    }

    return outerRep;
  }

  private buildAppendConst(action: AdAction): Expr | null {
    const flag = this.getOptionFlag(action);
    if (!flag) {
      this.error(`append_const action '${action.dest}' has no option strings`);
      return null;
    }

    // Similar to count - repeated flag
    const literal: Literal = { kind: "literal", attrs: { str: flag } };
    const rep: Repeat = { kind: "repeat", attrs: { node: literal, countMin: 0 } };

    const meta = this.buildNodeMeta(action);
    if (meta) rep.meta = meta;

    return rep;
  }

  private buildSubparsers(action: AdAction): Expr | null {
    const subparsers = action.subparsers;
    if (!isObject(subparsers)) {
      this.error(`parsers action '${action.dest}' has no subparsers`);
      return null;
    }

    const aliases = isObject(action.subparsers_aliases) ? action.subparsers_aliases : {};
    const alts: Expr[] = [];

    for (const [name, parserInfo] of Object.entries(subparsers)) {
      if (!isObject(parserInfo)) {
        this.warn(`Skipping non-object subparser '${name}'`);
        continue;
      }

      const subExpr = this.parseParserInfo(parserInfo);
      if (!subExpr) continue;

      // Prepend subcommand literal
      const cmdLit: Literal = { kind: "literal", attrs: { str: name } };
      const seq: Sequence = { kind: "sequence", attrs: { nodes: [cmdLit, ...subExpr.attrs.nodes] } };

      // Attach name and aliases as doc
      const subAliases = aliases[name];
      const aliasDoc =
        isArray(subAliases) && subAliases.length > 0
          ? ` (aliases: ${subAliases.filter(isString).join(", ")})`
          : "";

      const description = isString(parserInfo.description) ? parserInfo.description : undefined;
      const docStr = description
        ? description + aliasDoc
        : aliasDoc
          ? aliasDoc.slice(1) // Remove leading space
          : undefined;

      seq.meta = {
        name,
        ...(docStr && { doc: { description: docStr } }),
      };

      alts.push(seq);
    }

    if (alts.length === 0) {
      this.error(`No valid subparsers for '${action.dest}'`);
      return null;
    }

    if (alts.length === 1) {
      return alts[0]!;
    }

    const alt: Alternative = { kind: "alternative", attrs: { alts } };

    const isRequired = action.subparsers_required === true || action.required === true;
    if (!isRequired) {
      const opt: Optional = { kind: "optional", attrs: { node: alt } };

      const meta = this.buildNodeMeta(action);
      if (meta) opt.meta = meta;

      return opt;
    }

    const meta = this.buildNodeMeta(action);
    if (meta) alt.meta = meta;

    return alt;
  }

  // Mutual exclusion

  private applyMutualExclusion(
    actionsByDest: Map<string, AdAction>,
    groups: unknown[],
    nodes: Expr[],
    nodesByDest: Map<string, Expr>,
  ): Expr[] {
    const excluded = new Set<string>();

    for (const group of groups) {
      if (!isObject(group)) continue;
      const groupActions = group.actions;
      if (!isArray(groupActions)) continue;

      const memberDests: string[] = [];
      for (const dest of groupActions) {
        if (isString(dest) && nodesByDest.has(dest)) {
          memberDests.push(dest);
        }
      }

      if (memberDests.length < 2) continue;

      // Build alt from member nodes. Unwrapping the optional drops its meta
      // (doc/default), so merge it onto the inner node and tag the inner
      // with the dest so backends can derive a per-variant name.
      const altMembers: Expr[] = [];
      for (const dest of memberDests) {
        const node = nodesByDest.get(dest)!;
        let inner: Expr;
        let outerMeta: NodeMeta | undefined;
        if (node.kind === "optional") {
          inner = node.attrs.node;
          outerMeta = node.meta;
        } else {
          inner = node;
        }
        inner.meta = {
          ...outerMeta,
          ...inner.meta,
          name: inner.meta?.name ?? dest,
        };
        altMembers.push(inner);
        excluded.add(dest);
      }

      const alt: Alternative = { kind: "alternative", attrs: { alts: altMembers } };

      const isRequired = group.required === true;
      let groupNode: Expr;
      if (isRequired) {
        groupNode = alt;
      } else {
        groupNode = { kind: "optional", attrs: { node: alt } } satisfies Optional;
      }

      // Synthesize a name so backends can derive a meaningful id instead of
      // a Scope-generated placeholder. Prefer an explicit title if surfaced
      // by argdump, otherwise concat dests for 2-member groups, fall back
      // to a "_choice" suffix for larger groups.
      const title = isString(group.title) ? group.title : undefined;
      const groupName =
        title ??
        (memberDests.length === 2
          ? `${memberDests[0]}_or_${memberDests[1]}`
          : `${memberDests[0]}_choice`);
      groupNode.meta = { ...groupNode.meta, name: groupName };

      // Insert at position of first member
      const firstDest = memberDests[0]!;
      const firstIdx = nodes.findIndex((n) => n === nodesByDest.get(firstDest));
      if (firstIdx >= 0) {
        nodes.splice(firstIdx, 0, groupNode);
      } else {
        nodes.push(groupNode);
      }
    }

    // Remove excluded nodes
    return nodes.filter((n) => {
      // Find which dest this node corresponds to
      for (const [dest, node] of nodesByDest) {
        if (node === n && excluded.has(dest)) return false;
      }
      return true;
    });
  }

  // Main parser

  private parseParserInfo(descriptor: AdDescriptor): Sequence | null {
    const actions = descriptor.actions;
    if (!isArray(actions)) {
      return { kind: "sequence", attrs: { nodes: [] } };
    }

    const positionals: Expr[] = [];
    const optionals: Expr[] = [];
    const actionsByDest = new Map<string, AdAction>();
    const nodesByDest = new Map<string, Expr>();

    for (const rawAction of actions) {
      if (!isObject(rawAction)) continue;

      const node = this.buildAction(rawAction);
      if (!node) continue;

      const dest = rawAction.dest;
      if (isString(dest)) {
        actionsByDest.set(dest, rawAction);
        nodesByDest.set(dest, node);
      }

      if (this.isPositional(rawAction) && rawAction.action_type !== "parsers") {
        positionals.push(node);
      } else {
        optionals.push(node);
      }
    }

    // Assemble: positionals first, then optionals
    let allNodes = [...positionals, ...optionals];

    // Apply mutual exclusion groups
    const mutexGroups = descriptor.mutually_exclusive_groups;
    if (isArray(mutexGroups) && mutexGroups.length > 0) {
      allNodes = this.applyMutualExclusion(actionsByDest, mutexGroups, allNodes, nodesByDest);
    }

    return { kind: "sequence", attrs: { nodes: allNodes } };
  }

  // Public API

  parse(source: string, _filename?: string): ParseResult {
    this.reset();

    const descriptor = this.parseJSON(source);
    if (descriptor === null) {
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    const meta = this.buildAppMeta(descriptor);
    if (!meta) {
      this.error("Descriptor is missing prog");
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    const expr = this.parseParserInfo(descriptor);
    if (expr === null) {
      this.error("Failed to parse argument structure");
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    // Prepend prog as command literal (like Boutiques' command-line prefix)
    const prog = descriptor.prog;
    if (isString(prog) && prog) {
      expr.attrs.nodes.unshift({ kind: "literal", attrs: { str: prog } });
    }

    // Set root struct name
    if (!expr.meta?.name && meta.id) {
      expr.meta = { ...expr.meta, name: meta.id };
    }

    return {
      meta,
      expr,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}
