import pathlib
import re
import typing

from styx.backend.generic.documentation import docs_to_docstring
from styx.backend.generic.gen.interface import compile_interface
from styx.backend.generic.gen.lookup import LookupParam
from styx.backend.generic.languageprovider import (
    TYPE_PYLITERAL,
    CompiledFile,
    ExprType,
    LanguageCompileProvider,
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
    struct_has_outputs,
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
        self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct], execution_symbol: ExprType
    ) -> LineBuffer:
        args = [lookup.expr_param_symbol_alias[elem.base.id_] for elem in struct.body.iter_params()]
        return [
            f"params = {lookup.expr_func_build_params[struct.base.id_]}(",
            *indent([f"{a}={a}," for a in args]),
            ")",
            self.return_statement(f"{lookup.expr_func_execute[struct.base.id_]}(params, {execution_symbol})"),
        ]

    def call_build_cargs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        return [
            f"{return_symbol} = {lookup.expr_func_build_cargs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def call_build_outputs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        return [
            f"{return_symbol} = {lookup.expr_func_build_outputs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def param_var_to_mstr(self, param: ir.Param, symbol: str) -> MStr:
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
                                f"({self.expr_literal(value_true)} if {symbol} else {self.expr_literal(value_true)})",
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
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(f'dyn_cargs({symbol}["@type"])({symbol}, execution)', True)
                assert False

            if param.list_.join is None:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, True)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"map(str, {symbol})", True)
                if isinstance(param.body, ir.Param.Bool):
                    assert False, "TODO: Not implemented yet"
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", resolve_parent=True"
                    if param.body.mutable:
                        extra_args += ", mutable=True"
                    return MStr(f"[execution.input_file(f{extra_args}) for f in {symbol}]", True)
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(
                        f'[a for c in [dyn_cargs(s["@type"])(s, execution) for s in {symbol}] for a in c]', True
                    )
                assert False

            # arg.data.list_separator is not None
            sep_join = f"{enquote(param.list_.join)}.join"
            if isinstance(param.body, ir.Param.String):
                return MStr(f"{sep_join}({symbol})", False)
            if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                return MStr(f"{sep_join}(map(str, {symbol}))", False)
            if isinstance(param.body, ir.Param.Bool):
                assert False, "TODO: Not implemented yet"
            if isinstance(param.body, ir.Param.File):
                extra_args = ""
                if param.body.resolve_parent:
                    extra_args += ", resolve_parent=True"
                if param.body.mutable:
                    extra_args += ", mutable=True"
                return MStr(f"{sep_join}([execution.input_file(f{extra_args}) for f in {symbol}])", False)
            if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                return MStr(
                    f'{sep_join}([a for c in [dyn_cargs(s["@type"])(s, execution) for s in {symbol}] for a in c])',
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


class PythonLanguageExprProvider(LanguageExprProvider):
    def expr_line_comment(self, comment_: LineBuffer) -> LineBuffer:
        return comment(comment_, "#")

    def expr_bool(self, obj: bool) -> ExprType:
        """Convert a bool to a language literal."""
        return "True" if obj else "False"

    def expr_int(self, obj: int) -> ExprType:
        """Convert a bool to a language literal."""
        return str(obj)

    def expr_float(self, obj: float) -> ExprType:
        """Convert a bool to a language literal."""
        return str(obj)

    def expr_str(self, obj: str) -> ExprType:
        """Convert a bool to a language literal."""
        return enquote(obj)  # todo string escape?

    def expr_path(self, obj: pathlib.Path) -> ExprType:
        """Convert a bool to a language literal."""
        return enquote(str(obj))  # todo string escape?

    def expr_list(self, obj: list[ExprType]) -> ExprType:
        """Convert a bool to a language literal."""
        return enbrace(", ".join(obj), "[")

    def expr_dict(self, obj: dict[ExprType, ExprType]) -> ExprType:
        """Convert a bool to a language literal."""
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

    def struct_collect_outputs(self, struct: ir.Param[ir.Param.Struct], struct_symbol: str) -> str:
        if struct.list_:
            opt = ""
            if struct.nullable:
                opt = f" if {struct_symbol} else None"
            return (
                f'[dyn_outputs(i["@type"])(i, execution) '
                f'if dyn_outputs(i["@type"]) else None for i in {struct_symbol}]{opt}'
            )

        o = f'dyn_outputs({struct_symbol}["@type"])({struct_symbol}, execution)'
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
        lookup: LookupParam,
        name: str,
        param: ir.Param[ir.Param.Struct],
        items: list[tuple[ir.Param, ExprType]] | None = None,
    ) -> LineBuffer:
        return [
            f"{name} = {{",
            *indent([f'"@type": {self.expr_str(lookup.expr_struct_global_name[param.base.id_])},']),
            *indent([f"{self.expr_str(key.base.name)}: {value}," for key, value in items]),
            "}",
        ]

    def param_dict_set(self, dict_symbol: str, param: ir.Param, value_expr: str) -> LineBuffer:
        return [f"{dict_symbol}[{self.expr_str(param.base.name)}] = {value_expr}"]

    def dyn_declare(self, lookup: LookupParam, root_struct: ir.Param[ir.Param.Struct]) -> list[GenericFunc]:
        items = [
            (self.expr_str(lookup.expr_struct_global_name[s.base.id_]), lookup.expr_func_build_cargs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
        ]
        func_get_build_cargs = GenericFunc(
            name="dyn_cargs",
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
            (self.expr_str(lookup.expr_struct_global_name[s.base.id_]), lookup.expr_func_build_outputs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
            if struct_has_outputs(s)
        ]
        func_get_build_outputs = GenericFunc(
            name="dyn_outputs",
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

        return [
            func_get_build_cargs,
            func_get_build_outputs,
        ]

    def param_dict_type_declare(self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct]) -> LineBuffer:
        param_items: list[tuple[str, str]] = [
            (self.expr_str("@type"), self.type_literal_union([lookup.expr_struct_global_name[struct.base.id_]]))
        ]
        for p in struct.body.iter_params():
            _type = lookup.expr_param_type[p.base.id_]
            if p.nullable:
                _type = f"typing.NotRequired[{_type}]"
            param_items.append((self.expr_str(p.base.name), _type))

        dict_symbol = lookup.expr_params_dict_type[struct.base.id_]

        if param_items is None or len(param_items) == 0:
            return [f"{dict_symbol} = typing.TypedDict('{dict_symbol}', {{}})"]
        return [
            f"{dict_symbol} = typing.TypedDict('{dict_symbol}', {{",
            *indent([f"{key}: {value}," for key, value in param_items]),
            "})",
        ]

    def param_dict_get(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}[{self.expr_str(param.base.name)}]"

    def param_dict_get_or_null(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}.get({self.expr_str(param.base.name)})"


class _PackageData(typing.NamedTuple):
    package: ir.Package
    package_symbol: str
    scope: Scope
    module: GenericModule


class PythonLanguageCompileProvider(LanguageCompileProvider):
    def compile(self, interfaces: typing.Iterable[ir.Interface]) -> typing.Generator[CompiledFile, typing.Any, None]:
        packages: dict[str, _PackageData] = {}
        global_scope = self.language_scope()

        for interface in interfaces:
            if interface.package.name not in packages:
                packages[interface.package.name] = _PackageData(
                    package=interface.package,
                    package_symbol=global_scope.add_or_dodge(self.symbol_var_case_from(interface.package.name)),
                    scope=Scope(parent=global_scope),
                    module=GenericModule(
                        docstr=docs_to_docstring(interface.package.docs),
                    ),
                )
            package_data = packages[interface.package.name]

            # interface_module_symbol = global_scope.add_or_dodge(python_snakify(interface.command.param.name))
            interface_module_symbol = self.symbol_var_case_from(interface.command.base.name)

            interface_module: GenericModule = GenericModule()
            compile_interface(
                lang=self, interface=interface, package_scope=package_data.scope, interface_module=interface_module
            )
            package_data.module.imports.append(f"from .{interface_module_symbol} import *")
            yield CompiledFile(
                path=pathlib.Path(package_data.package_symbol) / (interface_module_symbol + ".py"),
                content=collapse(self.generate_module(interface_module)),
            )

        for package_data in packages.values():
            package_data.module.imports.sort()
            yield CompiledFile(
                path=pathlib.Path(package_data.package_symbol) / "__init__.py",
                content=collapse(self.generate_module(package_data.module)),
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
