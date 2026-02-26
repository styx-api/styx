import pathlib
import re
import typing

from styx.backend import TextFile
from styx.backend.compile import Compilable
from styx.backend.generic.documentation import docs_to_docstring
from styx.backend.generic.gen.app import compile_app
from styx.backend.generic.gen.lookup import SymbolLUT
from styx.backend.generic.languageprovider import (
    TYPE_PYLITERAL,
    ExprType,
    LanguageExprProvider,
    LanguageHighLevelProvider,
    LanguageIrProvider,
    LanguageProvider,
    LanguageSymbolProvider,
    LanguageTypeProvider,
    MStr,
)
from styx.backend.generic.linebuffer import (
    LineBuffer,
    blank_after,
    blank_before,
    collapse,
    comment,
    concat,
    expand,
    indent,
)
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure
from styx.backend.generic.scope import Scope
from styx.backend.generic.string_case import pascal_case, screaming_snake_case, snake_case
from styx.backend.generic.utils import (
    enbrace,
    enquote,
    ensure_endswith,
    escape_backslash,
    linebreak_paragraph,
)
from styx.backend.python.templates import (
    template_sub_pyproject,
    template_sub_readme,
    template_root_init_py,
    template_root_pyproject,
)
from styx.ir import core as ir


class PythonLanguageTypeProvider(LanguageTypeProvider):
    def type_str(self) -> str:
        """String type."""
        return "str"

    def type_int(self) -> str:
        """Integer type."""
        return "int"

    def type_float(self) -> str:
        """Float type."""
        return "float"

    def type_bool(self) -> str:
        """Bool type."""
        return "bool"

    def type_input_path(self) -> str:
        """Input path type."""
        return "InputPathType"

    def type_output_path(self) -> str:
        """Type of output path."""
        return "OutputPathType"

    def type_runner(self) -> str:
        """Type of Runner."""
        return "Runner"

    def type_execution(self) -> str:
        """Type of Execution."""
        return "Execution"

    def type_literal_union(self, obj: list[TYPE_PYLITERAL]) -> str:
        """Convert an object to a language literal union type."""
        return f"typing.Literal[{', '.join(map(self.expr_literal, obj))}]"

    def type_list(self, type_element: str) -> str:
        """Convert a type symbol to a type of list of that type."""
        return f"list[{type_element}]"

    def type_optional(self, type_element: str) -> str:
        """Convert a type symbol to an optional of that type."""
        return f"{type_element} | None"

    def type_union(self, type_elements: list[str]) -> str:
        """Convert a collection of type symbol to a union type of them."""
        return f"typing.Union[{', '.join(type_elements)}]"

    def type_string_list(self) -> str:
        return "list[str]"


class PythonLanguageSymbolProvider(LanguageSymbolProvider):
    def symbol_legal(self, name: str) -> bool:
        return name.isidentifier()

    def language_scope(self) -> Scope:
        import builtins
        import keyword
        import sys

        scope = Scope(self)

        for s in {
            *keyword.kwlist,
            *sys.stdlib_module_names,
            *dir(builtins),
            *dir(__builtins__),
        }:
            scope.add_or_die(s)

        return scope

    def symbol_from(self, name: str) -> str:
        alt_prefix: str = "v_"
        name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
        # Prefix if name starts with a digit or underscore
        if re.match(r"^[0-9_]", name):
            name = f"{alt_prefix}{name}"
        return name

    def symbol_constant_case_from(self, name: str) -> str:
        return screaming_snake_case(self.symbol_from(name))

    def symbol_class_case_from(self, name: str) -> str:
        return pascal_case(self.symbol_from(name))

    def symbol_var_case_from(self, name: str) -> str:
        return snake_case(self.symbol_from(name))


class PythonLanguageIrProvider(LanguageIrProvider):
    def build_params_and_execute(
        self, lookup: SymbolLUT, struct: ir.Param[ir.Param.Struct], runner_symbol: ExprType
    ) -> LineBuffer:
        args = [lookup.var_param[elem.base.id_] for elem in struct.body.iter_params_shallow()]
        return [
            f"params = {lookup.fn_struct_make_params[struct.base.id_]}(",
            *indent([f"{a}={a}," for a in args]),
            ")",
            self.return_statement(f"{lookup.fn_struct_execute[struct.base.id_]}(params, {runner_symbol})"),
        ]

    def call_build_cargs(
        self,
        lookup: SymbolLUT,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        return [
            f"{return_symbol} = {lookup.fn_struct_make_cmdargs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def call_build_outputs(
        self,
        lookup: SymbolLUT,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        return [
            f"{return_symbol} = {lookup.fn_struct_make_outputs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def param_var_to_mstr(
        self,
        lut: SymbolLUT,
        param: ir.Param,
        symbol: str,
    ) -> MStr:
        def _val() -> MStr:
            if not param.list_:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, False)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"str({symbol})", False)
                if isinstance(param.body, ir.Param.Bool):
                    as_list = (len(param.body.value_true) > 1) or (len(param.body.value_false) > 1)
                    if as_list:
                        value_true: str | list[str] | None = param.body.value_true
                        value_false: str | list[str] | None = param.body.value_false
                    else:
                        value_true = param.body.value_true[0] if len(param.body.value_true) > 0 else None
                        value_false = param.body.value_false[0] if len(param.body.value_false) > 0 else None
                    if len(param.body.value_true) > 0:
                        if len(param.body.value_false) > 0:
                            return MStr(
                                f"({self.expr_literal(value_true)} if {symbol} else {self.expr_literal(value_false)})",
                                as_list,
                            )
                        return MStr(self.expr_literal(value_true), as_list)
                    assert len(param.body.value_false) > 0
                    return MStr(self.expr_literal(value_false), as_list)
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", resolve_parent=True"
                    if param.body.mutable:
                        extra_args += ", mutable=True"
                    return MStr(f"execution.input_file({symbol}{extra_args})", False)
                if isinstance(param.body, ir.Param.Struct):
                    return MStr(f"{lut.fn_struct_make_cmdargs[param.base.id_]}({symbol}, execution)", True)
                if isinstance(param.body, ir.Param.StructUnion):
                    return MStr(
                        f'{lut.fn_dyn_union_fn_struct_make_cmdargs[param.base.id_]}({symbol}["@type"])({symbol}, execution)',
                        True,
                    )
                assert False

            if param.list_.join is None:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, True)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"map(str, {symbol})", True)
                if isinstance(param.body, ir.Param.Bool):
                    on_true = self.expr_literal("".join(param.body.value_true))
                    on_false = self.expr_literal("".join(param.body.value_false))
                    return MStr(f"[{on_true} if v else {on_false} for v in {symbol}]", True)
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", resolve_parent=True"
                    if param.body.mutable:
                        extra_args += ", mutable=True"
                    return MStr(f"[execution.input_file(f{extra_args}) for f in {symbol}]", True)
                if isinstance(param.body, ir.Param.Struct):
                    return MStr(
                        f"[a for c in [{lut.fn_struct_make_cmdargs[param.base.id_]}(s, execution) for s in {symbol}] for a in c]",
                        True,
                    )
                if isinstance(param.body, ir.Param.StructUnion):
                    return MStr(
                        f'[a for c in [{lut.fn_dyn_union_fn_struct_make_cmdargs[param.base.id_]}(s["@type"])(s, execution) for s in {symbol}] for a in c]',
                        True,
                    )
                assert False

            # arg.data.list_separator is not None
            sep_join = f"{enquote(param.list_.join)}.join"
            if isinstance(param.body, ir.Param.String):
                return MStr(f"{sep_join}({symbol})", False)
            if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                return MStr(f"{sep_join}(map(str, {symbol}))", False)
            if isinstance(param.body, ir.Param.Bool):
                on_true = self.expr_literal("".join(param.body.value_true))
                on_false = self.expr_literal("".join(param.body.value_false))
                return MStr(f"{sep_join}([{on_true} if v else {on_false} for v in {symbol}])", True)
            if isinstance(param.body, ir.Param.File):
                extra_args = ""
                if param.body.resolve_parent:
                    extra_args += ", resolve_parent=True"
                if param.body.mutable:
                    extra_args += ", mutable=True"
                return MStr(f"{sep_join}([execution.input_file(f{extra_args}) for f in {symbol}])", False)
            if isinstance(param.body, ir.Param.Struct):
                return MStr(
                    f"{sep_join}([a for c in [{lut.fn_struct_make_cmdargs[param.base.id_]}(s, execution) for s in {symbol}] for a in c])",
                    False,
                )
            if isinstance(param.body, ir.Param.StructUnion):
                return MStr(
                    f'{sep_join}([a for c in [{lut.fn_dyn_union_fn_struct_make_cmdargs[param.base.id_]}(s["@type"])(s, execution) for s in {symbol}] for a in c])',
                    False,
                )
            assert False

        return _val()

    def param_var_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        if param.nullable:
            if enbrace_statement:
                return f"({symbol} is not None)"
            return f"{symbol} is not None"

        if isinstance(param.body, ir.Param.Bool):
            if len(param.body.value_true) > 0 and len(param.body.value_false) == 0:
                return symbol
            if len(param.body.value_false) > 0 and len(param.body.value_true) == 0:
                if enbrace_statement:
                    return f"(not {symbol})"
                return f"not {symbol}"
            if len(param.body.value_false) == 0 and len(param.body.value_true) == 0:
                return "False"  # Never emits anything (useless param)
            if len(param.body.value_false) > 0 and len(param.body.value_true) > 0:
                return None
        return None

    def param_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        if param.nullable:
            if enbrace_statement:
                return f"({symbol} is not None)"
            return f"{symbol} is not None"

        if isinstance(param.body, ir.Param.Bool):
            if len(param.body.value_true) > 0 and len(param.body.value_false) == 0:
                return symbol
            if len(param.body.value_false) > 0 and len(param.body.value_true) == 0:
                if enbrace_statement:
                    return f"(not {symbol})"
                return f"not {symbol}"
        return None

    def call_validate_params(
        self,
        lookup: SymbolLUT,
        params_symbol: ExprType,
    ) -> LineBuffer:
        return [f"{lookup.fn_root_validate_params}({params_symbol})"]


class PythonLanguageExprProvider(LanguageExprProvider):
    def expr_line_comment(self, comment_: LineBuffer) -> LineBuffer:
        return comment(comment_, "#")

    def expr_bool(self, obj: bool) -> ExprType:
        """Convert a bool to a language literal."""
        return "True" if obj else "False"

    def expr_int(self, obj: int) -> ExprType:
        """Convert an int to a language literal."""
        return str(obj)

    def expr_float(self, obj: float) -> ExprType:
        """Convert a float to a language literal."""
        return str(obj)

    def expr_str(self, obj: str) -> ExprType:
        """Convert a string to a language literal."""
        return enquote(obj.replace("\\", "\\\\").replace('"', '\\"'))

    def expr_path(self, obj: pathlib.Path) -> ExprType:
        """Convert a path to a language literal."""
        return f"pathlib.Path({self.expr_str(str(obj))})"

    def expr_list(self, obj: list[ExprType]) -> ExprType:
        """Convert a list to a language literal."""
        return enbrace(", ".join(obj), "[")

    def expr_dict(self, obj: dict[ExprType, ExprType]) -> ExprType:
        """Convert a dict to a language literal."""
        return enbrace(", ".join([f"{k}: {v}" for k, v in obj.items()]), "{")

    def expr_numeric_to_str(self, numeric_expr: str) -> str:
        return f"str({numeric_expr})"

    def expr_null(self) -> str:
        return "None"

    def expr_remove_suffixes(self, str_expr: str, suffixes: list[str]) -> str:
        substitute = str_expr
        for suffix in suffixes:
            substitute += f".removesuffix({self.expr_literal(suffix)})"
        return substitute

    def expr_path_get_filename(self, path_expr: str) -> str:
        return f"pathlib.Path({path_expr}).name"

    def expr_conditions_join_and(self, condition_exprs: list[str]) -> str:
        return " and ".join(condition_exprs)

    def expr_conditions_join_or(self, condition_exprs: list[str]) -> str:
        return " or ".join(condition_exprs)

    def expr_concat_strs(self, exprs: list[str], join: str = "") -> str:
        if join:
            return f"{self.expr_str(join)}.join([{', '.join(exprs)}])"
        return " + ".join(exprs)

    def expr_ternary(self, condition: str, truthy: str, falsy: str, enbrace_: bool = False) -> str:
        if " " in condition:
            condition = enbrace(condition, "(")
        ret = f"{truthy} if {condition} else {falsy}"
        if enbrace_:
            return enbrace(ret, "(")
        return ret


class PythonLanguageHighLevelProvider(LanguageHighLevelProvider):
    def wrapper_module_imports(self) -> LineBuffer:
        return [
            "import typing",
            "import pathlib",
            "from styxdefs import *",
        ]

    def struct_collect_outputs(
        self, lut: SymbolLUT, struct: ir.Param[ir.Param.Struct] | ir.Param[ir.Param.StructUnion], struct_symbol: str
    ) -> str:
        if isinstance(struct.body, ir.Param.Struct):
            if struct.list_:
                opt = ""
                if struct.nullable:
                    opt = f" if {struct_symbol} else None"

                return (  # todo what is this condition?
                    f"[{lut.fn_struct_make_outputs[struct.base.id_]}(i, execution) "
                    f"if {lut.fn_struct_make_outputs[struct.base.id_]} else None for i in {struct_symbol}]{opt}"
                )

            o = f"{lut.fn_struct_make_outputs[struct.base.id_]}({struct_symbol}, execution)"
            if struct.nullable:
                o = f"{o} if {struct_symbol} else None"

        else:
            if struct.list_:
                opt = ""
                if struct.nullable:
                    opt = f" if {struct_symbol} else None"
                return (
                    f'[{lut.fn_dyn_union_fn_struct_make_outputs[struct.base.id_]}(i["@type"])(i, execution) '
                    f'if {lut.fn_dyn_union_fn_struct_make_outputs[struct.base.id_]}(i["@type"]) else None for i in {struct_symbol}]{opt}'
                )

            o = f'{lut.fn_dyn_union_fn_struct_make_outputs[struct.base.id_]}({struct_symbol}["@type"])({struct_symbol}, execution)'
            if struct.nullable:
                o = f"{o} if {struct_symbol} else None"

        return o

    def runner_symbol(self) -> str:
        return "runner"

    def runner_declare(self, runner_symbol: str) -> LineBuffer:
        return [f"{runner_symbol} = {runner_symbol} or get_global_runner()"]

    def symbol_execution(self) -> str:
        return "execution"

    def execution_declare(self, execution_symbol: str, metadata_symbol: str) -> LineBuffer:
        return [f"{execution_symbol} = runner.start_execution({metadata_symbol})"]

    def execution_process_params(
        self,
        execution_symbol: str,
        params_symbol: str,
    ) -> LineBuffer:
        return [f"{params_symbol} = {execution_symbol}.params({params_symbol})"]

    def execution_run(
        self,
        execution_symbol: str,
        cargs_symbol: str,
        stdout_output_symbol: str | None,
        stderr_output_symbol: str | None,
    ) -> LineBuffer:
        so = "" if stdout_output_symbol is None else f", handle_stdout=lambda s: ret.{stdout_output_symbol}.append(s)"
        se = "" if stderr_output_symbol is None else f", handle_stderr=lambda s: ret.{stderr_output_symbol}.append(s)"
        return [f"{execution_symbol}.run({cargs_symbol}{so}{se})"]

    def generate_arg_declaration(self, arg: GenericArg) -> str:
        annot_type = f": {arg.type}" if arg.type is not None else ""
        if arg.default is None:
            return f"{arg.name}{annot_type}"
        return f"{arg.name}{annot_type} = {arg.default}"

    def generate_func(self, func: GenericFunc) -> LineBuffer:
        buf = []

        # Sort arguments so default arguments come last
        func.args.sort(key=lambda a: a.default is not None)

        # Function signature
        buf.append(f"def {func.name}(")

        # Add arguments
        for arg in func.args:
            buf.extend(indent([f"{self.generate_arg_declaration(arg)},"]))
        buf.append(f") -> {func.return_type}:")

        arg_docstr_buf = []
        for arg in func.args:
            if arg.name == "self":
                continue
            arg_docstr = linebreak_paragraph(
                f"{arg.name}: {escape_backslash(arg.docstring) if arg.docstring else ''}",
                width=80 - (4 * 3) - 1,
                first_line_width=80 - (4 * 2) - 1,
            )
            arg_docstr = ensure_endswith("\\\n".join(arg_docstr), ".").split("\n")
            arg_docstr_buf.append(arg_docstr[0])
            arg_docstr_buf.extend(indent(arg_docstr[1:]))

        # Add docstring (Google style)

        if func.docstring_body:
            docstring_linebroken = linebreak_paragraph(escape_backslash(func.docstring_body), width=80 - 4)
        else:
            docstring_linebroken = [""]

        buf.extend(
            indent([
                '"""',
                *docstring_linebroken,
                "",
                "Args:",
                *indent(arg_docstr_buf),
                *(["Returns:", *indent([f"{escape_backslash(func.return_descr)}"])] if func.return_descr else []),
                '"""',
            ])
        )

        # Add function body
        if func.body:
            buf.extend(indent(func.body))
        else:
            buf.extend(indent(["pass"]))
        return buf

    def generate_structure(self, structure: GenericStructure) -> LineBuffer:
        # Sort fields so default arguments come last
        structure.fields.sort(key=lambda a: a.default is not None)

        def _arg_docstring(arg: GenericArg) -> LineBuffer:
            if not arg.docstring:
                return []
            return linebreak_paragraph(
                f'"""{escape_backslash(arg.docstring)}"""', width=80 - 4, first_line_width=80 - 4
            )

        args = concat([[self.generate_arg_declaration(f), *_arg_docstring(f)] for f in structure.fields])

        buf = [
            f"class {structure.name}(typing.NamedTuple):",
        ]
        if structure.docstring:
            buf.extend(
                indent([
                    '"""',
                    f"{escape_backslash(structure.docstring)}",
                    '"""',
                    *args,
                ])
            )
        return buf

    def generate_module(self, module: GenericModule) -> LineBuffer:
        exports = (
            [
                "__all__ = [",
                *indent(list(map(lambda x: f"{enquote(x)},", sorted(module.exports)))),
                "]",
            ]
            if module.exports
            else []
        )

        return blank_after([
            *(['"""', *linebreak_paragraph(escape_backslash(module.docstr)), '"""'] if module.docstr else []),
            *comment([
                "This file was auto generated by Styx.",
                "Do not edit this file directly.",
            ]),
            *blank_before(module.imports),
            *blank_before(module.header),
            *[line for func in module.funcs_and_classes for line in blank_before(self.generate_model(func), 2)],
            *blank_before(module.footer),
            *blank_before(exports, 2),
        ])

    def metadata_symbol(
        self,
        interface_base_name: str,
    ) -> str:
        return self.symbol_constant_case_from(f"{interface_base_name}_METADATA")

    def generate_metadata(
        self,
        metadata_symbol: str,
        entries: dict,
    ) -> LineBuffer:
        return [
            f"{metadata_symbol} = Metadata(",
            *indent([f"{k}={self.expr_literal(v)}," for k, v in entries.items()]),
            ")",
        ]

    def return_statement(self, value: str) -> str:
        return f"return {value}"

    def cargs_symbol(self) -> str:
        return "cargs"

    def cargs_declare(self, cargs_symbol: str) -> LineBuffer:
        return [f"{cargs_symbol} = []"]

    def mstr_collapse(self, mstr: MStr, join: str = "") -> MStr:
        return MStr(f'"{join}".join({mstr.expr})' if mstr.is_list else mstr.expr, False)

    def mstr_concat(self, mstrs: list[MStr], inner_join: str = "", outer_join: str = "") -> MStr:
        inner = list(self.mstr_collapse(mstr, inner_join) for mstr in mstrs)
        return MStr(self.expr_concat_strs(list(m.expr for m in inner), outer_join), False)

    def mstr_cargs_add(self, cargs_symbol: str, mstr: MStr | list[MStr]) -> LineBuffer:
        if isinstance(mstr, list):
            elements: list[str] = [(f"*{val}" if val_is_list else val) for val, val_is_list in mstr]
            return [
                "cargs.extend([",
                *indent(expand(",\n".join(elements))),
                "])",
            ]
        if mstr.is_list:
            return [f"{cargs_symbol}.extend({mstr.expr})"]
        return [f"{cargs_symbol}.append({mstr.expr})"]

    def if_else_block(self, condition: str, truthy: LineBuffer, falsy: LineBuffer | None = None) -> LineBuffer:
        buf = [
            f"if {condition}:",
            *indent(truthy),
        ]
        if falsy:
            buf.extend([
                "else:",
                *indent(falsy),
            ])
        return buf

    def generate_ret_object_creation(
        self,
        buf: LineBuffer,
        execution_symbol: str,
        output_type: str,
        members: dict[str, str],
    ) -> LineBuffer:
        buf.append(f"ret = {output_type}(")

        # Set root output path
        buf.extend(indent([f'root={execution_symbol}.output_file("."),']))

        for member_symbol, member_expr in members.items():
            buf.extend(indent([f"{member_symbol}={member_expr},"]))

        buf.extend([")"])

        return buf

    def resolve_output_file(self, execution_symbol: str, file_expr: str) -> str:
        return f"{execution_symbol}.output_file({file_expr})"

    def param_dict_create(
        self,
        lookup: SymbolLUT,
        name: str,
        param: ir.Param[ir.Param.Struct],
        items: list[tuple[ir.Param, ExprType]] | None = None,
    ) -> LineBuffer:
        return [
            f"{name} = {{",
            *indent([f'"@type": {self.expr_str(param.body.public_name)},']),
            *indent([f"{self.expr_str(key.base.name)}: {value}," for key, value in items]),
            "}",
        ]

    def param_dict_set(self, dict_symbol: str, param: ir.Param, value_expr: str) -> LineBuffer:
        return [f"{dict_symbol}[{self.expr_str(param.base.name)}] = {value_expr}"]

    def dyn_declare(self, lut: SymbolLUT, union: ir.Param[ir.Param.StructUnion]) -> list[GenericFunc]:
        items = [(self.expr_str(s.body.public_name), lut.fn_struct_make_cmdargs[s.base.id_]) for s in union.body.alts]
        func_get_build_cargs = GenericFunc(
            name=lut.fn_dyn_union_fn_struct_make_cmdargs[union.base.id_],
            return_type="typing.Any",
            docstring_body="Get build cargs function by command type.",
            return_descr="Build cargs function.",
            args=[
                GenericArg(
                    name="t",
                    docstring="Command type",
                    type="str",
                )
            ],
            body=["return {", *indent([f"{key}: {value}," for key, value in items]), "}.get(t)"],
        )

        # Build outputs function lookup
        items = [
            (self.expr_str(s.body.public_name), lut.fn_struct_make_outputs[s.base.id_])
            for s in union.body.alts
            if s.has_outputs_deep()
        ]
        func_get_build_outputs = None
        if len(items):
            func_get_build_outputs = GenericFunc(
                name=lut.fn_dyn_union_fn_struct_make_outputs[union.base.id_],
                return_type="typing.Any",
                docstring_body="Get build outputs function by command type.",
                return_descr="Build outputs function.",
                args=[
                    GenericArg(
                        name="t",
                        docstring="Command type",
                        type="str",
                    )
                ],
                body=["return {", *indent([f"{key}: {value}," for key, value in items]), "}.get(t)"],
            )

        # Validate params function lookup
        items = [
            (self.expr_str(s.body.public_name), lut.fn_struct_validate_params[s.base.id_]) for s in union.body.alts
        ]
        func_struct_validate_params = GenericFunc(
            name=lut.fn_dyn_union_fn_struct_validate_params[union.base.id_],
            return_type="typing.Any",
            docstring_body="Get validate params function by command type.",
            return_descr="Validate params function.",
            args=[
                GenericArg(
                    name="t",
                    docstring="Command type",
                    type="str",
                )
            ],
            body=["return {", *indent([f"{key}: {value}," for key, value in items]), "}.get(t)"],
        )

        return [
            func_get_build_cargs,
            *([func_get_build_outputs] if func_get_build_outputs else []),
            func_struct_validate_params,
        ]

    def _make_typed_dict(self, symbol: ExprType, items: list[tuple[ExprType, ExprType]]) -> LineBuffer:
        if items is None or len(items) == 0:
            return [f"{symbol} = typing.TypedDict('{symbol}', {{}})"]
        else:
            return [
                f"{symbol} = typing.TypedDict('{symbol}', {{",
                *indent([f"{key}: {value}," for key, value in items]),
                "})",
            ]

    def param_dict_type_declare(self, lut: SymbolLUT, struct: ir.Param[ir.Param.Struct]) -> LineBuffer:
        def _not_required(s):
            return f"typing.NotRequired[{s}]"

        param_items: list[tuple[str, str]] = []
        for p in struct.body.iter_params_shallow():
            _type = lut.type_param[p.base.id_]
            if p.nullable:
                _type = _not_required(_type)
            param_items.append((self.expr_str(p.base.name), _type))

        dict_symbol = lut.type_struct_params[struct.base.id_]
        dict_symbol_tagged = lut.type_struct_params_tagged[struct.base.id_]

        # todo: this needs helper function
        attype_key = self.expr_str("@type")
        attype_value = self.type_literal_union([struct.body.public_name])
        buf = self._make_typed_dict(f"_{dict_symbol}NoTag", param_items)

        # if struct.is_root() or isinstance(struct.parent.body, ir.Param.StructUnion):
        # only create tagged types for structs used in unions
        # todo: maybe move logic to generic
        buf += self._make_typed_dict(dict_symbol_tagged, [(attype_key, attype_value)] + param_items)
        buf.append(f"{dict_symbol} = _{dict_symbol}NoTag | {dict_symbol_tagged}")

        return buf

    def param_dict_get(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}[{self.expr_str(param.base.name)}]"

    def param_dict_get_or_default(self, name: str, param: ir.Param, default: ExprType) -> ExprType:
        return f"{name}.get({self.expr_str(param.base.name)}, {default})"

    def param_dict_get_or_null(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}.get({self.expr_str(param.base.name)})"

    def does_validate(self) -> bool:
        return True

    def build_fn_validate_params(
        self,
        param: ir.Param[ir.Param.Struct],
        lut: SymbolLUT,
    ) -> GenericFunc | None:
        func = GenericFunc(
            name=lut.fn_struct_validate_params[param.base.id_],
            docstring_body=f"Validate parameters. Throws an error if `params` is not a valid `{lut.type_struct_params[param.base.id_]}` object.",
            return_type=None,
            args=[
                GenericArg(
                    name="params",
                    type="typing.Any",
                    default=None,
                    docstring="The parameters object to validate.",
                ),
            ],
        )

        def _check_error(statement: str, error_message: str) -> LineBuffer:
            return [
                f"if {statement}:",
                *indent([
                    f"raise StyxValidationError({self.expr_str(error_message)})",
                ]),
            ]

        def _check_error_f(statement: str, error_message: str) -> LineBuffer:
            return [
                f"if {statement}:",
                *indent([
                    f"raise StyxValidationError(f'{error_message}')",
                ]),
            ]

        params_symbol = "params"

        func.body.extend([
            f"if {params_symbol} is None or not isinstance({params_symbol}, dict):",
            *indent([
                f"raise StyxValidationError(f'Params object has the wrong type \\'{{type({params_symbol})}}\\'')",
            ]),
        ])

        def _assert_dict(symbol):
            return [
                f"if not isinstance({symbol}, dict):",
                *indent([
                    f"raise StyxValidationError(f'Params object has the wrong type \\'{{type({symbol})}}\\'')",
                ]),
            ]

        def _assert_tagged(symbol: str) -> LineBuffer:
            return [
                f'if "@type" not in {symbol}:',
                *indent([
                    f"raise StyxValidationError({self.expr_str('Params object is missing `@type`')})",
                ]),
            ]

        for p in param.body.iter_params_shallow():
            get_param_or_null = self.param_dict_get_or_default(
                params_symbol,
                p,
                self.expr_null() if p.default_value is ir.Param.SetToNone else self.expr_literal(p.default_value),
            )
            get_param_or_die = self.param_dict_get(params_symbol, p)

            expr_err_expected_type = f"`{p.base.name}` has the wrong type: Received `{{type({get_param_or_null})}}` expected `{self.type_param(p, lut.type_struct_params, lut.type_struct_params_tagged)}`"

            level = 0

            if p.nullable:
                func.body.extend(indent([f"if {get_param_or_null} is not None:"], level))
                level += 1
            else:
                func.body.extend(
                    indent(_check_error(f"{get_param_or_null} is None", f"`{p.base.name}` must not be None"), level)
                )

            def _not_is_instance(pytype: str):
                return f"not isinstance({get_param_or_die}, {pytype})"

            if p.list_:
                func.body.extend(indent(_check_error_f(_not_is_instance("list"), expr_err_expected_type), level))

                if p.list_.count_max is not None and p.list_.count_min is not None:
                    if p.list_.count_max == p.list_.count_min:
                        func.body.extend(
                            indent(
                                _check_error(
                                    f"len({get_param_or_die}) != {p.list_.count_min}",
                                    f"Parameter `{p.base.name}` must contain exactly {p.list_.count_min} element{'s' if p.list_.count_min != 1 else ''}",
                                ),
                                level,
                            )
                        )
                    else:
                        func.body.extend(
                            indent(
                                _check_error(
                                    f"not ({p.list_.count_min} <= len({get_param_or_die}) <= {p.list_.count_max})",
                                    f"Parameter `{p.base.name}` must contain between {p.list_.count_min} and {p.list_.count_max} elements (inclusive)",
                                ),
                                level,
                            )
                        )
                elif p.list_.count_max is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"len({get_param_or_die}) > {p.list_.count_max}",
                                f"Parameter `{p.base.name}` must contain at most {p.list_.count_max} element{'s' if p.list_.count_max != 1 else ''}",
                            ),
                            level,
                        )
                    )
                elif p.list_.count_min is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"len({get_param_or_die}) < {p.list_.count_min}",
                                f"Parameter `{p.base.name}` must contain at least {p.list_.count_min} element{'s' if p.list_.count_min != 1 else ''}",
                            ),
                            level,
                        )
                    )

                func.body.extend(
                    indent(
                        [
                            f"for e in {get_param_or_die}:",
                        ],
                        level,
                    )
                )

                get_param_or_null = "e"
                get_param_or_die = "e"

                level += 1

            if isinstance(p.body, ir.Param.String):
                func.body.extend(indent(_check_error_f(_not_is_instance("str"), expr_err_expected_type), level))
            elif isinstance(p.body, ir.Param.Bool):
                func.body.extend(indent(_check_error_f(_not_is_instance("bool"), expr_err_expected_type), level))
            elif isinstance(p.body, ir.Param.Int):
                func.body.extend(indent(_check_error_f(_not_is_instance("int"), expr_err_expected_type), level))

                if p.body.min_value is not None and p.body.max_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"not ({p.body.min_value} <= {get_param_or_die} <= {p.body.max_value})",
                                f"Parameter `{p.base.name}` must be between {p.body.min_value} and {p.body.max_value} (inclusive)",
                            ),
                            level,
                        )
                    )
                elif p.body.min_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"{get_param_or_die} < {p.body.min_value}",
                                f"Parameter `{p.base.name}` must be at least {p.body.min_value}",
                            ),
                            level,
                        )
                    )
                elif p.body.max_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"{get_param_or_die} > {p.body.max_value}",
                                f"Parameter `{p.base.name}` must be at most {p.body.max_value}",
                            ),
                            level,
                        )
                    )
            elif isinstance(p.body, ir.Param.Float):
                func.body.extend(
                    indent(_check_error_f(_not_is_instance("(float, int)"), expr_err_expected_type), level)
                )

                if p.body.min_value is not None and p.body.max_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"not ({p.body.min_value} <= {get_param_or_die} <= {p.body.max_value})",
                                f"Parameter `{p.base.name}` must be between {p.body.min_value} and {p.body.max_value} (inclusive)",
                            ),
                            level,
                        )
                    )
                elif p.body.min_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"{get_param_or_die} < {p.body.min_value}",
                                f"Parameter `{p.base.name}` must be at least {p.body.min_value}",
                            ),
                            level,
                        )
                    )
                elif p.body.max_value is not None:
                    func.body.extend(
                        indent(
                            _check_error(
                                f"{get_param_or_die} > {p.body.max_value}",
                                f"Parameter `{p.base.name}` must be at most {p.body.max_value}",
                            ),
                            level,
                        )
                    )
            elif isinstance(p.body, ir.Param.File):
                func.body.extend(
                    indent(_check_error_f(_not_is_instance("(pathlib.Path, str)"), expr_err_expected_type), level)
                )
            elif isinstance(p.body, ir.Param.Struct):
                fn_validate = lut.fn_struct_validate_params[p.base.id_]
                expr_validate = f"{fn_validate}({get_param_or_die})"
                func.body.extend(indent([expr_validate], level))

            elif isinstance(p.body, ir.Param.StructUnion):
                fn_validate = lut.fn_dyn_union_fn_struct_validate_params[p.base.id_]
                expr_validate = f'{fn_validate}({get_param_or_die}["@type"])({get_param_or_die})'

                valid_tags = [alt.body.public_name for alt in p.body.alts]

                func.body.extend(
                    indent(
                        [
                            *_assert_dict(get_param_or_die),
                            *_assert_tagged(get_param_or_die),
                            *_check_error(
                                f'{get_param_or_die}["@type"] not in {self.expr_literal(valid_tags)}',
                                f"Parameter `{p.base.name}`s `@type` must be one of {self.expr_literal(valid_tags)}",
                            ),
                            expr_validate,
                        ],
                        level,
                    )
                )

            else:
                assert False

            if p.choices:
                func.body.extend(
                    indent(
                        _check_error(
                            f"{get_param_or_die} not in {self.expr_literal(p.choices)}",
                            f"Parameter `{p.base.name}` must be one of {self.expr_literal(p.choices)}",
                        ),
                        level,
                    )
                )

        return func


class PythonLanguageCompileProvider(Compilable):
    def compile(
        self,
        project: ir.Project,
        packages: typing.Iterable[
            tuple[
                ir.Package,
                typing.Iterable[ir.App],
            ]
        ],
    ) -> typing.Generator[TextFile, typing.Any, None]:
        _T = typing.TypeVar("_T")

        def _get_checked(store: dict[str, typing.Any], key: str, type_: type[_T]) -> _T | None:
            val = store.get(key)
            if val is None:
                return None
            if isinstance(val, type_):
                return val
            return None

        # main loop

        global_scope = self.language_scope()

        package_names: list[str] = []
        for package, interfaces in packages:
            package_names.append(package.name)

            python_package_name = f"{project.name}_{package.name}"
            python_package_path = pathlib.Path(python_package_name)
            python_package_path_src = python_package_path / "src"

            yield TextFile(
                path=python_package_path / "pyproject.toml",
                content=template_sub_pyproject(
                    project=project,
                    package=package,
                ),
            )

            yield TextFile(
                path=python_package_path / "README.md",
                content=template_sub_readme(project, package),
            )

            package_symbol: str = global_scope.add_or_dodge(self.symbol_var_case_from(package.name))
            package_scope: Scope = Scope(parent=global_scope)
            package_module: GenericModule = GenericModule(
                docstr=docs_to_docstring(package.docs),
            )
            package_luts: dict[str, SymbolLUT] = {}

            for interface in interfaces:
                interface_module_symbol = self.symbol_var_case_from(interface.command.base.name)

                interface_module: GenericModule = GenericModule()
                lut = compile_app(
                    lang=self,
                    package=package,
                    app=interface,
                    package_scope=package_scope,
                    module_app=interface_module,
                )
                yield TextFile.json(
                    path=pathlib.Path(f"symbolmaps") / package.name / f"{lut.fn_root_make_params_and_execute}.json",
                    content=lut.symbol_map(),
                )

                package_luts[interface.command.body.public_name] = lut
                package_module.imports.append(f"from .{interface_module_symbol} import *")
                yield TextFile(
                    path=python_package_path_src
                    / f"{project.name}_{package.name}"
                    / package_symbol
                    / (interface_module_symbol + ".py"),
                    content=collapse(self.generate_module(interface_module)),
                )

            yield TextFile.json(
                path=pathlib.Path(f"symbolmaps") / f"{package.name}.json",
                content={
                    global_name: f"{package.name}/{lut.fn_root_make_params_and_execute}.json"
                    for global_name, lut in package_luts.items()
                },
            )

            dyn_execute_dict = {
                self.expr_str(global_name): entrypoint.fn_root_execute
                for global_name, entrypoint in package_luts.items()
            }
            fn_pkg_dyn_execute = GenericFunc(
                name=f"execute",
                docstring_body="Run a command in this package dynamically from a params object.",
                args=[
                    GenericArg(name="params", type="dict", docstring="The parameters."),
                    GenericArg(name="runner", type="_Runner | None", default="None", docstring="Command runner"),
                ],
                body=[
                    "return {",
                    *indent([f"{k}: {v}," for k, v in dyn_execute_dict.items()]),
                    '}[params["@type"]](params, runner)',
                ],
            )
            package_module.funcs_and_classes.append(fn_pkg_dyn_execute)

            package_module.imports.append("from styxdefs import Runner as _Runner")

            package_module.imports.sort()
            yield TextFile(
                path=python_package_path_src / f"{project.name}_{package.name}" / package_symbol / "__init__.py",
                content=collapse(self.generate_module(package_module)),
            )
            yield TextFile(
                path=python_package_path_src / f"{project.name}_{package.name}" / "__init__.py",
                content="",
            )
            yield TextFile(
                path=python_package_path_src / f"{project.name}_{package.name}" / "py.typed",
                content="",
            )

        yield TextFile(
            path=pathlib.Path(project.name) / f"src/{project.name}/__init__.py",
            content=template_root_init_py(project, package_names),
        )
        yield TextFile(
            path=pathlib.Path(project.name) / f"src/{project.name}/py.typed",
            content="",
        )

        yield TextFile(
            path=pathlib.Path(project.name) / f"pyproject.toml",
            content=template_root_pyproject(project, package_names),
        )

        yield TextFile(
            path=pathlib.Path("requirements.txt"),
            content="\n".join(
                [f"./{project.name}_{package_name}" for package_name in package_names] + ["./" + project.name]
            ),
        )

        if python_dist_repo_url := _get_checked(project.extras, "dist_repo_url", str):
            # normalize URL for pip
            if not python_dist_repo_url.startswith("git+"):
                python_dist_repo_url = f"git+{python_dist_repo_url}"
            if not python_dist_repo_url.endswith(".git"):
                python_dist_repo_url += ".git"

            yield TextFile(
                path=pathlib.Path("requirements_remote.txt"),
                content="\n".join(
                    [
                        f"{python_dist_repo_url}#subdirectory={project.name}_{package_name}"
                        for package_name in package_names
                    ]
                    + [f"{python_dist_repo_url}#subdirectory={project.name}"]
                ),
            )

        # todo: add generic readme if not set
        if python_readme := _get_checked(project.extras, "readme_md", str):
            yield TextFile(
                path=pathlib.Path(project.name) / pathlib.Path("README.md"),
                content=python_readme,
            )
            yield TextFile(
                path=pathlib.Path("README.md"),
                content=python_readme,
            )

        yield TextFile.json(
            path=pathlib.Path(f"symbolmaps") / f"index.json",
            content={package_name: f"{package_name}.json" for package_name in package_names},
        )


class PythonLanguageProvider(
    PythonLanguageTypeProvider,
    PythonLanguageIrProvider,
    PythonLanguageExprProvider,
    PythonLanguageSymbolProvider,
    PythonLanguageHighLevelProvider,
    PythonLanguageCompileProvider,
    LanguageProvider,
):
    pass
