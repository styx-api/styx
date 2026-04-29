import { describe, expect, it } from "vitest";
import { solve } from "../../solver/solver.js";
import { defaultPipeline } from "../../ir/index.js";
import { BoutiquesParser } from "../../frontend/boutiques/parser.js";
import { ArgdumpParser } from "../../frontend/argdump/parser.js";
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

  it("merges default values into the description", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "test [INPUT1]",
        inputs: [
          minimalInput({
            type: "String",
            optional: true,
            description: "An input.",
            "default-value": "hello",
          }),
        ],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs[0]!["default-value"]).toBeUndefined();
    expect(inputs[0]!.description).toContain('Default: "hello"');
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

// Regression tests for issues styx-api/styx-ts#1-#5: argdump -> Boutiques
// must produce a descriptor that passes `bosh validate`, even when the source
// argparse parser uses dynamic types (functools.partial, custom action classes).
describe("argdump -> Boutiques validity", () => {
  const argdumpParser = new ArgdumpParser();

  function emitFromArgdump(dump: Record<string, unknown>): Record<string, unknown> {
    const { expr, meta } = argdumpParser.parse(JSON.stringify(dump));
    const optimized = defaultPipeline.apply(expr).expr;
    const solveResult = solve(optimized);
    const ctx = createContext(optimized, solveResult, { app: meta });
    const { descriptor: bt } = generateBoutiques(ctx);
    return bt as Record<string, unknown>;
  }

  it("emits `name` (not `id`) at the top level", () => {
    const bt = emitFromArgdump({
      prog: "mytool",
      description: "A tool",
      actions: [],
    });
    expect(bt.name).toBeDefined();
    expect(bt.id).toBeUndefined();
  });

  it("emits `name` on every input, defaulting to id", () => {
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: [],
          dest: "src",
          action_type: "store",
          type_info: { name: "str", builtin: true },
        },
        {
          option_strings: ["-v", "--verbose"],
          dest: "verbose",
          action_type: "store_true",
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.name).toBeDefined();
    }
  });

  it("encodes unbounded argparse count as a SubCommand with list:true", () => {
    // Boutiques has no native count: must be either value-choices (bounded)
    // or a SubCommand+list (unbounded). `Flag` with list:true is invalid.
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["-v", "--verbose"],
          dest: "verbose",
          action_type: "count",
          default: 0,
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const inp = inputs.find((i) => i.id === "verbose");
    expect(inp).toBeDefined();
    expect(inp!.list).toBe(true);
    expect(inp!["min-list-entries"]).toBe(0);
    // No list-separator: Boutiques must emit each list item as a separate
    // argv element so argparse `count` reads them as N occurrences. A
    // separator would collapse them into one space-joined argument.
    expect(inp!["list-separator"]).toBeUndefined();
    expect(inp!["default-value"]).toBeUndefined();

    // The type must be a SubCommand (object), not "Flag". Three occurrences
    // produce argv ["--verbose", "--verbose", "--verbose"], equivalent to
    // argparse `-vvv`.
    const sub = inp!.type as Record<string, unknown>;
    expect(typeof sub).toBe("object");
    expect(sub["command-line"]).toBe("--verbose");
    expect(sub.inputs).toEqual([]);
  });

  it("drops default-value when not in value-choices", () => {
    // store with bool default + string choices (e.g. --cifti-output)
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["--cifti-output"],
          dest: "cifti_output",
          action_type: "store",
          nargs: "?",
          default: false,
          type_info: { name: "str", builtin: true },
          choices: ["91k", "170k"],
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const inp = inputs.find((i) => i.id === "cifti_output");
    expect(inp).toBeDefined();
    expect(inp!["value-choices"]).toEqual(["91k", "170k"]);
    expect(inp!["default-value"]).toBeUndefined();
  });

  it("coerces String defaults & choices to strings (numeric type with explicit choices)", () => {
    // bold2anat_dof: type=int, choices=[6,9,12], default=6 - parser produces
    // a String alternative, but choices/default round-trip as numbers without
    // coercion.
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["--bold2anat-dof"],
          dest: "bold2anat_dof",
          action_type: "store",
          default: 6,
          type_info: { name: "int", builtin: true },
          choices: [6, 9, 12],
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const inp = inputs.find((i) => i.id === "bold2anat_dof");
    expect(inp).toBeDefined();
    expect(inp!.type).toBe("String");
    expect(inp!["value-choices"]).toEqual(["6", "9", "12"]);
    expect(inp!["default-value"]).toBeUndefined();
    expect(inp!.description).toContain('Default: "6"');
  });

  it("upgrades String inputs with bool default to Flag (custom action class)", () => {
    // force_syn: action_type=unknown (DeprecatedAction), default=false
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["--force-syn"],
          dest: "force_syn",
          action_type: "unknown",
          default: false,
          custom_action_class: "DeprecatedAction",
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const inp = inputs.find((i) => i.id === "force_syn");
    expect(inp).toBeDefined();
    expect(inp!.type).toBe("Flag");
    expect(inp!["default-value"]).toBeUndefined();
    expect(inp!["command-line-flag"]).toBe("--force-syn");
  });

  it("mutex group variants keep their own names, not the group name", () => {
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["--input-file"],
          dest: "input_file",
          action_type: "store",
          type_info: { name: "Path", module: "pathlib" },
        },
        {
          option_strings: ["--no-input"],
          dest: "no_input",
          action_type: "store_true",
        },
      ],
      mutually_exclusive_groups: [
        { required: false, actions: ["input_file", "no_input"] },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const parent = inputs.find((i) => i.id === "input_file_or_no_input");
    expect(parent).toBeDefined();
    const variants = parent!.type as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    // Each variant must carry its own dest-derived name, not the group name.
    const variantNames = variants.map((v) => v.id).sort();
    expect(variantNames).not.toContain("input_file_or_no_input");
    expect(variantNames).toContain("input_file");
  });

  it("sanitizes ids when source names contain illegal characters", () => {
    // Boutiques requires id ~ /^[0-9A-Za-z_]+$/. Argparse subparser command
    // names commonly contain hyphens (e.g. `do-thing`).
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: [],
          dest: "cmd",
          action_type: "parsers",
          subparsers: {
            "do-thing": { actions: [], description: "Do a thing" },
            "other.cmd": { actions: [], description: "Other" },
          },
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs.length).toBeGreaterThan(0);
    // Walk each input/sub-descriptor and assert no illegal id chars.
    const idRe = /^[0-9A-Za-z_]+$/;
    const checkBt = (d: Record<string, unknown>): void => {
      if (typeof d.id === "string") expect(d.id).toMatch(idRe);
      const ins = d.inputs as Record<string, unknown>[] | undefined;
      if (Array.isArray(ins)) {
        for (const i of ins) {
          if (typeof i.id === "string") expect(i.id).toMatch(idRe);
          if (typeof i.type === "object" && i.type !== null) {
            checkBt(i.type as Record<string, unknown>);
          } else if (Array.isArray(i.type)) {
            for (const v of i.type) checkBt(v as Record<string, unknown>);
          }
        }
      }
    };
    checkBt(bt);
  });

  it("infers Number type from default when type_info is non-serializable (functools.partial)", () => {
    // slice_time_ref: type=functools.partial (serializable=false), default=0.5
    // Default is a finite non-integer number, so we infer float -> Boutiques Number.
    const bt = emitFromArgdump({
      prog: "mytool",
      actions: [
        {
          option_strings: ["--slice-time-ref"],
          dest: "slice_time_ref",
          action_type: "store",
          default: 0.5,
          type_info: { name: "functools.partial", module: "functools", serializable: false },
        },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const inp = inputs.find((i) => i.id === "slice_time_ref");
    expect(inp).toBeDefined();
    expect(inp!.type).toBe("Number");
    expect(inp!["default-value"]).toBeUndefined();
    expect(inp!.description).toContain("Default: 0.5");
  });
});
