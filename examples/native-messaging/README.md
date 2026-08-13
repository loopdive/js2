# Native Messaging host, compiled by js2wasm to standalone WASI

[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
protocol lets a browser extension talk to a native binary on the user's
machine. The browser launches the host process and exchanges messages over the
process's **stdin** and **stdout**, framing each message as a **4-byte
little-endian length prefix** followed by a **UTF-8 JSON body**.

This is a natural fit for `--target wasi`: compile a TypeScript host to a single
`.wasm`, run it under `wasmtime`/`wasmer`, and point the browser at a thin wrapper
script. This directory contains:

```
examples/native-messaging/
  nm_js2wasm_wasi_p1.ts       ← host via RAW wasi_snapshot_preview1 fd_read/fd_write
  nm_js2wasm_node_fs.ts       ← host via synchronous node:fs readSync/writeSync
  nm_js2wasm_node_process.ts  ← host via async process.stdin Readable + process.stdout.write
  nm_js2wasm_deno.ts          ← host via the Deno stdio surface (lands separately)
  nm_js2wasm_wasi_p3.ts       ← host via the WASI Preview 3 spike (lands separately)
  README.md           ← this file
  nm_js2wasm_node_fs.json     ← Native host manifest template
  manifest.json       ← Web extension manifest
  nm_js2wasm_node_fs.sh       ← wasmtime/wasmer wrapper the browser invokes
  background.js       ← MV3 Web extension background `ServiceWorker` script
```

## Five hosts, one wire protocol — a comparison

The point of this directory is a side-by-side comparison: the **same** echo host
(read a framed message off stdin, write the framed echo to stdout) written
against **five different host surfaces**. They all speak the identical Native
Messaging wire protocol, so a single framed request comes back **byte-identical**
from every one (pinned by [`tests/native-messaging-comparison.test.ts`](../../tests/native-messaging-comparison.test.ts)).
What differs is the API each reaches for to touch stdio — and therefore the wasm
imports it emits, whether the read loop is synchronous or event-driven, and which
runtimes can launch the result. The original report ([loopdive/js2wasm#389](https://github.com/loopdive/js2wasm/issues/389))
asked for a host that runs under a WASI runtime, "not chasing Node.js" — the raw
`nm_js2wasm_wasi_p1.ts` is that answer; the others show the same protocol expressed through
progressively higher-level (and more Node-shaped) surfaces.

| Variant                                                      | Host surface                                    | Source import                                                                              | Sync or async                                                  | Emitted wasm imports                                                                    | Runs natively under                                       | Compiles to                                                         |
| ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| [`nm_js2wasm_wasi_p1.ts`](./nm_js2wasm_wasi_p1.ts)           | Raw WASI Preview 1 syscalls over linear memory  | `wasi_snapshot_preview1` (`fd_read`/`fd_write`) + `wasm:memory` (intrinsic, lowers inline) | **sync** — blocking `fd_read`/`fd_write` loop                  | only `wasi_snapshot_preview1`                                                           | `wasmtime` / `wasmer` / `wazero`                          | standalone WASI P1 command module (owns + exports its own `memory`) |
| [`nm_js2wasm_node_fs.ts`](./nm_js2wasm_node_fs.ts)           | Node synchronous `node:fs` fd IO                | `node:fs` (`readSync`/`writeSync`)                                                         | **sync** — `readSync`/`writeSync` read-until loop              | only `wasi_snapshot_preview1` (inlined); or a `node:fs` interface with `--link node:fs` | `wasmtime` **and** unmodified under real `node`           | standalone WASI P1 command module (or a `node:fs`-linkable module)  |
| [`nm_js2wasm_node_process.ts`](./nm_js2wasm_node_process.ts) | Node async streaming stdio                      | `process.stdin` (global) Readable + `process.stdout.write`                                 | **async** — event-driven `'data'`/`'end'`, incremental framing | only `wasi_snapshot_preview1`                                                           | `wasmtime` (drives the injected fd0 reactor / event loop) | standalone WASI P1 command module with an event loop                |
| [`nm_js2wasm_deno.ts`](./nm_js2wasm_deno.ts)                 | Deno stdio surface (`Deno.stdin`/`Deno.stdout`) | _(lands separately)_                                                                       | sync (`readSync`/`writeSync`)                                  | _(WASI-targeted; filled in when it lands)_                                              | Deno / a WASI runtime                                     | standalone WASI module                                              |
| [`nm_js2wasm_wasi_p3.ts`](./nm_js2wasm_wasi_p3.ts)           | WASI Preview 3 async streams                    | _(lands separately)_                                                                       | **async** — P3 stream reads                                    | WASI Preview 3 component interfaces                                                     | a Preview-3 / component-capable runner                    | WASI Preview 3 component                                            |

The bottom two rows are pre-filled descriptively; the comparison test
**discovers** variant files on disk and picks them up automatically as they land,
running each that lowers to a standalone WASI command module and asserting the
byte-identical echo (the P3 component variant, which needs its own runner, is
skipped gracefully).

> **Why `nm_js2wasm_node_process.ts` writes a `Uint8Array`, not a string.** Its
> `process.stdin` `'data'` chunks arrive as strings (one char per raw byte), but
> the framed response is written via `process.stdout.write(uint8Array)` so the
> binary 4-byte length prefix and any high body byte go out verbatim — a string
> argument would be UTF-8 re-encoded and corrupt those bytes. It also references
> the `process` **global** (not `import process from "node:process"`): the
> `process.stdin` Readable prelude (#2632) deliberately leaves a user-imported
> `process` binding alone, so the global surface is what lowers to the async
> stream. And its `main` is intentionally **not exported** — an exported no-arg
> `main` is both the `_start` target and the top-level call, which would register
> the stdin listeners (and thus echo every frame) twice.

## Status: a working drop-in host

This host now exercises the **full** Native Messaging loop under `--target
wasi`: read the framed JSON message off stdin (fd=0), route debug to stderr
(fd=2), and write a **correctly framed** JSON response — the binary 4-byte
little-endian length prefix plus the JSON body — to stdout (fd=1) with no
trailing newline. The two stdout gaps that previously blocked this are closed
(#1618, #1651).

As of **#2631** the host uses the **real Node fd-based synchronous primitives**
`fs.readSync(fd, …)` / `fs.writeSync(fd, …)` from `node:fs` instead of the
js2wasm-specific `process.stdin.read(buf, offset)` shape — which matched **no**
real Node API (`process.stdin` is an async Duplex stream with no synchronous
buffer-filling `read`; loopdive/js2wasm#389). The same source now (a) compiles via
js2wasm to standalone WASI **and** (b) runs **unmodified** under real `node`.

**To get a module you can run directly under `wasmtime`, compile with `--target
wasi` ALONE** (no `--link node:fs`): the `node:fs` `readSync`/`writeSync` calls
lower **inline** to `wasi_snapshot_preview1` `fd_read`/`fd_write`, so the emitted
module imports ONLY `wasi_snapshot_preview1` and owns its own memory (#2655). This
is the runnable standalone path the loopdive/js2wasm#389 reporter wanted.

`--link node:fs` is a **separate modular-linking variant**, NOT a
run-directly-under-bare-wasmtime flag: it makes the module _import_ a stable
`node:fs` interface (`readSync`/`writeSync` + its `memory`) that you then **link**
against [`node-fs.wat`](./node-fs.wat) (which maps them to WASI `fd_read`/
`fd_write`) — or satisfy from a JS host's real `node:fs`. A `--link node:fs`
module run under bare `wasmtime` with no link step fails with `unknown import:
node:fs::readSync` (loopdive/js2wasm#389 bug 2) — that is expected; link it first. See
[`NODE-FS-SHIM.md`](./NODE-FS-SHIM.md) for the link step.

| Capability                                            | Status | Detail                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read framed message from stdin                        | works  | `readSync(0, buf, { offset, length })` does a binary, incremental fd=0 read into the caller's buffer, returning the byte count (#2631); `length` is the remaining-to-target count so a read never over-reads into the next message |
| Decode the 4-byte LE length prefix                    | works  | byte math on the first 4 bytes of the read header buffer                                                                                                                                                                           |
| Route debug to stderr (fd=2)                          | works  | `writeSync(2, bytes, …)` — keeps the stdout protocol stream clean (#2631)                                                                                                                                                          |
| Write raw bytes to stdout with no newline             | works  | `writeSync(1, bytes, off)` → `fd_write(1, …)`, partial-write loop drains the whole buffer, no `\n` (#2631)                                                                                                                         |
| Emit the **binary 4-byte LE length prefix** on stdout | works  | the length prefix + body live in ONE buffer written with a single `writeSync` (atomic framing, #2526)                                                                                                                              |

The response is framed with `writeSync(1, …)` — the 4-byte LE length prefix and
the body bytes in one `Uint8Array`, written atomically — mirroring the Node.js
host API used by the reference hosts (`nm_assemblyscript.ts`, `nm_javy.js`,
`nm_qjs_wasi.js`). `fs.readSync`/`fs.writeSync` are also what Javy uses
(`Javy.IO.readSync`).
Request bodies larger than 1 MiB can be streamed into the host as successive
<=1 MiB Native Messaging frames, and each frame is echoed independently. It is
a drop-in host for byte-exact request/response framing; the only
external dependency is a WASI preview1 runtime to launch it (see "Run it"
below).
The host also accepts the reported single-frame 64 MiB JSON string shape and
streams it back as <=1 MiB JSON string response chunks, so the compiled module
does not need to allocate the full request body at once.

## The host source

[`nm_js2wasm_node_fs.ts`](./nm_js2wasm_node_fs.ts) follows the reference-host shape
guest271314 uses across runtimes:

- **`readMessageLength()` / `readFrameBody()`** — read the 4-byte
  little-endian length header, then exactly that many body bytes via
  `readSync(0, buf, { offset, length })` read-until loops (a `readExact` helper
  handles short reads). Bodies up to 1 MiB stay raw **`Uint8Array`** values and
  round-trip byte-exactly (#389, #1753, #2631).
- **`emitRun()` / `writeAll()`** — frame a `Uint8Array` body: the 4-byte LE
  length prefix + body live in ONE buffer written with a single `writeSync(1, …)`
  (atomic, no trailing newline). Bodies up to 1 MiB are echoed byte-for-byte.
- **`sendLargeStringChunks(declaredLen)`** — handles the large single-frame
  JSON string stress shape by reading the string body incrementally and writing
  each chunk as its own valid JSON string Native Messaging response frame.
- **`main()`** — the continuous port loop:
  read a length, stream large strings when needed, otherwise
  `sendMessage(readFrameBody(len))`. A full 1 MiB body is a complete Native
  Messaging frame, so the host writes its response immediately instead of
  waiting for a possible continuation header.

Diagnostics go to **stderr** (so they never corrupt the stdout protocol
stream). The application logic — here, a byte-exact echo for one request frame
at a time — lives entirely in the loop body and is the part you'd replace for a
real host that decodes `message`, dispatches on a command field, and frames
structured responses with `sendMessage()`. Carrying the body as bytes (rather
than a string) is also forward-compatible with Chromium's in-progress
`Uint8Array` Native Messaging support — the protocol body is fundamentally a
byte buffer.

## Build to `.wasm`

From the repo root (works immediately after `pnpm install`, no build step):

```bash
mkdir -p examples/native-messaging/out
# Standalone, runs directly under wasmtime — imports ONLY wasi_snapshot_preview1:
npx tsx src/cli.ts examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi -o examples/native-messaging/out
```

(Once the package is built — `pnpm run build` — or installed from npm, you can
use the `js2wasm` bin directly: `npx js2wasm nm_js2wasm_node_fs.ts --target wasi -o out`.)

This produces `out/nm_js2wasm_node_fs.wasm`, a self-contained WASI Preview-1 command
module: the `node:fs` `readSync`/`writeSync` calls lower **inline** to
`wasi_snapshot_preview1` `fd_read`/`fd_write`, so the module imports ONLY
`wasi_snapshot_preview1`, owns + exports its own `memory`, and runs directly under
`wasmtime` with no link step (#2655).

**Optional modular-linking variant — `--link node:fs`.** Adding
`--link node:fs` instead makes the module _import_ a stable `node:fs` interface
(`readSync`/`writeSync` + the shared linear `memory`) rather than inlining the
syscalls:

```bash
npx tsx src/cli.ts examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi --link node:fs -o examples/native-messaging/out
```

The result declares **what** host API it needs (`node:fs`), not how it's
satisfied — so you must **link** it against `node-fs.wasm` (built from
[`node-fs.wat`](./node-fs.wat), which maps `node:fs` → WASI `fd_read`/`fd_write`),
a native WASI host, or the real `node:fs` module under a JS host BEFORE it can
run. Running a `--link node:fs` module directly under bare `wasmtime` with no
link step fails with `unknown import: node:fs::readSync` (loopdive/js2wasm#389 bug 2)
— that is by design; link it first. See [`NODE-FS-SHIM.md`](./NODE-FS-SHIM.md) for
the link step. Use this variant only when you want the same binary to link against
an external `node:fs` provider; for a drop-in standalone host, prefer `--target
wasi` alone above.

> **Running the output under a runtime** (the exact Wasmtime `-W` proposal flags
> plus `bun -b` / Deno) is documented in
> [Standalone I/O → Running the output across runtimes](../../docs/standalone-io.md#running-the-output-across-runtimes).

> The `-o` flag is an **output directory**, not a filename. js2wasm names the
> output after the input basename (`nm_js2wasm_node_fs.wasm`).

### What is `out/nm_js2wasm_node_fs.imports.js`?

Alongside `nm_js2wasm_node_fs.wasm`, js2wasm emits **`nm_js2wasm_node_fs.imports.js`** (plus `nm_js2wasm_node_fs.d.ts`).
It is the **generated host-imports glue** a compiled module needs when you
instantiate it from a JavaScript host. It re-exports `createImports`,
`instantiateBytes`, and `instantiateFromUrl` from the `js2wasm` runtime package,
wiring up the module's import manifest and string pool:

```js
import { instantiateBytes } from "./out/nm_js2wasm_node_fs.imports.js";
const { instance } = await instantiateBytes(wasmBytes, deps, options);
instance.exports.main();
```

For **this** example it is **not used at runtime**: the Native Messaging host
is a fully standalone `--target wasi` module whose only imports are the WASI
preview1 syscalls (`fd_read`/`fd_write`), which the runtime — `wasmtime`,
`wasmer`, `wazero`, or Node's WASI — supplies directly. So the `nm_js2wasm_node_fs.sh`
wrapper launches `nm_js2wasm_node_fs.wasm` under a WASI runtime and `nm_js2wasm_node_fs.imports.js` is
never imported.

The glue file is emitted unconditionally by the compiler because the **same
module can also be driven from a JS host** (e.g. instantiated in the browser or
in Node via `WebAssembly.instantiate`), where the import wiring it provides is
required. Treat it as the JS-host on-ramp for the module; for the standalone
WASI path it is a harmless extra artifact you can ignore or delete.

### Bundling `nm_js2wasm_wasi_p1.ts`: the `wasm:memory` / `wasi_snapshot_preview1` ghost imports (loopdive/js2wasm#389)

The raw-WASI host [`nm_js2wasm_wasi_p1.ts`](./nm_js2wasm_wasi_p1.ts) imports from
two module specifiers that **have no resolvable JS module** — they are
compile-time contracts js2wasm satisfies during codegen, not runtime packages:

```ts
import { fd_read, fd_write } from "wasi_snapshot_preview1"; // real WASI core module (host-supplied)
import { store32, load32, store8, load8 } from "wasm:memory"; // js2wasm INTRINSIC — lowers to inline i32.load/store
```

`store32`/`load32`/`store8`/`load8` are js2wasm **intrinsics** (`wasm:memory`, a
namespace mirroring `wasm:js-string`); the compiler lowers each to a single inline
`i32.store`/`i32.load`/`i32.store8`/`i32.load8_u` over the module's own linear
memory. `wasi_snapshot_preview1`'s `fd_read`/`fd_write` are satisfied by the WASI
runtime at launch. **Neither specifier resolves to a file a JS bundler can find**,
so a JS bundler (`bun build`, `esbuild`, `deno bundle`) that tries to walk and
inline every import will **choke on both** with an unresolvable-import error.

**Recipe — mark the ghost specifiers external.** When bundling the `.ts` source to
`.js` (the JS-runtime distribution path, e.g. for `scale-test.mjs`), tell the
bundler to leave both imports as bare externals rather than resolve them. This is
the exact form [`scale-test.mjs`](./scale-test.mjs) uses:

```bash
bun build examples/native-messaging/nm_js2wasm_wasi_p1.ts \
  --target node \
  --external wasi_snapshot_preview1 --external 'wasm:memory' \
  --outfile nm_js2wasm_wasi_p1.js
```

`esbuild` takes the same flags (`--external:wasi_snapshot_preview1
--external:'wasm:memory'`); `deno bundle` uses `--no-bundle` (or an import map that
maps the two specifiers to a shim). **Quote `'wasm:memory'`** — the `:` is
shell-significant in some contexts.

> **Ergonomics tradeoff.** This is the cost the #389 reporter flagged:
> `nm_js2wasm_wasi_p1.ts` is the leanest, fastest of the hosts (raw inline
> linear-memory ops, no GC roundtrip), but its `wasm:memory` intrinsics are
> "ghost code" with **no JS implementation**, so the source does **not** run
> unmodified in a plain JS runtime and its bundling needs the `--external` opt-out
> above. The **other hosts have no `wasm:memory` import** — e.g.
> [`nm_js2wasm_node_fs.ts`](./nm_js2wasm_node_fs.ts) uses `node:fs`
> `readSync`/`writeSync` and runs unmodified under real `node` — so if you want a
> single source that both bundles cleanly for a JS runtime **and** compiles to
> standalone WASI, prefer a `node:fs` / `node:process` host. Pick `wasi_p1` when
> you want the tightest possible pure-WASI module and can accept the ghost-import
> bundling opt-out. (Note the `--external wasi_snapshot_preview1` is needed for
> **any** raw-WASI host regardless — `fd_read`/`fd_write` are host-supplied and
> equally unresolvable to a JS bundler.)

## Run it under a WASI runtime

`nm_js2wasm_node_fs.sh` wraps the runtime invocation. `wasmtime` is **not bundled** with this
repo — install it from <https://wasmtime.dev> (or use `wasmer` /
[wazero](https://github.com/tetratelabs/wazero); see
[`../wasi/README.md`](../wasi/README.md) for the full runtime matrix and how to
wrap a `.wasm` as a single self-contained native executable).

Once built, exercise the read → decode → respond loop by piping a framed
message. The 4-byte prefix below (`\x0d\x00\x00\x00`) declares a 13-byte body
`{"ping":true}`:

```bash
printf '\x0d\x00\x00\x00{"ping":true}' | ./examples/native-messaging/nm_js2wasm_node_fs.sh
```

You'll see the host's stderr diagnostic (received-length + decoded body
length) and its stdout response, framed with the binary 4-byte LE length
prefix followed by the JSON body — exactly the bytes browsers expect.

For an automated byte-exact check (build + run under wasmtime, asserting the
stdout frame and a clean stderr), run [`smoke-test.sh`](./smoke-test.sh) —
the same script CI runs (`.github/workflows/native-messaging-smoke.yml`):

```bash
./examples/native-messaging/smoke-test.sh
```

### Manual wasmtime memory stress

For opt-in local memory measurements, use
[`stress-memory.mjs`](./stress-memory.mjs). It builds the WASI host, streams
<=1 MiB Native Messaging request frames into wasmtime, drains framed stdout
without retaining the response body, and samples the wasmtime child RSS. The
default run uses
`JSON.stringify(Array(209715))`, whose body is exactly 1 MiB:

```bash
node examples/native-messaging/stress-memory.mjs
```

To reproduce the reported 64x browser workload shape without adding a heavy CI
test, run the same harness manually:

```bash
node examples/native-messaging/stress-memory.mjs --reported-64mib
```

`--reported-64mib` sends the `Array(209715 * 64)` body split into <=1 MiB
request frames and, by default, kills the wasmtime child if sampled RSS grows
more than 256 MiB above the first sample or if the run exceeds 180 seconds. The
harness streams request bytes, drains framed stdout without retaining response
bodies, and validates that each response frame is <=1 MiB. Because the host now
treats each Native Messaging frame independently, this mode is a memory and
frame-budget stress rather than a logical 64 MiB JSON response assertion.
`--max-request-frame-bytes` and `--max-response-frame-bytes` can tighten the
frame budgets; `--allow-large-response-frame` remains only for measuring older
wasm builds that predate the chunked writer.

The unit tests also cover the single-frame 64 MiB JSON string case. That path
streams the string back as multiple valid JSON string response frames and keeps
the compiled module's linear memory below a 512 MiB cap.

> If you don't have a WASI runtime installed, you can still confirm the module
> is valid the same way the [`../wasi/README.md`](../wasi/README.md) Node
> snippet does — `WebAssembly.compile(readFileSync('out/nm_js2wasm_node_fs.wasm'))` — and
> drive it against js2wasm's own `buildWasiPolyfill()` for a JS-side
> round-trip.

## Deploy it: turnkey Chrome host recipe (#2812)

A Chrome Native Messaging host is a **single executable** the browser launches
per the host manifest. Getting from a js2wasm `.wasm` to that executable is four
steps: **compile → pick a runner → wrap it as the launched executable → wire the
manifest.** The [`make-nm-host.sh`](./make-nm-host.sh) helper does steps 3–4 for
the `wasmtime` and `bun` paths; the manual commands for all three runners follow.

### 1. Compile the host

```bash
mkdir -p out
npx js2wasm examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi -o out
# → out/nm_js2wasm_node_fs.wasm  (self-contained WASI P1 command module)
```

`--target wasi` alone inlines stdin/stdout to `wasi_snapshot_preview1.fd_read` /
`fd_write`, so the module needs no link step. (For the `--link node:fs` variant,
which imports a `node:fs` interface instead, see **step 4** below and
[`NODE-FS-SHIM.md`](./NODE-FS-SHIM.md).)

### 2. Pick a runner + wrap it as the launched executable

Chrome invokes the manifest `path` with **no predictable working directory**, so
the launched file must be executable and reference the `.wasm` by **absolute
path**. Each runner below is a validated way to produce that launched executable.

**A. `wasmtime` shebang script** — a text file Chrome executes directly. This is
the [`nm_js2wasm_node_fs.sh`](./nm_js2wasm_node_fs.sh) template; make it executable and
point its shebang at the absolute `.wasm` path:

```bash
#!/usr/bin/env -S wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y /ABS/PATH/out/nm_js2wasm_node_fs.wasm
```

Use exactly these `-W` proposals (GC, typed function references, tail calls,
exception handling) — the flags the WasmGC codegen relies on. **Do not** use
`-W all-proposals=y`: it also enables stack-switching, which wasmtime 44–46
reject at module load, so the host exits before running. `wasmtime` must be
installed (<https://wasmtime.dev>).

**B. `bun -b` shebang script** — Bun runs a WasmGC module directly; the required
proposals are on by default, no flags:

```bash
#!/usr/bin/env -S bun -b /ABS/PATH/out/nm_js2wasm_node_fs.wasm
```

**C. `deno compile` standalone executable** — Deno runs the **Deno-surface**
host source ([`nm_js2wasm_deno.ts`](./nm_js2wasm_deno.ts), which uses
`Deno.stdin.readSync` / `Deno.stdout.writeSync`) directly, and `deno compile`
bundles it — runtime included — into a single self-contained binary that needs
no runtime install on the target machine:

```bash
deno compile --allow-read --allow-write \
  --output out/nm-deno-host examples/native-messaging/nm_js2wasm_deno.ts
```

> **Deno note:** `deno run out/host.wasm` on a `--target wasi` module does **not**
> work — Deno loads a bare `.wasm` as a WASM ES module and leaves
> `wasi_snapshot_preview1` unresolved (`error: Import "wasi_snapshot_preview1"…`).
> For Deno, deploy the Deno-surface `.ts` host above (run or `deno compile` it),
> not the WASI `.wasm`.

The [`make-nm-host.sh`](./make-nm-host.sh) helper emits runner **A** or **B** plus
a matching manifest in one step:

```bash
examples/native-messaging/make-nm-host.sh \
  --wasm out/nm_js2wasm_node_fs.wasm \
  --name com.example.host \
  --origin chrome-extension://YOUR_EXTENSION_ID/ \
  --runner wasmtime          # or: --runner bun
# → out/com.example.host.runner.sh  (chmod +x, absolute paths)
# → out/com.example.host.json       (manifest, absolute path → the runner)
```

Smoke-test any runner with a framed request (the 4-byte `\x0d\x00\x00\x00`
prefix declares a 13-byte `{"ping":true}` body) — every runner returns the
**byte-identical** framed echo:

```bash
printf '\x0d\x00\x00\x00{"ping":true}' | ./out/com.example.host.runner.sh
# stdout: <0d 00 00 00> {"ping":true}
```

### 3. Wire the manifest to the runner

The host manifest's `path` must be the **absolute** path to the runner from
step 2 (the `.sh` script for A/B, or the compiled binary for C):

```json
{
  "name": "com.example.host",
  "description": "js2wasm Native Messaging host",
  "path": "/ABS/PATH/out/com.example.host.runner.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

Then install the manifest into Chrome's per-platform `NativeMessagingHosts`
directory and connect from the extension — both detailed in
[Wire it into the browser](#wire-it-into-the-browser) below (the manifest
**filename** must equal the `name` field).

### 4. `node:fs` hosts (`--link node:fs`)

A module compiled with `--link node:fs` **imports** a `node:fs` interface
instead of inlining WASI syscalls, so the runner must supply that provider at
launch. The equivalents per runner:

| Runner     | Supply the `node:fs` provider                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wasmtime` | `wasmtime run --preload node:fs=examples/native-messaging/node-fs.wasm out/host.wasm` (add to the shebang / `make-nm-host.sh --preload node:fs=…/node-fs.wasm`) |
| `bun`      | no runtime preload flag — link `node:fs` at **compile** time (drop `--link`, so `--target wasi` inlines it), or run under wasmtime                              |
| Deno       | deploy the Deno-surface `.ts` host (step 2C) — it uses Deno's own stdio, no `node:fs` link needed                                                               |

Build the provider shim once with `node scripts/build-node-fs-shim.mjs` (writes
`node-fs.wasm`). See [`NODE-FS-SHIM.md`](./NODE-FS-SHIM.md) for the interface,
memory-ownership model, and the full link steps. For a drop-in standalone host,
prefer `--target wasi` alone (no `--link`) so no runtime preload is needed.

## Wire it into the browser

1. **Build** `out/nm_js2wasm_node_fs.wasm` (above) and make sure `nm_js2wasm_node_fs.sh` is executable
   (`chmod +x nm_js2wasm_node_fs.sh`).

2. **Edit `nm_js2wasm_node_fs.json`**:
   - `path` → the **absolute** path to `nm_js2wasm_node_fs.sh` (browsers require an absolute
     path and does not set a predictable working directory), and make sure the file is
     set to executable.
   - `allowed_origins` → `chrome-extension://YOUR_EXTENSION_ID/` for the
     extension that will connect. Find the ID on `chrome://extensions` with
     Developer mode enabled after installing the unpacked Web extension.

3. **Install the manifest** in the per-platform location Chrome scans:

   | Platform | Manifest location                                                                                                                                     |
   | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Linux    | `~/.config/google-chrome/NativeMessagingHosts/nm_js2wasm_node_fs.json`                                                                                |
   | macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/nm_js2wasm_node_fs.json`                                                            |
   | Windows  | a registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\nm_js2wasm_node_fs` whose default value is the absolute path to the manifest `.json` |

   The manifest **filename** must match the host `name` field
   (`nm_js2wasm_node_fs`). On Windows, `nm_js2wasm_node_fs.sh` won't run directly —
   use a `run.bat` (`@echo off` + `wasmtime "%~dp0out\nm_js2wasm_node_fs.wasm"`) and point
   `path` at the `.bat`.

4. **Connect from the extension.** With the `nativeMessaging` permission in the
   extension manifest:

   ```js
   const port = chrome.runtime.connectNative("nm_js2wasm_node_fs");
   port.onMessage.addListener((msg) => console.log("from host:", msg));
   port.onDisconnect.addListener((_) => {
     console.log("host disconnected");
     if (chrome.runtime.lastError) {
       console.log(chrome.runtime.lastError);
     }
   }
   port.postMessage({ ping: true });
   ```

   The browser handles the 4-byte length framing on its side; the host sees the
   raw bytes on stdin and produces correctly framed bytes on stdout via
   `process.stdout.write` (a `Uint8Array` prefix + the JSON body).

## Linkable `node:fs` shim (`--link node:fs`, #2625/#2633)

By default the stdin/stdout glue is inlined as `wasi_snapshot_preview1.fd_read`
/ `fd_write` in every module. With `--target wasi --link node:fs`, the module
instead imports a stable `node:fs` interface (fd-based `readSync`/`writeSync`,
plus its linear memory) and links against a small, separately-compiled
`node-fs.wasm` that implements that interface over WASI — proving the modular
linking pattern that generalizes to other `node:` modules and to deno/browser
shims. Since #2633 **all** std-IO routes through `node:fs`: console.log /
process.stdout/stderr.write lower to `writeSync(1|2, …)` and synchronous stdin is
`readSync(0, …)`. (The earlier bespoke `js2wasm:node-process` shim — and the
hallucinated `process.stdin.read(buf, offset)` it backed — was retired.) See
[NODE-FS-SHIM.md](./NODE-FS-SHIM.md) for the interface, the memory-ownership
model, and the Node + wasmtime link steps.

## Reference hosts in other runtimes

The protocol shape here mirrors the runtime-comparison examples collected at
[guest271314/native-messaging-webassembly](https://github.com/guest271314/native-messaging-webassembly):
`nm_assemblyscript.ts`, `nm_javy.js`, and `nm_qjs_wasi.js`. They are useful for
seeing the full length-prefixed read/write loop in runtimes that already expose
raw-byte stdio.
