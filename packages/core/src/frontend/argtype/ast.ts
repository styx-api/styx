/**
 * AST for the argtype sugar DSL. Mirrors the grammar in the argtype spec
 * (combinators, terminals, literals, naming, aliases, method chains) and is the
 * intermediate the parser produces before `lower.ts` translates it to Styx IR.
 *
 * Decorations (`name`, `doc`, `default`, value constraints, `.join`/`.count`,
 * outputs, media types) attach to any node, so they live as optional fields on
 * the single `AstNode` shape rather than as wrapper nodes - lowering folds them
 * onto the corresponding `NodeMeta` / terminal attrs.
 */

/** A combinator keyword. `set`/`any` have no direct IR node (see `lower.ts`). */
export type Combinator = "seq" | "set" | "opt" | "rep" | "alt" | "any";

/** A terminal keyword. */
export type Terminal = "int" | "float" | "str" | "path";

export interface AstNode {
  kind: "literal" | "terminal" | "comb" | "ref";

  /** kind === "literal": the fixed token string. */
  value?: string;
  /** kind === "terminal": which terminal. */
  terminal?: Terminal;
  /** kind === "comb": which combinator + its children. */
  op?: Combinator;
  children?: AstNode[];
  /** kind === "ref": an alias reference (resolved by substitution). */
  refName?: string;

  // -- Decorations (any node) --

  /** `label:` sugar / `.name("...")`. */
  name?: string;
  /** Title: a `# ` heading in a `///` block, or `.title("...")`. */
  title?: string;
  /** Description: a `///` block (minus the title), or `.description("...")`. */
  description?: string;
  /** `= value` sugar / `.default(...)` (terminal only). */
  default?: string | number;
  /** `.min(n)` (int/float only). */
  min?: number;
  /** `.max(n)` (int/float only). */
  max?: number;
  /** `.join(sep?)` - present means joined; separator defaults to "". */
  join?: string;
  /** `.count(n)` (= `.countMin(n).countMax(n)`) / `.countMin(n)` / `.countMax(n)`
   * (rep only). */
  countMin?: number;
  countMax?: number;
  /** `.mediaType(mime)` (path only; `mediatypes` extension). */
  mediaTypes?: string[];
  /** `.mutable()` (path only; `paths` extension). */
  mutable?: boolean;
  /** `.resolveParent()` (path only; `paths` extension). */
  resolveParent?: boolean;
  /** `.output(...)` (`outputs` extension). */
  outputs?: AstOutput[];
}

/** One output template declared via `.output(...)`. */
export interface AstOutput {
  /** `label:` on the template / `.name(...)`. */
  name?: string;
  /** Title of the produced file (from a `# ` heading in the entry's `///`). */
  title?: string;
  /** Description of the produced file (from the entry's `///`). */
  description?: string;
  /** Output-level `.or(fallback)` on the template. */
  fallback?: string;
  tokens: AstOutputToken[];
}

/** A piece of an output path template: literal text or a `{ref}` interpolation. */
export type AstOutputToken =
  | { kind: "literal"; value: string }
  | {
      kind: "ref";
      /** Target node name; undefined for a self-reference (`{}`). */
      name?: string;
      stripSuffix?: string[];
      stripPrefix?: string[];
      basename?: boolean;
      or?: string;
    };

/** A top-level alias definition (`Name = expr`). */
export interface AstAlias {
  name: string;
  expr: AstNode;
}

/** The result of parsing a full argtype document. */
export interface AstDocument {
  frontmatter?: Record<string, unknown>;
  aliases: AstAlias[];
  /** The single root definition (`name: expr`). */
  rootName: string;
  root: AstNode;
}
