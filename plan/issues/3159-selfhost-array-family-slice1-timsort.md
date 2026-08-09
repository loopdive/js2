---
id: 3159
title: "Self-hosted stdlib, array family slice 1: timsort kernels as TS source through our own IR pipeline"
status: ready
sprint: current
created: 2026-07-12
updated: 2026-07-12
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: refactor
area: ir, codegen, stdlib
language_feature: compiler-internals
goal: ir-full-coverage
related: [3141, 2855]
origin: "plan/self-hosting-scale-up.md family 4 (array methods) — first bounded slice"
---

# #3159 — Array family slice 1: self-host the timsort kernels (`src/codegen/timsort.ts`, 922 lines)

## Problem

`array-methods.ts` (9,565 lines) + its kernels are hand-emitted `Instr[]`. The #3141
pilot (GO) proved builtins written as ordinary TS source compile through our own
pipeline into drop-in replacements. This slice converts the array family's largest
pure, self-contained, funcMap-registered unit: the four timsort kernels
(`__isort_{k}` / `__merge_{k}` / `__merge_run_{k}` / `__timsort_{k}`, k ∈ {i32, f64}),
922 lines of hand assembly in `src/codegen/timsort.ts`.

## Why timsort first (root-cause analysis of the family)

Every `compile*` function in `array-methods.ts` is **element-type-generic** (one
inline emitter parameterized over f64/i32/i8/i16/ref/externref). Self-hosting only
*deletes* hand code when the TS dialect covers **all** elem kinds a unit
instantiates — a partial (f64-only) conversion keeps the generic hand emitter alive
and the PR goes net-POSITIVE. Timsort is the one unit whose instantiation set is
already restricted to **i32|f64** (#2502 guards; ref/externref sorts route to the
ToString insertion sort or no-op), and from-ast's magnitude compares are
**polymorphic over f64 AND i32** (#1126 Stage 3) — so ONE templated TS source
instantiates both variants and the whole hand file collapses. It is also
funcMap-registered with a fixed external ABI (`__timsort_{k}(vec) -> ()`), i.e. the
exact drop-in shape the Math pilot proved.

## Implementation plan (as built)

1. **Intrinsic callees (Precursor B, first concrete cut).** The IR dialect cannot
   express raw-array get/set/new/copy, and from-ast call args require exact IrType
   match (no f64→i32 index coercion), so the stdlib source calls tiny typed
   intrinsics with **f64 index params**: `__arri_get_<k>` / `__arri_set_<k>` /
   `__arri_new_<k>` / `__arri_copy_<k>` (k = elem kind; the run stack reuses the
   f64 set). Each is materialized on demand as a real ~5-instr defined function
   (internal `i32.trunc_sat_f64_s` on indices) by the driver's `resolveFunc` —
   name-based, funcIdx-shift safe, correctness never depends on any inliner.
2. **Driver generalization** (`src/codegen/stdlib-selfhost.ts`): new
   `emitSelfHostedFunc(ctx, def)` accepting per-def `paramTypes` (IrType[], allows
   `(ref null $arr)` / `(ref null $vec)` via from-ast `paramTypeOverrides`),
   `returnType`, `calleeTypes`, and an intrinsic-materializer hook. **No process
   memoization for these** (unlike the Math pilot): vec/arr typeIdx values are baked
   into the IR, which is only valid for the ctx that registered them. Emission
   happens once per compilation per elem kind (funcMap-cached), same as the hand
   path rebuilt its `Instr[]` per compilation.
3. **TS sources** (`src/stdlib/array-sort.ts`): the four kernels as a source
   template instantiated per elem kind. Ports the hand algorithm **op-for-op**
   (same compare directions/stability ladder: `>` in isort, `<=` in merge, `<` in
   run detection & collapse tie-breaks; minRun; 85-deep run stack; force-collapse).
   Internal signatures move index params to f64 (`number`) — sound (indices < 2^31,
   exact in f64) and only observable inside the kernel family; the external
   `__timsort_{k}(vec)` ABI is preserved by a ~10-instr hand thunk that extracts
   `(data, len)` and calls the self-hosted `__sh_timsort_{k}`. The run stack uses
   f64 arrays (values are run bases/lengths — exact) instead of the hand version's
   i32 arrays; observationally equivalent.
4. **Dialect findings** (bounds of the subset, documented not hacked): no `NaN`/
   `Infinity` idents (pilot rule, not needed here); minRun halving via
   `Math.floor(nmr / 2)` and odd-bit accumulation via compare if the bitwise arms
   misbehave on the template (probe decides); element values must stay segregated
   from index arithmetic (i32 elems don't mix into f64 counters — timsort only
   loads/compares/stores elements, never mixes).
5. **Proof** (pilot method): (a) behavioral sweep — sorted outputs of branch-built
   binaries vs main-built binaries, bit-compared elementwise over edge cases (NaN,
   ±0, ±Inf, denormals, dups, presorted/reversed/sawtooth, lengths spanning the
   63/64 isort cutoff and minRun boundaries, randoms) for f64 AND i32 (boolean[])
   elem vecs, host + standalone; (b) containment — byte-identical binaries for
   sort-free programs (SHA compare vs main).

## Acceptance criteria

- `src/codegen/timsort.ts` hand bodies deleted; file ≈ thin registration +
  intrinsics (~1/4 its size). Net across the PR strongly negative.
- Sweep: zero mismatches vs main-built control across the edge-case matrix.
- Byte-inert for non-sort programs (SHA-verified).
- Full CI green (test262 net ≥ 0, quality, standalone floor in merge_group).

## Non-goals

- No inline-substitution/peephole of intrinsic calls in this slice (perf lever,
  follow-up if benches ever demand it; sort is not on the benchmark sidebar).
- No conversion of comparator sorts / ToString default sort (different units).
- No `array-methods.ts` inline-emitter conversions yet (slices 2+ — need elem-kind
  coverage per the analysis above).

## Follow-up: slice 2 scoping (the copy-family)

`array-methods.ts` is **985 inline `fctx.body.push` sites** — every `compile*`
emitter splices into the CALLER's frame, so unlike timsort (a module-level
fixed-ABI helper) they are **not byte-inert to convert**: self-hosting an inline
emitter turns inlined code into an out-of-line call, changing byte output. That
moves the proof bar from byte-inert containment to **measured-net-non-negative +
behavioral sweep** (still bit-exact vs main-built control, but binaries differ).

The highest-leverage next unit is the **copy-family** — `compileArrayToReversed`
(99), `compileArrayWith` (60), `compileArrayToSpliced` (133), `compileArraySlice`
(36), `compileArrayConcat` (119) — which all inline the same "alloc
`array.new_default` + `array.copy` + per-element transform + `struct.new` vec"
pattern. Plan: extract each to a self-hosted `__sh_<method>_<k>(vec, …) -> vec`
called from a thin inline wrapper (the wrapper keeps the vec-struct
extract/repack the dialect can't express, exactly the timsort thunk shape).
Precursor: extend `__arri_*` to **all 6 element kinds** (add packed i8/i16
get_s/get_u/set) so one templated source covers every instantiation and the
generic inline emitter can actually be deleted (per the net-deletion rule above).
Estimated net −150…−250 across the family. **Start fresh from main AFTER the
driver (#3161/#2916) and this slice land** — avoids a held-PR stack and a triple
`emitSelfHostedFunc` collision.
