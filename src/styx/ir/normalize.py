import styx.ir.core as ir


def normalize(interface: ir.App) -> ir.App:
    """Normalize IR.

    Ensures unique struct names.
    Ensures unique parameter names within each struct.
    """
    struct_names = set()
    for struct in interface.command.iter_structs_deep(False):
        while struct.body.name in struct_names:
            name_parts = struct.body.name.rsplit("_", 1)
            if len(name_parts) == 2 and name_parts[1].isdigit():
                new_name = f"{name_parts[0]}_{int(name_parts[1]) + 1}"
            else:
                new_name = f"{struct.body.name}_1"
            struct.body.name = new_name
        struct_names.add(struct.body.name)

        param_names = set()
        for param in struct.body.iter_params_shallow():
            while param.base.name in param_names:
                name_parts = param.base.name.rsplit("_", 1)
                if len(name_parts) == 2 and name_parts[1].isdigit():
                    new_name = f"{name_parts[0]}_{int(name_parts[1]) + 1}"
                else:
                    new_name = f"{param.base.name}_1"
                param.base.name = new_name
            param_names.add(param.base.name)
    return interface
