/** Symbol collision avoidance for code generation. */
export class Scope {
  private readonly reserved: ReadonlySet<string>;
  private readonly used: Set<string>;
  private readonly parent?: Scope;

  constructor(reserved: Iterable<string> = [], parent?: Scope) {
    this.reserved = new Set(reserved);
    this.used = new Set();
    this.parent = parent;
  }

  /** Check if a symbol is already taken (in this scope or any parent). */
  has(symbol: string): boolean {
    return (
      this.reserved.has(symbol) || this.used.has(symbol) || (this.parent?.has(symbol) ?? false)
    );
  }

  /**
   * Add a symbol, appending a numeric suffix to avoid collisions. Returns the
   * safe name.
   *
   * When a `recase` transform is given, a disambiguated candidate is routed back
   * through it so the suffix is absorbed into the identifier's casing - e.g.
   * `pascalCase` folds `Config_2` into `Config2` - rather than leaving a
   * mixed-case `Config_2`. Uniqueness is always checked on the final emitted
   * form, so two hints that case-collide still get distinct names. Defaults to
   * identity (the bare `<name>_<n>` suffix) for callers that don't case-normalize.
   */
  add(candidate: string, recase: (s: string) => string = (s) => s): string {
    if (!this.has(candidate)) {
      this.used.add(candidate);
      return candidate;
    }
    let suffix = 2;
    let safe = recase(`${candidate}_${suffix}`);
    while (this.has(safe)) {
      suffix++;
      safe = recase(`${candidate}_${suffix}`);
    }
    this.used.add(safe);
    return safe;
  }

  /** Create a child scope that inherits this scope's restrictions. */
  child(reserved: Iterable<string> = []): Scope {
    return new Scope(reserved, this);
  }
}
