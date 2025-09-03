from styx.backend import compile_language
from styx.frontend.boutiques import from_boutiques
from styx.ir import core as ir


def boutiques2python(boutiques: dict, package: str = "no_package") -> str:
    ir_interface = from_boutiques(boutiques)
    project = ir.Project()
    package = ir.Package(package, "0.1.0", "no/docker/tag")

    for file in compile_language(lang="python", project=project, packages=[(package, [ir_interface])]):
        if file.content.__contains__(ir_interface.uid):  # todo this is just an hack for now
            return file.content
    assert False
