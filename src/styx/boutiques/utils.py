import shlex


def boutiques_split_command(command: str) -> list[str]:
    """Split a Boutiques command into a list of arguments.

    Args:
        command (str): The Boutiques command.

    Returns:
        list[str]: The list of arguments.
    """
    # shlex waits for stdin if None is passed, make sure this doesn't happen
    assert command is not None, "Command cannot be None"
    args = shlex.split(command)

    return args
