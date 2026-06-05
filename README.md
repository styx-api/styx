# Styx2

Next-generation [Styx](https://github.com/childmindresearch/styx) compiler - parses CLI tool specifications (e.g. Boutiques descriptors), optimizes an intermediate representation, and generates type-safe wrappers for multiple target languages. Part of the [Styx/NiWrap ecosystem](https://niwrap.dev/).

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
styx2/
├── packages/core/    # @styx-api/core - compiler library
├── playground/       # Svelte interactive compiler explorer
└── ...
```
