from typing import TypeGuard, Any

from styx.ir.core import Param


# Unfortunately TypeGuards dont work as methods with implicit self


def is_bool(param: Param[Any]) -> TypeGuard[Param[Param.Bool]]:
    """Check if the parameter is a boolean type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a boolean type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.Bool)


def is_int(param: Param[Any]) -> TypeGuard[Param[Param.Int]]:
    """Check if the parameter is an integer type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is an integer type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.Int)


def is_float(param: Param[Any]) -> TypeGuard[Param[Param.Float]]:
    """Check if the parameter is a float type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a float type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.Float)


def is_string(param: Param[Any]) -> TypeGuard[Param[Param.String]]:
    """Check if the parameter is a string type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a string type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.String)


def is_file(param: Param[Any]) -> TypeGuard[Param[Param.File]]:
    """Check if the parameter is a file type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a file type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.File)


def is_struct(param: Param[Any]) -> TypeGuard[Param[Param.Struct]]:
    """Check if the parameter is a struct type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a struct type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.Struct)


def is_struct_union(param: Param[Any]) -> TypeGuard[Param[Param.StructUnion]]:
    """Check if the parameter is a struct union type.

    Args:
        param: The parameter to check.

    Returns:
        True if the parameter is a struct union type, False otherwise.

    This function can be used for type narrowing in conditional blocks.
    """
    return isinstance(param.body, Param.StructUnion)
