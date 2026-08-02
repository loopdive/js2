---
id: 3975
title: "standalone: `$262.detachArrayBuffer` unsupported — 206 tests refuse, 80 of them already pass in the host lane"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
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

- [ ] `$262.detachArrayBuffer(buf)` works in `--target standalone`.
- [ ] The 206-record `detachArrayBuffer is unsupported by this host` bucket
      drops to ~0 in a fresh standalone harvest.
- [ ] Standalone official pass count rises by roughly +80 (the cross-lane
      recoverable set); report the actual delta.
- [ ] No host-lane regression — this must not disturb the #1523 host path.
- [ ] `createRealm` / `agent` standalone availability is checked and recorded.
