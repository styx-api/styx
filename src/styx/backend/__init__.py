"""Styx backends."""

import pathlib
import typing

import styx.ir.core as ir
from styx.backend.boutiques.core import compile_boutiques_json
from styx.backend.boutiques.core import to_boutiques as to_boutiques
from styx.backend.common import TextFile
from styx.backend.compile import Compilable


BACKEND_ID_TYPE = typing.Literal[
    "python",
    "r",
    "typescript",
    "boutiques",
    "ir",
    "jsonschema",
]


class BackendDescriptor(typing.NamedTuple):
    id_: BACKEND_ID_TYPE
    """Backend id."""
    name: str
    """Human readable name."""
    description: str
    """Backend description."""


_BACKENDS = [
    BackendDescriptor(id_="python", name="Python", description="Python (>=3.10)"),
    BackendDescriptor(id_="r", name="R", description="R (WIP)"),
    BackendDescriptor(id_="typescript", name="TypeScript", description="TypeScript (WIP)"),
    BackendDescriptor(id_="boutiques", name="Boutiques", description="Boutiques (WIP)"),
    BackendDescriptor(id_="ir", name="Styx IR Dump", description="Styx IR Dump"),
    BackendDescriptor(id_="jsonschema", name="JSON Schema", description="JSON Schema of inputs"),
]


def get_backends() -> list[BackendDescriptor]:
    return _BACKENDS


def compile_language(
    lang: BACKEND_ID_TYPE,
    project: ir.Project,
    packages: typing.Iterable[
        tuple[
            ir.Package,
            typing.Iterable[ir.Interface],
        ]
    ],
) -> typing.Generator[TextFile, typing.Any, None]:
    """For a stream of IR interfaces return a stream of compiled files.

    Args:
        lang: Target language.
        project: Project metadata.
        packages: Stream of package metadata and IR interfaces.

    Returns:
        Stream of compiled files.
    """

    compiler: Compilable | None = None
    if lang == "boutiques":
        yield from compile_boutiques_json((i for i in (i for _, i in packages)))
        return
    if lang == "ir":
        from styx.ir.serialize import JsonDumper

        compiler = JsonDumper()
    elif lang == "jsonschema":
        from styx.backend.jsonschema import JsonSchemaCompiler

        compiler = JsonSchemaCompiler()
    if lang == "python":
        from styx.backend.python.languageprovider import PythonLanguageProvider

        compiler = PythonLanguageProvider()
    elif lang == "r":
        from styx.backend.r.languageprovider import RLanguageProvider

        compiler = RLanguageProvider()
    elif lang == "typescript":
        from styx.backend.typescript.languageprovider import TypeScriptLanguageProvider

        compiler = TypeScriptLanguageProvider()

    if not compiler:
        raise Exception(f"No compiler found for '{lang}'")
    yield from compiler.compile(project, packages)
