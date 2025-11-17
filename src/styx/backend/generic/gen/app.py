from typing import NamedTuple

import styx.ir.core as ir
from styx.backend.generic.documentation import docs_to_docstring
from styx.backend.generic.gen.lookup import SymbolLUT
from styx.backend.generic.gen.metadata import generate_static_metadata
from styx.backend.generic.languageprovider import LanguageProvider, MStr
from styx.backend.generic.linebuffer import LineBuffer, blank_before, indent
from styx.backend.generic.model import GenericArg, GenericFunc, GenericModule, GenericStructure
from styx.backend.generic.scope import Scope
from styx.backend.generic.utils import enquote


def _compile_build_params(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lookup: SymbolLUT,
) -> GenericFunc:
    func = GenericFunc(
        name=lookup.fn_struct_make_params[param.base.id_],
        docstring_body="Build parameters.",
        return_type=lookup.type_struct_params_tagged[param.base.id_],
        return_descr="Parameter dictionary",
        args=[],
    )

    for p in param.body.iter_params_shallow():
        symbol = lookup.var_param[p.base.id_]
        func.args.append(
            GenericArg(
                name=symbol,
                type=lookup.type_param[p.base.id_],
                default=lang.param_default_value(p),
                docstring=p.base.docs.description,
            )
        )

    params_symbol = "params"

    param_items = [(p, lookup.var_param[p.base.id_]) for p in param.body.iter_params_shallow() if not p.nullable]
    func.body.extend(lang.param_dict_create(lookup, params_symbol, param, param_items))

    for p in param.body.iter_params_shallow():
        if not p.nullable:
            continue
        if (param_is_set_expr := lang.param_var_is_set_by_user(p, lookup.var_param[p.base.id_], False)) is not None:
            func.body.extend(
                lang.if_else_block(
                    param_is_set_expr,
                    [*lang.param_dict_set(params_symbol, p, lookup.var_param[p.base.id_])],
                )
            )

    func.body.append(lang.return_statement(params_symbol))

    return func


def _compile_param_dict_type(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lut: SymbolLUT,
) -> list[str]:
    return lang.param_dict_type_declare(lut, param)


def _compile_build_cargs(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lut: SymbolLUT,
) -> GenericFunc:
    func = GenericFunc(
        name=lut.fn_struct_make_cmdargs[param.base.id_],
        docstring_body="Build command-line arguments from parameters.",
        return_type=lang.type_string_list(),
        return_descr="Command-line arguments.",
        args=[
            GenericArg(
                name="params",
                type=lut.type_struct_params[param.base.id_],
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
                elem_symbol = lang.param_dict_get_or_default(
                    "params",
                    token,
                    lang.expr_null()
                    if token.default_value == ir.Param.SetToNone
                    else lang.expr_literal(token.default_value),
                )  # todo: only on undefined not on null - this will need a change in the system
                param_as_mstr = lang.param_var_to_mstr(lut, token, elem_symbol)
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
    module_app: GenericModule,
    lookup: SymbolLUT,
    capture_stdout: ir.StreamOutput | None = None,
    capture_stderr: ir.StreamOutput | None = None,
) -> None:
    outputs_class: GenericStructure = GenericStructure(
        name=lookup.type_struct_outputs[struct.base.id_],
        docstring=f"Output object returned when calling `{lookup.type_param[struct.base.id_]}(...)`.",
    )
    outputs_class.fields.append(
        GenericArg(
            name="root",
            type="OutputPathType",
            default=None,
            docstring="Output root folder. This is the root folder for all outputs.",
        )
    )

    for stdout_stderr_output in (capture_stdout, capture_stderr):
        if stdout_stderr_output is None:
            continue
        outputs_class.fields.append(
            GenericArg(
                name=lookup.var_output[stdout_stderr_output.id_],
                type=lang.type_string_list(),
                default=None,
                docstring=stdout_stderr_output.docs.description,
            )
        )

    for output in struct.base.outputs:
        output_symbol = lookup.var_output[output.id_]

        # Optional if any of its param references is optional
        optional = False
        for token in output.tokens:
            if isinstance(token, str):
                continue
            optional = optional or lookup.param_by_id[token.ref_id].nullable

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

    for sub_struct in struct.body.iter_params_shallow():
        if isinstance(sub_struct.body, ir.Param.Struct):
            if sub_struct.has_outputs_deep():
                output_type = lookup.type_struct_outputs[sub_struct.base.id_]
                if sub_struct.list_:
                    output_type = lang.type_list(output_type)
                if sub_struct.nullable:
                    output_type = lang.type_optional(output_type)

                output_symbol = lookup.var_output[sub_struct.base.id_]

                input_type = lookup.fn_struct_make_outputs[sub_struct.base.id_]
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
            if any([s.has_outputs_deep() for s in sub_struct.body.alts]):
                alt_types = [
                    lookup.type_struct_outputs[sub_command.base.id_]
                    for sub_command in sub_struct.body.alts
                    if sub_command.has_outputs_deep()
                ]
                if len(alt_types) > 0:
                    output_type = lang.type_union(alt_types)

                    if sub_struct.list_:
                        output_type = lang.type_list(output_type)
                    if sub_struct.nullable:
                        output_type = lang.type_optional(output_type)

                    output_symbol = lookup.var_output[sub_struct.base.id_]

                    alt_input_types = [
                        lookup.type_struct_params[sub_command.base.id_]
                        for sub_command in sub_struct.body.alts
                        if sub_command.has_outputs_deep()
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

    module_app.funcs_and_classes.append(outputs_class)
    module_app.exports.append(outputs_class.name)


def _compile_func_build_outputs(
    lang: LanguageProvider,
    param: ir.Param[ir.Param.Struct],
    lut: SymbolLUT,
    stdout_as_string_output: ir.StreamOutput | None = None,
    stderr_as_string_output: ir.StreamOutput | None = None,
) -> GenericFunc:
    """Generate the outputs building code."""
    func = GenericFunc(
        name=lut.fn_struct_make_outputs[param.base.id_],
        docstring_body="Build outputs object containing output file paths and possibly stdout/stderr.",
        return_type=lut.type_struct_outputs[param.base.id_],
        return_descr="Outputs object.",
        args=[
            GenericArg(
                name="params",
                type=lut.type_struct_params[param.base.id_],
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
        p = lut.param_by_id[output_param_reference.ref_id]
        if output_param_reference.fallback is None:
            symbol = lang.param_dict_get_or_default(
                "params", p, lang.expr_literal(None if p.default_value == ir.Param.SetToNone else p.default_value)
            )  # todo default needs to be properly handled
        else:
            symbol = lang.param_dict_get_or_default("params", p, lang.expr_str(output_param_reference.fallback))

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
        output_symbol = lut.var_output[stdout_stderr_output.id_]

        members[output_symbol] = lang.expr_list([])

    for output in param.base.outputs:
        output_symbol = lut.var_output[output.id_]

        output_segments: list[str] = []
        conditions = []
        for token in output.tokens:
            if isinstance(token, str):
                output_segments.append(lang.expr_literal(token))
                continue
            output_segments.append(_py_get_val(token))

            ostruct = lut.param_by_id[token.ref_id]

            param_symbol = lang.param_dict_get_or_null("params", ostruct)
            if (
                py_var_is_set_by_user := lang.param_var_is_set_by_user(ostruct, param_symbol, False)
            ) is not None and token.fallback is None:
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
    for sub_struct in param.body.iter_params_shallow():
        has_outputs = False
        if isinstance(sub_struct.body, ir.Param.Struct):
            has_outputs = sub_struct.has_outputs_deep()
        elif isinstance(sub_struct.body, ir.Param.StructUnion):
            has_outputs = any([s.has_outputs_deep() for s in sub_struct.body.alts])
        if not has_outputs:
            continue

        output_symbol = lut.var_output[sub_struct.base.id_]
        output_symbol_resolved = lang.param_dict_get_or_null("params", sub_struct)

        members[output_symbol] = lang.struct_collect_outputs(lut, sub_struct, output_symbol_resolved)

    lang.generate_ret_object_creation(
        buf=func.body,
        execution_symbol="execution",
        output_type=lut.type_struct_outputs[param.base.id_],
        members=members,
    )
    func.body.append(lang.return_statement("ret"))

    return func


def _compile_func_execute(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    lut: SymbolLUT,
    stdout_as_string_output: ir.StreamOutput | None = None,
    stderr_as_string_output: ir.StreamOutput | None = None,
) -> GenericFunc:
    outputs_type = lut.type_struct_outputs[struct.base.id_]

    func = GenericFunc(
        name=lut.fn_struct_execute[struct.base.id_],
        return_type=outputs_type,
        return_descr=f"NamedTuple of outputs (described in `{outputs_type}`).",  # todo
        docstring_body=docs_to_docstring(struct.base.docs),
        args=[
            GenericArg(
                name="params",
                type=lut.type_struct_params[struct.base.id_],
                default=None,
                docstring="The parameters.",
            ),
            GenericArg(
                name="runner",
                type=lang.type_optional(lang.type_runner()),
                default=lang.expr_null(),
                docstring="Command runner",
            ),
        ],
    )

    func.body.extend([
        *(lang.call_validate_params(lut, "params") if lang.does_validate() else []),
        *lang.runner_declare("runner"),
        *lang.execution_declare("execution", lut.obj_metadata),
        *lang.execution_process_params("execution", "params"),
        *lang.call_build_cargs(lut, struct, "params", "execution", "cargs"),
        *lang.call_build_outputs(lut, struct, "params", "execution", "ret"),
        *lang.execution_run(
            execution_symbol="execution",
            cargs_symbol="cargs",
            stdout_output_symbol=lut.var_output[stdout_as_string_output.id_] if stdout_as_string_output else None,
            stderr_output_symbol=lut.var_output[stderr_as_string_output.id_] if stderr_as_string_output else None,
        ),
        lang.return_statement("ret"),
    ])
    return func


# this is basically _params + _execute
def _compile_func_wrapper_root(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    lut: SymbolLUT,
) -> GenericFunc:
    outputs_type = lut.type_struct_outputs[struct.base.id_]

    func = GenericFunc(
        name=lut.fn_root_make_params_and_execute,
        return_type=outputs_type,
        return_descr=f"NamedTuple of outputs (described in `{outputs_type}`).",
        docstring_body=docs_to_docstring(struct.base.docs),
    )

    pyargs = func.args

    # Collect param python symbols
    for elem in struct.body.iter_params_shallow():
        symbol = lut.var_param[elem.base.id_]
        pyargs.append(
            GenericArg(
                name=symbol,
                type=lut.type_param[elem.base.id_],
                default=lang.param_default_value(elem),
                docstring=elem.base.docs.description,
            )
        )
    func.body.extend(lang.build_params_and_execute(lut, struct, "runner"))

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
    app: ir.App,
    lookup: SymbolLUT,
    module_app: GenericModule,
):
    for union in app.command.iter_unions_deep():
        for f in lang.dyn_declare(lookup, union):
            module_app.funcs_and_classes.append(f)


def _compile_struct(
    lang: LanguageProvider,
    struct: ir.Param[ir.Param.Struct],
    module_app: GenericModule,
    lut: SymbolLUT,
    capture_stdout: ir.StreamOutput | None = None,
    capture_stderr: ir.StreamOutput | None = None,
) -> None:
    for child in struct.body.iter_params_shallow():
        if isinstance(child.body, ir.Param.Struct):
            _compile_struct(
                lang=lang,
                struct=child,
                module_app=module_app,
                lut=lut,
            )
        elif isinstance(child.body, child.StructUnion):
            for e in child.body.alts:
                _compile_struct(
                    lang=lang,
                    struct=e,
                    module_app=module_app,
                    lut=lut,
                )

    if struct.is_root() or struct.has_outputs_deep():
        _compile_outputs_class(lang, struct, module_app, lut, capture_stdout, capture_stderr)

    f = _compile_build_params(lang, struct, lut)
    module_app.funcs_and_classes.append(f)
    module_app.exports.append(f.name)

    module_app.header.extend(blank_before(_compile_param_dict_type(lang, struct, lut), 2))
    # module_app.exports.append(lut.type_struct_params[struct.base.id_])

    if lang.does_validate():
        f = lang.build_fn_validate_params(struct, lut)
        assert f, "Language provider claims to produce validation functions but returned none"
        module_app.funcs_and_classes.append(f)

    f = _compile_build_cargs(lang, struct, lut)
    module_app.funcs_and_classes.append(f)
    # module_app.exports.append(f.name)

    if struct.is_root() or struct.has_outputs_deep():
        f = _compile_func_build_outputs(lang, struct, lut, capture_stdout, capture_stderr)
        module_app.funcs_and_classes.append(f)
        # module_app.exports.append(f.name)

    if struct.is_root():
        f = _compile_func_execute(lang, struct, lut, capture_stdout, capture_stderr)
        module_app.funcs_and_classes.append(f)
        module_app.exports.append(f.name)


def compile_app(
    lang: LanguageProvider,
    package: ir.Package,
    app: ir.App,
    package_scope: Scope,
    module_app: GenericModule,
) -> SymbolLUT:
    """Entry point to the language backend."""
    app.setup(package.name)

    lut = SymbolLUT.create(
        lang=lang,
        app=app,
        package_scope=package_scope,
    )

    module_app.imports.extend(lang.wrapper_module_imports())

    generate_static_metadata(
        lang=lang,
        module=module_app,
        lut=lut,
        package=package,
        app=app,
    )
    module_app.exports.append(lut.obj_metadata)

    _compile_lookups(lang, app, lut, module_app)

    _compile_struct(
        lang=lang,
        struct=app.command,
        module_app=module_app,
        lut=lut,
        capture_stdout=app.capture_stdout,
        capture_stderr=app.capture_stderr,
    )

    f = _compile_func_wrapper_root(
        lang=lang,
        struct=app.command,
        lut=lut,
    )
    module_app.funcs_and_classes.append(f)
    module_app.exports.append(f.name)

    return lut
