import pathlib
import re
import typing

from styx.backend import CompiledFile
from styx.backend.generic.documentation import docs_to_docstring
from styx.backend.generic.gen.interface import compile_interface
from styx.backend.generic.gen.lookup import LookupParam
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
    LanguageCompileProvider,
)
from styx.backend.generic.linebuffer import LineBuffer, blank_after, blank_before, comment, expand, indent, collapse
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure
from styx.backend.generic.scope import Scope
from styx.backend.generic.string_case import pascal_case, screaming_snake_case, snake_case
from styx.backend.generic.utils import (
    enbrace,
    enquote,
    struct_has_outputs,
)
from styx.ir import core as ir


class TypeScriptLanguageTypeProvider(LanguageTypeProvider):
    def type_str(self) -> str:
        """String type."""
        return "string"

    def type_int(self) -> str:
        """Integer type."""
        return "number"

    def type_float(self) -> str:
        """Float type."""
        return "number"

    def type_bool(self) -> str:
        """Bool type."""
        return "boolean"

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
        return f"{' | '.join(map(self.expr_literal, obj))}"

    def type_list(self, type_element: str) -> str:
        """Convert a type symbol to a type of list of that type."""
        return f"Array<{type_element}>"

    def type_optional(self, type_element: str) -> str:
        """Convert a type symbol to an optional of that type."""
        return f"{type_element} | null"

    def type_union(self, type_elements: list[str]) -> str:
        """Convert a collection of type symbol to a union type of them."""
        return f"{' | '.join(type_elements)}"

    def type_string_list(self) -> str:
        return "string[]"


class TypeScriptLanguageSymbolProvider(LanguageSymbolProvider):
    def symbol_legal(self, name: str) -> bool:
        return bool(re.match(r"^[a-zA-Z_$][a-zA-Z0-9_$]*$", name))

    def language_scope(self) -> Scope:
        scope = Scope(self)

        # TypeScript reserved keywords
        keywords = {
            "break",
            "case",
            "catch",
            "class",
            "const",
            "continue",
            "debugger",
            "default",
            "delete",
            "do",
            "else",
            "enum",
            "export",
            "extends",
            "false",
            "finally",
            "for",
            "function",
            "if",
            "import",
            "in",
            "instanceof",
            "new",
            "null",
            "return",
            "super",
            "switch",
            "this",
            "throw",
            "true",
            "try",
            "typeof",
            "var",
            "void",
            "while",
            "with",
            "implements",
            "interface",
            "let",
            "package",
            "private",
            "protected",
            "public",
            "static",
            "yield",
            "any",
            "boolean",
            "constructor",
            "declare",
            "get",
            "module",
            "require",
            "number",
            "set",
            "string",
            "symbol",
            "type",
            "from",
            "of",
            "arguments",  # Declarations with the name "arguments" cannot be used with the "esm" output format due to strict mode
        }

        for keyword in keywords:
            scope.add_or_die(keyword)

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


class TypeScriptLanguageIrProvider(LanguageIrProvider):
    def build_params_and_execute(
        self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct], execution_symbol: ExprType
    ) -> LineBuffer:
        param_list = list(struct.body.iter_params())
        param_list.sort(key=lambda a: a.default_value is not None)
        args = [lookup.expr_param_symbol_alias[elem.base.id_] for elem in param_list]
        return [
            f"const params = {lookup.expr_func_build_params[struct.base.id_]}({', '.join([a for a in args])})",
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
            f"const {return_symbol} = {lookup.expr_func_build_cargs[struct.base.id_]}({params_symbol}, {execution_symbol})"
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
            f"const {return_symbol} = {lookup.expr_func_build_outputs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def param_var_to_mstr(self, param: ir.Param, symbol: str) -> MStr:
        def _val() -> MStr:
            if not param.list_:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, False)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"String({symbol})", False)
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
                                f"({self.expr_literal(value_true)} ? {symbol} : {self.expr_literal(value_false)})",
                                as_list,
                            )
                        return MStr(self.expr_literal(value_true), as_list)
                    assert len(param.body.value_false) > 0
                    return MStr(self.expr_literal(value_false), as_list)
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", { resolveParent: true }"
                    if param.body.mutable:
                        extra_args += ", { mutable: true }"
                    return MStr(f"execution.inputFile({symbol}{extra_args})", False)
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(f"dynCargs({symbol}.__STYXTYPE__)({symbol}, execution)", True)
                assert False

            if param.list_.join is None:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, True)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"{symbol}.map(String)", True)
                if isinstance(param.body, ir.Param.Bool):
                    assert False, "TODO: Not implemented yet"
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", { resolveParent: true }"
                    if param.body.mutable:
                        extra_args += ", { mutable: true }"
                    return MStr(f"{symbol}.map(f => execution.inputFile(f{extra_args}))", True)
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(f"{symbol}.map(s => dynCargs(s.__STYXTYPE__)(s, execution)).flat()", True)
                assert False

            # param.list_.join is not None
            sep_join = f"{enquote(param.list_.join)}"
            if isinstance(param.body, ir.Param.String):
                return MStr(f"{symbol}.join({sep_join})", False)
            if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                return MStr(f"{symbol}.map(String).join({sep_join})", False)
            if isinstance(param.body, ir.Param.Bool):
                assert False, "TODO: Not implemented yet"
            if isinstance(param.body, ir.Param.File):
                extra_args = ""
                if param.body.resolve_parent:
                    extra_args += ", { resolveParent: true }"
                if param.body.mutable:
                    extra_args += ", { mutable: true }"
                return MStr(f"{symbol}.map(f => execution.inputFile(f{extra_args})).join({sep_join})", False)
            if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                return MStr(
                    f"{symbol}.map(s => dynCargs(s.__STYXTYPE__)(s, execution)).flat().join({sep_join})",
                    False,
                )
            assert False

        return _val()

    def param_var_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        if param.nullable:
            if enbrace_statement:
                return f"({symbol} !== null)"
            return f"{symbol} !== null"

        if isinstance(param.body, ir.Param.Bool):
            if len(param.body.value_true) > 0 and len(param.body.value_false) == 0:
                return symbol
            if len(param.body.value_false) > 0 and len(param.body.value_true) == 0:
                if enbrace_statement:
                    return f"(!{symbol})"
                return f"!{symbol}"
        return None

    def param_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        if param.nullable:
            if enbrace_statement:
                return f"({symbol} !== null)"
            return f"{symbol} !== null"

        if isinstance(param.body, ir.Param.Bool):
            if len(param.body.value_true) > 0 and len(param.body.value_false) == 0:
                return symbol
            if len(param.body.value_false) > 0 and len(param.body.value_true) == 0:
                if enbrace_statement:
                    return f"(!{symbol})"
                return f"!{symbol}"
        return None


class TypeScriptLanguageExprProvider(LanguageExprProvider):
    def expr_line_comment(self, comment_: LineBuffer) -> LineBuffer:
        return comment(comment_, "//")

    def expr_bool(self, obj: bool) -> ExprType:
        """Convert a bool to a language literal."""
        return "true" if obj else "false"

    def expr_int(self, obj: int) -> ExprType:
        """Convert an int to a language literal."""
        return str(obj)

    def expr_float(self, obj: float) -> ExprType:
        """Convert a float to a language literal."""
        return str(obj)

    def expr_str(self, obj: str) -> ExprType:
        """Convert a string to a language literal."""
        return enquote(obj)

    def expr_path(self, obj: pathlib.Path) -> ExprType:
        """Convert a path to a language literal."""
        return enquote(str(obj))

    def expr_list(self, obj: list[ExprType]) -> ExprType:
        """Convert a list to a language literal."""
        return enbrace(", ".join(obj), "[")

    def expr_dict(self, obj: dict[ExprType, ExprType]) -> ExprType:
        """Convert a dict to a language literal."""
        return enbrace(", ".join([f"{k}: {v}" for k, v in obj.items()]), "{")

    def expr_numeric_to_str(self, numeric_expr: str) -> str:
        return f"String({numeric_expr})"

    def expr_null(self) -> str:
        return "null"

    def expr_remove_suffixes(self, str_expr: str, suffixes: list[str]) -> str:
        conditions = [f".endsWith({self.expr_literal(suffix)})" for suffix in suffixes]
        removals = [f".slice(0, -{len(suffix)})" for suffix in suffixes]
        result = str_expr
        for condition, removal in zip(conditions, removals):
            result = f"({result}{condition} ? {result}{removal} : {result})"
        return result

    def expr_path_get_filename(self, path_expr: str) -> str:
        return f"path.basename({path_expr})"

    def expr_conditions_join_and(self, condition_exprs: list[str]) -> str:
        return " && ".join(condition_exprs)

    def expr_conditions_join_or(self, condition_exprs: list[str]) -> str:
        return " || ".join(condition_exprs)

    def expr_concat_strs(self, exprs: list[str], join: str = "") -> str:
        if join:
            return f"[{', '.join(exprs)}].join({self.expr_str(join)})"
        return f"[{', '.join(exprs)}].join('')"

    def expr_ternary(self, condition: str, truthy: str, falsy: str, enbrace_: bool = False) -> str:
        if " " in condition:
            condition = enbrace(condition, "(")
        ret = f"{condition} ? {truthy} : {falsy}"
        if enbrace_:
            return enbrace(ret, "(")
        return ret


class TypeScriptLanguageHighLevelProvider(LanguageHighLevelProvider):
    def wrapper_module_imports(self) -> LineBuffer:
        return [
            "import { Runner, Execution, Metadata, InputPathType, OutputPathType, getGlobalRunner } from 'styxdefs';",
        ]

    def struct_collect_outputs(self, struct: ir.Param[ir.Param.Struct], struct_symbol: str) -> str:
        if struct.list_:
            o = f"{struct_symbol}.map(i => dynOutputs(i.__STYXTYPE__)?.(i, execution) ?? null)"
            if struct.nullable:
                o = f"({o} ?? null)"
            return o

        o = f"dynOutputs({struct_symbol}.__STYXTYPE__)?.({struct_symbol}, execution)"
        if struct.nullable:
            o = f"({o} ?? null)"
        return o

    def runner_symbol(self) -> str:
        return "runner"

    def runner_declare(self, runner_symbol: str) -> LineBuffer:
        return [f"{runner_symbol} = {runner_symbol} || getGlobalRunner();"]

    def symbol_execution(self) -> str:
        return "execution"

    def execution_declare(self, execution_symbol: str, metadata_symbol: str) -> LineBuffer:
        return [f"const {execution_symbol} = runner.startExecution({metadata_symbol});"]

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
        so = ", undefined" if stdout_output_symbol is None else f", s => ret.{stdout_output_symbol}.push(s)"
        se = "" if stderr_output_symbol is None else f", s => ret.{stderr_output_symbol}.push(s)"
        return [f"{execution_symbol}.run({cargs_symbol}{so}{se});"]

    def generate_arg_declaration(self, arg: GenericArg) -> str:
        type_annotation = f": {arg.type}" if arg.type is not None else ""
        if arg.default is None:
            return f"{arg.name}{type_annotation}"
        return f"{arg.name}{type_annotation} = {arg.default}"

    def generate_func(self, func: GenericFunc) -> LineBuffer:
        buf = []

        # Sort arguments so default arguments come last
        func.args.sort(key=lambda a: a.default is not None)

        # Function signature with return type
        return_type = f": {func.return_type}" if func.return_type else ""
        buf.append(f"function {func.name}(")

        # Add arguments
        for arg in func.args:
            buf.extend(indent([f"{self.generate_arg_declaration(arg)},"]))
        buf.append(f"){return_type} {{")

        # Add JSDoc comment
        if func.docstring_body or func.args or func.return_descr:
            buf.extend(
                indent([
                    "/**",
                    *([f" * {line}" for line in func.docstring_body.split("\n")] if func.docstring_body else []),
                    *([""] if func.docstring_body and (func.args or func.return_descr) else []),
                    *([
                        f" * @param {arg.name} {arg.docstring}"
                        for arg in func.args
                        if arg.name != "self" and arg.docstring
                    ]),
                    *([""] if func.args and func.return_descr else []),
                    f" * @returns {func.return_descr}" if func.return_descr else "",
                    " */",
                ])
            )

        # Add function body
        if func.body:
            buf.extend(indent(func.body))
        else:
            buf.extend(indent(["return;"]))
        buf.append("}")
        return buf

    def generate_structure(self, structure: GenericStructure) -> LineBuffer:
        # Sort fields so default arguments come last
        structure.fields.sort(key=lambda a: a.default is not None)

        buf = ["/**"]
        if structure.docstring:
            buf.extend([f" * {line}" for line in structure.docstring.split("\n")])
            buf.append(" *")

        buf.extend([
            " * @interface",
            " */",
            f"interface {structure.name} {{",
        ])

        for field in structure.fields:
            if field.docstring:
                buf.extend(
                    indent([
                        "/**",
                        f" * {field.docstring}",
                        " */",
                    ])
                )
            buf.extend(indent([f"{field.name}{'' if field.default is None else '?'}: {field.type};"]))

        buf.append("}")
        return buf

    def generate_module(self, module: GenericModule) -> LineBuffer:
        exports = (
            [
                "export {",
                *indent([f"  {name}," for name in sorted(module.exports)]),
                "};",
            ]
            if module.exports
            else []
        )

        return blank_after([
            *(["/**", *[f" * {line}" for line in module.docstr.split("\n")], " */"] if module.docstr else []),
            *self.expr_line_comment([
                "This file was auto generated by Styx.",
                "Do not edit this file directly.",
            ]),
            *blank_before(module.imports),
            *blank_before(module.header),
            *[line for func in module.funcs_and_classes for line in blank_before(self.generate_model(func), 2)],
            *blank_before(module.footer),
            *blank_before(exports, 2),
        ])

    def metadata_symbol(self, interface_base_name: str) -> str:
        return self.symbol_constant_case_from(f"{interface_base_name}_METADATA")

    def generate_metadata(self, metadata_symbol: str, entries: dict) -> LineBuffer:
        return [
            f"const {metadata_symbol}: Metadata = {{",
            *indent([f"{k}: {self.expr_literal(v)}," for k, v in entries.items()]),
            "};",
        ]

    def return_statement(self, value: str) -> str:
        return f"return {value};"

    def cargs_symbol(self) -> str:
        return "cargs"

    def cargs_declare(self, cargs_symbol: str) -> LineBuffer:
        return [f"const {cargs_symbol}: string[] = [];"]

    def mstr_collapse(self, mstr: MStr, join: str = "") -> MStr:
        return MStr(f"{mstr.expr}.join({self.expr_str(join)})" if mstr.is_list else mstr.expr, False)

    def mstr_concat(self, mstrs: list[MStr], inner_join: str = "", outer_join: str = "") -> MStr:
        inner = list(self.mstr_collapse(mstr, inner_join) for mstr in mstrs)
        return MStr(self.expr_concat_strs(list(m.expr for m in inner), outer_join), False)

    def mstr_cargs_add(self, cargs_symbol: str, mstr: MStr | list[MStr]) -> LineBuffer:
        if isinstance(mstr, list):
            elements: list[str] = [(f"...{val}" if val_is_list else val) for val, val_is_list in mstr]
            return [f"{cargs_symbol}.push(", *indent(expand(",\n".join(elements))), ");"]
        if mstr.is_list:
            return [f"{cargs_symbol}.push(...{mstr.expr});"]
        return [f"{cargs_symbol}.push({mstr.expr});"]

    def if_else_block(self, condition: str, truthy: LineBuffer, falsy: LineBuffer | None = None) -> LineBuffer:
        buf = [f"if ({condition}) {{", *indent(truthy), "}"]
        if falsy:
            buf.extend(["else {", *indent(falsy), "}"])
        return buf

    def generate_ret_object_creation(
        self,
        buf: LineBuffer,
        execution_symbol: str,
        output_type: str,
        members: dict[str, str],
    ) -> LineBuffer:
        buf.append(f"const ret: {output_type} = {{")

        # Set root output path
        buf.extend(indent([f'root: {execution_symbol}.outputFile("."),']))

        for member_symbol, member_expr in members.items():
            buf.extend(indent([f"{member_symbol}: {member_expr},"]))

        buf.extend(["};"])
        return buf

    def resolve_output_file(self, execution_symbol: str, file_expr: str) -> str:
        return f"{execution_symbol}.outputFile({file_expr})"

    def param_dict_create(
        self, name: str, param: ir.Param, items: list[tuple[ir.Param, ExprType]] | None = None
    ) -> LineBuffer:
        return [
            f"const {name} = {{",
            *indent(
                [f'"__STYXTYPE__": {self.expr_str(param.body.name)} as const,']
                + [f"{self.expr_str(key.base.name)}: {value}," for key, value in (items or [])]
            ),
            "};",
        ]

    def param_dict_set(self, dict_symbol: str, param: ir.Param, value_expr: str) -> LineBuffer:
        return [f"{dict_symbol}[{self.expr_str(param.base.name)}] = {value_expr};"]

    def dyn_declare(self, lookup: LookupParam, root_struct: ir.Param[ir.Param.Struct]) -> list[GenericFunc]:
        cargs_items = [
            (self.expr_str(s.body.name), lookup.expr_func_build_cargs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
        ]

        func_get_build_cargs = GenericFunc(
            name="dynCargs",
            return_type="Function | undefined",
            docstring_body="Get build cargs function by command type.",
            return_descr="Build cargs function.",
            args=[
                GenericArg(
                    name="t",
                    docstring="Command type",
                    type="string",
                )
            ],
            body=[
                "const cargsFuncs = {",
                *indent([f"{key}: {value}," for key, value in cargs_items]),
                "};",
                "return cargsFuncs[t];",
            ],
        )

        outputs_items = [
            (self.expr_str(s.body.name), lookup.expr_func_build_outputs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
            if struct_has_outputs(s)
        ]

        func_get_build_outputs = GenericFunc(
            name="dynOutputs",
            return_type="Function | undefined",
            docstring_body="Get build outputs function by command type.",
            return_descr="Build outputs function.",
            args=[
                GenericArg(
                    name="t",
                    docstring="Command type",
                    type="string",
                )
            ],
            body=[
                "const outputsFuncs = {",
                *indent([f"{key}: {value}," for key, value in outputs_items]),
                "};",
                "return outputsFuncs[t];",
            ],
        )

        return [func_get_build_cargs, func_get_build_outputs]

    def param_dict_type_declare(self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct]) -> LineBuffer:
        param_items: list[tuple[str, str]] = [('"__STYXTYPE__"', self.type_literal_union([struct.body.name]))]

        for p in struct.body.iter_params():
            _type = lookup.expr_param_type[p.base.id_]
            if p.nullable:
                _type = f"{_type} | undefined"
            param_items.append((self.expr_str(p.base.name) + ("?" if p.nullable else ""), _type))

        dict_symbol = lookup.expr_params_dict_type[struct.base.id_]

        return [
            f"interface {dict_symbol} {{",
            *indent([f"{key}: {value};" for key, value in param_items]),
            "}",
        ]

    def param_dict_get(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}[{self.expr_str(param.base.name)}]"

    def param_dict_get_or_null(self, name: str, param: ir.Param) -> ExprType:
        return f"({name}[{self.expr_str(param.base.name)}] ?? null)"


class _PackageData(typing.NamedTuple):
    package: ir.Package
    package_symbol: str
    scope: Scope
    module: GenericModule


class TypeScriptLanguageCompileProvider(LanguageCompileProvider):
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
            package_data.module.imports.append(
                f"export * from './{package_data.package_symbol}/{interface_module_symbol}'"
            )
            yield CompiledFile(
                path=pathlib.Path(package_data.package_symbol) / (interface_module_symbol + ".ts"),
                content=collapse(self.generate_module(interface_module)),
            )

        for package_data in packages.values():
            package_data.module.imports.sort()
            yield CompiledFile(
                path=pathlib.Path(f"{package_data.package_symbol}.ts"),
                content=collapse(self.generate_module(package_data.module)),
            )


class TypeScriptLanguageProvider(
    TypeScriptLanguageTypeProvider,
    TypeScriptLanguageIrProvider,
    TypeScriptLanguageExprProvider,
    TypeScriptLanguageSymbolProvider,
    TypeScriptLanguageHighLevelProvider,
    TypeScriptLanguageCompileProvider,
    LanguageProvider,
):
    pass
