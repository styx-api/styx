# compile-argdump action

A reusable GitHub composite action that compiles an [argdump](https://niwrap.dev/)
descriptor into target-language wrappers using the published
[`@styx-api/cli`](https://www.npmjs.com/package/@styx-api/cli). It runs the
standard compile pipeline (with the default optimization passes: flatten →
remove-empty → simplify, run to fixpoint) and, by default, emits a **Boutiques
descriptor**.

No source build is required - the action `npx`-runs the published CLI.

## Usage

```yaml
- name: Compile argdump to Boutiques
  id: styx
  uses: styx-api/styx2/.github/actions/compile-argdump@main
  with:
    argdump-file: path/to/my_tool_dump.json

- name: Use the descriptor
  run: cat "${{ steps.styx.outputs.descriptor }}"
```

Upload the result as an artifact:

```yaml
- uses: styx-api/styx2/.github/actions/compile-argdump@main
  id: styx
  with:
    argdump-file: path/to/my_tool_dump.json
- uses: actions/upload-artifact@v4
  with:
    name: descriptor
    path: ${{ steps.styx.outputs.output-dir }}
```

## Inputs

| Input          | Required | Default     | Description                                                                                                                        |
| -------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `argdump-file` | yes      | -           | Path to the argdump JSON file to compile.                                                                                          |
| `backend`      | no       | `boutiques` | Backend(s) to emit, comma-separated. Known: `python`, `typescript`, `ts`, `schema`, `json-schema`, `boutiques`, `nipype`, `pydra`. |
| `output-dir`   | no       | `styx-out`  | Output directory. Per-backend files land in `<output-dir>/<backend>/`.                                                             |
| `mode`         | no       | `scripts`   | Emit tiers: `scripts` (app only) \| `single` (+ package) \| `multi` (+ project).                                                   |
| `styx-version` | no       | `latest`    | Version of `@styx-api/cli` to run (npm dist-tag or exact version). Pin for reproducible builds.                                    |
| `node-version` | no       | `22`        | Node.js version to set up.                                                                                                         |

## Outputs

| Output       | Description                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output-dir` | Directory the generated files were written to.                                                                                                           |
| `descriptor` | Path to the generated Boutiques descriptor (`<output-dir>/boutiques/descriptor.json`). Meaningful only when `boutiques` is among the requested backends. |

## Notes

- Pin `styx-version` (e.g. `0.5.0`) for reproducible output; `latest` tracks the newest published CLI.
- The action's output layout follows `styx build`: each backend writes under its own subdirectory of `output-dir`.
