"""Compile JSON schema (of input parameters)."""

import pathlib
import re
import typing

import styx.ir.core as ir
from styx.backend.common import TextFile
from styx.backend.compile import Compilable


def _param_to_input_schema_json(
    param: ir.Param,
) -> dict:
    def _val() -> dict:
        if isinstance(param.body, ir.Param.String):
            v = {
                "type": "string",
            }
            if param.choices:
                v["enum"] = param.choices
            return v
        if isinstance(param.body, ir.Param.Int):
            v: dict = {
                "type": "integer",
            }
            if param.choices:
                v["enum"] = param.choices
            else:
                if param.body.min_value is not None:
                    v["minimum"] = param.body.min_value
                if param.body.max_value is not None:
                    v["maximum"] = param.body.max_value
            return v
        if isinstance(param.body, ir.Param.Float):
            v = {
                "type": "number",
            }
            if param.choices:
                v["enum"] = param.choices
            else:
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
            return {"type": "string", "x-styx-type": "file"}
        if isinstance(param.body, ir.Param.Struct):  # , ir.Param.StructUnion)):
            v = _struct_to_input_schema_json(param)
            v["properties"]["@type"] = {"const": param.body.global_name}
            return v
        if isinstance(param.body, ir.Param.StructUnion):
            alternatives = []
            for struct in param.body.alts:
                struct_json = _param_to_input_schema_json(struct)
                struct_json["properties"]["@type"] = {"const": struct.body.global_name}
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


def _struct_to_input_schema_json(
    struct: ir.Param[ir.Param.Struct],
) -> dict:
    ret: dict = {
        "type": "object",
        "properties": {
            "@type": {"const": struct.body.global_name},
        },
        "additionalProperties": False,
    }

    if struct.base.docs.title:
        ret["title"] = struct.base.docs.title

    if struct.base.docs.description:
        ret["description"] = struct.base.docs.description

    required_properties: list[str] = ["@type"]
    for param in struct.body.iter_params():
        if not (param.nullable or param.default_value is not None):
            required_properties.append(param.base.name)
        ret["properties"][param.base.name] = _param_to_input_schema_json(param)

    if required_properties:
        ret["required"] = required_properties

    return ret


def to_input_schema_json(
        interface: ir.Interface,
) -> dict:
    """Input params JSON schema."""
    struct = interface.command

    ret: dict = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        # "$id": "https://example.com/schema.json",  # todo ?
    }

    if struct.base.docs.title:
        ret["title"] = struct.base.docs.title

    if struct.base.docs.description:
        ret["description"] = struct.base.docs.description

    ret.update(_struct_to_input_schema_json(struct))

    return ret


def to_output_schema_json(
    interface: ir.Interface,
):
    """Output object JSON schema."""

    struct = interface.command

    ret: dict = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        # "$id": "https://example.com/schema.json",  # todo ?
    }

    if struct.base.docs.title:
        ret["title"] = struct.base.docs.title

    if struct.base.docs.description:
        ret["description"] = struct.base.docs.description

    def _output_json(o: ir.Output) -> dict:
        return {
            "type": "string",
            "title": o.docs.title,
            "description": o.docs.description,
        }

    def _param_to_output_json_schema(param: ir.Param):
        outs: dict = {
            "root": {
                "type": "string",
                "title": "Root",
                "description": "Output root directory",
            }
        }
        ret = {"type": "object", "additionalProperties": False, "properties": outs}
        if param.list_:
            ret = {
                "type": "array",
                "items": ret,
            }
        if param.nullable:
            ret = {
                "anyOf": [ret, {"type": "null"}],
            }
        for o in param.base.outputs:
            outs[o.name] = _output_json(o)

        if isinstance(param.body, ir.Param.Struct):
            for p in param.body.iter_params():
                if p.has_outputs():
                    outs[param.base.name] = _param_to_output_json_schema(p)

        if isinstance(param.body, ir.Param.StructUnion):
            alternatives = []
            for struct in param.body.alts:
                if struct.has_outputs():
                    alternatives.append(_param_to_output_json_schema(struct))
            outs[param.base.name] = {"anyOf": alternatives}

        return ret

    ret.update(_param_to_output_json_schema(struct))

    return ret


def _make_filename_safe(filename: str) -> str:
    """Make a string safe for use as a filename."""
    safe_filename = re.sub(r'[<>:"/\\|?*]', "_", filename)
    safe_filename = safe_filename.strip(". ")
    return safe_filename if safe_filename else "unnamed"


class JsonSchemaCompiler(Compilable):
    def compile(
        self,
        project: ir.Project,
        packages: typing.Iterable[
            tuple[
                ir.Package,
                typing.Iterable[ir.Interface],
            ]
        ],
    ) -> typing.Generator[TextFile, typing.Any, None]:
        package_names: list[str] = []
        package_index = []
        for package, interfaces in packages:
            input_schema_paths: list[pathlib.Path] = []
            output_schema_paths: list[pathlib.Path] = []
            package_path = pathlib.Path(package.name)
            package_names.append(package.name)
            apps = []
            for interface in interfaces:
                interface.update_global_names(package.name)
                safe_global_name = _make_filename_safe(interface.command.body.global_name)
                input_schema_path = package_path / (safe_global_name + ".input.json")
                input_schema_paths.append(input_schema_path)
                output_schema_path = package_path / (safe_global_name + ".output.json")
                output_schema_paths.append(output_schema_path)
                yield TextFile.json(
                    path=input_schema_path,
                    content=to_input_schema_json(interface),
                )
                yield TextFile.json(
                    path=output_schema_path,
                    content=to_output_schema_json(interface),
                )
                apps.append({
                    "id": interface.uid,
                    "inputSchema": input_schema_path.as_posix(),
                    "outputSchema": output_schema_path.as_posix(),
                })
            package_index.append({
                "name": package.name,
                "apps": apps,
            })
            yield TextFile.json(
                path=package_path / "input.schema.json",
                content={"oneOf": [({"$ref": x.as_posix()}) for x in input_schema_paths]},
            )
            yield TextFile.json(
                path=package_path / "output.schema.json",
                content={"oneOf": [({"$ref": x.as_posix()}) for x in output_schema_paths]},
            )
        yield TextFile.json(
            path=pathlib.Path("input.schema.json"),
            content={"oneOf": [({"$ref": f"{x}/input.schema.json"}) for x in package_names]},
        )
        yield TextFile.json(
            path=pathlib.Path("output.schema.json"),
            content={"oneOf": [({"$ref": f"{x}/output.schema.json"}) for x in package_names]},
        )
        yield TextFile.json(
            path=pathlib.Path("index.json"),
            content={
                "name": project.name,
                "version": project.version,
                "packages": package_index,
            }
        )
