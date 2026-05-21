import type {
  BindingId,
  BoundType,
  GateAtom,
  ResolvedOutput,
  ResolvedToken,
} from "../../bindings/index.js";
import { outputGate } from "../../bindings/index.js";
import type { Expr } from "../../ir/index.js";
import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import { emitDocstring } from "./emit.js";
import { pyStr } from "./typemap.js";

/**
 * Field shape for a single resolved output.
 *
 * - `single`: emitted at most once. Optional iff any `present`/`variant` atom
 *   appears in the gate -> `OutputPathType | None`.
 * - `list`: emitted once per element of an iterated binding (any `iter`
 *   atom in the gate) -> `list[OutputPathType]`. Gated lists still type as
 *   `list[OutputPathType]` - the empty list stands for "nothing produced".
 */
type OutputShape = { kind: "single"; optional: boolean } | { kind: "list" };

function outputShape(gate: GateAtom[]): OutputShape {
  const iter = gate.some((a) => a.kind === "iter");
  if (iter) return { kind: "list" };
  const optional = gate.some((a) => a.kind === "present" || a.kind === "variant");
  return { kind: "single", optional };
}

function outputTypeExpr(shape: OutputShape): string {
  if (shape.kind === "list") return "list[OutputPathType]";
  return shape.optional ? "OutputPathType | None" : "OutputPathType";
}

/** Has any scope in the context attached at least one output? */
export function hasAnyOutputs(ctx: CodegenContext): boolean {
  return ctx.outputScopes.some((s) => s.outputs.length > 0);
}

/** Emit `@dataclasses.dataclass\nclass <outputsType>:` declaration. */
export function emitOutputsClass(
  ctx: CodegenContext,
  outputsType: string,
  cb: CodeBuilder,
): void {
  cb.line("@dataclasses.dataclass");
  cb.line(`class ${outputsType}:`);
  cb.indent(() => {
    emitDocstring(cb, "Output paths produced by the tool.");
    let emitted = false;
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) {
        const gate = outputGate(scopeGate, output, ctx.bindings);
        const shape = outputShape(gate);
        const fieldName = pyId(output.name);
        const typeExpr = outputTypeExpr(shape);
        cb.line(`${fieldName}: ${typeExpr}`);
        const doc = output.doc?.description ?? output.doc?.title;
        if (doc) emitDocstring(cb, doc);
        emitted = true;
      }
    }
    if (!emitted) cb.line("pass");
  });
}

/** Per-binding access-path map. */
type AccessMap = Map<BindingId, string>;

function buildAccessMap(ctx: CodegenContext): AccessMap {
  const out: AccessMap = new Map();
  walkAccess(ctx.expr, ctx, "params", out);
  return out;
}

function walkAccess(node: Expr, ctx: CodegenContext, base: string, out: AccessMap): void {
  const binding = ctx.resolve(node);

  switch (node.kind) {
    case "literal":
    case "int":
    case "float":
    case "str":
    case "path": {
      if (binding) out.set(binding.id, base);
      return;
    }
    case "sequence": {
      if (binding && binding.type.kind === "struct") {
        out.set(binding.id, base);
        for (const child of node.attrs.nodes) {
          const childBinding = ctx.resolve(child);
          if (childBinding) {
            walkAccess(child, ctx, `${base}[${pyStr(childBinding.name)}]`, out);
          } else {
            walkAccess(child, ctx, base, out);
          }
        }
      } else {
        if (binding) out.set(binding.id, base);
        for (const child of node.attrs.nodes) walkAccess(child, ctx, base, out);
      }
      return;
    }
    case "optional": {
      if (binding) {
        out.set(binding.id, base);
        walkAccess(node.attrs.node, ctx, base, out);
      } else {
        walkAccess(node.attrs.node, ctx, base, out);
      }
      return;
    }
    case "repeat": {
      if (binding) out.set(binding.id, base);
      return;
    }
    case "alternative": {
      if (binding) out.set(binding.id, base);
      for (const alt of node.attrs.alts) {
        walkAccess(alt, ctx, base, out);
      }
      return;
    }
  }
}

type IterScope = Map<BindingId, string>;

interface OutputEmitCtx {
  ctx: CodegenContext;
  access: AccessMap;
  iter: IterScope;
}

interface WrapperRender {
  open: string;
  loopVar?: string;
}

let loopCounter = 0;

function renderWrapperOpen(atom: GateAtom, ec: OutputEmitCtx): WrapperRender {
  if (atom.kind === "iter") {
    const access = bindingAccess(atom.binding, ec);
    const v = `__o${loopCounter++}`;
    return { open: `for ${v} in ${access}:`, loopVar: v };
  }
  if (atom.kind === "variant") {
    const access = bindingAccess(atom.binding, ec);
    return { open: `if ${access}["@type"] == ${pyStr(atom.variant)}:` };
  }
  // present
  const binding = ec.ctx.bindings.get(atom.binding);
  const access = bindingAccess(atom.binding, ec);
  const cond = presentCondition(binding?.type, access);
  return { open: `if ${cond}:` };
}

function presentCondition(type: BoundType | undefined, access: string): string {
  if (!type) return access;
  switch (type.kind) {
    case "optional":
      return `${access} is not None`;
    case "bool":
      return access;
    case "count":
      return `${access} > 0`;
    default:
      return access;
  }
}

function bindingAccess(id: BindingId, ec: OutputEmitCtx): string {
  const subst = ec.iter.get(id);
  if (subst) return subst;
  const access = ec.access.get(id);
  if (access) return access;
  return `None  # unresolved binding ${id}`;
}

/** Render the path expression for an output's tokens. */
function renderPathExpr(tokens: ResolvedToken[], ec: OutputEmitCtx): string {
  if (tokens.length === 0) return `""`;
  if (tokens.length === 1) return renderToken(tokens[0]!, ec);
  // f-string interpolation. Use a single-quoted outer so embedded subscript
  // expressions like `params["key"]` (with double quotes) don't collide with
  // the outer quote - PEP 701 (Python 3.12+) lifts this restriction, but we
  // target 3.10+.
  let result = "f'";
  for (const tok of tokens) {
    if (tok.kind === "literal") {
      // Escape backslashes, single quotes, and braces (the latter are f-string
      // metacharacters).
      result += tok.value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\{/g, "{{")
        .replace(/\}/g, "}}");
    } else {
      result += "{";
      result += renderRefValue(tok, ec);
      result += "}";
    }
  }
  result += "'";
  return result;
}

function renderToken(tok: ResolvedToken, ec: OutputEmitCtx): string {
  if (tok.kind === "literal") return pyStr(tok.value);
  return renderRefValue(tok, ec);
}

function renderRefValue(tok: Extract<ResolvedToken, { kind: "ref" }>, ec: OutputEmitCtx): string {
  let expr = bindingAccess(tok.binding, ec);
  if (tok.fallback !== undefined) {
    expr = `(${expr} if ${expr} is not None else ${pyStr(tok.fallback)})`;
  }
  if (tok.stripExtensions && tok.stripExtensions.length > 0) {
    const sorted = [...tok.stripExtensions].sort((a, b) => b.length - a.length);
    const lits = sorted.map((s) => pyStr(s)).join(", ");
    expr = `_strip_extensions(${expr}, [${lits}])`;
  }
  return expr;
}

/**
 * Emit one output: initialize a local variable, then descend into the wrapper
 * stack to assign or append.
 */
function emitOneOutput(
  output: ResolvedOutput,
  gate: GateAtom[],
  ec: OutputEmitCtx,
  cb: CodeBuilder,
): { localVar: string } {
  const shape = outputShape(gate);
  const localVar = `${pyId(output.name)}_v`;
  const typeAnnot = outputTypeExpr(shape);

  if (shape.kind === "list") {
    cb.line(`${localVar}: ${typeAnnot} = []`);
  } else if (shape.optional) {
    cb.line(`${localVar}: ${typeAnnot} = None`);
  }
  // For required-single (no gate), assignment is the very next line (no init).

  function nest(remaining: GateAtom[], child: OutputEmitCtx): void {
    if (remaining.length === 0) {
      const pathExpr = renderPathExpr(output.tokens, child);
      const call = `execution.output_file(${pathExpr})`;
      if (shape.kind === "list") {
        cb.line(`${localVar}.append(${call})`);
      } else if (shape.optional) {
        cb.line(`${localVar} = ${call}`);
      } else {
        cb.line(`${localVar}: ${typeAnnot} = ${call}`);
      }
      return;
    }
    const [head, ...rest] = remaining;
    if (!head) return;
    const wrapper = renderWrapperOpen(head, child);
    cb.line(wrapper.open);
    cb.indent(() => {
      const inner =
        head.kind === "iter"
          ? { ...child, iter: new Map(child.iter).set(head.binding, wrapper.loopVar!) }
          : child;
      nest(rest, inner);
    });
  }

  nest(gate, ec);
  return { localVar };
}

/**
 * Emit a standalone `_outputs(params, execution)` function that builds and
 * returns the `Outputs` dataclass. Mirrors the `_cargs` function so the
 * wrapper can just call both.
 */
export function emitBuildOutputs(
  ctx: CodegenContext,
  paramsType: string,
  outputsType: string,
  funcName: string,
  cb: CodeBuilder,
): void {
  cb.line(
    `def ${funcName}(params: ${paramsType}, execution: Execution) -> ${outputsType}:`,
  );
  cb.indent(() => {
    cb.line(`"""Build the ${outputsType} object for this tool."""`);
    loopCounter = 0;
    const ec: OutputEmitCtx = {
      ctx,
      access: buildAccessMap(ctx),
      iter: new Map(),
    };

    const fieldAssigns: Array<{ name: string; localVar: string }> = [];
    for (const scope of ctx.outputScopes) {
      const scopeBinding = ctx.bindings.get(scope.scope);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const output of scope.outputs) {
        const gate = outputGate(scopeGate, output, ctx.bindings);
        const { localVar } = emitOneOutput(output, gate, ec, cb);
        fieldAssigns.push({ name: pyId(output.name), localVar });
      }
    }

    if (fieldAssigns.length === 0) {
      cb.line(`return ${outputsType}()`);
    } else {
      cb.line(`return ${outputsType}(`);
      cb.indent(() => {
        for (const { name, localVar } of fieldAssigns) {
          cb.line(`${name}=${localVar},`);
        }
      });
      cb.line(")");
    }
  });
}

// Python keywords that can't be used as dataclass field names or kwarg keys.
// Mirrors `PY_KEYWORDS` in emit.ts (kept local to avoid the import cycle).
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
  "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/** Sanitize an output name to a valid Python identifier. */
function pyId(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^\d/.test(s)) s = "_" + s;
  if (s === "") s = "_";
  if (PY_KEYWORDS.has(s)) s = s + "_";
  return s;
}

/** Whether any output reference has stripExtensions set. */
export function needsStripExtensionsHelper(ctx: CodegenContext): boolean {
  for (const scope of ctx.outputScopes) {
    for (const output of scope.outputs) {
      for (const tok of output.tokens) {
        if (tok.kind === "ref" && tok.stripExtensions?.length) return true;
      }
    }
  }
  return false;
}

/** Emit a small `_strip_extensions` helper used by ref tokens that strip suffixes. */
export function emitStripExtensionsHelper(cb: CodeBuilder): void {
  cb.line("def _strip_extensions(value: str, exts: list[str]) -> str:");
  cb.indent(() => {
    cb.line("for ext in exts:");
    cb.indent(() => {
      cb.line("if value.endswith(ext):");
      cb.indent(() => {
        cb.line("return value[: -len(ext)]");
      });
    });
    cb.line("return value");
  });
}
