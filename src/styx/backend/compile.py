import typing

from styx.backend import TextFile
from styx.ir import core as ir


class Compilable(typing.Protocol):
    def compile(
        self,
        project: ir.Project,
        packages: typing.Iterable[
            tuple[
                ir.Package,
                typing.Iterable[ir.Interface],
            ]
        ],
    ) -> typing.Generator[TextFile, typing.Any, None]: ...
