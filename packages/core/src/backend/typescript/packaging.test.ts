import type { PackageMeta, ProjectMeta } from "../../manifest/index.js";
import type { EmittedPackage } from "../backend.js";
import { describe, expect, it } from "vitest";
import { TypeScriptBackend } from "./typescript.js";

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

describe("TypeScript emitProject packaging", () => {
  const out = new TypeScriptBackend().emitProject(proj, [
    emptyPkg({ name: "fsl" }),
    emptyPkg({ name: "ants" }),
  ]);

  it("emits package.json with the styxdefs npm floor", () => {
    const pkg = JSON.parse(out.files.get("package.json")!);
    expect(pkg.name).toBe("niwrap");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.dependencies.styxdefs).toBe("^0.2.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.type).toBe("module");
  });

  it("emits a root barrel re-exporting each suite", () => {
    const index = out.files.get("index.ts");
    expect(index).toContain('export * from "./ants/index.js";');
    expect(index).toContain('export * from "./fsl/index.js";');
  });

  it("emits a tsconfig.json targeting dist/", () => {
    const tsconfig = JSON.parse(out.files.get("tsconfig.json")!);
    expect(tsconfig.compilerOptions.outDir).toBe("./dist");
    expect(tsconfig.compilerOptions.declaration).toBe(true);
  });
});

describe("TypeScript packaging without project metadata", () => {
  it("falls back to a default package name", () => {
    const out = new TypeScriptBackend().emitProject({}, []);
    const pkg = JSON.parse(out.files.get("package.json")!);
    expect(pkg.name).toBe("styx-wrappers");
    expect(pkg.dependencies.styxdefs).toBe("^0.2.0");
  });

  it("normalizes an npm-illegal project name", () => {
    const out = new TypeScriptBackend().emitProject({ name: "My Project!" }, []);
    const pkg = JSON.parse(out.files.get("package.json")!);
    expect(pkg.name).toBe("my-project-");
  });
});
