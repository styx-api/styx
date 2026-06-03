import type { Binding, BindingId, BoundType, BoundVariant } from "../../bindings/index.js";
import { collectFieldInfo } from "../collect-field-info.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { pyStr, renderAccess, renderPyLiteral } from "./typemap.js";

// -- Result types --

interface Expr_ {
  expr: string;
}
interface Stmt {
  stmt: string;
}
export type ArgResult = Expr_ | Stmt;

function isExpr(r: ArgResult): r is Expr_ {
  return "expr" in r;
}

export function resultToStmt(r: ArgResult): string {
  return isExpr(r) ? `cargs.append(${r.expr})` : r.stmt;
}

function appendLines(cb: CodeBuilder, code: string): void {
  for (const line of code.split("\n")) cb.line(line);
}

// -- Type helpers --

function toStringExpr(node: Expr, type: BoundType, expr: string): string {
  if (type.kind === "scalar") {
    if (type.scalar === "str") return expr;
    if (type.scalar === "path") return pathArg(node, expr);
  }
  return `str(${expr})`;
}

/**
 * Command-line value for a path input via `execution.input_file`, threading the
 * path node's `resolve_parent` / `mutable` attrs as keyword args. `mutable=True`
 * tells the runner to stage a writable COPY (original untouched) and return the
 * copy's command-line path; the outputs builder surfaces that same copy's host
 * path via `execution.mutable_copy`.
 */
function pathArg(node: Expr, expr: string): string {
  if (node.kind !== "path") return `execution.input_file(${expr})`;
  let extra = "";
  if (node.attrs.resolveParent) extra += ", resolve_parent=True";
  if (node.attrs.mutable) extra += ", mutable=True";
  return `execution.input_file(${expr}${extra})`;
}

// -- Context passed down through recursion --

interface ArgContext {
  /** Join nesting depth (controls ternary vs if-statement for optionals). */
  joinDepth: number;
  /**
   * Loop variables bound by enclosing `repeat`-of-list nodes, keyed by the
   * repeat binding's id. `renderAccess` consults this to resolve the `iter`
   * segments in a binding's solver-assigned access path.
   */
  loopVars: ReadonlyMap<BindingId, string>;
  /**
   * Prefix substitutions for optional fields narrowed by an enclosing presence
   * guard: maps a rendered access prefix to the `.get()`-narrowed local that
   * holds it. Threaded into `renderAccess` so inner reads use the local (one
   * lookup, absent-safe, mypy-narrowable) instead of re-subscripting.
   */
  valueSubst: ReadonlyMap<string, string>;
  /**
   * Rendered Python default literals for root-level NON-OPTIONAL fields that
   * carry a Boutiques default (e.g. `maskfile -> "img_bet"`), keyed by field
   * name. Such a field is `NotRequired` (a hand-authored config may omit it) yet
   * is read unconditionally - so every read of its value becomes
   * `.get(key, <default>)` to substitute the default instead of raising
   * `KeyError`. Optional fields are excluded: they are presence-guarded (their
   * default, if any, is supplied by the factory's kwarg signature), so reading
   * them with a default here would both be wrong and collide with `valueSubst`.
   */
  defaults: ReadonlyMap<string, string>;
}

/**
 * The rendered default for a binding iff it is a root-level NON-OPTIONAL field
 * carrying a Boutiques default. Restricted to single-segment (root) field access
 * so a nested field can never accidentally pick up a same-named root default.
 */
function rootFieldDefault(
  binding: Binding,
  defaults: ReadonlyMap<string, string>,
): string | undefined {
  const a = binding.access;
  if (a.length === 1 && a[0]?.kind === "field") return defaults.get(binding.name);
  return undefined;
}

/**
 * Render a binding's access for an UNCONDITIONAL value read (terminal, repeat
 * loop, alternative dispatch): substitutes the field's default via
 * `.get(key, default)` when it is a defaulted non-optional field, else the plain
 * access. Returns plain access for every non-defaulted field, so the emitted
 * code is byte-identical to before for the common case. Not used by
 * `walkOptional` (its bare access is the `valueSubst` key and its guard reads
 * via `.get()`).
 */
function readAccess(binding: Binding, arg: ArgContext): string {
  const def = rootFieldDefault(binding, arg.defaults);
  return accessOf(binding, arg, def !== undefined ? { finalDefault: def } : {});
}

interface AccessOpts {
  /** Render the final field segment as `.get(key)` (absent key -> None). */
  finalGet?: boolean;
  /** Render the final field segment as `.get(key, default)` (absent key -> default). */
  finalDefault?: string;
}

/**
 * Render a binding's solver-assigned access path in the current loop scope.
 * `finalGet` renders the final field segment as `.get(key)` (used when binding
 * an optional's value to a narrowed local); `finalDefault` renders it as
 * `.get(key, default)` (used for absent-safe reads of a defaulted field).
 */
function accessOf(binding: Binding, arg: ArgContext, opts: AccessOpts = {}): string {
  return renderAccess(
    binding.access,
    (b) => {
      const v = arg.loopVars.get(b);
      if (v === undefined) throw new Error(`arg-builder: unbound loop variable for binding ${b}`);
      return v;
    },
    { finalFieldGet: opts.finalGet, finalFieldDefault: opts.finalDefault, subst: arg.valueSubst },
  );
}

/**
 * Build the field-name -> rendered-default map for a struct root (else empty).
 * Includes only non-optional defaulted fields (optional fields are
 * presence-guarded; their default comes from the factory's kwarg signature).
 */
function collectDefaults(ctx: CodegenContext, rootType?: BoundType): Map<string, string> {
  const out = new Map<string, string>();
  if (rootType?.kind !== "struct") return out;
  for (const [name, fi] of collectFieldInfo(ctx, rootType)) {
    if (fi.defaultValue === undefined) continue;
    if (rootType.fields[name]?.kind === "optional") continue;
    out.set(name, renderPyLiteral(fi.defaultValue));
  }
  return out;
}

// -- Recursive descent --

let loopVarCounter = 0;
let optVarCounter = 0;

/**
 * Build arg-building code for an IR tree via recursive descent.
 *
 * Mirrors the TypeScript backend's `walk` structurally so the emitted Python
 * has the same shape (and the same correctness story) as the TS output.
 */
export function buildArgs(rootExpr: Expr, ctx: CodegenContext, rootType?: BoundType): ArgResult {
  loopVarCounter = 0;
  optVarCounter = 0;
  const initialCtx: ArgContext = {
    joinDepth: 0,
    loopVars: new Map(),
    valueSubst: new Map(),
    defaults: collectDefaults(ctx, rootType),
  };
  return walk(rootExpr, ctx, initialCtx);
}

function walk(node: Expr, ctx: CodegenContext, arg: ArgContext): ArgResult {
  switch (node.kind) {
    case "literal":
      return { expr: pyStr(node.attrs.str) };

    case "int":
    case "float":
    case "str":
    case "path":
      return walkTerminal(node, ctx, arg);

    case "sequence":
      return walkSequence(node, ctx, arg);

    case "optional":
      return walkOptional(node, ctx, arg);

    case "repeat":
      return walkRepeat(node, ctx, arg);

    case "alternative":
      return walkAlternative(node, ctx, arg);
  }
}

function walkTerminal(node: Expr, ctx: CodegenContext, arg: ArgContext): ArgResult {
  const binding = ctx.resolve(node);
  if (!binding) throw new Error(`Missing binding for terminal node: ${node.kind}`);
  // A root-level defaulted field (e.g. an output basename `maskfile="img_bet"`)
  // is read here unconditionally but is `NotRequired`, so `readAccess`
  // substitutes the default for an absent key via `.get(key, default)`.
  return { expr: toStringExpr(node, binding.type, readAccess(binding, arg)) };
}

function walkSequence(
  node: Extract<Expr, { kind: "sequence" }>,
  ctx: CodegenContext,
  arg: ArgContext,
): ArgResult {
  // A non-join sequence inside an outer join must concatenate (rather than
  // push separate args) so it can stand in as a single Expr element of the
  // outer join. Boutiques produces this shape for `command-line-flag` inputs
  // nested under a parent join template (e.g. `[OUTPUT][FLAG]` -> seqJoin('')
  // around an opt(seq(lit(FLAG), value))).
  const join = node.attrs.join ?? (arg.joinDepth > 0 ? "" : undefined);

  // Struct scoping is already baked into each child's access path by the
  // solver; here we only thread join depth (a codegen concern).
  const childArg: ArgContext = join !== undefined ? { ...arg, joinDepth: arg.joinDepth + 1 } : arg;

  const parts = node.attrs.nodes.map((child) => walk(child, ctx, childArg));

  if (join !== undefined) {
    const exprs = parts.map((p) => (isExpr(p) ? p.expr : p.stmt));
    if (exprs.length === 1) return { expr: exprs[0]! };
    return { expr: `${pyStr(join)}.join([${exprs.join(", ")}])` };
  }

  return { stmt: parts.map(resultToStmt).join("\n") };
}

function walkOptional(
  node: Extract<Expr, { kind: "optional" }>,
  ctx: CodegenContext,
  arg: ArgContext,
): ArgResult {
  const binding = ctx.resolve(node);
  if (!binding) throw new Error("Missing binding for optional node");
  const isOpt = binding.type.kind === "optional";
  const access = accessOf(binding, arg);

  // For a nullable optional, bind the value to a narrowed local read via `.get()`
  // (the key is `NotRequired` - the factory omits it when None, so a bare
  // subscript would KeyError). Inner reads of this access (and anything nested
  // under it) are redirected to the local via `valueSubst`: one lookup, absent-
  // safe, and mypy can narrow the local (it cannot narrow a re-subscript or a
  // fresh `.get()`). Bool-flag optionals are also `NotRequired` (default false),
  // so the truthy guard reads via `.get()` too (absent key -> None -> flag off).
  let childArg = arg;
  let local: string | undefined;
  let getAccess: string | undefined;
  if (isOpt) {
    local = `v_${optVarCounter++}`;
    getAccess = accessOf(binding, arg, { finalGet: true });
    childArg = { ...arg, valueSubst: new Map(arg.valueSubst).set(access, local) };
  }
  // Absent-safe truthy guard for the bool-flag case.
  const boolGuard = accessOf(binding, arg, { finalGet: true });

  // The inner node's access path is solver-assigned (it either inherits this
  // optional's path on a collapse, or scopes into it for a struct); we thread the
  // loop scope, join depth, and the optional's value substitution.
  const inner = walk(node.attrs.node, ctx, childArg);

  // Inside a join context, emit as ternary expression.
  if (arg.joinDepth > 0 && isExpr(inner)) {
    if (isOpt) {
      // Walrus binds the narrowed local inside the lazy ternary; the inner expr
      // (which references `local`) only evaluates when the key is present.
      return { expr: `(${inner.expr} if (${local} := ${getAccess}) is not None else "")` };
    }
    return { expr: `(${inner.expr} if ${boolGuard} else "")` };
  }

  const cb = new CodeBuilder("    ");
  const innerStmt = resultToStmt(inner);
  if (isOpt) {
    cb.line(`${local} = ${getAccess}`);
    cb.line(`if ${local} is not None:`);
    cb.indent(() => appendLines(cb, innerStmt));
  } else {
    cb.line(`if ${boolGuard}:`);
    cb.indent(() => appendLines(cb, innerStmt));
  }
  return { stmt: cb.toString() };
}

function walkRepeat(
  node: Extract<Expr, { kind: "repeat" }>,
  ctx: CodegenContext,
  arg: ArgContext,
): ArgResult {
  const binding = ctx.resolve(node);
  if (!binding) throw new Error("Missing binding for repeat node");
  // A non-join repeat inside an outer join concatenates rather than pushing
  // separate args, mirroring walkSequence's handling of bare non-join seqs.
  const join = node.attrs.join ?? (arg.joinDepth > 0 ? "" : undefined);
  // Unconditional read (the count/list value) - `readAccess` substitutes a
  // defaulted non-optional field's default for an absent key.
  const access = readAccess(binding, arg);

  // Count repeat: emit a counted for-loop. Inside a join the for-loop would
  // be dropped into a list literal as raw text, so emit a comprehension.
  if (binding.type.kind === "count") {
    const inner = walk(node.attrs.node, ctx, arg);
    const v = `_i${loopVarCounter++}`;
    if (join !== undefined && isExpr(inner)) {
      return { expr: `${pyStr(join)}.join([${inner.expr} for ${v} in range(${access})])` };
    }
    const cb = new CodeBuilder("    ");
    cb.line(`for ${v} in range(${access}):`);
    cb.indent(() => appendLines(cb, resultToStmt(inner)));
    return { stmt: cb.toString() };
  }

  // List repeat: emit a for-in loop or generator-join. The loop variable is
  // registered under this repeat's binding id so inner bindings' `iter`
  // segments resolve to it via `renderAccess`.
  const loopVar = `item${loopVarCounter++}`;
  const childArg: ArgContext = {
    ...arg,
    loopVars: new Map(arg.loopVars).set(binding.id, loopVar),
  };

  const inner = walk(node.attrs.node, ctx, childArg);

  if (join !== undefined && isExpr(inner)) {
    return {
      expr: `${pyStr(join)}.join([${inner.expr} for ${loopVar} in ${access}])`,
    };
  }

  const cb = new CodeBuilder("    ");
  cb.line(`for ${loopVar} in ${access}:`);
  cb.indent(() => appendLines(cb, resultToStmt(inner)));
  return { stmt: cb.toString() };
}

function walkAlternative(
  node: Extract<Expr, { kind: "alternative" }>,
  ctx: CodegenContext,
  arg: ArgContext,
): ArgResult {
  const binding = ctx.resolve(node);
  if (!binding) throw new Error("Missing binding for alternative node");
  // Unconditional read (the enum value / bool guard / union discriminator) -
  // `readAccess` substitutes a defaulted non-optional field's default for an
  // absent key (e.g. a `value-choices` String with a default).
  const access = readAccess(binding, arg);

  // Complex-union variant fields already carry the union's path in their
  // solver-assigned access, so arms walk with the current context unchanged.
  const variants = node.attrs.alts.map((alt) => walk(alt, ctx, arg));

  if (
    binding.type.kind === "union" &&
    binding.type.variants.every((v: BoundVariant) => v.type.kind === "literal")
  ) {
    return { expr: `str(${access})` };
  }

  if (binding.type.kind === "bool") {
    // Inside a join, the alternative's output must be an expression, not a
    // statement: an `if/else` block dropped into a `"".join([...])` list
    // literal is not valid Python. Emit a ternary when both arms are exprs.
    if (arg.joinDepth > 0) {
      if (!variants[1]) {
        throw new Error(
          "single-arm bool alternative inside a join: cannot produce an expression " +
            "without ambiguous semantics (omitting the entry vs emitting empty string)",
        );
      }
      if (!variants.every(isExpr)) {
        throw new Error(
          "bool alternative inside a join has statement-shaped variants; " +
            "expected all arms to fold to expressions",
        );
      }
      const v0 = (variants[0] as Expr_).expr;
      const v1 = (variants[1] as Expr_).expr;
      return { expr: `(${v0} if ${access} else ${v1})` };
    }
    const cb = new CodeBuilder("    ");
    cb.line(`if ${access}:`);
    cb.indent(() => appendLines(cb, resultToStmt(variants[0]!)));
    if (variants[1]) {
      cb.line(`else:`);
      cb.indent(() => appendLines(cb, resultToStmt(variants[1]!)));
    }
    return { stmt: cb.toString() };
  }

  if (binding.type.kind === "union") {
    const unionType = binding.type;
    // A union may be pure-discriminated (every variant a struct with `@type`) or
    // mixed (struct variants plus bare-literal variants, e.g. ants
    // `Interpolation = "Linear" | MultiLabel | ...`). Pure-enum unions returned
    // above. Dispatch struct variants on `@type`; a bare literal is its own value.
    const structVariants = unionType.variants
      .map((variant, i) => ({ variant, i }))
      .filter((x) => x.variant.type.kind === "struct");
    const hasLiteral = unionType.variants.some((v) => v.type.kind === "literal");

    // Inside a join: chained ternary, same reason as bool above.
    if (arg.joinDepth > 0) {
      if (!variants.every(isExpr)) {
        throw new Error(
          "union alternative inside a join has statement-shaped variants; " +
            "expected all arms to fold to expressions",
        );
      }
      let structExpr = pyStr("");
      for (let k = structVariants.length - 1; k >= 0; k--) {
        const { variant, i } = structVariants[k]!;
        const v = (variants[i] as Expr_).expr;
        structExpr = `(${v} if ${access}["@type"] == ${pyStr(variant.name ?? "")} else ${structExpr})`;
      }
      if (!hasLiteral) return { expr: structExpr };
      // Mixed: a dict value dispatches by `@type`; a bare literal is itself.
      return { expr: `(${structExpr} if isinstance(${access}, dict) else str(${access}))` };
    }

    const cb = new CodeBuilder("    ");
    const emitStructDispatch = (): void => {
      structVariants.forEach(({ variant, i }, k) => {
        const keyword = k === 0 ? "if" : "elif";
        cb.line(`${keyword} ${access}["@type"] == ${pyStr(variant.name ?? "")}:`);
        cb.indent(() => appendLines(cb, resultToStmt(variants[i]!)));
      });
    };
    if (!hasLiteral) {
      emitStructDispatch();
      return { stmt: cb.toString() };
    }
    // Mixed union: branch on runtime shape (dict -> `@type` dispatch; else a
    // bare literal used directly), mirroring the validator.
    cb.line(`if isinstance(${access}, dict):`);
    cb.indent(emitStructDispatch);
    cb.line(`else:`);
    cb.indent(() => appendLines(cb, resultToStmt({ expr: `str(${access})` })));
    return { stmt: cb.toString() };
  }

  return { stmt: variants.map(resultToStmt).join("\n") };
}
