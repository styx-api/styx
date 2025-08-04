"""Serialize Styx IR to and from JSON."""

import dataclasses
import json
from typing import Any

from styx.ir.core import Param


def _param_body_type(param_body: Any) -> str:
    if isinstance(param_body, Param.String):
        return "string"
    if isinstance(param_body, Param.Struct):
        return "struct"
    if isinstance(param_body, Param.StructUnion):
        return "struct_union"
    if isinstance(param_body, Param.Int):
        return "int"
    if isinstance(param_body, Param.Float):
        return "float"
    if isinstance(param_body, Param.Bool):
        return "bool"
    if isinstance(param_body, Param.File):
        return "file"
    assert False, "Not a valid param"


def _snake_to_camel_case(snake_str):
    camel_string = "".join(x.capitalize() for x in snake_str.lower().split("_"))
    return snake_str[0].lower() + camel_string[1:]


def serialize(obj: Any) -> Any:
    if obj is None:
        return None
    if dataclasses.is_dataclass(obj):
        result = {}
        for field in dataclasses.fields(obj):
            value = getattr(obj, field.name)
            name = _snake_to_camel_case(field.name)
            result[name] = serialize(value)
        return result
    if isinstance(obj, list):
        return [serialize(item) for item in obj]
    if isinstance(obj, dict):
        return {k: serialize(v) for k, v in obj.items()}
    if isinstance(obj, Param):
        return {
            "base": serialize(obj.base),
            "body": {"type": _param_body_type(obj.body), **serialize(obj.body)},
            "list": serialize(obj.list_),
            "nullable": serialize(obj.nullable),
            "choices": serialize(obj.choices),
            "defaultValue": serialize(obj.default_value),
        }
    if obj is Param.SetToNone:
        return {"_special": "SET_TO_NONE"}
    if isinstance(obj, (str, int, float, bool)):
        return obj

    assert False


def to_json(obj: Any, indent: int = None) -> str:
    """Serialize an object to JSON string.

    Args:
        obj: The object to serialize
        indent: Number of spaces for indentation (None for compact JSON)

    Returns:
        JSON string representation of the object
    """
    return json.dumps(serialize(obj), indent=indent)


def from_json(json_str: str) -> Any:
    """Deserialize a JSON string to an object.

    Args:
        json_str: JSON string to deserialize

    Returns:
        Deserialized object
    """
    raise NotImplementedError


def to_json_file(obj: Any, filename: str, indent: int = None) -> None:
    """Serialize an object to a JSON file.

    Args:
        obj: The object to serialize
        filename: Path to the output file
        indent: Number of spaces for indentation (None for compact JSON)
    """
    with open(filename, "w") as f:
        json.dump(serialize(obj), f, indent=indent)


def from_json_file(filename: str) -> Any:
    """Deserialize an object from a JSON file.

    Args:
        filename: Path to the JSON file

    Returns:
        Deserialized object
    """
    raise NotImplementedError
