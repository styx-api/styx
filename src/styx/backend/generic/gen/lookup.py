from dataclasses import dataclass, field
import styx.ir.core as ir
from styx.backend.generic.languageprovider import LanguageProvider
from styx.backend.generic.scope import Scope

SymbolType = str


@dataclass
class SymbolLUT:
    """Symbol lookup table for code generation."""

    # Root-exclusive symbols

    obj_metadata: SymbolType
    """Static metadata table, public"""

    fn_root_make_params_and_execute: SymbolType
    """Main entrypoint (combines `fn_root_make_params` + `fn_root_execute` for: native arguments -> outputs object)"""

    # Also may exist for sub-structs but guaranteed for root

    fn_root_execute: SymbolType
    """Execute function (params -> outputs object, also executes runner as side effect)"""

    type_root_params: SymbolType
    """Root parameter struct type"""

    type_root_params_tagged: SymbolType
    """Root parameter struct type with tagged unions"""

    fn_root_make_params: SymbolType
    """Function to build root parameters from native arguments"""

    fn_root_make_cmdargs: SymbolType
    """Function to build command line arguments from parameters"""

    type_root_outputs: SymbolType
    """Root outputs struct type"""

    fn_root_make_outputs: SymbolType
    """Function to build outputs from execution results"""

    fn_root_validate_params: SymbolType
    """Function to validate root parameters object"""

    # Struct mappings

    type_struct_params: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Parameter struct types by struct ID. IStruct.id_ -> Language type"""

    type_struct_params_tagged: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Parameter struct types by struct ID. IStruct.id_ -> Language type"""

    type_struct_outputs: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Find outputs class name by struct param ID. IStruct.id_ -> Language class name"""

    # Struct -> function mappings

    fn_struct_make_params: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Function to build parameters for each struct. IStruct.id_ -> Language function symbol"""

    fn_struct_make_cmdargs: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Function to build command args for each struct. IStruct.id_ -> Language function symbol"""

    fn_struct_make_outputs: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Function to build outputs for each struct. IStruct.id_ -> Language function symbol"""

    fn_struct_execute: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Execute function for each struct. IStruct.id_ -> Language function symbol"""

    fn_struct_validate_params: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Param validation function for each struct. IStruct.id_ -> Language function symbol"""

    # Dynamic lookup functions for unions

    fn_dyn_union_fn_struct_make_cmdargs: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """StructUnion ID -> function which dynamically grabs the appropriate `fn_struct_make_cmdargs` based on tagged param passed in union field."""

    fn_dyn_union_fn_struct_make_outputs: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """StructUnion ID -> function which dynamically grabs the appropriate `fn_struct_make_outputs` based on tagged param passed in union field."""

    fn_dyn_union_fn_struct_validate_params: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """StructUnion ID -> function which dynamically grabs the appropriate `fn_struct_validate_params` based on tagged param passed in union field."""

    # For each param

    param_by_id: dict[ir.IdType, ir.Param] = field(default_factory=dict)
    """Find param object by its ID. Param ID -> Param"""

    type_param: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Find Language type by param id. Param ID -> Language type"""

    var_param: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Find function-parameter symbol by param ID. IParam.id_ -> Language symbol"""

    var_output: dict[ir.IdType, SymbolType] = field(default_factory=dict)
    """Find output field symbol by output ID. Output ID -> Language symbol"""

    @classmethod
    def create(
        cls,
        lang: LanguageProvider,
        app: ir.App,
        package_scope: Scope,
    ) -> "SymbolLUT":
        """Factory method to create a SymbolLUT from an IR App."""
        app.assert_set_up()

        function_scope = Scope(lang).language_base_scope()
        function_scope.add_or_die("runner")
        function_scope.add_or_die("execution")
        function_scope.add_or_die("cargs")
        function_scope.add_or_die("ret")
        function_scope.add_or_die("params")

        # Create instance with empty dicts
        instance = cls(
            obj_metadata=package_scope.add_or_dodge(lang.metadata_symbol(app.command.base.name)),
            fn_root_execute=package_scope.add_or_dodge(lang.symbol_var_case_from(app.command.body.name + "_execute")),
            fn_root_make_params_and_execute=package_scope.add_or_dodge(
                lang.symbol_var_case_from(app.command.base.name)
            ),
            type_root_params=package_scope.add_or_dodge(
                lang.symbol_class_case_from(app.command.body.name + "_Parameters")
            ),
            type_root_params_tagged=package_scope.add_or_dodge(
                lang.symbol_class_case_from(app.command.body.name + "_ParametersTagged")
            ),
            fn_root_make_params=package_scope.add_or_dodge(
                lang.symbol_var_case_from(app.command.body.name + "_params")
            ),
            fn_root_make_cmdargs=package_scope.add_or_dodge(
                lang.symbol_var_case_from(app.command.body.name + "_cargs")
            ),
            type_root_outputs=package_scope.add_or_dodge(
                lang.symbol_class_case_from(f"{app.command.body.name}_Outputs")
            ),
            fn_root_make_outputs=package_scope.add_or_dodge(
                lang.symbol_var_case_from(app.command.body.name + "_outputs")
            ),
            fn_root_validate_params=package_scope.add_or_dodge(
                lang.symbol_var_case_from(app.command.body.name + "_validate")
            ),
        )

        def _collect_output_field_symbols(
            param: ir.Param[ir.Param.Struct],
        ) -> None:
            scope = Scope(parent=package_scope)
            scope.add_or_die("root")

            for capture_stream in (app.capture_stdout, app.capture_stderr):
                if capture_stream is None:
                    continue
                output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(capture_stream.name))
                assert capture_stream.id_ not in instance.var_output
                instance.var_output[capture_stream.id_] = output_field_symbol

            for output in param.base.outputs:
                output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(output.name))
                assert output.id_ not in instance.var_output
                instance.var_output[output.id_] = output_field_symbol

            for sub_struct in param.body.iter_params_shallow():
                if isinstance(sub_struct.body, (ir.Param.Struct, ir.Param.StructUnion)):
                    output_field_symbol = scope.add_or_dodge(lang.symbol_var_case_from(sub_struct.base.name))
                    assert sub_struct.base.id_ not in instance.var_output
                    instance.var_output[sub_struct.base.id_] = output_field_symbol

        def _collect_param_alias_symbol(param: ir.Param[ir.Param.Struct]) -> None:
            scope = Scope(parent=function_scope)
            for elem in param.body.iter_params_shallow():
                symbol = scope.add_or_dodge(lang.symbol_var_case_from(elem.base.name))
                assert elem.base.id_ not in instance.var_param
                instance.var_param[elem.base.id_] = symbol

        # Initialize with command
        instance.param_by_id[app.command.base.id_] = app.command
        instance.type_param[app.command.base.id_] = instance.type_root_params

        scope = Scope(parent=package_scope)

        # Process the command struct
        instance.type_struct_params[app.command.base.id_] = instance.type_root_params
        instance.type_struct_params_tagged[app.command.base.id_] = instance.type_root_params_tagged
        instance.fn_struct_make_params[app.command.base.id_] = instance.fn_root_make_params
        instance.fn_struct_make_cmdargs[app.command.base.id_] = instance.fn_root_make_cmdargs
        instance.fn_struct_make_outputs[app.command.base.id_] = instance.fn_root_make_outputs
        instance.fn_struct_execute[app.command.base.id_] = instance.fn_root_execute
        instance.type_struct_outputs[app.command.base.id_] = instance.type_root_outputs
        instance.fn_struct_validate_params[app.command.base.id_] = instance.fn_root_validate_params

        # Process nested structs
        for struct in app.command.iter_structs_deep():
            instance.type_struct_params[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_class_case_from(f"{app.command.body.name}_{struct.body.name}_Parameters")
            )
            instance.type_struct_params_tagged[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_class_case_from(f"{app.command.body.name}_{struct.body.name}_ParametersTagged")
            )
            instance.fn_struct_make_params[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{app.command.body.name}_{struct.body.name}_params")
            )
            instance.fn_struct_make_cmdargs[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{app.command.body.name}_{struct.body.name}_cargs")
            )
            instance.fn_struct_make_outputs[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{app.command.body.name}_{struct.body.name}_outputs")
            )
            instance.fn_struct_execute[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{app.command.body.name}_{struct.body.name}_execute")
            )
            instance.type_struct_outputs[struct.base.id_] = package_scope.add_or_dodge(
                lang.symbol_class_case_from(f"{app.command.body.name}_{struct.body.name}_Outputs")
            )
            instance.fn_struct_validate_params[struct.base.id_] = scope.add_or_dodge(
                lang.symbol_var_case_from(f"{app.command.body.name}_{struct.body.name}_validate")
            )

        # Collect symbols for the root command
        _collect_param_alias_symbol(app.command)
        _collect_output_field_symbols(app.command)

        # Process all parameters
        for elem in app.command.iter_params_deep():
            instance.param_by_id[elem.base.id_] = elem

            if isinstance(elem.body, ir.Param.Struct):
                instance.type_param[elem.base.id_] = lang.type_param(
                    elem, instance.type_struct_params, instance.type_struct_params_tagged
                )
                _collect_param_alias_symbol(elem)
                _collect_output_field_symbols(elem)
            elif isinstance(elem.body, ir.Param.StructUnion):
                for alternative in elem.body.alts:
                    instance.type_param[alternative.base.id_] = lang.type_param(
                        alternative, instance.type_struct_params, instance.type_struct_params_tagged
                    )

                # Union dynamic function lookup tables
                instance.fn_dyn_union_fn_struct_make_outputs[elem.base.id_] = scope.add_or_dodge(
                    lang.symbol_var_case_from(f"{app.command.body.name}_{elem.base.name}_outputs_dyn_fn")
                )
                instance.fn_dyn_union_fn_struct_make_cmdargs[elem.base.id_] = scope.add_or_dodge(
                    lang.symbol_var_case_from(f"{app.command.body.name}_{elem.base.name}_cargs_dyn_fn")
                )
                instance.fn_dyn_union_fn_struct_validate_params[elem.base.id_] = scope.add_or_dodge(
                    lang.symbol_var_case_from(f"{app.command.body.name}_{elem.base.name}_validate_dyn_fn")
                )

                instance.type_param[elem.base.id_] = lang.type_param(
                    elem, instance.type_struct_params, instance.type_struct_params_tagged
                )
            else:
                instance.type_param[elem.base.id_] = lang.type_param(
                    elem, instance.type_struct_params, instance.type_struct_params_tagged
                )

        return instance

    def symbol_map(self) -> dict:
        first_node = self.param_by_id.items().__iter__().__next__()
        assert first_node is not None, "No params defined"
        root = first_node[1].get_root()

        def _process_param(param: ir.Param):
            out = {}
            for child in param.body.iter_params_shallow():
                p = {}

                p["var_param"] = self.var_param[child.base.id_]

                if isinstance(child.body, ir.Param.Struct):
                    p["fn_struct_make_params"] = self.fn_struct_make_params.get(child.base.id_)
                    p["properties"] = _process_param(child)

                if isinstance(child.body, ir.Param.StructUnion):
                    p["variants"] = {
                        alt.body.public_name: {
                            "fn_struct_make_params": self.fn_struct_make_params.get(alt.base.id_),
                            "properties": _process_param(alt),
                        }
                        for alt in child.body.alts
                    }

                out[child.base.name] = p
            return out

        return {
            "fn_root_make_params_and_execute": self.fn_root_make_params_and_execute,
            "properties": _process_param(root),
        }

        # for param in self.param_by_id.items().__iter__().__next__()[1].get_root().iter_params_deep(False):
        #    path = ".".join([x.base.name.replace(".", "..") for x in param.get_full_path()])
        #    print(path)
