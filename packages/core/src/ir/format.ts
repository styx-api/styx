import type { AppMeta, Output, OutputToken } from "./meta.js";
import type { Expr } from "./node.js";

export function format(expr: Expr, meta?: AppMeta): string {
  const lines: string[] = [];

  if (meta) {
    lines.push(`app ${meta.id ?? "unknown"}${meta.version ? `@${meta.version}` : ""}`);
    if (meta.doc?.description) {
      lines.push(`  "${meta.doc.description}"`);
    }
    if (meta.doc?.authors?.length) {
      lines.push(`  authors: ${meta.doc.authors.join(", ")}`);
    }
    if (meta.container) {
      lines.push(`  container: ${meta.container.image}`);
    }
    if (meta.stdout) {
      lines.push(`  stdout: ${meta.stdout.name}`);
    }
    if (meta.stderr) {
      lines.push(`  stderr: ${meta.stderr.name}`);
    }
    lines.push("");
  }

  lines.push(formatExpr(expr, 0));
  return lines.join("\n");
}

function formatOutputToken(token: OutputToken): string {
  if (token.kind === "literal") return JSON.stringify(token.value);
  const flags = [
    token.stripExtensions?.length && `strip=${JSON.stringify(token.stripExtensions)}`,
    token.fallback !== undefined && `fallback=${JSON.stringify(token.fallback)}`,
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` {${flags.join(", ")}}` : "";
  return `ref(${token.target.name})${suffix}`;
}

function formatOutputsBlock(outputs: Output[], indent: number): string {
  const pad = "  ".repeat(indent);
  const lines = [`${pad}outputs:`];
  for (const out of outputs) {
    const name = out.name ?? "<anon>";
    const media = out.mediaTypes?.length ? ` (${out.mediaTypes.join(", ")})` : "";
    const tokens = out.tokens.map(formatOutputToken).join(" + ") || `""`;
    lines.push(`${pad}  ${name}${media}: ${tokens}`);
  }
  return lines.join("\n");
}

// Splice the outputs block in right after the node's header line (its first
// line), before any child lines, so outputs read naturally as belonging to
// the node they decorate.
function spliceOutputs(body: string, outputsBlock: string): string {
  if (!outputsBlock) return body;
  const nl = body.indexOf("\n");
  if (nl === -1) return `${body}\n${outputsBlock}`;
  return `${body.slice(0, nl)}\n${outputsBlock}${body.slice(nl)}`;
}

function formatExpr(expr: Expr, indent: number): string {
  const pad = "  ".repeat(indent);
  const name = expr.meta?.name ? ` [${expr.meta.name}]` : "";
  const outputsBlock = expr.meta?.outputs?.length
    ? formatOutputsBlock(expr.meta.outputs, indent + 1)
    : "";

  let body: string;
  switch (expr.kind) {
    case "literal":
      body = `${pad}literal${name} "${expr.attrs.str}"`;
      break;

    case "str":
      body = `${pad}str${name}`;
      break;

    case "int": {
      const { minValue, maxValue } = expr.attrs;
      const range =
        minValue !== undefined || maxValue !== undefined
          ? ` (${minValue ?? ""}..${maxValue ?? ""})`
          : "";
      body = `${pad}int${name}${range}`;
      break;
    }

    case "float": {
      const { minValue, maxValue } = expr.attrs;
      const range =
        minValue !== undefined || maxValue !== undefined
          ? ` (${minValue ?? ""}..${maxValue ?? ""})`
          : "";
      body = `${pad}float${name}${range}`;
      break;
    }

    case "path": {
      const flags = [
        expr.attrs.resolveParent && "resolveParent",
        expr.attrs.mutable && "mutable",
      ].filter(Boolean);
      const suffix = flags.length > 0 ? ` {${flags.join(", ")}}` : "";
      body = `${pad}path${name}${suffix}`;
      break;
    }

    case "sequence": {
      const join = expr.attrs.join !== undefined ? ` join="${expr.attrs.join}"` : "";
      const header = `${pad}sequence${name}${join}`;
      if (expr.attrs.nodes.length === 0) {
        body = `${header} (empty)`;
      } else {
        const children = expr.attrs.nodes.map((n) => formatExpr(n, indent + 1)).join("\n");
        body = `${header}\n${children}`;
      }
      break;
    }

    case "alternative": {
      const header = `${pad}alternative${name}`;
      const children = expr.attrs.alts.map((n) => formatExpr(n, indent + 1)).join("\n");
      body = `${header}\n${children}`;
      break;
    }

    case "optional": {
      const header = `${pad}optional${name}`;
      const child = formatExpr(expr.attrs.node, indent + 1);
      body = `${header}\n${child}`;
      break;
    }

    case "repeat": {
      const { join, countMin, countMax } = expr.attrs;
      const parts = [
        join !== undefined && `join="${join}"`,
        countMin !== undefined && `min=${countMin}`,
        countMax !== undefined && `max=${countMax}`,
      ].filter(Boolean);
      const suffix = parts.length > 0 ? ` {${parts.join(", ")}}` : "";
      const header = `${pad}repeat${name}${suffix}`;
      const child = formatExpr(expr.attrs.node, indent + 1);
      body = `${header}\n${child}`;
      break;
    }

    default: {
      const _exhaustive: never = expr;
      body = `${pad}unknown`;
    }
  }

  return spliceOutputs(body, outputsBlock);
}
