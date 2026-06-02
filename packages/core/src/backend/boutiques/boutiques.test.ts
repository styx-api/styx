import { describe, expect, it } from "vitest";
import { resolveOutputs, solve } from "../../solver/index.js";
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
  const outputs = resolveOutputs(optimized, solveResult);
  const ctx = createContext(optimized, solveResult, outputs, { app: meta });
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
  it("collapses a lone (non-union) subcommand into the root command", () => {
    // The evolved model collapses `seq(T) -> T`, so a single (non-union)
    // subcommand merges into the root: its inputs surface as the tool's own
    // inputs and its command-line text becomes part of the root command. (Nested
    // SubCommand objects only arise from unions - see "handles subcommand union
    // input".) The tool's own command name must survive the merge.
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
              "command-line": "--name [NAME] [COUNT]",
              inputs: [
                { id: "name", "value-key": "[NAME]", type: "String" },
                { id: "count", "value-key": "[COUNT]", type: "Number", integer: true },
              ],
            },
          },
        ],
      }),
    );
    // Both subcommand inputs surface flat; no nested object.
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs.map((i) => i.id)).toEqual(["name", "count"]);
    expect(inputs.every((i) => typeof i.type === "string")).toBe(true);
    // The root command name is preserved ahead of the subcommand's own literal.
    expect(bt["command-line"]).toBe("test --name [NAME] [COUNT]");
  });

  it("preserves the command name when a single-input tool collapses", () => {
    // Regression: a single-input subcommand collapses through a preserved inner
    // sequence; the root `test` literal must not be dropped.
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
              inputs: [{ id: "name", "value-key": "[NAME]", type: "String" }],
            },
          },
        ],
      }),
    );
    expect(bt["command-line"]).toBe("test --name [NAME]");
    const inputs = bt.inputs as Record<string, unknown>[];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.type).toBe("String");
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
                inputs: [{ id: "num", "value-key": "[NUM]", type: "Number", integer: true }],
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
    const outputs = resolveOutputs(optimized, solveResult);
    const ctx = createContext(optimized, solveResult, outputs, { app: meta });

    const backend = new BoutiquesBackend();
    const result = backend.emitApp(ctx);

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
    const outputs = resolveOutputs(optimized, solveResult);
    const ctx = createContext(optimized, solveResult, outputs, { app: meta });

    const backend = new BoutiquesBackend();
    const result = backend.emitApp(ctx);
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
    const outputs = resolveOutputs(optimized, solveResult);
    const ctx = createContext(optimized, solveResult, outputs, { app: meta });
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
    // store with bool default + string choices (e.g. --cifti-output). nargs="?"
    // makes the value optional, so the flag can appear alone OR with a choice -
    // an optional-value-under-an-optional-flag, which the solver keeps as a
    // SubCommand (a single optional sub-field does not collapse, so the
    // "flag present, value absent" state survives). The string choices land on
    // the nested value input; the bool `default` must not become a
    // `default-value` on either input.
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
    expect(inp!["default-value"]).toBeUndefined();
    const sub = inp!.type as Record<string, unknown>;
    const nested = (sub.inputs as Record<string, unknown>[])[0]!;
    expect(nested["value-choices"]).toEqual(["91k", "170k"]);
    expect(nested["default-value"]).toBeUndefined();
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
      mutually_exclusive_groups: [{ required: false, actions: ["input_file", "no_input"] }],
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

  it("emits a populated descriptor for store-action variants in a mutex group", () => {
    // Regression: when the mutex code synthesized seq.meta.name from `dest`
    // (underscored), it diverged from the path terminal's name (hyphenated,
    // from preferredName), so findStructNode could not match the binding and
    // the variant emitted empty (just name+id, no command-line/inputs).
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
      mutually_exclusive_groups: [{ required: false, actions: ["input_file", "no_input"] }],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const parent = inputs.find((i) => i.id === "input_file_or_no_input");
    expect(parent).toBeDefined();
    const variants = parent!.type as Record<string, unknown>[];
    const storeVariant = variants.find((v) => v.id === "input_file");
    expect(storeVariant).toBeDefined();
    expect(storeVariant!["command-line"]).toBe("--input-file [INPUT_FILE]");
    const subInputs = storeVariant!.inputs as Record<string, unknown>[];
    expect(subInputs).toHaveLength(1);
    expect(subInputs[0]?.id).toBe("input_file");
    expect(subInputs[0]?.type).toBe("File");
  });

  it("uses meta.name for literal alternatives (e.g. mutex store_false dest)", () => {
    // Regression: solver always stripped the literal value (`--fs-no-reconall`
    // -> `fs-no-reconall`) and ignored alt.meta.name set by the mutex code,
    // which caused value-key collisions when the dest differed from the flag.
    const bt = emitFromArgdump({
      prog: "petprep",
      actions: [
        {
          option_strings: ["--fs-subjects-dir"],
          dest: "fs_subjects_dir",
          action_type: "store",
          type_info: { name: "Path", module: "pathlib" },
        },
        {
          option_strings: ["--fs-no-reconall"],
          dest: "run_reconall",
          action_type: "store_false",
        },
      ],
      mutually_exclusive_groups: [
        { required: false, actions: ["fs_subjects_dir", "run_reconall"] },
      ],
    });
    const inputs = bt.inputs as Record<string, unknown>[];
    const parent = inputs.find((i) => i.id === "fs_subjects_dir_or_run_reconall");
    expect(parent).toBeDefined();
    const variants = parent!.type as Record<string, unknown>[];
    // The literal variant should use the dest from meta.name, not the
    // stripped-flag fallback.
    const variantIds = variants.map((v) => v.id).sort();
    expect(variantIds).toEqual(["fs_subjects_dir", "run_reconall"]);
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

describe("Boutiques output-files emission", () => {
  it("emits a literal-only output-files entry at the root", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
        "output-files": [{ id: "log", "path-template": "run.log" }],
      }),
    );
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("log");
    expect(files[0]!["path-template"]).toBe("run.log");
    expect(files[0]!.optional).toBeUndefined();
  });

  it("emits an output that references an input via value-key", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT_FILE]",
        inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
        "output-files": [{ id: "out", "path-template": "[INPUT_FILE].out" }],
      }),
    );
    const inputs = bt.inputs as Record<string, unknown>[];
    const inputKey = inputs[0]!["value-key"] as string;
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files[0]!["path-template"]).toBe(`${inputKey}.out`);
  });

  it("marks the output optional when the referenced input is optional", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT_FILE]",
        inputs: [
          {
            id: "input_file",
            name: "In",
            type: "File",
            "value-key": "[INPUT_FILE]",
            optional: true,
          },
        ],
        "output-files": [{ id: "out", "path-template": "[INPUT_FILE].out" }],
      }),
    );
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files[0]!.optional).toBe(true);
  });

  it("propagates path-template-stripped-extensions", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT_FILE]",
        inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
        "output-files": [
          {
            id: "out",
            "path-template": "[INPUT_FILE].out",
            "path-template-stripped-extensions": [".nii", ".nii.gz"],
          },
        ],
      }),
    );
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files[0]!["path-template-stripped-extensions"]).toEqual([".nii", ".nii.gz"]);
  });

  it("preserves output name and description", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT_FILE]",
        inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
        "output-files": [
          {
            id: "out",
            name: "Output file",
            description: "The output of the tool",
            "path-template": "[INPUT_FILE].out",
          },
        ],
      }),
    );
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files[0]!.name).toBe("Output file");
    expect(files[0]!.description).toBe("The output of the tool");
  });

  it("does not emit `optional: true` when no ref is gated (the source hint is dropped)", () => {
    // The Boutiques source `optional: true` is a tool-author hint we re-derive
    // structurally - so an output whose refs all point to required inputs
    // emits without the flag, regardless of the hint.
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT_FILE]",
        inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
        "output-files": [{ id: "maybe", "path-template": "[INPUT_FILE].extra", optional: true }],
      }),
    );
    const files = bt["output-files"] as Record<string, unknown>[];
    expect(files[0]!.optional).toBeUndefined();
  });

  it("emits an output hosted inside a subcommand arm on that arm's descriptor", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [SUBCMD]",
        inputs: [
          {
            id: "subcmd",
            "value-key": "[SUBCMD]",
            type: [
              {
                id: "convert",
                "command-line": "convert [SRC]",
                inputs: [{ id: "src", "value-key": "[SRC]", type: "File" }],
                "output-files": [{ id: "converted", "path-template": "[SRC].conv" }],
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
    expect(bt["output-files"]).toBeUndefined();
    const inputs = bt.inputs as Record<string, unknown>[];
    const subType = inputs[0]!.type as Record<string, unknown>[];
    const convert = subType.find((d) => d.id === "convert")!;
    const convertFiles = convert["output-files"] as Record<string, unknown>[];
    expect(convertFiles).toHaveLength(1);
    expect(convertFiles[0]!.id).toBe("converted");
    // path-template uses the arm's locally-scoped value-key for SRC
    const convertInputs = convert.inputs as Record<string, unknown>[];
    const srcKey = convertInputs[0]!["value-key"] as string;
    expect(convertFiles[0]!["path-template"]).toBe(`${srcKey}.conv`);
    const inspectFiles = subType.find((d) => d.id === "inspect")!["output-files"];
    expect(inspectFiles).toBeUndefined();
  });

  it("emits no output-files when the descriptor has none", () => {
    const bt = emitFor(
      minimalDescriptor({
        "command-line": "tool [INPUT1]",
        inputs: [minimalInput({ type: "String" })],
      }),
    );
    expect(bt["output-files"]).toBeUndefined();
  });
});

describe("Boutiques output-files round-trip", () => {
  it("re-parses to an equivalent IR shape after emit", () => {
    const descriptor = {
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [{ id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]" }],
      "output-files": [
        {
          id: "out",
          name: "Output",
          description: "The output",
          "path-template": "[INPUT_FILE].out",
          "path-template-stripped-extensions": [".nii"],
        },
      ],
    };
    const emitted = roundTrip(descriptor);
    const reFiles = (emitted["output-files"] as Record<string, unknown>[])[0]!;
    expect(reFiles.id).toBe("out");
    expect(reFiles.name).toBe("Output");
    expect(reFiles.description).toBe("The output");
    expect(reFiles["path-template-stripped-extensions"]).toEqual([".nii"]);
    // path-template references the emitted input's value-key
    const emittedInputs = emitted.inputs as Record<string, unknown>[];
    const inputKey = emittedInputs[0]!["value-key"] as string;
    expect(reFiles["path-template"]).toBe(`${inputKey}.out`);
  });

  it("round-trips an output optional flag derived from an optional ref", () => {
    // The optional input drives the structural optionality of the output.
    const descriptor = {
      name: "tool",
      "command-line": "tool [INPUT_FILE]",
      inputs: [
        { id: "input_file", name: "In", type: "File", "value-key": "[INPUT_FILE]", optional: true },
      ],
      "output-files": [{ id: "maybe", "path-template": "[INPUT_FILE].extra" }],
    };
    const emitted = roundTrip(descriptor);
    const files = emitted["output-files"] as Record<string, unknown>[];
    expect(files[0]!.optional).toBe(true);
  });

  it("round-trips a subcommand-scoped output", () => {
    const descriptor = {
      name: "tool",
      "command-line": "tool [SUBCMD]",
      inputs: [
        {
          id: "subcmd",
          "value-key": "[SUBCMD]",
          type: [
            {
              id: "convert",
              "command-line": "convert [SRC]",
              inputs: [{ id: "src", "value-key": "[SRC]", type: "File" }],
              "output-files": [{ id: "converted", "path-template": "[SRC].conv" }],
            },
            {
              id: "inspect",
              "command-line": "inspect [TARGET]",
              inputs: [{ id: "target", "value-key": "[TARGET]", type: "File" }],
            },
          ],
        },
      ],
    };
    const emitted = roundTrip(descriptor);
    const subType = (emitted.inputs as Record<string, unknown>[])[0]!.type as Record<
      string,
      unknown
    >[];
    const convert = subType.find((d) => d.id === "convert")!;
    const files = convert["output-files"] as Record<string, unknown>[];
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("converted");
    // path-template references the arm's own input
    const convertInputs = convert.inputs as Record<string, unknown>[];
    const srcKey = convertInputs[0]!["value-key"] as string;
    expect(files[0]!["path-template"]).toBe(`${srcKey}.conv`);
    // the inspect arm has no outputs
    const inspect = subType.find((d) => d.id === "inspect")!;
    expect(inspect["output-files"]).toBeUndefined();
  });
});
