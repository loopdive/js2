# `node:fs` shim (#2631)

The Native Messaging host needs **synchronous** byte IO over stdin/stdout/stderr.
The faithful Node primitives for that are `fs.readSync(fd, …)` / `fs.writeSync(fd,
…)` from `node:fs` — fd-based (integer fd 0/1/2), **not** path-based, mapping 1:1
to WASI `fd_read` / `fd_write` with **no filesystem**. (The earlier example used
`process.stdin.read(buffer, offset)`, which matches **no** real Node API:
`process.stdin` is an async Duplex stream with no synchronous buffer-filling
`read` — loopdive/js2wasm#389. `fs.readSync`/`fs.writeSync` are also what Javy uses:
`Javy.IO.readSync`.)

`--link node:fs` keeps the syscall implementation **out of codegen**: the
compiler only wires `import { readSync, writeSync } from "node:fs"` to imports of
a stable **`node:fs`** interface. The module declares **what** host API it needs
(`node:fs`), not **how** it's satisfied — that is a link-time concern. The same
module can be linked against:

- **`node-fs.wasm`** (built from [`node-fs.wat`](./node-fs.wat)), which maps the
  interface to WASI `fd_read`/`fd_write`,
- a **native WASI host** that provides `node:fs` directly, or
- the **real `node:fs` module** under a JS host (where `import { readSync,
writeSync } from "node:fs"` resolves to the actual Node implementation, so the
  same source runs **unmodified** under `node`).

Naming the import `node:fs` (not `js2wasm:node-fs`) keeps the shim implementation
out of the module's declared dependency — the module just says "I need `node:fs`".

## Interface (`node:fs`)

A byte boundary over a **shared linear memory** — nothing GC-typed crosses the
link. The js2wasm pointer ABI passes `(fd, ptr, len)`; the compiler bridges its
GC/linear `Uint8Array` buffer to `(ptr, len)`:

| Function    | Signature                           | Meaning                                        |
| ----------- | ----------------------------------- | ---------------------------------------------- |
| `readSync`  | `(fd i32, ptr i32, len i32) -> i32` | bytes read from `fd` into `mem[ptr..ptr+len)`  |
| `writeSync` | `(fd i32, ptr i32, len i32) -> i32` | bytes written from `mem[ptr..ptr+len)` to `fd` |

Only the fd-based synchronous primitives are supported. **Path-based** `fs`
functions (`readFileSync(path)`, …) need a filesystem (`path_open` / preopens)
and are rejected under `--target wasi`.

## Memory ownership — no instantiation cycle

For a node:fs-only host (no `process`/`console` IO), the **shim owns + exports**
the linear memory; the **user module imports** it (memory index 0) along with
`readSync`/`writeSync`. So:

1. Instantiate `node-fs.wasm` first — it imports only `wasi_snapshot_preview1`.
2. Instantiate the user module with `{ memory, readSync, writeSync }` taken from
   the shim's exports.

There is no cycle (the shim never imports anything from the user module). The
shim reads/writes the user's bytes over the _same_ memory, builds the WASI iovec
in its own reserved scratch, and issues the syscall.

(Since #2633, **all** std-IO under `--link node:fs` goes through `node:fs`:
console.log / process.stdout/stderr.write lower to `writeSync(1|2, …)` and
synchronous stdin is `readSync(0, …)`. `node:fs` owns the single shared linear
memory; the bespoke `js2wasm:node-process` shim was retired.)

## Build

Compile the user module:

```sh
npx js2wasm examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi --link node:fs -o out
```

The emitted `out/nm_js2wasm_node_fs.wasm` imports only `node:fs` (memory + `readSync` +
`writeSync`) and carries **no** `wasi_snapshot_preview1` import for the IO path.

(Re)generate the shim:

```sh
node scripts/build-node-fs-shim.mjs                 # writes examples/native-messaging/node-fs.wasm + .wat
```

`node-fs.wasm` is a generated artifact (gitignored); `node-fs.wat` is the
committed source. Run the generator once before linking, or call the exported
`buildNodeFsShim()` to assemble it in-process (the test does this).

## Link + run

### Node (instantiate shim, pass its exports as the user's imports)

```js
import { readFileSync } from "node:fs";

const shimBin = readFileSync("examples/native-messaging/node-fs.wasm");
const userBin = readFileSync("out/nm_js2wasm_node_fs.wasm");

// Minimal WASI fd_read/fd_write over the shim-owned memory (or use a real WASI).
let mem = null;
const wasi = {
  fd_write(fd, iovs, n, nwritten) {
    /* read iovec from mem, write to fd */
  },
  fd_read(fd, iovs, n, nread) {
    /* read from fd into mem at iovec ptr */
  },
};

const shim = await WebAssembly.instantiate(shimBin, { wasi_snapshot_preview1: wasi });
mem = shim.instance.exports.memory;
const user = await WebAssembly.instantiate(userBin, {
  "node:fs": {
    memory: shim.instance.exports.memory,
    readSync: shim.instance.exports.readSync,
    writeSync: shim.instance.exports.writeSync,
  },
});
user.instance.exports.main(); // or _start (the top-level main() call)
```

### Under real `node` (no shim — the import resolves to real `node:fs`)

Because the source imports `{ readSync, writeSync } from "node:fs"` and calls
them with the real Node argument shapes (`readSync(fd, buffer, { offset, length
})` / `writeSync(fd, buffer, offset)`), the **same `.ts` file** runs directly
under `node` (e.g. via `tsx`), where `node:fs` is the real module — no shim, no
recompile.

### wasmtime (`--preload`)

```sh
wasmtime run \
  --preload node:fs=examples/native-messaging/node-fs.wasm \
  --invoke main \
  out/nm_js2wasm_node_fs.wasm
```

`--preload <name>=<file>` registers the shim under the import module name
`node:fs`; wasmtime resolves the user module's imports against it and provides
`wasi_snapshot_preview1` to the shim.

## Scope

The fd-based `readSync`/`writeSync` (no path) are supported now; the ABI can be
extended to more of `node:fs` later. Path-based `fs` (filesystem) stays gated
behind `--allow-fs` for JS-host targets and is rejected in standalone WASI.
