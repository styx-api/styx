import type { Binding, BindingId, BoundType, BoundVariant } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { renderAccess } from "./emit.js";

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

function toStringExpr(node: Expr, type: BoundType, expr: string): string {
  if (type.kind === "scalar") {
    if (type.scalar === "str") return expr;
    if (type.scalar === "path") return pathArg(node, expr);
  }
  return `String(${expr})`;
}

/**
 * Command-line value for a path input via `execution.inputFile`. The styxdefs
 * signature is `inputFile(hostFile, resolveParent?, mutable?)`, so `mutable`
 * requires supplying `resolveParent` positionally first. `mutable=true` tells
 * the runner to stage a writable COPY (original untouched) and return the copy's
 * command-line path; the outputs builder surfaces that same copy's host path via
 * `execution.mutableCopy`.
 */
function pathArg(node: Expr, expr: string): string {
  if (node.kind !== "path") return `execution.inputFile(${expr})`;
  const { resolveParent, mutable } = node.attrs;
  if (mutable) return `execution.inputFile(${expr}, ${resolveParent ? "true" : "false"}, true)`;
  if (resolveParent) return `execution.inputFile(${expr}, true)`;
  return `execution.inputFile(${expr})`;
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
}

/** Render a binding's solver-assigned access path in the current loop scope. */
function accessOf(binding: Binding, arg: ArgContext): string {
  return renderAccess(binding.access, (b) => {
    const v = arg.loopVars.get(b);
    if (v === undefined) throw new Error(`arg-builder: unbound loop variable for binding ${b}`);
    return v;
  });
}

// -- Recursive descent --

let loopVarCounter = 0;

/**
 * Build arg-building code for an IR tree via recursive descent.
 *
 * Context flows down via the immutable `arg` parameter (access paths, join depth, etc.).
 * Results flow up via return values (expressions or statement blocks).
 */
export function buildArgs(rootExpr: Expr, ctx: CodegenContext, _rootType?: BoundType): ArgResult {
  loopVarCounter = 0;
  const initialCtx: ArgContext = {
    joinDepth: 0,
    loopVars: new Map(),
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
  const access = accessOf(binding, arg);
  return { expr: toStringExpr(node, binding.type, access) };
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
  const access = accessOf(binding, arg);

  // The inner node's access path is solver-assigned (it either inherits this
  // optional's path on a collapse, or scopes into it for a struct), so no scope
  // context needs threading - only the existing loop scope and join depth.
  const inner = walk(node.attrs.node, ctx, arg);

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
  // A non-join repeat inside an outer join concatenates rather than pushing
  // separate args, mirroring walkSequence's handling of bare non-join seqs.
  const join = node.attrs.join ?? (arg.joinDepth > 0 ? "" : undefined);
  const access = accessOf(binding, arg);

  // Count repeat: emit a counted for-loop. Inside a join the for-loop would
  // be dropped into a list literal as raw text, so emit `Array.from` instead.
  if (binding.type.kind === "count") {
    const inner = walk(node.attrs.node, ctx, arg);
    const v = `i${loopVarCounter++}`;
    if (join !== undefined && isExpr(inner)) {
      return {
        expr: `Array.from({length: ${access}}, (_, ${v}) => ${inner.expr}).join(${JSON.stringify(join)})`,
      };
    }
    const cb = new CodeBuilder("  ");
    cb.line(`for (let ${v} = 0; ${v} < ${access}; ${v}++) {`);
    cb.indent(() => appendLines(cb, resultToStmt(inner)));
    cb.line("}");
    return { stmt: cb.toString() };
  }

  // List repeat: emit a for-of loop or .map().join(). The loop variable is
  // registered under this repeat's binding id so inner bindings' `iter`
  // segments resolve to it via `renderAccess`.
  const loopVar = `item${loopVarCounter++}`;
  const childArg: ArgContext = {
    ...arg,
    loopVars: new Map(arg.loopVars).set(binding.id, loopVar),
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
  const access = accessOf(binding, arg);

  // Complex-union variant fields already carry the union's path in their
  // solver-assigned access, so arms walk with the current context unchanged.
  const variants = node.attrs.alts.map((alt) => walk(alt, ctx, arg));

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
      let structExpr = '""';
      for (let k = structVariants.length - 1; k >= 0; k--) {
        const { variant, i } = structVariants[k]!;
        const v = (variants[i] as Expr_).expr;
        structExpr = `(${access}["@type"] === ${JSON.stringify(variant.name ?? "")} ? ${v} : ${structExpr})`;
      }
      if (!hasLiteral) return { expr: structExpr };
      // Mixed: an object value dispatches by `@type`; a bare literal is itself.
      return {
        expr: `(typeof ${access} === "object" && ${access} !== null ? ${structExpr} : String(${access}))`,
      };
    }

    const cb = new CodeBuilder("  ");
    // `switch` (not an `if`/`else if` ===-chain): each `case` narrows the
    // discriminated union, whereas a chain accumulates narrowing and TS rejects
    // later arms (TS2367).
    const emitStructSwitch = (): void => {
      cb.line(`switch (${access}["@type"]) {`);
      cb.indent(() => {
        for (const { variant, i } of structVariants) {
          cb.line(`case ${JSON.stringify(variant.name ?? "")}: {`);
          cb.indent(() => {
            appendLines(cb, resultToStmt(variants[i]!));
            cb.line("break;");
          });
          cb.line("}");
        }
      });
      cb.line("}");
    };
    if (!hasLiteral) {
      emitStructSwitch();
      return { stmt: cb.toString() };
    }
    // Mixed union: branch on runtime shape. `typeof === "object"` narrows to the
    // struct variants; the `else` to the bare-literal members.
    cb.line(`if (typeof ${access} === "object" && ${access} !== null) {`);
    cb.indent(emitStructSwitch);
    cb.line(`} else {`);
    cb.indent(() => appendLines(cb, resultToStmt({ expr: `String(${access})` })));
    cb.line(`}`);
    return { stmt: cb.toString() };
  }

  return { stmt: variants.map(resultToStmt).join("\n") };
}
