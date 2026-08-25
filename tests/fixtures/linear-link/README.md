# `peer.wasm` — a real C-compiled module for the #4539 link test

`peer.c` is compiled to a **freestanding** wasm32 module (no libc, no WASI) so
the linear backend's link topology can be proven against genuine C output
rather than against JS stubs. It owns and exports a memory, exports two
functions, and imports nothing.

The bytes are embedded as base64 in `tests/issue-4539-c-link.test.ts` rather
than committed as a binary: at ~529 bytes the encoding is small, it keeps the
test deterministic on machines with no C toolchain, and the source plus the
exact command below keep it auditable and regenerable.

Regenerate:

```bash
clang --target=wasm32 -nostdlib -O2 \
  -Wl,--no-entry -Wl,--export-memory -Wl,--export-all \
  -o peer.wasm peer.c
node -e 'console.log(require("fs").readFileSync("peer.wasm").toString("base64"))'
```

Built with Ubuntu clang 18.1.3; sha256 of the committed bytes starts `2899c9d1f50498cb`.
A WASI sysroot is deliberately **not** required — freestanding is enough, which
is what makes this test runnable where the full engine artifact build is not.
