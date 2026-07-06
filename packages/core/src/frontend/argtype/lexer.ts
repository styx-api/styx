/**
 * Tokenizer for the argtype sugar DSL.
 *
 * Notable points:
 * - `///` doc comments are significant tokens (they attach to the next node);
 *   `//` line comments are discarded.
 * - Template literals (`` `{ref}.png` ``) are captured whole as a single token;
 *   their internal `{...}` structure is parsed separately by `template.ts`.
 * - Combinator/terminal words (`seq`, `int`, ...) are plain identifiers; the
 *   parser classifies them, so they are not reserved at the lexer level.
 */

export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "template"
  | "doc"
  | "colon"
  | "eq"
  | "pipe"
  | "dot"
  | "comma"
  | "lparen"
  | "rparen"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Raw text: identifier name, unquoted string body, number text, doc text, or template body. */
  value: string;
  line: number;
  column: number;
}

export interface LexError {
  message: string;
  line: number;
  column: number;
}

export interface LexResult {
  tokens: Token[];
  errors: LexError[];
}

const PUNCT: Record<string, TokenKind> = {
  ":": "colon",
  "=": "eq",
  "|": "pipe",
  ".": "dot",
  ",": "comma",
  "(": "lparen",
  ")": "rparen",
};

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const peek = (o = 0): string => source[i + o] ?? "";
  const advance = (): string => {
    const ch = source[i++]!;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };
  const push = (kind: TokenKind, value: string, l: number, c: number): void => {
    tokens.push({ kind, value, line: l, column: c });
  };

  while (i < source.length) {
    const ch = peek();
    const startLine = line;
    const startCol = col;

    // Whitespace (incl. CR for Windows line endings).
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    // Comments: `///` doc (kept) vs `//` line (dropped).
    if (ch === "/" && peek(1) === "/") {
      const isDoc = peek(2) === "/";
      // Consume the slashes.
      advance();
      advance();
      if (isDoc) advance();
      let text = "";
      while (i < source.length && peek() !== "\n") text += advance();
      if (isDoc) push("doc", text.trim(), startLine, startCol);
      continue;
    }

    // Double-quoted string literal.
    if (ch === '"') {
      advance();
      let str = "";
      let closed = false;
      while (i < source.length) {
        const c = advance();
        if (c === "\\") {
          const esc = i < source.length ? advance() : "";
          str += unescape(esc);
        } else if (c === '"') {
          closed = true;
          break;
        } else if (c === "\n") {
          break;
        } else {
          str += c;
        }
      }
      if (!closed)
        errors.push({ message: "Unterminated string literal", line: startLine, column: startCol });
      push("string", str, startLine, startCol);
      continue;
    }

    // Template literal: capture the raw body between backticks. A backslash
    // escapes the next character (kept raw here, unescaped by `template.ts`), so
    // an escaped backtick does not close the template.
    if (ch === "`") {
      advance();
      let body = "";
      let closed = false;
      while (i < source.length) {
        const c = advance();
        if (c === "\\") {
          body += c;
          if (i < source.length) body += advance();
          continue;
        }
        if (c === "`") {
          closed = true;
          break;
        }
        body += c;
      }
      if (!closed)
        errors.push({
          message: "Unterminated template literal",
          line: startLine,
          column: startCol,
        });
      push("template", body, startLine, startCol);
      continue;
    }

    // Number: optional leading `-`, digits, optional fractional part, optional
    // exponent (e.g. `1e-05`, `2.2e-308` - tool value bounds use these).
    if (isDigit(ch) || (ch === "-" && isDigit(peek(1)))) {
      let num = advance(); // first char (digit or '-')
      while (i < source.length && isDigit(peek())) num += advance();
      if (peek() === "." && isDigit(peek(1))) {
        num += advance(); // '.'
        while (i < source.length && isDigit(peek())) num += advance();
      }
      // Exponent: e/E, optional sign, digits.
      if (peek() === "e" || peek() === "E") {
        const signed = peek(1) === "+" || peek(1) === "-";
        if (isDigit(peek(1)) || (signed && isDigit(peek(2)))) {
          num += advance(); // e/E
          if (peek() === "+" || peek() === "-") num += advance();
          while (i < source.length && isDigit(peek())) num += advance();
        } else {
          // `e`/`E` right after the digits but no exponent value follows: a
          // malformed number (digits never abut a bare identifier in argtype),
          // so flag it rather than silently emitting `1` + ident `e`.
          num += advance(); // consume the stray e/E
          errors.push({
            message: `Malformed number '${num}': exponent has no digits`,
            line: startLine,
            column: startCol,
          });
        }
      }
      push("number", num, startLine, startCol);
      continue;
    }

    // Identifier / keyword.
    if (isIdentStart(ch)) {
      let id = advance();
      while (i < source.length && isIdentPart(peek())) id += advance();
      push("ident", id, startLine, startCol);
      continue;
    }

    // Punctuation.
    const punct = PUNCT[ch];
    if (punct) {
      advance();
      push(punct, ch, startLine, startCol);
      continue;
    }

    errors.push({ message: `Unexpected character '${ch}'`, line: startLine, column: startCol });
    advance();
  }

  push("eof", "", line, col);
  return { tokens, errors };
}

/** Minimal escape handling inside double-quoted strings. */
function unescape(esc: string): string {
  switch (esc) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "":
      return "";
    default:
      return esc;
  }
}
