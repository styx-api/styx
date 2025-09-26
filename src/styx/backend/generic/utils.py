"""Common codegen utilities."""

from typing_extensions import deprecated

from styx.ir import core as ir


def enquote(
    s: str,
    quote: str = '"',
) -> str:  # noqa
    """Put a string in "quotes"."""
    return f"{quote}{s}{quote}"


def enbrace(
    s: str,
    brace_type: str = "{",
) -> str:  # noqa
    """Put a string in {braces}."""
    _right_brace = {"{": "}", "[": "]", "(": ")"}
    return f"{brace_type}{s}{_right_brace[brace_type]}"


def linebreak_line(text: str, width: int = 80) -> list[str]:
    """Insert linebreaks into a line of text. Breaks lines at word boundaries."""
    words = text.split()
    lines = []
    line = ""
    for word in words:
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            if line:
                line += " "
            line += word
    lines.append(line)
    return lines


def linebreak_paragraph(text: str, width: int = 80, first_line_width: int = 80) -> list[str]:
    """Insert linebreaks into a paragraph of text. Breaks lines at word boundaries."""
    lines = text.splitlines()
    wrapped_lines = []
    first = True
    for line in lines:
        if first:
            wrapped_lines.extend(linebreak_line(line, width=first_line_width))
            first = False
        else:
            wrapped_lines.extend(linebreak_line(line, width=width))
    return wrapped_lines


def ensure_endswith(text: str, suffix: str) -> str:
    """Ensure that a string ends with a specific suffix."""
    return text if text.endswith(suffix) else f"{text}{suffix}"


def escape_backslash(s: str) -> str:
    """Escape backslashes with double backslash."""
    return s.replace("\\", "\\\\")
