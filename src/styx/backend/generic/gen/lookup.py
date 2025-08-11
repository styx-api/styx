import styx.ir.core as ir
from styx.backend.generic.languageprovider import LanguageProvider
from styx.backend.generic.scope import Scope


class LookupParam:
    """Pre-compute and store symbols, types, class-names, etc. to reduce spaghetti code everywhere else."""

    def __init__(
        self,
        lang: LanguageProvider,
        interface: ir.Interface,
        package_scope: Scope,
        function_symbol: str,
        function_scope: Scope,
    ) -> None:
        def _collect_output_field_symbols(
            param: ir.Param[ir.Param.Struct],
        ) -> None:
            scope = Scope(parent=package_scope)
            scope.add_or_die("root")

            for stdout_stderr_output in (interface.stdout_as_string_output, interface.stderr_as_string_output):
                if stdout_stderr_output is None:
                    continue
                output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(stdout_stderr_output.name))
                assert stdout_stderr_output.id_ not in self.expr_output_field_symbol
                self.expr_output_field_symbol[stdout_stderr_output.id_] = output_field_symbol

            for output in param.base.outputs:
                output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(output.name))
                assert output.id_ not in self.expr_output_field_symbol
                self.expr_output_field_symbol[output.id_] = output_field_symbol

            for sub_struct in param.body.iter_params():
                if isinstance(sub_struct.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(sub_struct.base.name))
                    assert sub_struct.base.id_ not in self.expr_output_field_symbol
                    self.expr_output_field_symbol[sub_struct.base.id_] = output_field_symbol

        def _collect_param_alias_symbol(param: ir.Param[ir.Param.Struct]) -> None:
            scope = Scope(parent=function_scope)
            for elem in param.body.iter_params():
                symbol = scope.add_or_dodge(lang.symbol_var_case_from(elem.base.name))
                assert elem.base.id_ not in self.expr_param_symbol_alias
                self.expr_param_symbol_alias[elem.base.id_] = symbol

        self.param: dict[ir.IdType, ir.Param] = {interface.command.base.id_: interface.command}
        """Find param object by its ID. IParam.id_ -> IParam"""
        self.expr_params_dict_type: dict[ir.IdType, str] = {}
        """Parameter dict types."""
        self.expr_param_type: dict[ir.IdType, str] = {interface.command.base.id_: function_symbol}
        """Find Language type by param id. IParam.id_ -> Language type"""
        self.expr_param_symbol_alias: dict[ir.IdType, str] = {}
        """Find function-parameter symbol by param ID. IParam.id_ -> Language symbol"""
        self.expr_struct_output_type: dict[ir.IdType, str] = {}
        """Find outputs class name by struct param ID. IStruct.id_ -> Language class name"""
        self.expr_output_field_symbol: dict[ir.IdType, str] = {}
        """Find output field symbol by output ID. Output.id_ -> Language symbol"""

        self.expr_struct_global_name: dict[ir.IdType, str] = interface.get_global_name_lookup()
        """Find struct global name. 
        
        This is the @type.
        This name should uniquely identify a struct across commands and packages.
        (i.e. "{package_name}.{command}.{sub-command}"). 
        IStruct.id_ -> Global name
        """

        self.expr_func_build_params: dict[ir.IdType, str] = {}
        self.expr_func_build_cargs: dict[ir.IdType, str] = {}
        self.expr_func_build_outputs: dict[ir.IdType, str] = {}
        self.expr_func_execute: dict[ir.IdType, str] = {}

        scope = Scope(parent=package_scope)

        struct = interface.command
        self.expr_params_dict_type[struct.base.id_] = scope.add_or_dodge(
            lang.symbol_class_case_from(struct.body.name + "_Parameters")
        )
        self.expr_func_build_params[struct.base.id_] = scope.add_or_dodge(
            lang.symbol_var_case_from(struct.body.name + "_params")
        )
        self.expr_func_build_cargs[struct.base.id_] = scope.add_or_dodge(
            lang.symbol_var_case_from(struct.body.name + "_cargs")
        )
        self.expr_func_build_outputs[struct.base.id_] = scope.add_or_dodge(
            lang.symbol_var_case_from(struct.body.name + "_outputs")
        )
        self.expr_func_execute[struct.base.id_] = scope.add_or_dodge(
            lang.symbol_var_case_from(struct.body.name + "_execute")
        )
        self.expr_struct_output_type[struct.base.id_] = package_scope.add_or_dodge(
            lang.symbol_class_case_from(f"{struct.body.name}_Outputs")
        )
        for struct in interface.command.iter_structs_recursively():
            self.expr_params_dict_type[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_class_case_from(f"{interface.command.body.name}_{struct.body.name}_Parameters")
            )
            self.expr_func_build_params[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{interface.command.body.name}_{struct.body.name}_params")
            )
            self.expr_func_build_cargs[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{interface.command.body.name}_{struct.body.name}_cargs")
            )
            self.expr_func_build_outputs[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{interface.command.body.name}_{struct.body.name}_outputs")
            )
            self.expr_func_execute[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{interface.command.body.name}_{struct.body.name}_execute")
            )
            self.expr_struct_output_type[struct.base.id_] = package_scope.add_or_dodge(
                lang.symbol_class_case_from(f"{interface.command.body.name}_{struct.body.name}_Outputs")
            )

        _collect_param_alias_symbol(
            param=interface.command,
        )
        _collect_output_field_symbols(
            param=interface.command,
        )

        for elem in interface.command.iter_params_recursively():
            self.param[elem.base.id_] = elem

            if isinstance(elem.body, ir.Param.Struct):
                self.expr_param_type[elem.base.id_] = lang.type_param(elem, self.expr_params_dict_type)

                _collect_param_alias_symbol(
                    param=elem,
                )
                _collect_output_field_symbols(
                    param=elem,
                )
            elif isinstance(elem.body, ir.Param.StructUnion):
                for alternative in elem.body.alts:
                    self.expr_param_type[alternative.base.id_] = lang.type_param(
                        alternative, self.expr_params_dict_type
                    )
                self.expr_param_type[elem.base.id_] = lang.type_param(elem, self.expr_params_dict_type)
            else:
                self.expr_param_type[elem.base.id_] = lang.type_param(elem, self.expr_params_dict_type)
