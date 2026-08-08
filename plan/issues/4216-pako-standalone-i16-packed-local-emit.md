---
id: 4216
title: "standalone pako: packed i16 storage type leaks into a value position at binary emit"
status: ready
sprint: Backlog
created: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: emit
goal: standalone-gap
related: [743, 4157, 679]
origin: "2026-08-08 — found by the #743 second-corpus census (pako 2.1.0 standalone compile)"
---

# #4216 — standalone pako: packed `i16` leaks into a value position at binary emit

## Problem

Compiling pako 2.1.0's self-contained dist bundle (`dist/pako.esm.mjs`, 226 KB,
zlib port) with `target: "standalone"` fails at binary emit with exactly one
error:

```
Binary emit error: Error: encodeValType: packed storage type "i16" is not valid
in a value position (only struct fields / array elements) — a packed type leaked
into a param/result/local/global
    at encodeValType (src/emit/binary.ts:855)
    at encodeFunctionWithSourceMap (src/emit/binary.ts:667-669)   ← locals vector
    at emitBinaryWithSourceMapUnguarded (src/emit/binary.ts:571)
```

The frame at `binary.ts:667-669` is the function-locals vector, so some
function declares a **local** of packed type `i16`. Packed types (`i8`/`i16`)
are storage-only in WasmGC; a local/param/result/global must widen to `i32`.
The emit-time guard (which is doing its job) was added precisely to catch this
class of leak — this is the first real-corpus reproduction.

Codegen itself completes: the fnctor field-provenance census runs to the end
(122 slots recorded) and this is the **only** error in the compile. pako is
heavy on `Uint16Array`/`Uint8Array` and the native-strings backend uses i16
arrays (#679), so the likely source is an array-element read whose result type
was taken as the storage type instead of the widened `i32` — but the emitting
function has not been identified yet; that is the first step.

## Repro

```bash
cd /tmp && npm pack pako@2.1.0 && tar xzf pako-2.1.0.tgz
# then compile package/dist/pako.esm.mjs with:
#   compile(source, { fileName: "pako.mjs", skipSemanticDiagnostics: true,
#                     target: "standalone" })
```

(Probe used by the census: see #743 "2026-08-08 — second-corpus measurement".)

## Why it matters

pako is the chosen **second dogfood corpus** for the #743/#4157 representation
program (same size class as acorn's bundle, function-ctor classes, numeric/
typed-array-heavy — the contrast corpus to acorn's string/object shape). This
one error is all that blocks it from becoming a compiled, runnable standalone
corpus with its own perf lane; until then it is census-only.

## Acceptance criteria

- [ ] pako 2.1.0 `dist/pako.esm.mjs` compiles to a valid standalone binary
      (Wasm validation passes; no packed types in value positions).
- [ ] A minimal fixture pins the widening (i16-array element read flowing into
      a local/param/result) as a regression test.
- [ ] A smoke canary (deflate → inflate round-trip of a short string inside the
      module) returns the expected checksum.
