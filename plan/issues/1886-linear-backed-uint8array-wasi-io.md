---
id: 1886
title: "Linear-backed Uint8Array for WASI I/O buffers (escape analysis) — avoid GC↔linear copies, beat AssemblyScript on memory"
status: in-progress
sprint: Backlog
created: 2026-06-04
updated: 2026-06-05
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: typed-arrays
goal: performance
related: [1863, 1527, 389]
---
# #1886 — Linear-backed `Uint8Array` for WASI I/O buffers

**Source:** GitHub issue #389. guest271314's AssemblyScript host
(`nm_assemblyscript_component.wat`) is faster than js2wasm on the same workload;
the `.wat` shows why, and it points at a concrete, *targeted* optimization.

## Why AssemblyScript is faster (measured + confirmed from its `.wat`)

> **Framing correction (esch 2026-06-05):** the original issue title/body framed
> this as "hold the body in memory to beat AS." That is **wrong** and the title
> is kept only for issue continuity. The team-lead's held-GC-body measurement
> confirmed that holding the 64 MiB body in a **GC array** is both *slower* and
> *fatter* than streaming a 1 MiB window — retention is not the lever. **The
> lever is getting the bytes out of the GC heap and into linear memory so
> `fd_read`/`fd_write` touch them with zero copy** (and so element ops are
> `i32.load8_u`/`i32.store8` against that same linear region). We *beat* AS on
> memory precisely by NOT holding the body — we stream a small linear window.

AssemblyScript uses **linear memory exclusively** — no WasmGC, no `array.new`/
`array.copy`/`struct.new`. Its message buffer *is* linear memory, so `fd_read`
reads **directly into** it and `fd_write` writes **directly from** it: **zero
copies**, no GC-heap instantiation.

js2wasm's `--target wasi` uses the **WasmGC backend**: `Uint8Array` is a GC
array. But WASI `fd_read`/`fd_write` can only touch *linear* memory, so every
read/write pays an element-wise copy js2wasm-side:
- `fd_read` lands bytes in a linear scratch region → copied element-by-element
  **into** the GC array (`node-process-api.ts` `emitProcessStdinRead`, the
  `array.set` loop);
- the GC array is copied element-by-element **back** to linear memory →
  `fd_write` (`index.ts` `ensureWasiWriteUint8ArrayHelper`, the `i32.store8`
  loop).

The streaming example host (landed, #389) removes body retention and the slow
`array.copy` (37 MB / ~0.50 s for 64 MiB), but it **cannot** remove these
GC↔linear copies — they're inherent to a GC-array buffer.

### Measured cost decomposition (wasmtime 45, 64 MiB `[null,...]`, this branch)

| Workload | Wall | Peak RSS | What it isolates |
|---|---|---|---|
| AssemblyScript (linear buffer, zero-copy I/O + linear memmove) | 0.12–0.24 s | 147 MB | the syscall + linear-memmove floor |
| js2wasm full native-messaging host (current merged, GC stream) | **0.50 s** | **37 MB** | I/O copies **+** GC frame-build loops |
| js2wasm I/O-only (read 1 MiB GC window, echo it back — no reframe) | 0.27 s | 30 MB | the two GC↔linear I/O copies + 64 syscalls |
| js2wasm write-only (echo a fixed 1 MiB GC buffer 64×) | **0.15 s** | 31 MB | the GC→linear **write** copy alone |

**The lever this issue is actually pulling (corrects the original framing):**
the win is **not** "hold the body in memory" (holding it in a *GC* array is both
slower *and* fatter than the streaming window — confirmed by the team-lead's
held-body measurement). The win is **getting the bytes out of the GC heap and
into linear memory so `fd_read`/`fd_write` touch them with zero copy.** The
write copy alone is ~0.15 s and the read copy is symmetric: the two GC↔linear
I/O copies are ≈0.27 s of the 0.50 s — i.e. **the dominant, removable cost**.
The remaining ~0.23 s is the per-element frame-build/carry loops, which are
`array.get_u`/`array.set` today and become `i32.load8_u`/`i32.store8` once the
buffer is linear-backed — comparable per-op, but they then feed `fd_write` with
**no boundary copy at all**. So a correct #1886 should reach **~0.15–0.25 s at
flat ~24–31 MB** — AS-class speed while *beating* AS on memory (no 147 MB
linear body; we stream through a 1 MiB linear window). The target is **not**
"match AS" — it's "AS speed, AS-beating memory."

## The optimization (not a global backend switch)

Selectively back a `Uint8Array` by **linear memory** when analysis proves it is
a plain I/O buffer that does not need GC — keep GC arrays everywhere else.

A `new Uint8Array(n)` is "linear-safe" iff it never escapes to a GC-requiring
use (stored in a GC struct/array, returned as a ref, captured, etc.) and is only
indexed / passed to `process.stdin.read` / `process.stdout.write`. For such an
array:
- allocate it in **linear memory** as `(ptr, len)`;
- `process.stdin.read(buf, off)` → `fd_read` straight into `ptr+off` (no copy);
- `process.stdout.write(buf)` → `fd_write` straight from `ptr` (no copy);
- `buf[i]` → a linear load/store.

When the analysis can't prove safety, fall back to the GC array (today's
behavior). GC stays the default; linear is used only where it's a pure buffer —
"without changing this for cases where it's not needed." Stays within the
"mimic standard Node APIs" rule: it's a transparent optimization of plain
`Uint8Array` + `process.stdin/stdout`, no bespoke builtin.

## What it requires

1. **Escape/usage analysis** for typed arrays — mark a `Uint8Array`
   "linear-safe" iff it never escapes to a GC-requiring context. (The
   typed-array slice of general escape analysis.)
2. **A linear allocator** for these buffers — the WASI output already has a
   linear memory and a (currently dead) `$__wasi_bump_ptr` global; wire up a
   real bump/arena (a per-port-loop arena reset suits short-lived I/O buffers).
3. **Codegen** so indexing + the `stdin.read`/`stdout.write` intrinsics operate
   on a linear-backed array, with a clean GC fallback.

Overlaps the `codegen-linear` backend (#1527) and general escape analysis, but
as an analysis-driven optimization rather than a target choice.

## Acceptance criteria

- A WASI byte-I/O host (e.g. `examples/native-messaging/nm_js2wasm.ts`) whose
  `Uint8Array` buffers are provably I/O-only compiles with **no GC↔linear
  copies** on the read/write path; verified in the `.wat` (no element-wise
  GC→linear loop around `fd_read`/`fd_write`).
- 64 MiB round-trip wall time within ~2× of the AssemblyScript host.
- No correctness/behavior change for `Uint8Array` that does escape (GC fallback
  intact); existing tests + `smoke-test.sh` pass.

## Implementation Plan (esch, 2026-06-04)

### 0. Scope and guiding principle

This is an **analysis-driven optimization inside the WasmGC front-end +
codegen**, gated to `--target wasi` (and standalone with linear memory). It is
**not** a switch to the `codegen-linear` backend (#1527) and **not** a global
default change. GC stays the representation for every `Uint8Array`; a buffer is
moved to a **linear (`ptr`, `len`)** representation only when analysis *proves*
it is a pure I/O buffer that never needs GC. When proof fails — fall straight
back to today's GC vec, byte-for-byte unchanged.

The representation has to be **end-to-end consistent for a given buffer**: if
`buf` is linear-backed, then `new Uint8Array(n)` for it, every `buf[i]`
load/store, `buf.length`, and the `stdin.read(buf)` / `stdout.write(buf)`
intrinsics must all agree on the linear form. We cannot make *only* the I/O
intrinsics zero-copy while keeping the GC array for indexing — the bytes would
live in two places. So the analysis decides per-buffer, and the whole
representation switches together.

### 1. Linear-safe escape/usage analysis (new module `src/codegen/linear-uint8-analysis.ts`)

A pre-pass over the WASI source file that classifies each `Uint8Array` *binding*
(`const`/`let`/`var` initialized from `new Uint8Array(...)`, and function
**parameters** typed `Uint8Array`) as **linear-safe** or not.

**Linear-safe predicate** — a binding is linear-safe iff *every* use of it is
one of the allowed forms, and it never enters a GC-requiring context:

Allowed uses:
- element load/store: `b[i]` / `b[i] = v` (any index expr);
- `b.length`;
- `process.stdin.read(b)` / `process.stdin.read(b, off)`;
- `process.stdout.write(b)` / `process.stderr.write(b)`;
- passed as a call argument to a function whose corresponding **parameter is
  itself linear-safe** (interprocedural threading — see fixpoint below);
- `new Uint8Array(b)` is *not* allowed (it would view/copy — keep GC).

Disqualifying (forces GC fallback):
- stored into any object/array/struct field, a closure capture, a module
  global, or `this.x = b`;
- returned from a function (`return b`);
- assigned to a binding of wider/`any`/`unknown`/union type;
- used by any method other than the allowed I/O intrinsics (`.subarray`,
  `.slice`, `.set`, `.fill`, `.indexOf`, spread `[...b]`, `for..of b`,
  `Array.from(b)`, `JSON.stringify`, template interpolation, `===`/`==`
  identity compare, `b instanceof`, `typeof`, etc.);
- passed to a function parameter that is *not* linear-safe, or to any
  externref/host-import boundary, or to an **exported** function's parameter
  (export ABI is observable — keep GC);
- reassigned to point at a different array, or aliased via destructuring.
- aliasing: `const c = b;` then using `c` in a disqualifying way disqualifies
  `b`. Treat any non-call-arg, non-index, non-`.length`, non-I/O reference
  conservatively as an escape.

**Interprocedural fixpoint** (the native-messaging host needs it — `buf` is
threaded into `readExact`/`readAt`/`emitRun`):
1. Seed: assume every `Uint8Array` parameter of every **non-exported** function
   is *candidate* linear-safe; every exported function's `Uint8Array` params are
   *not* linear-safe (observable ABI).
2. Iterate to fixpoint: for each function, walk its body; a parameter loses
   candidacy if used in any disqualifying way *or* passed to a callee parameter
   that is currently non-linear-safe. A `new Uint8Array` binding is linear-safe
   iff all its uses are allowed under the *current* parameter classification.
3. Converge (monotone: only ever demote, never promote), then freeze.

Output: a `Set<ts.Symbol>` of linear-safe **bindings** (locals + params) plus a
`Set<funcSymbol→paramIndex[]>` map of which params are linear-backed, consumed
by codegen. Conservative by construction — any uncertainty ⇒ not linear-safe.

Keep this analysis **off by default** behind a context flag
(`ctx.linearUint8 = true` only when `ctx.wasi`), so non-WASI builds are
untouched and the blast radius is contained.

### 2. Linear bump allocator (wire up the dead `$__wasi_bump_ptr`)

`registerWasiImports` already declares a `$__wasi_bump_ptr` global
(`index.ts:4578`) that is currently dead. Wire a real bump allocator:
- Reserve a fixed linear region for linear-backed buffers **above** the existing
  WASI scratch pages (`WASI_STDIN_BUF_START = 64 KiB`,
  `WASI_WRITE_SCRATCH_START = 128 KiB`). Add `LINEAR_U8_ARENA_START = 192 KiB`
  (page 3) and initialize `$__wasi_bump_ptr` to it.
- New helper `__lin_u8_alloc(len: i32) -> i32` (emitted lazily, like the
  write helpers): align `len` up to 8, `ptr = bump`, `bump += len`, `memory.grow`
  if `bump` exceeds `memory.size` (reuse the `ceil(x/65536)=(x+65535)>>16`
  page-growth idiom already used by the write helpers), return `ptr`. A
  zero-init is **not** needed for `fd_read` buffers but `new Uint8Array(n)` is
  spec'd zero-filled — linear memory is zero on grow, but a *reused* arena slot
  is not; see arena-reset below.
- **Arena reset (the per-port-loop reclamation):** the native-messaging buffers
  (`header`, `one`, `buf`) are allocated once before the `while(true)` loop and
  reused; the per-iteration `small`/`tmp`/`frame` are allocated *inside* the
  loop. A naive bump-forever leaks ~`frame` per message → unbounded growth on a
  long stream. **Reset rule:** when a linear-safe `new Uint8Array` appears
  inside a loop body, snapshot the bump pointer at loop entry and rewind to it
  at the bottom of each iteration (a `__lin_u8_arena_mark` / `__lin_u8_reset`
  pair around the loop body). Justification: a buffer allocated *inside* an
  iteration cannot legally outlive that iteration under the linear-safe
  predicate (it doesn't escape, isn't returned, isn't captured), so rewinding at
  the iteration boundary is sound. Buffers allocated *outside* the loop sit
  below the mark and survive. For correctness of the zero-fill contract,
  `new Uint8Array(n)` in a reused slot must `memory.fill(ptr, 0, len)` — cheap
  vs the eliminated copies, and only when the source actually reads
  before-write (we can keep it unconditional for safety in v1).
  - **Phase the reset carefully**: v1 may allocate without reset (correct,
    leaks on infinite streams) to land the zero-copy I/O win first, then add the
    loop-scoped reset in a follow-up slice once the simpler path is proven. Flag
    this in the PR.

### 3. Codegen — linear-backed buffer representation

Represent a linear-safe buffer as an **i32 local holding its `ptr`**, plus a
companion i32 local holding its `len` (allocated alongside in `allocLocal`).
Member/intrinsic lowering branches on "is this binding linear-safe?":

- **`new Uint8Array(n)`** (`new-super.ts` ~2299/3024, the
  `isNativeUint8Array` arm): if the binding is linear-safe, emit
  `len = n; ptr = __lin_u8_alloc(n); memory.fill(ptr,0,n)` and bind the two i32
  locals **instead of** `getOrRegisterVecType` + `array.new_default`. The
  `new Uint8Array([a,b,c])` literal form: alloc `len=count`, then a sequence of
  `i32.store8 ptr+k, literal`.
- **`b[i]` read** (`property-access.ts` `compileElementAccessBody`): if `b` is
  linear-safe, emit `i32.load8_u (ptr + i)` returning `{kind:"f64"}` after
  `f64.convert_i32_u` to match the existing Uint8Array element value type (the
  current GC path returns the byte widened to the array's element kind — keep
  the *observable* numeric type identical).
- **`b[i] = v`** (assignment compiler): `i32.store8 (ptr+i), trunc(v)&0xff`.
- **`b.length`**: `local.get len` → `f64.convert_i32_u`.
- **`process.stdin.read(b, off)`** (`node-process-api.ts`
  `emitProcessStdinRead`): when `b` is linear-safe, **skip the `array.set` copy
  loop entirely** — set the iovec base to `ptr + off`, length to `len - off`,
  call `fd_read`, return `nread`. Zero element copies.
- **`process.stdout.write(b)`** (`node-process-api.ts` →
  `ensureWasiWriteUint8ArrayHelper`): when `b` is linear-safe, skip the
  `i32.store8` staging copy — set the iovec base to `ptr`, length to `len`, call
  `fd_write`. Zero element copies.
- **Passing a linear-safe `b` to a linear-safe callee param**: pass the two i32s
  (`ptr`, `len`) as two wasm params. This means linear-backed functions get a
  *rewritten signature*: each linear-safe `Uint8Array` param becomes
  `(ptr: i32, len: i32)`. Build the func type from the param classification map.
  All call sites of such a function must agree — guaranteed because the analysis
  froze the param set before codegen.

**GC fallback**: when a binding is *not* in the linear-safe set, every site
above takes the existing GC vec path **unchanged**. The new branches are
strictly additive (`if (isLinearSafe(sym)) { …new… } else { …existing… }`), so
non-WASI and any escaping `Uint8Array` are byte-identical to today.

### 4. Files / functions to touch

| File | Change |
|---|---|
| `src/codegen/linear-uint8-analysis.ts` (new) | the analysis pass + result types |
| `src/codegen/context/types.ts` | add `linearUint8Set?: Set<ts.Symbol>`, `linearUint8Params?: Map<...>`, `linearU8BumpGlobalIdx`, arena constants to `CodegenContext` |
| `src/codegen/index.ts` | run analysis when `ctx.wasi`; `LINEAR_U8_ARENA_START`; `__lin_u8_alloc` / arena-mark / reset helpers; init `$__wasi_bump_ptr`; add linear-write fast path in `ensureWasiWriteUint8ArrayHelper` (or a sibling `__wasi_fd_write_linear(ptr,len)`) |
| `src/codegen/node-process-api.ts` | linear-safe branches in `emitProcessStdinRead` + the write dispatch in `tryCompileNodeProcessCall` |
| `src/codegen/expressions/new-super.ts` | linear-backed `new Uint8Array(n)` / `new Uint8Array([..])` |
| `src/codegen/property-access.ts` | linear-backed `b[i]` read in `compileElementAccessBody` |
| assignment site (find the `array.set` element-assign path) | linear-backed `b[i] = v` |
| `.length` member access | linear-backed length |
| function-signature builder + call-arg lowering | rewrite linear-safe `Uint8Array` params to `(ptr,len)`; thread args |
| `tests/issue-1886.test.ts` (new) | analysis unit tests (safe vs escaping) + emitted-wasm assertions (no `array.set`/`array.get_u` loop around `fd_read`/`fd_write` for the example) + execution equivalence |

### 5. Downstream-effect checklist (senior-dev diligence)

- **Stack balance / ValType**: `b[i]` must keep returning the same *observable*
  value type the GC path returns (`f64` after the widen) so callers' arithmetic
  is unchanged. Verify no stack-type mismatch by re-validating the emitted wasm.
- **Function-index shifting**: `__lin_u8_alloc` and the linear write helper are
  late-emitted lazily — they must register through `ctx.funcMap` and respect the
  `addUnionImports`/late-import shift discipline (`ctx.currentFunc.body` shift),
  exactly like the existing `__wasi_write_*` helpers. Do NOT cache a raw
  `funcIdx` across a late import.
- **Signature rewrite is the riskiest piece** — a linear-safe param becomes two
  i32s. If *any* call site disagrees (e.g. a missed escape that should have
  demoted the param), the module fails validation. The fixpoint must be
  conservative and the codegen must consult the *same frozen* classification at
  both the callee def and every call site. Add a verifier assertion: if a
  function is linear-rewritten, every call to it in the module must be
  linear-arg.
- **`memory 3` → larger**: arena lives in page 3; `registerWasiImports` reserves
  3 pages today. Bump the reserved minimum to 4 and let `memory.grow` handle the
  rest (the write helpers already grow on demand).
- **`one`/`header` tiny buffers**: still worth linear-backing (uniform path), but
  the win is in `buf`/`frame`. No special-casing needed.
- **Don't regress non-Uint8Array typed arrays**: the analysis only touches
  `Uint8Array` under `noJsHost`/`wasi`; `Int32Array`/`Float64Array` stay GC.

### 6. Expected result vs acceptance criteria

- Emitted `.wat` for `nm_js2wasm.ts`: **no `array.set` loop** in the stdin-read
  path and **no `i32.store8` staging loop** in the stdout-write path — `fd_read`
  targets `ptr+off`, `fd_write` reads from `ptr` directly. (Baseline today: 49
  `array.set`, 37 `array.get_u`; expect the I/O-path ones gone, frame-build
  `array.*` replaced by `i32.load8_u`/`i32.store8`.)
- 64 MiB round-trip wall ~0.15–0.25 s (from 0.50 s), peak RSS flat ~24–31 MB
  (we do **not** hold the 64 MiB body — still streaming a 1 MiB linear window).
  Within ~2× of AS on wall, **better** than AS on memory.
- Escaping `Uint8Array` (stored in a struct, returned, captured): GC path
  unchanged; existing typed-array tests + `examples/native-messaging/smoke-test.sh`
  (if present) + a scoped equivalence subset pass.

### 7. Phasing (slices for safe landing)

- **Slice A** — analysis module + unit tests (no codegen change). **DONE**
  (merged): marks every `nm_js2wasm.ts` buffer linear-safe and rejects crafted
  escaping cases; wired behind `ctx.wasi`, byte-identical to baseline.
- **Slice B** — linear allocator + `new`/index/`.length`/zero-copy-I/O codegen,
  **intraprocedural only**. **DONE** (this PR).
- **Slice C** — interprocedural signature rewrite so `readExact`/`readAt`/
  `emitRun` take linear `(ptr,len)` params → full zero-copy I/O. **NOT STARTED.**
- **Slice D** — zero-copy direct-slice write + loop-scoped arena reset.
  **NOT STARTED.**

## Slice B — what landed (esch 2026-06-05)

Intraprocedural linear backing for a `new Uint8Array(...)` **local**. A buffer
qualifies (`isLocalLinearNewBinding` in `src/codegen/linear-uint8-codegen.ts`)
iff Slice-A proved it linear-safe AND, additionally for Slice B:
1. it is a `new Uint8Array(...)` **local** (not a param — params stay GC);
2. it is used **only intraprocedurally** — `b[i]`, `b.length`, and the I/O
   intrinsics `process.std*.{read,write}(b)` only. A buffer passed to a **user
   function** is rejected here even though Slice A admits it (Slice A's
   permissive set is forward-looking to Slice C's signature rewrite; Slice B has
   no callee-signature rewrite, so a `(ptr,len)` local cannot cross a GC-typed
   call ABI);
3. it is **allocated at most once per run** (`isAllocatedAtMostOnce`) — not
   inside a loop, and its enclosing function is the module entry or is called at
   most once and never from a loop. This is the **bump-arena leak guard**: the
   arena is monotonic (no free) until Slice D, so a per-iteration `new` would
   leak ~1 MiB/iteration. Buffers that fail this stay GC-backed.

Codegen: `(ptr,len)` i32 locals via a lazily-emitted `__lin_u8_alloc(len)->ptr`
bump allocator over a dedicated page-4 arena global `$__lin_u8_arena_ptr`
(NOT the page-0 `$__wasi_bump_ptr`, which aliases string-literal data). `b[i]` →
`i32.load8_u`, `b[i]=v` → `i32.store8`, `b.length` → the `len` local,
`stdin.read`/`stdout.write` → zero-copy `fd_read`/`fd_write` against `ptr`.

**Two root-caused codegen bugs fixed (the WIP's validation failure):**
1. **Allocator funcIdx desync → bare `ref.null extern` in a void fn.** The WIP
   pre-emitted `__lin_u8_alloc` *before* `collectAllSourceImports`. `addImport`
   does NOT shift already-registered defined functions, so every later import
   shifted the module's import/defined boundary and left `call __lin_u8_alloc`
   pointing at an *import* (e.g. `__extern_get`, 2 params/1 result). That made
   the function's net stack delta `-1`; `stackBalance`'s function-level
   `fixBranch(expected=0)` then saw the body as "short one value" and, for an
   empty block type, pushed a `ref.null extern` to fill it — leaving a value on
   the stack at the end of a void `main` → invalid wasm
   (`expected externref, found i32`). **Fix:** emit `__lin_u8_alloc` in the
   deferred-helper zone (alongside `emitToUint32Helper`/`emitDeferredWasiHelpers`,
   after `collectAllSourceImports`, before the final
   `reconcileNativeStrFinalizeShift` and before user functions), so its index is
   stable and any residual drift is reconciled by the native-string regime.
2. **Predicate mismatch → spurious `__extern_get`/`__str_flatten` desync.** The
   hoist pre-pass skipped the GC `$buf` local using the *raw* Slice-A
   `safeBindings` set, but the declaration-site lowering used the tighter Slice-B
   predicate. For a buffer Slice A admitted but Slice B declined (e.g. the nm
   host's `buf`, threaded through `readExact`), the GC local was skipped yet the
   binding fell back to the GC path with no storage → it pulled in GC extern
   helpers against a missing local and desynced `__str_flatten`. **Fix:** the
   hoist-skip now uses the same `isLocalLinearNewBinding` predicate.

**Result.** `probe_u8` (single buffer in `main`) is fully linear-backed and
round-trips correctly under wasmtime **v44** and **v45** (stdin `0x41` →
`buf[0]=(0x41+1)&255=0x42` → stdout, rest zero-filled). The native-messaging
host (`nm_js2wasm.ts`) is **byte-identical** to current main (`cmp` passes):
every one of its buffers either escapes via a helper param (Slice C territory)
or is allocated per-frame in a loop (Slice D territory), so Slice B correctly
declines all of them and emits no allocator/arena — h2h on v44/v45 is unchanged
(`validJSON=true match=true`, 65 frames, flat ~24 MB on v45). **The host speedup
is therefore NOT in Slice B** — it requires Slice C (cross-function `(ptr,len)`)
and Slice D (zero-copy direct-slice write + arena reset). Slice B lands the
allocator + intraprocedural codegen + the two index-shift fixes as a safe
foundation.

## Slice C — interprocedural signature rewrite (NOT STARTED — the host win)

Rewrite each linear-safe `Uint8Array` **parameter** of a non-exported function to
a `(ptr: i32, len: i32)` pair, and thread linear args as two i32s at every call
site. This is what unlocks the nm host: `readExact`/`readAt`/`emitRun` currently
receive `buf` as a GC vec, forcing the buffer GC-backed; once they take
`(ptr,len)`, `buf` in `main` becomes linear and the whole read/build/write path
is zero-copy. Risk (per §5): the rewrite must consult the *same frozen*
classification at the callee def and every call site — a single missed escape
that should have demoted the param makes the module fail validation. Add a
verifier assertion: a linear-rewritten function must have linear args at every
call. Slice A already froze `linearParams` (funcSym → linear param indices) for
exactly this consumer.

## Slice D — zero-copy direct-slice write + loop-scoped arena reset (NOT STARTED)

Two related follow-ons, landable together once B+C make the host buffers linear:

1. **Loop-scoped arena reset** (lifts Slice B's allocate-at-most-once guard).
   The bump arena is monotonic today. Snapshot `$__lin_u8_arena_ptr` at loop
   entry and rewind to it at the bottom of each iteration (`__lin_u8_arena_mark`
   / `__lin_u8_reset`). Sound because a linear-safe buffer allocated *inside* an
   iteration cannot escape it. `new Uint8Array(n)` into a reused slot must then
   `memory.fill(ptr,0,len)` to honour the zero-fill contract. This lets
   per-frame buffers (`frame`, `small`, `tmp`) be linear-backed without leaking,
   and lets the nm host's `emitRun` frame buffer go linear.

2. **Zero-copy direct-slice write.** Once a buffer is linear-backed, drop
   `emitRun`'s per-frame element-copy entirely and write the run's bytes
   DIRECTLY from the linear window: `stdout.write("[")`, a zero-copy `fd_write`
   of `buf[start .. start+runLen)`, `stdout.write("]")`. Clean API (no bespoke
   builtin): linear-backed `Uint8Array.prototype.subarray(start,end)` returns a
   zero-copy VIEW (`ptr+offset`, `len`) over the same arena — not a copy — and
   `process.stdout.write(view)` does `fd_write` from `view.ptr+view.offset` for
   `view.len`. "The fastest copy is the one you don't do" — this beats AS (which
   does one memmove into its output buffer) on both wall and memory.

**Sequencing:** Slice B (this) → Slice C (interprocedural signature rewrite) →
Slice D (arena reset + zero-copy direct-slice write). Acceptance for C+D: the nm
host h2h reaches AS-class wall (~0.15–0.25 s) at flat ~24–31 MB, with
`emitRun`'s per-frame copy gone and no arena leak on long-lived streams.
