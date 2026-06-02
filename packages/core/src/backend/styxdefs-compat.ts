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
 * Extra Python runtime packages the root distribution pulls in (container +
 * graph runners). Left unpinned - styxdefs's floor constrains them transitively
 * via their own inter-package pins.
 */
export const PYTHON_RUNNER_DEPS = ["styxdocker", "styxsingularity", "styxgraph"] as const;
