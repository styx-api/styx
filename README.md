# Styx

The Styx compiler (v2) - parses CLI tool specifications (e.g. Boutiques descriptors), optimizes an intermediate representation, and generates type-safe wrappers for multiple target languages. Part of the [Styx/NiWrap ecosystem](https://niwrap.dev/). The legacy v1 Python compiler lives at [styx-legacy](https://github.com/styx-api/styx-legacy).

Early development. See [ARCHITECTURE.md](ARCHITECTURE.md) for design details.

## Development

```bash
npm install
npm run build
npm test
```

### Watch mode

```bash
# Terminal 1: Watch core library
npm run dev -w @styx-api/core

# Terminal 2: Run playground
npm run dev
```

## Project Structure

```
styx/
├── packages/core/    # @styx-api/core - compiler library
├── playground/       # Svelte interactive compiler explorer
└── ...
```
