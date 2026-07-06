import type { CodegenContext } from "../../manifest/index.js";
import type { Backend, EmittedApp } from "../backend.js";
import { Scope } from "../scope.js";
import { snakeCase } from "../string-case.js";
import { generateArgtype } from "./emit.js";

/**
 * A per-tool file stem, so co-located tools in a catalog build don't clobber one
 * another's `descriptor.argtype`. Standalone single-tool builds (no scope) keep
 * the bare name. Mirrors the JSON Schema backend's `schemaStem`.
 */
function argtypeStem(ctx: CodegenContext, scope?: Scope): string | undefined {
  const id = ctx.app?.id;
  if (!id || !scope) return undefined;
  return scope.add(snakeCase(id) || "descriptor");
}

/**
 * Serialization backend: emit argtype sugar-DSL source from the IR + `AppMeta`.
 *
 * The dogfooding / round-trip counterpart to the argtype frontend. Like the
 * Boutiques backend it only needs the IR (`ctx.expr`) and app metadata
 * (`ctx.app`), never the solved bindings, so it ignores the rest of the context.
 */
export class ArgtypeBackend implements Backend {
  readonly name = "argtype";
  readonly target = "argtype";

  /** One scope per package so per-tool file stems stay unique in the suite dir. */
  newPackageScope(): Scope {
    return new Scope();
  }

  emitApp(ctx: CodegenContext, scope?: Scope): EmittedApp {
    const { source, warnings } = generateArgtype(ctx.expr, ctx.app);
    const stem = argtypeStem(ctx, scope);
    const filename = stem ? `${stem}.argtype` : "descriptor.argtype";
    return {
      meta: ctx.app,
      files: new Map([[filename, source]]),
      errors: [],
      warnings,
    };
  }
}
