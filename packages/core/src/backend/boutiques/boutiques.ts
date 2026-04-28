import type { Binding, BoundType, BoundVariant } from "../../bindings/index.js";
import type { Expr, ScalarKind } from "../../ir/index.js";
import type { AppMeta } from "../../ir/meta.js";
import type { CodegenContext } from "../../manifest/index.js";
import type { Backend, EmitResult, EmitWarning } from "../backend.js";
import { collectFieldInfo } from "../collect-field-info.js";
import { findDoc } from "../find-doc.js";
import { findStructNode } from "../find-struct-node.js";
import { resolveFieldBinding } from "../resolve-field-binding.js";
import { Scope } from "../scope.js";
import { screamingSnakeCase } from "../string-case.js";

// Boutiques descriptor types (output format)

interface BtDescriptor {
  name?: string;
  id?: string;
  description?: string;
  "schema-version"?: string;
  "tool-version"?: string;
  author?: string;
  url?: string;
  "container-image"?: { image: string; type?: string };
  "command-line"?: string;
  inputs?: BtInput[];
  "stdout-output"?: { id: string; name?: string; description?: string };
  "stderr-output"?: { id: string; name?: string; description?: string };
}

interface BtInput {
  id: string;
  name?: string;
  description?: string;
  type: string | BtDescriptor | BtDescriptor[];
  "value-key": string;
  optional?: boolean;
  list?: boolean;
  "list-separator"?: string;
  "min-list-entries"?: number;
  "max-list-entries"?: number;
  "command-line-flag"?: string;
  "command-line-flag-separator"?: string;
  "value-choices"?: (string | number)[];
  "default-value"?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  "resolve-parent"?: boolean;
  mutable?: boolean;
}

// Wrapper peeling result

interface PeeledInput {
  isOptional: boolean;
  isList: boolean;
  listSeparator?: string;
  minListEntries?: number;
  maxListEntries?: number;
  flag?: string;
  flagSeparator?: string;
}

class BoutiquesEmitter {
  private warnings: EmitWarning[] = [];

  constructor(private ctx: CodegenContext) {}

  private warn(message: string): void {
    this.warnings.push({ message });
  }

  emit(): { descriptor: BtDescriptor; warnings: EmitWarning[] } {
    const descriptor = this.buildRootDescriptor();
    return { descriptor, warnings: this.warnings };
  }

  private buildRootDescriptor(): BtDescriptor {
    const bt: BtDescriptor = { "schema-version": "0.5+styx" };

    // Map AppMeta to root descriptor fields
    const app = this.ctx.app;
    if (app) {
      this.applyAppMeta(bt, app);
    }

    // Resolve root binding
    const rootBinding = this.ctx.resolve(this.ctx.expr);
    if (!rootBinding) {
      // No root binding - the solver collapsed single-field sequences.
      // Walk the expression tree directly to synthesize the descriptor.
      this.buildFromUnboundSequence(bt, this.ctx.expr);
      return bt;
    }

    this.buildDescriptorBody(bt, rootBinding, this.ctx.expr);
    return bt;
  }

  private applyAppMeta(bt: BtDescriptor, app: AppMeta): void {
    // Boutiques requires `name` at root and disallows `id` there.
    const rootName = app.doc?.title ?? app.id;
    if (rootName) bt.name = rootName;
    if (app.doc?.description) bt.description = app.doc.description;
    if (app.version) bt["tool-version"] = app.version;
    if (app.authors?.[0]) bt.author = app.authors[0];
    if (app.urls?.[0]) bt.url = app.urls[0];
    if (app.container) {
      bt["container-image"] = {
        image: app.container.image,
        ...(app.container.type && { type: app.container.type }),
      };
    }
    if (app.stdout) {
      bt["stdout-output"] = {
        id: app.stdout.name,
        ...(app.stdout.doc?.title && { name: app.stdout.doc.title }),
        ...(app.stdout.doc?.description && { description: app.stdout.doc.description }),
      };
    }
    if (app.stderr) {
      bt["stderr-output"] = {
        id: app.stderr.name,
        ...(app.stderr.doc?.title && { name: app.stderr.doc.title }),
        ...(app.stderr.doc?.description && { description: app.stderr.doc.description }),
      };
    }
  }

  private buildDescriptorBody(bt: BtDescriptor, binding: Binding, expr: Expr): void {
    const type = binding.type;

    if (type.kind === "struct") {
      this.buildFromStruct(bt, type, expr);
    } else {
      // Root is not a struct (e.g. simplified to a literal) - just build command line
      bt["command-line"] = this.buildCommandLineFromExpr(expr);
    }
  }

  // Handle sequences where the solver collapsed single-field structs.
  // Walk children, emitting literals as command-line text and bound nodes as inputs.
  private buildFromUnboundSequence(bt: BtDescriptor, expr: Expr): void {
    if (expr.kind !== "sequence") {
      bt["command-line"] = this.buildCommandLineFromExpr(expr);
      return;
    }

    const scope = new Scope();
    const idScope = new Scope();
    const commandParts: string[] = [];
    const inputs: BtInput[] = [];

    for (const child of expr.attrs.nodes) {
      if (child.kind === "literal") {
        commandParts.push(child.attrs.str);
        continue;
      }

      const binding = this.ctx.resolve(child);
      if (binding) {
        // Direct binding on this child
        const id = idScope.add(this.sanitizeId(binding.name));
        const valueKey = scope.add(screamingSnakeCase(id));
        const valueKeyStr = `[${valueKey}]`;
        const peeled = this.peelNode(child, binding.type);
        if (this.isBool(binding.type) && !peeled.flag) {
          const flagStr = this.extractBoolFlag(child);
          if (flagStr) peeled.flag = flagStr;
        }
        const input = this.buildInputFromBinding(binding, id, valueKeyStr, peeled, child);
        commandParts.push(valueKeyStr);
        inputs.push(input);
      } else {
        // No direct binding - might be a nested sequence (subcommand).
        // Try to find bindings deeper inside.
        const deepBinding = this.findDeepBinding(child);
        if (deepBinding) {
          const rawName = child.meta?.name ?? deepBinding.name;
          const id = idScope.add(this.sanitizeId(rawName));
          const valueKey = scope.add(screamingSnakeCase(id));
          const valueKeyStr = `[${valueKey}]`;
          const subBt = this.buildSubCommandFromUnbound(child);
          const input: BtInput = {
            id,
            type: subBt,
            "value-key": valueKeyStr,
          };
          this.finalizeInput(input);
          commandParts.push(valueKeyStr);
          inputs.push(input);
        } else {
          commandParts.push(this.buildCommandLineFromExpr(child));
        }
      }
    }

    bt["command-line"] = commandParts.join(" ");
    bt.inputs = inputs;
  }

  // Build a subcommand descriptor from an unbound sequence node
  private buildSubCommandFromUnbound(node: Expr): BtDescriptor {
    const bt: BtDescriptor = {};
    if (node.meta?.name) {
      bt.name = node.meta.name;
      bt.id = this.sanitizeId(node.meta.name);
    }
    this.buildFromUnboundSequence(bt, node);
    return bt;
  }

  // Find any binding in a subtree
  private findDeepBinding(node: Expr): Binding | undefined {
    const binding = this.ctx.resolve(node);
    if (binding) return binding;

    switch (node.kind) {
      case "sequence":
        for (const child of node.attrs.nodes) {
          const found = this.findDeepBinding(child);
          if (found) return found;
        }
        return undefined;
      case "optional":
        return this.findDeepBinding(node.attrs.node);
      case "repeat":
        return this.findDeepBinding(node.attrs.node);
      case "alternative":
        for (const alt of node.attrs.alts) {
          const found = this.findDeepBinding(alt);
          if (found) return found;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  // Build an input from a binding directly (without struct context)
  private buildInputFromBinding(
    binding: Binding,
    id: string,
    valueKey: string,
    peeled: PeeledInput,
    wrapperNode: Expr,
  ): BtInput {
    const innerType = this.unwrapType(binding.type);
    const mapped = this.mapType(innerType, wrapperNode);

    const input: BtInput = {
      id,
      type: mapped.type,
      "value-key": valueKey,
    };

    if (binding.node.meta?.doc?.title) input.name = binding.node.meta.doc.title;
    if (binding.node.meta?.doc?.description) input.description = binding.node.meta.doc.description;

    if (peeled.isOptional || mapped.optional) input.optional = true;
    const isList = peeled.isList || mapped.list === true;
    if (isList) {
      input.list = true;
      const listSep = peeled.listSeparator ?? mapped.listSeparator;
      const minEntries = peeled.minListEntries ?? mapped.minListEntries;
      if (listSep !== undefined) input["list-separator"] = listSep;
      if (minEntries !== undefined) input["min-list-entries"] = minEntries;
      if (peeled.maxListEntries !== undefined) input["max-list-entries"] = peeled.maxListEntries;
    }
    if (peeled.flag) {
      input["command-line-flag"] = peeled.flag;
      if (peeled.flagSeparator) input["command-line-flag-separator"] = peeled.flagSeparator;
    }
    if (mapped.integer) input.integer = true;
    if (mapped.minimum !== undefined) input.minimum = mapped.minimum;
    if (mapped.maximum !== undefined) input.maximum = mapped.maximum;
    if (mapped.valueChoices) input["value-choices"] = mapped.valueChoices;
    if (mapped.resolveParent) input["resolve-parent"] = true;
    if (mapped.mutable) input["mutable"] = true;

    if (innerType.kind !== "count") {
      const defaultValue = binding.node.meta?.defaultValue;
      if (defaultValue !== undefined) input["default-value"] = defaultValue;
    }

    this.finalizeInput(input);
    return input;
  }

  private buildFromStruct(
    bt: BtDescriptor,
    structType: Extract<BoundType, { kind: "struct" }>,
    expr: Expr,
  ): void {
    const structNode = findStructNode(expr, this.ctx, structType);
    if (!structNode) {
      bt["command-line"] = "";
      bt.inputs = [];
      return;
    }

    const scope = new Scope();
    const idScope = new Scope();
    const commandParts: string[] = [];
    const inputs: BtInput[] = [];
    const fieldInfo = collectFieldInfo(this.ctx, structType);

    for (const child of structNode.attrs.nodes) {
      // Literal nodes -> command-line text
      if (child.kind === "literal") {
        commandParts.push(child.attrs.str);
        continue;
      }

      // Try to resolve to a field binding
      const match = resolveFieldBinding(child, this.ctx, structType);
      if (!match) {
        // Unbound node - emit as literal text if possible
        if (child.kind === "literal") {
          commandParts.push(child.attrs.str);
        }
        continue;
      }

      const { binding, wrapperNode } = match;
      const fieldType = structType.fields[binding.name];
      if (!fieldType) continue;

      // Skip literal fields (union discriminators, not user-facing)
      if (fieldType.kind === "literal") continue;

      const id = idScope.add(this.sanitizeId(binding.name));
      const valueKey = scope.add(screamingSnakeCase(id));
      const valueKeyStr = `[${valueKey}]`;

      // Peel wrapper layers from the IR node
      const peeled = this.peelNode(wrapperNode, fieldType);

      // Bool IR pattern: optional(literal("-v")) - the literal IS the flag.
      if (this.isBool(fieldType) && !peeled.flag) {
        const flagStr = this.extractBoolFlag(wrapperNode);
        if (flagStr) peeled.flag = flagStr;
      }

      const input = this.buildInput(binding, id, fieldType, valueKeyStr, peeled, fieldInfo, wrapperNode);

      // Add flag to command line if present, then value-key
      if (peeled.flag) {
        if (fieldType.kind === "bool" || (fieldType.kind === "optional" && this.isBool(fieldType))) {
          // Bool flags: the value-key IS the flag
          commandParts.push(valueKeyStr);
        } else {
          // Value flags: flag then value-key as separate args
          commandParts.push(valueKeyStr);
        }
      } else {
        commandParts.push(valueKeyStr);
      }

      inputs.push(input);
    }

    bt["command-line"] = commandParts.join(" ");
    bt.inputs = inputs;
  }

  // Extract flag literal from a bool IR pattern: optional(literal("-v"))
  private extractBoolFlag(node: Expr): string | undefined {
    if (node.kind === "optional") return this.extractBoolFlag(node.attrs.node);
    if (node.kind === "literal") return node.attrs.str;
    return undefined;
  }

  private buildInput(
    binding: Binding,
    id: string,
    fieldType: BoundType,
    valueKey: string,
    peeled: PeeledInput,
    fieldInfo: Map<string, { doc?: string; defaultValue?: string | number | boolean }>,
    wrapperNode: Expr,
  ): BtInput {
    const info = fieldInfo.get(binding.name);
    const innerType = this.unwrapType(fieldType);
    const mapped = this.mapType(innerType, wrapperNode);

    const input: BtInput = {
      id,
      type: mapped.type,
      "value-key": valueKey,
    };

    // Name (short label) - only from explicit title, not description
    const title = binding.node.meta?.doc?.title;
    if (title) input.name = title;

    // Description (longer help text)
    const description =
      info?.doc ?? binding.node.meta?.doc?.description ?? findDoc(binding.node, fieldType);
    if (description) input.description = description;

    if (peeled.isOptional || mapped.optional) input.optional = true;

    const isList = peeled.isList || mapped.list === true;
    if (isList) {
      input.list = true;
      const listSep = peeled.listSeparator ?? mapped.listSeparator;
      const minEntries = peeled.minListEntries ?? mapped.minListEntries;
      if (listSep !== undefined) input["list-separator"] = listSep;
      if (minEntries !== undefined) input["min-list-entries"] = minEntries;
      if (peeled.maxListEntries !== undefined) input["max-list-entries"] = peeled.maxListEntries;
    }

    // Flag
    if (peeled.flag) {
      input["command-line-flag"] = peeled.flag;
      if (peeled.flagSeparator) input["command-line-flag-separator"] = peeled.flagSeparator;
    }

    // Constraints from mapped type
    if (mapped.integer) input.integer = true;
    if (mapped.minimum !== undefined) input.minimum = mapped.minimum;
    if (mapped.maximum !== undefined) input.maximum = mapped.maximum;
    if (mapped.valueChoices) input["value-choices"] = mapped.valueChoices;
    if (mapped.resolveParent) input["resolve-parent"] = true;
    if (mapped.mutable) input["mutable"] = true;

    // count's "default" is implicit via min-list-entries:0; skip emitting it.
    if (innerType.kind !== "count") {
      const defaultValue = info?.defaultValue ?? binding.node.meta?.defaultValue;
      if (defaultValue !== undefined) input["default-value"] = defaultValue;
    }

    this.finalizeInput(input);
    return input;
  }

  // Normalize an input so the descriptor is valid even when upstream types
  // are dynamic (functools.partial, custom action classes) and the parser
  // had to fall back to String.
  private finalizeInput(input: BtInput): void {
    if (input.name === undefined) input.name = input.id;

    // A String with a bool default and no choices is really a Flag.
    if (
      input.type === "String" &&
      typeof input["default-value"] === "boolean" &&
      input["value-choices"] === undefined
    ) {
      input.type = "Flag";
    }

    if (input.type === "Flag") {
      delete input["default-value"];
      delete input["value-choices"];
      delete input.list;
      delete input["list-separator"];
      delete input["min-list-entries"];
      delete input["max-list-entries"];
    } else if (input.type === "String") {
      const dv = input["default-value"];
      if (dv !== undefined && typeof dv !== "string") {
        input["default-value"] = String(dv);
      }
      const choices = input["value-choices"];
      if (Array.isArray(choices)) {
        input["value-choices"] = choices.map((c) => (typeof c === "string" ? c : String(c)));
      }
    } else if (input.type === "Number") {
      const dv = input["default-value"];
      if (dv !== undefined && typeof dv !== "number") {
        const num = Number(dv);
        if (Number.isFinite(num)) input["default-value"] = num;
        else delete input["default-value"];
      }
    }

    // Default must be one of the choices, or dropped.
    const choices = input["value-choices"];
    const dv = input["default-value"];
    if (Array.isArray(choices) && dv !== undefined && !choices.some((c) => c === dv)) {
      delete input["default-value"];
    }
  }

  // Peel wrapper layers from an IR node to extract Boutiques input properties.
  // Walks from outermost to innermost, detecting optional/repeat/flag patterns.
  private peelNode(node: Expr, type: BoundType): PeeledInput {
    const result: PeeledInput = { isOptional: false, isList: false };
    this.peelNodeInner(node, type, result);
    return result;
  }

  private peelNodeInner(node: Expr, type: BoundType, result: PeeledInput): void {
    switch (node.kind) {
      case "optional":
        result.isOptional = true;
        this.peelNodeInner(
          node.attrs.node,
          type.kind === "optional" ? type.inner : type,
          result,
        );
        break;

      case "repeat":
        // count's Repeat is the count, not a list - mapType handles it.
        if (this.isCount(type)) {
          break;
        }
        result.isList = true;
        if (node.attrs.join !== undefined) result.listSeparator = node.attrs.join;
        if (node.attrs.countMin !== undefined) result.minListEntries = node.attrs.countMin;
        if (node.attrs.countMax !== undefined) result.maxListEntries = node.attrs.countMax;
        this.peelNodeInner(
          node.attrs.node,
          type.kind === "list" ? type.item : type,
          result,
        );
        break;

      case "sequence": {
        // Detect flag pattern: seq(lit(flag), inner)
        const nodes = node.attrs.nodes;
        if (nodes.length === 2 && nodes[0]!.kind === "literal") {
          const flagLit = nodes[0]!.attrs.str;
          const { flag, separator } = this.splitFlagLiteral(flagLit);
          result.flag = flag;
          if (separator) result.flagSeparator = separator;
          this.peelNodeInner(nodes[1]!, type, result);
        }
        // Otherwise don't peel further (it's a struct sequence or similar)
        break;
      }

      default:
        // Terminal or other node - nothing more to peel
        break;
    }
  }

  // Split a flag literal like "-f " or "--flag=" into flag + separator.
  // The parser merges flag + separator into one literal: `flag + (flagSep ?? "")`
  private splitFlagLiteral(str: string): { flag: string; separator: string } {
    // If it ends with "=", split there
    if (str.endsWith("=")) {
      return { flag: str.slice(0, -1), separator: "=" };
    }
    // If it ends with whitespace, strip it
    const trimmed = str.trimEnd();
    if (trimmed.length < str.length) {
      return { flag: trimmed, separator: str.slice(trimmed.length) };
    }
    // No separator
    return { flag: str, separator: "" };
  }

  // Unwrap optional/list layers to get the "core" type for mapping
  private unwrapType(type: BoundType): BoundType {
    if (type.kind === "optional") return this.unwrapType(type.inner);
    if (type.kind === "list") return this.unwrapType(type.item);
    return type;
  }

  // Returned list/optional fields override peeled values (for `count`, whose
  // IR Repeat does not correspond to a Boutiques list).
  private mapType(
    type: BoundType,
    node: Expr,
  ): {
    type: string | BtDescriptor | BtDescriptor[];
    integer?: boolean;
    minimum?: number;
    maximum?: number;
    valueChoices?: (string | number)[];
    resolveParent?: boolean;
    mutable?: boolean;
    list?: boolean;
    listSeparator?: string;
    minListEntries?: number;
    optional?: boolean;
  } {
    switch (type.kind) {
      case "scalar":
        return this.mapScalar(type.scalar, node);

      case "bool":
        return { type: "Flag" };

      case "count":
        return this.mapCount(node);

      case "literal":
        // Single literal - emit as String with value-choices
        return {
          type: "String",
          valueChoices: [type.value],
        };

      case "struct":
        return { type: this.buildSubCommand(type, node) };

      case "union":
        return this.mapUnion(type, node);

      // optional/list should have been unwrapped already
      case "optional":
        return this.mapType(type.inner, node);
      case "list":
        return this.mapType(type.item, node);
    }
  }

  private mapScalar(
    scalar: ScalarKind,
    node: Expr,
  ): {
    type: string;
    integer?: boolean;
    minimum?: number;
    maximum?: number;
    resolveParent?: boolean;
    mutable?: boolean;
  } {
    const terminal = this.findTerminal(node);

    switch (scalar) {
      case "int": {
        const result: { type: string; integer: true; minimum?: number; maximum?: number } = {
          type: "Number",
          integer: true,
        };
        if (terminal?.kind === "int") {
          if (terminal.attrs.minValue !== undefined) result.minimum = terminal.attrs.minValue;
          if (terminal.attrs.maxValue !== undefined) result.maximum = terminal.attrs.maxValue;
        }
        return result;
      }

      case "float": {
        const result: { type: string; minimum?: number; maximum?: number } = { type: "Number" };
        if (terminal?.kind === "float") {
          if (terminal.attrs.minValue !== undefined) result.minimum = terminal.attrs.minValue;
          if (terminal.attrs.maxValue !== undefined) result.maximum = terminal.attrs.maxValue;
        }
        return result;
      }

      case "str":
        return { type: "String" };

      case "path": {
        const result: { type: string; resolveParent?: boolean; mutable?: boolean } = {
          type: "File",
        };
        if (terminal?.kind === "path") {
          if (terminal.attrs.resolveParent) result.resolveParent = true;
          if (terminal.attrs.mutable) result.mutable = true;
        }
        return result;
      }
    }
  }

  private mapUnion(
    type: Extract<BoundType, { kind: "union" }>,
    node: Expr,
  ): {
    type: string | BtDescriptor | BtDescriptor[];
    valueChoices?: (string | number)[];
  } {
    // All-literal union -> value-choices
    const allLiteral = type.variants.every((v: BoundVariant) => v.type.kind === "literal");
    if (allLiteral) {
      return {
        type: "String",
        valueChoices: type.variants.map((v: BoundVariant) =>
          v.type.kind === "literal" ? v.type.value : "",
        ),
      };
    }

    // All-struct union -> SubCommandUnion
    const allStruct = type.variants.every(
      (v: BoundVariant) => v.type.kind === "struct",
    );
    if (allStruct) {
      return { type: this.buildSubCommandUnion(type, node) };
    }

    // Mixed union -> wrap each variant as a SubCommand descriptor
    return { type: this.buildMixedUnionAsSubCommands(type, node) };
  }

  private buildSubCommand(
    type: Extract<BoundType, { kind: "struct" }>,
    node: Expr,
  ): BtDescriptor {
    const bt: BtDescriptor = {};
    const structNode = findStructNode(node, this.ctx, type);
    if (structNode) {
      // Recursively serialize as nested descriptor
      this.buildFromStruct(bt, type, node);
    }
    if (node.meta?.name) {
      bt.name = node.meta.name;
      bt.id = this.sanitizeId(node.meta.name);
    }
    return bt;
  }

  private buildSubCommandUnion(
    type: Extract<BoundType, { kind: "union" }>,
    node: Expr,
  ): BtDescriptor[] {
    const alts = node.kind === "alternative" ? node.attrs.alts : [node];

    return type.variants.map((variant: BoundVariant, i: number) => {
      const altNode = alts[i] ?? node;
      if (variant.type.kind === "struct") {
        const bt = this.buildSubCommand(variant.type, altNode);
        if (variant.name && !bt.name) {
          bt.name = variant.name;
          bt.id = this.sanitizeId(variant.name);
        }
        return bt;
      }
      return this.wrapAsDescriptor(variant, altNode);
    });
  }

  private buildMixedUnionAsSubCommands(
    type: Extract<BoundType, { kind: "union" }>,
    node: Expr,
  ): BtDescriptor[] {
    const alts = node.kind === "alternative" ? node.attrs.alts : [node];

    return type.variants.map((variant: BoundVariant, i: number) => {
      const altNode = alts[i] ?? node;
      if (variant.type.kind === "struct") {
        const bt = this.buildSubCommand(variant.type, altNode);
        if (variant.name && !bt.name) {
          bt.name = variant.name;
          bt.id = this.sanitizeId(variant.name);
        }
        return bt;
      }
      return this.wrapAsDescriptor(variant, altNode);
    });
  }

  // Wrap a non-struct variant as a trivial single-input descriptor
  private wrapAsDescriptor(variant: BoundVariant, node: Expr): BtDescriptor {
    const name = variant.name ?? "value";
    const id = this.sanitizeId(name);
    const mapped = this.mapType(variant.type, node);
    const input: BtInput = {
      id,
      type: mapped.type,
      "value-key": `[${screamingSnakeCase(id)}]`,
    };
    if (mapped.valueChoices) input["value-choices"] = mapped.valueChoices;
    if (mapped.integer) input.integer = true;
    if (mapped.minimum !== undefined) input.minimum = mapped.minimum;
    if (mapped.maximum !== undefined) input.maximum = mapped.maximum;

    this.finalizeInput(input);

    return {
      name,
      id,
      "command-line": `[${screamingSnakeCase(id)}]`,
      inputs: [input],
    };
  }

  // Find terminal node through wrappers
  private findTerminal(node: Expr): Expr | undefined {
    switch (node.kind) {
      case "optional":
        return this.findTerminal(node.attrs.node);
      case "repeat":
        return this.findTerminal(node.attrs.node);
      case "sequence": {
        const nonLiteral = node.attrs.nodes.find((n) => n.kind !== "literal");
        return nonLiteral ? this.findTerminal(nonLiteral) : undefined;
      }
      default:
        return node;
    }
  }

  // Build a simple command-line string from literal nodes in an expression
  private buildCommandLineFromExpr(expr: Expr): string {
    if (expr.kind === "literal") return expr.attrs.str;
    if (expr.kind === "sequence") {
      return expr.attrs.nodes.map((n) => this.buildCommandLineFromExpr(n)).join(" ");
    }
    return "";
  }

  private isBool(type: BoundType): boolean {
    if (type.kind === "bool") return true;
    if (type.kind === "optional") return this.isBool(type.inner);
    return false;
  }

  private isCount(type: BoundType): boolean {
    if (type.kind === "count") return true;
    if (type.kind === "optional") return this.isCount(type.inner);
    return false;
  }

  // Boutiques `id` must match /^[0-9A-Za-z_]+$/ (input ids, sub-descriptor
  // ids, value-keys after [ ] removal). Non-matching chars (e.g. argparse
  // subparser names with hyphens) become underscores.
  private sanitizeId(raw: string): string {
    const cleaned = raw.replace(/[^0-9A-Za-z_]/g, "_");
    return cleaned.length > 0 ? cleaned : "id";
  }

  private findCountRepeat(node: Expr): Extract<Expr, { kind: "repeat" }> | undefined {
    switch (node.kind) {
      case "repeat":
        return node;
      case "optional":
        return this.findCountRepeat(node.attrs.node);
      default:
        return undefined;
    }
  }

  // Bounded count -> String + enumerated value-choices.
  // Unbounded count -> SubCommand + list:true (no list-separator: each
  // occurrence must be a separate argv element for argparse to count it).
  private mapCount(
    node: Expr,
  ): {
    type: string | BtDescriptor;
    valueChoices?: string[];
    list?: boolean;
    listSeparator?: string;
    minListEntries?: number;
    optional?: boolean;
  } {
    const repeat = this.findCountRepeat(node);
    if (!repeat || repeat.attrs.node.kind !== "literal") {
      return { type: "Flag" };
    }
    const flag = repeat.attrs.node.attrs.str;
    const countMin = repeat.attrs.countMin ?? 0;
    const countMax = repeat.attrs.countMax;

    if (countMax !== undefined && countMax >= Math.max(countMin, 1)) {
      const choices: string[] = [];
      const start = Math.max(countMin, 1);
      for (let i = start; i <= countMax; i++) choices.push(flag.repeat(i));
      return {
        type: "String",
        valueChoices: choices,
        ...(countMin === 0 && { optional: true }),
      };
    }

    const dest = repeat.meta?.name;
    const subId = this.sanitizeId(dest ? `${dest}_token` : "count_token");
    const subBt: BtDescriptor = {
      name: subId,
      id: subId,
      "command-line": flag,
      inputs: [],
    };

    return {
      type: subBt,
      list: true,
      minListEntries: countMin,
    };
  }
}

export function generateBoutiques(ctx: CodegenContext): {
  descriptor: BtDescriptor;
  warnings: EmitWarning[];
} {
  return new BoutiquesEmitter(ctx).emit();
}

export class BoutiquesBackend implements Backend {
  readonly name = "boutiques";
  readonly target = "boutiques";

  emit(ctx: CodegenContext): EmitResult {
    const { descriptor, warnings } = generateBoutiques(ctx);
    const json = JSON.stringify(descriptor, null, 2);
    return {
      files: new Map([["descriptor.json", json]]),
      errors: [],
      warnings,
    };
  }
}
