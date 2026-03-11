import { describe, expect, it } from "vitest";
import { solve } from "../../solver/solver.js";
import { defaultPipeline } from "../../ir/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { createContext } from "../../manifest/context.js";
import { generateBoutiques, BoutiquesBackend } from "./boutiques.js";

const parser = new BoutiquesParser();

function emitFor(descriptor: Record<string, unknown>): Record<string, unknown> {
  const { expr, meta } = parser.parse(JSON.stringify(descriptor));
  const optimized = defaultPipeline.apply(expr).expr;
  const solveResult = solve(optimized);
  const ctx = createContext(optimized, solveResult, { app: meta });
  const { descriptor: bt } = generateBoutiques(ctx);
  return bt as Record<string, unknown>;
}

function roundTrip(descriptor: Record<string, unknown>): Record<string, unknown> {
  const emitted = emitFor(descriptor);
  // Re-parse the emitted descriptor
  const result = parser.parse(JSON.stringify(emitted));
  expect(result.errors).toHaveLength(0);
  return emitted;
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

describe("Boutiques generation", () => {
  it("produces a schema-version field", () => {
    const bt = emitFor(minimalDescriptor());
    expect(bt["schema-version"]).toBe("0.5+styx");
  });

  it("maps app-level metadata", () => {
    const bt = emitFor(
      minimalDescriptor({
        name: "My Tool",
        description: "A useful tool",
        "tool-version": "1.0",
        author: "Test Author",
        url: "https://example.com",
      }),
    );
    expect(bt.name).toBe("My Tool");
    expect(bt.description).toBe("A useful tool");
    expect(bt["tool-version"]).toBe("1.0");
    expect(bt.author).toBe("Test Author");
    expect(bt.url).toBe("https://example.com");
  });

  it("maps container metadata", () => {
    const bt = emitFor(
      minimalDescriptor({
        "container-image": { image: "myimage:latest", type: "docker" },
      }),
    );
    const container = bt["container-image"] as Record<string, unknown>;
    expect(container.image).toBe("myimage:latest");
    expect(container.type).toBe("docker");
  });

  it("maps string input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.type).toBe("String");
    expect(inputs[0]!.id).toBe("input1");
  });

  it("maps integer input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Number", integer: true })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.type).toBe("Number");
    expect(inputs[0]!.integer).toBe(true);
  });

  it("maps float input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Number" })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.type).toBe("Number");
    expect(inputs[0]!.integer).toBeUndefined();
  });

  it("maps file input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "File" })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.type).toBe("File");
  });

  it("maps flag input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "Flag", "command-line-flag": "-v" })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.type).toBe("Flag");
    expect(inputs[0]!["command-line-flag"]).toBe("-v");
  });

  it("marks optional fields", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String", optional: true })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.optional).toBe(true);
  });

  it("handles list inputs", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "String",
            list: true,
            "list-separator": ",",
            "min-list-entries": 1,
            "max-list-entries": 5,
          }),
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.list).toBe(true);
    expect(inputs[0]!["list-separator"]).toBe(",");
    expect(inputs[0]!["min-list-entries"]).toBe(1);
    expect(inputs[0]!["max-list-entries"]).toBe(5);
  });

  it("maps value-choices for enum inputs", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String", "value-choices": ["a", "b", "c"] })],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!["value-choices"]).toEqual(["a", "b", "c"]);
  });

  it("propagates number constraints", () => {
    const bt = emitFor(
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
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!.minimum).toBe(0);
    expect(inputs[0]!.maximum).toBe(100);
  });

  it("propagates default values", () => {
    const bt = emitFor(
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
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!["default-value"]).toBe("hello");
  });

  it("handles command-line-flag with separator", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "String",
            "command-line-flag": "--name",
            "command-line-flag-separator": "=",
            optional: true,
          }),
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!["command-line-flag"]).toBe("--name");
    expect(inputs[0]!["command-line-flag-separator"]).toBe("=");
  });

  it("handles file input with resolve-parent and mutable", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "File",
            "resolve-parent": true,
            mutable: true,
          }),
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!["resolve-parent"]).toBe(true);
    expect(inputs[0]!.mutable).toBe(true);
  });

  it("handles stdout/stderr outputs", () => {
    const bt = emitFor(
      minimalDescriptor({
        "stdout-output": { id: "stdout", name: "Standard output", description: "stdout desc" },
        "stderr-output": { id: "stderr", name: "Standard error" },
      }),
    );
    const stdout = bt["stdout-output"] as Record<string, unknown>;
    expect(stdout.id).toBe("stdout");
    expect(stdout.name).toBe("Standard output");
    expect(stdout.description).toBe("stdout desc");
    const stderr = bt["stderr-output"] as Record<string, unknown>;
    expect(stderr.id).toBe("stderr");
    expect(stderr.name).toBe("Standard error");
  });
});

describe("Boutiques subcommands", () => {
  it("handles subcommand input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [SUB]",
        inputs: [
          {
            id: "sub",
            name: "Subcommand",
            "value-key": "[SUB]",
            type: {
              id: "sub",
              "command-line": "--name [NAME]",
              inputs: [
                { id: "name", "value-key": "[NAME]", type: "String" },
              ],
            },
          },
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs).toHaveLength(1);
    const subType = inputs[0]!.type as Record<string, unknown>;
    expect(typeof subType).toBe("object");
    expect(Array.isArray(subType)).toBe(false);
    const subInputs = subType.inputs as Record<string, unknown>[];
    expect(subInputs).toBeDefined();
    expect(subInputs.length).toBeGreaterThan(0);
  });

  it("handles subcommand union input", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [SUB]",
        inputs: [
          {
            id: "sub",
            name: "Subcommand",
            "value-key": "[SUB]",
            type: [
              {
                id: "mode_a",
                name: "Mode A",
                "command-line": "--mode a [VAL]",
                inputs: [{ id: "val", "value-key": "[VAL]", type: "String" }],
              },
              {
                id: "mode_b",
                name: "Mode B",
                "command-line": "--mode b [NUM]",
                inputs: [
                  { id: "num", "value-key": "[NUM]", type: "Number", integer: true },
                ],
              },
            ],
          },
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs).toHaveLength(1);
    const subType = inputs[0]!.type;
    expect(Array.isArray(subType)).toBe(true);
    const alts = subType as Record<string, unknown>[];
    expect(alts.length).toBe(2);
  });
});

describe("Boutiques round-trip", () => {
  it("round-trips a simple descriptor", () => {
    roundTrip(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
      }),
    );
  });

  it("round-trips a descriptor with flags", () => {
    roundTrip(
      minimalDescriptor({
        "command-line": "test [VERBOSE] [INPUT1]",
        inputs: [
          { id: "verbose", "value-key": "[VERBOSE]", type: "Flag", "command-line-flag": "-v" },
          minimalInput({ type: "String" }),
        ],
      }),
    );
  });

  it("round-trips a descriptor with optional and flag", () => {
    roundTrip(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "Number",
            "command-line-flag": "-n",
            optional: true,
          }),
        ],
      }),
    );
  });

  it("round-trips the bet descriptor", () => {
    roundTrip({
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
    });
  });
});

describe("BoutiquesBackend", () => {
  it("emits a file map with descriptor.json", () => {
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
    const ctx = createContext(optimized, solveResult, { app: meta });

    const backend = new BoutiquesBackend();
    const result = backend.emit(ctx);

    expect(result.errors).toHaveLength(0);
    expect(result.files.has("descriptor.json")).toBe(true);
    const parsed = JSON.parse(result.files.get("descriptor.json")!);
    expect(parsed["schema-version"]).toBe("0.5+styx");
  });

  it("produces valid JSON that can be re-parsed", () => {
    const { expr, meta } = parser.parse(
      JSON.stringify(
        minimalDescriptor({
          "command-line": "test [INPUT1] [INPUT2]",
          inputs: [
            minimalInput({ type: "String" }),
            {
              id: "input2",
              name: "Input 2",
              type: "Number",
              integer: true,
              "value-key": "[INPUT2]",
              "command-line-flag": "--count",
              optional: true,
            },
          ],
        }),
      ),
    );
    const optimized = defaultPipeline.apply(expr).expr;
    const solveResult = solve(optimized);
    const ctx = createContext(optimized, solveResult, { app: meta });

    const backend = new BoutiquesBackend();
    const result = backend.emit(ctx);
    const json = result.files.get("descriptor.json")!;

    // Re-parse with BoutiquesParser - should succeed
    const reparse = parser.parse(json);
    expect(reparse.errors).toHaveLength(0);
  });
});
