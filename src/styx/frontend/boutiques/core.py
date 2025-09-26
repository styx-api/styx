"""Boutiques backend."""

import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import TypeVar

import styx.ir.core as ir
from styx.frontend.boutiques.utils import boutiques_split_command
from styx.ir.normalize import normalize

T = TypeVar("T")


def destruct_template(
    template: str,
    lookup: dict[str, T],
) -> list[str | T]:
    """Destruct a template string to a list of strings and replacements.

    This is used to safely destruct boutiques `command-line` as well as `path-template` strings.

    Example:
        >>> destruct_template(
        >>>     template="hello x, I am y",
        >>>     lookup={"x": 12, "y": 34},
        >>> )
        ["hello ", 12, ", I am ", 34]
    """
    destructed: list[str | T] = []
    stack: list[str | T] = [template]
    while len(stack) > 0:
        x = stack.pop(0)
        if not isinstance(x, str):
            destructed.append(x)
            continue
        did_split = False
        for alias, replacement in lookup.items():
            if alias in x:
                left, right = x.split(alias, 1)
                if len(right) > 0:
                    stack.insert(0, right)
                stack.insert(0, replacement)
                if len(left) > 0:
                    stack.insert(0, left)
                did_split = True
                break
        if not did_split:
            destructed.append(x)
    return destructed


@dataclass
class IdCounter:
    _counter: int = 0

    def next(self) -> int:
        self._counter += 1
        return self._counter - 1


def _hash_from_boutiques(tool: dict) -> str:
    """Generate a hash from a Boutiques tool."""
    json_str = json.dumps(tool, sort_keys=True)
    return hashlib.sha1(json_str.encode()).hexdigest()


def _bt_template_str_parse(
    input_command_line_template: str,
    lookup_input: dict[str, dict],
) -> list[list[str | dict]]:
    """Parse a Boutiques command line template string into segments."""
    bt_template_str = boutiques_split_command(input_command_line_template)
    return [destruct_template(arg, lookup_input) for arg in bt_template_str]


class InputTypePrimitive(Enum):
    String = 1
    Float = 2
    Integer = 3
    File = 4
    Flag = 5
    SubCommand = 6
    SubCommandUnion = 7


@dataclass
class InputType:
    primitive: InputTypePrimitive
    is_list: bool = False
    is_optional: bool = False
    is_enum: bool = False


def _input_type_primitive_from_boutiques(bt_input: dict) -> InputTypePrimitive:
    """Convert a Boutiques input to a Styx input type primitive."""
    if "type" not in bt_input:
        raise ValueError(f"type is missing for input: '{bt_input['id']}'")

    if isinstance(bt_input["type"], dict):
        return InputTypePrimitive.SubCommand

    if isinstance(bt_input["type"], list):
        return InputTypePrimitive.SubCommandUnion

    bt_type_name = bt_input["type"]
    if not isinstance(bt_type_name, str):
        bt_type_name = bt_type_name.value

    if bt_type_name == "String":
        return InputTypePrimitive.String
    elif bt_type_name == "File":
        return InputTypePrimitive.File
    elif bt_type_name == "Flag":
        return InputTypePrimitive.Flag
    elif bt_type_name == "Number" and not bt_input.get("integer"):
        return InputTypePrimitive.Float
    elif bt_type_name == "Number" and bt_input.get("integer"):
        return InputTypePrimitive.Integer
    else:
        raise NotImplementedError


def _input_type_from_boutiques(bt_input: dict) -> InputType:
    """Convert a Boutiques input to a Styx input type."""
    bt_is_list = bt_input.get("list") is True
    bt_is_optional = bt_input.get("optional") is True
    bt_is_enum = bt_input.get("value-choices") is not None
    primitive = _input_type_primitive_from_boutiques(bt_input)
    if primitive == InputTypePrimitive.File:
        assert not bt_is_enum
    if primitive == InputTypePrimitive.Flag:
        return InputType(InputTypePrimitive.Flag, False, True, False)
    return InputType(primitive, bt_is_list, bt_is_optional, bt_is_enum)


def _arg_elem_from_bt_elem(
    elem: dict,
    id_counter: IdCounter,
    ir_id_lookup: dict[str, ir.IdType],
) -> ir.Param:
    if not isinstance(elem, dict):
        assert False

    d = elem

    input_bt_ref = d["value-key"]
    input_docs = ir.Documentation(
        title=d.get("name"),
        description=d.get("description"),
    )
    input_name = d["id"]

    repeatable_join: str | None = d.get("list-separator")
    input_type = _input_type_from_boutiques(d)

    input_id = id_counter.next()
    ir_id_lookup[input_bt_ref] = input_id

    dparam = ir.Param.Base(
        id_=input_id,
        name=input_name,
        docs=input_docs,
    )

    constraints = _collect_constraints(d, input_type)

    dlist = None
    if input_type.is_list:
        dlist = ir.Param.List(
            join=repeatable_join,
            count_min=constraints.list_length_min,
            count_max=constraints.list_length_max,
        )

    match input_type.primitive:
        case InputTypePrimitive.String:
            choices = d.get("value-choices")
            assert choices is None or all([isinstance(o, str) for o in choices]), (
                "value-choices must be all string for string input"
            )

            return ir.Param(
                base=dparam,
                body=ir.Param.String(),
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=d.get("default-value", ir.Param.SetToNone)
                if input_type.is_optional
                else d.get("default-value"),
                choices=choices,
            )

        case InputTypePrimitive.Integer:
            choices = d.get("value-choices")
            assert choices is None or all([isinstance(o, int) for o in choices]), (
                "value-choices must be all int for integer input"
            )
            assert constraints.value_min is None or isinstance(constraints.value_min, int)
            assert constraints.value_max is None or isinstance(constraints.value_max, int)

            return ir.Param(
                base=dparam,
                body=ir.Param.Int(
                    min_value=constraints.value_min,
                    max_value=constraints.value_max,
                ),
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=d.get("default-value", ir.Param.SetToNone)
                if input_type.is_optional
                else d.get("default-value"),
                choices=choices,
            )

        case InputTypePrimitive.Float:
            return ir.Param(
                base=dparam,
                body=ir.Param.Float(
                    min_value=constraints.value_min,
                    max_value=constraints.value_max,
                ),
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=d.get("default-value", ir.Param.SetToNone)
                if input_type.is_optional
                else d.get("default-value"),
            )

        case InputTypePrimitive.File:
            return ir.Param(
                base=dparam,
                body=ir.Param.File(
                    resolve_parent=d.get("resolve-parent") is True,
                    mutable=d.get("mutable") is True,
                ),
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=ir.Param.SetToNone if input_type.is_optional else None,
            )

        case InputTypePrimitive.Flag:
            input_prefix = d.get("command-line-flag")
            assert input_prefix is not None, "Flag type input must have command-line-flag"

            return ir.Param(
                base=dparam,
                body=ir.Param.Bool(
                    value_true=[input_prefix] if input_prefix else [],
                ),
                default_value=d.get("default-value") is True,
            )
        case InputTypePrimitive.SubCommand:
            dparam, dstruct = _struct_from_boutiques(d, id_counter)
            ir_id_lookup[input_bt_ref] = dparam.id_  # override

            return ir.Param(
                base=dparam,
                body=dstruct,
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=ir.Param.SetToNone if input_type.is_optional else None,
            )

        case InputTypePrimitive.SubCommandUnion:
            bt_alts = d.get("type")
            assert isinstance(bt_alts, list)

            alts: list[ir.Param[ir.Param.Struct]] = []
            for bt_alt in bt_alts:
                alt_dparam, alt_dstruct = _struct_from_boutiques(bt_alt, id_counter)
                alts.append(
                    ir.Param(
                        base=alt_dparam,
                        body=alt_dstruct,
                    )
                )

            return ir.Param(
                base=dparam,
                body=ir.Param.StructUnion(
                    alts=alts,
                ),
                list_=dlist,
                nullable=input_type.is_optional,
                default_value=ir.Param.SetToNone if input_type.is_optional else None,
            )
    assert False


@dataclass
class _NumericConstraints:
    value_min: int | float | None = None
    value_max: int | float | None = None
    list_length_min: int | None = None
    list_length_max: int | None = None


def _collect_constraints(d: dict, input_type: InputType) -> _NumericConstraints:
    ret = _NumericConstraints()
    value_min_exclusive = False
    value_max_exclusive = False
    if input_type.primitive in (InputTypePrimitive.Float, InputTypePrimitive.Integer):
        if (val := d.get("minimum")) is not None:
            ret.value_min = int(val) if d.get("integer") else val
            value_min_exclusive = d.get("exclusive-minimum") is True
        if (val := d.get("maximum")) is not None:
            ret.value_max = int(val) if d.get("integer") else val
            value_max_exclusive = d.get("exclusive-maximum") is True
    if d.get("list") is True:
        ret.list_length_min = d.get("min-list-entries")
        ret.list_length_max = d.get("max-list-entries")
    if ret.value_min is not None and value_min_exclusive and input_type.primitive == InputTypePrimitive.Integer:
        ret.value_min += 1
    if ret.value_max is not None and value_max_exclusive and input_type.primitive == InputTypePrimitive.Integer:
        ret.value_max -= 1
    return ret


def _struct_from_boutiques(
    bt: dict,
    id_counter: IdCounter,
) -> tuple[ir.Param.Base, ir.Param.Struct]:
    def _get_authors(bt: dict) -> list[str]:
        if "author" in bt:
            return [bt["author"]]
        return []

    def _get_urls(bt: dict) -> list[str]:
        if "url" in bt:
            return [bt["url"]]
        return []

    parent_input: dict | None = None
    if "type" not in bt:  # Root boutiques descriptor
        if (bt_id := bt.get("id", bt.get("name"))) is None:
            raise Exception(f"Descriptor is missing id/name: {bt_id}")

        groups, ir_id_lookup = _collect_inputs(bt, id_counter)
        outputs = _collect_outputs(bt, ir_id_lookup, id_counter)

        docs = ir.Documentation(
            title=bt.get("name"),
            description=bt.get("description"),
            authors=_get_authors(bt),
            urls=_get_urls(bt),
        )

        return ir.Param.Base(
            id_=id_counter.next(),
            name=bt_id,
            outputs=outputs,
            docs=docs,
        ), ir.Param.Struct(
            name=bt_id,
            groups=groups,
            docs=docs,
        )

    else:
        parent_input = bt
        bt = bt["type"]

        groups, ir_id_lookup = _collect_inputs(bt, id_counter)
        outputs = _collect_outputs(bt, ir_id_lookup, id_counter)

        docs_parent = ir.Documentation(
            title=bt.get("name"),
            description=parent_input.get("description"),
            authors=_get_authors(parent_input),
            urls=_get_urls(parent_input),
        )

        docs = ir.Documentation(
            title=bt.get("name"),
            description=bt.get("description"),
            authors=_get_authors(bt),
            urls=_get_urls(bt),
        )

        return ir.Param.Base(
            id_=id_counter.next(),
            name=parent_input["id"],
            outputs=outputs,
            docs=docs_parent,
        ), ir.Param.Struct(
            name=bt["id"],
            groups=groups,
            docs=docs,
        )


def _collect_outputs(bt: dict, ir_id_lookup: dict[str, ir.IdType], id_counter: IdCounter) -> list[ir.Output]:
    outputs: list[ir.Output] = []
    for bt_output in bt.get("output-files", []):
        path_template = bt_output["path-template"]
        destructed = destruct_template(path_template, ir_id_lookup)
        output_sequence: list[str | ir.OutputParamReference] = [
            ir.OutputParamReference(
                ref_id=x,
                file_remove_suffixes=bt_output.get("path-template-stripped-extensions", []),
                fallback=bt_output.get("path-template-fallback", None),
            )
            if isinstance(x, int)
            else x
            for x in destructed
        ]
        outputs.append(
            ir.Output(
                id_=id_counter.next(),
                name=bt_output["id"],
                tokens=output_sequence,
                docs=ir.Documentation(description=bt_output.get("description"), title=bt_output.get("name")),
            )
        )
    return outputs


def _collect_inputs(bt: dict, id_counter: IdCounter) -> tuple[list[ir.ConditionalGroup], dict[str, ir.IdType]]:
    inputs_lookup = {i["value-key"]: i for i in bt.get("inputs", [])}
    # maps boutiques 'value-keys' to expressions
    ir_id_lookup: dict[str, ir.IdType] = {}
    groups: list[ir.ConditionalGroup] = []
    for bt_segment in _bt_template_str_parse(bt.get("command-line", ""), inputs_lookup):
        group = ir.ConditionalGroup()
        carg = ir.CmdArg()

        for bt_elem in bt_segment:
            if isinstance(bt_elem, str):
                carg.tokens.append(bt_elem)
                continue

            param = _arg_elem_from_bt_elem(
                bt_elem,
                id_counter,
                ir_id_lookup,
            )

            if not isinstance(param.body, ir.Param.Bool):
                # bool arguments use command line flag as value
                input_prefix: str | None = bt_elem.get("command-line-flag")
                input_prefix_join: str | None = bt_elem.get("command-line-flag-separator")
                if input_prefix_join is not None:
                    carg.tokens.append((input_prefix if input_prefix else "") + input_prefix_join)
                elif input_prefix:
                    group.cargs.append(ir.CmdArg([input_prefix]))

            carg.tokens.append(param)

        group.cargs.append(carg)
        groups.append(group)

    return groups, ir_id_lookup


def _collect_stdout_stderr_output(bt: dict, id_counter: IdCounter) -> ir.StreamOutput:
    assert "id" in bt, "StdOut / StdErr Output needs id"
    return ir.StreamOutput(
        id_=id_counter.next(),
        name=bt["id"],
        docs=ir.Documentation(title=bt.get("name"), description=bt.get("description")),
    )


@dataclass
class BoutiquesPartialPackage:
    docker: str | None = None
    version: str | None = None


def partial_package_info_from_boutiques(
    tool: dict,
) -> BoutiquesPartialPackage:
    """Boutiques may provide some package level information in the tool descriptor."""

    docker: str | None = None
    if "container-image" in tool:
        docker = tool["container-image"].get("image")
    return BoutiquesPartialPackage(
        docker=docker,
        version=tool.get("tool-version"),
    )


def from_boutiques(
    tool: dict,
) -> ir.App:
    """Convert a Boutiques tool to a Styx descriptor."""
    hash_ = _hash_from_boutiques(tool)

    id_counter = IdCounter()

    stdout_output: ir.StreamOutput | None = None
    stderr_output: ir.StreamOutput | None = None
    if "stdout-output" in tool:
        stdout_output = _collect_stdout_stderr_output(tool["stdout-output"], id_counter)
    if "stderr-output" in tool:
        stderr_output = _collect_stdout_stderr_output(tool["stderr-output"], id_counter)

    dparam, dstruct = _struct_from_boutiques(tool, id_counter)

    return normalize(
        ir.App(
            uid=f"{hash_}.boutiques",
            command=ir.Param(
                base=dparam,
                body=dstruct,
            ),
            capture_stderr=stderr_output,
            capture_stdout=stdout_output,
        )
    )
