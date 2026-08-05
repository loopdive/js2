---
id: 4159
title: "SOUNDNESS: typed-lane array element access bypasses the #3251 vec overlay — a defineProperty accessor index reads the stale element and drops the setter write (standalone, confirmed)"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone
language_feature: arrays, property-descriptors
goal: standalone-mode
related: [3251, 3116, 2042, 3185]
origin: "Design review of #3251's fast-path guard, 2026-08-04"
---

# #4159 — typed-lane array element access bypasses the vec overlay (accessor arm)

## Summary

`Object.defineProperty(arr, "1", { get, set })` on a statically-typed
`number[]` is **silently ignored** by the typed inline `array.get` / `array.set`
lane under `--target standalone`. The read returns the stale vec element and the
write goes into the vec instead of calling the setter. No trap, no diagnostic —
a wrong answer.

This is not a missing feature; it is an **incoherence between two halves of the
same object**. #3251's overlay made the *dynamic* lane correct while the typed
lane kept reading the raw backing, so `arr[1]` and `dyn[1]` on the same array at
the same instant disagree.

## Confirmed repro (2026-08-04, this branch, `pnpm install` + `npx tsx`)

```ts
// A — typed read through a getter
export function f(): number {
  const arr: number[] = [10, 20, 30];
  Object.defineProperty(arr, "1", { get: function () { return 99; }, configurable: true });
  return arr[1];                       // got 20, expected 99   ❌
}

// B — typed write through a setter
let seen: number = 0;
export function f(): number {
  const arr: number[] = [10, 20, 30];
  Object.defineProperty(arr, "1", {
    set: function (v: number) { seen = v; },
    get: function () { return 99; },
    configurable: true,
  });
  arr[1] = 5;
  return seen;                         // got 0, expected 5     ❌
}
```

Controls that PASS, which is what localises the bug:

```ts
// data descriptor on the same index — the value write-back keeps the vec coherent
Object.defineProperty(arr, "1", { value: 77, writable: true, configurable: true });
return arr[1];                         // got 77                ✅

// same array, same accessor, read through the DYNAMIC lane
const dyn: any = arr;
return dyn[1];                         // got 99                ✅
```

So: **data descriptors are fine, accessors are not, and only the typed lane is
wrong.** Probe scripts: `.tmp/probe-typed-accessor.mts`, `.tmp/probe2.mts`
(scratch, not committed — the repro above is self-contained).

## Root cause

From `src/codegen/vec-overlay.ts`'s own header (#3251 S1), the coherence
strategy is explicitly two-pronged:

> Data-define VALUES are written back INTO the vec (per-carrier
> `__vec_elem_set_<t>`) so the typed inline `array.get` fast path stays coherent
> with **zero read overhead** […] Dynamic reads (`__extern_get_idx` […]) get a
> finalize-spliced overlay prologue: accessor entries invoke their getter via
> `__call_accessor_get` […]

That is a sound design **for data descriptors only**. An accessor define has no
value to write back — and the epic's implementation plan says the typed read is
"raw `array.get` inline — NOT hookable cheaply". The result is that the accessor
arm has *no* path to the typed lane at all. `grep -n overlay src/codegen/object-ops.ts
src/codegen/expressions/*.ts` returns one comment and no consultation.

The epic's stated mitigation — "accessor defines do NOT extend the vec length
for OOB indices" (the #3116 hole-materialisation lesson) — protects only
*out-of-bounds* indices. The failing case is **in-bounds**, where the element
already exists and the typed read is a plain `array.get`.

## Why this matters more than its test count

- It is a **wrong answer, not a refusal**. The compiler emits confident code.
  Every other #3251 gap either throws or produces a diagnosable failure.
- It is **lane-incoherent within one program**: `arr[1] !== dyn[1]` for the same
  `arr` and the same instant, decided purely by the static type of the reference.
  Whether a read is correct depends on whether the type checker happened to keep
  the array monomorphic — an invisible, non-local property.
- The #3251 acceptance criteria include *"dense-array fast path unchanged (no
  perf/behaviour regression)"* — the fast path is indeed unchanged, which is
  exactly the problem. **The epic can meet its stated criteria with this hole
  open**, so it needs to be tracked separately rather than assumed covered.

## Suggested direction (needs an architect call, do not implement blind)

The tension is real and the whole point of the overlay is to avoid taxing the
dense path, so "just route typed reads through the overlay" is the wrong fix. A
guard is needed whose cost the dense case does not pay. Options, cheapest first:

1. **Per-carrier deopt flag consulted only when the module-global overlay state
   is non-null.** The existing outer guard
   (`global.get $__vec_overlay_state; ref.is_null`) already gives a
   near-zero-cost "no descriptors anywhere in this module" check. A typed read
   could emit `if overlay-state != null → call the dynamic path; else →
   array.get`. Programs that never touch `defineProperty` on an array pay one
   global load + null test per element access — measurable in a hot loop, so
   this needs benchmarking, not assertion.
2. **Hoist the guard out of the loop.** For a typed loop over a local array
   whose identity does not escape, the guard is loop-invariant; check once on
   entry and pick a dense or generic loop body. Same shape as the per-call
   protector proposed for prototype-chain lookups.
3. **Escape-based specialisation.** If a `number[]` local provably never reaches
   `Object.defineProperty`/`Reflect.defineProperty` or any dynamic sink, the
   typed lane is unconditionally safe and needs no guard at all. This is the
   only option with genuinely zero steady-state cost, and it is also the most
   work.
4. **Refuse instead of miscompiling.** Interim: if the compiler sees a
   `defineProperty` with an accessor descriptor targeting a value that also has
   typed-lane reads, emit a structured compile error. Turns a silent wrong
   answer into a diagnosable refusal while the real fix is designed. Consistent
   with the `STRICT_IR_REASONS` philosophy of promoting silent fallbacks to hard
   errors.

## Acceptance criteria

- `arr[1]` on a typed `number[]` with an accessor index invokes the getter, on
  both the typed and dynamic lanes, and the two agree.
- `arr[1] = v` invokes the setter rather than writing the backing.
- Dense-array benchmark suite shows no regression beyond an agreed budget —
  state the measured number, do not assert "negligible".
- Host/gc lane behaviour is determined and stated (see below).
- Standalone floor NET ≥ 0.

## Open questions

- **Host/gc lane is UNVERIFIED.** Instantiating the host build needs a
  `string_constants` import module that the quick probe could not supply, so the
  same repro was not run there. #3251 states the host lane routes through
  `__defineProperty_desc` / `__vec_set_elem` (#3116) imports, which suggests it
  may be coherent — but that is inference, not measurement. Verify before
  scoping.
- **Non-writable data descriptors, typed write** — `writable: false` then
  `arr[1] = 5` throws a `WebAssembly.Exception` in standalone. That may well be
  the spec-correct strict-mode `TypeError` (module code is strict); the probe did
  not decode the exception payload, so this case is **inconclusive** and is
  deliberately not claimed as a defect here.
- How many test262 files does this account for? Not measured. The #3251 epic
  sizes the accessor-index cluster at ~204 host-free assertion failures via the
  *dynamic* lane, which the overlay already fixed. The typed-lane share is
  probably small in test262 (the corpus is untyped JS) and much larger in
  real TypeScript input — which is the dogfooding risk, not a conformance one.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate` (record
  `#4159 … status=reserved`, read from `origin/issue-assignments`). The
  allocator's open-PR scan degraded (`gh` unavailable in this container), so
  `--allow-unscanned` was used after scanning the open-PR set through the GitHub
  API: two open PRs (#4106, #4123), highest issue id introduced is 4154. The
  required `check:issue-ids:against-main` gate remains the backstop.
- No regression test is added with this issue on purpose — a committed failing
  test would red the `equivalence-gate` for every unrelated PR. Add it with the
  fix.
