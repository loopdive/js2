---
id: 4514
title: "R2 prepared-owner call closure: directional awareness / component splitting to restore compile-once for ABI-certified callees of withdrawn callers"
status: done
completed: 2026-08-16
assignee: ttraenkler/opus-ir-2
sprint: 78
created: 2026-08-16
priority: high
horizon: m
feasibility: hard
model: opus
reasoning_effort: high
task_type: enhancement
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
lane: ir-retirement
parent: 3518
related: [4508, 4494, 3521, 3518]
origin: "tech-lead dispatch 2026-08-16, from the #4508 baseline notes"
loc-budget-allow:
  # +83 lines in the R2 prepared-owner selector, ~60 of them the recorded
  # rationale for a subtle soundness boundary (which fixed-point direction the
  # exemption covers and why the other three must not inherit it). The natural
  # subsystem home for the predicate is src/codegen/ir-legacy-caller-abi.ts,
  # which already owns the same proof shape, but it cannot reach
  # r2SignatureMatchesAllocatedSlot without exporting the selector's Program ABI
  # slot comparison; that move is worth doing on its own, not inside a
  # behavioural change.
  - src/codegen/ir-prepared-free-functions.ts
files:
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/program-abi-provider-planning.ts
  - src/codegen/ir-legacy-caller-abi.ts
  - scripts/ir-only-baseline.json
  - tests/issue-4508.test.ts
  - tests/issue-4514.test.ts
---

# #4514 — restore compile-once for the four units #4508's storage edge dragged out

## Problem (measured, recorded in `scripts/ir-only-baseline.json` standalone notes)

#4508 fed module-binding storage edges into the prepared-owner fixpoint. That
recovered `algorithms.ts::fibMemo` and `::main` as IR-emitted, but as a side
effect `::fibIter`, `::binarySearch`, `::quicksort`, `::joinNums` **lost
compile-once** (they still emit IR bodies, but a legacy body is emitted first):
`main` fails to seal on its own unplanned-abi-binding providers, parity
withdraws it, and the **reverse-callers edge** in
`selectR2PreparedOwnerComponents` (`src/codegen/ir-prepared-free-functions.ts`,
the `[...(callers.get(unitId) ?? [])].some(...)` disjunct in the ownership
fixpoint, ~line 1150) then drags every callee of `main` out of the enlarged
component. `tests/issue-4508.test.ts` pins the four units' compile-twice state
so this refinement flips a test.

The baseline notes explicitly rule out the two cheap outs:

- **Reverting the storage edge is wrong** — it re-loses `fibMemo`/`main`.
- **A forward-only second closure was measured and is UNSOUND** — it leaves a
  direct reader beside a still-prepared component whose late-discovered runtime
  providers break the frozen prepared ABI (`callable provider … discovered
  after prepared provider planning`).

## Implementation plan (tech lead, 2026-08-16)

1. **Instrument first.** Log which disjunct withdraws each unit in the fixpoint
   (caller-edge vs callee-edge vs construction vs storage). Confirm on current
   main that the four units are withdrawn **only** by the reverse-callers edge
   (their callee/storage edges are clean). If any unit has a second blocking
   edge, record it here and descope that unit.
2. **Directional refinement.** A unit admitted to `freeFunctionCandidates`
   already passed `r2StableSignatureType` on every param + return AND
   `r2SignatureMatchesAllocatedSlot` — i.e. its prepared ABI provably equals
   the slot ABI a legacy caller's pre-emitted `call` targets. For such a unit,
   a withdrawn/legacy **caller** is not a signature hazard (this is the same
   proof shape as `hasFullyAnnotatedScalarAbi` in
   `src/codegen/ir-legacy-caller-abi.ts`, already shipped for the select-stage
   closure — see #3518's 2026-08-15 notes). Refine the reverse-callers
   disjunct: withdraw on an outside caller **only when** the unit's ABI
   certification does not hold (e.g. reference-shaped contracts where the
   prepared component could re-plan the carrier). Keep the callee direction,
   the construction direction (#4494), and the storage direction (#4508)
   untouched — each is load-bearing for lowerability/sealing, not just
   signature safety.
3. **If step 2's blanket exemption is too coarse** (sealing still fails or the
   unsound-variant error reappears), fall back to **component splitting**:
   after the fixpoint converges, re-admit any maximal subset of withdrawn
   units that is internally closed (all callees + construction targets inside
   the subset or baseline, all storage terminals prepared) — callers outside
   the subset are permitted for ABI-certified members only.
4. **Prove soundness by the recorded failure mode**: compile the standalone
   playground corpus and assert the `callable provider … discovered after
   prepared provider planning` invariant does not fire; the shipped shape must
   not be the measured-unsound forward-only variant.

## Acceptance criteria

- [ ] `tests/issue-4508.test.ts`'s compile-twice pins for the four units flip
      to compile-once assertions (edit the test in the same PR).
- [ ] Standalone lane: `legacyBodyEmittedCeiling` ratchets 26 → ≤ 22;
      `irBodyEmittedFloor` stays ≥ 22; 0 invariants; ratchet the baseline via
      supported regeneration, not hand-editing.
- [ ] Single-host lane unchanged: 37/37 IR, READY (the caller-direction
      refinement must be structurally unreachable or provably inert there).
- [ ] `pnpm run check:ir-fallbacks` — no unintended/post-claim growth.
- [ ] Equivalence gate + standalone runtime probe (`algorithms.ts` `main()`
      runs, values unchanged vs main) green.

## Outcome (2026-08-16, ttraenkler/opus-ir-2)

**Standalone lane `legacyBodyEmittedCeiling` 26 → 18** (target was ≤ 22);
`emitted` / `irBodyEmitted` unchanged at 22, `unsupported` unchanged at 15,
invariants 0, verdict READY. Single-host lane unchanged (37/37 IR, 0 legacy,
READY). Re-measured after merging `upstream/main` (which by then carried #4615
and #4616).

### Step 1 — instrumented, and it confirmed the plan's premise

A temporary trace of each withdrawal disjunct in
`selectR2PreparedOwnerComponents` (standalone, `algorithms.ts`) gave the exact
chain — one edge per unit, no unit with a second blocking edge:

| unit | withdrawn by |
| --- | --- |
| `fibMemo` | storage edge (#4508) — the module-init is not a prepared storage terminal on this lane |
| `main` | callee edge into `fibMemo` |
| `fibIter`, `binarySearch`, `quicksort`, `joinNums` | **reverse-callers edge into `main`, and nothing else** |

So the four units were descoped by nothing but a withdrawn caller, exactly as
the baseline notes predicted. Their `callers` sets contain only `main` (plus, for
`quicksort`, itself).

### Step 2 — directional refinement (shipped)

`r2CertifiedAgainstOutsideCallers` in `src/codegen/ir-prepared-free-functions.ts`.
A free-function owner keeps its component membership despite an outside caller
when **both** hold:

1. every parameter and the return carrier is fixed by the declaration
   (`r2CarrierFixedByDeclaration`: `void`, `f64`/`i32`, `string`, vector of
   those) — deliberately narrower than R2 admission, which also accepts
   `callable`, `extern` and the generator-only opaque externref; and
2. `r2SignatureMatchesAllocatedSlot` still holds, i.e. the prepared projection
   equals the Program ABI slot an outside caller's pre-emitted `call` targets.

The callee, construction (#4494) and storage (#4508) directions are untouched —
those are lowerability/sealing constraints, not signature ones. Class members
are excluded by construction (their admission never ran the R2 signature
proofs).

### Step 3 was not needed — but step 2 alone was fatal, for a different reason
### than the issue predicted

The naive refinement reproduced the recorded unsound symptom exactly —
`callable provider runtime|21:__extern_is_undefined was discovered after
prepared provider planning`, `success: false`, 3 invariants on `fibMemo`,
`main` and the module-init. **The mechanism is provider planning, not call
closure.** `ProgramAbiCallableProviderRegistry.planPrepared` seals the provider
key denominator for the WHOLE compilation on its first call, and provider
ordinals are positions in that sorted array. Preparing *any* subset of a source
file therefore froze discovery before the units left on the late route had
lowered — so a runtime helper first observed there was refused. This is why
#4508's whole-file collapse "worked": with nothing prepared, nothing sealed.

Fix (`src/codegen/program-abi-provider-planning.ts`): a key first observed after
sealing is **appended past the sealed prefix** instead of being refused. That
preserves what the seal actually protects — no already-minted ordinal can move,
since every sealed position keeps its index — while letting the prepared and
late routes coexist in one compilation. Diagnostic A/B: with the throw disabled
the refinement already produced 18 legacy bodies and 0 invariants, which
identified the seal as the sole blocker before any redesign.

That second fix is why the win is **−8 rather than the −4** the four named units
predict: partial preparation of a source file no longer forces the rest of that
file onto a worse route.

### Verification

- `pnpm run check:ir-only` — standalone 22 emitted / 22 IR / **18 legacy** / 15
  unsupported / 0 invariants; single-host 37/37/0/0/0; verdict READY.
- Per-unit `algorithms.ts` standalone: `fibIter`, `binarySearch`, `quicksort`,
  `joinNums` all `emitted, ir=true, legacy=false` (compile-once restored);
  `fibMemo`, `main`, `<module-init>` still `emitted, ir=true, legacy=true`
  (unchanged, still on the late route).
- Runtime A/B, base vs branch, `algorithms.ts` both lanes: **byte-identical
  program output** (host lane prints the full Fibonacci / binary-search /
  quicksort transcript; standalone instantiates and runs without trapping).
- `tests/issue-4508.test.ts` — the compile-twice tripwire for the four units is
  inverted to compile-once, as that test's own comment instructed.
- `tests/issue-4514.test.ts` — new: certified callee survives a withdrawn
  caller; the exemption does not leak to the caller itself; the storage
  direction still withdraws a certified signature; an object-carrier callee is
  NOT exempted while a `number[]` one is; host lane inert; and the
  provider-discovery regression pin on the real corpus entry.

### The exemption needed one more guard, found only in the merge queue

PR #4627's first merge_group re-validation failed `check for test262
regressions`: 8 files, one family, all `pass → compile_error` with changed wasm
hashes — `annexB/language/global-code/*-global-existing-fn-no-init.js`, erroring
`ABI draft … :function-value-trampoline:… would mutate sealed prepared scope`.
This is the class of failure PR-level checks cannot see: the heavy shards are
merge_group-only.

Root cause: the signature proof covers the CALL ABI and says nothing about
**support bindings drafted for an owner after its component seals**. annexB
web-compat function hoisting (B.3.3.2 `CanDeclareGlobalFunction`) is exactly
that shape — a block-scoped `function f` beside a top-level `function f` drafts
a `function-value-trampoline` on the top-level unit at hoist time.

Isolated by A/B before fixing (the selector change, not the provider change, was
responsible) and then by four minimal shapes: only "block-scoped function
redeclaring a same-named top-level function" fails. An ordinary function-value
reference from a withdrawn caller compiles; a duplicate top-level declaration
compiles; a nested declaration with a unique name compiles.

Guard: a unit whose name is also declared by any non-top-level function
declaration in the file is not exempted. Deliberately over-approximate — it only
ever removes an exemption, so it can cost compile-once on an unusual shape but
can never admit an unsound one. The standalone measurement is unchanged at 18
legacy bodies with the guard in place.

### Note for follow-up

`--update` also wanted to ratchet the **single-host** `legacyBodyEmittedCeiling`
10 → 0 (that lane measures 0 legacy bodies before and after this change). That
tightening is real but unearned by this PR and would fail an unrelated PR that
regresses the lane, so it was left at 10. Someone should land it deliberately.
