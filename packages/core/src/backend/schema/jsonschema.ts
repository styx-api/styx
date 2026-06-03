import type { Binding, BoundType, BoundVariant } from "../../bindings/index.js";
import type { Expr, ScalarKind } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import type { Backend, EmittedApp } from "../backend.js";
import { type OutputShape, collectOutputFields, streamFields } from "../collect-output-fields.js";
import { findDoc } from "../find-doc.js";
import { findStructNode } from "../find-struct-node.js";
import { resolveFieldBinding } from "../resolve-field-binding.js";

export interface JsonSchema {
  type?: string | string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  oneOf?: JsonSchema[];
  enum?: (string | number)[];
  const?: string | number;
  [key: string]: unknown;
}

class SchemaBuilder {
  constructor(private ctx: CodegenContext) {}

  build(): JsonSchema {
    const envelope: JsonSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
    };
    if (this.ctx.app?.doc?.title) envelope.title = this.ctx.app.doc.title;
    if (this.ctx.app?.doc?.description) envelope.description = this.ctx.app.doc.description;

    const rootBinding = this.ctx.resolve(this.ctx.expr);
    if (!rootBinding) return envelope;

    const schema = { ...envelope, ...this.fromBinding(rootBinding) };

    if (this.ctx.app?.id && schema.properties) {
      const pkg = this.ctx.package?.name ?? "unknown";
      schema.properties = {
        "@type": { const: `${pkg}/${this.ctx.app.id}` },
        ...schema.properties,
      };
      schema.required = ["@type", ...(schema.required ?? [])];
    }

    return schema;
  }

  private fromBinding(binding: Binding): JsonSchema {
    const schema = this.fromType(binding.type, binding.node);
    const meta = binding.node.meta;
    if (meta?.doc?.title) schema.title = meta.doc.title;
    if (meta?.doc?.description) schema.description = meta.doc.description;
    if (meta?.defaultValue !== undefined) schema.default = meta.defaultValue;
    return schema;
  }

  private fromType(type: BoundType, node?: Expr): JsonSchema {
    switch (type.kind) {
      case "scalar":
        return this.scalarSchema(type.scalar, node);
      case "bool":
        return { type: "boolean" };
      case "count":
        return { type: "integer", minimum: 0 };
      case "literal":
        return { const: type.value };
      case "optional":
        return this.fromType(type.inner, node?.kind === "optional" ? node.attrs.node : undefined);
      case "list":
        return {
          type: "array",
          items: this.fromType(type.item, node?.kind === "repeat" ? node.attrs.node : undefined),
        };
      case "struct":
        return this.structSchema(type, node);
      case "union":
        return this.unionSchema(type);
    }
  }

  private findTerminal(node: Expr): Expr {
    switch (node.kind) {
      case "optional":
        return this.findTerminal(node.attrs.node);
      case "repeat":
        return this.findTerminal(node.attrs.node);
      case "sequence": {
        const nonLiteral = node.attrs.nodes.find((n) => n.kind !== "literal");
        return nonLiteral ? this.findTerminal(nonLiteral) : node;
      }
      default:
        return node;
    }
  }

  private scalarSchema(scalar: ScalarKind, node?: Expr): JsonSchema {
    const base: JsonSchema = {
      int: { type: "integer" } as JsonSchema,
      float: { type: "number" } as JsonSchema,
      str: { type: "string" } as JsonSchema,
      // TODO: rename to "path" - keeping "file" for v1 compatibility
      path: { type: "string", "x-styx-type": "file" } as JsonSchema,
    }[scalar];

    const terminal = node ? this.findTerminal(node) : undefined;
    if (terminal && (terminal.kind === "int" || terminal.kind === "float")) {
      if (terminal.attrs.minValue !== undefined) base.minimum = terminal.attrs.minValue;
      if (terminal.attrs.maxValue !== undefined) base.maximum = terminal.attrs.maxValue;
    }

    return base;
  }

  private structSchema(type: Extract<BoundType, { kind: "struct" }>, node?: Expr): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    // Use shared findStructNode for correct traversal through opt/rep/alt wrappers
    const structNode = node ? findStructNode(node, this.ctx, type) : undefined;
    if (structNode) {
      for (const child of structNode.attrs.nodes) {
        // Use shared resolveFieldBinding for correct collapsed-sequence handling
        const match = resolveFieldBinding(child, this.ctx, type);
        if (!match) continue;
        const { binding, wrapperNode } = match;

        const schema = this.fromType(binding.type, binding.node);
        const fieldType = type.fields[binding.name]!;

        // Use shared findDoc for correct doc propagation through collapsed sequences
        const doc =
          findDoc(wrapperNode, fieldType) ??
          findDoc(binding.node, fieldType) ??
          wrapperNode.meta?.doc?.description;
        if (doc) schema.description = doc;

        const title = wrapperNode.meta?.doc?.title ?? binding.node.meta?.doc?.title;
        if (title) schema.title = title;

        const defaultValue = wrapperNode.meta?.defaultValue ?? binding.node.meta?.defaultValue;
        if (defaultValue !== undefined) schema.default = defaultValue;

        properties[binding.name] = schema;
        if (fieldType.kind !== "optional" && defaultValue === undefined) {
          required.push(binding.name);
        }
      }
    } else {
      for (const [name, fieldType] of Object.entries(type.fields)) {
        properties[name] = this.fromType(fieldType);
        if (fieldType.kind !== "optional") {
          required.push(name);
        }
      }
    }

    const schema: JsonSchema = { type: "object", properties };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  private unionSchema(type: Extract<BoundType, { kind: "union" }>): JsonSchema {
    const allLiterals = type.variants.every((v: BoundVariant) => v.type.kind === "literal");
    if (allLiterals) {
      return {
        enum: type.variants.map((v: BoundVariant) =>
          v.type.kind === "literal" ? v.type.value : "",
        ),
      };
    }
    return { oneOf: type.variants.map((v: BoundVariant) => this.fromType(v.type)) };
  }
}

export function generateSchema(ctx: CodegenContext): JsonSchema {
  return new SchemaBuilder(ctx).build();
}

/** Output names are language-neutral in the schema; key by the raw descriptor id. */
const rawName = (name: string): string => name;

/** The JSON Schema for one output field, given its solved shape. */
function outputFieldSchema(shape: OutputShape): JsonSchema {
  // A list output is always present (an empty array when nothing is produced),
  // its elements never null: `OutputPathType[]` / `list[OutputPathType]`.
  if (shape.kind === "list") {
    return { type: "array", items: { type: "string", "x-styx-type": "file" } };
  }
  // A single output's key is always present on the Outputs object; when its gate
  // is off the value is `null` (the backends type it `OutputPathType | None` /
  // `OutputPathType | null`). So a gated single is a file path OR null - not an
  // absent key. We mark it `required` (see below) and carry the null branch.
  if (shape.optional) return { type: ["string", "null"], "x-styx-type": "file" };
  return { type: "string", "x-styx-type": "file" };
}

/**
 * JSON Schema for a tool's **Outputs object**: the set of files it produces
 * (resolved outputs + mutable inputs surfaced as outputs) plus its captured
 * stdout/stderr streams. Built from the same `collectOutputFields` /
 * `streamFields` source of truth the Python and TypeScript backends use to type
 * the Outputs dataclass/interface, so the three describe the same shape.
 *
 * Field encoding (mirrors how the language backends type each field):
 * - required single -> `{ type: "string", x-styx-type: "file" }`
 * - optional single -> `{ type: ["string", "null"], x-styx-type: "file" }`
 * - list output     -> `{ type: "array", items: { type: "string", x-styx-type: "file" } }`
 * - stream field    -> `{ type: "array", items: { type: "string" } }` (lines of
 *   text, NOT paths - the absent `x-styx-type` lets a consumer tell them apart)
 *
 * EVERY field is `required`: unlike the inputs schema (where an optional param
 * key is genuinely omitted, so "not in `required`" is faithful), an Outputs
 * field is always present - a gated single is `null`, a gated list is an empty
 * array. So optionality is carried by the `null` type branch, and a strict
 * validator accepts the actual emitted object (e.g. `{ "out_file": null }`).
 */
export function generateOutputsSchema(ctx: CodegenContext): JsonSchema {
  const schema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  };
  if (ctx.app?.doc?.title) schema.title = ctx.app.doc.title;
  if (ctx.app?.doc?.description) schema.description = ctx.app.doc.description;

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const field of collectOutputFields(ctx, rawName)) {
    const prop = outputFieldSchema(field.shape);
    if (field.doc) prop.description = field.doc;
    properties[field.name] = prop;
    required.push(field.name);
  }

  for (const stream of streamFields(ctx, rawName)) {
    const prop: JsonSchema = { type: "array", items: { type: "string" } };
    if (stream.doc) prop.description = stream.doc;
    properties[stream.name] = prop;
    required.push(stream.name);
  }

  schema.properties = properties;
  if (required.length > 0) schema.required = required;
  return schema;
}

export class JsonSchemaBackend implements Backend {
  readonly name = "json-schema";
  readonly target = "json-schema";

  emitApp(ctx: CodegenContext): EmittedApp {
    const schema = generateSchema(ctx);
    const outputsSchema = generateOutputsSchema(ctx);
    return {
      meta: ctx.app,
      // Inputs and outputs are kept as two cleanly addressable artifacts
      // (mirroring v1's `<tool>.input.json` / `<tool>.output.json` split): a
      // consumer can fetch/compute either independently, and the inputs
      // `schema.json` stays byte-stable for existing consumers.
      files: new Map([
        ["schema.json", JSON.stringify(schema, null, 2)],
        ["outputs.schema.json", JSON.stringify(outputsSchema, null, 2)],
      ]),
      errors: [],
      warnings: [],
    };
  }
}
