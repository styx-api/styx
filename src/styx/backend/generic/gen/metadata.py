from styx.backend.generic.gen.lookup import SymbolLUT
from styx.backend.generic.languageprovider import LanguageProvider
from styx.backend.generic.model import GenericModule
from styx.backend.generic.scope import Scope
from styx.ir import core as ir


def generate_static_metadata(
    lang: LanguageProvider,
    module: GenericModule,
    lut: SymbolLUT,
    package: ir.Package,
    app: ir.App,
) -> None:
    """Generate the static metadata."""
    metadata_symbol = lut.obj_metadata

    entries: dict = {
        "id": app.uid,
        "name": app.command.base.name,
        "package": package.name,
    }

    if app.command.base.docs.literature:
        entries["citations"] = app.command.base.docs.literature

    if package.docker:
        entries["container_image_tag"] = package.docker

    module.header.extend(lang.generate_metadata(metadata_symbol, entries))
