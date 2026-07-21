/**
 * Frontmatter handling for argtype documents.
 *
 * A document may begin with a `---` fenced block of YAML-ish metadata (`exe`,
 * `version`, `container`, `authors`, `stdout`, ...). Rather than pull in a full
 * YAML dependency, this parses the small subset the format uses: scalar
 * `key: value`, block sequences (`- item`), inline flow sequences (`[a, b]`),
 * and one level of nested mappings. That covers every key the lowering step
 * consumes; anything more exotic is read as a raw string and ignored downstream.
 */

export interface SplitResult {
  frontmatter?: Record<string, unknown>;
  /** The document body. Frontmatter lines are blanked (not removed) so token
   * line numbers still line up with the original source. */
  body: string;
  errors: string[];
}

export function splitFrontmatter(source: string): SplitResult {
  // Tolerate a leading BOM / blank lines before the opening fence.
  const lines = source.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;

  if (lines[start]?.trim() !== "---") {
    return { body: source, errors: [] };
  }

  // Find the closing fence.
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { body: source, errors: ["Unterminated frontmatter block (missing closing '---')"] };
  }

  const fmLines = lines.slice(start + 1, end);
  const { value, errors } = parseYamlish(fmLines);

  // Blank out the frontmatter region (fences + content) to preserve line numbers.
  const blanked = lines.map((line, i) => (i >= start && i <= end ? "" : line));
  return { frontmatter: value, body: blanked.join("\n"), errors };
}

interface Line {
  indent: number;
  content: string;
}

function tokenizeLines(raw: string[]): Line[] {
  const out: Line[] = [];
  for (const line of raw) {
    const noComment = stripComment(line);
    if (noComment.trim() === "") continue;
    const indent = noComment.length - noComment.trimStart().length;
    out.push({ indent, content: noComment.trim() });
  }
  return out;
}

/** Strip a trailing `#` comment that is not inside quotes. Following YAML, a
 * `#` only starts a comment at the start of the line or after whitespace, so an
 * unquoted value containing `#` (e.g. a URL fragment `https://x/#frag`) is kept
 * intact. */
function stripComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    // A backslash escape inside a double-quoted value hides the next char (so
    // `\"` does not close the string).
    if (inQuote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYamlish(raw: string[]): { value: Record<string, unknown>; errors: string[] } {
  const lines = tokenizeLines(raw);
  const errors: string[] = [];
  let pos = 0;

  function parseBlock(minIndent: number): Record<string, unknown> | unknown[] {
    // Sequence block?
    if (
      pos < lines.length &&
      lines[pos]!.indent >= minIndent &&
      lines[pos]!.content.startsWith("- ")
    ) {
      const seq: unknown[] = [];
      const indent = lines[pos]!.indent;
      while (
        pos < lines.length &&
        lines[pos]!.indent === indent &&
        lines[pos]!.content.startsWith("- ")
      ) {
        seq.push(parseScalar(lines[pos]!.content.slice(2).trim()));
        pos++;
      }
      return seq;
    }

    // Mapping block.
    const map: Record<string, unknown> = {};
    if (pos >= lines.length) return map;
    const indent = lines[pos]!.indent;
    while (
      pos < lines.length &&
      lines[pos]!.indent === indent &&
      !lines[pos]!.content.startsWith("- ")
    ) {
      const { content } = lines[pos]!;
      const colon = findColon(content);
      if (colon === -1) {
        errors.push(`Malformed frontmatter line: '${content}'`);
        pos++;
        continue;
      }
      const key = content.slice(0, colon).trim();
      const valueText = content.slice(colon + 1).trim();
      pos++;
      if (valueText !== "") {
        map[key] = parseScalar(valueText);
      } else if (pos < lines.length && lines[pos]!.indent > indent) {
        map[key] = parseBlock(lines[pos]!.indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  const value = parseBlock(0);
  return { value: isRecord(value) ? value : { _root: value }, errors };
}

function findColon(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ":") {
      return i;
    }
  }
  return -1;
}

/** Reverse the backslash escapes an emitter applies to a quoted scalar
 * (`\n`, `\t`, `\r`, `\"`, `\\`), so values with newlines/quotes round-trip. */
function unescapeScalar(s: string): string {
  return s.replace(/\\(.)/g, (_, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}

/** Split a flow-sequence body (`a, "b, c", [d, e]`) on top-level commas, keeping
 * commas inside quotes or a nested `[...]` intact. Empty segments (from a leading,
 * trailing, or doubled comma, or an empty `[]` body) are dropped, matching YAML;
 * a quoted empty string keeps its quotes and so survives. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuote === '"' && ch === "\\") {
      cur += ch + (body[i + 1] ?? "");
      i++;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
    } else if (ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "]") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseScalar(text: string): unknown {
  // Inline flow sequence: `[a, b, c]` (valid YAML the block-list parser would
  // otherwise read as a bare string). `[]` is the empty list.
  if (text.startsWith("[") && text.endsWith("]") && text.length >= 2) {
    return splitFlow(text.slice(1, -1)).map(parseScalar);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return unescapeScalar(text.slice(1, -1));
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
