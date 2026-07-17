import type { CodegenContext } from "../../manifest/index.js";
import { CodeBuilder } from "../code-builder.js";
import type { OutputField } from "../collect-output-fields.js";
import { emitDocstring } from "../python/emit.js";
import { pyStr, renderPyLiteral } from "../python/typemap.js";
import type { TypedParam, TypedParamItem, TypedSpec } from "../typed-spec.js";

/** Generated symbol names for one tool's nipype interface module. */
export interface NipypeNames {
  /** Styx Python module file stem to import the wrapper from (e.g. `_bet`). */
  styxStem: string;
  /** Interface module file stem (e.g. `bet`). */
  ifaceStem: string;
  /** Interface class name (e.g. `Bet`). */
  cls: string;
  /** Input spec class name (e.g. `BetInputSpec`). */
  inputSpec: string;
  /** Output spec class name (e.g. `BetOutputSpec`). */
  outputSpec: string;
}

function call(ctor: string, args: string[]): string {
  return `${ctor}(${args.join(", ")})`;
}

/**
 * Render a numeric literal, forcing a float form (e.g. `0.0`) for a float field.
 * `traits.Range` infers its numeric type from the bound literals, so integer
 * bounds on a float field (e.g. `low=0, high=1`) would build an *integer* range
 * that rejects `0.5`. Emitting `0.0`/`1.0` keeps it a float range.
 */
function renderNum(value: string | number | boolean, asFloat: boolean): string {
  if (asFloat && typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return renderPyLiteral(value);
}

/** Human-readable `desc=` text: doc + degrade/media-type notes. */
function descText(p: TypedParam): string | undefined {
  const parts: string[] = [];
  if (p.doc) parts.push(p.doc);
  if (p.kind === "struct" || p.kind === "union") parts.push("(nested configuration; pass a dict)");
  if (p.mediaTypes && p.mediaTypes.length > 0) {
    parts.push(`(media types: ${p.mediaTypes.join(", ")})`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Map a list element descriptor to a (bare) nipype inner trait. */
function renderItemTrait(item: TypedParamItem | undefined): string {
  if (!item) return "traits.Any()";
  switch (item.kind) {
    case "path":
      return "File(exists=True)";
    case "int":
    case "count":
      return "traits.Int()";
    case "float":
      return "traits.Float()";
    case "str":
      return "traits.Str()";
    case "bool":
      return "traits.Bool()";
    case "enum":
      return call(
        "traits.Enum",
        (item.choices ?? []).map((c) => renderPyLiteral(c)),
      );
    default:
      return "traits.Any()";
  }
}

/** Map a parameter to its nipype input trait expression, carrying rich constraints. */
export function renderInputTrait(p: TypedParam): string {
  const tail: string[] = [];
  if (p.mandatory) tail.push("mandatory=True");
  const desc = descText(p);
  if (desc) tail.push(`desc=${pyStr(desc)}`);
  const hasDef = p.hasDefault && p.default !== undefined;
  const def = p.default;

  switch (p.kind) {
    case "path":
      return call("File", ["exists=True", ...tail]);
    case "bool":
      return call("traits.Bool", [
        ...(hasDef ? [renderPyLiteral(def!), "usedefault=True"] : []),
        ...tail,
      ]);
    case "count":
      return call("traits.Int", [
        ...(hasDef ? [renderPyLiteral(def!), "usedefault=True"] : []),
        ...tail,
      ]);
    case "int":
    case "float": {
      const asFloat = p.kind === "float";
      if (p.range) {
        const a: string[] = [];
        if (hasDef) a.push(`value=${renderNum(def!, asFloat)}`);
        if (p.range.min !== undefined) a.push(`low=${renderNum(p.range.min, asFloat)}`);
        if (p.range.max !== undefined) a.push(`high=${renderNum(p.range.max, asFloat)}`);
        if (hasDef) a.push("usedefault=True");
        return call("traits.Range", [...a, ...tail]);
      }
      const ctor = p.kind === "int" ? "traits.Int" : "traits.Float";
      return call(ctor, [
        ...(hasDef ? [renderNum(def!, asFloat), "usedefault=True"] : []),
        ...tail,
      ]);
    }
    case "str":
      return call("traits.Str", [
        ...(hasDef ? [renderPyLiteral(def!), "usedefault=True"] : []),
        ...tail,
      ]);
    case "enum": {
      const choices = p.choices ?? [];
      // nipype's first Enum arg is the default; put the styx default first, but
      // only when it is actually one of the choices - prepending an out-of-spec
      // default would silently widen the allowed set. (Enum choices are never
      // booleans, so a boolean default can't be one.)
      const defChoice =
        hasDef && def !== undefined && typeof def !== "boolean" && choices.includes(def)
          ? def
          : undefined;
      const ordered =
        defChoice !== undefined ? [defChoice, ...choices.filter((c) => c !== defChoice)] : choices;
      return call("traits.Enum", [
        ...ordered.map((c) => renderPyLiteral(c)),
        ...(defChoice !== undefined ? ["usedefault=True"] : []),
        ...tail,
      ]);
    }
    case "list": {
      const inner = renderItemTrait(p.itemType);
      const bounds: string[] = [];
      if (p.listBounds?.min !== undefined) bounds.push(`minlen=${p.listBounds.min}`);
      if (p.listBounds?.max !== undefined) bounds.push(`maxlen=${p.listBounds.max}`);
      return call("traits.List", [inner, ...bounds, ...tail]);
    }
    case "struct":
    case "union":
      return call("traits.Any", tail);
  }
}

/**
 * Map an output field to its nipype output trait expression. `isRoot` is the
 * synthetic output directory, typed as a `Directory` rather than a `File`.
 */
function renderOutputTrait(f: OutputField, isRoot: boolean): string {
  const tail = f.doc ? [`desc=${pyStr(f.doc)}`] : [];
  if (f.shape.kind === "list") return call("traits.List", ["File()", ...tail]);
  if (isRoot) return call("Directory", tail);
  return call("File", tail);
}

/**
 * Emit the nipype interface module for one tool: a typed InputSpec/OutputSpec and
 * a BaseInterface that delegates execution to the co-emitted styx Python wrapper.
 */
export function emitNipypeInterface(
  ctx: CodegenContext,
  spec: TypedSpec,
  names: NipypeNames,
): string {
  const cb = new CodeBuilder("    ");
  cb.comment("This file was auto generated by Styx.", "# ");
  cb.comment("Do not edit this file directly.", "# ");
  cb.blank();

  cb.line("from nipype.interfaces.base import (");
  cb.indent(() => {
    cb.line("BaseInterface,");
    cb.line("BaseInterfaceInputSpec,");
    cb.line("Directory,");
    cb.line("File,");
    cb.line("TraitedSpec,");
    cb.line("isdefined,");
    cb.line("traits,");
  });
  cb.line(")");
  cb.blank();
  cb.line(
    `from .${names.styxStem} import ${spec.delegation.wrapperFn}, ${spec.delegation.outputsClass}`,
  );
  cb.blank();
  cb.blank();

  // InputSpec
  cb.line(`class ${names.inputSpec}(BaseInterfaceInputSpec):`);
  cb.indent(() => {
    if (!spec.rootIsStruct || spec.params.length === 0) {
      cb.line("pass");
      return;
    }
    for (const p of spec.params) {
      cb.line(`${p.hostName} = ${renderInputTrait(p)}`);
    }
  });
  cb.blank();
  cb.blank();

  // OutputSpec
  cb.line(`class ${names.outputSpec}(TraitedSpec):`);
  cb.indent(() => {
    if (spec.outputs.length === 0 && spec.streams.length === 0) {
      cb.line("pass");
      return;
    }
    spec.outputs.forEach((f, i) => cb.line(`${f.id} = ${renderOutputTrait(f, i === 0)}`));
    for (const s of spec.streams) {
      const tail = s.doc ? `, desc=${pyStr(s.doc)}` : "";
      cb.line(`${s.id} = traits.List(traits.Str()${tail})`);
    }
  });
  cb.blank();
  cb.blank();

  // Interface
  cb.line(`class ${names.cls}(BaseInterface):`);
  cb.indent(() => {
    const docText = [ctx.app?.doc?.title, ctx.app?.doc?.description].filter(Boolean).join("\n\n");
    emitDocstring(cb, docText || undefined);
    cb.line(`input_spec = ${names.inputSpec}`);
    cb.line(`output_spec = ${names.outputSpec}`);
    cb.blank();

    cb.line("def _run_interface(self, runtime):");
    cb.indent(() => {
      if (!spec.rootIsStruct) {
        cb.line("raise NotImplementedError(");
        cb.indent(() =>
          cb.line(pyStr("styx nipype backend: tools with a non-struct root are not supported.")),
        );
        cb.line(")");
        return;
      }
      cb.line("kwargs = {}");
      for (const p of spec.params) {
        if (p.mandatory) {
          cb.line(`kwargs[${pyStr(p.hostName)}] = self.inputs.${p.hostName}`);
        } else {
          cb.line(`if isdefined(self.inputs.${p.hostName}):`);
          cb.indent(() => cb.line(`kwargs[${pyStr(p.hostName)}] = self.inputs.${p.hostName}`));
        }
      }
      cb.line(
        `self._result: ${spec.delegation.outputsClass} = ${spec.delegation.wrapperFn}(**kwargs)`,
      );
      cb.line("return runtime");
    });
    cb.blank();

    cb.line("def _list_outputs(self):");
    cb.indent(() => {
      if (!spec.rootIsStruct) {
        cb.line("return self._outputs().get()");
        return;
      }
      cb.line("result = self._result");
      cb.line("outputs = self._outputs().get()");
      for (const f of spec.outputs) {
        if (f.shape.kind === "single" && f.shape.optional) {
          cb.line(`if result.${f.id} is not None:`);
          cb.indent(() => cb.line(`outputs[${pyStr(f.id)}] = result.${f.id}`));
        } else {
          cb.line(`outputs[${pyStr(f.id)}] = result.${f.id}`);
        }
      }
      for (const s of spec.streams) cb.line(`outputs[${pyStr(s.id)}] = result.${s.id}`);
      cb.line("return outputs");
    });
  });

  return cb.toString();
}
