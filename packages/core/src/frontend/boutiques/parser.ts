import { nodeRef } from "../../ir/meta.js";
import type { AppMeta, NodeMeta, NodeRef, Output, OutputToken } from "../../ir/meta.js";
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
import { destructTemplate } from "./destruct-template.js";
import { boutiquesSplitCommand } from "./split-command.js";

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

// Outputs attach to the rootSeq of the descriptor they were declared in
// (root or a subcommand's sequence). Per-ref gating is computed downstream
// from each referenced binding's `gate`.

// Boutiques types

type BtInput = Record<string, unknown>;
type BtDescriptor = Record<string, unknown>;

enum InputTypePrimitive {
  String = "String",
  Float = "Float",
  Integer = "Integer",
  File = "File",
  Flag = "Flag",
  SubCommand = "SubCommand",
  SubCommandUnion = "SubCommandUnion",
}

interface InputType {
  primitive: InputTypePrimitive;
  isList: boolean;
  isOptional: boolean;
  isEnum: boolean;
}

// Parser

export class BoutiquesParser implements Frontend {
  readonly name = "boutiques";
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

  private parseJSON(source: string): BtDescriptor | null {
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

  // Input type detection

  private getInputTypePrimitive(btInput: BtInput): InputTypePrimitive | null {
    const btType = btInput.type;

    if (btType === undefined) {
      this.error(`type is missing for input: '${btInput.id}'`);
      return null;
    }

    if (isObject(btType)) return InputTypePrimitive.SubCommand;
    if (isArray(btType)) return InputTypePrimitive.SubCommandUnion;

    const typeName = isString(btType) ? btType : String(btType);

    switch (typeName) {
      case "String":
        return InputTypePrimitive.String;
      case "File":
        return InputTypePrimitive.File;
      case "Flag":
        return InputTypePrimitive.Flag;
      case "Number":
        return btInput.integer ? InputTypePrimitive.Integer : InputTypePrimitive.Float;
      default:
        this.error(`Unknown input type: '${typeName}'`);
        return null;
    }
  }

  private getInputType(btInput: BtInput): InputType | null {
    const primitive = this.getInputTypePrimitive(btInput);
    if (primitive === null) return null;

    if (primitive === InputTypePrimitive.Flag) {
      return { primitive, isList: false, isOptional: true, isEnum: false };
    }

    const isList = btInput.list === true;
    const isOptional = btInput.optional === true;
    const isEnum = btInput["value-choices"] !== undefined;

    if (primitive === InputTypePrimitive.File && isEnum) {
      this.error(`File input '${btInput.id}' cannot have value-choices`);
      return null;
    }

    return { primitive, isList, isOptional, isEnum };
  }

  // Metadata building

  private buildNodeMeta(btInput: BtInput): NodeMeta | undefined {
    const name = btInput.id;
    const title = btInput.name;
    const description = btInput.description;
    const defaultValue = btInput["default-value"];

    const hasDefault =
      isString(defaultValue) || isNumber(defaultValue) || typeof defaultValue === "boolean";

    if (!isString(name) && !isString(title) && !isString(description) && !hasDefault) {
      return undefined;
    }

    return {
      ...(isString(name) && { name }),
      ...((isString(title) || isString(description)) && {
        doc: {
          ...(isString(title) && { title }),
          ...(isString(description) && { description }),
        },
      }),
      ...(hasDefault && { defaultValue }),
    };
  }

  private buildStreamMeta(
    bt: Record<string, unknown>,
  ): { name: string; doc?: { title?: string; description?: string } } | undefined {
    const id = bt.id;
    if (!isString(id)) return undefined;

    const name = bt.name;
    const description = bt.description;

    return {
      name: id,
      ...((isString(name) || isString(description)) && {
        doc: {
          ...(isString(name) && { title: name }),
          ...(isString(description) && { description }),
        },
      }),
    };
  }

  private buildOutput(
    out: BtInput,
    lookup: Record<string, NodeRef>,
    idOptional: Set<string>,
  ): { output: Output } | null {
    const id = out.id;
    if (!isString(id)) {
      this.error("output-files entry missing id");
      return null;
    }

    const template = out["path-template"];
    if (!isString(template)) {
      this.error(`output-files entry '${id}' missing path-template`);
      return null;
    }

    const stripRaw = out["path-template-stripped-extensions"];
    const stripExtensions =
      isArray(stripRaw) && stripRaw.every(isString) && stripRaw.length > 0
        ? (stripRaw as string[])
        : undefined;

    const parts = destructTemplate<NodeRef>(template, lookup);

    const tokens: OutputToken[] = parts.map((part) => {
      if (typeof part === "string") return { kind: "literal" as const, value: part };
      return {
        kind: "ref" as const,
        target: part,
        ...(stripExtensions && { stripExtensions }),
        // Boutiques substitutes an unset optional input with the empty string.
        ...(idOptional.has(part.name) && { fallback: "" }),
      };
    });

    const title = out.name;
    const description = out.description;
    const output: Output = { name: id, tokens };
    if (isString(title) || isString(description)) {
      output.doc = {
        ...(isString(title) && { title }),
        ...(isString(description) && { description }),
      };
    }
    // Boutiques' `optional: bool` on output-files is a tool-author hint and is
    // re-derived at emit time from the refs' bindings - we don't store it.

    return { output };
  }

  /**
   * Attach `output-files` entries to the descriptor's rootSeq. Per-output
   * gating (which refs are optional, which arm we're inside) is recovered
   * downstream from each ref binding's `gate`.
   */
  private attachOutputs(rootSeq: Sequence, bt: BtDescriptor): void {
    const outputFiles = bt["output-files"];
    if (!isArray(outputFiles)) return;

    const lookup: Record<string, NodeRef> = {};
    const idOptional = new Set<string>();
    const inputs = bt["inputs"];
    if (isArray(inputs)) {
      for (const input of inputs) {
        if (isObject(input) && isString(input["value-key"]) && isString(input.id)) {
          lookup[input["value-key"]] = nodeRef(input.id);
          if (input.optional === true) idOptional.add(input.id);
        }
      }
    }

    for (const out of outputFiles) {
      if (!isObject(out)) {
        this.warn("Skipping non-object output-files entry");
        continue;
      }
      const built = this.buildOutput(out, lookup, idOptional);
      if (!built) continue;

      if (!rootSeq.meta) rootSeq.meta = {};
      rootSeq.meta.outputs = [...(rootSeq.meta.outputs ?? []), built.output];
    }
  }

  private buildAppMeta(bt: BtDescriptor): AppMeta | undefined {
    const id = bt.id ?? bt.name;
    if (!isString(id)) return undefined;

    const name = bt.name;
    const description = bt.description;
    const version = bt["tool-version"];
    const author = bt.author;
    const url = bt.url;
    const container = bt["container-image"];
    const stdout = bt["stdout-output"];
    const stderr = bt["stderr-output"];

    return {
      id,
      ...(isString(version) && { version }),
      ...((isString(name) || isString(description)) && {
        doc: {
          ...(isString(name) && { title: name }),
          ...(isString(description) && { description }),
        },
      }),
      ...(isString(author) && { authors: [author] }),
      ...(isString(url) && { urls: [url] }),
      ...(isObject(container) &&
        isString(container.image) && {
          container: {
            image: container.image,
            ...(isString(container.type) && {
              type: container.type as "docker" | "singularity",
            }),
          },
        }),
      ...(isObject(stdout) && { stdout: this.buildStreamMeta(stdout) }),
      ...(isObject(stderr) && { stderr: this.buildStreamMeta(stderr) }),
    };
  }

  // Terminal node building

  private buildEnumAlternative(choices: unknown[], meta?: NodeMeta): Alternative | null {
    const alts: Literal[] = [];

    for (const choice of choices) {
      if (isString(choice)) {
        alts.push({ kind: "literal", attrs: { str: choice } });
      } else if (isNumber(choice)) {
        alts.push({ kind: "literal", attrs: { str: String(choice) } });
      } else {
        this.warn(`Ignoring non-string/number enum choice: ${JSON.stringify(choice)}`);
      }
    }

    if (alts.length === 0) return null;

    const node: Alternative = { kind: "alternative", attrs: { alts } };
    if (meta) node.meta = meta;
    return node;
  }

  private buildTerminal(btInput: BtInput, inputType: InputType): Expr | null {
    const meta = this.buildNodeMeta(btInput);

    if (inputType.isEnum) {
      const choices = btInput["value-choices"];
      if (!isArray(choices)) {
        this.error(`Invalid value-choices for '${btInput.id}'`);
        return null;
      }
      return this.buildEnumAlternative(choices, meta);
    }

    switch (inputType.primitive) {
      case InputTypePrimitive.String: {
        const node: Str = { kind: "str", attrs: {} };
        if (meta) node.meta = meta;
        return node;
      }

      case InputTypePrimitive.Integer: {
        const node: Int = { kind: "int", attrs: {} };
        if (isNumber(btInput.minimum)) {
          node.attrs.minValue = Math.floor(btInput.minimum);
          if (btInput["exclusive-minimum"] === true) node.attrs.minValue += 1;
        }
        if (isNumber(btInput.maximum)) {
          node.attrs.maxValue = Math.floor(btInput.maximum);
          if (btInput["exclusive-maximum"] === true) node.attrs.maxValue -= 1;
        }
        if (meta) node.meta = meta;
        return node;
      }

      case InputTypePrimitive.Float: {
        const node: Float = { kind: "float", attrs: {} };
        if (isNumber(btInput.minimum)) node.attrs.minValue = btInput.minimum;
        if (isNumber(btInput.maximum)) node.attrs.maxValue = btInput.maximum;
        if (meta) node.meta = meta;
        return node;
      }

      case InputTypePrimitive.File: {
        const node: Path = {
          kind: "path",
          attrs: {
            ...(btInput["resolve-parent"] === true && { resolveParent: true }),
            ...(btInput.mutable === true && { mutable: true }),
          },
        };
        if (meta) node.meta = meta;
        return node;
      }

      case InputTypePrimitive.Flag: {
        const flag = btInput["command-line-flag"];
        if (!isString(flag)) {
          this.error(`Flag input '${btInput.id}' missing command-line-flag`);
          return null;
        }
        const literal: Literal = { kind: "literal", attrs: { str: flag } };
        const node: Optional = { kind: "optional", attrs: { node: literal } };
        const flagMeta = meta ?? {};
        if (flagMeta.defaultValue === undefined) flagMeta.defaultValue = false;
        node.meta = flagMeta;
        return node;
      }

      case InputTypePrimitive.SubCommand: {
        const nested = btInput.type;
        if (!isObject(nested)) {
          this.error(`Invalid subcommand type for '${btInput.id}'`);
          return null;
        }
        const node = this.parseDescriptor(nested);
        if (node && meta) node.meta = meta;
        return node;
      }

      case InputTypePrimitive.SubCommandUnion: {
        const alts = btInput.type;
        if (!isArray(alts)) {
          this.error(`Invalid subcommand union type for '${btInput.id}'`);
          return null;
        }
        const parsedAlts: Expr[] = [];
        for (const alt of alts) {
          if (!isObject(alt)) {
            this.warn("Skipping non-object subcommand alternative");
            continue;
          }
          const parsed = this.parseDescriptor(alt);
          if (parsed) {
            // Set metadata from the subcommand descriptor
            const altMeta = this.buildAppMeta(alt);
            if (altMeta?.id) {
              parsed.meta = { ...parsed.meta, name: altMeta.id };
            }
            parsedAlts.push(parsed);
          }
        }
        if (parsedAlts.length === 0) {
          this.error(`No valid alternatives for subcommand union '${btInput.id}'`);
          return null;
        }
        if (parsedAlts.length === 1) {
          const node = parsedAlts[0]!;
          if (meta) node.meta = { ...node.meta, ...meta };
          return node;
        }
        const node: Alternative = { kind: "alternative", attrs: { alts: parsedAlts } };
        if (meta) node.meta = meta;
        return node;
      }

      default:
        return null;
    }
  }

  // Node wrapping (repeat, flag, optional)

  private wrapWithRepeat(node: Expr, btInput: BtInput): Repeat {
    return {
      kind: "repeat",
      attrs: {
        node,
        ...(isString(btInput["list-separator"]) && { join: btInput["list-separator"] }),
        ...(isNumber(btInput["min-list-entries"]) && { countMin: btInput["min-list-entries"] }),
        ...(isNumber(btInput["max-list-entries"]) && { countMax: btInput["max-list-entries"] }),
      },
    };
  }

  private wrapWithFlag(node: Expr, btInput: BtInput): Expr {
    const flag = btInput["command-line-flag"];
    if (!isString(flag)) return node;

    const flagSep = btInput["command-line-flag-separator"];
    const prefix: Literal = {
      kind: "literal",
      attrs: { str: flag + (flagSep ?? "") },
    };

    return { kind: "sequence", attrs: { nodes: [prefix, node] } };
  }

  private wrapWithOptional(node: Expr): Optional {
    return { kind: "optional", attrs: { node } };
  }

  private wrapNode(node: Expr, btInput: BtInput, inputType: InputType): Expr {
    // Flags handle their own optional wrapping
    if (inputType.primitive === InputTypePrimitive.Flag) {
      return node;
    }

    const inner = node;

    // Order: repeat -> flag -> optional
    // This produces: optional(sequence(flag, repeat(value)))

    if (inputType.isList) {
      node = this.wrapWithRepeat(node, btInput);
    }

    node = this.wrapWithFlag(node, btInput);

    if (inputType.isOptional) {
      node = this.wrapWithOptional(node);
    }

    // Hoist metadata (doc, default) to outermost wrapper so backends find it
    // on the binding node. Keep name on inner for solver's findDeepName.
    if (node !== inner && inner.meta) {
      const { name, ...rest } = inner.meta;
      if (Object.keys(rest).length > 0) {
        node.meta = { ...node.meta, ...rest };
        inner.meta = name ? { name } : undefined;
      }
    }

    return node;
  }

  // Command line parsing

  private parseCommandLineTemplate(
    template: string,
    inputsLookup: Map<string, BtInput>,
  ): Array<Array<string | BtInput>> {
    let args: string[];
    try {
      args = boutiquesSplitCommand(template);
    } catch (e) {
      this.error(`Failed to parse command-line: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }

    const lookupObj = Object.fromEntries(inputsLookup);
    return args.map((arg) => destructTemplate(arg, lookupObj));
  }

  private parseDescriptor(bt: BtDescriptor): Sequence | null {
    // Build inputs lookup
    const inputs = bt["inputs"];
    const inputsLookup = new Map<string, BtInput>();

    if (isArray(inputs)) {
      for (const input of inputs) {
        if (isObject(input) && isString(input["value-key"])) {
          inputsLookup.set(input["value-key"], input);
        }
      }
    }

    // Parse command line template
    const commandLine = bt["command-line"];
    const segments = isString(commandLine)
      ? this.parseCommandLineTemplate(commandLine, inputsLookup)
      : [];

    // Build IR
    const rootSeq: Sequence = { kind: "sequence", attrs: { nodes: [] } };

    for (const segment of segments) {
      const seq: Sequence = { kind: "sequence", attrs: { nodes: [], join: "" } };

      for (const elem of segment) {
        if (isObject(elem)) {
          const inputType = this.getInputType(elem);
          if (inputType === null) continue;

          let node = this.buildTerminal(elem, inputType);
          if (node === null) continue;

          node = this.wrapNode(node, elem, inputType);
          seq.attrs.nodes.push(node);
        } else {
          seq.attrs.nodes.push({ kind: "literal", attrs: { str: elem } });
        }
      }

      // Flatten single-node sequences
      if (seq.attrs.nodes.length === 1) {
        rootSeq.attrs.nodes.push(seq.attrs.nodes[0]!);
      } else if (seq.attrs.nodes.length > 1) {
        rootSeq.attrs.nodes.push(seq);
      }
    }

    this.attachOutputs(rootSeq, bt);
    return rootSeq;
  }

  // Public API

  parse(source: string, _filename?: string): ParseResult {
    this.reset();

    const bt = this.parseJSON(source);
    if (bt === null) {
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    const baseMeta = this.buildAppMeta(bt);
    if (!baseMeta) {
      this.error("Descriptor is missing id/name");
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    const expr = this.parseDescriptor(bt);
    if (expr === null) {
      this.error("Failed to parse command structure");
      return {
        expr: { kind: "sequence", attrs: { nodes: [] } },
        errors: this.errors,
        warnings: this.warnings,
      };
    }

    // Set root struct name from descriptor id if not already set
    if (!expr.meta?.name && baseMeta?.id) {
      expr.meta = { ...expr.meta, name: baseMeta.id };
    }

    return {
      meta: baseMeta,
      expr,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}
