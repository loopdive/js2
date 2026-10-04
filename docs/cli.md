# CLI Reference

`js2wasm` compiles a single TypeScript or JavaScript entry file to a WebAssembly
GC module, plus auxiliary outputs (WAT, `.d.ts`, imports helper, optionally
WIT).

```text
Usage: js2wasm <input.ts> [options]
```

For a guided walkthrough, see [`docs/getting-started.md`](getting-started.md).

## Output files

Every successful compile writes the following into the current working
directory (or into `--out <dir>`) — not next to the input file:

| File | Default | Disable with |
|------|---------|--------------|
| `<name>.wasm` | always | (binary is always emitted unless `--wat` is passed) |
| `<name>.wat` | yes | `--no-wat` |
| `<name>.d.ts` | yes | `--no-dts` |
| `<name>.imports.js` | yes | (always emitted) |
| `<name>.wit` | no | enable with `--wit` |

## Output flags

### `-o, --out <dir>`

Output directory; `--out=<dir>` also works. Defaults to the current working
directory (#2816). Writing
beside the input was a footgun for inputs that live inside the installed package
(e.g. an example under `node_modules/@loopdive/js2/examples/...`), which would
dump artifacts into `node_modules`.

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

### `--wit-package <p>`

Package name for the `--wit` output, as `ns:name[@version]`. Implies `--wit`.
Defaults to `js2wasm:<input-basename>`. `--wit-package=<p>` also works.

```bash
js2wasm api.ts --wit-package acme:math@1.0.0
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

The single host/output axis (#2736); `--target=<t>` also works. Host values
pick the ambient global surface the program type-checks against; backend
values pick the lowering.

| Value | Kind | Description |
|-------|------|-------------|
| `web` (default) | host | WasmGC / JS-host module; DOM ambient globals in scope. |
| `node` | host | WasmGC / JS-host module for a real Node host (Node ambient surface, no DOM). |
| `deno` | host | WasmGC / JS-host module for a real Deno host (Deno ambient surface, no DOM). |
| `wasi` | host + backend | Standalone WASI Preview 1 module: imports `fd_write` / `proc_exit` instead of JS host functions. |
| `gc` | backend | WasmGC with JS host imports for builtins — the default backend for `web` / `node` / `deno`. |
| `linear` | backend | Linear-memory module (no WasmGC). |
| `standalone` | backend | Pure WasmGC, no JS host and no WASI imports. Same as `--standalone`. |

```bash
js2wasm hello.ts --target wasi
```

The WASI target auto-enables native (WasmGC i16) string arrays in place of
`wasm:js-string` builtins, so the binary runs in any WASI host without JS glue.

To **run** the resulting `.wasm` — the exact Wasmtime `-W` proposal flags (and
the `all-proposals` caveat), plus `bun -b` and Deno — see the runtime matrix in
[Standalone I/O → Running the output across runtimes](./standalone-io.md#running-the-output-across-runtimes).

### `--standalone`

Shorthand for `--target standalone`: pure WasmGC, no JS host, no WASI. Forces
native (WasmGC i16) strings and refuses to emit `wasm:js-string` or `env`
JS-host imports. Cannot be combined with `--allow-fs`.

### `--allocator <bump|arena-reset>`

Linear-backend allocator (#1856); requires `--target linear`. `bump` (default)
is an allocate-and-exit arena with the smallest binary. `arena-reset` reclaims
between primitive-only exported calls; aggregate or global escapes fall back,
and explicit `__arena_reset` / `__arena_used` exports are kept.

### `--utf8-storage`

Dual i8/i16 string storage (#1588): strings proven UTF-8 (literals, JSON,
decoder results, …) are stored i8-backed for a cheaper Component Model
boundary. Implies native strings on the WasmGC backend. Off by default; output
is byte-identical when off.

### `--semantic-providers <auto|native-first>`

Semantic implementation policy (#4397). `auto` (default) preserves
compatibility; `native-first` selects the migrated Wasm-native provider
families even under a JS host. It does not disable JS boundary wrappers or
platform APIs.

### `--link <ns>`

Leave the external namespace `<ns>` as link-time imports instead of
inline-lowering it (repeatable; `--link=<ns>` also works). The imports are
satisfied at instantiation by a preloaded provider module (e.g.
`wasmtime --preload <ns>=provider.wasm`). On WASI, `--link node:fs` also
selects the import-and-link std-IO path: stream IO goes through
`node:fs` `readSync` / `writeSync` and its memory instead of
`wasi_snapshot_preview1`. Off by default — every namespace is inline-lowered
into a self-contained module.

### `--package-linking <separate|merge|off>`

How npm package imports are compiled for a project (`--package-linking=<mode>`
also works). `separate` compiles each package to its own cached provider
module and instantiates it alongside the consumer, keeping the consumer's
compiler errors authoritative (no bundled retry). `merge` statically combines
the providers into one binary with Binaryen `wasm-merge`. `off` compiles the
whole project as one source bundle. Without the flag, the CLI uses the
single-file path unless the entry has a relative import; the project API
(`compileProject()`) defaults to automatic linking with a compatibility
fallback.

### `--cache-dir <dir>`

Where `--package-linking` caches the compiled provider module of each npm
package (content-addressed, safe to delete). `--cache-dir=<dir>` also works.
By default the cache goes to the nearest ancestor's
`node_modules/.cache/js2wasm/npm-modules`, or — when no `node_modules` exists —
to the OS user cache directory (`$XDG_CACHE_HOME` or `~/.cache` on Linux,
`~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows) under
`js2wasm/npm-modules`. It is never written next to your source files.

### `--host-bridge <auto|always|off>`

Controls whether the module exports the **host bridge** — the interop surface a
**JavaScript** host uses to reach inside WasmGC values it cannot otherwise read:
`__vec_*` (materialize arrays), `__sget_*` / `__sset_*` (compiled-struct fields;
a plain `obj.field` on a WasmGC struct yields `undefined`), `__call_fn*`
(invoke closures), `__exn_render_*` (render a natively-thrown payload),
`__stdout_*` (drain the host-free print sink).

| Value | Effect |
|-------|--------|
| `auto` (default) | On for js-host targets, **off** for `wasi` / `standalone`. |
| `always` | Always publish it — what a JS harness that inspects the module needs. |
| `off` | Never publish it. |

These exports are the **calling convention** in js-host mode, not debug
information: `src/runtime.ts` cannot materialize an array or read a struct field
without them. But a `wasi` / `standalone` binary runs under a JS-free host
(wasmtime), where the only consumers are inspection tools — and because exports
are GC roots, `wasm-opt` cannot strip anything they transitively pin. A
standalone program that returned one array used to ship ~21 kB of
float-formatting tables it never called.

```bash
# a deployable pure-Wasm binary — the default for this target
js2wasm hello.ts --target wasi -O3

# same program, but a JS harness will inspect it afterwards
js2wasm hello.ts --target wasi -O3 --host-bridge always
```

If you instantiate a standalone module **from JavaScript** and read its values,
pass `--host-bridge always` (or `hostBridge: "always"` to `compile()`). Every
consumer guards each access with a `typeof exports.__x === "function"` check, so
a missing bridge degrades rather than throws — which means the symptom is
silently wrong output, not a crash. Ask for it explicitly.

## Host-surface flags

`--host-bridge` is documented under [Target flags](#--host-bridge-autoalwaysoff).

### `--emulate <node|none>`

Emulate a host runtime's globals so they type-check without `@types/node`.
`node` adds an ambient `process` and friends; `none` turns emulation off.
Emulation is type-level only and never changes the emitted Wasm. It is
auto-enabled when the source imports a `node:` builtin (pass `--emulate none`
to stop that); otherwise it is off, and using `process` warns you to add the
flag (#2603).

### `--no-host-imports`

Strict dual-mode: reject any JS-host `env` import that is not on the allowlist
(#1524). Implied by `--target wasi`.

### `--allow-host-imports`

Debug-only escape hatch that turns strict dual-mode off for a WASI build, for
temporarily mixing host and WASI imports while migrating a program.

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

### `--skip-semantic-diagnostics`

Skip TypeScript's **semantic** checking. Syntax errors still fail the compile;
only the type-diagnostic gate is skipped, and type *queries* keep working, so
codegen is unaffected.

This exists for compiling **plain JavaScript packages**. A real npm package run
through strict-mode type-checking reports a wall of legitimate-but-irrelevant
diagnostics that abort the compile even though codegen would have succeeded —
acorn 8.16.0, for instance, fails on 5 `Type 'null' is not assignable to type
'undefined'`-style errors under hundreds of `Property does not exist on type`
warnings (#3717). The option has always existed on the programmatic API
(`compile(src, { skipSemanticDiagnostics: true })`), and every dogfood harness
that compiles a real package sets it; this flag is the CLI's way in.

```bash
js2wasm node_modules/acorn/dist/acorn.mjs --skip-semantic-diagnostics -o dist/
```

Do not reach for it to silence diagnostics on your own TypeScript — there the
errors are usually real.

### `--ts7`

Use TypeScript 7 (the Go port) as the parser/checker frontend. Experimental;
full migration tracked in issue #1029. Equivalent to setting `JS2WASM_TS7=1` in
the environment. The compiler loads it from the `typescript7` npm alias, so
install it as `pnpm add -D typescript7@npm:typescript@^7` (or the npm/yarn
equivalent).

```bash
js2wasm src/main.ts --ts7
```

## Informational flags

### `--explain`, `js2wasm explain <input.ts>`

Print the compiler-owned provider/capability report for the input and write no
artifacts. The `explain` subcommand is the same thing.

### `--explain-json`

Print that report as stable, schema-versioned JSON. `js2wasm explain <input.ts>
--json` is equivalent.

### `-v, --verbose`

List every dropped host-import warning individually instead of collapsing
them into a one-line summary (WASI/strict mode, #2520).

### `-q, --quiet`

Suppress the post-compile "how to run" hint.

### `-V, --version`

Print the package version and exit. The short form is a capital `V`; lower-case
`-v` is `--verbose`.

### `-h, --help`

Show the usage help and exit.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Compile succeeded. Warnings, and any error-severity diagnostics the compiler tolerated, may still print to stderr. |
| `1` | Compile failed, the emitted module failed validation, the input file could not be read, or invalid CLI options. |

Compile errors print as `path:line:column - error: message`, one per line.

**Tolerated errors.** Some TypeScript type errors do not affect code
generation — e.g. TS2678 on a `switch` case that can never match. The compiler
still produces a valid module, so the CLI writes its outputs and exits `0`, but
it prints every such diagnostic in the same `path:line:column - error:` form,
followed by a one-line `note:` with their count. Treat them as you would a
`tsc` error: the program compiled, but probably not the way you meant.

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
