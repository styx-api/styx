/**
 * Runtime version floors baked into generated dependency metadata.
 *
 * styx2-generated code calls `mutable_copy` / `mutableCopy` (introduced in the
 * styxdefs 0.7.0 / styxdefs-js 0.2.0 release), so emitted packages genuinely
 * require that runtime floor. This is the single source of truth: bump here and
 * both the Python and TypeScript backends pick it up.
 */
export const STYXDEFS_COMPAT = {
  /** PEP 508 specifier for the Python `styxdefs` package. */
  python: ">=0.7.0,<0.8.0",
  /** npm semver range for the `styxdefs` package. */
  npm: "^0.2.0",
} as const;

/**
 * Extra Python runtime packages the root metapackage pulls in. `styxkit[all]`
 * provides the cross-backend runner-selection helpers (`use_docker`, `use_auto`,
 * ...) that the metapackage's `__init__` re-exports, and transitively installs
 * every container/graph runner backend. Left unpinned - styxkit's own styxdefs
 * floor constrains the stack.
 */
export const PYTHON_RUNNER_DEPS = ["styxkit[all]"] as const;
