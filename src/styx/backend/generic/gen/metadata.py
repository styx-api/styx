from styx.backend.generic.languageprovider import LanguageProvider
from styx.backend.generic.model import GenericModule
from styx.backend.generic.scope import Scope
from styx.ir import core as ir


def generate_static_metadata(
    lang: LanguageProvider,
    module: GenericModule,
    scope: Scope,
    package: ir.Package,
    interface: ir.Interface,
) -> str:
    """Generate the static metadata."""
    metadata_symbol = scope.add_or_dodge(lang.metadata_symbol(interface.command.base.name))

    entries: dict = {
        "id": interface.uid,
        "name": interface.command.base.name,
        "package": package.name,
    }

    if interface.command.base.docs.literature:
        entries["citations"] = interface.command.base.docs.literature

    if package.docker:
        entries["container_image_tag"] = package.docker

    module.header.extend(lang.generate_metadata(metadata_symbol, entries))

    return metadata_symbol
