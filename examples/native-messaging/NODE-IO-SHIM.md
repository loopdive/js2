# `js2wasm:node-io` shim (#2524 Phase 1)

`--node-io-shim` factors the `process` stream IO host-API out of every compiled
module into a separately-compiled, **linkable** core-wasm shim. Instead of
inlining the `wasi_snapshot_preview1.fd_read` / `fd_write` glue, a module
compiled with this flag **imports a stable `js2wasm:node-io` interface** and
links against `node-shim.wasm`, which implements that interface over WASI.

This is the modularization mechanism that generalizes: the same interface can be
backed by a deno shim, a browser shim, or an `fs`/`path` shim — swap the shim,
keep the user module.

## Interface (`js2wasm:node-io`)

A byte boundary over a **shared linear memory** — nothing GC-typed crosses the
link (that is Phase 2, #2514):

| Function | Signature | Meaning |
|----------|-----------|---------|
| `stdin_read`  | `(ptr i32, len i32) -> i32` | bytes read into `mem[ptr..ptr+len)` |
| `stdout_write`| `(ptr i32, len i32) -> i32` | bytes written from `mem[ptr..ptr+len)` |
| `stderr_write`| `(ptr i32, len i32)`        | write to stderr (void) |

## Memory ownership — no instantiation cycle

The **shim owns + exports** the linear memory; the **user module imports** it
(memory index 0) along with the three IO functions. So:

1. Instantiate `node-shim.wasm` first — it imports only `wasi_snapshot_preview1`.
2. Instantiate the user module with `{ memory, stdin_read, stdout_write,
   stderr_write }` taken from the shim's exports.

There is no cycle (the shim never imports anything from the user module). The
shim reads/writes the user's bytes over the *same* memory, builds the WASI
iovec in its own reserved scratch, and issues the syscall.

## Build

Compile the user module:

```sh
npx js2wasm examples/native-messaging/nm_js2wasm.ts --target wasi --node-io-shim -o out
```

The emitted `out/nm_js2wasm.wasm` imports only `js2wasm:node-io` (memory + the
IO functions it uses) and carries **no** `wasi_snapshot_preview1` import for the
stream-IO path.

(Re)generate the shim:

```sh
node scripts/build-node-io-shim.mjs            # writes examples/native-messaging/node-shim.wasm + .wat
```

`node-shim.wasm` is a generated artifact (gitignored); `node-shim.wat` is the
committed source. Run the generator once before linking, or call the exported
`buildNodeIoShim()` to assemble it in-process (the test does this).

## Link + run

### Node (instantiate shim, pass its exports as the user's imports)

```js
import { readFileSync } from "node:fs";

const shimBin = readFileSync("examples/native-messaging/node-shim.wasm");
const userBin = readFileSync("out/nm_js2wasm.wasm");

// Minimal WASI fd_read/fd_write over the shim-owned memory (or use a real WASI).
let mem = null;
const wasi = {
  fd_write(fd, iovs, n, nwritten) { /* read iovec from mem, write to fd */ },
  fd_read(fd, iovs, n, nread)     { /* read from fd into mem at iovec ptr */ },
};

const shim = await WebAssembly.instantiate(shimBin, { wasi_snapshot_preview1: wasi });
mem = shim.instance.exports.memory;
const user = await WebAssembly.instantiate(userBin, {
  "js2wasm:node-io": {
    memory:       shim.instance.exports.memory,
    stdin_read:   shim.instance.exports.stdin_read,
    stdout_write: shim.instance.exports.stdout_write,
    stderr_write: shim.instance.exports.stderr_write,
  },
});
user.instance.exports.main();
```

### wasmtime (`--preload`)

```sh
wasmtime run \
  --preload js2wasm:node-io=examples/native-messaging/node-shim.wasm \
  --invoke main \
  out/nm_js2wasm.wasm
```

`--preload <name>=<file>` registers the shim under the import module name
`js2wasm:node-io`; wasmtime resolves the user module's imports against it and
provides `wasi_snapshot_preview1` to the shim.

## Scope

Phase 1 keeps the GC↔linear copy in the **user** module and moves only the
**syscall side** behind the import over the shared memory. The GC runtime
boundary (passing GC objects across the link, requiring a canonical rec group)
is Phase 2 — see #2514. Component Model packaging is the deferred alternative
(#2525). Default (flag off) behavior is unchanged: the inline `fd_read`/
`fd_write` path stays as the fallback.
