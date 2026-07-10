import { StreamLanguage, LanguageSupport, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * A CodeMirror StreamLanguage for the argtype DSL, used to highlight the input
 * editor. It mirrors the TextMate grammar that Shiki uses for the output panel
 * (see `grammars.ts` / the argtype spec repo); keep the token set in sync.
 *
 * Token names below are mapped to highlight tags via `tokenTable`, so the
 * active theme (oneDark) colors them. Returning a name not in the table would
 * leave that token uncolored.
 */

const COMBINATORS = /^(?:seq|set|opt|rep|alt|any)$/;
const TERMINALS = /^(?:int|float|str|path)$/;

const parser: StreamParser<unknown> = {
  name: "argtype",

  token(stream) {
    if (stream.eatSpace()) return null;

    // Line comments: `///` doc comment and `//` regular both run to EOL.
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    // Double-quoted string literal (tolerates an unterminated open quote).
    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '"' && !escaped) break;
        escaped = ch === "\\" && !escaped;
      }
      return "string";
    }

    // Backtick template literal (single-line; `{...}` interpolation not
    // sub-tokenized here - the whole span reads as a string).
    if (stream.peek() === "`") {
      stream.next();
      while (!stream.eol()) {
        if (stream.next() === "`") break;
      }
      return "string";
    }

    // Numeric literal (leading `-` allowed, e.g. defaults).
    if (stream.match(/^-?\d+(?:\.\d+)?/)) {
      return "number";
    }

    // Method chain: `.name` (styled whether or not a call follows).
    if (stream.match(/^\.[A-Za-z_]\w*/)) {
      return "method";
    }

    // Identifiers -> keyword / terminal / label / type-alias / plain name.
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      const rest = stream.string.slice(stream.pos);
      if (COMBINATORS.test(word) && /^\s*\(/.test(rest)) return "combinator";
      if (TERMINALS.test(word)) return "terminal";
      // A label is an identifier followed by `:` but not `:=`.
      if (/^\s*:(?!=)/.test(rest)) return "label";
      // PascalCase bare word: a type alias definition or reference.
      if (/^[A-Z]/.test(word)) return "alias";
      return "name";
    }

    // Operators and the frontmatter/arrow glyph.
    if (stream.match(/^(?:\||=|\.|→)/)) {
      return "operator";
    }

    // Grouping and separators.
    if (stream.match(/^[(),]/)) {
      return "punctuation";
    }

    // Anything else (e.g. `---` fence dashes): consume one char, uncolored.
    stream.next();
    return null;
  },

  tokenTable: {
    combinator: t.keyword,
    terminal: t.typeName,
    string: t.string,
    comment: t.comment,
    number: t.number,
    label: t.propertyName,
    alias: t.className,
    method: t.function(t.variableName),
    name: t.variableName,
    operator: t.operator,
    punctuation: t.punctuation,
  },
};

const argtypeLanguage = StreamLanguage.define(parser);

/** CodeMirror language support for the argtype DSL. */
export function argtype(): LanguageSupport {
  return new LanguageSupport(argtypeLanguage);
}
