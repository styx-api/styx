# Styx <img src="docs/logo.svg" align="right" width="25%"/>

[![Build](https://github.com/childmindresearch/styx/actions/workflows/test.yaml/badge.svg?branch=main)](https://github.com/childmindresearch/styx/actions/workflows/test.yaml?query=branch%3Amain)
[![codecov](https://codecov.io/gh/childmindresearch/styx/branch/main/graph/badge.svg?token=22HWWFWPW5)](https://codecov.io/gh/childmindresearch/styx)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
![stability-wip](https://img.shields.io/badge/stability-work_in_progress-lightgrey.svg)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/childmindresearch/styx/blob/main/LICENSE)
[![pages](https://img.shields.io/badge/api-docs-blue)](https://childmindresearch.github.io/styx)

Command line tool wrapper compiler.

Compile Python command line tool wrappers from JSON metadata.
Supports a superset of the [Boutiques](https://boutiques.github.io/) descriptor format, and generates idiomatic Python
(3.10+) wrappers with type hints, argument parsing, and documentation. Generated code only depends on the Python
standard library (and on shared type definition). Runtimes are decoupled via dependency-injection.

## The Styx-verse

### Documentation

- [Styx Book](https://childmindresearch.github.io/styxbook/)
- [Styx Playground](https://childmindresearch.github.io/styxplayground/)

### Precompiled wrappers

- [Neuroimaging](https://github.com/childmindresearch/niwrap)

### Runtimes

- [Docker](https://github.com/childmindresearch/styxdocker)
- [Singularity](https://github.com/childmindresearch/styxsingularity)

### Middleware

- [Graph generation](https://github.com/childmindresearch/styxgraph)


## Installation

Styx is not needed to run the generated wrappers, but is required to compile them.

```bash
pip install git+https://github.com/styx-api/styx.git
```

## License

Styx is MIT licensed. The license of the generated wrappers depends on the input metadata.
