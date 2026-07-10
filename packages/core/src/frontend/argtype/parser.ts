/**
 * Recursive-descent parser for the argtype sugar DSL, producing an `AstDocument`
 * (frontmatter + aliases + a single root definition). Lowering to Styx IR is a
 * separate step (`lower.ts`).
 *
 * Precedence, loosest to tightest: `,` (list separator) < `label:` < `|` (alt)
 * < `.method()` (chaining). See the spec's "Sugar DSL" section.
 */

import type { AstAlias, AstDocument, AstNode, AstOutput, Combinator, Terminal } from "./ast.js";
import { lex } from "./lexer.js";
import type { Token, TokenKind } from "./lexer.js";
import { splitFrontmatter } from "./frontmatter.js";
import { parseTemplate } from "./template.js";
import { splitDocText } from "./doc.js";

/** Split a `///` block and attach its title/description to a node. Per the spec,
 * the block "is applied first and wins": for each field the block provides it
 * overrides a value a chained `.title()`/`.description()` already set, while a
 * field the block leaves unset keeps whatever the chain supplied. */
function attachDocText(target: { title?: string; description?: string }, raw: string): void {
  const { title, description } = splitDocText(raw);
  if (title !== undefined) target.title = title;
  if (description !== undefined) target.description = description;
}

const COMBINATORS = new Set<Combinator>(["seq", "set", "opt", "rep", "alt", "any"]);
const TERMINALS = new Set<Terminal>(["int", "float", "str", "path"]);

export interface AstParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface AstParseResult {
  doc?: AstDocument;
  errors: AstParseError[];
  warnings: AstParseError[];
}

/** Core + supported-extension chaining methods. Anything else is an extension
 * we don't implement and is parsed-and-ignored (the spec's "ignorable" rule). */
const KNOWN_METHODS = new Set([
  "name",
  "title",
  "description",
  "default",
  "min",
  "max",
  "join",
  "count",
  "countMin",
  "countMax",
  "mediaType",
  "mutable",
  "resolveParent",
]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  readonly errors: AstParseError[] = [];
  readonly warnings: AstParseError[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(o = 0): Token {
    return this.tokens[Math.min(this.pos + o, this.tokens.length - 1)]!;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private next(): Token {
    return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1]!;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (this.at(kind)) return this.next();
    const tok = this.peek();
    this.error(`Expected ${what} but found '${tok.value || tok.kind}'`, tok);
    return tok;
  }

  private error(message: string, tok: Token = this.peek()): void {
    this.errors.push({ message, line: tok.line, column: tok.column });
  }

  private warn(message: string, tok: Token = this.peek()): void {
    this.warnings.push({ message, line: tok.line, column: tok.column });
  }

  // -- Top level --

  parseDocument(frontmatter: Record<string, unknown> | undefined): AstDocument | undefined {
    const aliases: AstAlias[] = [];
    let rootName: string | undefined;
    let root: AstNode | undefined;

    while (!this.at("eof")) {
      const docs = this.collectDocs();
      if (this.at("eof")) break; // trailing docs before end of file

      // An alias (`Name = expr`) or a named root (`name: expr`) both begin with
      // an identifier / quoted label followed by `=` / `:`. Anything else at the
      // top level is a bare, anonymous root expression - the spec lets the root
      // be unnamed (its id then falls back to `exe`/`id` frontmatter).
      const labelLike = this.at("ident") || this.at("string");
      const following = this.peek(1).kind;

      if (labelLike && following === "eq") {
        // Alias: Name = expr. Alias names must be identifiers (they are
        // referenced by bare name at each use site).
        const nameTok = this.next();
        if (nameTok.kind === "string")
          this.error("Alias names must be identifiers, not quoted strings", nameTok);
        this.next(); // '='
        const expr = this.parseElement();
        if (docs) attachDocText(expr, docs);
        aliases.push({ name: nameTok.value, expr });
        continue;
      }

      if (labelLike && following === "colon") {
        // Named root definition: name: expr
        const nameTok = this.next();
        this.next(); // ':'
        const expr = this.parseElement();
        if (docs) attachDocText(expr, docs);
        if (root) {
          this.error(
            `Multiple root definitions; '${nameTok.value}' ignored (already have '${rootName ?? "<anonymous>"}')`,
            nameTok,
          );
        } else {
          rootName = nameTok.value;
          root = expr;
          if (!root.name) root.name = nameTok.value;
        }
        continue;
      }

      // Anonymous root: a bare expression (`seq(...)`, `rep(str)`, `path`,
      // `"literal"`, `(...)`, or an alias reference). It leaves `rootName`
      // unset; lowering derives the tool id from frontmatter. Every root
      // expression starts with an identifier, a string, or `(`; a top-level
      // token that cannot start an expression is a syntax error, not an
      // anonymous root (guarding this keeps `parsePrimary`'s empty-literal
      // fallback from being adopted as the root and then reported as a
      // spurious duplicate of the real one).
      if (!this.at("ident") && !this.at("string") && !this.at("lparen")) {
        this.error(
          "Expected a definition (name: expr), an alias (Name = expr), or a root expression",
        );
        break;
      }
      const expr = this.parseElement();
      if (docs) attachDocText(expr, docs);
      if (root) {
        this.error("Multiple root definitions; a second top-level expression is not allowed");
        break;
      }
      root = expr;
    }

    if (!root) {
      this.error("No root definition (expected `name: expr` or a bare root expression)");
      return undefined;
    }
    return {
      ...(frontmatter && { frontmatter }),
      aliases,
      ...(rootName !== undefined && { rootName }),
      root,
    };
  }

  /** Collect consecutive `///` doc lines, joined with newlines. */
  private collectDocs(): string | undefined {
    const lines: string[] = [];
    while (this.at("doc")) lines.push(this.next().value);
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  // -- Expressions --

  /**
   * An element is the unit inside a comma list: an optionally-named expression.
   * `label:` is looser than `|`, so a name binds the whole alternative that
   * follows it.
   */
  private parseElement(): AstNode {
    // A label is a bare identifier or a quoted string (for names that are not
    // valid identifiers), followed by `:`. A quoted string NOT followed by `:`
    // is a literal, so the colon lookahead disambiguates.
    if ((this.at("ident") || this.at("string")) && this.peek(1).kind === "colon") {
      const nameTok = this.next();
      this.next(); // colon
      const inner = this.parseElement();
      inner.name = nameTok.value;
      return inner;
    }
    return this.parseAlt();
  }

  private parseAlt(): AstNode {
    const first = this.parseChain();
    if (!this.at("pipe")) return first;
    const alts: AstNode[] = [first];
    while (this.at("pipe")) {
      this.next();
      alts.push(this.parseChain());
    }
    return { kind: "comb", op: "alt", children: alts };
  }

  private parseChain(): AstNode {
    const node = this.parsePrimary();
    // Method chain.
    let chained = false;
    while (this.at("dot")) {
      this.next();
      this.applyMethod(node);
      chained = true;
    }
    // `= value` default sugar. The spec restricts it to a bare terminal: once a
    // chain has started, `.default(...)` must be used instead.
    if (this.at("eq")) {
      const eqTok = this.next();
      const value = this.parseValue();
      if (node.kind === "terminal" && !chained) {
        node.default = value;
      } else {
        this.error(
          "`= value` default is only allowed on a bare terminal; use `.default(...)` after a method chain",
          eqTok,
        );
      }
    }
    return node;
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();

    if (tok.kind === "string") {
      this.next();
      return { kind: "literal", value: tok.value };
    }

    if (tok.kind === "lparen") {
      // Anonymous sequence group.
      const children = this.parseParenList();
      return { kind: "comb", op: "seq", children };
    }

    if (tok.kind === "ident") {
      if (COMBINATORS.has(tok.value as Combinator) && this.peek(1).kind === "lparen") {
        this.next();
        const children = this.parseParenList();
        return { kind: "comb", op: tok.value as Combinator, children };
      }
      if (TERMINALS.has(tok.value as Terminal)) {
        this.next();
        return { kind: "terminal", terminal: tok.value as Terminal };
      }
      // Otherwise an alias reference.
      this.next();
      return { kind: "ref", refName: tok.value };
    }

    this.error(`Unexpected token '${tok.value || tok.kind}' in expression`, tok);
    this.next();
    return { kind: "literal", value: "" };
  }

  /** Parse `( elem, elem, ... )` with optional leading docs and trailing comma. */
  private parseParenList(): AstNode[] {
    this.expect("lparen", "'('");
    const items: AstNode[] = [];
    while (!this.at("rparen") && !this.at("eof")) {
      const docs = this.collectDocs();
      if (this.at("rparen")) break; // trailing docs before close
      const elem = this.parseElement();
      if (docs) attachDocText(elem, docs);
      items.push(elem);
      if (this.at("comma")) this.next();
      else break;
    }
    this.expect("rparen", "')'");
    return items;
  }

  // -- Method calls --

  private applyMethod(node: AstNode): void {
    const nameTok = this.expect("ident", "a method name");
    const method = nameTok.value;
    if (method === "output") {
      node.outputs = [...(node.outputs ?? []), ...this.parseOutputArgs()];
      return;
    }
    if (!KNOWN_METHODS.has(method)) {
      // An extension method we don't implement (e.g. the draft `constraints`
      // extension's `.requires()`/`.conflicts()`). The spec requires unknown
      // extension annotations to be ignorable, so skip the argument list
      // (whatever its shape) and continue rather than failing the parse.
      this.skipBalancedArgs();
      this.warn(`Ignoring unsupported method '.${method}()'`, nameTok);
      return;
    }

    const args = this.parseScalarArgs();
    switch (method) {
      case "name":
        if (typeof args[0] === "string") node.name = args[0];
        break;
      case "title":
        if (typeof args[0] === "string") node.title = args[0];
        break;
      case "description":
        // `.description()` sets the description directly; the `# ` heading
        // convention is sugar for the `///` form only, so a leading `#` here is a
        // literal part of the description, not a title.
        if (typeof args[0] === "string") node.description = args[0];
        break;
      case "default":
        if (args[0] !== undefined) node.default = args[0];
        break;
      case "min":
        if (typeof args[0] === "number") node.min = args[0];
        break;
      case "max":
        if (typeof args[0] === "number") node.max = args[0];
        break;
      case "join":
        node.join = typeof args[0] === "string" ? args[0] : "";
        break;
      case "count":
        // `.count(n)` is exactly n (sugar for `.countMin(n).countMax(n)`). For a
        // one-sided or asymmetric bound, use `.countMin` / `.countMax` directly.
        if (typeof args[0] === "number") {
          node.countMin = args[0];
          node.countMax = args[0];
        }
        break;
      case "countMin":
        if (typeof args[0] === "number") node.countMin = args[0];
        break;
      case "countMax":
        if (typeof args[0] === "number") node.countMax = args[0];
        break;
      case "mediaType":
        if (typeof args[0] === "string") (node.mediaTypes ??= []).push(args[0]);
        break;
      case "mutable":
        node.mutable = true;
        break;
      case "resolveParent":
        node.resolveParent = true;
        break;
    }
  }

  /** Parse a parenthesized list of plain scalar arguments (numbers / strings). */
  private parseScalarArgs(): (string | number)[] {
    this.expect("lparen", "'('");
    const args: (string | number)[] = [];
    while (!this.at("rparen") && !this.at("eof")) {
      args.push(this.parseValue());
      if (this.at("comma")) this.next();
      else break;
    }
    this.expect("rparen", "')'");
    return args;
  }

  /** Consume a balanced `( ... )` group without interpreting its contents.
   * Used to skip the arguments of an unsupported extension method. */
  private skipBalancedArgs(): void {
    if (!this.at("lparen")) return;
    let depth = 0;
    do {
      const tok = this.next();
      if (tok.kind === "lparen") depth++;
      else if (tok.kind === "rparen") depth--;
      else if (tok.kind === "eof") break;
    } while (depth > 0);
  }

  /** Parse the argument list of `.output(...)`: one or more template expressions. */
  private parseOutputArgs(): AstOutput[] {
    this.expect("lparen", "'('");
    const outputs: AstOutput[] = [];
    while (!this.at("rparen") && !this.at("eof")) {
      const docs = this.collectDocs();
      if (this.at("rparen")) break; // trailing docs before close
      const out = this.parseOutputTemplate();
      if (docs) attachDocText(out, docs);
      outputs.push(out);
      if (this.at("comma")) this.next();
      else break;
    }
    this.expect("rparen", "')'");
    return outputs;
  }

  /** `label: \`tpl\`` or `\`tpl\`` followed by optional `.name(...)` / `.or(...)`. */
  private parseOutputTemplate(): AstOutput {
    let name: string | undefined;
    // The output name may be a bare identifier or a quoted label (for
    // non-identifier output names), mirroring `label:` naming.
    if ((this.at("ident") || this.at("string")) && this.peek(1).kind === "colon") {
      name = this.next().value;
      this.next(); // colon
    }

    const out: AstOutput = { tokens: [] };
    if (this.at("template")) {
      const tmplTok = this.next();
      const { tokens, errors } = parseTemplate(tmplTok.value);
      out.tokens = tokens;
      for (const e of errors) this.error(e, tmplTok);
    } else {
      this.error(`Expected an output template literal`);
    }

    // Template-level chaining: .name("x") / .or("fallback") / .title("t") /
    // .description("d"). An unrecognized method is an ignorable extension
    // annotation (same rule as node method chains): skip its arguments and warn
    // rather than failing the parse.
    const CHAIN = new Set(["name", "or", "title", "description"]);
    while (this.at("dot")) {
      this.next();
      const m = this.expect("ident", "a template method");
      if (CHAIN.has(m.value)) {
        const arg = this.parseScalarArgs()[0];
        if (typeof arg === "string") {
          if (m.value === "name") name = arg;
          else if (m.value === "or") out.fallback = arg;
          else if (m.value === "title") out.title = arg;
          else out.description = arg; // description
        }
      } else {
        this.skipBalancedArgs();
        this.warn(`Ignoring unsupported output-template method '.${m.value}()'`, m);
      }
    }

    if (name !== undefined) out.name = name;
    return out;
  }

  private parseValue(): string | number {
    const tok = this.peek();
    if (tok.kind === "string") {
      this.next();
      return tok.value;
    }
    if (tok.kind === "number") {
      this.next();
      return Number(tok.value);
    }
    this.error(`Expected a value (string or number) but found '${tok.value || tok.kind}'`, tok);
    this.next();
    return "";
  }
}

export function parseArgtype(source: string): AstParseResult {
  const { frontmatter, body, errors: fmErrors } = splitFrontmatter(source);
  const { tokens, errors: lexErrors } = lex(body);

  const parser = new Parser(tokens);
  const doc = parser.parseDocument(frontmatter);

  const errors: AstParseError[] = [
    ...fmErrors.map((m) => ({ message: m })),
    ...lexErrors.map((e) => ({ message: e.message, line: e.line, column: e.column })),
    ...parser.errors,
  ];
  return { ...(doc && { doc }), errors, warnings: parser.warnings };
}
