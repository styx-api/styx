#!/usr/bin/env python3
"""Styx Compiler CLI - Command line interface for the Styx compiler."""

import argparse
import json
import sys
import typing
from pathlib import Path

import styx.ir.core as ir
from styx.backend import BACKEND_ID_TYPE, compile_language, get_backends
from styx.frontend.boutiques import from_boutiques
from styx.ir.optimize import optimize


def setup_parser() -> argparse.ArgumentParser:
    """Set up the command line argument parser."""
    parser = argparse.ArgumentParser(
        prog="styx",
        description="Styx Compiler - Convert tool descriptors to various target languages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  styx input.json -b python -o output/
  styx *.json --backend typescript --output-dir build/
  styx tool.json -b boutiques,python -o generated/
  styx descriptor.json --list-backends
  styx tool.json -b python --package-title "My Tool" --package-authors "John Doe" "Jane Smith"
        """,
    )

    # Input files
    parser.add_argument("input_files", nargs="*", type=Path, help="Input Boutiques JSON descriptor file(s)")

    # Backend selection
    backend_choices = [backend.id_ for backend in get_backends()]
    parser.add_argument(
        "-b",
        "--backend",
        type=str,
        help=f"Target backend(s). Available: {', '.join(backend_choices)}. "
        "Use comma-separated values for multiple backends (e.g., 'python,typescript')",
    )

    # Output directory
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        help="Output directory for generated files (if not specified, output will be printed to stdout)",
    )

    # Package configuration
    parser.add_argument(
        "--package-name", type=str, help="Package name for generated code (default: derived from input filename)"
    )

    # Documentation options
    parser.add_argument("--package-title", type=str, help="Package documentation title")

    parser.add_argument("--package-description", type=str, help="Package description")

    parser.add_argument("--package-authors", type=str, nargs="*", help="Package authors")

    parser.add_argument("--package-literature", type=str, nargs="*", help="Package literature references")

    parser.add_argument("--package-urls", type=str, nargs="*", help="Package documentation URLs")

    # Optimization
    parser.add_argument("--no-optimize", action="store_true", help="Skip IR optimization step")

    # Utility options
    parser.add_argument("--list-backends", action="store_true", help="List available backends and exit")

    parser.add_argument("--dry-run", action="store_true", help="Show what would be generated without writing files")

    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose output")

    parser.add_argument("--force", action="store_true", help="Overwrite existing output files")

    return parser


def list_backends() -> None:
    """Display available backends."""
    backends = get_backends()

    max_id_len = max(len(backend.id_) for backend in backends)
    max_name_len = max(len(backend.name) for backend in backends)

    print("Available backends:")
    print()
    for backend in backends:
        print(f"  {backend.id_:<{max_id_len}} - {backend.name:<{max_name_len}} ({backend.description})")
    print()


def parse_backends(backend_str: str) -> list[BACKEND_ID_TYPE]:
    """Parse comma-separated backend string into list of backend IDs."""
    if not backend_str:
        return []

    backends = [b.strip() for b in backend_str.split(",")]
    available_backends = {b.id_ for b in get_backends()}

    invalid_backends = [b for b in backends if b not in available_backends]
    if invalid_backends:
        raise ValueError(
            f"Invalid backend(s): {', '.join(invalid_backends)}. Available: {', '.join(sorted(available_backends))}"
        )

    return typing.cast(list[BACKEND_ID_TYPE], backends)


def load_boutiques_file(file_path: Path, verbose: bool = False) -> dict:
    """Load and validate a Boutiques JSON file."""
    if verbose:
        print(f"Loading {file_path}...")

    if not file_path.exists():
        raise FileNotFoundError(f"Input file not found: {file_path}")

    if not file_path.suffix.lower() == ".json":
        raise ValueError(f"Input file must be a JSON file: {file_path}")

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {file_path}: {e}")


def create_ir_interface(
    json_data: dict,
    package_name: str,
    package_title: str | None = None,
    package_description: str | None = None,
    package_authors: list[str] | None = None,
    package_literature: list[str] | None = None,
    package_urls: list[str] | None = None,
    optimize_ir: bool = True,
    verbose: bool = False,
) -> ir.Interface:
    """Create IR interface from Boutiques JSON data."""
    if verbose:
        print(f"Creating IR interface for package '{package_name}'...")

    # Create documentation object with all fields
    docs = ir.Documentation(
        title=package_title,
        description=package_description,
        authors=package_authors or [],
        literature=package_literature or [],
        urls=package_urls or [],
    )

    ir_interface = from_boutiques(json_data, package_name=package_name, package_docs=docs)

    if optimize_ir:
        if verbose:
            print("Optimizing IR...")
        ir_interface = optimize(ir_interface)

    return ir_interface


def compile_and_output(
    ir_interface: ir.Interface,
    backends: list[BACKEND_ID_TYPE],
    output_dir_user: Path | None = None,
    dry_run: bool = False,
    force: bool = False,
    verbose: bool = False,
) -> None:
    """Compile IR interface to target backends and write files or print to stdout."""
    # If no output directory, print to stdout
    print_to_stdout = output_dir_user is None
    output_dir = output_dir_user if output_dir_user is not None else Path()

    if output_dir_user is not None:
        output_dir_user.mkdir(parents=True, exist_ok=True)

    for backend in backends:
        if verbose and not print_to_stdout:
            print(f"Compiling to {backend}...")

        try:
            compiled_files = list(compile_language(backend, [ir_interface]))

            for compiled_file in compiled_files:
                if print_to_stdout:
                    if len(backends) > 1:
                        print(f"\n# Backend: {backend}")
                    print(compiled_file)
                    continue

                output_path = output_dir / compiled_file.path

                # If multiple backends, prefix with backend subdirectory
                if len(backends) > 1:
                    output_path = output_dir / backend / compiled_file.path

                if dry_run:
                    print(f"Would create: {output_path}")
                    continue

                # Check if file exists and not forcing
                if output_path.exists() and not force:
                    response = input(f"File {output_path} exists. Overwrite? (y/N): ")
                    if response.lower() != "y":
                        print(f"Skipped: {output_path}")
                        continue

                # Create directory if needed
                output_path.parent.mkdir(parents=True, exist_ok=True)

                # Write file
                with open(output_path, "w", encoding="utf-8") as f:
                    f.write(compiled_file.content)

                if verbose:
                    print(f"Created: {output_path}")

        except Exception as e:
            print(f"Error compiling to {backend}: {e}", file=sys.stderr)
            continue


def main() -> int:
    """Main CLI entry point."""
    parser = setup_parser()
    args = parser.parse_args()

    # Handle list backends
    if args.list_backends:
        list_backends()
        return 0

    # Check for required input files when not listing backends
    if not args.input_files:
        print("Error: input_files are required", file=sys.stderr)
        parser.print_help()
        return 1

    # Validate backends
    if not args.backend:
        print("Error: --backend is required", file=sys.stderr)
        parser.print_help()
        return 1

    try:
        backends = parse_backends(args.backend)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    # Process each input file
    for input_file in args.input_files:
        if args.verbose:
            print(f"\nProcessing {input_file}...")

        try:
            # Load JSON data
            json_data = load_boutiques_file(input_file, args.verbose)

            # Determine package name
            package_name = args.package_name or input_file.stem

            # Create IR interface
            ir_interface = create_ir_interface(
                json_data=json_data,
                package_name=package_name,
                package_title=args.package_title,
                package_description=args.package_description,
                package_authors=args.package_authors,
                package_literature=args.package_literature,
                package_urls=args.package_urls,
                optimize_ir=not args.no_optimize,
                verbose=args.verbose,
            )

            # Compile and output
            compile_and_output(
                ir_interface=ir_interface,
                backends=backends,
                output_dir_user=args.output_dir,
                dry_run=args.dry_run,
                force=args.force,
                verbose=args.verbose,
            )

        except Exception as e:
            print(f"Error processing {input_file}: {e}", file=sys.stderr)
            continue

    if not args.dry_run and args.output_dir:
        print(f"\nCompleted! Output written to {args.output_dir}")
    elif not args.output_dir and not args.dry_run:
        if args.verbose:
            print("\nCompleted! Output printed to stdout", file=sys.stderr)

    return 0


def cli() -> None:
    """CLI entry point for package installation."""
    sys.exit(main())


if __name__ == "__main__":
    cli()
