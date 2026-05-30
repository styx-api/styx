# Architecture

A compiler for CLI interface specifications. Parses CLI definitions from various sources, optimizes the intermediate representation, solves for minimal parameter bindings, and generates typed wrappers and schemas for multiple target languages.

## Pipeline

```mermaid
flowchart LR
    subgraph Frontend
        F1[Boutiques]
        F2[Argparse]
        F3[...]
    end

    subgraph IR
        IR1[Expr Tree]
        IR2[Passes]
    end

    subgraph Solver
        S1[Solve]
        S2[Bindings]
    end

    subgraph Backend
        B1[TypeScript]
        B2[Python]
        B3[JSON Schema]
        B4[Boutiques]
        B5[R]
    end

    F1 & F2 & F3 --> IR1
    IR1 --> IR2 --> S1 --> S2

    S2 --> B1 & B2 & B3 & B4 & B5
    IR2 -.-> B1 & B2 & B3 & B4
```

## Core Concepts

| Module        | Purpose                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **ir**        | Canonical expression tree (Expr = Literal \| Sequence \| Alternative \| Optional \| Repeat \| Int \| Float \| Str \| Path) |
| **ir/passes** | Optimization passes: flatten, simplify, canonicalize, remove-empty                                                         |
| **bindings**  | Solved types (BoundType = scalar \| bool \| count \| literal \| optional \| list \| struct \| union)                       |
| **solver**    | IR → Bindings via pattern matching                                                                                         |
| **manifest**  | Optional metadata: Project > Package > App                                                                                 |
| **frontend**  | Parsers producing IR                                                                                                       |
| **backend**   | Code generators consuming IR + Bindings                                                                                    |

## Solver Patterns

| IR Pattern              | BoundType            |
| ----------------------- | -------------------- |
| `optional<literal>`     | `bool`               |
| `repeat<literal>`       | `count`              |
| `optional<T>`           | `optional<solve(T)>` |
| `repeat<T>`             | `list<solve(T)>`     |
| `sequence<...named...>` | `struct<...>`        |
| `alternative<...>`      | `union<...>`         |
| terminal                | `scalar`             |

## Design Philosophy

The key architectural improvement over Styx 1 is a clean separation of concerns for backends:

- **Solved bindings -> parametrization** - the solver (`solver/solver.ts`) walks the IR once and pattern-matches into a `BoundType` tree (bool, count, optional, list, struct, union, etc.). Backends translate these into the typed parameter interface that users interact with.
- **IR -> argument building logic** - the expr tree describes how to construct the command line (sequences, optionals, alternatives, literals). Backends translate the IR into runtime code that assembles CLI invocations, pulling values from the solved parameters to fill each slot.

The IR is the skeleton of the command line; the bindings define the typed interface; the argument builder walks the IR and pulls from the parametrization to assemble the final invocation. In Styx 1, these concerns were entangled - each backend had to re-derive types from the IR via a complex `LanguageProvider` protocol. In Styx 2, backends receive both pieces pre-computed and just translate them into target language constructs.

### Solver-owned facts

The solver attaches everything a backend needs to a binding during the same walk that produces it, so backends never re-derive structural facts from the IR. Each `Binding` carries three:

- **`type`** (`BoundType`) - the typed shape, for the parameter interface.
- **`gate`** (`GateAtom[]`) - the wrapper layers from the root (`present` / `variant` / `iter`), so "is this binding conditionally active, and under what?" is pure data. Backends nest guards/loops in array order.
- **`access`** (`AccessPath`) - where the binding's value lives relative to top-level `params`, as a segment list (`field(name)` | `iter(repeatBinding)`). A tiny per-language `renderAccess` turns it into `params.foo.bar` (TS) / `params["foo"]["bar"]` (Python); an `iter` segment resolves to the loop variable for that repeat. Assigned by a post-solve pass (`solver/assign-access.ts`) once all types have settled.

`access` exists because the answer to "where does binding X live" was previously re-derived independently by the cargs builder and the outputs emitter, which drifted. Computing it once in the solver collapses both into a pure lookup; any future consumer (validators, codecs, completion) inherits it for free. Notably the segment set needs only `field` and `iter` - complex-union variant fields are plain `field` segments off the union's path (the `@type` discriminant lives in `gate`, not the access path), and wrapper collapses like `optional<scalar>` are expressed by a binding inheriting its parent's path.

## Styx 1 vs Styx 2

|                     | Styx 1 (Python)                                                                          | Styx 2 (TypeScript)                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **IR**              | Dataclass hierarchy (`Param[T]` with body types)                                         | Algebraic expr tree with `kind` discriminant                                                                                   |
| **Optimization**    | Minimal (string merging)                                                                 | Pass-based pipeline (flatten, simplify, canonicalize)                                                                          |
| **Type resolution** | Direct mapping in frontend; each backend re-derives types via language provider protocol | Solver produces a universal `BoundType` tree; backends just translate it                                                       |
| **Backends**        | Python mature, TS/R partial; each implements a complex `LanguageProvider` protocol       | TypeScript, JSON Schema, Python, Boutiques complete; R deferred; backends just translate solved bindings                       |
| **Output files**    | First-class: path templates with param refs, suffix stripping, fallbacks                 | First-class via gate-on-binding: scope-by-IR-node bucketing, `ResolvedOutput` with path templates, suffix stripping, fallbacks |

Styx 2 is an evolved **successor** to Styx 1, not a drop-in replacement: the goal is to cover all of Styx 1's functionality while improving on its design, so breaking changes from Styx 1's output shape are expected and acceptable. Styx 1 functionality not yet implemented in Styx 2:

- **Stream outputs** (`stdout-output` / `stderr-output`) - Boutiques parse path exists, downstream IR shape not yet wired
- **Mutable inputs** - tools that overwrite their input file (Boutiques `x-styx-mutable`) - solver and runner integration pending
- **Boutiques constraint groups** - mutual exclusion, value-disables, value-requires - serialized round-trip deferred

## Roadmap

Long-term, Boutiques shifts from being the primary frontend to primarily a **backend** (for cross-compatibility and bootstrapping NiWrap onto the new compiler). Planned frontends:

- **Custom TypeScript-types-like language** - the intended primary way to define CLI specs
- **Serialized Python argparse** - parse argparse definitions
- **Boutiques** (current) - remains as both a frontend and a backend

## Ecosystem Context

This compiler is part of the **Styx/NiWrap ecosystem** ([niwrap.dev](https://niwrap.dev/)):

- **Styx compiler** (this repo) - generates type-safe bindings from CLI tool descriptions
- **NiWrap** - Boutiques descriptors for ~2,000 neuroimaging tools (FSL, FreeSurfer, ANTs, AFNI, MRTrix3, etc.) plus a build pipeline that feeds them through Styx to produce language-specific packages
- **NiWrap packages** - generated Python/TypeScript/R wrappers with IDE autocompletion and type checking
- **NiWrap Hub** - interactive web platform for exploring tools and generating code
