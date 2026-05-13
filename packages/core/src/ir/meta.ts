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
 * the node that "owns" it - that node is the implicit trigger: the output
 * emits exactly when the owning node is active during arg-walk. Gating
 * (optional/alternative ancestors) and list scope (repeat ancestors) are
 * read off the owner's position in the tree, so there is no separate trigger
 * list. Token refs name other in-scope nodes (typically the owner's subtree).
 *
 * `optional` is the frontend asserting the file may be absent independent of
 * structural gating (e.g. Boutiques `output-files[].optional`). The resolved
 * output is optional if this is set OR the owner is structurally gated.
 */
export interface Output {
  name?: string;
  doc?: Documentation;
  tokens: OutputToken[];
  optional?: boolean;
  mediaTypes?: MediaTypeIdentifier[];
}

/** Metadata attached to any IR node. */
export interface NodeMeta {
  /** Name identifier for this node (used by solver for binding names). */
  name?: string;
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
  authors?: string[];
  urls?: string[];
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
