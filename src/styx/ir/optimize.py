import typing
from typing import Generator, Callable, Iterable, NamedTuple

import styx.ir.core as ir

Optimizer = Callable[[ir.App], ir.App]


def _merge_string_tokens(app: ir.App) -> ir.App:
    """Merge neighbouring string literals in Carg tokens."""

    def _iter_cargs() -> Generator[ir.CmdArg, None, None]:
        for param in app.command.iter_params_deep(False):
            if isinstance(param.body, ir.Param.Struct):
                for group in param.body.groups:
                    yield from group.cargs

    for carg in _iter_cargs():
        old_tokens = carg.tokens
        new_tokens: list[ir.Param | str] = []
        for token in old_tokens:
            if len(new_tokens) == 0:
                new_tokens.append(token)
                continue
            if isinstance(token, str) and isinstance(new_tokens[-1], str):
                new_tokens[-1] += token
                continue
            new_tokens.append(token)
        if len(old_tokens) > len(new_tokens):
            carg.tokens = new_tokens

    return app


def _count(i: Iterable) -> int:
    counter = 0
    for _ in i:
        counter += 1
    return counter


def _constant_optional_structs(app: ir.App) -> ir.App:
    """
    All structs that are nullable but themselves don't have any parameters can be converted to bools.
    """

    for struct in app.command.iter_structs_deep():
        if isinstance(struct.parent.body, ir.Param.StructUnion):
            continue
        if not struct.nullable or struct.list_:
            continue
        if _count(struct.iter_params_deep()) != 0:
            continue

        old_body: ir.Param.Struct = struct.body

        value_true = []

        for g in old_body.groups:
            for c in g.cargs:
                arg = ""
                for t in c.tokens:
                    assert isinstance(t, str)  # no params -> all strings
                    arg += t
                value_true.append(arg)

        struct.body = ir.Param.Bool(
            value_true=value_true,
        )

        struct.nullable = False
        struct.default_value = False

    return app


class _ParentLocation(NamedTuple):
    parent: ir.Param[ir.Param.Struct]

    group_idx: int
    group: ir.ConditionalGroup

    cmdarg_idx: int
    cmdarg: ir.CmdArg

    token_idx: int
    token: ir.Param


def _param_parent_location(param: ir.Param) -> _ParentLocation | None:
    if param.parent is None:
        return None
    if isinstance(param.parent.body, ir.Param.StructUnion):
        return None

    for parent_group_idx, parent_group in enumerate(param.parent.body.groups):
        for parent_carg_idx, parent_carg in enumerate(parent_group.cargs):
            for parent_token_idx, parent_token in enumerate(parent_carg.tokens):
                if isinstance(parent_token, str):
                    continue
                if parent_token.base.id_ == param.base.id_:
                    return _ParentLocation(
                        parent=param.parent,
                        group_idx=parent_group_idx,
                        group=parent_group,
                        cmdarg_idx=parent_carg_idx,
                        cmdarg=parent_carg,
                        token_idx=parent_token_idx,
                        token=parent_token,
                    )
    return None


T = typing.TypeVar("T")


def _join_optionals(a: T | None, b: T | None, join: Callable[[T, T], T]) -> T | None:
    if a is None:
        if b is None:
            return None
        return b
    if b is None:
        return a
    return join(a, b)


def _merge_docs(a: ir.Documentation, b: ir.Documentation) -> ir.Documentation:
    return ir.Documentation(
        title=_join_optionals(a.title, b.title, lambda x, y: x if x == y else f"{x}: {y}"),
        description=_join_optionals(a.description, b.description, lambda x, y: x if x == y else f"{x}\n\n{y}"),
        authors=_join_optionals(a.authors, b.authors, lambda x, y: x + y),
        literature=_join_optionals(a.literature, b.literature, lambda x, y: x + y),
        urls=_join_optionals(a.urls, b.urls, lambda x, y: x + y),
    )


def _flatten_single_param_structs_into_groups(app: ir.App) -> ir.App:
    """
    If a subcommand has a single param it should be merged into the parent.
    If both are nullable this does not always work.

    Quite tricky - Really hope to never have to touch this again.
    """

    needs_rerun = True
    while needs_rerun:
        needs_rerun = False
        for struct in app.command.iter_structs_deep():
            if isinstance(struct.parent.body, ir.Param.StructUnion):
                continue
            if struct.list_:
                continue
            if _count(struct.body.iter_params_shallow()) != 1:
                continue
            single_param = struct.body.iter_params_shallow().__next__()
            if struct.nullable and single_param.nullable:
                continue

            location = _param_parent_location(struct)
            assert location is not None

            if struct.nullable:
                # merge all groups and use a single group with the param now nullable

                single_param.nullable = True
                single_param.default_value = ir.Param.SetToNone
                new_cargs: list[ir.CmdArg] = []
                for g in struct.body.groups:
                    for cmdarg in g.cargs:
                        new_cargs.append(cmdarg)
                struct.body.groups = [ir.ConditionalGroup(cargs=new_cargs)]
                # todo: handle joins?

            single_param.base.docs = _merge_docs(struct.base.docs, single_param.base.docs)

            # replace the cmdarg containing the struct with all cmdargs from the struct
            # get all structs cmdargs (after flattening if nullable)
            struct_cmdargs = []
            for g in struct.body.groups:
                struct_cmdargs.extend(g.cargs)

            # build new cmdargs list: before + struct's cmdargs + after
            new_cargs = (
                location.group.cargs[: location.cmdarg_idx]  # cmdargs before the one with struct
                + struct_cmdargs  # all cmdargs from inside the struct
                + location.group.cargs[(location.cmdarg_idx + 1) :]  # cmdargs after
            )

            # replace the group with the new cmdargs
            new_groups = (
                location.parent.body.groups[: location.group_idx]
                + [ir.ConditionalGroup(cargs=new_cargs, join=location.group.join)]  # preserve join
                + location.parent.body.groups[(location.group_idx + 1) :]
            )

            location.parent.body.groups = new_groups

            app.command.setup_parent_references()
            needs_rerun = True
            break

    return app


_truthy = {
    "true",
    "1",
    "yes",
    "y",
    "on",
    "enabled",
    "enable",
    "ok",
    "okay",
    "active",
    "accept",
    "accepted",
    "confirm",
    "confirmed",
}

_falsy = {
    "false",
    "0",
    "no",
    "n",
    "off",
    "disabled",
    "disable",
    "none",
    "null",
    "nil",
    "",
    "empty",
    "nope",
    "nah",
    "negative",
    "inactive",
    "deny",
    "denied",
    "reject",
    "rejected",
    "cancel",
    "cancelled",
}


def _truthy_choices(app: ir.App) -> ir.App:
    for param in app.command.iter_params_deep():
        if param.choices is None or len(param.choices) != 2:
            continue

        choice1, choice2 = param.choices

        if isinstance(param.body, ir.Param.String):
            choice1_lower = choice1.lower()
            choice2_lower = choice2.lower()

            choice1_truthy = choice1_lower in _truthy
            choice2_truthy = choice2_lower in _truthy
            choice1_falsy = choice1_lower in _falsy
            choice2_falsy = choice2_lower in _falsy

            if choice1_truthy and choice2_falsy:
                param.body = ir.Param.Bool(
                    value_true=[choice1],
                    value_false=[choice2],
                )
                param.choices = None
            elif choice2_truthy and choice1_falsy:
                param.body = ir.Param.Bool(
                    value_true=[choice2],
                    value_false=[choice1],
                )
                param.choices = None

        elif isinstance(param.body, ir.Param.Int):
            choice1_truthy = choice1 == 1
            choice2_truthy = choice2 == 1
            choice1_falsy = choice1 == 0
            choice2_falsy = choice2 == 0

            if choice1_truthy and choice2_falsy:
                param.body = ir.Param.Bool(
                    value_true=[str(choice1)],
                    value_false=[str(choice2)],
                )
                param.choices = None
            elif choice2_truthy and choice1_falsy:
                param.body = ir.Param.Bool(
                    value_true=[str(choice2)],
                    value_false=[str(choice1)],
                )
                param.choices = None

    return app


def optimize(app: ir.App) -> ir.App:
    """Simplify IR without changing generated command."""

    app.command.setup_parent_references()

    _optimizers: list[Optimizer] = [
        _merge_string_tokens,
        _constant_optional_structs,
        _flatten_single_param_structs_into_groups,
        _truthy_choices,
    ]

    for optimizer in _optimizers:
        app = optimizer(app)

    return app
