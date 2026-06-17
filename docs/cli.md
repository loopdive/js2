# CLI Reference

`js2wasm` compiles a single TypeScript or JavaScript entry file to a WebAssembly
GC module, plus auxiliary outputs (WAT, `.d.ts`, imports helper, optionally
WIT).

```text
Usage: js2wasm <input.ts> [options]
```

For a guided walkthrough, see [`docs/getting-started.md`](getting-started.md).

## Output files

Every successful compile writes the following alongside the input (or in
`--out <dir>`):

| File | Default | Disable with |
|------|---------|--------------|
| `<name>.wasm` | always | (binary is always emitted unless `--wat` is passed) |
| `<name>.wat` | yes | `--no-wat` |
| `<name>.d.ts` | yes | `--no-dts` |
| `<name>.imports.js` | yes | (always emitted) |
| `<name>.wit` | no | enable with `--wit` |

## Output flags

### `-o, --out <dir>`

Output directory. Defaults to the directory of the input file.

```bash
js2wasm src/main.ts -o dist/
```

### `--wat`

Emit only the WebAssembly text format to stdout. No `.wasm` / `.d.ts` /
`.imports.js` are written. Useful for inspecting codegen.

```bash
js2wasm add.ts --wat | less
```

### `--no-wat`

Skip the `<name>.wat` output. The binary, `.d.ts`, and imports helper still
emit.

### `--no-dts`

Skip the `<name>.d.ts` output.

### `--wit`

Also generate a `<name>.wit` interface file alongside the binary. The WIT
describes the module's exports for use with the WebAssembly Component Model.

```bash
js2wasm api.ts --wit
```

## Optimization flags

Optimization is **on by default** (`-O3`): a bare `js2wasm build.ts` runs
Binaryen's `wasm-opt` over the compiled binary. If `wasm-opt` is not available
in your environment, the compiler emits a one-line warning and ships the
unoptimized binary — it never fails.

> The default flip applies to the **CLI only**. The programmatic `compile()`
> API still defaults to no optimization (pass `{ optimize: 3 }` to opt in), so
> embedding js2wasm has no surprise behaviour change.

### `-O, --optimize`

Explicitly request optimization at the default level (`-O3`). Redundant now
that optimization is on by default, but kept for clarity and scripts.

```bash
js2wasm add.ts -O
```

### `--no-optimize`, `-O0`

Disable the optimizer and emit raw codegen output (the pre-default-on
behaviour). Useful for inspecting unoptimized codegen or for byte-stable
diffs.

```bash
js2wasm add.ts --no-optimize
```

### `-O1` .. `-O4`

Pick an explicit optimization level. `-O1` is fastest to compile; `-O4` is the
most aggressive. `-O3` is the default level used by bare `-O` and by default.

```bash
js2wasm add.ts -O2
```

## Target flags

### `--target <t>`

Compilation target. One of:

| Value | Description |
|-------|-------------|
| `gc` (default) | Emit a WasmGC module with JS host imports for builtins. |
| `linear` | Emit a linear-memory module (no WasmGC; broader host compatibility). |
| `wasi` | Emit a WASI module that imports `fd_write` / `proc_exit` instead of JS host functions. |

```bash
js2wasm hello.ts --target wasi
```

The WASI target auto-enables native (WasmGC i16) string arrays in place of
`wasm:js-string` builtins, so the binary runs in any WASI host without JS glue.

## Permission flags

### `--allow-fs`

Permit `node:fs` host imports (`readFileSync`, `writeFileSync`) for non-WASI
targets. Off by default to keep the import surface minimal and prevent
accidental capability leakage.

```bash
js2wasm script.ts --allow-fs
```

This flag is implicit when `--target wasi` is set; WASI hosts gate filesystem
access through preopened directories rather than `--allow-fs`.

## Define / mode flags

### `--define K=V`

Substitute identifier path `K` with literal value `V` before parsing.
Repeatable. The value must be a JavaScript literal — string values must include
their own quotes.

```bash
js2wasm src/main.ts \
  --define process.env.NODE_ENV='"production"' \
  --define DEBUG=false
```

Equivalent syntax: `--define=K=V`.

### `--mode <m>`

Shorthand for a common bundle of `--define`s. One of:

| Mode | Substitutions |
|------|---------------|
| `production` | `process.env.NODE_ENV="production"`, `typeof process="undefined"`, `typeof window="undefined"` |
| `development` | `process.env.NODE_ENV="development"` |

```bash
js2wasm src/main.ts --mode production -O3
```

Useful for stripping development-only branches at compile time.

## Frontend flags

### `--ts7`

Use `@typescript/native-preview` (TypeScript 7 Go-port) as the parser/checker
frontend. Preview; full migration tracked in issue #1029. Equivalent to setting
`JS2WASM_TS7=1` in the environment.

```bash
js2wasm src/main.ts --ts7
```

## Informational flags

### `-v, --version`

Print the package version and exit.

### `-h, --help`

Show the usage help and exit.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Compile succeeded (warnings may still print to stderr). |
| `1` | Compile failed, or invalid CLI options. |

Compile errors print as `path:line:column - error: message`, one per line.

## Examples

Minimal compile:

```bash
js2wasm add.ts
```

Production build, optimized, with WIT interface:

```bash
js2wasm src/api.ts -o dist/ -O3 --wit --mode production
```

WASI command-line tool:

```bash
js2wasm tools/hello.ts --target wasi -O2
wasmtime tools/hello.wasm
```

Inspect generated WAT for a single file:

```bash
js2wasm scratch.ts --wat | head -80
```
