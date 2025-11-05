from __future__ import annotations

import dataclasses
import weakref
from dataclasses import dataclass
from typing import Any, Generator, Generic, Optional, TypeVar, Union


@dataclass
class Documentation:
    """Represents documentation for various elements."""

    title: str | None = None
    """The title of the documentation."""

    description: str | None = None
    """A description of the element being documented."""

    authors: list[str] = dataclasses.field(default_factory=list)
    """List of authors."""

    literature: list[str] | None = dataclasses.field(default_factory=list)
    """List of related literature references."""

    urls: list[str] | None = dataclasses.field(default_factory=list)
    """List of relevant URLs."""


@dataclass
class Project:
    """Metadata for project containing multiple packages."""

    name: str = "unknown"
    """The name of the project."""

    version: str = "0.1.0"
    """The version of the project."""

    docs: Documentation = dataclasses.field(default_factory=Documentation)
    """Documentation for the project."""

    license: str | None = None
    """License of the project."""

    extras: dict[str, Any] = dataclasses.field(default_factory=dict)
    """Additional backend specific config options."""


@dataclass
class Package:
    """Metadata for software package containing command."""

    name: str
    """The name of the package."""

    version: str | None
    """The version of the package."""

    docker: str | None
    """Docker image tag."""

    docs: Documentation = dataclasses.field(default_factory=Documentation)
    """Documentation for the package."""


IdType = int


@dataclass
class OutputParamReference:
    """Represents a reference to an output parameter."""

    ref_id: IdType
    """The ID of the referenced parameter."""

    file_remove_suffixes: list[str] = dataclasses.field(default_factory=list)
    """List of suffixes to remove from file names."""

    fallback: str | None = None
    """Fall back to this value if the referenced parameter is optional and set to None."""


@dataclass
class Output:
    """Represents an output."""

    id_: IdType
    """Unique ID of the output. Unique including param IDs."""

    name: str
    """The name of the output."""

    tokens: list[str | OutputParamReference] = dataclasses.field(default_factory=list)
    """List of tokens and/or parameter references. This is similar to a Python f-string."""

    docs: Documentation = dataclasses.field(default_factory=Documentation)
    """Documentation for the output."""

    media_types: list[str] = dataclasses.field(default_factory=list)
    """Media types the output may have."""


T = TypeVar("T")


class Param(Generic[T]):
    """Generic class to represent various types of parameters."""

    @dataclass
    class Base:
        """Base class for all parameters."""

        id_: IdType
        """The ID of the parameter. Unique including output IDs."""

        name: str
        """The name of the parameter."""

        outputs: list[Output] = dataclasses.field(default_factory=list)
        """List of outputs associated with this parameter."""

        docs: Documentation = dataclasses.field(default_factory=Documentation)
        """Documentation for the parameter."""

    @dataclass
    class List:
        """Represents list parameters."""

        count_min: int | None = None
        """Minimum count of list items."""

        count_max: int | None = None
        """Maximum count of list items."""

        join: str | None = None
        """Join string for list items."""

    class SetToNone:
        """Represents a parameter that can be set to None."""

        pass

    @dataclass
    class Bool:
        """Represents boolean parameters."""

        value_true: list[str] = dataclasses.field(default_factory=list)
        """List of strings representing true value."""

        value_false: list[str] = dataclasses.field(default_factory=list)
        """List of strings representing false value."""

    @dataclass
    class Int:
        """Represents integer parameters."""

        min_value: int | None = None
        """Minimum allowed value."""

        max_value: int | None = None
        """Maximum allowed value."""

    @dataclass
    class Float:
        """Represents float parameters."""

        min_value: float | None = None
        """Minimum allowed value."""

        max_value: float | None = None
        """Maximum allowed value."""

    @dataclass
    class String:
        """Represents string parameters."""

        pass

    @dataclass
    class File:
        """Represents file parameters."""

        resolve_parent: bool = False
        """Whether to resolve parent directory."""

        mutable: bool = False
        """This file may be mutated."""

        media_types: list[str] = dataclasses.field(default_factory=list)
        """Media types the file may have."""

    @dataclass
    class Struct:
        """Represents a command structure."""

        name: str | None = None
        """Name of the structure."""

        public_name: str | None = None
        """Structure public name. 
        
        This is the @type.
        This name should uniquely identify the root structure across commands and packages and union members between each others.
        """

        groups: list[ConditionalGroup] = dataclasses.field(default_factory=list)
        """List of conditional groups."""

        join: str | None = None
        """If not None, collapse all groups to a single string with this delimiter.
        Args within groups should be joined without delimiter.
        """

        docs: Documentation | None = None
        """Documentation for the structure."""

        def iter_params_shallow(self) -> Generator[Param, Any, None]:
            """Iterate over all parameters in the structure.

            Yields:
                Each parameter in the structure.
            """
            for group in self.groups:
                yield from group.iter_params()

    @dataclass
    class StructUnion:
        """Represents a union of parameter structures."""

        alts: list[Param[Param.Struct]] = dataclasses.field(default_factory=list)
        """List of alternative structure parameters."""

    def iter_params_deep(self, skip_self: bool = True) -> Generator[Param, Any, None]:
        """Iterate through all child-params recursively."""
        if not skip_self:
            yield self
        if isinstance(self.body, Param.Struct):
            for e in self.body.iter_params_shallow():
                yield from e.iter_params_deep(False)
        elif isinstance(self.body, Param.StructUnion):
            for e in self.body.alts:
                yield from e.iter_params_deep(False)

    def iter_structs_deep(self, skip_self: bool = True) -> Generator[Param[Param.Struct], Any, None]:
        """Iterate through all child-structures recursively."""
        if not skip_self and isinstance(self.body, Param.Struct):
            yield self  # type: ignore
        if isinstance(self.body, Param.Struct):
            for e in self.body.iter_params_shallow():
                yield from e.iter_structs_deep(False)
        elif isinstance(self.body, Param.StructUnion):
            for e in self.body.alts:
                yield from e.iter_structs_deep(False)

    def iter_unions_deep(self, skip_self: bool = True) -> Generator[Param[Param.StructUnion], Any, None]:
        """Iterate through all child-unions recursively."""
        if not skip_self and isinstance(self.body, Param.StructUnion):
            yield self  # type: ignore
        if isinstance(self.body, Param.Struct):
            for e in self.body.iter_params_shallow():
                yield from e.iter_unions_deep(False)
        elif isinstance(self.body, Param.StructUnion):
            for e in self.body.alts:
                yield from e.iter_unions_deep(False)

    @property
    def parent(self) -> Optional[Param[Param.Struct] | Param[Param.StructUnion]]:
        """Get the parent parameter, if any.

        Returns:
            The parent parameter, or None if this is a root parameter or the parent
            has been garbage collected.
        """
        if self._parent_ref is None:
            return None
        return self._parent_ref()

    def set_parent(self, parent: Optional[Param[Param.Struct] | Param[Param.StructUnion]]) -> None:
        """Set the parent parameter.

        Args:
            parent: The parent parameter, or None to clear the parent reference.
        """
        if parent is None:
            self._parent_ref = None
        else:
            self._parent_ref = weakref.ref(parent)

    def get_path_to_root(self) -> list[Param[Param.Struct] | Param[Param.StructUnion]]:
        """Get the path from this parameter to the root parameter.

        Returns:
            List of parameter names from this parameter up to (but not including) the root.
            Empty list if this is the root parameter.
        """
        path: list[Param[Param.Struct] | Param[Param.StructUnion]] = []
        current = self.parent
        while current is not None:
            path.append(current)
            current = current.parent
        return list(reversed(path))

    def get_full_path(self) -> list[Param]:
        """Get the full path from root to this parameter.

        Returns:
            List of parameter names from root down to this parameter.
        """
        path = self.get_path_to_root()
        path.append(self)
        return path

    def is_root(self) -> bool:
        """Check if this parameter is a root parameter (has no parent).

        Returns:
            True if this parameter has no parent, False otherwise.
        """
        return self.parent is None

    def get_root(self) -> Param[Param.Struct]:
        """Get the root parameter of this parameter tree.

        Returns:
            The root parameter (may be self if this is already the root).
        """
        current = self
        while current.parent is not None:
            current = current.parent
        return current

    def setup_parent_references(self) -> None:
        """Set up parent references for all child parameters."""
        if isinstance(self.body, Param.Struct):
            for child in self.body.iter_params_shallow():
                child.set_parent(self)
                child.setup_parent_references()
        elif isinstance(self.body, Param.StructUnion):
            for child in self.body.alts:
                child.set_parent(self)
                child.setup_parent_references()

    def has_outputs_deep(self) -> bool:
        """Check if this param or any child param has outputs."""
        if len(self.base.outputs) > 0:
            return True
        if isinstance(self.body, Param.Struct):
            for e in self.body.iter_params_shallow():
                if e.has_outputs_deep():
                    return True
        elif isinstance(self.body, Param.StructUnion):
            for e in self.body.alts:
                if e.has_outputs_deep():
                    return True
        return False

    def __init__(
        self,
        base: Base,
        body: T,
        list_: Optional[List] = None,
        nullable: bool = False,
        choices: Optional[list[Union[str, int, float]]] = None,
        default_value: Union[
            bool, str, int, float, list[bool], list[str], list[int], list[float], type[SetToNone], None
        ] = None,
    ) -> None:
        """Initialize a Param instance.

        Args:
            base: Base parameter information.
            body: The body of the parameter. Determines its base type.
            list_: List information if the parameter is a list.
            nullable: Whether the parameter can be null.
            choices: List of possible choices for the parameter.
            default_value: Default value for the parameter.

        Raises:
            TypeError: If any of the input types are incorrect.
            ValueError: If there are constraint violations.
        """
        self.base = base
        self.body: T = body
        self.list_ = list_
        self.nullable = nullable
        self.choices = choices
        self.default_value = default_value

        self._parent_ref: Optional[weakref.ReferenceType[Param[Param.Struct] | Param[Param.StructUnion]]] = None
        """Weak reference to parent parameter."""

        # Runtime type checking
        self._check_base()
        self._check_body_type()
        self._check_list()
        self._check_nullable()
        self._check_choices()
        self._check_default_value()
        self._check_constraints()

    def _check_base(self) -> None:
        """Check if base is an instance of Param.Base."""
        if not isinstance(self.base, Param.Base):
            raise TypeError("base must be an instance of Param.Base")

    def _check_body_type(self) -> None:
        """Check if body is an instance of one of the allowed types."""
        if not isinstance(
            self.body, (Param.Bool, Param.Int, Param.Float, Param.String, Param.File, Param.Struct, Param.StructUnion)
        ):
            raise TypeError(
                "body must be an instance of "
                "Param.Bool, Param.Int, Param.Float, Param.String, Param.File, Param.Struct or Param.StructUnion"
            )

    def _check_list(self) -> None:
        """Check if list_ is None or an instance of Param.List."""
        if self.list_ is not None and not isinstance(self.list_, Param.List):
            raise TypeError("list_ must be None or an instance of Param.List")

    def _check_nullable(self) -> None:
        """Check if nullable is a boolean."""
        if not isinstance(self.nullable, bool):
            raise TypeError("nullable must be a boolean")

    def _check_choices(self) -> None:
        """Check if choices is None or a list of the correct type."""
        if self.choices is not None:
            if not isinstance(self.choices, list):
                raise TypeError("choices must be None or a list")
            expected_type = self._get_expected_type()
            if expected_type is not None and not all(isinstance(choice, expected_type) for choice in self.choices):
                raise TypeError(f"All choices must be of type {' or '.join([e.__name__ for e in expected_type])}")

    def _check_default_value(self) -> None:
        """Check if default_value is of the correct type."""
        if self.default_value is None:
            return
        if self.default_value is Param.SetToNone:
            if not self.nullable:
                raise ValueError("default_value cannot be SetToNone when nullable is False")
            return

        expected_type = self._get_expected_type()
        if expected_type is None:
            raise TypeError("default_value must be a None for this type")
        if self.list_:
            if not isinstance(self.default_value, list):
                raise TypeError("default_value must be a list when list_ is provided")
            if not all(isinstance(item, expected_type) for item in self.default_value):
                raise TypeError(
                    f"All items in default_value must be of type {' or '.join([e.__name__ for e in expected_type])}"
                )
        else:
            if not isinstance(self.default_value, expected_type):
                raise TypeError(f"default_value must be of type {' or '.join([e.__name__ for e in expected_type])}")

    def _check_constraints(self) -> None:
        """Check if all constraints are satisfied."""
        if isinstance(self.body, (Param.Int, Param.Float)):
            if self.body.min_value is not None and self.body.max_value is not None:
                if self.body.min_value > self.body.max_value:
                    raise ValueError("min_value cannot be greater than max_value")

            if (
                self.default_value is not None
                and self.default_value is not Param.SetToNone
                and not isinstance(self.default_value, (list, Param.SetToNone))
            ):
                assert isinstance(self.default_value, (int, float))
                if self.body.min_value is not None and self.default_value < self.body.min_value:
                    raise ValueError(f"default_value cannot be less than min_value ({self.body.min_value})")
                if self.body.max_value is not None and self.default_value > self.body.max_value:
                    raise ValueError(f"default_value cannot be greater than max_value ({self.body.max_value})")

        if self.list_:
            if self.list_.count_min is not None and self.list_.count_max is not None:
                if self.list_.count_min > self.list_.count_max:
                    raise ValueError("count_min cannot be greater than count_max")

            if isinstance(self.default_value, list):
                if self.list_.count_min is not None and len(self.default_value) < self.list_.count_min:
                    raise ValueError(
                        f"default_value list length cannot be less than count_min ({self.list_.count_min})"
                    )
                if self.list_.count_max is not None and len(self.default_value) > self.list_.count_max:
                    raise ValueError(
                        f"default_value list length cannot be greater than count_max ({self.list_.count_max})"
                    )

    def _get_expected_type(self) -> tuple[type, ...] | None:
        """Get the expected type based on the body type."""
        if isinstance(self.body, Param.Bool):
            return (bool,)
        elif isinstance(self.body, Param.Int):
            return (int,)
        elif isinstance(self.body, Param.Float):
            return float, int
        elif isinstance(self.body, Param.String):
            return (str,)
        elif isinstance(self.body, (Param.File, Param.Struct, Param.StructUnion)):
            return None
        else:
            raise TypeError("Unknown body type")

    def __repr__(self) -> str:
        """Return a string representation of the Param instance."""
        parts = [
            f"Param(id={self.base.id_!r}, name={self.base.name!r}",
            f"type={self.body}",
        ]

        if self.list_:
            parts.append(f"list={self.list_!r}")
        if self.nullable:
            parts.append("nullable=True")
        if self.choices:
            parts.append(f"choices={self.choices!r}")
        if self.default_value is not None:
            parts.append(f"default={self.default_value!r}")
        if self.base.outputs:
            parts.append(f"outputs={self.base.outputs!r}")

        return ", ".join(parts) + ")"


@dataclass
class CmdArg:
    """Represents command arguments."""

    tokens: list[Param | str] = dataclasses.field(default_factory=list)
    """List of parameters or string tokens."""

    join: str | None = None
    """If not None, collapse all defined tokens to a single string with this delimiter.
    """

    def iter_params(self) -> Generator[Param, Any, None]:
        """Iterate over all parameters in the command argument.

        Yields:
            Each parameter in the command argument.
        """
        for token in self.tokens:
            if isinstance(token, Param):
                yield token


@dataclass
class ConditionalGroup:
    """Represents a group of command arguments.

    Arguments will only be emitted if at least one parameter within is defined, or if there are no parameters.
    """

    cargs: list[CmdArg] = dataclasses.field(default_factory=list)
    """List of command arguments."""

    join: str | None = None
    """If not None, collapse all args to a single string with this delimiter.
    Args within groups should be joined without delimiter.
    """

    def iter_params(self) -> Generator[Param, Any, None]:
        """Iterate over all parameters in the conditional group.

        Yields:
            Each parameter in the conditional group.
        """
        for carg in self.cargs:
            yield from carg.iter_params()


@dataclass
class StreamOutput:
    id_: IdType
    """Unique ID of the output. Unique including param IDs."""

    name: str
    """The name of the output."""

    docs: Documentation = dataclasses.field(default_factory=Documentation)
    """Documentation for the output."""


@dataclass
class App:
    """Represents an application."""

    uid: str
    """Unique identifier for the app."""

    command: Param[Param.Struct]
    """The command structure for this app."""

    capture_stdout: StreamOutput | None = None
    """Collect stdout as string output."""

    capture_stderr: StreamOutput | None = None
    """Collect stderr as string output."""

    project: Project = dataclasses.field(default_factory=Project)
    """Project metadata."""

    _is_set_up: bool = dataclasses.field(default=False, init=False, repr=False, compare=False)

    def assert_set_up(self) -> None:
        """Assert that the app is set up."""
        assert self._is_set_up

    def setup(self, package_name: str) -> None:
        """Set up parent references and generate global structure names."""
        if self._is_set_up:
            return
        self._is_set_up = True

        self.command.setup_parent_references()

        self.command.body.public_name = f"{package_name}/{self.command.base.name}"

        for struct_param in self.command.iter_structs_deep():
            struct_param.body.public_name = struct_param.body.name
