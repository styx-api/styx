import type { AccessPath, AccessSegment, Binding, BoundType } from "../bindings/index.js";
import type { Expr } from "../ir/index.js";

/**
 * Attach `Binding.access` to every binding by walking the IR once, threading
 * the same scope state the backend walkers used to re-derive independently
 * (`arg-builder.walk` and `outputs-emit.walkAccess`). Producing the paths here,
 * after types settle, collapses both walkers into pure `renderAccess` lookups
 * and removes the drift class between them.
 *
 * The walk faithfully mirrors the (post-`ca61dc8`) arg-builder/outputs-emit
 * scope handling for sequence/optional/alternative, and adopts the
 * arg-builder's `repeat` recursion (which `walkAccess` lacked) so bindings
 * inside a `repeat`-of-list get an `iter`-rooted path instead of being absent.
 */
export function assignAccessPaths(expr: Expr, resolve: (node: Expr) => Binding | undefined): void {
  const rootBinding = resolve(expr);
  walk(expr, resolve, { path: [], currentStructType: rootBinding?.type });
}

/**
 * Scope state threaded down the walk, mirroring the arg-builder's `ArgContext`
 * but carrying structured paths instead of rendered strings.
 */
interface AccessCtx {
  /** Access path of the enclosing struct scope (the base for child fields). */
  path: AccessPath;
  /**
   * When set, the next binding's value lives at this exact path rather than at
   * `path + field(name)` - the wrapper collapsed the inner value onto its own
   * path (`optional<scalar>`/`optional<bool>`, scalar lists). Mirrors the
   * arg-builder's `directValue`. Not a rendered segment: it is "inherit the
   * parent's path, append nothing".
   */
  directPath?: AccessPath;
  /** The struct type at the current scope level (prevents double-scoping). */
  currentStructType?: BoundType;
}

function field(name: string): AccessSegment {
  return { kind: "field", name };
}

function iter(binding: string): AccessSegment {
  return { kind: "iter", binding };
}

/** The path at which a binding's own value lives in the current scope. */
function ownAccess(arg: AccessCtx, name: string): AccessPath {
  return arg.directPath ?? [...arg.path, field(name)];
}

/** Whether a BoundType contains a struct that requires scoping when entered. */
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

/** Unwrap optional/list to find the inner struct type, if any. */
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

function walk(node: Expr, resolve: (node: Expr) => Binding | undefined, arg: AccessCtx): void {
  const binding = resolve(node);

  switch (node.kind) {
    case "literal":
      return;

    case "int":
    case "float":
    case "str":
    case "path": {
      if (binding) binding.access = ownAccess(arg, binding.name);
      return;
    }

    case "sequence": {
      let childArg = arg;
      if (binding && hasStructScope(binding.type) && binding.type !== arg.currentStructType) {
        // A nested struct: children access fields under this binding's path.
        const access: AccessPath = [...arg.path, field(binding.name)];
        binding.access = access;
        childArg = {
          path: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding) {
        // Root struct or a struct already scoped by an enclosing wrapper: the
        // binding reuses the current path (collapse / already-scoped).
        binding.access = arg.directPath ?? arg.path;
      }
      for (const child of node.attrs.nodes) walk(child, resolve, childArg);
      return;
    }

    case "optional": {
      if (!binding) {
        walk(node.attrs.node, resolve, arg);
        return;
      }
      const access: AccessPath = [...arg.path, field(binding.name)];
      binding.access = access;
      let childArg: AccessCtx;
      if (hasStructScope(binding.type)) {
        childArg = {
          path: access,
          currentStructType: unwrapToStruct(binding.type) ?? arg.currentStructType,
        };
      } else if (binding.type.kind === "optional" || binding.type.kind === "bool") {
        // Collapsed non-struct: the inner value lives at the optional's path.
        childArg = { ...arg, directPath: access };
      } else {
        childArg = arg;
      }
      walk(node.attrs.node, resolve, childArg);
      return;
    }

    case "repeat": {
      // The solver always binds repeat nodes, so this is defensive only; unlike
      // optional/alternative there are no children to recurse into without it.
      if (!binding) return;
      // The list/count binding lives at its own access path.
      binding.access = ownAccess(arg, binding.name);

      if (binding.type.kind === "count") {
        // Count repeats wrap a literal (no inner binding); recurse harmlessly
        // with the scope unchanged, mirroring the arg-builder.
        walk(node.attrs.node, resolve, arg);
        return;
      }

      // List repeat: inner bindings are iteration-scoped. Reset the base to an
      // `iter` segment bound to this repeat; the renderer substitutes the loop
      // variable. Scalar lists collapse the element onto the loop var directly
      // (directPath), struct lists scope into the element type.
      const itemType = binding.type.kind === "list" ? binding.type.item : undefined;
      const isScalar = !itemType || !hasStructScope(itemType);
      const elementPath: AccessPath = [iter(binding.id)];
      const childArg: AccessCtx = {
        path: elementPath,
        directPath: isScalar ? elementPath : undefined,
        currentStructType:
          !isScalar && itemType?.kind === "struct" ? itemType : arg.currentStructType,
      };
      walk(node.attrs.node, resolve, childArg);
      return;
    }

    case "alternative": {
      if (!binding) {
        for (const alt of node.attrs.alts) walk(alt, resolve, arg);
        return;
      }
      const access = ownAccess(arg, binding.name);
      binding.access = access;
      const isComplexUnion =
        binding.type.kind === "union" &&
        !binding.type.variants.every((v) => v.type.kind === "literal");
      node.attrs.alts.forEach((alt, i) => {
        if (isComplexUnion && binding.type.kind === "union") {
          // A complex-union variant's fields are accessed via the union's own
          // path (the `@type` discriminant narrows it), so scope into `access`.
          const variantType = binding.type.variants[i]?.type;
          walk(alt, resolve, {
            path: access,
            currentStructType: variantType?.kind === "struct" ? variantType : arg.currentStructType,
          });
        } else {
          walk(alt, resolve, arg);
        }
      });
      return;
    }
  }
}
