"""Test command line argument building."""

import styx.boutiques.utils
import styx.compiler.core
import styx.compiler.settings
import styx.runners.core
from tests.utils.dynmodule import (
    BT_TYPE_FILE,
    BT_TYPE_FLAG,
    BT_TYPE_NUMBER,
    BT_TYPE_STRING,
    boutiques_dummy,
    dynamic_module,
)


def test_positional_string_arg() -> None:
    """Positional string argument."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_STRING,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="my_string")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "my_string"]


def test_positional_number_arg() -> None:
    """Positional number argument."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_NUMBER,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="123")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "123"]


def test_positional_file_arg() -> None:
    """Positional file argument."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_FILE,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="/my/file.txt")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "/my/file.txt"]


def test_flag_arg() -> None:
    """Flag argument."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_FLAG,
                        "command-line-flag": "-x",
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="my_string")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "-x"]


def test_named_arg() -> None:
    """Named argument."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_STRING,
                        "command-line-flag": "-x",
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="my_string")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "-x", "my_string"]


def test_list_of_strings_arg() -> None:
    """List of strings."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_STRING,
                        "list": True,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x=["my_string1", "my_string2"])

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "my_string1 my_string2"]


def test_list_of_numbers_arg() -> None:
    """List of numbers."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy [X]",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_NUMBER,
                        "list": True,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x=[1, 2])

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["dummy", "1 2"]


def test_static_args() -> None:
    """Static arguments."""
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "dummy -a 1 -b 2 [X] -c 3 -d 4",
                "inputs": [
                    {
                        "id": "x",
                        "name": "The x",
                        "value-key": "[X]",
                        "type": BT_TYPE_STRING,
                    }
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(runner=dummy_runner, x="my_string")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == [
        "dummy",
        "-a",
        "1",
        "-b",
        "2",
        "my_string",
        "-c",
        "3",
        "-d",
        "4",
    ]


def test_arg_order() -> None:
    """Argument order.

    The wrapper should respect the order of the arguments
    in the Boutiques descriptor input array.
    """
    settings = styx.compiler.settings.CompilerSettings(defs_mode=styx.compiler.settings.DefsMode.IMPORT)
    model = styx.boutiques.utils.boutiques_from_dict(
        boutiques_dummy(
            {
                "command-line": "[B] [A]",
                "inputs": [
                    {
                        "id": "a",
                        "name": "The a",
                        "value-key": "[A]",
                        "type": BT_TYPE_STRING,
                    },
                    {
                        "id": "b",
                        "name": "The b",
                        "value-key": "[B]",
                        "type": BT_TYPE_STRING,
                    },
                ],
            }
        )
    )

    compiled_module = styx.compiler.core.compile_descriptor(model, settings)

    test_module = dynamic_module(compiled_module, "test_module")
    dummy_runner = styx.runners.core.DummyRunner()
    test_module.dummy(dummy_runner, "aaa", "bbb")

    assert dummy_runner.last_cargs is not None
    assert dummy_runner.last_cargs == ["bbb", "aaa"]
