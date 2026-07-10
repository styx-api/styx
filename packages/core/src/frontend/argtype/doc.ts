/**
 * Doc-comment title/description handling.
 *
 * The `# Title` heading convention is *sugar*: it applies only when splitting a
 * `///` block (`splitDocText`). The chaining methods `.title()` / `.description()`
 * set the title / description directly and are not re-parsed for headings.
 */

export interface DocParts {
  title?: string;
  description?: string;
}

/**
 * Reflow a `///` description as Markdown-style prose: a single line break is a
 * soft wrap (the lines join with a space) and a blank line starts a new
 * paragraph (kept as `\n\n`). This lets an author wrap a long description across
 * several `///` lines for readability without forcing hard breaks, while real
 * paragraph structure survives. (It does not preserve Markdown lists or indented
 * code blocks - their single line breaks are joined like ordinary prose.)
 */
function reflowProse(text: string): string {
  return text
    .split(/\n{2,}/) // blank line(s) -> paragraph boundary
    .map((para) =>
      para
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(" "),
    )
    .filter((para) => para.length > 0)
    .join("\n\n");
}

/**
 * Split a `///` doc block into title + description. A leading Markdown H1
 * (`# Title` on the first line) is the title; everything after it is the
 * description. Without a leading `# `, the whole block is the description (no
 * title). The description is reflowed as prose (see `reflowProse`): single line
 * breaks soft-wrap, blank lines separate paragraphs.
 */
export function splitDocText(raw: string): DocParts {
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  if (firstLine.startsWith("# ")) {
    const title = firstLine.slice(2).trim();
    const description = reflowProse(newline === -1 ? "" : raw.slice(newline + 1));
    return {
      ...(title && { title }),
      ...(description && { description }),
    };
  }
  const description = reflowProse(raw);
  return description ? { description } : {};
}
