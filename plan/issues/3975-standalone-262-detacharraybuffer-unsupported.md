---
id: 3975
title: "standalone: route `$262.detachArrayBuffer` through the native detached-buffer marker (77/89 pass)"
status: done
completed: 2026-08-11
sprint: 78
created: 2026-08-01
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: testing
language_feature: typed-arrays
goal: standalone-mode
related: [1523, 1350, 1645, 1781]
origin: "2026-08-01 /harvest-errors of loopdive/js2wasm-baselines test262-standalone-current.jsonl (run 20260801-090441, gitHash c601e89b)"
---

# #3975 — standalone lane has no `$262.detachArrayBuffer`

## Resolution (2026-08-11)

The buffer-side native implementation was already present. The literal Test262
runtime in `scripts/test262-fyi-runtime.js` stopped before reaching it: when a
standalone module observed that `structuredClone` was absent, the shim threw the
uniform "unsupported by this host" error. The adapted diagnostic harness had
already used the correct native marker for months, which is why focused
DataView tests were green while the maintained original-harness baseline was
not.

The shim now writes `buffer.__detached__ = true` and returns when no host
`structuredClone` exists. In standalone/WASI, the existing assignment lowering
in `tryCompileStandaloneDetachedWrite` converts that write into the native
ArrayBuffer detached state (`length = -1`). The GC/host lane still calls real
`structuredClone(buffer, { transfer: [buffer] })` and is unchanged.

### Fresh measurement

Source: maintained `loopdive/js2wasm-baselines`
`test262-standalone-current.jsonl`, baseline commit
`2ca8c9422f41937caf6d6c27ee9ed5a964ebc206`, rows timestamped
2026-08-11 19:17, oracle v13. The report contains 43,548 official rows and
29,165 standalone passes. The branch is based on canonical
`loopdive/js2wasm` `main` at `beb8e4e7180a32e1fbd89e549b692328981479b4`;
the Test262 gitlink is `b363f29d3c43c626dc852744ad64a0b48a003693`.

The old 206-row estimate had shrunk before this implementation:

| category | fresh uniform-refusal rows |
| --- | ---: |
| `built-ins/DataView` | 78 |
| `built-ins/ArrayBuffer` | 8 |
| `built-ins/Uint8Array` | 3 |
| **total** | **89** |

Authoritative `runTest262File(..., "standalone")` A/B:

| | baseline | branch |
| --- | ---: | ---: |
| pass | 0 / 89 | **77 / 89** |
| `$262.detachArrayBuffer is unsupported by this host` | **89 / 89** | **0 / 89** |
| honest downstream residual | 0 / 89 | 12 / 89 |

The maintained host JSONL passes 38 of the 89 files. The branch's larger
77-file standalone gain is real: the native DataView detached-buffer path is
ahead of the host lane on 39 additional files. A representative maintained-
runner control,
`DataView/prototype/getUint32/detached-buffer-after-toindex-byteoffset.js`,
moved from the exact baseline refusal to pass when run alone.

The 12 residuals are no longer harness capability failures:

| residual mechanism | files |
| --- | ---: |
| ArrayBuffer detached getters return the internal `-1`/numeric sentinel instead of `0`/`false` (`byteLength`, `maxByteLength`, `resizable`) | 3 |
| ArrayBuffer detached operations do not throw the required TypeError (`transfer`, `transferToFixedLength`, `resize`, `sliceToImmutable`, `transferToImmutable`) | 5 |
| Uint8Array base64/hex operations omit detached-view validation (`toHex`, `setFromHex`, `setFromBase64`) | 3 |
| `new DataView(detachedBuffer)` omits its TypeError | 1 |
| **total** | **12** |

Two baseline files were absent from the shared Test262 checkout; both were
re-run from a detached checkout of the repository's pinned Test262 gitlink and
are included in the 12 residuals above. No row was silently dropped.

Focused verification is 41/41 green: the new four-case GC+standalone suite and
the 37 DataView plus literal-harness/import cases in `issue-3173.test.ts` and
`issue-3418.test.ts`. The new controls prove that
standalone emits zero host imports and observes the native detached state,
while GC still retains the real `structuredClone` import and transfer call.
The maintained runner also reproduced **12/12** currently-passing
DataView/ArrayBuffer/Uint8Array control rows from the same fresh baseline.

`$262.createRealm` is present in the literal runtime but remains the existing
identity-only realm shim. `$262.agent` is absent. The fresh standalone JSONL
has no failure text naming either capability; agent/SharedArrayBuffer semantics
remain the separate Atomics backlog and were not expanded into this fix.

## TL;DR

**206 official failing tests** in the **standalone** lane fail with:

```
Error: $262.detachArrayBuffer is unsupported by this host
```

The default (JS-host) lane hits this **zero** times — #1523 provided the `$262`
host-object API (`createRealm` / `detachArrayBuffer` / `agent`) for the host
lane only. The standalone lane never got an equivalent, so every test that
needs to detach a buffer to observe post-detach behaviour refuses.

This is a **lane gap, not a semantics gap**, and it has an unusually clean
payoff: **80 of the 206 files already pass in the host lane**, so they are
blocked purely by the missing harness capability.

## Evidence

Source: `test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`,
run `20260801-090441` (gitHash `c601e89b`); standalone official
25,630 / 43,106 pass (59.5 %).

| Category | Count |
| --- | --- |
| `built-ins/TypedArray` | 78 |
| `built-ins/DataView` | 77 |
| `built-ins/TypedArrayConstructors` | 42 |
| `built-ins/ArrayBuffer` | 6 |
| `built-ins/Uint8Array` | 3 |
| **total** | **206** |

Cross-lane check on the same 206 files:

| Default-lane status | Count |
| --- | --- |
| `pass` | **80** |
| `fail` | 126 |

So ~80 tests are directly recoverable by implementing the capability; the other
126 fail in the host lane too and are gated on real detached-buffer semantics
(#1350 `blocked` / #1645 `ready`) rather than on `$262`.

Samples:

```
test/built-ins/TypedArray/prototype/join/BigInt/detached-buffer.js
test/built-ins/TypedArray/prototype/toString/BigInt/detached-buffer.js
test/built-ins/TypedArrayConstructors/internals/GetOwnProperty/detached-buffer-key-is-symbol.js
test/built-ins/DataView/prototype/getUint32/detached-buffer-after-toindex-byteoffset.js
test/built-ins/ArrayBuffer/prototype/byteLength/detached-buffer.js
```

## Scope

Implement `detachArrayBuffer` for the standalone `$262` harness object. In
standalone there is no JS host to delegate to, so detaching has to be done
against the WasmGC-native `ArrayBuffer` representation directly — set the
buffer's backing store to the detached state and make every downstream
`ArrayBuffer`/`TypedArray`/`DataView` accessor observe it.

**The 126 host-lane-failing files are explicitly out of scope.** Landing this
should move ~80 tests; do not chase the rest here — route them to #1645.

Worth confirming while in this code: whether `$262.createRealm` and
`$262.agent` are also missing in standalone. They did not surface in this
harvest (the tests that need them likely refuse earlier for another reason), so
they are **not** assumed missing — check rather than infer, and file separately
if they are.

## Acceptance criteria

- [x] `$262.detachArrayBuffer(buf)` works in `--target standalone`.
- [x] The fresh 89-record `detachArrayBuffer is unsupported by this host`
      bucket drops to 0.
- [x] Targeted standalone pass count rises by **77/89**, with all 12 residuals
      explicitly bucketed above.
- [x] No host-lane regression — the #1523 `structuredClone` path stays live.
- [x] `createRealm` / `agent` standalone availability is checked and recorded.
