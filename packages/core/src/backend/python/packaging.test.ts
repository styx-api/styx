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
    // Flat layout: the suite directory is the importable package.
    expect(sub).toContain('packages = ["fsl"]');
    expect(sub).toContain('package-dir = { "fsl" = "." }');
    expect(sub).toContain('"fsl" = ["py.typed"]');
    expect(sub).toContain("setuptools.build_meta");
  });

  it("emits a per-suite README crediting the upstream tool", () => {
    const readme = out.files.get("fsl/README.md");
    expect(readme).toContain("# NiWrap wrappers for [FSL](https://fsl.fmrib.ox.ac.uk)");
    expect(readme).toContain("no affiliation with the original authors");
  });

  it("emits a root pyproject depending on runners and sub-distributions", () => {
    const root = out.files.get("pyproject.toml");
    expect(root).toBeDefined();
    expect(root).toContain('name = "niwrap"');
    expect(root).toContain('"styxdocker",');
    expect(root).toContain('"styxsingularity",');
    expect(root).toContain('"styxgraph",');
    expect(root).toContain('"niwrap_fsl",');
    expect(root).toContain('"niwrap_ants",');
    // Metapackage owns no modules of its own.
    expect(root).toContain("packages = []");
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
  it("falls back to the bare package name as the distribution name", () => {
    const out = new PythonBackend().emitProject({}, [emptyPkg({ name: "fsl" })]);
    const sub = out.files.get("fsl/pyproject.toml");
    expect(sub).toContain('name = "fsl"');
  });

  it("covers a nameless package under the 'package' fallback dir", () => {
    const out = new PythonBackend().emitProject(proj, [emptyPkg({})]);
    expect(out.files.has("package/pyproject.toml")).toBe(true);
    expect(out.files.get("requirements.txt")).toContain("./package");
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
