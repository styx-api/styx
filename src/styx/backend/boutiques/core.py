"""Boutiques backend for converting Styx IR to Boutiques descriptors."""

import json
import pathlib
import typing
from typing import Optional, Union

import styx.ir.core as ir
from styx.backend.common import TextFile


class BoutiquesConversionError(Exception):
    """Raised when IR cannot be converted to Boutiques."""

    pass


def warn(message: str) -> None:
    print(f"WARNING: {message}")


def _convert_documentation(docs: ir.Documentation) -> dict:
    """Convert IR documentation to Boutiques format."""
    result = {}
    if docs.description:
        result["description"] = docs.description
    if docs.title:
        result["name"] = docs.title
    if docs.authors:
        result["author"] = docs.authors[0]
        if len(docs.authors) > 1:
            warn("Boutiques only supports a single author")
    if docs.urls:
        result["url"] = docs.urls[0]
        if len(docs.authors) > 1:
            warn("Boutiques only supports a single URL")
    return result


def _convert_param_type(param: ir.Param, value_key: str) -> dict:
    """Convert IR parameter type to Boutiques format."""
    result = {"value-key": value_key}

    if isinstance(param.body, ir.Param.Bool):
        result["type"] = "Flag"
        if param.body.value_true:
            result["command-line-flag"] = param.body.value_true[0]
        if param.body.value_false:
            result["command-line-flag-false"] = param.body.value_false[0]
        # Omit default-value for flags unless explicitly true
        if param.default_value is True:
            result["default-value"] = True

    elif isinstance(param.body, ir.Param.Int):
        result["type"] = "Number"
        result["integer"] = True
        if param.body.min_value is not None:
            result["minimum"] = param.body.min_value
        if param.body.max_value is not None:
            result["maximum"] = param.body.max_value

    elif isinstance(param.body, ir.Param.Float):
        result["type"] = "Number"
        if param.body.min_value is not None:
            result["minimum"] = param.body.min_value
        if param.body.max_value is not None:
            result["maximum"] = param.body.max_value

    elif isinstance(param.body, ir.Param.String):
        result["type"] = "String"

    elif isinstance(param.body, ir.Param.File):
        result["type"] = "File"
        # Note: Boutiques doesn't have direct equivalents for resolve_parent and mutable

    elif isinstance(param.body, ir.Param.Struct):
        # Convert Struct to a Boutiques subcommand
        nested = _convert_struct_to_subcommand(param.body, value_key)
        result["type"] = nested

    elif isinstance(param.body, ir.Param.StructUnion):
        # Convert StructUnion to Boutiques type list
        alternatives = []
        for alt in param.body.alts:
            if not isinstance(alt.body, ir.Param.Struct):
                raise BoutiquesConversionError(f"StructUnion alternatives must be Structs, got {type(alt.body)}")
            alt_desc = _convert_struct_to_subcommand(alt.body, value_key)
            alternatives.append(alt_desc)
        result["type"] = alternatives

    else:
        raise BoutiquesConversionError(f"Unsupported parameter type: {type(param.body)}")

    if param.list_:
        result["list"] = True
        if param.list_.join:
            result["list-separator"] = param.list_.join
        if param.list_.count_min is not None:
            result["min-list-entries"] = param.list_.count_min
        if param.list_.count_max is not None:
            result["max-list-entries"] = param.list_.count_max

    if param.nullable:
        result["optional"] = True

    if param.choices:
        result["value-choices"] = param.choices

    if param.default_value is not None:
        if param.default_value is not ir.Param.SetToNone:
            result["default-value"] = param.default_value

    return result


def _convert_struct_to_subcommand(struct: ir.Param.Struct, value_key: str) -> dict:
    """Convert IR Struct to Boutiques subcommand format."""
    result = {
        "id": struct.name if struct.name else "unnamed_struct",
        "command-line": _build_command_template(struct.groups)[0],  # Only need template string
    }

    if struct.docs:
        result.update(_convert_documentation(struct.docs))

    # Convert nested inputs
    result["inputs"] = []
    for group in struct.groups:
        for carg in group.cargs:
            for token in carg.tokens:
                if isinstance(token, ir.Param):
                    try:
                        nested_key = f"[{token.base.name.upper()}]"
                        param_desc = _convert_param_type(token, nested_key)
                        param_desc["id"] = token.base.name
                        if token.base.docs:
                            param_desc.update(_convert_documentation(token.base.docs))
                        result["inputs"].append(param_desc)
                    except BoutiquesConversionError as e:
                        raise BoutiquesConversionError(f"Error converting nested parameter {token.base.name}: {str(e)}")

    return result


def _process_command_tokens(tokens: list[Union[str, ir.Param]], param_to_key: dict[int, str]) -> list[str]:
    """Process command tokens and collect command line flags."""
    result = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if isinstance(token, str):
            # Check if next token is a parameter that could use this as a flag
            if (
                i + 1 < len(tokens)
                and isinstance(tokens[i + 1], ir.Param)
                and not isinstance(tokens[i + 1].body, ir.Param.Bool)
            ):  # Bools handle their own flags
                param = tokens[i + 1]
                # Store the flag for this parameter's type description
                param_to_key[param.base.id_] = (token, None)
                # Skip both tokens - flag will be handled by parameter
                i += 2
                result.append(f"[{param.base.name.upper()}]")
                continue
            result.append(token)
        elif isinstance(token, ir.Param):
            value_key = f"[{token.base.name.upper()}]"
            param_to_key[token.base.id_] = value_key
            result.append(value_key)
        i += 1
    return result


def _build_command_template(groups: list[ir.ConditionalGroup]) -> tuple[str, dict[int, str]]:
    """Build Boutiques command-line template from IR groups."""
    parts = []
    param_to_key = {}

    for group in groups:
        group_parts = []
        for carg in group.cargs:
            if carg.join is not None:
                # If we have a join string, process all tokens together
                processed = _process_command_tokens(carg.tokens, param_to_key)
                group_parts.append(carg.join.join(processed))
            else:
                # Otherwise process tokens individually
                processed = _process_command_tokens(carg.tokens, param_to_key)
                group_parts.extend(processed)

        if group.join:
            parts.append(group.join.join(group_parts))
        else:
            parts.extend(group_parts)

    return " ".join(parts), param_to_key


def _convert_outputs(
    outputs: list[ir.Output],
    stdout: Optional[ir.StdOutErrAsStringOutput],
    stderr: Optional[ir.StdOutErrAsStringOutput],
) -> dict:
    """Convert IR outputs to Boutiques format."""
    result = {}

    # Handle regular file outputs
    if outputs:
        result["output-files"] = []
        for output in outputs:
            output_desc = {
                "id": output.name,
                "path-template": "".join(
                    str(token)
                    if isinstance(token, str)
                    else "[MASK]"  # HARDCODE FOR NOW - need to get name from param lookup
                    for token in output.tokens
                ),
            }
            if output.docs:
                output_desc.update(_convert_documentation(output.docs))

            # Collect all strip extensions from references
            stripped_extensions = [
                suffix
                for token in output.tokens
                if isinstance(token, ir.OutputParamReference)
                for suffix in token.file_remove_suffixes
            ]
            if stripped_extensions:
                output_desc["path-template-stripped-extensions"] = stripped_extensions

            result["output-files"].append(output_desc)

    # Handle stdout/stderr
    if stdout:
        result["stdout-output"] = {
            "id": stdout.name,
            "name": stdout.name,
            "description": stdout.docs.description if stdout.docs.description else None,
        }

    if stderr:
        result["stderr-output"] = {
            "id": stderr.name,
            "name": stderr.name,
            "description": stderr.docs.description if stderr.docs.description else None,
        }

    return result


def to_boutiques(interface: ir.Interface) -> dict:
    """Convert a Styx IR Interface to a Boutiques descriptor."""
    try:
        descriptor = {
            "name": interface.package.name,
            "schema-version": "0.5",  # Current Boutiques schema version
        }

        # Add package metadata
        if interface.package.version:
            descriptor["tool-version"] = interface.package.version

        descriptor.update(_convert_documentation(interface.package.docs))

        if interface.package.docker:
            descriptor["container-image"] = {"type": "docker", "image": interface.package.docker}

        # Convert command structure
        if not isinstance(interface.command.body, ir.Param.Struct):
            raise BoutiquesConversionError("Top-level command must be a Struct")

        # Generate command line template and collect inputs
        command_line, param_to_key = _build_command_template(interface.command.body.groups)
        descriptor["command-line"] = command_line

        # Convert all parameters
        inputs = []
        for group in interface.command.body.groups:
            if len(group.cargs) == 2 and len(group.cargs[1].tokens) == 1 and isinstance(group.cargs[1].tokens[0], str):
                last_command_line_flag = group.cargs[1].tokens[0]
            else:
                last_command_line_flag = None

            for carg in group.cargs:
                for token in carg.tokens:
                    if isinstance(token, ir.Param):
                        try:
                            param_desc = _convert_param_type(token, param_to_key[token.base.id_])
                            param_desc["id"] = token.base.name
                            if last_command_line_flag is not None:
                                param_desc["command-line-flag"] = last_command_line_flag
                            if token.base.docs:
                                param_desc.update(_convert_documentation(token.base.docs))
                            inputs.append(param_desc)
                        except BoutiquesConversionError as e:
                            warn(f"Error converting parameter {token.base.name}: {str(e)}")

        if inputs:
            descriptor["inputs"] = inputs

        # Convert outputs
        outputs = _convert_outputs(
            interface.command.base.outputs, interface.stdout_as_string_output, interface.stderr_as_string_output
        )
        descriptor.update(outputs)

        return descriptor

    except Exception as e:
        raise BoutiquesConversionError(f"Failed to convert interface to Boutiques: {str(e)}")


def compile_boutiques_json(
    interfaces: typing.Iterable[ir.Interface],
) -> typing.Generator[TextFile, typing.Any, None]:
    for interface in interfaces:
        yield TextFile(
            path=pathlib.Path(interface.uid + ".json"),
            content=json.dumps(to_boutiques(interface), indent=2),
        )
