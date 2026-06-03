import type { Documentation, MediaTypeIdentifier } from "./types.js";

/**
 * Opaque, name-based reference to an IR node by its `NodeMeta.name`.
 *
 * Resolved post-solve against the binding registry, not within IR passes.
 * Names survive optimization (pointers don't), so token refs stay valid even
 * after passes rewrite the tree. See `memory/design_outputs.md`.
 */
export interface NodeRef {
  kind: "node-ref";
  name: string;
}

/** Construct a NodeRef from a node name. */
export function nodeRef(name: string): NodeRef {
  return { kind: "node-ref", name };
}

/** Output token: literal text or a parameter reference. */
export type OutputToken =
  | { kind: "literal"; value: string }
  | {
      kind: "ref";
      target: NodeRef;
      stripExtensions?: string[];
      fallback?: string;
    };

/**
 * Specification for a file the tool produces. Lives on `NodeMeta.outputs` of
 * the struct node (root sequence or subcommand sequence) that declared it.
 * Per-output gating is derived downstream from the scope's binding gate and
 * each ref binding's gate, so no host node or `optional` flag is stored.
 */
export interface Output {
  name?: string;
  doc?: Documentation;
  tokens: OutputToken[];
  mediaTypes?: MediaTypeIdentifier[];
}

/** Metadata attached to any IR node. */
export interface NodeMeta {
  /** Name identifier for this node (used by solver for binding names). */
  name?: string;
  /**
   * The discriminator (`@type`) tag for this node when it is a union arm (a
   * Boutiques sub-command). Kept separate from `name`: a single-field
   * sub-command collapses onto its inner field, whose `name` then wins, so the
   * tag would otherwise become the inner field's id - e.g. two distinct
   * sub-commands `VariousString`/`VariousFile` both wrapping an `obj` field
   * would collide on `@type: "obj"` (and the second arm would be unreachable).
   * `mergeMeta` preserves this through the collapse and the solver prefers it
   * for the variant tag, so distinct sub-commands keep distinct, reachable
   * `@type`s.
   */
  variantTag?: string;
  doc?: Documentation;
  defaultValue?: string | number | boolean;
  /** Files produced when this node is active. See `Output`. */
  outputs?: Output[];
}

/** Application-level metadata for the root node. */
export interface AppMeta {
  id?: string;
  version?: string;
  doc?: Documentation;
  container?: {
    image: string;
    type?: "docker" | "singularity";
  };
  stdout?: StreamOutput;
  stderr?: StreamOutput;
}

export interface StreamOutput {
  name: string;
  doc?: Documentation;
}

/**
 * Produce a usable name for an Output. Frontends may leave `Output.name`
 * unset; downstream code (resolver, validator, backends) needs a stable
 * identifier for diagnostics and field naming. Falls back to `output_<index>`
 * keyed by the output's position in tree-walk order.
 */
export function effectiveOutputName(output: Output, index: number): string {
  return output.name ?? `output_${index}`;
}
