from styx.backend import compile_language
from styx.frontend.boutiques import from_boutiques


def boutiques2python(boutiques: dict, package: str = "no_package") -> str:
    ir = from_boutiques(boutiques, package)
    py = compile_language("python", [ir]).__next__().content
    return py
