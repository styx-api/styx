import type { CodegenContext } from "../../manifest/index.js";
import type { Backend, EmittedApp, EmitWarning } from "../backend.js";
import type { Scope } from "../scope.js";
import { appModuleName, generatePython } from "../python/index.js";
import { pascalCase } from "../string-case.js";
import { buildTypedSpec } from "../typed-spec.js";
import { emitPydraTask, type PydraNames } from "./emit.js";

/** Derive the per-tool pydra module/class names. */
export function pydraNames(ctx: CodegenContext): PydraNames {
  const mod = appModuleName(ctx.app);
  const rawId = ctx.app?.id ?? "tool";
  // Mirror the Python backend's digit-leading-id prescrub so the task class name
  // is a valid Python identifier (e.g. `3dPFM` -> `V3DPfm`).
  const safeId = /^[0-9]/.test(rawId) ? "v_" + rawId : rawId;
  return {
    styxStem: `_${mod}`,
    ifaceStem: mod,
    cls: pascalCase(safeId),
  };
}

/** Generate the pydra task module source for one tool. */
export function generatePydra(ctx: CodegenContext): string {
  return emitPydraTask(ctx, buildTypedSpec(ctx), pydraNames(ctx));
}

/**
 * Emits pydra tasks (`@python.define`, the post-rewrite pydra.compose API) whose
 * typed inputs/outputs carry rich constraints (numeric ranges and list bounds via
 * attrs validators, enum choices, file types, defaults) and which delegate
 * execution to the styx Python wrapper (Option B): no command-line arg-building
 * or output-path resolution is re-implemented here.
 *
 * Per tool, two co-located files are emitted so the output is a self-contained,
 * importable Python package: `_<tool>.py` (the styx Python module) and
 * `<tool>.py` (the task, importing the wrapper via a relative import).
 */
export class PydraBackend implements Backend {
  readonly name = "pydra";
  readonly target = "pydra";

  // `scope` is intentionally unused: each tool is emitted as its own module, so
  // per-tool fresh scoping keeps the styx module's kwarg names and the typed
  // spec's host names identical by construction (see NipypeBackend).
  emitApp(ctx: CodegenContext, _scope?: Scope): EmittedApp {
    const names = pydraNames(ctx);
    const spec = buildTypedSpec(ctx);
    const warnings: EmitWarning[] = [];
    if (!spec.rootIsStruct) {
      warnings.push({
        message: `pydra: '${ctx.app?.id ?? "?"}' has a non-struct root; emitted task has no typed inputs and raises on run.`,
      });
    }
    const styxCode = generatePython(ctx);
    const taskCode = emitPydraTask(ctx, spec, names);
    return {
      meta: ctx.app,
      files: new Map([
        [`${names.styxStem}.py`, styxCode],
        [`${names.ifaceStem}.py`, taskCode],
      ]),
      errors: [],
      warnings,
    };
  }
}
