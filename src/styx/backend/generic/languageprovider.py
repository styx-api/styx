import pathlib
import typing
from abc import abstractmethod
from typing import Mapping, Protocol, Sequence, TypeAlias

import styx.ir.core as ir
from styx.backend.compile import Compilable

if typing.TYPE_CHECKING:
    from styx.backend.generic.gen.lookup import LookupParam
else:
    LookupParam = None
from styx.backend.generic.linebuffer import LineBuffer
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure

if typing.TYPE_CHECKING:
    from styx.backend.generic.scope import Scope
else:
    Scope = None

_TYPE_PYPRIMITIVE: TypeAlias = str | float | int | bool | pathlib.Path | None
TYPE_PYLITERAL: TypeAlias = _TYPE_PYPRIMITIVE | Sequence["TYPE_PYLITERAL"] | Mapping[str, "TYPE_PYLITERAL"]

ExprType = str
TypeType = str


class MStr(typing.NamedTuple):
    """Expression referring to either a string or a list of strings."""

    expr: ExprType
    is_list: bool


class LanguageTypeProvider(Protocol):
    @abstractmethod
    def type_str(self) -> TypeType:
        """String type."""
        ...

    @abstractmethod
    def type_int(self) -> TypeType:
        """Integer type."""
        ...

    @abstractmethod
    def type_float(self) -> TypeType:
        """Float type."""
        ...

    @abstractmethod
    def type_bool(self) -> TypeType:
        """Bool type."""
        ...

    @abstractmethod
    def type_input_path(self) -> TypeType:
        """Input path type."""
        ...

    @abstractmethod
    def type_output_path(self) -> TypeType:
        """Type of output path."""
        ...

    @abstractmethod
    def type_runner(self) -> TypeType:
        """Type of Runner."""
        ...

    @abstractmethod
    def type_execution(self) -> TypeType:
        """Type of Execution."""
        ...

    @abstractmethod
    def type_literal_union(self, obj: list[TYPE_PYLITERAL]) -> TypeType:
        """Convert an object to a language literal union type."""
        ...

    @abstractmethod
    def type_list(self, type_element: TypeType) -> TypeType:
        """Convert a type symbol to a type of list of that type."""
        ...

    @abstractmethod
    def type_optional(self, type_element: TypeType) -> TypeType:
        """Convert a type symbol to an optional of that type."""
        ...

    @abstractmethod
    def type_union(self, type_elements: list[TypeType]) -> TypeType:
        """Convert a collection of type symbol to a union type of them."""
        ...

    # Default implementations

    def type_param(self, param: ir.Param, lookup_struct_type: dict[ir.IdType, str]) -> TypeType:
        """Return the Python type expression for a param.

        Args:
            param: The param.
            lookup_struct_type: lookup dictionary for struct types (pre-compute).

        Returns:
            Language type expression.
        """

        def _base() -> str:
            if isinstance(param.body, ir.Param.String):
                if param.choices:
                    return self.type_literal_union(param.choices)  # type: ignore
                return self.type_str()
            if isinstance(param.body, ir.Param.Int):
                if param.choices:
                    return self.type_literal_union(param.choices)  # type: ignore
                return self.type_int()
            if isinstance(param.body, ir.Param.Float):
                return self.type_float()
            if isinstance(param.body, ir.Param.File):
                return self.type_input_path()
            if isinstance(param.body, ir.Param.Bool):
                return self.type_bool()
            if isinstance(param.body, ir.Param.Struct):
                return lookup_struct_type[param.base.id_]
            if isinstance(param.body, ir.Param.StructUnion):
                return self.type_union([lookup_struct_type[i.base.id_] for i in param.body.alts])
            assert False

        type_ = _base()
        if param.list_:
            type_ = self.type_list(type_)
        if param.nullable:
            type_ = self.type_optional(type_)

        return type_

    def type_string_list(self) -> TypeType:
        """Type of string list. (e.g. for cargs)."""
        return self.type_list(self.type_str())


class LanguageSymbolProvider(Protocol):
    @abstractmethod
    def symbol_legal(self, name: str) -> bool:
        """Is a given string a legal symbol in this language."""
        ...

    @abstractmethod
    def language_scope(self) -> Scope:
        """Build a scope with all the global keywords, reserved symbols, etc.

        (Basically everything we never want to shadow).
        """
        ...

    @abstractmethod
    def symbol_from(self, name: str) -> ExprType:
        """Convert an arbitrary name to a similar-looking legal symbol."""
        ...

    @abstractmethod
    def symbol_constant_case_from(self, name: str) -> ExprType:
        """Convert an arbitrary name to a similar-looking legal symbol.

        which is in the usual case style of a constant.
        """
        ...

    @abstractmethod
    def symbol_class_case_from(self, name: str) -> ExprType:
        """Convert an arbitrary name to a similar-looking legal symbol.

        which is in the usual case style of a class name.
        """
        ...

    @abstractmethod
    def symbol_var_case_from(self, name: str) -> ExprType:
        """Convert an arbitrary name to a similar-looking legal symbol.

        which is in the usual case style of a variable.
        """
        ...


class LanguageExprProvider(Protocol):
    @abstractmethod
    def expr_bool(self, obj: bool) -> ExprType:
        """Convert a bool to a language literal."""
        ...

    @abstractmethod
    def expr_int(self, obj: int) -> ExprType:
        """Convert a int to a language literal."""
        ...

    @abstractmethod
    def expr_float(self, obj: float) -> ExprType:
        """Convert a float to a language literal."""
        ...

    @abstractmethod
    def expr_str(self, obj: str) -> ExprType:
        """Convert a str to a language literal."""
        ...

    @abstractmethod
    def expr_path(self, obj: pathlib.Path) -> ExprType:
        """Convert a path to a language literal."""
        ...

    @abstractmethod
    def expr_list(self, obj: list[ExprType]) -> ExprType:
        """Convert a list to a language literal."""
        ...

    @abstractmethod
    def expr_dict(self, obj: dict[ExprType, ExprType]) -> ExprType:
        """Convert a dict to a language literal."""
        ...

    def expr_literal(self, obj: TYPE_PYLITERAL) -> ExprType:
        """Convert an object to a language literal expression."""
        if obj is None:
            return self.expr_null()
        if isinstance(obj, bool):
            return self.expr_bool(obj)
        if isinstance(obj, int):
            return self.expr_int(obj)
        if isinstance(obj, float):
            return self.expr_float(obj)
        if isinstance(obj, str):
            return self.expr_str(obj)
        if isinstance(obj, pathlib.Path):
            return self.expr_path(obj)
        if isinstance(obj, (list, tuple, set)):
            return self.expr_list([self.expr_literal(o) for o in obj])
        if isinstance(obj, dict):
            return self.expr_dict({self.expr_literal(k): self.expr_literal(v) for k, v in obj.items()})
        raise ValueError(f"Unsupported type: {type(obj)}")

    @abstractmethod
    def expr_remove_suffixes(
        self,
        str_expr: ExprType,
        suffixes: list[str],
    ) -> ExprType:
        """String expression which removes all given suffixes from a string expression."""
        ...

    @abstractmethod
    def expr_path_get_filename(
        self,
        path_expr: ExprType,
    ) -> ExprType:
        """Extract filename from path expression."""
        ...

    @abstractmethod
    def expr_numeric_to_str(
        self,
        numeric_expr: ExprType,
    ) -> ExprType:
        """Numeric (float or int) expression to str expression."""
        ...

    @abstractmethod
    def expr_conditions_join_and(
        self,
        condition_exprs: list[ExprType],
    ) -> ExprType:
        """Join conditions via logical AND."""
        ...

    @abstractmethod
    def expr_conditions_join_or(
        self,
        condition_exprs: list[ExprType],
    ) -> ExprType:
        """Join conditions via logical OR."""
        ...

    @abstractmethod
    def expr_concat_strs(self, exprs: list[ExprType], join: str = "") -> ExprType:
        """Concatenate string expressions."""
        ...

    @abstractmethod
    def expr_ternary(self, condition: ExprType, truthy: ExprType, falsy: ExprType, enbrace_: bool = False) -> ExprType:
        """Ternary expression."""
        ...

    @abstractmethod
    def expr_null(self) -> ExprType:
        """Null value."""
        ...

    @abstractmethod
    def expr_line_comment(self, comment_: LineBuffer) -> LineBuffer:
        """Line comment."""
        ...


class LanguageHighLevelProvider(Protocol):
    @abstractmethod
    def if_else_block(self, condition: str, truthy: LineBuffer, falsy: LineBuffer | None = None) -> LineBuffer:
        """If/else block."""
        ...

    @abstractmethod
    def generate_arg_declaration(self, arg: GenericArg) -> ExprType:
        """Argument declaration."""
        ...

    @abstractmethod
    def generate_func(self, func: GenericFunc) -> LineBuffer:
        """Generate function."""
        ...

    @abstractmethod
    def generate_structure(self, structure: GenericStructure) -> LineBuffer:
        """Generate structure."""
        ...

    @abstractmethod
    def generate_module(self, module: GenericModule) -> LineBuffer:
        """Generate module."""
        ...

    def generate_model(self, m: GenericFunc | GenericStructure) -> LineBuffer:
        if isinstance(m, GenericFunc):
            return self.generate_func(m)
        if isinstance(m, GenericStructure):
            return self.generate_structure(m)
        raise TypeError(f"Unsupported type: {type(m)}")

    @abstractmethod
    def return_statement(self, value: ExprType) -> ExprType:
        """(Possibly early) return statement."""
        ...

    @abstractmethod
    def wrapper_module_imports(self) -> LineBuffer:
        """List of imports each wrapper module should have."""
        ...

    @abstractmethod
    def metadata_symbol(
        self,
        interface_base_name: str,
    ) -> ExprType:
        """Symbol the metadata constant should get."""
        ...

    @abstractmethod
    def generate_metadata(
        self,
        metadata_symbol: str,
        entries: dict,
    ) -> LineBuffer:
        """Generate the metadata definition."""
        ...

    @abstractmethod
    def cargs_symbol(self) -> ExprType:
        """Construct command line args list."""
        ...

    @abstractmethod
    def cargs_declare(self, cargs_symbol: str) -> LineBuffer:
        """Construct command line args list."""
        ...

    @abstractmethod
    def mstr_cargs_add(self, cargs_symbol: str, mstr: MStr | list[MStr]) -> LineBuffer:
        """Extend cargs by mstr."""
        ...

    @abstractmethod
    def mstr_collapse(self, mstr: MStr, join: str = "") -> MStr:
        """Join a mstr if it is referring to a list."""
        ...

    @abstractmethod
    def mstr_concat(self, mstrs: list[MStr], inner_join: str = "", outer_join: str = "") -> MStr:
        """Concatenate all mstrings down to a mstr(*, False).

        inner_join controls how the inner mstrs collapse,
        outer_join how the resulting mstr is joined.
        """
        ...

    def mstr_empty_literal_like(self, mstr: MStr) -> ExprType:
        """Empty string or string list expression depending on mstr.is_list."""
        return self.expr_list([]) if mstr.is_list else self.expr_str("")

    @abstractmethod
    def runner_symbol(self) -> ExprType:
        """Construct command line args list."""
        ...

    @abstractmethod
    def runner_declare(self, runner_symbol: str) -> LineBuffer:
        """Construct command line args list."""
        ...

    @abstractmethod
    def symbol_execution(self) -> str:
        """Construct command line args list."""
        ...

    @abstractmethod
    def execution_declare(self, execution_symbol: str, metadata_symbol: str) -> LineBuffer:
        """Construct command line args list."""
        ...

    @abstractmethod
    def execution_process_params(
        self,
        execution_symbol: str,
        params_symbol: str,
    ) -> LineBuffer:
        """Let the execution process the params."""
        ...

    @abstractmethod
    def execution_run(
        self,
        execution_symbol: str,
        cargs_symbol: str,
        stdout_output_symbol: str | None,
        stderr_output_symbol: str | None,
    ) -> LineBuffer:
        """Start execution."""
        ...

    @abstractmethod
    def generate_ret_object_creation(
        self,
        buf: LineBuffer,
        execution_symbol: str,
        output_type: str,
        members: dict[str, str],
    ) -> LineBuffer:
        """Generate return tuple object."""
        ...

    @abstractmethod
    def resolve_output_file(self, execution_symbol: str, file_expr: str) -> str:
        """Resolve output file."""
        ...

    @abstractmethod
    def struct_collect_outputs(self, struct: ir.Param[ir.Param.Struct], struct_symbol: str) -> str:
        """Collect outputs for a sub-struct."""
        ...

    @abstractmethod
    def dyn_declare(self, lookup: LookupParam, root_struct: ir.Param[ir.Param.Struct]) -> list[GenericFunc]:
        """Declare functions needed for performing dynamic dispatch of subcommand carg and output building."""
        ...

    @abstractmethod
    def param_dict_type_declare(self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct]) -> LineBuffer:
        """Declare the type a subcommand parameter dictionary."""
        ...

    @abstractmethod
    def param_dict_create(
        self,
        lookup: LookupParam,
        name: str,
        param: ir.Param[ir.Param.Struct],
        items: list[tuple[ir.Param, ExprType]] | None = None,
    ) -> LineBuffer:
        """Construct dictionary."""
        ...

    @abstractmethod
    def param_dict_set(self, dict_symbol: str, param: ir.Param, value_expr: str) -> LineBuffer:
        """Set a parameter from in a dict."""
        ...

    @abstractmethod
    def param_dict_get(self, name: str, param: ir.Param) -> ExprType:
        """Get a parameter from its dict."""
        ...

    @abstractmethod
    def param_dict_get_or_default(self, name: str, param: ir.Param, default: ExprType) -> ExprType:
        """Get a parameter from its dict."""
        ...

    def param_dict_get_or_null(self, name: str, param: ir.Param) -> ExprType:
        """Get a parameter from its dict."""
        return self.param_dict_get_or_default(name, param, self.expr_null())


class LanguageIrProvider(Protocol):
    def param_default_value(self, param: ir.Param) -> str | None:
        """Default value language literal if param has default value else None."""
        if param.default_value is ir.Param.SetToNone:
            return self.expr_null()
        if param.default_value is None:
            return None
        return self.expr_literal(param.default_value)  # type: ignore

    @abstractmethod
    def param_var_to_mstr(
        self,
        param: ir.Param,
        symbol: str,
    ) -> MStr:
        """Language var to MStr."""
        ...

    @abstractmethod
    def param_var_is_set_by_user(
        self,
        param: ir.Param,
        symbol: str,
        enbrace_statement: bool = False,
    ) -> str | None:
        """Return a language expression that checks if the variable is set by the user.

        Returns `None` if the param must always be specified.
        """
        ...

    @abstractmethod
    def param_is_set_by_user(
        self,
        param: ir.Param,
        symbol: str,
        enbrace_statement: bool = False,
    ) -> str | None:
        """Return a language expression that checks if the variable is set by the user.

        Returns `None` if the param must always be specified.
        """
        ...

    @abstractmethod
    def build_params_and_execute(
        self, lookup: LookupParam, struct: ir.Param[ir.Param.Struct], runner_symbol: ExprType
    ) -> LineBuffer: ...

    @abstractmethod
    def call_build_cargs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer: ...

    @abstractmethod
    def call_build_outputs(
        self,
        lookup: LookupParam,
        struct: ir.Param[ir.Param.Struct],
        params_symbol: ExprType,
        execution_symbol: ExprType,
        return_symbol: ExprType,
    ) -> LineBuffer: ...


class LanguageProvider(
    LanguageTypeProvider,
    LanguageSymbolProvider,
    LanguageIrProvider,
    LanguageExprProvider,
    LanguageHighLevelProvider,
    Compilable,
    Protocol,
):
    pass
