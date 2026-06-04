import { describe, expect, it } from "vitest";
import { resolveOutputs, solve } from "../../solver/index.js";
import { defaultPipeline } from "../../ir/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { createContext } from "../../manifest/context.js";
import { generateOutputsSchema, generateSchema, JsonSchemaBackend } from "./jsonschema.js";
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

function outputsSchemaFor(descriptor: Record<string, unknown>): JsonSchema {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
  return generateOutputsSchema(ctx);
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

  it("maps file input to string with x-styx-type=path", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "File" })],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("string");
    expect(props["input1"]?.["x-styx-type"]).toBe("path");
  });

  it("maps a bounded list input to an array with minItems/maxItems", () => {
    const schema = schemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "Number",
            list: true,
            "min-list-entries": 3,
            "max-list-entries": 3,
          }),
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["input1"]?.type).toBe("array");
    expect(props["input1"]?.minItems).toBe(3);
    expect(props["input1"]?.maxItems).toBe(3);
    expect((props["input1"]?.items as JsonSchema)?.type).toBe("number");
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

describe("Outputs JSON Schema generation", () => {
  const withOutputs = (outputFiles: unknown[], inputs: unknown[]): Record<string, unknown> =>
    minimalDescriptor({
      "command-line": "test [INPUT1]",
      inputs,
      "output-files": outputFiles,
    });

  it("produces a valid object-typed envelope", () => {
    const schema = outputsSchemaFor(minimalDescriptor());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });

  it("includes app-level title and description", () => {
    const schema = outputsSchemaFor(
      minimalDescriptor({ name: "My Tool", description: "A useful tool" }),
    );
    expect(schema.title).toBe("My Tool");
    expect(schema.description).toBe("A useful tool");
  });

  it("emits only the always-present root property for a tool with no declared outputs", () => {
    const schema = outputsSchemaFor(minimalDescriptor());
    expect(schema.properties).toEqual({
      root: { type: "string", "x-styx-type": "path" },
    });
    expect(schema.required).toEqual(["root"]);
  });

  it("maps a required single output to a required file-typed property", () => {
    const schema = outputsSchemaFor(
      withOutputs(
        [
          {
            id: "out",
            name: "Output",
            description: "The result file",
            "path-template": "[INPUT1].out",
          },
        ],
        [minimalInput({ type: "File" })],
      ),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["out"]).toEqual({
      type: "string",
      "x-styx-type": "path",
      description: "The result file",
    });
    expect(schema.required).toContain("out");
  });

  it("types an optional (present-gated) output as nullable and keeps it required", () => {
    // The output references an optional input, so its gate carries a `present`
    // atom -> optional-single. The Outputs field is always present but null when
    // the gate is off, so it stays in `required` and carries a null type branch.
    const schema = outputsSchemaFor(
      withOutputs(
        [{ id: "out", name: "Output", "path-template": "[INPUT1].out" }],
        [minimalInput({ type: "File", optional: true })],
      ),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["out"]?.type).toEqual(["string", "null"]);
    expect(props["out"]?.["x-styx-type"]).toBe("path");
    expect(schema.required).toContain("out");
  });

  it("types a union-variant-gated output as nullable and keeps it required", () => {
    // The `converted` output references `src`, which lives in the `convert` arm
    // of a union, so its gate carries a `variant` atom (a distinct optionality
    // path from `present`) -> optional-single -> nullable + required.
    const schema = outputsSchemaFor(
      minimalDescriptor({
        "command-line": "test [SUBCMD]",
        inputs: [
          {
            id: "subcmd",
            "value-key": "[SUBCMD]",
            type: [
              {
                id: "convert",
                "command-line": "convert [SRC]",
                inputs: [{ id: "src", "value-key": "[SRC]", type: "File" }],
                "output-files": [
                  { id: "converted", name: "Converted", "path-template": "[SRC].conv" },
                ],
              },
              {
                id: "inspect",
                "command-line": "inspect [TARGET]",
                inputs: [{ id: "target", "value-key": "[TARGET]", type: "File" }],
              },
            ],
          },
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["converted"]?.type).toEqual(["string", "null"]);
    expect(props["converted"]?.["x-styx-type"]).toBe("path");
    expect(schema.required).toContain("converted");
  });

  it("maps a list output to a required array of file-typed items", () => {
    // The output references a list input, so its gate carries an `iter` atom
    // -> list shape -> always present (empty array when nothing is produced).
    const schema = outputsSchemaFor(
      withOutputs(
        [
          {
            id: "out",
            name: "Output",
            description: "All results",
            "path-template": "[INPUT1].out",
          },
        ],
        [minimalInput({ type: "File", list: true })],
      ),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["out"]).toEqual({
      type: "array",
      items: { type: "string", "x-styx-type": "path" },
      description: "All results",
    });
    expect(schema.required).toContain("out");
  });

  it("propagates the output name as the property description when no doc is given", () => {
    const schema = outputsSchemaFor(
      withOutputs(
        [{ id: "out", name: "Output file", "path-template": "[INPUT1].out" }],
        [minimalInput({ type: "File" })],
      ),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["out"]?.description).toBe("Output file");
  });

  it("maps stdout/stderr streams to required string arrays with no file marker", () => {
    const schema = outputsSchemaFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
        "stdout-output": { id: "stdout", name: "Captured stdout" },
        "stderr-output": { id: "stderr", name: "Captured stderr", description: "Standard error." },
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    // A line list, NOT a path list: the absent `x-styx-type` on `items`
    // distinguishes a captured stream from a produced file.
    expect(props["stdout"]?.type).toBe("array");
    expect(props["stdout"]?.items).toEqual({ type: "string" });
    expect(props["stderr"]).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Standard error.",
    });
    expect(schema.required).toContain("stdout");
    expect(schema.required).toContain("stderr");
  });

  it("surfaces a mutable input as a required file output", () => {
    const schema = outputsSchemaFor(
      minimalDescriptor({
        "command-line": "test [INFILE]",
        inputs: [
          { id: "infile", name: "Input", type: "File", "value-key": "[INFILE]", mutable: true },
        ],
      }),
    );
    const props = schema.properties as Record<string, JsonSchema>;
    expect(props["infile"]?.type).toBe("string");
    expect(props["infile"]?.["x-styx-type"]).toBe("path");
    expect(schema.required).toContain("infile");
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
    const result = backend.emitApp(ctx);

    expect(result.errors).toHaveLength(0);
    expect(result.files.has("schema.json")).toBe(true);
    const parsed = JSON.parse(result.files.get("schema.json")!);
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("emits outputs.schema.json alongside schema.json", () => {
    const { expr, meta } = parser.parse(
      JSON.stringify(
        minimalDescriptor({
          "command-line": "test [INPUT1]",
          inputs: [minimalInput({ type: "File" })],
          "output-files": [{ id: "out", name: "Output", "path-template": "[INPUT1].out" }],
        }),
      ),
    );
    const optimized = defaultPipeline.apply(expr).expr;
    const solveResult = solve(optimized);
    const outputs = resolveOutputs(optimized, solveResult);
    const ctx = createContext(optimized, solveResult, outputs, { app: meta });

    const result = new JsonSchemaBackend().emitApp(ctx);

    expect(result.files.has("outputs.schema.json")).toBe(true);
    const parsed = JSON.parse(result.files.get("outputs.schema.json")!);
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parsed.type).toBe("object");
    expect(parsed.properties.out).toEqual({
      type: "string",
      "x-styx-type": "path",
      description: "Output",
    });
    expect(parsed.required).toContain("out");
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
    expect(props["infile"]?.["x-styx-type"]).toBe("path");
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
