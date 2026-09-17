---
id: 1645
title: "spec gap: ArrayBuffer resizable + TypedArray detached-buffer guards (100 + 39 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-09-17
completed: 2026-09-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typedarray
goal: spec-completeness
sprint: current
renumbered_from: 1351
parent: 1328
# (2026-09-17, S1) The §23.2.4.4 detached-view guard has to sit on the
# `__call_m_<name>_<arity>` dispatcher prologue, because a `$__ta_dyn_view` is a
# `$__vec_base` subtype and the generic vec arm claims every method with no
# `__ta_dyn_<m>` helper. The two call sites (fixed-arity + vararg) plus their
# rationale comments and the import are +22 lines in the file and +21 in
# `fillClosedMethodDispatch`. The alternative measured WORSE: a `ref.eq` name
# ladder on `__extern_method_call` scored identically (9 pass on the 33-row
# list) while interning ~30 extra method-name globals into every dyn-view
# module, so it was removed. The guard body itself lives in
# `ta-dyn-method-call.ts`, which is the subsystem module for this dispatch.
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
---
# #1351 — ArrayBuffer.resize / detached-buffer guards on TypedArray methods

## Problem

`built-ins/ArrayBuffer`: **87 / 196 pass (44.4%) — 100 fails (44 wasm_compile, 36 assertion_fail,
9 other, 5 null_deref, 1 type_error)**.
`built-ins/DataView`: **410 / 561 pass (73.1%) — 26 runtime_error among 112 fails**.
`built-ins/Uint8Array`: **31 / 68 pass (45.6%) — 37 fails**.

Spec §25.1 (ArrayBuffer): ArrayBuffer can be resizable (constructor accepts `{maxByteLength}`) or
fixed-length. Detached buffers throw TypeError on every read/write/access.

Spec §23.2 (TypedArray): every prototype method must check IsDetachedBuffer at the start, throw
TypeError if detached. ArrayBuffer.transfer detaches the source.

The 44 wasm_compile errors in ArrayBuffer suggest the ResizableArrayBuffer constructor signature
isn't recognized — the typed-codegen path gets a wrong arity.

## Acceptance criteria

1. `built-ins/ArrayBuffer/prototype/resize/length.js` passes.
2. `built-ins/ArrayBuffer/transfer/detaches-source-buffer.js` passes.
3. `built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js` passes.
4. `built-ins/DataView/prototype/getInt32/detached-buffer-throws.js` passes.
5. Pass-rate for `built-ins/ArrayBuffer` rises from 44% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__arraybuffer_*` host imports
- `src/codegen/registry/typedarray.ts` — detached-buffer guards on every prototype method

## Implementation Plan

### Root cause

ResizableArrayBuffer is newer (ES2024); our codegen registry doesn't have an overload for the
options-object constructor `new ArrayBuffer(byteLength, {maxByteLength})`. Type-inference picks
the wrong overload and emits a wasm_compile-failing call.

Detached-buffer guards: each TypedArray method needs a prologue:
```
if (IsDetachedBuffer(this[[ViewedArrayBuffer]])) throw TypeError
```
We've inlined the methods without this guard.

### Approach

1. **Resizable**: add an options-object constructor variant. Store `maxByteLength` in the
   ArrayBuffer struct; `.resize(newLength)` updates `byteLength` if `<= maxByteLength`, throws
   RangeError otherwise.
2. **transfer**: implement by allocating a new buffer, copying data, marking source detached.
3. **Detached guards**: extend the codegen registry so every TypedArray method emits a detached
   check at entry. Add `IsDetachedBuffer` host import that returns 1/0.

### Edge cases

- `transfer()` with no argument → use source's byteLength.
- `transfer(newLen)` where newLen > source: zero-pad.
- Detached check must run even for length-0 access (e.g. `view.getInt8(0)` on a 0-length detached buffer).
- DataView: detached check separate from ArrayBuffer detached.

### Test262 sample

- `test262/test/built-ins/ArrayBuffer/prototype/resize/length.js`
- `test262/test/built-ins/ArrayBuffer/transfer/detaches-source-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js`

## Remaining work (2026-06-17, PO reconcile — NOT started)

The s63 reconciler flagged this issue because merged PR #1532
(`chore(#2148): drain in-review orphan pool — reconcile #1326, #1645`) carries
`#1645` in its title. That PR is **docs-only** — it re-classified this issue's
status during the orphan-pool sweep and explicitly recorded "No implementation
exists (spec-gap)", setting it to `ready` / `sprint: Backlog`. The other three
merged PRs that name #1645 (#702/#666/#800) are likewise all `docs(...)`
escalation/dedup notes, not code.

**No code has landed against any acceptance criterion.** Resizable ArrayBuffer
(`{maxByteLength}` constructor + `.resize`), `ArrayBuffer.transfer`, and the
TypedArray/DataView detached-buffer guards are all unimplemented; the
`built-ins/ArrayBuffer` pass-rate target (44% → ≥75%) is unmet. Status correctly
stays `ready` / `sprint: Backlog` — the full Implementation Plan above is the work
to be done.

## Slicing (dev-g investigation, 2026-07-17)

Measured against fresh `upstream/main`: substantial resize/detach machinery
already exists (#3054-C / #3058 `.resize`, #3097 host-AB marshal bridge), but
**`ArrayBuffer.prototype.transfer` has no dispatch arm** — `ab.transfer()`
throws `TypeError: transfer is not a function` from the `__extern_method_call`
fall-through (`src/runtime.ts` ~L10668, right after the `resize` arm at L10569).

I prototyped a runtime `transfer` / `transferToFixedLength` arm that allocates a
host `ArrayBuffer` with the copied bytes and marks the source detached
(`_detachedBuffers.add`). It compiles and `dest.byteLength` reads correctly, but
it **fails the target test262 asserts** (`prototype/transfer/from-fixed-to-same.js`
et al.) for two structural reasons, both requiring **codegen** work, not
runtime-only:

1. **Source detach is invisible to compiled native reads.** The test asserts
   `source.byteLength === 0` after transfer. A statically-typed `ArrayBuffer`
   receiver lowers `.byteLength` to a direct `array.len` on the backing vec
   struct, which **bypasses** the host `_detachedBuffers` WeakSet mark — so it
   returns the *old* length (measured: 8, not 0). Detaching a compiled AB struct
   needs a **native detach primitive** (zero the vec length field + a
   struct-readable detached flag), so `array.len` / the detached guards observe
   it. The same gap breaks `source.slice()`-throws-after-detach.
2. **`new Uint8Array(dest)` over a host-AB externref returns NaN.** transfer must
   return a value the *compiled* code can view; the compiled `TypedArray`
   constructor over a host `ArrayBuffer` externref does not read its bytes
   (measured: `destArray[0]` → NaN). Either the ctor must accept a host AB, or
   transfer must return a **compiled vec struct** (which needs a host-callable
   struct allocator — none is exported today; only in-place `__rab_resize`).

### Proposed 3-way split

- **(a) native AB detach primitive + `transfer`/`transferToFixedLength`** —
  senior-dev, **L**. Add a codegen detach op on the vec struct (length→0 +
  detached flag readable by `array.len` sites and the detached guards) and a
  host-callable byte-vec allocator so `transfer` can return a live compiled
  buffer; wire the two dispatch arms. Unblocks the `transfer` cluster
  (~48 tests) and acceptance criterion #2.
- **(b) detached-buffer method guards** on TypedArray/DataView prototype
  methods — **M**. `$262.detachArrayBuffer` uses the host WeakSet path (already
  observable), so these guards (`copyWithin`/`getInt32`/… throw TypeError when
  detached) are runtime-tractable independent of (a). Acceptance criteria #3/#4.
- **(c) resizable prototype-introspection / descriptor tests** — **hard**.
  `resize.length === 1`, `transfer.name`, `dest.resizable`/`maxByteLength`
  descriptor shape, etc. require real function-object / accessor introspection
  on builtin prototypes, which the compilation model does not currently model.

Leave #1645 `ready` as the umbrella; (a)/(b)/(c) can be filed as sub-issues when
scheduled.

---

## Implementation Plan — S1: `%TypedArray%.prototype.buffer` returns the viewed buffer's IDENTITY (2026-09-17)

### The premise above is wrong, and the correction is the whole slice

This file has said since May 2026 that the gap is *missing detached-buffer
guards on TypedArray methods*. **Measured on current `main` (68bcd9eb4d),
`--target standalone`, `result.imports === []` on every probe: the guards are
already there and they already work.** Mark the real buffer detached and the
methods throw the §23.2.4.4 ValidateTypedArray TypeError, on every element type:

| receiver | `ta.fill(0)` after the buffer is marked detached |
| --- | --- |
| Uint8Array · Int8Array · Uint16Array · Int32Array · Float32Array · Float64Array · Uint8ClampedArray | TypeError, all seven |

`forEach`, `sort`, `slice`, `indexOf` and `join` behave the same. Detaching
through a *function* (the shape `$262.detachArrayBuffer` uses — a parameter, not
a literal receiver) also works.

**What is actually broken is one line of identity.** test262 never detaches the
buffer it constructed; `$DETACHBUFFER(sample.buffer)` detaches whatever the
`.buffer` GETTER hands back. And under standalone that getter hands back a
different object:

| probe (standalone, imports `[]`) | result | expected |
| --- | --- | --- |
| `const b = new ArrayBuffer(8); b === b` | 1 | 1 |
| plain-object and aliased-buffer identity controls | 1, 1 | 1, 1 — **reference equality itself is fine** |
| `new Float64Array(b).buffer === b` | **0** | 1 |
| `new DataView(b).buffer === b` | **0** | 1 |
| `t.buffer === t.buffer` | 1 | 1 — stable, so it is ONE wrong object, not a fresh one per read |
| `new Float64Array(new ArrayBuffer(64)).buffer.byteLength` | **0** | 64 |

So `$DETACHBUFFER` marks the stand-in, the view keeps reading its live backing,
and all 33 rows report *"Expected a TypeError to be thrown but no exception was
thrown at all"*. The guard never fired because it was asked about the wrong
object.

### Where it comes from — the code says so itself

`src/codegen/property-access-dispatch.ts`, the #2596 `propName === "buffer"`
arm: for a TypedArray receiver under `noJsHost`, it **synthesizes a fresh,
zero-filled `i32_byte` vec** sized to the view's byte length. Its own comment:

> TRUE write-through aliasing (mutating `.buffer` mutates the view, and
> `a.buffer === b.buffer` identity) is OUT OF SCOPE — it needs the unified
> byte-storage representation … this slice is the non-trapping floor.

That floor was the right call in #2596 (before it, the generic
`__extern_get(view, "buffer")` read `ref.cast` to the buffer vec and trapped
`illegal cast`, breaking every `.buffer`-touching test). It is not the right
answer now, and **two other routes in this repo already give the right one**:

- `src/codegen/ta-dyn-mop.ts:450` (the dynamic-MOP route) returns
  `struct.get` field 1 of the view — the same backing ref — and its comment
  states the intent exactly: *"the SAME backing byte-vec ref `new ArrayBuffer(n)`
  produced … so `ta.buffer === buffer` holds and $DETACHBUFFER's len=-1 write is
  observable through it."*
- The **DataView** half of the #2596 arm was already converted by #3173:
  *"a DataView's `.buffer` is its ACTUAL viewed buffer, identity included …
  return it directly instead of synthesizing a fresh zero-filled copy."*

This is the session's recurring shape: a correct implementation exists, and the
route a plain test262 program actually takes is not the one that reaches it.

### Change

Give the **TypedArray** half of that arm the identity the DataView half already
has, and the dynamic-MOP route already returns.

1. In the #2596 arm (`property-access-dispatch.ts`), replace the synthesized
   zero-filled vec for `bufIsTypedArr` with the view's real backing ref, the way
   `ta-dyn-mop.ts:450` does. A view constructed **over an existing
   ArrayBuffer** must return that buffer; a view constructed from a **length**
   (`new Float64Array(8)`) must return the buffer it implicitly created, and
   return the *same* one on every read.
2. The representation question the #2596 comment flags is real and must be
   answered, not assumed: a `new Float64Array(n)` view's backing is an `f64`
   vec, while an ArrayBuffer is a bare `$__vec_i32_byte`. **Establish by
   measurement which shape each construction path produces before writing the
   arm** — `ta-dyn-mop.ts` returning field 1 unconditionally is evidence the
   struct already carries a buffer ref, but evidence is not proof for every
   construction path. If some path genuinely has no byte-vec to hand back, say
   so with the probe that shows it and scope that path out **by name**; do not
   silently keep synthesizing for it.
3. **`byteLength` must come out right too.** `t.buffer.byteLength` measures 0
   for a 64-byte buffer today — the #2596 comment claims this arm exists to make
   exactly that "correct and non-trapping", so it is already not doing what it
   says. Whatever the fix is, a 64-byte buffer reads 64, and a detached one
   reads 0 (§25.1.3.3 maps detached to `length < 0`, and byte reads clamp
   negatives to 0 in `property-access.ts`).
4. **Re-check the DataView row.** `new DataView(b).buffer === b` measures **0**
   here despite #3173. Either the `usesNativeDataViewProvider(ctx)` condition on
   that arm did not hold for this probe, or #3173's identity is narrower than
   its comment claims. Find out which and state it; if it is the former, the
   probe is fine and the arm is simply not reached — say that rather than
   "fixing" a working mechanism.

### Acceptance

- `new <TA>(b).buffer === b` is **1** for all seven element types, and for a
  view constructed from a length the getter returns the same object twice.
- `new Float64Array(new ArrayBuffer(64)).buffer.byteLength` is **64**.
- The 33 ES2015 detached rows (list regenerated by `.tmp/detach-census.mjs`
  against `.test262-cache/test262-standalone-current.jsonl`): measured on BOTH
  a merge-base worktree and the branch, same `.test262-cache` symlinked into
  both. **Zero rows lost** — the per-test edition ratchet fails on a single
  pass→not-pass in ES2015 and there is no waiver (this is what is currently
  blocking #6493; do not repeat it).
- A control set over `built-ins/TypedArray`, `built-ins/TypedArrayConstructors`,
  `built-ins/DataView` and `built-ins/ArrayBuffer` (162 ES2015 non-pass rows in
  that area today, plus their passing neighbours) re-run on both trees.
- `result.imports` stays `[]`.
- gc / js-host output byte-identical: this arm is `noJsHost`-gated, so the host
  lane must not move at all — sha256 a set of probes on both trees.

### Recorded on the way, not part of this slice

- **`ta.reverse()` on a detached buffer is a COMPILER CRASH**, not a wrong
  answer: `Binary emit error: encodeValType: packed storage type "i8" is not
  valid in a value position … a packed type leaked into a param/result/local/
  global` (`src/emit/binary.ts:887`). Reproduced standalone with a five-line
  program. `fill`/`forEach`/`sort`/`slice`/`indexOf`/`join` on the same detached
  receiver all compile and throw correctly, so it is specific to `reverse`.
  Needs its own issue.

---

## S1 RESULT (2026-09-17) — the plan above is corrected by measurement

**`.buffer` identity was never the defect.** The plan's probe table is an
artifact of how the probe was written, and the change that landed is a
different one: the §23.2.4.4 ValidateTypedArray **throw** on a detached
dynamic view.

### Correction 1 — the `(x as any)` cast, not the compiler, produced the zeros

Every row of the plan's table was probed as `(t as any).buffer`. That cast is
load-bearing in the wrong direction: `taViewReceiverTypeIdx`
(`src/codegen/property-access.ts:3471`) discriminates on the receiver being an
**identifier** whose local/global SLOT type is a `$__ta_view` typeIdx. An
`as`-expression is not an identifier, so the read falls past the working
`emitTaViewAccessor` route (`dataview-native.ts:8635`, which returns
`struct.get` field 1 — the buffer itself) down to the #2596
synthesize-a-fresh-zero-filled-vec floor.

Re-probed on the same commit (68bcd9eb4d) with a plain identifier receiver,
`--target standalone`, `result.imports === []`:

| probe | plan's table (`(t as any).buffer`) | measured (`t.buffer`) | expected |
| --- | --- | --- | --- |
| `new Uint8Array(b).buffer === b` | — | **1** | 1 |
| `new Int8Array(b).buffer === b` | — | **1** | 1 |
| `new Uint16Array(b).buffer === b` | — | **1** | 1 |
| `new Int32Array(b).buffer === b` | — | **1** | 1 |
| `new Float32Array(b).buffer === b` | — | **1** | 1 |
| `new Float64Array(b).buffer === b` | 0 | **1** | 1 |
| `new Uint8ClampedArray(b).buffer === b` | — | **1** | 1 |
| `new DataView(b).buffer === b` | 0 | **1** | 1 |
| `new Float64Array(new ArrayBuffer(64)).buffer.byteLength` | 0 | **64** | 64 |

So plan item 4 answers itself: **#3173's DataView identity works.** Nothing was
wrong with that arm; the probe simply never reached it. Nothing in
`property-access-dispatch.ts` was changed.

### Correction 2 — which construction path has a byte-vec (plan item 2, measured)

- **View over an existing ArrayBuffer** — `$__ta_view_<name>`
  (`registry/types.ts:399`), fields `[length, buf: ref null $__vec_i32_byte,
  byteOffset, kind]`. Shared backing, all seven element types: writing through
  the view is visible on the buffer (`new Float64Array(b); t[0] = 2;
  new DataView(b).getUint8(7) === 0x40`, and the integer views at byte 0).
- **Dynamically constructed view** (`new TA(x)` with `TA` a parameter — the
  test262 shape) — `$__ta_dyn_view`, same `buf` field. `.buffer` already
  returns it (`ta-dyn-mop.ts:450`), and the detach IS observable through it:
  `b.byteLength` measured 8 before the `$DETACHBUFFER` write and 0 after.
- **Static length construction** (`new Float64Array(8)`) — a plain
  `$__vec_f64` `{length, data}`. **It has no byte-vec at all**, so `.buffer`
  synthesizes one: `t.buffer.byteLength` is right (64) but `t.buffer ===
  t.buffer` is **0**. Scoped OUT by name, as the plan permits: giving it
  identity needs either a per-view side table or routing the length ctor
  through `$__ta_view`, and neither moves a single test262 row — the corpus
  reaches `.buffer` through the dynamic carrier, which already answers
  correctly. Probe: `.tmp/rep3.ts probe_lenCtorSame`.

### The real defect, and the fix

`$__ta_dyn_view` is a `$__vec_base` subtype. A `%TypedArray%.prototype` method
with no native `__ta_dyn_<m>` helper — `some`, `every`, `forEach`, `sort`,
`keys`, `values`, `entries`, `find`, `findIndex`, … — is therefore claimed by
the **generic vec arm** of its `__call_m_<name>_<arity>` dispatcher, which reads
the view's post-detach length of **0**, iterates zero times and returns
normally. §23.2.4.4 step 5 requires a TypeError. That is exactly the reported
error on 24 of the 33 rows: *"Expected a TypeError to be thrown but no exception
was thrown at all."*

Fix (2 files, +169 lines, no new module, no new host import):

- `src/codegen/ta-dyn-method-call.ts` — `TA_DYN_VALIDATE_METHOD_NAMES` (the
  §23.2.4.4 method set, `subarray` deliberately excluded) and
  `taDynDetachedGuardInstrs`, which builds
  `if (ref.test $__ta_dyn_view recv && recv.expando == null && recv.buf.length < 0) throw TypeError`.
- `src/codegen/closed-method-dispatch.ts` — that prologue on both the
  fixed-arity and vararg `__call_m_*` dispatcher bodies. The method name is a
  compile-time constant there, so there is no runtime name ladder.

Three properties that keep it narrow:

- It can only fire when the shared backing vec's length is the **`-1` detach
  marker** (`tryCompileStandaloneDetachedWrite`), a value unreachable for a live
  buffer. A program that never detaches is behaviourally unchanged.
- `ctx.standalone`-gated and `ctx.taDynViewTypeIdx >= 0`-gated: the js-host/gc
  lane and every module without a dynamic view emit byte-identical output.
- The `expando == null` clause is §7.3.2 shadowing in conservative form — a view
  carrying ANY own member declines the throw, so `view.some = f; view.some()`
  can never be preempted.

**Rejected on measurement:** the same guard was first built as a `ref.eq` name
ladder prepended to `__extern_method_call`'s `$__ta_dyn_view` arm. Measured on
the 33-row list it scored **identically** (9 pass) while interning ~30 extra
method-name string globals into every dyn-view module, so it was removed.

### Measured — both trees, same `.test262-cache`, `--isolate --standalone`

Base = a detached worktree at the merge-base `68bcd9eb4d`; branch = the same
list on the change. Nothing before the runner's `=== counts ===` line is used.

| list | base | branch | delta |
| --- | --- | --- | --- |
| the 33 ES2015 detached rows | 0 pass / 32 fail / 1 CE | **9 pass** / 23 fail / 1 CE | **+9, 0 lost** |

Flipped to pass, all `built-ins/TypedArray/prototype/<m>/detached-buffer.js`:
`entries`, `every`, `find`, `findIndex`, `forEach`, `keys`, `some`, `sort`,
`values`.

Still failing, and why (each is a different defect, not this one):
`copyWithin` / `fill/coerced-*` detach *during argument coercion*, so an
entry-time guard cannot see it; `forEach|reduce|reduceRight|every|some
/callbackfn-detachbuffer` detach *mid-callback* and assert an iteration count;
`subarray/detached-buffer` wants `ToInteger(begin)` observed (and already threw
a TypeError on base — unchanged by this change); `ArrayIteratorPrototype/next`,
`DataView/custom-proto-access`, `TypedArray.from/*` are other paths.

### Acceptance against the plan

- `new <TA>(b).buffer === b` for all seven types — **green** (was already green;
  pinned).
- `new Float64Array(new ArrayBuffer(64)).buffer.byteLength === 64` — **green**
  (was already green; pinned).
- "for a view constructed from a length the getter returns the same object
  twice" — **NOT delivered**, scoped out by name above with the probe that shows
  it. It is the static length-ctor path only, and it moves no rows.
- 33 detached rows, both trees, **zero lost** — met.
- `result.imports` stays `[]` — asserted in the pin test on every standalone
  compile.
- Host/gc lane does not move — proven by sha256 on probe modules compiled both
  ways on both trees, plus a gc-lane assertion in the pin test.

Pin test: `tests/issue-1645-detached-view-validate.test.ts`.

### Follow-ups — file each as its own issue, NOT under this id

This issue closes on S1. The umbrella's other strands are untouched and each
needs its own scope; re-opening #1645 for them would hide S1's measured result
behind an open-ended title:

1. **Resizable `ArrayBuffer` + `ArrayBuffer.prototype.transfer`** — the original
   1351/#1645 headline. Unaddressed.
2. **Detach observed DURING argument coercion** — `fill/coerced-{value,start,end}-detach`,
   `copyWithin/coerced-values-*-detached`. An entry-time guard is the wrong
   shape: §23.2.3.8 step 10 re-checks IsDetachedBuffer AFTER `ToNumber(value)`,
   so each method needs a post-coercion re-check.
3. **Detach observed DURING a callback** — `forEach|reduce|reduceRight|every|some
   /callbackfn-detachbuffer`. These assert an ITERATION COUNT (`loops === 2`),
   so they need the per-iteration length re-read, not a throw.
4. **`ta.reverse()` on a detached buffer is a COMPILER CRASH** —
   `encodeValType: packed storage type "i8" is not valid in a value position`
   (`src/emit/binary.ts:887`). Re-confirmed present on both trees on
   2026-09-17, i.e. NOT affected either way by S1. Still needs its own issue.
5. **`.buffer` identity for a STATIC length-constructed view** —
   `new Float64Array(8)`; see the scope-out above. Zero measured test262 value,
   so it should be scheduled only if a real consumer needs it.
6. **`subarray` on a detached dyn view throws today and should not** —
   measured identical before and after S1 (probe `.tmp/pin.ts probe_subarray`
   returned `1` on both trees), so it is pre-existing, not a regression. It is
   the reason `subarray` is excluded from `TA_DYN_VALIDATE_METHOD_NAMES`.
