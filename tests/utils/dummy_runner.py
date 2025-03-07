import pathlib
import typing

from styxdefs import Execution, InputPathType, Metadata, OutputPathType, Runner


class DummyRunner(Runner, Execution):
    def __init__(self) -> None:
        self.last_cargs: list[str] | None = None
        self.last_metadata: Metadata | None = None

    def start_execution(self, metadata: Metadata) -> Execution:
        self.last_metadata = metadata
        return self

    def params(self, params: dict) -> dict:
        return params

    def input_file(
        self,
        host_file: InputPathType,
        resolve_parent: bool = False,
        mutable: bool = False,
    ) -> str:
        return str(host_file)

    def output_file(self, local_file: str, optional: bool = False) -> OutputPathType:
        return pathlib.Path(local_file)

    def run(
            self,
            cargs: list[str],
            handle_stdout: typing.Callable[[str], None] | None = None,
            handle_stderr: typing.Callable[[str], None] | None = None,
    ) -> None:
        self.last_cargs = cargs
