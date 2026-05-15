import { describe, expect, it } from "vitest";
import { resolveOutputs, solve } from "../../solver/index.js";
import { defaultPipeline } from "../../ir/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { createContext } from "../../manifest/context.js";
import { generateSchema, JsonSchemaBackend } from "./jsonschema.js";
import type { JsonSchema } from "./jsonschema.js";

const parser = new BoutiquesParser();

function schemaFor(descriptor: Record<string, unknown>): JsonSchema {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
  return generateSchema(ctx);
}

function minimalDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-tool",
    "command-line": "test",
    inputs: [],
    ...overrides,
  };
}

function minimalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "input1",
    name: "Input 1",
    type: "String",
    "value-key": "[INPUT1]",
    ...overrides,
  };
}

describe("JsonSchema generation", () => {
  it("produces a valid JSON Schema envelope", () => {
    const schema = schemaFor(minimalDescriptor());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("includes app-level title and description", () => {
    const schema = schemaFor(minimalDescriptor({ name: "My Tool", description: "A useful tool" }));
    expect(schema.title).toBe("My Tool");
    expect(schema.description).toBe("A useful tool");
  });

  it("maps string input to string type", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
      }),
    );
    expect(schema.properties).toBeDefined();
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("string");
  });

  it("maps integer input to integer type", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Number", integer: true })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("integer");
  });

  it("maps float input to number type", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Number" })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("number");
  });

  it("maps file input to string with x-styx-type=file", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "File" })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("string");
    expect(props["input1"]?.["x-styx-type"]).toBe("file");
  });

  it("maps flag input to boolean", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Flag", "command-line-flag": "-v" })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("boolean");
  });

  it("marks required fields in required array", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1] [INPUT2]",
        inputs: [
          minimalInput({ id: "input1", "value-key": "[INPUT1]", type: "String" }),
          minimalInput({
            id: "input2",
            "value-key": "[INPUT2]",
            type: "String",
            optional: true,
          }),
        ],
      }),
    );
    expect(schema.required).toContain("input1");
    expect(schema.required).not.toContain("input2");
  });

  it("propagates minimum/maximum from int constraints", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "Number",
            integer: true,
            minimum: 0,
            maximum: 100,
          }),
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.minimum).toBe(0);
    expect(props["input1"]?.maximum).toBe(100);
  });

  it("propagates minimum/maximum from float constraints", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "Number",
            minimum: 0.0,
            maximum: 1.0,
          }),
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.minimum).toBe(0.0);
    expect(props["input1"]?.maximum).toBe(1.0);
  });

  it("emits enum for all-literal unions", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String", "value-choices": ["a", "b", "c"] })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.enum).toEqual(["a", "b", "c"]);
    expect(props["input1"]?.oneOf).toBeUndefined();
  });

  it("propagates title and description from node metadata", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "String",
            name: "My Input",
            description: "An important input",
          }),
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.title).toBe("My Input");
    expect(props["input1"]?.description).toBe("An important input");
  });

  it("propagates default values", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "String",
            optional: true,
            "default-value": "hello",
          }),
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.default).toBe("hello");
  });

  it("handles list inputs as arrays", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String", list: true })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("array");
    expect(props["input1"]?.items).toEqual({ type: "string" });
  });
  it("handles subcommand with flag wrapping", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [MASKS]",
        inputs: [
          {
            id: "masks",
            name: "Masks",
            "value-key": "[MASKS]",
            "command-line-flag": "--masks",
            type: {
              id: "masks",
              "command-line": "[FIXED] [MOVING]",
              inputs: [
                { id: "fixed", "value-key": "[FIXED]", type: "String", optional: true },
                { id: "moving", "value-key": "[MOVING]", type: "String", optional: false },
              ],
            },
            optional: true,
          },
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    const masks = props["masks"];
    expect(masks).toBeDefined();
    const masksProps = masks?.properties as Record<string, JsonSchema>;
    expect(masksProps["fixed"]?.type).toBe("string");
    expect(masksProps["moving"]?.type).toBe("string");
  });
});

describe("JsonSchemaBackend", () => {
  it("emits a file map with schema.json", () => {
    const { expr, meta } = parser.parse(
      JSON.stringify(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "String" })],
        }),
      ),
    );
    const optimized = defaultPipeline.apply(expr).expr;
    const solveResult = solve(optimized);
    const outputs = resolveOutputs(optimized, solveResult);
    const ctx = createContext(optimized, solveResult, outputs, {
      app: meta ? { doc: meta.doc } : undefined,
    });

    const backend = new JsonSchemaBackend();
    const result = backend.emit(ctx);

    expect(result.errors).toHaveLength(0);
    expect(result.files.has("schema.json")).toBe(true);
    const parsed = JSON.parse(result.files.get("schema.json")!);
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("bet descriptor produces expected schema", () => {
    const betDescriptor = {
      name: "bet",
      description: "Automated brain extraction tool for FSL",
      "command-line": "bet [INFILE] [MASKFILE] [FRACTIONAL_INTENSITY] [VERBOSE]",
      inputs: [
        { id: "infile", "value-key": "[INFILE]", type: "File", optional: false },
        { id: "maskfile", "value-key": "[MASKFILE]", type: "String", optional: false },
        {
          id: "fractional_intensity",
          "value-key": "[FRACTIONAL_INTENSITY]",
          type: "Number",
          "command-line-flag": "-f",
          minimum: 0,
          maximum: 1,
          optional: true,
        },
        { id: "verbose", "value-key": "[VERBOSE]", type: "Flag", "command-line-flag": "-v" },
      ],
    };

    const schema = schemaFor(betDescriptor);

    expect(schema.title).toBe("bet");
    expect(schema.description).toBe("Automated brain extraction tool for FSL");

    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["@type"]).toEqual({ const: "unknown/bet" });
    expect(schema.required).toContain("@type");
    expect(props["infile"]?.type).toBe("string");
    expect(props["infile"]?.["x-styx-type"]).toBe("file");
    expect(props["maskfile"]?.type).toBe("string");
    expect(props["fractional_intensity"]?.type).toBe("number");
    expect(props["fractional_intensity"]?.minimum).toBe(0);
    expect(props["fractional_intensity"]?.maximum).toBe(1);
    expect(props["verbose"]?.type).toBe("boolean");

    expect(schema.required).toContain("infile");
    expect(schema.required).toContain("maskfile");
    expect(schema.required).not.toContain("fractional_intensity");
    // verbose is bool with default false, so it is not required
    expect(schema.required).not.toContain("verbose");
    expect(props["verbose"]?.default).toBe(false);
  });
});
