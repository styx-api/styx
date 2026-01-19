from dataclasses import dataclass
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

    def find_and_convert() -> bool:
        """Find and convert one struct. Returns True if a conversion was made."""
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
                        assert isinstance(t, str)
                        arg += t
                    value_true.append(arg)

            struct.body = ir.Param.Bool(value_true=value_true, value_false=[])
            struct.nullable = False
            struct.default_value = False

            # Now extract into its own ConditionalGroup
            location = _param_parent_location(struct)
            if location is None:
                continue

            # Create new cmdarg with the bool param
            new_cmdarg = ir.CmdArg(tokens=[struct], join=location.cmdarg.join)
            new_group = ir.ConditionalGroup(cargs=[new_cmdarg], join=None)

            # Remove from original group
            new_cargs = location.group.cargs[: location.cmdarg_idx] + location.group.cargs[location.cmdarg_idx + 1 :]

            parent_struct = location.parent
            if new_cargs:
                modified_group = ir.ConditionalGroup(cargs=new_cargs, join=location.group.join)
                parent_struct.body.groups = (
                    parent_struct.body.groups[: location.group_idx]
                    + [modified_group, new_group]
                    + parent_struct.body.groups[location.group_idx + 1 :]
                )
            else:
                parent_struct.body.groups = (
                    parent_struct.body.groups[: location.group_idx]
                    + [new_group]
                    + parent_struct.body.groups[location.group_idx + 1 :]
                )

            app.command.setup_parent_references()
            return True

        return False

    while find_and_convert():
        pass

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


def _join_optionals[T](a: T | None, b: T | None, join: Callable[[T, T], T]) -> T | None:
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
    Flatten structs that contain only a single parameter into their parent group.
    """

    @dataclass
    class TokenLocation:
        """Location of a param within the tree."""

        parent_struct: ir.Param[ir.Param.Struct]
        group_idx: int
        cmdarg_idx: int
        token_idx: int

        @property
        def group(self) -> ir.ConditionalGroup:
            return self.parent_struct.body.groups[self.group_idx]

        @property
        def cmdarg(self) -> ir.CmdArg:
            return self.group.cargs[self.cmdarg_idx]

        def cmdarg_has_only_struct(self) -> bool:
            """Check if the cmdarg contains only the struct param (no other tokens)."""
            tokens = self.cmdarg.tokens
            return len(tokens) == 1 and isinstance(tokens[0], ir.Param)

    def find_token_location(target: ir.Param) -> TokenLocation | None:
        """Find where a param lives in its parent's token list."""
        parent = target.parent
        if parent is None or not isinstance(parent.body, ir.Param.Struct):
            return None

        for group_idx, group in enumerate(parent.body.groups):
            for cmdarg_idx, cmdarg in enumerate(group.cargs):
                for token_idx, token in enumerate(cmdarg.tokens):
                    if token is target:
                        return TokenLocation(parent, group_idx, cmdarg_idx, token_idx)
        return None

    def get_single_param(struct_body: ir.Param.Struct) -> ir.Param | None:
        """Get the single param if struct has exactly one, else None."""
        params = list(struct_body.iter_params_shallow())
        return params[0] if len(params) == 1 else None

    def has_only_static_tokens_and_one_param(struct_body: ir.Param.Struct) -> bool:
        """Check if struct has only string tokens plus exactly one param across all cmdargs."""
        param_count = 0
        for group in struct_body.groups:
            for carg in group.cargs:
                for token in carg.tokens:
                    if isinstance(token, ir.Param):
                        param_count += 1
                        if param_count > 1:
                            return False
        return param_count == 1

    def collect_all_tokens(struct_body: ir.Param.Struct) -> list[ir.Param | str]:
        """Collect all tokens from all cmdargs in order."""
        tokens: list[ir.Param | str] = []
        for group in struct_body.groups:
            for carg in group.cargs:
                tokens.extend(carg.tokens)
        return tokens

    def find_flattening_candidate() -> tuple[ir.Param[ir.Param.Struct], ir.Param, TokenLocation] | None:
        """Find a struct that can be safely flattened."""
        for struct in app.command.iter_structs_deep():
            if struct.parent is None:
                continue
            if isinstance(struct.parent.body, ir.Param.StructUnion):
                continue
            if struct.list_ is not None:
                continue
            if struct.base.outputs:
                continue

            single_param = get_single_param(struct.body)
            if single_param is None:
                continue

            if struct.nullable and single_param.nullable:
                continue

            location = find_token_location(struct)
            if location is None:
                continue

            # Can flatten if:
            # 1. Parent cmdarg contains ONLY this struct, AND
            # 2. Struct has only static tokens plus one param
            if not location.cmdarg_has_only_struct():
                continue
            if not has_only_static_tokens_and_one_param(struct.body):
                continue

            return struct, single_param, location

        return None

    def flatten_struct(
        struct: ir.Param[ir.Param.Struct],
        single_param: ir.Param,
        location: TokenLocation,
    ) -> None:
        """Flatten struct by creating a new ConditionalGroup for its cmdargs."""
        # Collect all cmdargs from the struct
        struct_cmdargs: list[ir.CmdArg] = []
        for group in struct.body.groups:
            struct_cmdargs.extend(group.cargs)

        # Create a new ConditionalGroup for the struct's cmdargs
        new_struct_group = ir.ConditionalGroup(cargs=struct_cmdargs, join=None)

        # Remove the struct's cmdarg from the original group
        new_cargs = location.group.cargs[: location.cmdarg_idx] + location.group.cargs[location.cmdarg_idx + 1 :]

        # Update the original group (or remove if empty)
        if new_cargs:
            modified_group = ir.ConditionalGroup(cargs=new_cargs, join=location.group.join)
            new_groups = (
                location.parent_struct.body.groups[: location.group_idx]
                + [modified_group, new_struct_group]
                + location.parent_struct.body.groups[location.group_idx + 1 :]
            )
        else:
            new_groups = (
                location.parent_struct.body.groups[: location.group_idx]
                + [new_struct_group]
                + location.parent_struct.body.groups[location.group_idx + 1 :]
            )

        location.parent_struct.body.groups = new_groups

    while True:
        candidate = find_flattening_candidate()
        if candidate is None:
            break

        struct, single_param, location = candidate

        # Transfer nullability if needed
        if struct.nullable and not single_param.nullable:
            single_param.nullable = True
            single_param.default_value = ir.Param.SetToNone

        # Merge docs
        single_param.base.docs = _merge_docs(struct.base.docs, single_param.base.docs)

        # Flatten the struct
        flatten_struct(struct, single_param, location)

        app.command.setup_parent_references()

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
