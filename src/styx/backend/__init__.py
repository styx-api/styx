"""Styx backends."""
import typing

from styx.backend.boutiques.core import to_boutiques, compile_boutiques_json
from styx.backend.common import CompiledFile
import styx.ir.core as ir
from styx.backend.python.languageprovider import PythonLanguageProvider
from styx.backend.r.languageprovider import RLanguageProvider
from styx.backend.typescript.languageprovider import TypeScriptLanguageProvider

BACKEND_ID_TYPE = typing.Literal["python", "r", "typescript", "boutiques"]


class BackendDescriptor(typing.NamedTuple):
    id_: BACKEND_ID_TYPE
    """Backend id."""
    name: str
    """Human readable name."""
    description: str
    """Backend description."""


_BACKENDS = [
    BackendDescriptor(
        id_="python",
        name="Python",
        description="Python (>=3.10)"
    ),
    BackendDescriptor(
        id_="r",
        name="R",
        description="R (WIP)"
    ),
    BackendDescriptor(
        id_="typescript",
        name="TypeScript",
        description="TypeScript (WIP)"
    ),
    BackendDescriptor(
        id_="boutiques",
        name="Boutiques",
        description="Boutiques (WIP)"
    ),
]


def get_backends():
    return _BACKENDS


def compile_language(
    lang: BACKEND_ID_TYPE,
    interfaces: typing.Iterable[ir.Interface],
) -> typing.Generator[CompiledFile, typing.Any, None]:
    """For a stream of IR interfaces return a stream of compiled files.

    Args:
        lang: Target language.
        interfaces: Stream of IR interfaces.

    Returns:
        Stream of compiled files.
    """
    if lang == "boutiques":
        yield from compile_boutiques_json(interfaces)
        return
    if lang == "python":
        lp = PythonLanguageProvider
    elif lang == "r":
        lp = RLanguageProvider
    elif lang == "typescript":
        lp = TypeScriptLanguageProvider
    else:
        raise Exception(f"Unknown language '{lang}'")
    yield from lp().compile(interfaces)
