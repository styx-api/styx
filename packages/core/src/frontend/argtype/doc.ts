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
 * Split a `///` doc block into title + description. A leading Markdown H1
 * (`# Title` on the first line) is the title; everything after it is the
 * description. Without a leading `# `, the whole block is the description (no
 * title), regardless of paragraph breaks.
 */
export function splitDocText(raw: string): DocParts {
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  if (firstLine.startsWith("# ")) {
    const title = firstLine.slice(2).trim();
    const description = (newline === -1 ? "" : raw.slice(newline + 1)).trim();
    return {
      ...(title && { title }),
      ...(description && { description }),
    };
  }
  const description = raw.trim();
  return description ? { description } : {};
}
