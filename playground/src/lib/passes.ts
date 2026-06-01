import { flatten, simplify, removeEmpty, canonicalize, createPipeline } from "@styx/core";
import type { Pass } from "@styx/core";

export interface PassDef {
  key: string;
  label: string;
  pass: Pass;
  default: boolean;
}

/**
 * Single source of truth for the optimization passes the playground exposes.
 * Drives the toggle UI, the config state shape, and pipeline assembly - add a
 * pass here and it flows everywhere with no hand-syncing.
 */
export const PASS_REGISTRY = [
  { key: "flatten", label: "Flatten", pass: flatten, default: true },
  { key: "simplify", label: "Simplify", pass: simplify, default: true },
  { key: "removeEmpty", label: "Remove Empty", pass: removeEmpty, default: true },
  { key: "canonicalize", label: "Canonicalize", pass: canonicalize, default: false },
] as const satisfies readonly PassDef[];

export type PassKey = (typeof PASS_REGISTRY)[number]["key"];
export type PassConfig = Record<PassKey, boolean>;

export const defaultPassConfig: PassConfig = Object.fromEntries(
  PASS_REGISTRY.map((p) => [p.key, p.default]),
) as PassConfig;

/** Compose the active passes into a fixpoint pipeline, or null if none are on. */
export function buildPipeline(config: PassConfig): Pass | null {
  const active = PASS_REGISTRY.filter((p) => config[p.key]).map((p) => p.pass);
  if (active.length === 0) return null;
  return createPipeline(active, { fixpoint: true });
}
