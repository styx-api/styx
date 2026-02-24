from styx.backend.styxdefs_compat import STYXDEFS_COMPAT
from styx.ir import core as ir


def template_root_pyproject(project: ir.Project, dependencies: list[str]) -> str:
    description = (
        project.docs.description
        if project.docs.description
        else f"Styx generated wrappers for {project.docs.title or project.name}."
    )
    dependencies = "".join([f'\n  "{project.name}_{d}",' for d in dependencies])
    authors = ", ".join(project.docs.authors) if project.docs.authors else "unknown"
    return f'''[project]
name = "{project.name}"
version = "{project.version}"
description = "{description}"
readme = "README.md"
license = "{project.license or "unknown"}"
authors = [{{ name = "{authors}" }}]
requires-python = ">=3.10"
dependencies = [
  "styxdocker",
  "styxpodman",
  "styxsingularity",
  "styxgraph",{dependencies}
]

[build-system]
requires = ["uv_build>=0.8.13,<0.9.0"]
build-backend = "uv_build"'''


def template_sub_pyproject(
    project: ir.Project,
    package: ir.Package,
) -> str:
    authors = ", ".join(project.docs.authors) if project.docs.authors else "unknown"
    return f'''[project]
name = "{project.name}_{package.name}"
version = "{project.version}"
description = "{project.docs.description or "Wrappers"}"
license = "{project.license or "unknown"}"
authors = [{{ name = "{authors}" }}]
requires-python = ">=3.10"
dependencies = [
    "styxdefs{STYXDEFS_COMPAT}"
]

[tool.uv.build-backend]
module-name = "{project.name}_{package.name}.{package.name}"

[build-system]
requires = ["uv_build>=0.8.13,<0.9.0"]
build-backend = "uv_build"'''


def template_sub_readme(project: ir.Project, package: ir.Package) -> str:
    project_title = project.docs.title or project.name
    package_title = package.docs.title or package.name
    package_authors = ", ".join(package.docs.urls) if package.docs.urls else "unknown"
    package_url = package.docs.urls[0] if package.docs.urls else None
    package_title_md = f"[{package_title}]({package_url})" if package_url else package_title

    package_description_md = f"\n\n{package.docs.description}" if package.docs.description else ""

    return f"""# {project_title} wrappers for {package_title_md}{package_description_md}

{package_title} is made by {package_authors}.

This package contains wrappers only and has no affiliation with the original authors.
"""


def template_root_init_py(project: ir.Project, package_names: list[str]) -> str:
    reexports = "\n".join([f"from {project.name}_{x} import {x}" for x in package_names])

    dyn_execute = "\n".join([
        f'    if (stype.startswith("{x}/")): return {x}.execute(params, runner)' for x in package_names
    ])

    return f'''{reexports}
from styxdefs import *  # Reexport styxdefs
from styxdocker import DockerRunner
from styxpodman import PodmanRunner
from styxsingularity import SingularityRunner
from styxgraph import GraphRunner


def use_local(*args, **kwargs):
    """Set the LocalRunner as the global runner."""
    set_global_runner(LocalRunner(*args, **kwargs))


def use_dry(*args, **kwargs):
    """Set the DryRunner as the global runner."""
    set_global_runner(DryRunner(*args, **kwargs))


def use_docker(*args, **kwargs):
    """Set the DockerRunner as the global runner."""
    set_global_runner(DockerRunner(*args, **kwargs))


def use_podman(*args, **kwargs):
    """Set the PodmanRunner as the global runner."""
    set_global_runner(PodmanRunner(*args, **kwargs))


def use_singularity(*args, **kwargs):
    """Set the SingularityRunner as the global runner."""
    set_global_runner(SingularityRunner(*args, **kwargs))


def use_graph(*args, **kwargs):
    """Set the GraphRunner as the global runner."""
    set_global_runner(GraphRunner(*args, **kwargs))

def execute(params, runner: Runner | None = None):
    stype = params["@type"]
{dyn_execute}
    return None
'''
