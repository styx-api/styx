import styx.ir.core as ir


def _expr_counter(expr: ir.Param) -> int:
    if isinstance(expr.body, ir.Param.Struct):
        return 1 + sum([_expr_counter(e) for e in expr.body.iter_params_shallow()])
    if isinstance(expr.body, ir.Param.StructUnion):
        return 1 + sum([_expr_counter(e) for e in expr.body.alts])
    return 1


def _param_counter(expr: ir.Param) -> int:
    if isinstance(expr.body, ir.Param.Struct):
        return sum([_param_counter(e) for e in expr.body.iter_params_shallow()])
    if isinstance(expr.body, ir.Param.StructUnion):
        return sum([_param_counter(e) for e in expr.body.alts])
    return 1


def _mccabe(expr: ir.Param) -> int:
    complexity = 1

    if expr.nullable or (isinstance(expr.body, (ir.Param.Struct, ir.Param.StructUnion)) and expr.list_):
        complexity = 2

    match expr.body:
        case ir.Param.Struct():
            x = [_mccabe(e) for e in expr.body.iter_params_shallow()]
            return complexity * (sum(x) - len(x) + 1)
        case ir.Param.StructUnion():
            return complexity * sum([_mccabe(e) for e in expr.body.alts])
    return complexity


def stats(interface: ir.App) -> dict[str, str | int | float]:
    return {
        "name": interface.command.base.name,
        "num_expressions": _expr_counter(interface.command),
        "num_params": _param_counter(interface.command),
        "mccabe": _mccabe(interface.command),
    }
