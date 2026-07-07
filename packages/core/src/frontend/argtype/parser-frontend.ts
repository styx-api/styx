import type { Sequence } from "../../ir/node.js";
import type { Frontend, ParseError, ParseResult, ParseWarning } from "../frontend.js";
import { parseArgtype } from "./parser.js";
import { lowerDocument } from "./lower.js";

/** A fresh empty root sequence for error returns (IR passes mutate in place). */
function emptyExpr(): Sequence {
  return { kind: "sequence", attrs: { nodes: [] } };
}

/**
 * Frontend for the argtype sugar DSL - the hand-authored, TypeScript-types-like
 * language for describing CLI argument grammars (see the argtype spec). Parses
 * the text into an AST, then lowers it to Styx IR + AppMeta.
 *
 * Supported today: the argtype core (combinators, terminals, literals, naming,
 * aliases, value constraints, `.join`/`.count`/`.default`, doc comments,
 * frontmatter) plus the `outputs`, `mediatypes`, and `paths` extensions. `set`
 * lowers to a sequence and `any` to its first branch; the `constraints`
 * extension is parsed-and-ignored.
 */
export class ArgtypeParser implements Frontend {
  readonly name = "argtype";
  readonly extensions = ["argtype"];

  parse(source: string, _filename?: string): ParseResult {
    const { doc, errors: parseErrors, warnings: parseWarnings } = parseArgtype(source);
    const toLocation = (e: { line?: number; column?: number }) =>
      e.line !== undefined ? { location: { line: e.line, column: e.column } } : {};
    const errors: ParseError[] = parseErrors.map((e) => ({ message: e.message, ...toLocation(e) }));
    const warnings: ParseWarning[] = parseWarnings.map((e) => ({
      message: e.message,
      ...toLocation(e),
    }));

    if (!doc) {
      return { expr: emptyExpr(), errors, warnings };
    }

    const lowered = lowerDocument(doc);
    warnings.push(...lowered.warnings.map((message) => ({ message })));
    errors.push(...lowered.errors.map((message) => ({ message })));

    return {
      ...(lowered.meta && { meta: lowered.meta }),
      expr: lowered.expr,
      errors,
      warnings,
    };
  }
}
