import type { BoundType, BoundVariant } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { pyStr } from "./typemap.js";

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

/** Whether a BoundType contains a struct that requires scoping when entering a wrapper. */
function hasStructScope(type: BoundType): boolean {
  switch (type.kind) {
    case "optional":
      return hasStructScope(type.inner);
    case "list":
      return hasStructScope(type.item);
    case "struct":
      return true;
    default:
      return false;
  }
}

function unwrapToStruct(type: BoundType): Extract<BoundType, { kind: "struct" }> | undefined {
  switch (type.kind) {
    case "optional":
      return unwrapToStruct(type.inner);
    case "list":
      return unwrapToStruct(type.item);
    case "struct":
      return type;
    default:
      return undefined;
  }
}

function toStringExpr(type: BoundType, expr: string): string {
  if (type.kind === "scalar") {
    if (type.scalar === "str") return expr;
    if (type.scalar === "path") return `execution.input_file(${expr})`;
  }
  return `str(${expr})`;
}

// -- Context passed down through recursion --

interface ArgContext {
  /** Base path for field access (e.g. `params`, `params["range"]`, `item0`). */
  paramsVar: string;
  /** Join nesting depth (controls ternary vs if-statement for optionals). */
  joinDepth: number;
  /**
   * When set, the next binding's value is directly at this path
   * rather than `paramsVar["bindingName"]`. Handles solver sequence collapse.
   */
  directValue?: string;
  /** The struct type at the current scope level (prevents double-scoping). */
  currentStructType?: BoundType;
}

/** Resolve the access path for a binding in the current context. */
function resolveAccess(arg: ArgContext, bindingName: string): string {
  return arg.directValue ?? `${arg.paramsVar}[${pyStr(bindingName)}]`;
}

// -- Recursive descent --

let loopVarCounter = 0;

/**
 * Build arg-building code for an IR tree via recursive descent.
 *
 * Mirrors the TypeScript backend's `walk` structurally so the emitted Python
 * has the same shape (and the same correctness story) as the TS output.
 */
export function buildArgs(rootExpr: Expr, ctx: CodegenContext, rootType?: BoundType): ArgResult {
  loopVarCounter = 0;
  const initialCtx: ArgContext = {
    paramsVar: "params",
    joinDepth: 0,
    currentStructType: rootType,
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
  const access = resolveAccess(arg, binding.name);
  return { expr: toStringExpr(binding.type, access) };
}

function walkSequence(
  node: Extract<Expr, { kind: "sequence" }>,
  ctx: CodegenContext,
  arg: ArgContext,
): ArgResult {
  const binding = ctx.resolve(node);
  // A non-join sequence inside an outer join must concatenate (rather than
  // push separate args) so it can stand in as a single Expr element of the
  // outer join. Boutiques produces this shape for `command-line-flag` inputs
  // nested under a parent join template (e.g. `[OUTPUT][FLAG]` -> seqJoin('')
  // around an opt(seq(lit(FLAG), value))).
  const join = node.attrs.join ?? (arg.joinDepth > 0 ? "" : undefined);

  const needsScope =
    binding && hasStructScope(binding.type) && binding.type !== arg.currentStructType;
  const childArg: ArgContext = needsScope
    ? {
        ...arg,
        paramsVar: `${arg.paramsVar}[${pyStr(binding!.name)}]`,
        directValue: undefined,
        currentStructType: binding!.type,
        joinDepth: join !== undefined ? arg.joinDepth + 1 : arg.joinDepth,
      }
    : join !== undefined
      ? { ...arg, joinDepth: arg.joinDepth + 1 }
      : arg;

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
  const access = `${arg.paramsVar}[${pyStr(binding.name)}]`;

  let childArg: ArgContext;
  if (hasStructScope(binding.type)) {
    const inner = unwrapToStruct(binding.type);
    childArg = {
      ...arg,
      paramsVar: access,
      directValue: undefined,
      currentStructType: inner ?? arg.currentStructType,
    };
  } else if (binding.type.kind === "optional" || binding.type.kind === "bool") {
    childArg = { ...arg, directValue: access };
  } else {
    childArg = arg;
  }

  const inner = walk(node.attrs.node, ctx, childArg);

  // Inside a join context, emit as ternary expression.
  if (arg.joinDepth > 0 && isExpr(inner)) {
    if (binding.type.kind === "optional") {
      return { expr: `(${inner.expr} if ${access} is not None else "")` };
    }
    return { expr: `(${inner.expr} if ${access} else "")` };
  }

  const cb = new CodeBuilder("    ");
  const innerStmt = resultToStmt(inner);
  if (binding.type.kind === "optional") {
    cb.line(`if ${access} is not None:`);
    cb.indent(() => appendLines(cb, innerStmt));
  } else {
    cb.line(`if ${access}:`);
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
  const access = resolveAccess(arg, binding.name);

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

  // List repeat: emit a for-in loop or generator-join.
  const itemType = binding.type.kind === "list" ? binding.type.item : undefined;
  const isScalar = !itemType || !hasStructScope(itemType);
  const loopVar = `item${loopVarCounter++}`;

  const childArg: ArgContext = {
    ...arg,
    paramsVar: loopVar,
    directValue: isScalar ? loopVar : undefined,
    currentStructType: !isScalar && itemType?.kind === "struct" ? itemType : arg.currentStructType,
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
  const access = resolveAccess(arg, binding.name);

  const isComplexUnion =
    binding.type.kind === "union" &&
    !binding.type.variants.every((v: BoundVariant) => v.type.kind === "literal");

  const variants = node.attrs.alts.map((alt, i) => {
    if (isComplexUnion && binding.type.kind === "union") {
      const variantType = binding.type.variants[i]?.type;
      return walk(alt, ctx, {
        ...arg,
        paramsVar: access,
        directValue: undefined,
        currentStructType: variantType?.kind === "struct" ? variantType : arg.currentStructType,
      });
    }
    return walk(alt, ctx, arg);
  });

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
