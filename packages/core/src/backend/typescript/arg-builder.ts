import type { BoundType, BoundVariant } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";

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
  return isExpr(r) ? `cargs.push(${r.expr});` : r.stmt;
}

function appendLines(cb: CodeBuilder, code: string): void {
  for (const line of code.split("\n")) cb.line(line);
}

// -- Type helpers --

/**
 * Whether a BoundType contains a struct that requires scoping
 * paramsVar when entering its wrapper (optional, repeat).
 */
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

/** Unwrap optional/list to find the inner struct type. */
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
    if (type.scalar === "path") return `execution.inputFile(${expr})`;
  }
  return `String(${expr})`;
}

// -- Context passed down through recursion --

interface ArgContext {
  /** Base path for field access (e.g. "params", "params.range", "item0"). */
  paramsVar: string;
  /** Join nesting depth (controls ternary vs if-statement for optionals). */
  joinDepth: number;
  /**
   * When set, the next binding's value is directly at this path
   * rather than at `paramsVar.bindingName`.
   *
   * This handles solver sequence collapse: when `seq(lit, T)` collapses to just T,
   * the parent wrapper (optional, repeat) holds the value at its own access path.
   * The child binding still exists with its original name, but that name isn't a
   * valid access path - the value lives at `directValue` instead.
   *
   * Consumed by the first binding that uses it. Reset when entering scoped
   * contexts (struct sequences, complex union variants).
   */
  directValue?: string;
  /** The struct type at the current scope level (prevents double-scoping). */
  currentStructType?: BoundType;
}

/** Resolve the access path for a binding in the current context. */
function resolveAccess(arg: ArgContext, bindingName: string): string {
  return arg.directValue ?? `${arg.paramsVar}.${bindingName}`;
}

// -- Recursive descent --

let loopVarCounter = 0;

/**
 * Build arg-building code for an IR tree via recursive descent.
 *
 * Context flows down via the immutable `arg` parameter (access paths, join depth, etc.).
 * Results flow up via return values (expressions or statement blocks).
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
      return { expr: JSON.stringify(node.attrs.str) };

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

  // Compute child context: scope into nested struct if needed
  const needsScope =
    binding && hasStructScope(binding.type) && binding.type !== arg.currentStructType;
  const childArg: ArgContext = needsScope
    ? {
        ...arg,
        paramsVar: `${arg.paramsVar}.${binding!.name}`,
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
    return { expr: `[${exprs.join(", ")}].join(${JSON.stringify(join)})` };
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
  const access = `${arg.paramsVar}.${binding.name}`;

  // Compute child context based on the inner type
  let childArg: ArgContext;
  if (hasStructScope(binding.type)) {
    // Struct inside optional: scope paramsVar so children access fields directly
    const inner = unwrapToStruct(binding.type);
    childArg = {
      ...arg,
      paramsVar: access,
      directValue: undefined,
      currentStructType: inner ?? arg.currentStructType,
    };
  } else if (binding.type.kind === "optional" || binding.type.kind === "bool") {
    // Collapsed non-struct: the value is at the optional's access path.
    // The inner binding (scalar, union, list, count) was folded into the optional
    // by the solver, so its name is a phantom - directValue tells the inner
    // walker to use this path instead of paramsVar.bindingName.
    childArg = { ...arg, directValue: access };
  } else {
    childArg = arg;
  }

  const inner = walk(node.attrs.node, ctx, childArg);

  // Inside a join context, emit as ternary expression
  if (arg.joinDepth > 0 && isExpr(inner)) {
    if (binding.type.kind === "optional") {
      return { expr: `(${access} != null ? ${inner.expr} : "")` };
    }
    return { expr: `(${access} ? ${inner.expr} : "")` };
  }

  const cb = new CodeBuilder("  ");
  const innerStmt = resultToStmt(inner);
  if (binding.type.kind === "optional") {
    cb.line(`if (${access} != null) {`);
    cb.indent(() => appendLines(cb, innerStmt));
    cb.line("}");
  } else {
    cb.line(`if (${access}) {`);
    cb.indent(() => appendLines(cb, innerStmt));
    cb.line("}");
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
  const join = node.attrs.join;
  const access = resolveAccess(arg, binding.name);

  // Count repeat: emit a counted for-loop
  if (binding.type.kind === "count") {
    const inner = walk(node.attrs.node, ctx, arg);
    const v = `i${loopVarCounter++}`;
    const cb = new CodeBuilder("  ");
    cb.line(`for (let ${v} = 0; ${v} < ${access}; ${v}++) {`);
    cb.indent(() => appendLines(cb, resultToStmt(inner)));
    cb.line("}");
    return { stmt: cb.toString() };
  }

  // List repeat: emit a for-of loop or .map().join()
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
    return { expr: `${access}.map((${loopVar}) => ${inner.expr}).join(${JSON.stringify(join)})` };
  }

  const cb = new CodeBuilder("  ");
  cb.line(`for (const ${loopVar} of ${access}) {`);
  cb.indent(() => appendLines(cb, resultToStmt(inner)));
  cb.line("}");
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

  // For complex unions (struct variants), scope paramsVar into the union's
  // access path so variant children resolve fields correctly (e.g. params.source.file)
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
    return { expr: `String(${access})` };
  }

  if (binding.type.kind === "bool") {
    // Inside a join, the alternative's output must be an expression, not a
    // statement: dropping an `if/else` block into a `[...].join("")` list
    // literal is not valid TypeScript. Emit a ternary when both arms are exprs.
    if (arg.joinDepth > 0 && variants.every(isExpr)) {
      const v0 = (variants[0] as Expr_).expr;
      const v1 = variants[1] ? (variants[1] as Expr_).expr : '""';
      return { expr: `(${access} ? ${v0} : ${v1})` };
    }
    const cb = new CodeBuilder("  ");
    cb.line(`if (${access}) {`);
    cb.indent(() => appendLines(cb, resultToStmt(variants[0]!)));
    if (variants[1]) {
      cb.line("} else {");
      cb.indent(() => appendLines(cb, resultToStmt(variants[1]!)));
    }
    cb.line("}");
    return { stmt: cb.toString() };
  }

  if (binding.type.kind === "union") {
    const unionType = binding.type;
    // Inside a join: chained ternary, same reason as bool above.
    if (arg.joinDepth > 0 && variants.every(isExpr)) {
      let expr = '""';
      for (let i = unionType.variants.length - 1; i >= 0; i--) {
        const variant = unionType.variants[i]!;
        const v = (variants[i] as Expr_).expr;
        expr = `(${access}["@type"] === ${JSON.stringify(variant.name ?? "")} ? ${v} : ${expr})`;
      }
      return { expr };
    }
    const cb = new CodeBuilder("  ");
    cb.line(`switch (${access}["@type"]) {`);
    cb.indent(() => {
      for (let i = 0; i < unionType.variants.length; i++) {
        const variant = unionType.variants[i]!;
        cb.line(`case ${JSON.stringify(variant.name)}: {`);
        cb.indent(() => {
          appendLines(cb, resultToStmt(variants[i]!));
          cb.line("break;");
        });
        cb.line("}");
      }
    });
    cb.line("}");
    return { stmt: cb.toString() };
  }

  return { stmt: variants.map(resultToStmt).join("\n") };
}
