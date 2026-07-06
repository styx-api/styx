/**
 * Parse an output template literal body (the text between backticks) into
 * `AstOutputToken[]`. Literal runs become literal tokens; `{...}` interpolations
 * become ref tokens carrying any reference operations (`strip_suffix`,
 * `strip_prefix`, `basename`, `or`).
 *
 * `{}` (empty braces) is a self-reference: the value of the node the output is
 * attached to. Lowering resolves it to that node's name.
 */

import type { AstOutputToken } from "./ast.js";

export interface TemplateParseResult {
  tokens: AstOutputToken[];
  errors: string[];
}

export function parseTemplate(body: string): TemplateParseResult {
  const tokens: AstOutputToken[] = [];
  const errors: string[] = [];
  let lit = "";
  let i = 0;

  const flushLit = (): void => {
    if (lit.length > 0) {
      tokens.push({ kind: "literal", value: lit });
      lit = "";
    }
  };

  while (i < body.length) {
    const ch = body[i]!;
    // A backslash escapes the next character: `\{`, `\}`, `` \` ``, `\\` become
    // that literal char (so `{` need not start an interpolation).
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1]!;
      lit += next === "{" || next === "}" || next === "`" || next === "\\" ? next : "\\" + next;
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = body.indexOf("}", i);
      if (close === -1) {
        errors.push("Unterminated '{' in output template");
        lit += body.slice(i);
        break;
      }
      flushLit();
      const inner = body.slice(i + 1, close).trim();
      const { token, error } = parseRef(inner);
      if (error) errors.push(error);
      tokens.push(token);
      i = close + 1;
    } else {
      lit += ch;
      i++;
    }
  }
  flushLit();
  return { tokens, errors };
}

/** Parse the inside of `{...}`: an optional name followed by `.op(arg)` calls.
 * The name is a bare identifier, a double-quoted string (for a non-identifier
 * target name, e.g. `{"4d_output"}`), or absent for a self-reference (`{}`). */
function parseRef(inner: string): { token: AstOutputToken; error?: string } {
  const token: AstOutputToken & { kind: "ref" } = { kind: "ref" };

  let rest = inner;
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(inner);
  if (quoted) {
    // A quoted target name carries an arbitrary (non-identifier) name verbatim,
    // mirroring a quoted `label:`. (A `}` inside the name is not supported: the
    // template scanner ends the interpolation at the first `}`.)
    token.name = unescapeArg(quoted[1]!);
    rest = inner.slice(quoted[0].length);
  } else {
    // Leading identifier (the referenced name).
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(inner);
    if (nameMatch) {
      token.name = nameMatch[0];
      rest = inner.slice(nameMatch[0].length);
    }
  }

  // Method chain: .op("arg") or .op()
  const opRe = /^\.\s*([A-Za-z_]+)\s*\(\s*(?:"((?:[^"\\]|\\.)*)")?\s*\)/;
  let error: string | undefined;
  while (rest.length > 0) {
    const m = opRe.exec(rest);
    if (!m) {
      error = `Unrecognized output-reference operation near '${rest}'`;
      break;
    }
    const op = m[1]!;
    const arg = m[2];
    switch (op) {
      case "strip_suffix":
        if (arg !== undefined) (token.stripSuffix ??= []).push(unescapeArg(arg));
        break;
      case "strip_prefix":
        if (arg !== undefined) (token.stripPrefix ??= []).push(unescapeArg(arg));
        break;
      case "basename":
        token.basename = true;
        break;
      case "or":
        if (arg !== undefined) token.or = unescapeArg(arg);
        break;
      default:
        error = `Unknown output-reference operation '${op}'`;
    }
    rest = rest.slice(m[0].length).trimStart();
  }

  return { token, ...(error && { error }) };
}

function unescapeArg(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}
