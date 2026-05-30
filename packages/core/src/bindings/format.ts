import type { Expr } from "../ir/node.js";
import type { AccessPath, BindingRegistry, OutputValidationResult } from "./binding.js";
import type { SolveResult } from "./index.js";
import { outputGate } from "./output-gate.js";
import type { GateAtom, OutputScope, ResolvedOutput, ResolvedToken } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export interface FormatExtras {
  scopes?: OutputScope[];
  diagnostics?: OutputValidationResult;
}

export function formatSolveResult(result: SolveResult, expr: Expr, extras?: FormatExtras): string {
  const binding = result.resolve(expr);
  const rootLine = binding ? `${binding.name}: ${formatType(binding.type)}` : "(no binding)";

  const sections = [rootLine];

  const gatedBindings = [...result.bindings.values()].filter(
    (b) => b.gate.length > 0 && b !== binding,
  );
  if (gatedBindings.length > 0) {
    sections.push("", "gates:");
    for (const b of gatedBindings) {
      sections.push(`  ${b.name}: ${formatGate(b.gate, result.bindings)}`);
    }
  }

  const accessBindings = [...result.bindings.values()].filter((b) => b.access.length > 0);
  if (accessBindings.length > 0) {
    sections.push("", "access:");
    for (const b of accessBindings) {
      sections.push(`  ${b.name}: ${formatAccess(b.access, result.bindings)}`);
    }
  }

  if (extras?.scopes?.length) {
    sections.push("", "outputs:");
    for (const scope of extras.scopes) {
      const scopeBinding = result.bindings.get(scope.scope);
      const header = scopeBinding ? `  on ${scopeBinding.name}:` : "  on <unbound>:";
      sections.push(header);
      const scopeGate = scopeBinding?.gate ?? [];
      for (const out of scope.outputs) {
        sections.push(formatResolvedOutput(out, scopeGate, result.bindings, 2));
      }
    }
  }

  const diags = [...(extras?.diagnostics?.errors ?? []), ...(extras?.diagnostics?.warnings ?? [])];
  if (diags.length > 0) {
    sections.push("", "diagnostics:");
    for (const d of diags) sections.push(`  [${d.level}] ${d.output}: ${d.message}`);
  }

  return sections.join("\n");
}

function formatResolvedOutput(
  out: ResolvedOutput,
  scopeGate: GateAtom[],
  bindings: BindingRegistry,
  indent: number,
): string {
  const pad = "  ".repeat(indent);
  const media = out.mediaTypes?.length ? ` (${out.mediaTypes.join(", ")})` : "";
  const tokens = out.tokens.map((t) => formatResolvedToken(t, bindings)).join(" + ") || `""`;
  const gateAtoms = outputGate(scopeGate, out, bindings);
  const optional = gateAtoms.some((a) => a.kind === "present" || a.kind === "variant");
  const optTag = optional ? " [optional]" : "";
  const gate =
    gateAtoms.length > 0
      ? ` when (${gateAtoms.map((a) => formatGateAtom(a, bindings)).join(" AND ")})`
      : "";
  return `${pad}${out.name}${optTag}${media}: ${tokens}${gate}`;
}

function bindingName(bindings: BindingRegistry, id: string): string {
  return bindings.get(id)?.name ?? `<${id}>`;
}

export function formatResolvedToken(token: ResolvedToken, bindings: BindingRegistry): string {
  if (token.kind === "literal") return JSON.stringify(token.value);
  const flags = [
    token.stripExtensions?.length && `strip=${JSON.stringify(token.stripExtensions)}`,
    token.fallback !== undefined && `fallback=${JSON.stringify(token.fallback)}`,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` {${flags.join(", ")}}` : "";
  return `ref(${bindingName(bindings, token.binding)})${suffix}`;
}

export function formatGateAtom(atom: GateAtom, bindings: BindingRegistry): string {
  switch (atom.kind) {
    case "present":
      return `present(${bindingName(bindings, atom.binding)})`;
    case "variant":
      return `${bindingName(bindings, atom.binding)}=${atom.variant}`;
    case "iter":
      return `iter(${bindingName(bindings, atom.binding)})`;
  }
}

export function formatGate(gate: GateAtom[], bindings: BindingRegistry): string {
  if (gate.length === 0) return "(unconditional)";
  return gate.map((a) => formatGateAtom(a, bindings)).join(" / ");
}

/**
 * Render a binding's access path for debugging, e.g. `params.sub.x` or
 * `<iter:things>.file`. An `iter` segment shows the repeat it loops, since the
 * concrete loop variable is a backend emit-time detail.
 */
export function formatAccess(access: AccessPath, bindings: BindingRegistry): string {
  let out = "params";
  for (const seg of access) {
    out =
      seg.kind === "field" ? `${out}.${seg.name}` : `<iter:${bindingName(bindings, seg.binding)}>`;
  }
  return out;
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
