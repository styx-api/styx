import type { Expr } from "../ir/node.js";
import type {
  AccessPath,
  Binding,
  BindingId,
  BindingRegistry,
  OutputValidationResult,
} from "./binding.js";
import type { SolveResult } from "./index.js";
import { outputGate } from "./output-gate.js";
import type { GateAtom, OutputScope, ResolvedOutput, ResolvedToken } from "./resolved-output.js";
import type { BoundType } from "./types.js";

export interface FormatExtras {
  scopes?: OutputScope[];
  diagnostics?: OutputValidationResult;
}

/**
 * Resolves a binding id to its display name. Every name a dump prints comes
 * from one namer, so a row label and each reference to it (`ref(...)`,
 * `<iter:...>`, an output scope) always agree on which binding is meant.
 */
type Namer = (id: BindingId) => string;

export function formatSolveResult(result: SolveResult, expr: Expr, extras?: FormatExtras): string {
  const root = result.resolve(expr);
  const layout = layoutBindings(result.bindings, root);
  // Name in layout order so a disambiguating counter reads top-to-bottom.
  const ordered = layout.map((r) => r.binding);
  const name = createNamer(root ? [root, ...ordered] : ordered);

  const sections = [root ? `${name(root.id)}: ${formatType(root.type)}` : "(no binding)"];

  if (layout.length > 0) sections.push("", "bindings:", ...layout.map((r) => formatRow(r, name)));

  if (extras?.scopes?.length) {
    sections.push("", "outputs:");
    for (const scope of extras.scopes) {
      const scopeBinding = result.bindings.get(scope.scope);
      sections.push(`  on ${scopeBinding ? name(scopeBinding.id) : "<unbound>"}:`);
      for (const out of scope.outputs) {
        sections.push(
          formatResolvedOutput(out, scopeBinding?.gate ?? [], result.bindings, name, 2),
        );
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

interface Row {
  binding: Binding;
  depth: number;
}

/**
 * Lay every binding out as a tree indented by its gate:
 *
 *     center_of_gravity#flag: params.center_of_gravity
 *       center_of_gravity#list: params.center_of_gravity
 *         center_of_gravity#element: <iter:center_of_gravity#list>
 *
 * A binding's gate is the chain of wrapper bindings above it, and each wrapper
 * registers under that chain minus itself, so nesting a row beneath the owner
 * of its last gate atom lays the whole chain out positionally. The wrapper
 * layers one parameter expands into then stack visibly instead of reading as
 * duplicate rows, and no row has to restate its ancestors as
 * `present(...) / iter(...)`.
 *
 * Nesting follows the gate, not containment: a struct's fields carry the same
 * gate as the struct, so they render as its siblings. Containment is what the
 * access path on each row shows.
 */
function layoutBindings(bindings: BindingRegistry, root: Binding | undefined): Row[] {
  const children = new Map<BindingId | null, Binding[]>();
  for (const b of bindings.values()) {
    const owner = b.gate[b.gate.length - 1]?.binding;
    const parent = owner !== undefined && bindings.has(owner) ? owner : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(b);
    else children.set(parent, [b]);
  }

  const rows: Row[] = [];
  const seen = new Set<BindingId>();

  // Gates are built by descent and cannot cycle; `seen` only keeps a
  // hand-built registry from spinning here.
  const walk = (parent: BindingId | null, depth: number): void => {
    for (const binding of children.get(parent) ?? []) {
      if (seen.has(binding.id)) continue;
      seen.add(binding.id);
      // The root's type is already spelled out in full on the first line, so it
      // gets no row and its children do not indent past it.
      if (binding === root) {
        walk(binding.id, depth);
        continue;
      }
      rows.push({ binding, depth });
      walk(binding.id, depth + 1);
    }
  };
  walk(null, 0);

  return rows;
}

function formatRow({ binding, depth }: Row, name: Namer): string {
  const label = name(binding.id);
  // Sibling rows under one union come from different arms; mark which, unless
  // the label already says so - it was disambiguated by arm, or it is the arm.
  const arm = innermostArm(binding.gate);
  const stated = arm !== undefined && (binding.name === arm || label.endsWith(`#${arm}`));
  const tag = arm !== undefined && !stated ? ` [${arm}]` : "";
  return `${"  ".repeat(depth + 1)}${label}${tag}: ${formatAccess(binding.access, name)}`;
}

/**
 * Give every binding a name that is unique across the dump.
 *
 * Co-named bindings are normal rather than a defect: one `opt("-c", rep(float))`
 * produces a presence flag, a list and an element all named
 * `center_of_gravity`, two of which even share an access path (the solver's
 * wrapper collapse). Those take a `#qualifier` suffix; names that are already
 * unique stay bare, so the common case reads clean.
 *
 * `ordered` fixes both which name wins and how the tie-break counter climbs, so
 * pass bindings in the order they will be printed.
 */
function createNamer(ordered: Binding[]): Namer {
  const shared = new Set<string>();
  const seen = new Set<string>();
  // A repeat nobody loops over collapsed to a `count`. This reads the registry
  // rather than the repeat's own type because a repeat used directly as a union
  // arm gets retyped to the boxed variant struct, losing the `count` kind.
  const looped = new Set<BindingId>();
  for (const b of ordered) {
    if (seen.has(b.name)) shared.add(b.name);
    seen.add(b.name);
    for (const atom of b.gate) if (atom.kind === "iter") looped.add(atom.binding);
  }

  // One `used` set spanning every name, so a qualifier, a tie-break counter and
  // a descriptor name that already contains a `#` cannot land on one string.
  // Names arrive verbatim from the descriptor, so `x#flag2` is a real input.
  const used = new Set<string>();
  const names = new Map<BindingId, string>();
  for (const b of ordered) {
    const base = shared.has(b.name) ? `${b.name}#${qualifier(b, looped)}` : b.name;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}${n}`;
    used.add(name);
    names.set(b.id, name);
  }

  return (id) => names.get(id) ?? `<${id}>`;
}

/**
 * What sets a binding apart from the others sharing its name.
 *
 * Wrapper bindings answer with their layer, taken from the node the solver
 * bound - authoritative about which layer registered the binding, and correct
 * however deeply the parameter is nested. Leaves answer with the union arm they
 * sit in, since co-named leaves are usually one field repeated across arms, and
 * fall back to whether the gate loops them.
 */
function qualifier(b: Binding, looped: ReadonlySet<BindingId>): string {
  switch (b.node.kind) {
    case "optional":
      return "flag";
    case "repeat":
      return looped.has(b.id) ? "list" : "count";
    case "alternative":
      return "union";
    case "sequence":
      return "struct";
    default: {
      // An arm named after the very field it holds adds nothing.
      const arm = innermostArm(b.gate);
      if (arm !== undefined && arm !== b.name) return arm;
      return b.gate.some((a) => a.kind === "iter") ? "element" : "value";
    }
  }
}

/** The name of the innermost union arm a gate places a binding in, if any. */
function innermostArm(gate: GateAtom[]): string | undefined {
  for (let i = gate.length - 1; i >= 0; i--) {
    const atom = gate[i]!;
    if (atom.kind === "variant") return atom.variant;
  }
  return undefined;
}

function formatResolvedOutput(
  out: ResolvedOutput,
  scopeGate: GateAtom[],
  bindings: BindingRegistry,
  name: Namer,
  indent: number,
): string {
  const pad = "  ".repeat(indent);
  const media = out.mediaTypes?.length ? ` (${out.mediaTypes.join(", ")})` : "";
  const tokens = out.tokens.map((t) => formatResolvedToken(t, name)).join(" + ") || `""`;
  const gateAtoms = outputGate(scopeGate, out, bindings);
  const optional = gateAtoms.some((a) => a.kind === "present" || a.kind === "variant");
  const optTag = optional ? " [optional]" : "";
  const gate =
    gateAtoms.length > 0
      ? ` when (${gateAtoms.map((a) => formatGateAtom(a, name)).join(" AND ")})`
      : "";
  return `${pad}${out.name}${optTag}${media}: ${tokens}${gate}`;
}

function formatResolvedToken(token: ResolvedToken, name: Namer): string {
  if (token.kind === "literal") return JSON.stringify(token.value);
  const flags = [
    token.stripExtensions?.length && `strip=${JSON.stringify(token.stripExtensions)}`,
    token.fallback !== undefined && `fallback=${JSON.stringify(token.fallback)}`,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` {${flags.join(", ")}}` : "";
  return `ref(${name(token.binding)})${suffix}`;
}

function formatGateAtom(atom: GateAtom, name: Namer): string {
  switch (atom.kind) {
    case "present":
      return `present(${name(atom.binding)})`;
    case "variant":
      return `${name(atom.binding)}=${atom.variant}`;
    case "iter":
      return `iter(${name(atom.binding)})`;
  }
}

/**
 * Render a binding's access path, e.g. `params.sub.x` or `<iter:things>.file`.
 * An `iter` segment shows the repeat it loops, since the concrete loop variable
 * is a backend emit-time detail.
 */
function formatAccess(access: AccessPath, name: Namer): string {
  let out = "params";
  for (const seg of access) {
    out = seg.kind === "field" ? `${out}.${seg.name}` : `<iter:${name(seg.binding)}>`;
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
