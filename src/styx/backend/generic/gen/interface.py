import styx.ir.core as ir
from styx.backend.generic.documentation import docs_to_docstring
from styx.backend.generic.gen.lookup import LookupParam
from styx.backend.generic.gen.metadata import generate_static_metadata
from styx.backend.generic.languageprovider import LanguageProvider, MStr
from styx.backend.generic.linebuffer import LineBuffer, blank_before
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure
from styx.backend.generic.scope import Scope
from styx.backend.generic.utils import enquote, struct_has_outputs


def _compile_build_params(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
) -> GenericFunc:
    func = GenericFunc(
        name=lookup.expr_func_build_params[param.base.id_],
        docstring_body="Build parameters.",
        return_type=lookup.expr_params_dict_type[param.base.id_],
        return_descr="Parameter dictionary",
        args=[],
    )

    for p in param.body.iter_params():
        symbol = lookup.expr_param_symbol_alias[p.base.id_]
        func.args.append(
            GenericArg(
                name=symbol,
                type=lookup.expr_param_type[p.base.id_],
                default=lang.param_default_value(p),
                docstring=p.base.docs.description,
            )
        )

    params_symbol = "params"

    param_items = [(p, lookup.expr_param_symbol_alias[p.base.id_]) for p in param.body.iter_params() if not p.nullable]
    func.body.extend(lang.param_dict_create(lookup, params_symbol, param, param_items))

    for p in param.body.iter_params():
        if not p.nullable:
            continue
        if (
            param_is_set_expr := lang.param_var_is_set_by_user(p, lookup.expr_param_symbol_alias[p.base.id_], False)
        ) is not None:
            func.body.extend(
                lang.if_else_block(
                    param_is_set_expr,
                    [*lang.param_dict_set(params_symbol, p, lookup.expr_param_symbol_alias[p.base.id_])],
                )
            )

    func.body.append(lang.return_statement(params_symbol))

    return func


def _compile_param_dict_type(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
) -> list[str]:
    return lang.param_dict_type_declare(lookup, param)


def _compile_build_cargs(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
) -> GenericFunc:
    func = GenericFunc(
        name=lookup.expr_func_build_cargs[param.base.id_],
        docstring_body="Build command-line arguments from parameters.",
        return_type=lang.type_string_list(),
        return_descr="Command-line arguments.",
        args=[
            GenericArg(
                name="params",
                type=lookup.expr_params_dict_type[param.base.id_],
                default=None,
                docstring="The parameters.",
            ),
            GenericArg(
                name=lang.symbol_execution(),
                type=lang.type_execution(),
                default=None,
                docstring="The execution object for resolving input paths.",
            ),
        ],
    )

    func.body.extend(lang.cargs_declare("cargs"))

    for group in param.body.groups:
        group_conditions_py = []

        # We're collecting two structurally equal to versions of cargs string expressions,
        # one that assumes all parameters are set and one that checks all of them.
        # This way later we can use one or the other depending on the surrounding context.
        cargs_exprs: list[MStr] = []  # string expressions for building cargs
        cargs_exprs_maybe_null: list[MStr] = []  # string expressions for building cargs if parameters may be null

        for carg in group.cargs:
            carg_exprs: list[MStr] = []  # string expressions for building a single carg
            carg_exprs_maybe_null: list[MStr] = []

            # Build single carg
            for token in carg.tokens:
                if isinstance(token, str):
                    carg_exprs.append(MStr(lang.expr_literal(token), False))
                    carg_exprs_maybe_null.append(MStr(lang.expr_literal(token), False))
                    continue
                # elem_symbol = lookup.py_symbol[token.base.id_]
                elem_symbol = lang.param_dict_get_or_null("params", token)
                param_as_mstr = lang.param_var_to_mstr(token, elem_symbol)
                carg_exprs.append(param_as_mstr)
                if (param_is_set_expr := lang.param_var_is_set_by_user(token, elem_symbol, False)) is not None:
                    group_conditions_py.append(param_is_set_expr)
                    _empty_expr = lang.mstr_empty_literal_like(param_as_mstr)
                    carg_exprs_maybe_null.append(
                        MStr(
                            lang.expr_ternary(param_is_set_expr, param_as_mstr.expr, _empty_expr, True),
                            param_as_mstr.is_list,
                        )
                    )
                else:
                    carg_exprs_maybe_null.append(param_as_mstr)

            # collapse and add single carg to cargs expressions
            if len(carg_exprs) == 1:
                cargs_exprs.append(carg_exprs[0])
                cargs_exprs_maybe_null.append(carg_exprs_maybe_null[0])
            else:
                cargs_exprs.append(lang.mstr_concat(carg_exprs))
                cargs_exprs_maybe_null.append(lang.mstr_concat(carg_exprs_maybe_null))

        # Append to cargs buffer
        buf_appending: LineBuffer = []
        if len(cargs_exprs) == 1:
            for str_symbol in cargs_exprs_maybe_null if len(group_conditions_py) > 1 else cargs_exprs:
                buf_appending.extend(lang.mstr_cargs_add("cargs", str_symbol))
        else:
            x = cargs_exprs_maybe_null if len(group_conditions_py) > 1 else cargs_exprs
            buf_appending.extend(lang.mstr_cargs_add("cargs", x))

        if len(group_conditions_py) > 0:
            func.body.extend(
                lang.if_else_block(
                    condition=lang.expr_conditions_join_or(group_conditions_py),
                    truthy=buf_appending,
                )
            )
        else:
            func.body.extend(buf_appending)

    func.body.append(lang.return_statement("cargs"))

    return func


def _compile_outputs_class(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    interface_module: GenericModule,
    lookup: LookupParam,
    stdout_as_string_output: ir.StdOutErrAsStringOutput | None = None,
    stderr_as_string_output: ir.StdOutErrAsStringOutput | None = None,
) -> None:
    outputs_class: GenericStructure = GenericStructure(
        name=lookup.expr_struct_output_type[struct.base.id_],
        docstring=f"Output object returned when calling `{lookup.expr_param_type[struct.base.id_]}(...)`.",
    )
    outputs_class.fields.append(
        GenericArg(
            name="root",
            type="OutputPathType",
            default=None,
            docstring="Output root folder. This is the root folder for all outputs.",
        )
    )

    for stdout_stderr_output in (stdout_as_string_output, stderr_as_string_output):
        if stdout_stderr_output is None:
            continue
        outputs_class.fields.append(
            GenericArg(
                name=lookup.expr_output_field_symbol[stdout_stderr_output.id_],
                type=lang.type_string_list(),
                default=None,
                docstring=stdout_stderr_output.docs.description,
            )
        )

    for output in struct.base.outputs:
        output_symbol = lookup.expr_output_field_symbol[output.id_]

        # Optional if any of its param references is optional
        optional = False
        for token in output.tokens:
            if isinstance(token, str):
                continue
            optional = optional or lookup.param[token.ref_id].nullable

        output_type = lang.type_output_path()
        if optional:
            output_type = lang.type_optional(output_type)

        outputs_class.fields.append(
            GenericArg(
                name=output_symbol,
                type=output_type,
                default=None,
                docstring=output.docs.description,
            )
        )

    for sub_struct in struct.body.iter_params():
        if isinstance(sub_struct.body, ir.Param.Struct):
            if struct_has_outputs(sub_struct):
                output_type = lookup.expr_struct_output_type[sub_struct.base.id_]
                if sub_struct.list_:
                    output_type = lang.type_list(output_type)
                if sub_struct.nullable:
                    output_type = lang.type_optional(output_type)

                output_symbol = lookup.expr_output_field_symbol[sub_struct.base.id_]

                input_type = lookup.expr_func_build_outputs[sub_struct.base.id_]
                docs_append = ""
                if sub_struct.list_:
                    docs_append = "This is a list of outputs with the same length and order as the inputs."

                outputs_class.fields.append(
                    GenericArg(
                        name=output_symbol,
                        type=output_type,
                        default=None,
                        docstring=f"Outputs from {enquote(input_type, '`')}.{docs_append}",
                    )
                )
        elif isinstance(sub_struct.body, ir.Param.StructUnion):
            if any([struct_has_outputs(s) for s in sub_struct.body.alts]):
                alt_types = [
                    lookup.expr_struct_output_type[sub_command.base.id_]
                    for sub_command in sub_struct.body.alts
                    if struct_has_outputs(sub_command)
                ]
                if len(alt_types) > 0:
                    output_type = lang.type_union(alt_types)

                    if sub_struct.list_:
                        output_type = lang.type_list(output_type)
                    if sub_struct.nullable:
                        output_type = lang.type_optional(output_type)

                    output_symbol = lookup.expr_output_field_symbol[sub_struct.base.id_]

                    alt_input_types = [
                        lookup.expr_params_dict_type[sub_command.base.id_]
                        for sub_command in sub_struct.body.alts
                        if struct_has_outputs(sub_command)
                    ]
                    docs_append = ""
                    if sub_struct.list_:
                        docs_append = "This is a list of outputs with the same length and order as the inputs."

                    input_types_human = " or ".join([enquote(t, "`") for t in alt_input_types])
                    outputs_class.fields.append(
                        GenericArg(
                            name=output_symbol,
                            type=output_type,
                            default=None,
                            docstring=f"Outputs from {input_types_human}.{docs_append}",
                        )
                    )

    interface_module.funcs_and_classes.append(outputs_class)
    interface_module.exports.append(outputs_class.name)


def _compile_func_build_outputs(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
    stdout_as_string_output: ir.StdOutErrAsStringOutput | None = None,
    stderr_as_string_output: ir.StdOutErrAsStringOutput | None = None,
) -> GenericFunc:
    """Generate the outputs building code."""
    func = GenericFunc(
        name=lookup.expr_func_build_outputs[param.base.id_],
        docstring_body="Build outputs object containing output file paths and possibly stdout/stderr.",
        return_type=lookup.expr_struct_output_type[param.base.id_],
        return_descr="Outputs object.",
        args=[
            GenericArg(
                name="params",
                type=lookup.expr_params_dict_type[param.base.id_],
                default=None,
                docstring="The parameters.",
            ),
            GenericArg(
                name=lang.symbol_execution(),
                type=lang.type_execution(),
                default=None,
                docstring="The execution object for resolving input paths.",
            ),
        ],
    )

    members = {}

    def _py_get_val(
        output_param_reference: ir.OutputParamReference,
    ) -> str:
        p = lookup.param[output_param_reference.ref_id]
        symbol = lang.param_dict_get_or_null("params", p)

        if p.list_:
            raise Exception(f"Output path template replacements cannot be lists. ({p.base.name})")

        if isinstance(p.body, ir.Param.String):
            return lang.expr_remove_suffixes(symbol, output_param_reference.file_remove_suffixes)

        if isinstance(p.body, (ir.Param.Int, ir.Param.Float)):
            return lang.expr_numeric_to_str(symbol)

        if isinstance(p.body, ir.Param.File):
            return lang.expr_remove_suffixes(
                lang.expr_path_get_filename(symbol), output_param_reference.file_remove_suffixes
            )

        # if isinstance(p.body, ir.Param.Bool):
        #    raise Exception(f"Unsupported input type for output path template of '{p.base.name}'.")
        raise Exception(f"Unsupported output type for output path template of '{p.base.name}'.")

    for stdout_stderr_output in (stdout_as_string_output, stderr_as_string_output):
        if stdout_stderr_output is None:
            continue
        output_symbol = lookup.expr_output_field_symbol[stdout_stderr_output.id_]

        members[output_symbol] = lang.expr_list([])

    for output in param.base.outputs:
        output_symbol = lookup.expr_output_field_symbol[output.id_]

        output_segments: list[str] = []
        conditions = []
        for token in output.tokens:
            if isinstance(token, str):
                output_segments.append(lang.expr_literal(token))
                continue
            output_segments.append(_py_get_val(token))

            ostruct = lookup.param[token.ref_id]
            # param_symbol = lookup.expr_param_symbol_alias[ostruct.base.id_]
            param_symbol = lang.param_dict_get_or_null("params", ostruct)
            if (py_var_is_set_by_user := lang.param_var_is_set_by_user(ostruct, param_symbol, False)) is not None:
                conditions.append(py_var_is_set_by_user)

        if len(conditions) > 0:
            members[output_symbol] = lang.expr_ternary(
                condition=lang.expr_conditions_join_and(conditions),
                truthy=lang.resolve_output_file("execution", lang.expr_concat_strs(output_segments)),
                falsy=lang.expr_null(),
            )
        else:
            members[output_symbol] = lang.resolve_output_file("execution", lang.expr_concat_strs(output_segments))

    # sub struct outputs
    for sub_struct in param.body.iter_params():
        has_outputs = False
        if isinstance(sub_struct.body, ir.Param.Struct):
            has_outputs = struct_has_outputs(sub_struct)
        elif isinstance(sub_struct.body, ir.Param.StructUnion):
            has_outputs = any([struct_has_outputs(s) for s in sub_struct.body.alts])
        if not has_outputs:
            continue

        output_symbol = lookup.expr_output_field_symbol[sub_struct.base.id_]
        output_symbol_resolved = lang.param_dict_get_or_null("params", sub_struct)

        members[output_symbol] = lang.struct_collect_outputs(sub_struct, output_symbol_resolved)

    lang.generate_ret_object_creation(
        buf=func.body,
        execution_symbol="execution",
        output_type=lookup.expr_struct_output_type[param.base.id_],
        members=members,
    )
    func.body.append(lang.return_statement("ret"))

    return func


def _compile_func_execute(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
    metadata_symbol: str,
    stdout_as_string_output: ir.StdOutErrAsStringOutput | None = None,
    stderr_as_string_output: ir.StdOutErrAsStringOutput | None = None,
) -> GenericFunc:
    struct_has_outputs(struct)

    outputs_type = lookup.expr_struct_output_type[struct.base.id_]

    func = GenericFunc(
        name=lookup.expr_func_execute[struct.base.id_],
        return_type=outputs_type,
        return_descr=f"NamedTuple of outputs (described in `{outputs_type}`).",  # todo
        docstring_body=docs_to_docstring(struct.base.docs),
        args=[
            GenericArg(
                name="params",
                type=lookup.expr_params_dict_type[struct.base.id_],
                default=None,
                docstring="The parameters.",
            ),
            GenericArg(
                name=lang.symbol_execution(),
                type=lang.type_execution(),
                default=None,
                docstring="The execution object.",
            ),
        ],
    )

    func.body.extend([
        # lang.expr_line_comment("todo: validate constraint checks (or after middlewares?)"),
        *lang.execution_process_params("execution", "params"),
        *lang.call_build_cargs(lookup, struct, "params", "execution", "cargs"),
        *lang.call_build_outputs(lookup, struct, "params", "execution", "ret"),
        *lang.execution_run(
            execution_symbol="execution",
            cargs_symbol="cargs",
            stdout_output_symbol=lookup.expr_output_field_symbol[stdout_as_string_output.id_]
            if stdout_as_string_output
            else None,
            stderr_output_symbol=lookup.expr_output_field_symbol[stderr_as_string_output.id_]
            if stderr_as_string_output
            else None,
        ),
        lang.return_statement("ret"),
    ])
    return func


def _compile_func_wrapper_root(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
    metadata_symbol: str,
) -> GenericFunc:
    outputs_type = lookup.expr_struct_output_type[struct.base.id_]

    func = GenericFunc(
        name=lookup.expr_param_type[struct.base.id_],
        return_type=outputs_type,
        return_descr=f"NamedTuple of outputs (described in `{outputs_type}`).",
        docstring_body=docs_to_docstring(struct.base.docs),
    )

    pyargs = func.args

    # Collect param python symbols
    for elem in struct.body.iter_params():
        symbol = lookup.expr_param_symbol_alias[elem.base.id_]
        pyargs.append(
            GenericArg(
                name=symbol,
                type=lookup.expr_param_type[elem.base.id_],
                default=lang.param_default_value(elem),
                docstring=elem.base.docs.description,
            )
        )

    func.body.extend([
        *lang.runner_declare("runner"),
        *lang.execution_declare("execution", metadata_symbol),
    ])

    func.body.extend(lang.build_params_and_execute(lookup, struct, "execution"))

    pyargs.append(
        GenericArg(
            name="runner",
            type=lang.type_optional(lang.type_runner()),
            default=lang.expr_null(),
            docstring="Command runner",
        )
    )
    return func


def _compile_lookups(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    lookup: LookupParam,
) -> list[GenericFunc]:
    return lang.dyn_declare(lookup, struct)


def _compile_struct(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    interface_module: GenericModule,
    lookup: LookupParam,
    metadata_symbol: str,
    stdout_as_string_output: ir.StdOutErrAsStringOutput | None = None,
    stderr_as_string_output: ir.StdOutErrAsStringOutput | None = None,
    root_struct: bool = False,
) -> None:
    for child in struct.body.iter_params():
        if isinstance(child.body, ir.Param.Struct):
            _compile_struct(
                lang=lang,
                struct=child,
                interface_module=interface_module,
                lookup=lookup,
                metadata_symbol=metadata_symbol,
            )
        elif isinstance(child.body, child.StructUnion):
            for e in child.body.alts:
                _compile_struct(
                    lang=lang,
                    struct=e,
                    interface_module=interface_module,
                    lookup=lookup,
                    metadata_symbol=metadata_symbol,
                )

    if root_struct or struct_has_outputs(struct):
        _compile_outputs_class(lang, struct, interface_module, lookup, stdout_as_string_output, stderr_as_string_output)

    f = _compile_build_params(lang, struct, lookup)
    interface_module.funcs_and_classes.append(f)
    interface_module.exports.append(f.name)

    interface_module.header.extend(blank_before(_compile_param_dict_type(lang, struct, lookup), 2))
    interface_module.exports.append(lookup.expr_params_dict_type[struct.base.id_])

    f = _compile_build_cargs(lang, struct, lookup)
    interface_module.funcs_and_classes.append(f)
    interface_module.exports.append(f.name)

    if root_struct or struct_has_outputs(struct):
        f = _compile_func_build_outputs(lang, struct, lookup, stdout_as_string_output, stderr_as_string_output)
        interface_module.funcs_and_classes.append(f)
        interface_module.exports.append(f.name)

    if root_struct:
        f = _compile_func_execute(
            lang, struct, lookup, metadata_symbol, stdout_as_string_output, stderr_as_string_output
        )
        interface_module.funcs_and_classes.append(f)
        interface_module.exports.append(f.name)


def compile_interface(
    lang: LanguageProvider,
    interface: ir.Interface,
    package_scope: Scope,
    interface_module: GenericModule,
) -> None:
    """Entry point to the Python backend."""
    interface_module.imports.extend(lang.wrapper_module_imports())

    metadata_symbol = generate_static_metadata(
        lang=lang,
        module=interface_module,
        scope=package_scope,
        interface=interface,
    )
    interface_module.exports.append(metadata_symbol)

    function_symbol = package_scope.add_or_dodge(lang.symbol_var_case_from(interface.command.base.name))
    interface_module.exports.append(function_symbol)

    function_scope = Scope(lang).language_base_scope()
    function_scope.add_or_die("runner")
    function_scope.add_or_die("execution")
    function_scope.add_or_die("cargs")
    function_scope.add_or_die("ret")
    function_scope.add_or_die("params")

    # Lookup tables
    lookup = LookupParam(
        lang=lang,
        interface=interface,
        package_scope=package_scope,
        function_symbol=function_symbol,
        function_scope=function_scope,
    )

    for f in _compile_lookups(lang, interface.command, lookup):
        interface_module.funcs_and_classes.append(f)

    _compile_struct(
        lang=lang,
        struct=interface.command,
        interface_module=interface_module,
        lookup=lookup,
        metadata_symbol=metadata_symbol,
        stdout_as_string_output=interface.stdout_as_string_output,
        stderr_as_string_output=interface.stderr_as_string_output,
        root_struct=True,
    )

    f = _compile_func_wrapper_root(
        lang,
        interface.command,
        lookup,
        metadata_symbol,
    )
    interface_module.funcs_and_classes.append(f)
