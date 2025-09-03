import typing


class Version(typing.NamedTuple):
    major: int
    minor: int
    patch: int

    def __repr__(self):
        return f"{self.major}.{self.minor}.{self.patch}"


class StyxDefsCompat(typing.NamedTuple):
    minimum: Version
    """Inclusive minimum version."""
    maximum: Version
    """Exclusive maximum version."""

    def __repr__(self):
        return f">={self.minimum},<{self.maximum}"


STYXDEFS_COMPAT = StyxDefsCompat(
    minimum=Version(0, 5, 0),
    maximum=Version(0, 6, 0),
)
