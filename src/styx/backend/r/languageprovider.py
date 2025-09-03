import pathlib
import re
import typing

from styx.backend.common import TextFile
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
)
from styx.backend.generic.linebuffer import LineBuffer, blank_after, blank_before, collapse, comment, expand, indent
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure
from styx.backend.generic.scope import Scope
from styx.backend.generic.string_case import pascal_case, screaming_snake_case
from styx.backend.generic.utils import (
    enbrace,
    enquote,
    escape_backslash,
    linebreak_paragraph,
    struct_has_outputs,
)
from styx.ir import core as ir


class RLanguageTypeProvider(LanguageTypeProvider):
    def type_str(self) -> str:
        """String type."""
        return "character"

    def type_int(self) -> str:
        """Integer type."""
        return "integer"

    def type_float(self) -> str:
        """Float type."""
        return "numeric"

    def type_bool(self) -> str:
        """Bool type."""
        return "logical"

    def type_input_path(self) -> str:
        """Input path type."""
        return "character"

    def type_output_path(self) -> str:
        """Type of output path."""
        return "character"

    def type_runner(self) -> str:
        """Type of Runner."""
        return "Runner"

    def type_execution(self) -> str:
        """Type of Execution."""
        return "Execution"

    def type_literal_union(self, obj: list[TYPE_PYLITERAL]) -> str:
        """Convert an object to a language literal union type.
        Note: R doesn't have native union types, so we'll handle this differently.
        """
        return f"Union[{', '.join(map(self.expr_literal, obj))}]"

    def type_list(self, type_element: str) -> str:
        """Convert a type symbol to a type of list of that type.
        In R, vectors/lists are homogeneous by default.
        """
        return f"vector[{type_element}]"

    def type_optional(self, type_element: str) -> str:
        """Convert a type symbol to an optional of that type.
        In R, NULL is used for optional values.
        """
        return f"nullable[{type_element}]"

    def type_union(self, type_elements: list[str]) -> str:
        """Convert a collection of type symbol to a union type of them."""
        return f"Union[{', '.join(type_elements)}]"

    def type_string_list(self) -> str:
        """R's character vector type."""
        return "character"


class RLanguageSymbolProvider(LanguageSymbolProvider):
    def symbol_legal(self, name: str) -> bool:
        """Check if a symbol name is legal in R.
        R allows dots in names and is more permissive than Python.
        """
        # R variable names can contain letters, numbers, dots and underscores
        # They must start with a letter or dot (if dot, the second character cannot be a number)
        if not name:
            return False
        if name[0].isdigit():
            return False
        if name[0] == "." and len(name) > 1 and name[1].isdigit():
            return False
        return all(c.isalnum() or c in "._" for c in name)

    def language_scope(self) -> Scope:
        """Create a scope with R's reserved words and base functions."""
        scope = Scope(self)

        # R reserved words
        reserved_words = {
            "if",
            "else",
            "repeat",
            "while",
            "function",
            "for",
            "in",
            "next",
            "break",
            "TRUE",
            "FALSE",
            "NULL",
            "Inf",
            "NaN",
            "NA",
            "NA_integer_",
            "NA_real_",
            "NA_complex_",
            "NA_character_",
            "...",
        }

        # Common R base functions that might conflict
        base_functions = {
            "c",
            "list",
            "data.frame",
            "matrix",
            "array",
            "factor",
            "sum",
            "mean",
            "median",
            "sd",
            "var",
            "cor",
            "cov",
            "plot",
            "print",
            "cat",
            "paste",
            "paste0",
            "sprintf",
        }

        for word in reserved_words | base_functions:
            scope.add_or_die(word)

        return scope

    def symbol_from(self, name: str) -> str:
        """Convert a name to a valid R symbol.
        R is more permissive with names than Python, but we'll still sanitize.
        """
        # Replace invalid characters with dots (R convention)
        name = re.sub(r"[^a-zA-Z0-9_.]", ".", name)

        # Ensure name starts with a letter or dot
        if re.match(r"^[0-9]", name):
            name = "X" + name

        # Ensure dot-started names don't have number as second char
        if name.startswith(".") and len(name) > 1 and name[1].isdigit():
            name = "X" + name

        return name

    def symbol_constant_case_from(self, name: str) -> str:
        """Convert a name to a constant case.
        R typically uses ALL_CAPS for constants.
        """
        return screaming_snake_case(self.symbol_from(name))

    def symbol_class_case_from(self, name: str) -> str:
        """Convert a name to a class case.
        R typically uses PascalCase for S4 classes.
        """
        return pascal_case(self.symbol_from(name))

    def symbol_var_case_from(self, name: str) -> str:
        """Convert a name to a variable case.
        R typically uses dot.case or snake_case for variables.
        """
        # Using dot.case as it's more common in R
        name = self.symbol_from(name)
        # Convert snake_case to dot.case
        name = name.replace("_", ".")
        return name.lower()


class RLanguageIrProvider(LanguageIrProvider):
    def build_params_and_execute(
        self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct], runner_symbol: ExprType
    ) -> LineBuffer:
        """Build parameters and execute in R style."""
        args = [lookup.expr_param_symbol_alias[elem.base.id_] for elem in struct.body.iter_params()]
        return [
            f"params <- {lookup.expr_func_build_params[struct.base.id_]}({', '.join([f'{a}={a}' for a in args])})",
            self.return_statement(f"{lookup.expr_func_execute[struct.base.id_]}(params, {runner_symbol})"),
        ]

    def call_build_cargs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        """Build command arguments in R style."""
        return [
            f"{return_symbol} <- {lookup.expr_func_build_cargs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def call_build_outputs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer:
        """Build outputs in R style."""
        return [
            f"{return_symbol} <- {lookup.expr_func_build_outputs[struct.base.id_]}({params_symbol}, {execution_symbol})"
        ]

    def param_var_to_mstr(self, param: ir.Param, symbol: str) -> MStr:
        """Convert parameter variables to R string representation."""

        def _val() -> MStr:
            if not param.list_:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, False)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"as.character({symbol})", False)
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
                                f"if ({symbol}) {self.expr_literal(value_true)} else {self.expr_literal(value_false)}",
                                as_list,
                            )
                        return MStr(self.expr_literal(value_true), as_list)
                    assert len(param.body.value_false) > 0
                    return MStr(self.expr_literal(value_false), as_list)
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", resolve.parent=TRUE"
                    if param.body.mutable:
                        extra_args += ", mutable=TRUE"
                    return MStr(f"execution$input.file({symbol}{extra_args})", False)
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(f'dyn.cargs({symbol}$"@type")({symbol}, execution)', True)
                assert False

            # Handle lists/vectors
            if param.list_.join is None:
                if isinstance(param.body, ir.Param.String):
                    return MStr(symbol, True)
                if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                    return MStr(f"sapply({symbol}, as.character)", True)
                if isinstance(param.body, ir.Param.Bool):
                    assert False, "TODO: Not implemented yet"
                if isinstance(param.body, ir.Param.File):
                    extra_args = ""
                    if param.body.resolve_parent:
                        extra_args += ", resolve.parent=TRUE"
                    if param.body.mutable:
                        extra_args += ", mutable=TRUE"
                    return MStr(f"sapply({symbol}, function(f) execution$input.file(f{extra_args}))", True)
                if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    return MStr(f'unlist(lapply({symbol}, function(s) dyn.cargs(s$"@type")(s, execution)))', True)
                assert False

            # Handle joined lists
            sep_join = f"paste(collapse={enquote(param.list_.join)})"
            if isinstance(param.body, ir.Param.String):
                return MStr(f"{sep_join}({symbol})", False)
            if isinstance(param.body, (ir.Param.Int, ir.Param.Float)):
                return MStr(f"{sep_join}(sapply({symbol}, as.character))", False)
            if isinstance(param.body, ir.Param.Bool):
                assert False, "TODO: Not implemented yet"
            if isinstance(param.body, ir.Param.File):
                extra_args = ""
                if param.body.resolve_parent:
                    extra_args += ", resolve.parent=TRUE"
                if param.body.mutable:
                    extra_args += ", mutable=TRUE"
                return MStr(f"{sep_join}(sapply({symbol}, function(f) execution$input.file(f{extra_args})))", False)
            if isinstance(param.body, (ir.Param.Struct, ir.Param.StructUnion)):
                return MStr(
                    f'{sep_join}(unlist(lapply({symbol}, function(s) dyn.cargs(s$"@type")(s, execution))))',
                    False,
                )
            assert False

        return _val()

    def param_var_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        """Check if parameter is set by user in R style."""
        if param.nullable:
            if enbrace_statement:
                return f"(!is.null({symbol}))"
            return f"!is.null({symbol})"

        if isinstance(param.body, ir.Param.Bool):
            if len(param.body.value_true) > 0 and len(param.body.value_false) == 0:
                return symbol
            if len(param.body.value_false) > 0 and len(param.body.value_true) == 0:
                if enbrace_statement:
                    return f"(!{symbol})"
                return f"!{symbol}"
        return None

    def param_is_set_by_user(self, param: ir.Param, symbol: str, enbrace_statement: bool = False) -> str | None:
        """Similar to param_var_is_set_by_user but for direct parameters."""
        return self.param_var_is_set_by_user(param, symbol, enbrace_statement)


class RLanguageExprProvider(LanguageExprProvider):
    def expr_line_comment(self, comment_: LineBuffer) -> LineBuffer:
        """Convert to R-style comments using #."""
        return comment(comment_, "#")

    def expr_bool(self, obj: bool) -> ExprType:
        """Convert a bool to R logical literal."""
        return "TRUE" if obj else "FALSE"

    def expr_int(self, obj: int) -> ExprType:
        """Convert an int to R numeric literal."""
        return str(obj)

    def expr_float(self, obj: float) -> ExprType:
        """Convert a float to R numeric literal."""
        return str(obj)

    def expr_str(self, obj: str) -> ExprType:
        """Convert a string to R character literal."""
        return enquote(obj)  # R uses same string quoting as Python

    def expr_path(self, obj: pathlib.Path) -> ExprType:
        """Convert a path to R character literal."""
        return enquote(str(obj))

    def expr_list(self, obj: list[ExprType]) -> ExprType:
        """Convert a list to R vector/list.
        In R, c() creates an atomic vector, list() creates a list.
        """
        return f"c({', '.join(obj)})"

    def expr_dict(self, obj: dict[ExprType, ExprType]) -> ExprType:
        """Convert a dict to R list with named elements."""
        return f"list({', '.join([f'{k}={v}' for k, v in obj.items()])})"

    def expr_numeric_to_str(self, numeric_expr: str) -> str:
        """Convert numeric expression to string in R."""
        return f"as.character({numeric_expr})"

    def expr_null(self) -> str:
        """R's NULL value."""
        return "NULL"

    def expr_remove_suffixes(self, str_expr: str, suffixes: list[str]) -> str:
        """Remove suffixes from string in R using gsub."""
        substitute = str_expr
        patterns = [f"({suffix})$" for suffix in suffixes]
        for pattern in patterns:
            substitute = f"gsub({self.expr_literal(pattern)}, '', {substitute})"
        return substitute

    def expr_path_get_filename(self, path_expr: str) -> str:
        """Get filename from path in R using basename."""
        return f"basename({path_expr})"

    def expr_conditions_join_and(self, condition_exprs: list[str]) -> str:
        """Join conditions with AND in R."""
        return " && ".join(condition_exprs)

    def expr_conditions_join_or(self, condition_exprs: list[str]) -> str:
        """Join conditions with OR in R."""
        return " || ".join(condition_exprs)

    def expr_concat_strs(self, exprs: list[str], join: str = "") -> str:
        """Concatenate strings in R using paste/paste0."""
        if join:
            return f"paste({', '.join(exprs)}, collapse={self.expr_str(join)})"
        return f"paste0({', '.join(exprs)})"

    def expr_ternary(self, condition: str, truthy: str, falsy: str, enbrace_: bool = False) -> str:
        """R uses ifelse() for vectorized ternary operations."""
        if " " in condition:
            condition = enbrace(condition, "(")
        ret = f"ifelse({condition}, {truthy}, {falsy})"
        if enbrace_:
            return enbrace(ret, "(")
        return ret


class RLanguageHighLevelProvider(LanguageHighLevelProvider):
    def wrapper_module_imports(self) -> LineBuffer:
        return [
            "library(styxdefs)",
            'source("utils.R")',
        ]

    def struct_collect_outputs(self, struct: ir.Param[ir.Param.Struct], struct_symbol: str) -> str:
        if struct.list_:
            opt = ""
            if struct.nullable:
                opt = f" if (!is.null({struct_symbol})) else NULL"
            return (
                f'lapply({struct_symbol}, function(i) if (!is.null(dyn.outputs(i[["@type"]]))) '
                f'dyn.outputs(i[["@type"]])(i, execution) else NULL){opt}'
            )

        o = f'dyn.outputs({struct_symbol}[["@type"]])({struct_symbol}, execution)'
        if struct.nullable:
            o = f"if (!is.null({struct_symbol})) {o} else NULL"
        return o

    def runner_symbol(self) -> str:
        return "runner"

    def runner_declare(self, runner_symbol: str) -> LineBuffer:
        return [f"{runner_symbol} <- {runner_symbol} %||% get.global.runner()"]

    def symbol_execution(self) -> str:
        return "execution"

    def execution_declare(self, execution_symbol: str, metadata_symbol: str) -> LineBuffer:
        return [f"{execution_symbol} <- runner$start.execution({metadata_symbol})"]

    def execution_process_params(
        self,
        execution_symbol: str,
        params_symbol: str,
    ) -> LineBuffer:
        return [f"{params_symbol} <- {execution_symbol}$params({params_symbol})"]

    def execution_run(
        self,
        execution_symbol: str,
        cargs_symbol: str,
        stdout_output_symbol: str | None,
        stderr_output_symbol: str | None,
    ) -> LineBuffer:
        so = (
            ""
            if stdout_output_symbol is None
            else f", handle.stdout=function(s) ret${stdout_output_symbol} <- c(ret${stdout_output_symbol}, s)"
        )
        se = (
            ""
            if stderr_output_symbol is None
            else f", handle.stderr=function(s) ret${stderr_output_symbol} <- c(ret${stderr_output_symbol}, s)"
        )
        return [f"{execution_symbol}$run({cargs_symbol}{so}{se})"]

    def generate_arg_declaration(self, arg: GenericArg) -> str:
        if arg.default is None:
            return arg.name
        return f"{arg.name}={arg.default}"

    def generate_func(self, func: GenericFunc) -> LineBuffer:
        buf = []
        func.args.sort(key=lambda a: a.default is not None)

        # Function documentation
        if func.docstring_body or func.args or func.return_descr:
            buf.extend([
                "#' @title",
                f"#' {'\n'.join(["#' " + l for l in linebreak_paragraph(func.docstring_body)])}"
                if func.docstring_body
                else "#' Function documentation",
                "#'",
                "#' @param",
                *[
                    f"#' {arg.name} {'\n'.join(["#' " + l for l in linebreak_paragraph(arg.docstring)])}"
                    for arg in func.args
                    if arg.name != "self"
                ],
                "#'",
                *([f"#' @return {func.return_descr}"] if func.return_descr else []),
            ])

        # Function definition
        buf.append(f"{func.name} <- function(")
        for arg in func.args:
            buf.extend(indent([f"{self.generate_arg_declaration(arg)},"]))
        buf.append(") {")

        if func.body:
            buf.extend(indent(func.body))
        else:
            buf.extend(indent(["NULL"]))

        buf.append("}")
        return buf

    def generate_structure(self, structure: GenericStructure) -> LineBuffer:
        structure.fields.sort(key=lambda a: a.default is not None)

        field_docs = "\n".join([f"#   {f.name}: {f.docstring}" for f in structure.fields])

        return [
            f"#' Create a new {structure.name}",
            "#'",
            f"#' {structure.docstring}" if structure.docstring else "",
            "#' Fields:",
            f"#' {field_docs}",
            f"{structure.name} <- function(",
            *indent([f"{f.name}{' = ' + str(f.default) if f.default is not None else ''}," for f in structure.fields]),
            ") {",
            "  structure(",
            "    list(",
            *indent([f"{f.name} = {f.name}," for f in structure.fields]),
            f'    @type = "{structure.name}"',
            "    ),",
            f'    class = "{structure.name}"',
            "  )",
            "}",
        ]

    def generate_module(self, module: GenericModule) -> LineBuffer:
        exports = (
            [
                "# Exports",
                ".exports <- c(",
                *indent([f'"{name}",' for name in sorted(module.exports)]),
                ")",
            ]
            if module.exports
            else []
        )

        return blank_after([
            *(["#'", *linebreak_paragraph(escape_backslash(module.docstr)), "#'"] if module.docstr else []),
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

    def metadata_symbol(self, interface_base_name: str) -> str:
        return self.symbol_constant_case_from(f"{interface_base_name}_METADATA")

    def generate_metadata(self, metadata_symbol: str, entries: dict) -> LineBuffer:
        return [
            f"{metadata_symbol} <- list(",
            *indent([f"{k} = {self.expr_literal(v)}," for k, v in entries.items()]),
            ")",
        ]

    def return_statement(self, value: str) -> str:
        return f"return({value})"

    def cargs_symbol(self) -> str:
        return "cargs"

    def cargs_declare(self, cargs_symbol: str) -> LineBuffer:
        return [f"{cargs_symbol} <- list()"]

    def mstr_collapse(self, mstr: MStr, join: str = "") -> MStr:
        return MStr(f"paste({mstr.expr}, collapse={self.expr_str(join)})" if mstr.is_list else mstr.expr, False)

    def mstr_concat(self, mstrs: list[MStr], inner_join: str = "", outer_join: str = "") -> MStr:
        inner = list(self.mstr_collapse(mstr, inner_join) for mstr in mstrs)
        return MStr(
            f"paste({', '.join(m.expr for m in inner)}, collapse={self.expr_str(outer_join)})"
            if outer_join
            else f"paste0({', '.join(m.expr for m in inner)})",
            False,
        )

    def mstr_cargs_add(self, cargs_symbol: str, mstr: MStr | list[MStr]) -> LineBuffer:
        if isinstance(mstr, list):
            elements = [val if not val_is_list else f"unlist({val})" for val, val_is_list in mstr]
            return [f"{cargs_symbol} <- append({cargs_symbol}, list(", *indent(expand(",\n".join(elements))), "))"]
        if mstr.is_list:
            return [f"{cargs_symbol} <- append({cargs_symbol}, {mstr.expr})"]
        return [f"{cargs_symbol} <- append({cargs_symbol}, list({mstr.expr}))"]

    def param_dict_create(
        self, lookup: LookupParam, name: str, param: ir.Param, items: list[tuple[ir.Param, ExprType]] | None = None
    ) -> LineBuffer:
        return [
            f"{name} <- list(",
            *indent([f'"@type" = {self.expr_str(lookup.expr_struct_global_name[param.base.id_])}']),
            *indent([f"{self.expr_str(key.base.name)} = {value}" for key, value in (items or [])]),
            ")",
        ]

    def param_dict_set(self, dict_symbol: str, param: ir.Param, value_expr: str) -> LineBuffer:
        return [f"{dict_symbol}[[{self.expr_str(param.base.name)}]] <- {value_expr}"]

    def dyn_declare(self, lookup: LookupParam, root_struct: ir.Param[ir.Param.Struct]) -> list[GenericFunc]:
        items = [
            (self.expr_str(lookup.expr_struct_global_name[s.base.id_]), lookup.expr_func_build_cargs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
        ]
        func_get_build_cargs = GenericFunc(
            name="dyn.cargs",
            return_type="function",
            docstring_body="Get build cargs function by command type.",
            return_descr="Build cargs function.",
            args=[GenericArg(name="t", docstring="Command type", type="character")],
            body=[
                "dispatch.table <- list(",
                *indent([f"{key} = {value}," for key, value in items]),
                ")",
                "return(dispatch.table[[t]])",
            ],
        )

        items = [
            (self.expr_str(lookup.expr_struct_global_name[s.base.id_]), lookup.expr_func_build_outputs[s.base.id_])
            for s in root_struct.iter_structs_recursively(False)
            if struct_has_outputs(s)
        ]
        func_get_build_outputs = GenericFunc(
            name="dyn.outputs",
            return_type="function",
            docstring_body="Get build outputs function by command type.",
            return_descr="Build outputs function.",
            args=[GenericArg(name="t", docstring="Command type", type="character")],
            body=[
                "dispatch.table <- list(",
                *indent([f"{key} = {value}," for key, value in items]),
                ")",
                "return(dispatch.table[[t]])",
            ],
        )

        return [func_get_build_cargs, func_get_build_outputs]

    def param_dict_type_declare(self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct]) -> LineBuffer:
        param_items = [(self.expr_str("@type"), lookup.expr_struct_global_name[struct.base.id_])]
        for p in struct.body.iter_params():
            param_items.append((self.expr_str(p.base.name), lookup.expr_param_type[p.base.id_]))

        dict_symbol = lookup.expr_params_dict_type[struct.base.id_]

        return [
            f"validate.{dict_symbol} <- function(x) {{",
            "  required.fields <- c(",
            *indent([f"{key}," for key, _ in param_items]),
            "  )",
            "  if (!all(required.fields %in% names(x))) {",
            '    stop("Missing required fields in parameter dictionary")',
            "  }",
            "  return(TRUE)",
            "}",
        ]

    def generate_ret_object_creation(
        self,
        buf: LineBuffer,
        execution_symbol: str,
        output_type: str,
        members: dict[str, str],
    ) -> LineBuffer:
        buf.append("ret <- list(")
        buf.extend(
            indent([
                f'root = {execution_symbol}$output.file(".")',
            ])
        )
        for member_symbol, member_expr in members.items():
            buf.extend(indent([f"{member_symbol} = {member_expr},"]))
        buf.extend([")", f'class(ret) <- "{output_type}"'])
        return buf

    def resolve_output_file(self, execution_symbol: str, file_expr: str) -> str:
        return f"{execution_symbol}$output.file({file_expr})"

    def if_else_block(self, condition: str, truthy: LineBuffer, falsy: LineBuffer | None = None) -> LineBuffer:
        buf = [f"if ({condition}) {{", *indent(truthy), "}"]
        if falsy:
            buf.extend(["else {", *indent(falsy), "}"])
        return buf

    def param_dict_get(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}[[{self.expr_str(param.base.name)}]]"

    def param_dict_get_or_null(self, name: str, param: ir.Param) -> ExprType:
        return f"{name}[[{self.expr_str(param.base.name)}]] %||% NULL"


class _PackageData(typing.NamedTuple):
    package: ir.Package
    package_symbol: str
    scope: Scope
    module: GenericModule


class RLanguageCompileProvider:
    def compile(self, interfaces: typing.Iterable[ir.Interface]) -> typing.Generator[TextFile, typing.Any, None]:
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
            # package_data.module.imports.append(f"from .{interface_module_symbol} import *")
            yield TextFile(
                path=pathlib.Path(package_data.package_symbol) / (interface_module_symbol + ".R"),
                content=collapse(self.generate_module(interface_module)),
            )

        # for package_data in packages.values():
        #    package_data.module.imports.sort()
        #    yield CompiledFile(
        #        path=pathlib.Path(package_data.package_symbol) / "__init__.py",
        #        content=collapse(self.generate_module(package_data.module))
        #    )


class RLanguageProvider(
    RLanguageTypeProvider,
    RLanguageIrProvider,
    RLanguageExprProvider,
    RLanguageSymbolProvider,
    RLanguageHighLevelProvider,
    RLanguageCompileProvider,
    LanguageProvider,
):
    pass
