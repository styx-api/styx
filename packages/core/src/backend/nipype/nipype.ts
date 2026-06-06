import type { CodegenContext } from "../../manifest/index.js";
import type { Backend, EmittedApp, EmitWarning } from "../backend.js";
import type { Scope } from "../scope.js";
import { appModuleName, generatePython } from "../python/index.js";
import { pascalCase } from "../string-case.js";
import { buildTypedSpec } from "../typed-spec.js";
import { emitNipypeInterface, type NipypeNames } from "./emit.js";

/** Derive the per-tool nipype module/class names. */
export function nipypeNames(ctx: CodegenContext): NipypeNames {
  const mod = appModuleName(ctx.app);
  const rawId = ctx.app?.id ?? "tool";
  // Mirror the Python backend's digit-leading-id prescrub so the derived class
  // name is a valid Python identifier (e.g. `3dPFM` -> `V3DPfm`).
  const safeId = /^[0-9]/.test(rawId) ? "v_" + rawId : rawId;
  const cls = pascalCase(safeId);
  return {
    styxStem: `_${mod}`,
    ifaceStem: mod,
    cls,
    inputSpec: `${cls}InputSpec`,
    outputSpec: `${cls}OutputSpec`,
  };
}

/** Generate the nipype interface module source for one tool. */
export function generateNipype(ctx: CodegenContext): string {
  return emitNipypeInterface(ctx, buildTypedSpec(ctx), nipypeNames(ctx));
}

/**
 * Emits nipype `Interface` definitions whose typed InputSpec/OutputSpec carry
 * rich constraints (numeric ranges, list bounds, enum choices, file types) and
 * which delegate execution to the styx Python wrapper (Option B): no command-line
 * arg-building or output-path resolution is re-implemented here.
 *
 * Per tool, two co-located files are emitted so the output is a self-contained,
 * importable Python package: `_<tool>.py` (the styx Python module) and
 * `<tool>.py` (the interface, importing the wrapper via a relative import).
 */
export class NipypeBackend implements Backend {
  readonly name = "nipype";
  readonly target = "nipype";

  // `scope` is intentionally unused: each tool is emitted as its own module
  // (no flat re-export barrel), so per-tool fresh scoping keeps the styx module's
  // kwarg names and the typed spec's host names identical by construction.
  // Suite-level shared scoping is a follow-up alongside emitPackage/emitProject.
  emitApp(ctx: CodegenContext, _scope?: Scope): EmittedApp {
    const names = nipypeNames(ctx);
    const spec = buildTypedSpec(ctx);
    const warnings: EmitWarning[] = [];
    if (!spec.rootIsStruct) {
      warnings.push({
        message: `nipype: '${ctx.app?.id ?? "?"}' has a non-struct root; emitted interface has no typed inputs and raises on run.`,
      });
    }
    const styxCode = generatePython(ctx);
    const ifaceCode = emitNipypeInterface(ctx, spec, names);
    return {
      meta: ctx.app,
      files: new Map([
        [`${names.styxStem}.py`, styxCode],
        [`${names.ifaceStem}.py`, ifaceCode],
      ]),
      errors: [],
      warnings,
    };
  }
}
