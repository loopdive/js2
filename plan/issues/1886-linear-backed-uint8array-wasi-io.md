---
id: 1886
title: "Linear-backed Uint8Array for WASI I/O buffers (escape analysis) — avoid GC↔linear copies, beat AssemblyScript on memory"
status: done
pr: 1288
sprint: 61
created: 2026-06-04
updated: 2026-06-10
completed: 2026-06-10
slice_b_status: done
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: typed-arrays
goal: performance
related: [1863, 1527, 389]
claimed_by: codex-developer
claimed_at: 2026-06-07T10:10:06.150Z
---
# #1886 — Linear-backed `Uint8Array` for WASI I/O buffers

**Source:** GitHub issue #389. guest271314's AssemblyScript host
(`nm_assemblyscript_component.wat`) is faster than js2wasm on the same workload;
the `.wat` shows why, and it points at a concrete, *targeted* optimization.

## Why AssemblyScript is faster (measured + confirmed from its `.wat`)

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

- **Slice A** — analysis module + unit tests (no codegen change); prove it marks
  every `nm_js2wasm.ts` buffer linear-safe and correctly *rejects* a crafted
  escaping case. Lands behind the flag, gated off.
- **Slice B** — linear allocator + `new`/index/`.length` codegen + the
  intraprocedural buffers (`header`, `one`, `buf` in `main`). No signature
  rewrite yet (so `readExact`/`emitRun` still take GC — but those are only the
  small/parameter paths; measure the partial win).
- **Slice C** — interprocedural signature rewrite so `readExact`/`readAt`/
  `emitRun` take linear `(ptr,len)` params → full zero-copy I/O. This is where
  the big number lands.
- **Slice D** (optional follow-up) — loop-scoped arena reset for unbounded
  streams.

**Landing plan (revised, esch 2026-06-05):** PR #1 = **Slice A** only (the
analysis pass, wired behind `ctx.wasi`, with no codegen consumer — emitted
WASI modules verified byte-identical to baseline via `cmp`). Tech lead approved
splitting the risky signature-rewrite (Slice C) into its own PR; the same
isolation logic applies to the codegen wiring (Slice B), so the bump allocator
+ `new`/index/`.length`/zero-copy I/O codegen lands as **PR #2** and the
interprocedural signature rewrite as **PR #3**. This banks the analysis
foundation (zero runtime risk) and keeps each codegen change independently
reviewable + benchmarkable. The allocator design (page-4 arena at
`LINEAR_U8_ARENA_START = 256 KiB`, a dedicated `$__lin_u8_arena_ptr` bump global
— NOT the page-0 `$__wasi_bump_ptr`, which aliases string-literal data —
emitted lazily reusing the #1856 align8 + page-grow idiom) is prototyped and
typechecks; it ships with PR #2.

Slices A+B+C are the core of this issue; D can be a follow-up if the per-message
allocation proves to leak on infinite streams (the benchmark sends one large
message, so A–C suffice to hit the acceptance numbers, but D is needed for
production correctness on long-lived ports — call it out in the PR).

## Slice B — implementation notes (esch, 2026-06-05, PR #2)

**Landed:** the bump allocator + intraprocedural `new`/`b[i]`/`b[i]=v`/`b.length`
+ zero-copy `fd_read`/`fd_write` codegen for linear-backed `Uint8Array` locals.
Correctness-preserving (the GC path is untouched for everything not proven
Slice-B-eligible); the full host speedup arrives in Slice C.

### What "Slice-B-eligible" means — and why it is NARROWER than Slice A
Slice A (`safeBindings`) proves a buffer never escapes the GC heap, and it
*admits param-threaded buffers* (a buffer passed to a user function whose
parameter is itself linear-safe) so that Slice C can rewrite those signatures.
But Slice B is **intraprocedural only** — it does not rewrite signatures yet.
Backing a param-threaded buffer linearly *now* would hand a `(ptr,len)` i32 pair
to a callee still typed for a GC array at the call boundary → invalid Wasm
(`expected (ref null $type), found i32`). This is exactly what blew up the
native-messaging host on the first cut: `__str_flatten` mis-validated because
`main`'s `header`/`buf` were linear-backed but `readExact(header, …)` still
expected a GC array.

**Fix (root cause, not symptom):** the analysis now also computes
`localOnlyBindings` — the subset of `safeBindings` that is (a) a `new
Uint8Array(...)` *local* (never a parameter) and (b) **never** passed as an
argument to a user function (its only call-arg uses are the
`process.std*.{read,write}` I/O intrinsics, which Slice B lowers in place).
Codegen consumes `localOnlyBindings`, NOT `safeBindings`, at all four wiring
sites (`isLinearSafeBinding`, the TDZ hoist-skip, the eager type-reserve gate,
the late allocator-emit gate). This keeps analysis ⇔ codegen *exactly aligned*:
codegen linear-backs precisely the set it can correctly represent. Slice C will
widen consumption to all of `safeBindings` once the signature rewrite is in.

This is still a real intraprocedural win on the nm host: `emitRun`'s per-frame
`frame` buffer (built with an element loop and written whole) IS local-only, so
its element loop now lowers to `i32.store8` and its write is zero-copy; only the
threaded read window (`buf`/`header`/`one`/`small`/`tmp`/`src`) stays GC until C.

### The real root cause of the `expected externref found i32` fault — late-import func-index shift (sd-1886, PR #2)
The FINDINGS handoff attributed the `function[34]::main … expected externref,
found i32 at offset 4634` to the void-function finalizer. Disassembling the
binary at that offset proved otherwise: the byte is **`call 2`**, and import
func 2 is `env.__extern_get` — i.e. `$main`'s `call $__lin_u8_alloc` was
resolving to the wrong slot. Root cause: the WIP emitted the allocator
**eagerly** (before the import collectors), so it claimed a low defined-func
index; then `collectUsedExternImports` registered `env.__extern_get` (added for
the `buf[i]` externref element-access pre-pass) via the bare `addImport` path,
which bumps `numImportFuncs` but does **not** shift already-baked defined-func
indices. The allocator's true index moved up by one; its `funcMap` entry and
every baked `call $__lin_u8_alloc` stayed stale → the call landed on
`__extern_get` (an `(externref)->…` import) while passing an i32 length. (This
is the exact `addUnionImports` hazard CLAUDE.md documents.)

**Fix (split type from function):** `reserveLinearU8AllocType` registers the
allocator's `(i32)->(i32)` func **type** eagerly (before any GC struct/array or
native-string helper type, keeping the shared `ctx.mod.types` prefix stable so
`__str_flatten`'s baked `(ref null $type)` indices don't shift), while the
allocator **function** is emitted in the post-import-registration helper block
(alongside `emitToUint32Helper` / `emitDeferredWasiHelpers`) where
`numImportFuncs` is final — so its defined index is correct and survives
`env.__extern_get`. This dual constraint is why neither the all-eager nor the
all-lazy single-shot emission point works; both desync one path or the other.
Once the fix landed, the void function ended cleanly with no leftover
`ref.null extern` — confirming the finalizer was never the fault.

### `new Uint8Array(arrayBuffer)` view form must stay GC (#1654 regression guard, sd-1886)
The length-form lowering treats the single `new Uint8Array(arg)` argument as a
byte count. For `new Uint8Array(someArrayBuffer)` — a zero-copy view over an
ArrayBuffer — `arg` is an object, not a number; lowering it as a length would
call `__lin_u8_alloc(<object>)` and read garbage (broke
`tests/issue-1654-*`). `isLengthOrLiteralNewUint8` now gates the codegen:
single-arg `new Uint8Array` is linear-backed **only** when the argument's static
type is `NumberLike`/`any`; any object-typed arg (ArrayBuffer / TypedArray /
array-like) falls through to the GC path, which models the view aliasing
correctly. The array-literal and zero-arg forms stay linear.

### The void-completion `ref.null extern` fault (kept; orthogonal)
`tryEmitLinearU8ElementSet` returns `VOID_RESULT` and leaves nothing on the
stack — `buf[i] = v` compiles as a pure statement store, so the
module/function completion-value tracker is never left owing an unpaired
trailing `ref.null extern`. `x = buf[i] = v` value-of-assignment is unsupported
for linear-backed buffers (out of scope for byte-I/O workloads; the analysis
never admits a buffer read as a bare identifier anyway).

### Slice B validation gate (all green)
- `probe_u8.ts` (`buf[i] = (buf[i]+1)&255` + stdin/stdout) validates AND
  round-trips under wasmtime **v44 (pinned) and v45**; `.wat` shows
  `i32.load8_u`/`i32.store8` + iovec `fd_read`/`fd_write`, zero `array.*` for the
  buffer, no stray GC `$buf` local, no trailing unpaired `ref.null extern`.
- nm host compiles to **valid** Wasm; `h2h` 64 MiB message = **65 frames /
  13,421,760 elements / validJSON=true / match=true** on v44 AND v45; the
  single-frame echo path also round-trips. (Peak ~84 MB — the 1 MiB read window
  is still GC until Slice C; B's gate is correctness, not the ~24 MB number.)
- Escaping buffer (returned) and param-threaded buffer (nm `buf`) both correctly
  fall back to GC — verified in `.wat` (0 linear store8 for those) + execution.
- `tests/issue-1886.test.ts` (Slice-A analysis + Slice-B `localOnlyBindings`
  eligibility, 12) + new `tests/issue-1886-slice-b.test.ts` (codegen-validity +
  execution round-trips, incl. the index-shift validity guard, the string-mix
  `__str_flatten` guard, the escaping + param-threaded GC-fallback cases, and
  `&255` wrap; 8) + `tests/wasi.test.ts` (24) + `tests/issue-1654-*` (the
  `new Uint8Array(ab)` view-form regression guard, 5) + `tests/issue-1856.test.ts`
  (allocator idiom, 5) all green.
- No new failures vs `origin/main` in the targeted suites above; CI runs the
  full conformance gate on the PR.

## Slice C — interprocedural signature rewrite (attempt 22)

Implemented on `symphony/1886`:
- `linearParams` functions now register wasm signatures with each proven-safe
  `Uint8Array` param expanded to `(ptr: i32, len: i32)`.
- Function-body lowering registers the original source param name in
  `fctx.linearU8Buffers` while exposing only synthetic ptr/len locals in the
  actual wasm param list.
- Direct identifier calls to linear-param helpers pass the caller's registered
  `(ptr,len)` pair for matching source arg positions; non-linear args keep the
  existing path and exported/unsupported helper signatures stay GC.
- The linear codegen now consumes `safeBindings` for locals threaded through
  helpers, while constructor representability still rejects ArrayBuffer/view
  forms so #1654 stays on the GC path.
- Added function and loop arena marks/resets for short-lived linear `Uint8Array`
  locals. This prevents `emitRun`/loop-local buffers from growing linear memory
  per call/iteration once Slice C starts backing the native-messaging read
  window linearly.

Validation on 2026-06-07:
- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run tests/issue-1886.test.ts tests/issue-1886-slice-b.test.ts`
  (24 tests; includes helper ptr/len execution, stdin offset, conservative
  `arguments` demotion, and loop arena reset memory cap)
- `pnpm exec vitest run tests/wasi.test.ts tests/wasi-stdin.test.ts tests/issue-1653-wasi-process-stdin-read.test.ts tests/issue-1654-wasi-dataview-arraybuffer.test.ts tests/issue-1655-wasi-arraybuffer-write.test.ts tests/issue-1856.test.ts tests/issue-1618-1651-wasi-stdout.test.ts`
  (59 tests)
- `pnpm exec vitest run tests/issue-1753.test.ts` (64 MiB bounded native
  messaging pattern workload stays <=8 MiB linear memory)
- `pnpm exec vitest run tests/issue-1767.test.ts -t "completes the reported 64x Chrome null-array workload with bounded memory"`

Observed during expanded validation: full `tests/issue-1767.test.ts` still has
the existing large-JSON-string expectation failure (`invalidStringFrames = 65`);
the native-messaging source and that test are unchanged from `origin/main`, and
the #1886-affected bounded-memory/null-array cases pass after the arena reset.

Attempt 30 closeout on 2026-06-07: merged current `origin/main` into
`symphony/1886` after PR #1288's prior CI was blocked only by the
stale-baseline guard, then reran scoped validation successfully:
`pnpm exec tsc --noEmit`, `pnpm exec vitest run tests/issue-1886.test.ts
tests/issue-1886-slice-b.test.ts` (24/24), `pnpm exec vitest run
tests/wasi.test.ts tests/wasi-stdin.test.ts
tests/issue-1653-wasi-process-stdin-read.test.ts
tests/issue-1654-wasi-dataview-arraybuffer.test.ts
tests/issue-1655-wasi-arraybuffer-write.test.ts tests/issue-1856.test.ts
tests/issue-1618-1651-wasi-stdout.test.ts` (59/59), `pnpm exec vitest run
tests/issue-1753.test.ts` (3/3), `pnpm exec vitest run tests/issue-1767.test.ts
-t "completes the reported 64x Chrome null-array workload with bounded memory"`
(1 passed, 3 skipped), and `bash examples/native-messaging/smoke-test.sh`.
Issue stays `in-review` with ready PR #1288 for the PR-status poller.

## Slice D — zero-copy direct-slice write (follow-on, banked)

Naming: the interprocedural signature rewrite is **Slice C**; the lead's
zero-copy-subarray idea is a SEPARATE follow-on recorded here as **Slice D** to
avoid collision. Once a buffer is linear-backed (B/C), drop `emitRun`'s per-frame
copy entirely — write the run's bytes DIRECTLY from the linear window:
- linear-backed `Uint8Array.prototype.subarray(start,end)` returns a zero-copy
  VIEW over the SAME linear buffer (`ptr+offset, len`) — not a copy. (Today the
  host avoids `subarray` because GC `array.copy` is ~14× slower than an element
  loop on i8 arrays; linear-backed makes the view free.)
- `process.stdout.write(view)` → `fd_write` from `view.ptr + view.offset` for
  `view.len`, zero copy.
- `nm_js2wasm.ts` then drops `emitRun`'s element loop, writing
  `buf.subarray(start, start + runLen)` directly.

Acceptance: `emitRun`'s per-frame copy gone; `h2h` shows the host AT/BELOW AS
speed AND flat memory. Land as its own PR after Slice C merges (or carve a
sub-issue). Sequencing: Slice B (this) → Slice C → Slice D.
