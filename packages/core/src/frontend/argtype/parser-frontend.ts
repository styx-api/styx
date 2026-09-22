import type { Sequence } from "../../ir/node.js";
import type { Frontend, ParseError, ParseResult, ParseWarning } from "../frontend.js";
import {
  inlineAliases,
  parseArgtype,
  resolveAnnotations,
  resolveMediaTypes,
  resolveOutputs,
  resolvePaths,
} from "@argtype/core";
import type { Diagnostic } from "@argtype/core";
import { lowerDocument } from "./lower.js";

/** A fresh empty root sequence for error returns (IR passes mutate in place). */
function emptyExpr(): Sequence {
  return { kind: "sequence", attrs: { nodes: [] } };
}

// Extensions Styx implements are the ones imported above. `constraints` is
// deliberately absent because the IR cannot express inter-argument rules;
// `lower.ts` reports any annotation no imported module claims rather than
// dropping it silently.

/**
 * Frontend for the argtype DSL - the hand-authored, TypeScript-types-like
 * language for describing CLI argument grammars (see the argtype spec).
 *
 * The language itself lives in `@argtype/core`, its consumer-neutral reference
 * implementation, and this frontend runs its three stages then lowers to IR:
 *
 * 1. `parseArgtype` - source to a faithful AST (no interpretation).
 * 2. `inlineAliases` - substitute alias references, since a generator wants one
 *    flat grammar. It also makes the resolver's target checks reach alias use
 *    sites, which they cannot do while a `ref`'s concrete kind is unknown.
 * 3. `resolveAnnotations` - give the core decorations their typed meaning,
 *    then one pass per extension Styx implements (`outputs`, `mediatypes`,
 *    `paths`); `constraints` is deliberately skipped.
 * 4. `lower.ts` - the generator-specific narrowing: `set` becomes a sequence,
 *    `any` becomes its first branch, outputs attach to their enclosing scope.
 *
 * Step 4 is the only part that is Styx's alone. Its choices are lossless when
 * emitting a single invocation and wrong for a validator or a runner, which is
 * why they stay here rather than upstream.
 */
export class ArgtypeParser implements Frontend {
  readonly name = "argtype";
  readonly extensions = ["argtype"];

  parse(source: string, _filename?: string): ParseResult {
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];
    const toLocation = (d: { line?: number; column?: number }) =>
      d.line !== undefined ? { location: { line: d.line, column: d.column } } : {};
    // One list in, split by severity here - the package stamps every diagnostic
    // with a severity, so this no longer has to be decided per call site.
    const collect = (from: Diagnostic[]): void => {
      for (const d of from) {
        const entry = { message: d.message, ...toLocation(d) };
        switch (d.severity) {
          case "error":
            errors.push(entry);
            break;
          case "warning":
            warnings.push(entry);
            break;
          default:
            // A severity this version of Styx does not know about. `severity` is
            // a closed union today, so this is unreachable - but treating the
            // fallback as "error" would turn a purely additive upstream level
            // (an advisory `info`/`hint`) into a hard compile failure, and
            // errors fail the whole build downstream. Degrade to a warning: an
            // unrecognized diagnostic is still worth surfacing, and surfacing it
            // must not be more severe than what it actually reports.
            warnings.push(entry);
            break;
        }
      }
    };

    const parsed = parseArgtype(source);
    collect(parsed.diagnostics);
    if (!parsed.ok) return { expr: emptyExpr(), errors, warnings };

    const inlined = inlineAliases(parsed.doc);
    collect(inlined.diagnostics);

    const resolved = resolveAnnotations(inlined.doc);
    collect(resolved.diagnostics);

    // Each extension is a separate opt-in pass over the resolved tree. Their
    // results are keyed by node rather than folded into it, so a node carries
    // only what the language core defines.
    const outputs = resolveOutputs(resolved.doc);
    const mediaTypes = resolveMediaTypes(resolved.doc);
    const paths = resolvePaths(resolved.doc);
    for (const ext of [outputs, mediaTypes, paths]) collect(ext.diagnostics);

    const lowered = lowerDocument(resolved.doc, {
      outputs: outputs.outputs,
      mediaTypes: mediaTypes.mediaTypes,
      paths: paths.paths,
    });
    for (const d of lowered.errors) errors.push({ message: d.message, ...toLocation(d) });
    for (const d of lowered.warnings) warnings.push({ message: d.message, ...toLocation(d) });

    return {
      ...(lowered.meta && { meta: lowered.meta }),
      expr: lowered.expr,
      errors,
      warnings,
    };
  }
}
