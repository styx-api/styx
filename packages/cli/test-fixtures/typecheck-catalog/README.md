# Codegen typecheck catalog

A small curated catalog whose **generated code is type-checked in CI**. The
`codegen-typecheck` CI job (and `npm run typecheck:codegen` locally) generates
Python + TypeScript from this catalog and runs `mypy --strict` and
`tsc --noEmit` over the output via [`scripts/typecheck-codegen.mjs`](../../../../scripts/typecheck-codegen.mjs).

This complements the string-matching unit tests: those pin specific emitted
shapes, but only running the real type-checkers proves the generated code
actually type-checks. It catches whole classes of bugs the unit tests miss -
declaration ordering / forward references, optional-omit `NotRequired`,
union-output `never` collapses, indexability.

## Tools

| Tool           | Shape it guards                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dwi2response` | Vendored mrtrix descriptor: a discriminated union of sub-command structs where several variants share a nested literal-union field (`wm_algo`). This nested-union-inside-union ordering regressed the Python backend (NameError at import + ~200 mypy errors) and is fixed by the type-declaration topological sort. |
| `shapes`       | Scalars (int/float/str/file), an optional boolean flag, a required list (`list[float]`), an optional repeatable list, optional-without-default fields (the `typing.NotRequired` path), and an output file.                                                                                                           |

## Adding a fixture

1. Add an app directory under `suite/1.0/<name>/` with an `app.json`
   (`source.path` pointing at a colocated descriptor) and the descriptor file.
2. List `<name>` in `suite/1.0/version.json`'s `apps` array.
3. Run `npm run typecheck:codegen` and confirm it stays green.

Prefer the smallest descriptor that exercises a distinct codegen path; vendor a
real descriptor when a shape is hard to hand-write (as with `dwi2response`).
