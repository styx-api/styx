from typing import Generator

import styx.ir.core as ir


def _merge_string_tokens(interface: ir.App) -> ir.App:
    """Merge neighbouring string literals in Carg tokens."""

    def _iter_cargs() -> Generator[ir.CmdArg, None, None]:
        for param in interface.command.iter_params_deep(False):
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

    return interface


def optimize(interface: ir.App) -> ir.App:
    """Simplify IR without changing meaning."""
    interface = _merge_string_tokens(interface)
    return interface
