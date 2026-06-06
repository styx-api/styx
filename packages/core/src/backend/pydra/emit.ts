import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { OutputField } from "../collect-output-fields.js";
import { emitDocstring } from "../python/emit.js";
import { pyStr, renderPyLiteral } from "../python/typemap.js";
import type { TypedParam, TypedParamItem, TypedSpec } from "../typed-spec.js";

/** Generated symbol names for one tool's pydra task module. */
export interface PydraNames {
  /** Styx Python module file stem to import the wrapper from (e.g. `_bet`). */
  styxStem: string;
  /** Task module file stem (e.g. `bet`). */
  ifaceStem: string;
  /** Task class name (e.g. `Bet`). */
  cls: string;
}

/** Which optional imports the emitted module needs. */
interface Imports {
  typing: boolean;
  attrs: boolean;
  file: boolean;
  directory: boolean;
}

/** A scalar enum's Python type: int when every choice is numeric, else str. */
function enumScalar(choices: readonly (string | number)[] | undefined): string {
  return (choices ?? []).every((c) => typeof c === "number") ? "int" : "str";
}

/** True when a parameter is a file path (a path scalar or a list of paths). */
function isPathParam(p: TypedParam): boolean {
  return p.kind === "path" || (p.kind === "list" && p.itemType?.kind === "path");
}

function itemTypeStr(item: TypedParamItem | undefined, imp: Imports): string {
  if (!item) {
    imp.typing = true;
    return "ty.Any";
  }
  switch (item.kind) {
    case "path":
      imp.file = true;
      return "File";
    case "int":
    case "count":
      return "int";
    case "float":
      return "float";
    case "str":
      return "str";
    case "bool":
      return "bool";
    case "enum":
      return enumScalar(item.choices);
    default:
      imp.typing = true;
      return "ty.Any";
  }
}

/** Base (non-optional) Python type expression for a parameter. */
function baseType(p: TypedParam, imp: Imports): string {
  switch (p.kind) {
    case "path":
      imp.file = true;
      return "File";
    case "int":
    case "count":
      return "int";
    case "float":
      return "float";
    case "str":
      return "str";
    case "bool":
      return "bool";
    case "enum":
      return enumScalar(p.choices);
    case "list":
      return `list[${itemTypeStr(p.itemType, imp)}]`;
    case "struct":
    case "union":
      imp.typing = true;
      return "ty.Any";
  }
}

/** Full input type, wrapping in `ty.Optional[...]` for an omittable-no-default field. */
function inputType(p: TypedParam, imp: Imports): string {
  const base = baseType(p, imp);
  if (p.optional && !p.hasDefault) {
    imp.typing = true;
    return `ty.Optional[${base}]`;
  }
  return base;
}

/** An attrs validator enforcing numeric range / list-length bounds, or undefined. */
function validatorExpr(p: TypedParam, imp: Imports): string | undefined {
  const checks: string[] = [];
  if (p.range) {
    if (p.range.min !== undefined)
      checks.push(`attrs.validators.ge(${renderPyLiteral(p.range.min)})`);
    if (p.range.max !== undefined)
      checks.push(`attrs.validators.le(${renderPyLiteral(p.range.max)})`);
  }
  if (p.listBounds) {
    if (p.listBounds.min !== undefined)
      checks.push(`attrs.validators.min_len(${p.listBounds.min})`);
    if (p.listBounds.max !== undefined)
      checks.push(`attrs.validators.max_len(${p.listBounds.max})`);
  }
  if (checks.length === 0) return undefined;
  imp.attrs = true;
  let v = checks.length === 1 ? checks[0]! : `attrs.validators.and_(${checks.join(", ")})`;
  // A None default would otherwise trip the validator; skip it when absent.
  if (p.optional && !p.hasDefault) v = `attrs.validators.optional(${v})`;
  return v;
}

/** Help text: doc + degrade / media-type notes. */
function helpText(p: TypedParam): string | undefined {
  const parts: string[] = [];
  if (p.doc) parts.push(p.doc);
  if (p.kind === "struct" || p.kind === "union") parts.push("(nested configuration; pass a dict)");
  if (p.mediaTypes && p.mediaTypes.length > 0) {
    parts.push(`(media types: ${p.mediaTypes.join(", ")})`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Render a `python.arg(...)` field for one parameter. */
function renderInputArg(p: TypedParam, imp: Imports): string {
  const args: string[] = [`type=${inputType(p, imp)}`];
  if (p.mandatory) {
    // no default -> mandatory
  } else if (p.optional && !p.hasDefault) {
    args.push("default=None");
  } else {
    args.push(`default=${renderPyLiteral(p.default!)}`);
  }
  if (p.kind === "enum") {
    args.push(`allowed_values=[${(p.choices ?? []).map((c) => renderPyLiteral(c)).join(", ")}]`);
  }
  const v = validatorExpr(p, imp);
  if (v) args.push(`validator=${v}`);
  const h = helpText(p);
  if (h) args.push(`help=${pyStr(h)}`);
  return `python.arg(${args.join(", ")})`;
}

/** Python type for an output field. `isRoot` is the synthetic output directory. */
function outputType(f: OutputField, isRoot: boolean, imp: Imports): string {
  if (f.shape.kind === "list") {
    imp.file = true;
    return "list[File]";
  }
  if (isRoot) {
    imp.directory = true;
    return "Directory";
  }
  imp.file = true;
  if (f.shape.optional) {
    imp.typing = true;
    return "ty.Optional[File]";
  }
  return "File";
}

function renderOutputArg(f: OutputField, isRoot: boolean, imp: Imports): string {
  const args: string[] = [`type=${outputType(f, isRoot, imp)}`];
  if (f.doc) args.push(`help=${pyStr(f.doc)}`);
  return `python.out(${args.join(", ")})`;
}

/**
 * Emit the pydra task module for one tool: a `@python.define` task whose typed
 * inputs/outputs carry rich constraints and whose body delegates execution to the
 * co-emitted styx Python wrapper (Option B). Targets the post-rewrite
 * `pydra.compose` API (pydra >= 1.0a, Python >= 3.11).
 */
export function emitPydraTask(ctx: CodegenContext, spec: TypedSpec, names: PydraNames): string {
  const imp: Imports = { typing: false, attrs: false, file: false, directory: false };

  // Render fields first so we know which imports are needed.
  const inputEntries = spec.params.map((p) => ({
    key: p.hostName,
    expr: renderInputArg(p, imp),
  }));
  const outputEntries = spec.outputs.map((f, i) => ({
    key: f.id,
    expr: renderOutputArg(f, i === 0, imp),
  }));
  for (const s of spec.streams) {
    // list[str] uses builtin generics - no extra import needed.
    outputEntries.push({
      key: s.id,
      expr: `python.out(type=list[str]${s.doc ? `, help=${pyStr(s.doc)}` : ""})`,
    });
  }

  // Path-typed inputs arrive from pydra as fileformats objects; the styx wrapper
  // expects str/pathlib.Path, so convert them at the call boundary.
  const needsPath = spec.params.some(isPathParam);

  const cb = new CodeBuilder("    ");
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.comment("Targets the pydra.compose API (pydra >= 1.0a, Python >= 3.11).", "# ");
  cb.blank();

  if (needsPath) cb.line("import os");
  if (imp.typing) cb.line("import typing as ty");
  if (imp.attrs) cb.line("import attrs.validators");
  cb.line("from pydra.compose import python");
  const ff: string[] = [];
  if (imp.directory) ff.push("Directory");
  if (imp.file) ff.push("File");
  if (ff.length > 0) cb.line(`from fileformats.generic import ${ff.join(", ")}`);
  cb.blank();
  cb.line(`from .${names.styxStem} import ${spec.delegation.wrapperFn}`);
  cb.blank();
  cb.blank();

  if (needsPath) {
    cb.line("def _styx_path(value):");
    cb.indent(() => {
      cb.line('"""Convert fileformats / Path inputs into a styxdefs-accepted path."""');
      cb.line("if value is None:");
      cb.indent(() => cb.line("return None"));
      cb.line("if isinstance(value, (list, tuple)):");
      cb.indent(() => cb.line("return [os.fspath(v) for v in value]"));
      cb.line("return os.fspath(value)");
    });
    cb.blank();
    cb.blank();
  }

  // Decorator
  cb.line("@python.define(");
  cb.indent(() => {
    if (inputEntries.length === 0) {
      cb.line("inputs={},");
    } else {
      cb.line("inputs={");
      cb.indent(() => {
        for (const e of inputEntries) cb.line(`${pyStr(e.key)}: ${e.expr},`);
      });
      cb.line("},");
    }
    cb.line("outputs={");
    cb.indent(() => {
      for (const e of outputEntries) cb.line(`${pyStr(e.key)}: ${e.expr},`);
    });
    cb.line("},");
  });
  cb.line(")");

  // Function
  const paramList = spec.params.map((p) => p.hostName);
  cb.line(`def ${names.cls}(${paramList.join(", ")}):`);
  cb.indent(() => {
    const docText = [ctx.app?.doc?.title, ctx.app?.doc?.description].filter(Boolean).join("\n\n");
    emitDocstring(cb, docText || undefined);

    if (!spec.rootIsStruct) {
      cb.line("raise NotImplementedError(");
      cb.indent(() =>
        cb.line(pyStr("styx pydra backend: tools with a non-struct root are not supported.")),
      );
      cb.line(")");
      return;
    }

    if (spec.params.length === 0) {
      cb.line(`result = ${spec.delegation.wrapperFn}()`);
    } else {
      cb.line(`result = ${spec.delegation.wrapperFn}(`);
      cb.indent(() => {
        for (const p of spec.params) {
          const expr = isPathParam(p) ? `_styx_path(${p.hostName})` : p.hostName;
          cb.line(`${p.hostName}=${expr},`);
        }
      });
      cb.line(")");
    }

    const returns = [
      ...spec.outputs.map((f) => `result.${f.id}`),
      ...spec.streams.map((s) => `result.${s.id}`),
    ];
    if (returns.length === 1) {
      cb.line(`return ${returns[0]}`);
    } else {
      cb.line(`return ${returns.join(", ")}`);
    }
  });

  return cb.toString();
}
