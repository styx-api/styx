/**
 * Destruct a template string to a list of strings and replacements.
 *
 * This is used to safely destruct boutiques `command-line` as well as `path-template` strings.
 *
 * @example
 * destructTemplate("hello x, I am y", { x: 12, y: 34 })
 * // => ["hello ", 12, ", I am ", 34]
 */
export function destructTemplate<T>(template: string, lookup: Record<string, T>): (string | T)[] {
  const destructed: (string | T)[] = [];
  const stack: (string | T)[] = [template];

  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
    const x = stack.shift()!;

    if (typeof x !== "string") {
      destructed.push(x);
      continue;
    }

    // Pick the leftmost match; on a tie in position, the longest alias wins
    // (maximal munch), so a value-key that is a prefix of another (e.g. `foo`
    // vs `foobar`) does not shadow it by mere iteration order.
    let best: { idx: number; alias: string; replacement: T } | null = null;
    for (const [alias, replacement] of Object.entries(lookup)) {
      if (alias.length === 0) continue;
      const idx = x.indexOf(alias);
      if (idx === -1) continue;
      if (
        best === null ||
        idx < best.idx ||
        (idx === best.idx && alias.length > best.alias.length)
      ) {
        best = { idx, alias, replacement };
      }
    }

    if (best === null) {
      destructed.push(x);
      continue;
    }

    const left = x.slice(0, best.idx);
    const right = x.slice(best.idx + best.alias.length);
    if (right.length > 0) {
      stack.unshift(right);
    }
    stack.unshift(best.replacement);
    if (left.length > 0) {
      stack.unshift(left);
    }
  }

  return destructed;
}
