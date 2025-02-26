import pathlib
import typing


class CompiledFile(typing.NamedTuple):
    path: pathlib.Path
    """Relative path of the output file"""
    content: str
    """File contents"""

    def write(self, parent: pathlib.Path | str = "."):
        """Write file. Creates parent directories as necessary"""
        p = parent / self.path
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf8") as file:
            file.write(self.content)

    def __repr__(self):
        return f"{'=' * 80}\nFile: {self.path.as_posix()}\n{'-'*80}\n{self.content}\n{'=' * 80}"
