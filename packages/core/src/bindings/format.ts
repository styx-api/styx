import type { Expr } from "../ir/node.js";
import type { BindingRegistry } from "./binding.js";
import type { SolveResult } from "./index.js";
import type { GateAtom, ResolvedOutput, ResolvedToken } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export function formatSolveResult(result: SolveResult, expr: Expr): string {
  const binding = result.resolve(expr);
  const rootLine = binding ? `${binding.name}: ${formatType(binding.type)}` : "(no binding)";

  const sections = [rootLine];
  if (result.outputs.length > 0) {
    sections.push("", "outputs:");
    for (const out of result.outputs) {
      sections.push(formatResolvedOutput(out, result.bindings, 1));
    }
  }
  const diags = [...result.outputDiagnostics.errors, ...result.outputDiagnostics.warnings];
  if (diags.length > 0) {
    sections.push("", "diagnostics:");
    for (const d of diags) {
      sections.push(`  [${d.level}] ${d.output}: ${d.message}`);
    }
  }
  return sections.join("\n");
}

function bindingName(bindings: BindingRegistry, id: string): string {
  return bindings.get(id)?.name ?? `<${id}>`;
}

function formatResolvedToken(token: ResolvedToken, bindings: BindingRegistry): string {
  if (token.kind === "literal") return JSON.stringify(token.value);
  const flags = [
    token.stripExtensions?.length && `strip=${JSON.stringify(token.stripExtensions)}`,
    token.fallback !== undefined && `fallback=${JSON.stringify(token.fallback)}`,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` {${flags.join(", ")}}` : "";
  return `ref(${bindingName(bindings, token.binding)})${suffix}`;
}

function formatGateAtom(atom: GateAtom, bindings: BindingRegistry): string {
  if (atom.kind === "present") return `present(${bindingName(bindings, atom.binding)})`;
  return `${bindingName(bindings, atom.binding)}=${atom.variant}`;
}

function formatBranchCondition(
  branchCondition: GateAtom[][],
  bindings: BindingRegistry,
): string {
  // Outer = disjunction, inner = conjunction. Skip the "[[]]" trivial guard.
  const meaningful = branchCondition.filter((conj) => conj.length > 0);
  if (meaningful.length === 0) return "";
  const clauses = meaningful.map(
    (conj) => `(${conj.map((a) => formatGateAtom(a, bindings)).join(" AND ")})`,
  );
  return ` when ${clauses.join(" OR ")}`;
}

function formatResolvedOutput(
  out: ResolvedOutput,
  bindings: BindingRegistry,
  indent: number,
): string {
  const pad = "  ".repeat(indent);
  const optional = out.optional ? " [optional]" : "";
  const media = out.mediaTypes?.length ? ` (${out.mediaTypes.join(", ")})` : "";
  const tokens = out.tokens.map((t) => formatResolvedToken(t, bindings)).join(" + ") || `""`;
  const gate = formatBranchCondition(out.branchCondition, bindings);
  const listScope =
    out.listScope.length > 0
      ? ` for each ${out.listScope.map((id) => bindingName(bindings, id)).join(", ")}`
      : "";
  return `${pad}${out.name}${optional}${media}: ${tokens}${gate}${listScope}`;
}

function formatType(type: BoundType, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = (t: BoundType) => formatType(t, indent + 1);

  switch (type.kind) {
    case "scalar":
      return type.scalar;
    case "bool":
      return "bool";
    case "count":
      return "count";
    case "literal":
      return typeof type.value === "number" ? String(type.value) : `"${type.value}"`;
    case "optional":
      return `optional<${inner(type.inner)}>`;
    case "list":
      return `list<${inner(type.item)}>`;

    case "struct": {
      const entries = Object.entries(type.fields);
      if (entries.length === 0) return "struct {}";
      if (entries.length === 1) {
        const [name, t] = entries[0]!;
        return `struct { ${name}: ${formatType(t)} }`;
      }
      const fields = entries.map(([name, t]) => `${pad}  ${name}: ${inner(t)}`).join("\n");
      return `struct {\n${fields}\n${pad}}`;
    }

    case "union": {
      if (type.variants.length === 0) return "union {}";

      // If all variants are literals, display inline
      const allLiterals = type.variants.every((v) => v.type.kind === "literal");
      if (allLiterals) {
        return type.variants
          .map((v) =>
            v.type.kind === "literal"
              ? typeof v.type.value === "number"
                ? String(v.type.value)
                : `"${v.type.value}"`
              : "?",
          )
          .join(" | ");
      }

      // Otherwise multi-line union
      const variants = type.variants.map((v) => `${pad}  | ${v.name}: ${inner(v.type)}`).join("\n");
      return `union {\n${variants}\n${pad}}`;
    }

    default:
      return ((_x: never) => "unknown")(type);
  }
}
