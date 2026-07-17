---
id: 2658
title: "WASI Preview 3 (0.3) target — scope: adapter-interop tops out at P2, native-P3 is a component-model epic"
status: in-progress
assignee: ttraenkler/sdev-p3-b0
created: 2026-06-25
updated: 2026-06-26
priority: low
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: wasi
goal: wasi-async-runtime
sprint: Backlog
es_edition: n/a
depends_on: []
related: [2643, 2646, 2632, 2635, 2525, 1774, 1772]
origin: "Arch scoping of a WASI Preview 3 (0.3) target after WASI 0.3 shipped 2026-06-11 (native async in the Component Model: async func / stream<T> / future<T>). Mirrors the #2643 verdict style: cheap-interop-slice-now vs component-model-epic-deferred."
---

# #2658 — WASI Preview 3 (0.3) target scope

## Problem

WASI 0.3 shipped on 2026-06-11: native async in the Component Model
(`async func`, `stream<T>`, `future<T>` baked into the canonical ABI), rebasing
the P2 `wasi:cli` / `wasi:io` interfaces onto real async. The strategic appeal
for js2wasm is that P3's native `stream<u8>` is the _clean_ substrate for
**interactive streaming stdin** (#2646) — the thing the asyncify hack (blocked)
and the P2 `poll`-based reactor both struggle with.

This issue scopes what "target WASI Preview 3" actually means for js2wasm today,
in the same honest-sizing spirit as the #2643 scoping. The headline answer is
below; the two paths and their slice decomposition follow.

## Verdict (TL;DR)

**There is no cheap P3-interop win today, because the toolchain ships no
P1→P3 or P2→P3 adapter.** Everything that "targets P3" requires the _native_
component-model producer work, which is the deferred `#2525` epic.

Concretely, regrounded against the installed toolchain on this box
(2026-06-25):

| Capability                               | State on this box                           | Implication                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasmtime                                 | **44.0.0**                                  | hosts WASI `0.3.0-rc-2026-03-15` worlds (`wasi:cli/stdin@0.3.0`, `wasi:clocks@0.3.0`, …). Built-in `-W component-model-async`. ✅ a P3 host is runnable here.                                                                 |
| jco                                      | **1.16.1** (vendored via `componentize-js`) | only adapter shipped is `wasi_snapshot_preview1.{command,reactor}.wasm`, and it encodes **`wasi:cli@0.2.3`** — a **P1→P2** adapter. **No P3 adapter, no `--wasi-version` flag.**                                              |
| `wasi:io/poll` + `wasi:io/streams` in P3 | **removed** in 0.3                          | streams/futures moved into the canonical ABI; P3 stdin is `wasi:cli/stdin.read-via-stream → stream<u8>`. So the P2 adapter's whole reactor-backing model (`poll_oneoff`→`wasi:io/poll`) has **no P3 analogue to adapt onto**. |

So the two paths split cleanly:

- **Path 1 — adapter/interop (the #2643 Slice-A trick), re-run for P3: DOES NOT
  EXIST.** The jco adapter only produces a **P2** component. There is no
  P1→P3 / P2→P3 adapter in jco 1.16, wasm-tools, or wasmtime 44. The cheapest
  honest "P3 interop" we can ship is a **documentation + verification slice**
  proving our existing **P2 component runs unchanged under wasmtime 44's
  P3-capable host** (a P3 host is backward-compatible with 0.2 worlds) — i.e.
  "P3 host, P2 guest." That is real and cheap, but it is **not** a P3 _target_;
  the guest is still P2. **No codegen change, no new behaviour over #2643.**

- **Path 2 — native P3 async producer.** Emit a genuine P3 component:
  `wasi:cli/run@0.3.0` world, the async canonical ABI (`async`-lifted exports,
  `stream<u8>` / `future<T>` lowering, `task.*`/`waitable-set` built-ins,
  `cabi_realloc`, resource tables, a `component-type` custom section). This is
  the component-model-producer epic (`project_wasm_linking_core_over_component`,
  #2525) — **large, defer.** It is the _only_ path that makes js2wasm a true P3
  target and the _only_ path that gives #2646 interactive streaming "for free."

**Does P3 unblock #2646 interactive streaming?** _Architecturally yes, but only
via Path 2._ P3's `wasi:cli/stdin.read-via-stream` hands the guest a host-driven
`stream<u8>`; the async canonical ABI lets a P3-async-lifted `run` export
**suspend at a stream read and be resumed by the host scheduler** — exactly the
incremental loop-borrow #2646 needs, with the suspend/resume done by the
_component-model runtime_ instead of the blocked asyncify hack or a pre-drain.
**But it is NOT reachable via the adapter path** (which doesn't exist for P3 and
even if it did would wrap our _synchronous_ `poll_oneoff` core, not an async
export). #2646 "for free" requires the native async-export lowering in Path 2.
So: P3 is the right long-term home for interactive stdin, but it is **not** a
shortcut around the #2646 blocker — it relocates the blocker from "asyncify the
core module" to "emit an async-lifted component export," which is strictly more
work (the whole Path 2 epic) though architecturally cleaner.

## Regrounding — what we already have (verified 2026-06-25)

- **P1 reactor** (`src/codegen/async-scheduler.ts`, 3013 lines): timer heap +
  fd0-readiness reactor (multi-subscription `poll_oneoff`) + the #2632 Phase-3
  faithful `process.stdin` Readable, all against **WASI Preview 1**. `_start`
  runs a synchronous `poll_oneoff`-blocking loop.
- **#2643 Slice A (done)**: `scripts/wasi-p2-component.mjs` adapts the unchanged
  P1 core module into a **P2 component** via the jco P1→P2 adapter
  (`jco new --adapt wasi_snapshot_preview1=<adapter>`), runs under wasmtime 44's
  component model, byte-identical streaming to the P1 arm
  (`tests/issue-2643-wasi-p2-adapter.test.ts`). The adapter targets
  `wasi:cli@0.2.3`. Slices B2–B4 (native `wasi:io/poll` lowering) were deferred
  as a component-model epic with **no new behaviour over the adapter**.
- **#2646 (blocked)**: true incremental loop-borrow via asyncify
  (`wasm-opt --asyncify` over `poll_oneoff`) so the reactor suspends and resumes
  on each Node `'data'` tick — blocked on the asyncify-GC gap (asyncify does not
  handle WasmGC stack values).

## Implementation Plan

### Path 1 — "P3 host, P2 guest" verification (cheap, but NOT a P3 target)

The honest cheap slice. Proves forward-compat: our existing #2643 P2 component
runs under a **P3-capable host** (wasmtime 44 with `-W component-model-async`),
since a P3 host still hosts 0.2 worlds. Delivers **no P3 guest**, **no codegen
change**, **no #2646 unblock** — purely a forward-compat assurance + a doc that
records "no P3 adapter exists; here is why the cheap trick stops at P2."

**Slice A1 (docs + test, ~0.5 day, role: developer)**

- Extend `tests/issue-2643-wasi-p2-adapter.test.ts` (or a sibling) to also run
  the adapted **P2** component under wasmtime 44 with
  `-W component-model-async=y` enabled, asserting the same byte-identical
  streaming output — i.e. proving the P2 guest is unaffected by the host's P3
  async machinery being on.
- Document in this issue + `docs/` that the jco 1.16 adapter is **P1→P2 only**
  (`wasi:cli@0.2.3`), so there is no `--target wasi-p3` adapter slice analogous
  to #2643 Slice A. Record the toolchain probe (no P3 adapter in jco/wasm-tools/
  wasmtime 44; P3 drops `wasi:io/poll`+`wasi:io/streams`).
- **Acceptance:** P2 component runs green under a P3-async-enabled wasmtime host;
  doc states plainly that "target P3" today = Path 2 (native), not an adapter.
- **Value:** low — forward-compat assurance only. Worth doing _only_ bundled
  with whoever next touches the WASI test path; not worth a standalone dispatch.

### Path 2 — native P3 async producer (large epic, DEFER to #2525 track)

Make js2wasm emit a genuine P3 component. This is the component-model-producer
work deferred by `project_wasm_linking_core_over_component` and #2525. Sized
honestly into slices so it can be picked up incrementally **after** the #2525
Component-Model track is staffed.

**Slice B0 — spike: hand-author a P3 `run` component, run it (1–2 days, role:
senior-developer / architect)**

- NOT codegen. By hand (WIT + `wasm-tools`/jco `embed`+`new`, or a tiny Rust/JS
  reference), produce a minimal `wasi:cli/run@0.3.0` component that does an
  async `stream<u8>` stdin echo, and run it under wasmtime 44
  (`-W component-model-async=y`). Purpose: pin down the _exact_ binary shape
  js2wasm must emit (async canonical ABI lifting, `stream`/`future` type
  encoding, `component-type` section, `cabi_realloc`, the `0.3.0-rc-2026-03-15`
  vs final `0.3.0` world id on this wasmtime). De-risks the entire epic.
- **Acceptance:** a working reference P3 echo component + a written spec of the
  binary sections js2wasm must produce. **Gate for B1+.**

**Slice B1 — `--target wasi-p3` flag plumbing + WIT/world selection (1 day,
role: developer)**

- Add the CLI flag and thread a `wasiPreview: 1 | 2 | 3` (or `p3: boolean`)
  through `compile()` into codegen options. No binary change yet (flag selects
  world id + later toggles the lowering). Cheap seam; **no standalone value**
  until B2 (mirror of #2643 Slice B1).

**Slice B2 — component-type custom section + canonical-ABI lifting for a
_synchronous_ P3 `run` (large, ~1–2 weeks, role: senior-developer)**

- Emit the `component-type` custom section describing the
  `wasi:cli/run@0.3.0` world; lift `_start`→`run` through the canonical ABI;
  emit `cabi_realloc`; resource-table plumbing for any handles. Start
  _synchronous_ (no `stream`/`future`) to land the producer machinery before the
  async ABI. This is the bulk of "js2wasm is a component producer."
- Depends: B0, B1, and the #2525 component-model substrate.

**Slice B3 — async canonical ABI: `async`-lifted `run` + `stream<u8>` stdin
(large, ~1–2 weeks, role: senior-developer)**

- Lift `run` as an **async** export; lower `wasi:cli/stdin.read-via-stream` to a
  native `stream<u8>` read; wire the reactor's suspend points to the
  component-model `task`/`waitable-set` built-ins instead of `poll_oneoff`. The
  async event-loop reactor stops calling `poll_oneoff` and instead yields to the
  host scheduler at stream reads.
- **This is the slice that subsumes #2646**: interactive incremental stdin comes
  from the host driving the async `stream<u8>`, no asyncify, no pre-drain.
- Depends: B2.

**Slice B4 — wire #2646 acceptance onto B3 (small once B3 lands, role:
developer)**

- Re-run the #2646 interactive echo-per-line acceptance against the native P3
  async component; prove per-chunk reaction with no up-front EOF. Close #2646 as
  _resolved-by-P3-native_ (its asyncify approach becomes the fallback only for
  non-component P1 hosts).
- Depends: B3.

### What to do now vs defer

- **Now:** _nothing dispatch-worthy on its own._ Path 1 Slice A1 is a ~half-day
  forward-compat doc/test — fold it into the next WASI-path PR, don't staff it
  solo. The genuinely valuable artifact of this issue is **this scope doc**:
  it records that "target P3" has no cheap-adapter shortcut and stops the team
  from chasing a #2643-style Slice A that cannot exist for P3.
- **Defer (gated on #2525):** Path 2 (B0→B4). B0 is the right first move when
  the Component-Model track is picked up — a low-cost spike that de-risks the
  whole epic and produces the binary-shape spec. #2646 should be marked
  `related:` here and ultimately resolved by B3/B4, not by reviving asyncify.

## Acceptance (for this scoping issue)

- This issue file documents the two paths with honest sizing and a slice
  decomposition (above). ✅
- The verdict explicitly states: no P1→P3/P2→P3 adapter exists in the installed
  toolchain, so there is **no cheap P3-interop slice** analogous to #2643 Slice
  A; "target P3" = the native component-model epic (Path 2). ✅
- The #2646 question is answered: P3 native async (Path 2, Slice B3) is the clean
  replacement for the asyncify hack, reachable **only** via the native path, not
  the (nonexistent) adapter path. ✅

## Out of scope

- Implementing any of Path 2 (this is scoping only).
- The #2525 component-model substrate itself (prerequisite, tracked separately).
- Reviving the #2646 asyncify approach (superseded by Path 2 Slice B3 long-term;
  remains the P1-host fallback).

## B0 Spike Findings (2026-06-26, executed)

Slice **B0** was executed — the de-risking spike for Path 2 (NOT the producer
itself). Goal: prove a minimal native P3 async component runs on this box, and
pin the exact binary shape js2wasm must emit for B2/B3. Artifacts live under
`examples/native-messaging/p3-b0-spike/` (hand-authored WAT + run script) and the
`nm_wasi_p3.ts` source-reference comparison instance. **Headline: the P3 async
runtime target is real and runnable here; the producer toolchain on this box has
a precise `future<T>` encoding gap that B2/B3 must close.**

### Toolchain probed (this box, 2026-06-26)

| Tool     | Version                                                                                     | Relevant capability                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasmtime | **44.0.0** (`af382d7d9`, 2026-04-20)                                                        | Hosts WASI **`0.3.0-rc-2026-03-15`** worlds. `-S p3=y` enables WASIp3 host APIs; `-W component-model-async{,-builtins,-stackful}=y` enable async lifting/lowering + the `task.*`/`waitable-set.*`/`stream.*`/`future.*` built-ins. |
| jco      | **1.16.1** (pnpm dir `@bytecodealliance+jco@1.17.6`; vendored via `componentize-js@0.19.3`) | `jco parse`/`embed`/`new`/`print` wrap a **bundled** wasm-tools (`obj/wasm-tools.core.wasm`). No standalone `wasm-tools`/`cargo`/`rustc` on the box. `componentize` (StarlingMonkey) emits **P2 only**.                            |

The world id wasmtime 44 actually hosts is **`0.3.0-rc-2026-03-15`**, NOT the
final `0.3.0`. A producer MUST emit that exact package version string or
wasmtime rejects the world (`no exported instance named wasi:cli/run@…`).

### Authoritative P3 stdio WIT (fetched from `wasmtime` v44.0.0,

`crates/wasi/src/p3/wit/deps/cli.wit`)

```wit
package wasi:cli@0.3.0-rc-2026-03-15;

interface types { enum error-code { io, illegal-byte-sequence, pipe } }

interface run {                       // the command entrypoint
  run: async func() -> result;        // <-- ASYNC-lifted export
}

interface stdin {
  use types.{error-code};
  read-via-stream: func() -> tuple<stream<u8>, future<result<_, error-code>>>;
}

interface stdout {
  use types.{error-code};
  write-via-stream: func(data: stream<u8>) -> future<result<_, error-code>>;
}
```

So the **elegant P3 echo** is a stream hand-off: `read-via-stream()` yields the
stdin `stream<u8>`; pass that same readable end to `write-via-stream(data)`; the
host pumps stdin→stdout; the guest awaits the returned `future<result>`. The
guest barely touches the bytes — the host drives the copy. (Contrast the P1
`nm_wasi.ts`, which hand-marshals iovecs through linear memory in a
`fd_read`/`fd_write` loop.)

### ✅ What RUNS here (de-risked)

1. **A genuine P3 async command runs under wasmtime 44.** A hand-authored
   component that exports `wasi:cli/run@0.3.0-rc-2026-03-15` with an
   **async-lifted** `run` — `(canon lift (core func) async (callback $cb))`,
   the core `run` calling `(canon task.return (result (result)))` then returning
   the `EXIT` code `0` — runs cleanly:
   `wasmtime run -W component-model-async=y -S p3=y run-async.wasm` → rc 0.
   This proves the **async canonical ABI** (async lift + callback + `task.return`)
   is fully functional on this box. This is the runnable B0 proof
   (`p3-b0-spike/run-async.wat` + `run-p3-b0.sh`).
2. **`stream<u8>` types encode and decode fine.** A component importing a
   function returning bare `stream<u8>` — or `tuple<stream<u8>, u32>` — decodes
   and reaches the linker stage (not a parse error).
3. **The lower/lift memory cycle has a clean break.** Put `memory` + a bump
   `cabi_realloc` in a small **libc** core module instantiated _first_; alias its
   memory/realloc; `canon lower` the host imports and `canon lift` the `run`
   export against that memory; instantiate `$main` with `(with "libc" (instance
$libc))` + the lowered-import instance. No shim/fixup indirection table is
   needed because the memory does not live in the instance that imports the
   lowered funcs. (`wasm-tools component new` would instead auto-generate the
   shim+fixup table idiom — verified by inspecting a real adapted P2 component.)

### ❌ The precise blocker for the FULL stream echo (`future<T>` encoding skew)

A component that uses a **`future<T>`** type — in EITHER an imported-instance
function signature (e.g. `stdin.read-via-stream`'s
`tuple<stream<u8>, future<result<_, error-code>>>`) or an export — **fails to
DECODE in wasmtime 44**, under every async feature-flag combination
(`component-model-async`, `-async-builtins`, `-async-stackful`,
`-error-context`, `-gc`):

```
Error: failed to parse WebAssembly module
Caused by: instance not valid to be used as import (at offset 0x…)
```

Bisected precisely: bare `stream<u8>` ✅ decodes, `tuple<stream<u8>, u32>` ✅
decodes, but adding a `future<…>` member ❌ breaks the **decode**. Since the
entire P3 stdio surface returns `future<result<_, error-code>>`, a fully-running
stdin→stdout stream echo **cannot be produced with the on-box toolchain
combination** (jco 1.16.1's bundled wasm-tools + wasmtime 44).

**Root cause = component-model-async TYPE-ENCODING version skew**, not a missing
feature flag and not a js2wasm issue: the `future`/`stream` canonical type
encoding evolved between the wasm-tools snapshot jco 1.16.1 vendors (late-2025
era) and wasmtime 44 (2026-04). wasm-tools _parses + encodes_ the `future`-typed
component; wasmtime's decoder _rejects_ that encoding. The `stream-echo.wat`
artifact is authored to the correct authoritative WIT and **parses with jco**,
but is gated at the wasmtime decode step by exactly this skew (documented inline
in the file + reproduced by `run-p3-b0.sh`).

### Binary-shape spec js2wasm's P3 producer (B2/B3) must emit

A native P3 component for `wasi:cli/run@0.3.0-rc-2026-03-15` consists of:

1. **`component-type` custom section** describing the world — package version
   string **`0.3.0-rc-2026-03-15`** exactly; `run` typed `async func() -> result`.
2. **Async-lifted `run` export**: `(canon lift (core func $run) async (callback
$cb) (memory $mem) (realloc $realloc))`. The core `run` implements the async
   protocol — returns the packed status code (`EXIT`/`WAIT`/`YIELD`/`POLL` in the
   low 4 bits, waitable-set index in the high bits) and calls `(canon
task.return (result (result)))` to deliver its result; `$cb` is the callback
   resumed by the host scheduler. (For the simpler model, lift `async` _without_
   a callback and use blocking `waitable-set.wait` under
   `-W component-model-async-stackful`.)
3. **`cabi_realloc`** (a real bump/allocator) + an owned, exported `memory`.
4. **`stream<u8>` / `future<result<_, error-code>>` lowering** of the stdio
   imports via `(canon lower (func …) (memory $mem) (realloc $realloc))`, plus
   the async built-ins `(canon stream.read/​stream.write/​future.read/​
waitable-set.new/​waitable-set.wait/​waitable.join/​subtask.drop …)` to drive
   and await the host-side stream pump. read-via-stream returns the
   `tuple<stream, future>` via a return-area pointer (the tuple exceeds 1 flat
   result); write-via-stream takes the stream handle (flat i32) and returns the
   future handle.
5. **resource/handle tables** for the `stream`/`future` handles (i32 indices
   into the component's per-instance tables).
6. **The lower/lift memory-cycle break** (libc-first or shim+fixup, both work).

**Gate output for B1+:** B2/B3 must be built against a wasm-tools whose
`future`/`stream` encoding matches **wasmtime 44**'s decoder (upgrade jco's
bundled wasm-tools, vendor a matching standalone `wasm-tools`, or have the native
producer emit the type encoding wasmtime 44 expects and validate with `wasmtime`
directly — NOT only `jco parse`, which is what masked the skew). The
async-command half of the ABI (lift/callback/`task.return`) is already proven to
run, so B2 (sync `run` producer) is unblocked by this finding; only the
`stream`/`future` half (B3) carries the encoding-skew dependency.

### B0 verdict

- **B0 acceptance met:** a runnable minimal P3 async component demonstrated under
  wasmtime 44 (`run-async.wat`), the binary-shape spec written (above), the
  `nm_wasi_p3.ts` comparison instance produced (source-reference, honestly
  labeled — the js2wasm P3 producer is the deferred B2–B4 epic).
- **Sizing unchanged:** B0 did NOT prove the epic is cheaper than scoped. The
  async-command runtime works, but the `future`/`stream` producer half now
  carries a _concrete, named_ prerequisite (toolchain encoding-skew resolution)
  on top of the component-model-producer work. Path 2 (B2–B4) stays **deferred /
  gated on #2525**. Issue remains **`in-progress`** (B0 done; B2–B4 deferred).

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — scoping/epic. The referencing PR is the B0 spike (P3 async stream<u8> echo verified under wasmtime 44). Native WASI Preview 3 is a Component-Model epic (async func / stream<T> / future<T>), deferred; only a documentation+verification interop slice is shippable now. priority low, sprint Backlog. Stays in-progress.
