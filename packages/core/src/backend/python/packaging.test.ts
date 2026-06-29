import type { PackageMeta, ProjectMeta } from "../../manifest/index.js";
import type { EmittedPackage } from "../backend.js";
import { describe, expect, it } from "vitest";
import { PythonBackend } from "./python.js";

const emptyPkg = (meta: PackageMeta): EmittedPackage => ({
  meta,
  files: new Map(),
  errors: [],
  warnings: [],
});

const proj: ProjectMeta = {
  name: "niwrap",
  version: "1.2.3",
  doc: { title: "NiWrap", description: "Neuroimaging wrappers." },
  license: { description: "MIT" },
};

const packages: EmittedPackage[] = [
  // fsl carries its own (tool) version to prove the sub-package pyproject ignores
  // it in favor of the project version - the wrapper ships on the project's release.
  emptyPkg({
    name: "fsl",
    version: "6.0.4",
    doc: { title: "FSL", urls: ["https://fsl.fmrib.ox.ac.uk"] },
  }),
  emptyPkg({ name: "ants" }),
];

describe("Python emitPackage packaging", () => {
  it("emits an empty py.typed marker alongside __init__.py", () => {
    const out = new PythonBackend().emitPackage({ name: "fsl" }, []);
    expect(out.files.has("__init__.py")).toBe(true);
    expect(out.files.get("py.typed")).toBe("");
  });
});

describe("Python emitProject packaging", () => {
  const out = new PythonBackend().emitProject(proj, packages);

  it("emits per-suite pyproject.toml with the styxdefs floor", () => {
    const sub = out.files.get("fsl/pyproject.toml");
    expect(sub).toBeDefined();
    expect(sub).toContain('name = "niwrap_fsl"');
    expect(sub).toContain('"styxdefs>=0.7.0,<0.8.0",');
    // The project (catalog) version, not fsl's own tool version (6.0.4).
    expect(sub).toContain('version = "1.2.3"');
    expect(sub).not.toContain('version = "6.0.4"');
    // Flat suite dir mapped onto the dotted `<project>.<suite>` import package so
    // it nests under the metapackage namespace (`from niwrap import fsl`).
    expect(sub).toContain('packages = ["niwrap.fsl"]');
    expect(sub).toContain('package-dir = { "niwrap.fsl" = "." }');
    expect(sub).toContain('"niwrap.fsl" = ["py.typed"]');
    expect(sub).toContain("setuptools.build_meta");
  });

  it("emits a per-suite README crediting the upstream tool", () => {
    const readme = out.files.get("fsl/README.md");
    expect(readme).toContain("# NiWrap wrappers for [FSL](https://fsl.fmrib.ox.ac.uk)");
    expect(readme).toContain("no affiliation with the original authors");
  });

  it("emits a root pyproject depending on styxkit and sub-distributions", () => {
    const root = out.files.get("pyproject.toml");
    expect(root).toBeDefined();
    expect(root).toContain('name = "niwrap"');
    // The runner stack now arrives via styxkit[all], not three separate deps.
    expect(root).toContain('"styxkit[all]",');
    expect(root).not.toContain('"styxdocker",');
    expect(root).toContain('"niwrap_fsl",');
    expect(root).toContain('"niwrap_ants",');
    // Metapackage now ships its own importable module (the styxkit re-export),
    // the `niwrap/` namespace the suites nest into. No package-dir remap needed
    // when the module name matches its source directory (the common case).
    expect(root).toContain('packages = ["niwrap"]');
    expect(root).toContain('"niwrap" = ["py.typed"]');
    expect(root).not.toContain("package-dir");
  });

  it("emits a root __init__ re-exporting styxkit, plus a py.typed marker", () => {
    expect(out.files.get("niwrap/__init__.py")).toContain("from styxkit import *");
    expect(out.files.get("niwrap/py.typed")).toBe("");
  });

  it("emits a requirements.txt for local installs (suites then root)", () => {
    expect(out.files.get("requirements.txt")).toBe("./fsl\n./ants\n./\n");
  });

  it("emits a root README", () => {
    const readme = out.files.get("README.md");
    expect(readme).toContain("# NiWrap");
    expect(readme).toContain("- niwrap_fsl");
    expect(readme).toContain("- niwrap_ants");
  });
});

describe("Python packaging without project metadata", () => {
  it("falls back to the bare package name as the distribution and import name", () => {
    const out = new PythonBackend().emitProject({}, [emptyPkg({ name: "fsl" })]);
    const sub = out.files.get("fsl/pyproject.toml");
    expect(sub).toContain('name = "fsl"');
    // No project name => no namespace to nest under => top-level `fsl` import.
    expect(sub).toContain('packages = ["fsl"]');
    expect(sub).toContain('package-dir = { "fsl" = "." }');
  });

  it("covers a nameless package under the 'package' fallback dir", () => {
    const out = new PythonBackend().emitProject(proj, [emptyPkg({})]);
    expect(out.files.has("package/pyproject.toml")).toBe(true);
    expect(out.files.get("requirements.txt")).toContain("./package");
  });
});

describe("Python metapackage module naming", () => {
  it("scrubs a project name that is a Python keyword into an importable module", () => {
    const out = new PythonBackend().emitProject({ name: "import" }, [emptyPkg({ name: "fsl" })]);
    // `import import` is a SyntaxError, so the reserved word must be dodged.
    expect(out.files.has("import_/__init__.py")).toBe(true);
    expect(out.files.get("pyproject.toml")).toContain('packages = ["import_"]');
    // Suites nest under the scrubbed namespace, not the raw keyword.
    expect(out.files.get("fsl/pyproject.toml")).toContain('packages = ["import_.fsl"]');
  });

  it("dodges the metapackage source dir when a suite is named after the project", () => {
    const out = new PythonBackend().emitProject({ name: "fsl" }, [emptyPkg({ name: "fsl" })]);
    // Both want `fsl/` on disk: the suite's wrapper module and the metapackage's
    // styxkit re-export. The metapackage source dir dodges to `fsl_/`...
    expect(out.files.has("fsl_/__init__.py")).toBe(true);
    expect(out.files.has("fsl/__init__.py")).toBe(false);
    // ...but its import name stays `fsl` (via a package-dir remap) so it still
    // shares the `fsl/` namespace the suite nests into at install time.
    const root = out.files.get("pyproject.toml")!;
    expect(root).toContain('packages = ["fsl"]');
    expect(root).toContain('package-dir = { "fsl" = "fsl_" }');
    expect(out.files.get("fsl/pyproject.toml")).toContain('packages = ["fsl.fsl"]');
    expect(out.warnings.some((w) => w.message.includes("collides"))).toBe(true);
  });
});

describe("Python packaging TOML safety", () => {
  it("escapes quotes and strips control chars in emitted strings", () => {
    const out = new PythonBackend().emitProject(
      {
        name: "proj",
        doc: { description: 'a "q" b' + String.fromCharCode(0) + "cd" + String.fromCharCode(12) },
      },
      [emptyPkg({ name: "fsl" })],
    );
    const root = out.files.get("pyproject.toml")!;
    // Quotes escaped; the NUL and form-feed control chars stripped.
    expect(root).toContain('description = "a \\"q\\" bcd"');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(root)).toBe(false);
  });

  it("emits each author as its own table", () => {
    const out = new PythonBackend().emitProject(
      { name: "proj", doc: { authors: ["Ada Lovelace", "Alan Turing"] } },
      [],
    );
    const root = out.files.get("pyproject.toml")!;
    expect(root).toContain('authors = [{ name = "Ada Lovelace" }, { name = "Alan Turing" }]');
  });
});

describe("Python summary clamping (PyPI 512-char Summary limit)", () => {
  const summaryOf = (toml: string): string => {
    const cap = toml.match(/^description = "(.*)"$/m)?.[1];
    if (cap === undefined) throw new Error("no description line");
    return cap;
  };

  it("clamps a long multi-sentence description to a complete sentence <= 512 chars", () => {
    const longDesc = "This sentence is a reasonably sized clause of prose. ".repeat(20); // ~1040 chars
    const out = new PythonBackend().emitProject({ name: "proj", version: "1.0.0" }, [
      emptyPkg({ name: "tool", doc: { description: longDesc } }),
    ]);
    const summary = summaryOf(out.files.get("tool/pyproject.toml")!);
    expect(summary.length).toBeLessThanOrEqual(512);
    // Cut on a sentence boundary - ends with a period, no dangling fragment.
    expect(summary.endsWith(".")).toBe(true);
    expect(summary.endsWith("...")).toBe(false);
  });

  it("falls back to a word boundary + ellipsis when no sentence boundary fits", () => {
    const runOn = "alpha bravo charlie delta ".repeat(40); // >512, spaces but no '. '
    const out = new PythonBackend().emitProject({ name: "proj", version: "1.0.0" }, [
      emptyPkg({ name: "tool", doc: { description: runOn } }),
    ]);
    const summary = summaryOf(out.files.get("tool/pyproject.toml")!);
    expect(summary.length).toBeLessThanOrEqual(512);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("leaves a short description untouched", () => {
    const out = new PythonBackend().emitProject({ name: "proj", version: "1.0.0" }, [
      emptyPkg({ name: "tool", doc: { description: "Short and sweet." } }),
    ]);
    expect(summaryOf(out.files.get("tool/pyproject.toml")!)).toBe("Short and sweet.");
  });
});
