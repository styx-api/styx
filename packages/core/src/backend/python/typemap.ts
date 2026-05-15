import type { BoundType } from "../../bindings/index.js";
import type { TypeMap } from "../backend.js";

export const pythonTypeMap: TypeMap = {
  map(type: BoundType): string {
    switch (type.kind) {
      case "scalar":
        return { int: "int", float: "float", str: "str", path: "pathlib.Path" }[type.scalar];
      case "bool":
        return "bool";
      case "count":
        return "int";
      case "optional":
        return `${this.map(type.inner)} | None`;
      case "list":
        return `list[${this.map(type.item)}]`;
      case "struct":
        return "dict[str, Any]";
      case "union":
        return type.variants.map((v) => this.map(v.type)).join(" | ");
      case "literal":
        return typeof type.value === "number" ? "int" : "str";
    }
  },
  imports(type: BoundType): string[] {
    const imports = new Set<string>();
    const collect = (t: BoundType) => {
      if (t.kind === "scalar" && t.scalar === "path") imports.add("import pathlib");
      if (t.kind === "struct") imports.add("from typing import Any");
      if (t.kind === "optional") collect(t.inner);
      if (t.kind === "list") collect(t.item);
      if (t.kind === "union") t.variants.forEach((v) => collect(v.type));
      if (t.kind === "struct") Object.values(t.fields).forEach(collect);
    };
    collect(type);
    return Array.from(imports);
  },
};
