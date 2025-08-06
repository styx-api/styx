"""Compile JSON schema (of input parameters)."""

import json
import pathlib
import typing

import styx.ir.core as ir
from styx.backend.common import CompiledFile
from styx.backend.typescript.languageprovider import TypeScriptLanguageProvider


def _param_to_schema_json(
    param: ir.Param,
) -> dict:
    def _val() -> dict:
        if isinstance(param.body, ir.Param.String):
            return {
                "type": "string",
            }
        if isinstance(param.body, ir.Param.Int):
            v: dict = {
                "type": "integer",
            }
            if param.body.min_value is not None:
                v["minimum"] = param.body.min_value
            if param.body.max_value is not None:
                v["maximum"] = param.body.max_value
            return v
        if isinstance(param.body, ir.Param.Float):
            v = {
                "type": "number",
            }
            if param.body.min_value is not None:
                v["minimum"] = param.body.min_value
            if param.body.max_value is not None:
                v["maximum"] = param.body.max_value
            return v
        if isinstance(param.body, ir.Param.Bool):
            return {
                "type": "boolean",
            }
        if isinstance(param.body, ir.Param.File):
            return {
                "type": "string",
            }
        if isinstance(param.body, ir.Param.Struct):  # , ir.Param.StructUnion)):
            v = _struct_to_schema_json(param)
            v["properties"]["__STYXTYPE__"] = {"const": param.body.name}
            return v
        if isinstance(param.body, ir.Param.StructUnion):
            alternatives = []
            for struct in param.body.alts:
                struct_json = _param_to_schema_json(struct)
                struct_json["properties"]["__STYXTYPE__"] = {"const": struct.body.name}
                alternatives.append(struct_json)
            return {"anyOf": alternatives}
        assert False

    ret: dict = _val()

    if param.list_:
        ret = {
            "type": "array",
            "items": ret,
        }

        if param.list_.count_min is not None:
            ret["minItems"] = param.list_.count_min
        if param.list_.count_max is not None:
            ret["maxItems"] = param.list_.count_max

    if param.nullable:
        ret = {"anyOf": [ret, {"type": "null"}]}

    if param.default_value is not None:
        ret["default"] = None if param.default_value is ir.Param.SetToNone else param.default_value

    if param.base.docs.title:
        ret["title"] = param.base.docs.title

    if param.base.docs.description:
        ret["description"] = param.base.docs.description

    return ret


def _struct_to_schema_json(
    struct: ir.Param[ir.Param.Struct],
) -> dict:
    ret: dict = {
        "type": "object",
        "properties": {
            "__STYXTYPE__": {"const": struct.body.name},
        },
        "additionalProperties": False,
    }

    if struct.base.docs.title:
        ret["title"] = struct.base.docs.title

    if struct.base.docs.description:
        ret["description"] = struct.base.docs.description

    required_properties: list[str] = []
    for param in struct.body.iter_params():
        if not (param.nullable or param.default_value is not None):
            required_properties.append(param.base.name)
        ret["properties"][param.base.name] = _param_to_schema_json(param)

    if required_properties:
        ret["required"] = required_properties

    return ret


def to_schema_json(
    interface: ir.Interface,
    ts_lang: TypeScriptLanguageProvider,
) -> dict:
    struct = interface.command

    ret = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://example.com/schema.json",  # todo
    }

    if struct.base.docs.title:
        ret["title"] = struct.base.docs.title

    if struct.base.docs.description:
        ret["description"] = struct.base.docs.description

    ret.update(_struct_to_schema_json(struct))

    return ret


def compile_schema_json(
    interfaces: typing.Iterable[ir.Interface],
) -> typing.Generator[CompiledFile, typing.Any, None]:
    ts_lang = TypeScriptLanguageProvider()
    for interface in interfaces:
        yield CompiledFile(
            path=pathlib.Path(interface.uid + ".json"),
            content=json.dumps(to_schema_json(interface, ts_lang), indent=2),
        )
