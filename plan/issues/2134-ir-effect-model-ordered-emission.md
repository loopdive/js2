---
id: 2134
title: "IR effect model: classify instruction kinds, enforce program-order emission for effectful ops"
status: done
sprint: current
created: 2026-06-12
updated: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/dev-2912f
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1924, 1982, 1925, 2135, 2138]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N1)"
---

# #2134 — the IR scheduler has no purity contract; #1982 will recur

## Problem

`emitBlockBody`/`emitValue` (`src/ir/lower.ts:2131-2160`, `:686-710`) defer
single-use defs to their use site and re-emit def trees, treating
`struct.get`/`slot.read` as freely movable pure values. #1982 (lazy emission
reorders memory reads past writes — silent wrong arithmetic, WAT-proofed) is
the symptom; its fix (PR #1405) is point-wise. The IR still has no
`pure / read / write / control` classification on instruction kinds and no
verifier rule that effectful ops keep program order. Every new instruction
kind re-rolls the dice.

## Approach

1. One `effects` table per `IrInstr` kind (share with
   `dead-code.ts isSideEffecting`, which already half-exists).
2. `emitBlockBody` defers only `pure` instructions.
3. Verifier rule (under #1924's table-driven framework): assert the table
   covers every kind (exhaustive switch) and that emitted order preserves
   read/write ordering.

## Acceptance criteria

- #1982 repros A+B pass (regression-guarded).
- A unit test injecting a deferred `class.get` past a `class.set` fails
  verification.
- No byte-diff on the playground corpus for pure-only functions.

## Notes

Fable-routed: the effects-table design review is the hard part. Sequence
with #1924 (the verifier framework it plugs into).

## Reground (2026-07-02, dev-2912f) — what already exists on main

The issue's premise ("no pure/read/write/control classification") is
PARTIALLY STALE. The #1982 fix (PR #1405) matured into a real classification,
private to `lower.ts` (~2443-2646 on `89ab6295`):

- **`SchedFx`** — per-instr effect summary: `readsHeap` / `writesHeap` /
  `allSlots` / `readSlots: Set<number>` / `writeSlots: Set<number>`, with
  buffer recursion (loops/try/if), memoization, and per-slot precision.
- **`schedFxOf`** — an EXHAUSTIVE switch over `IrInstr` kinds with a
  TS-`never` exhaustiveness check AND a runtime full-barrier default, so a
  new kind is (a) a compile error until classified and (b) never silently
  re-orderable. This is the issue's "effects table" in substance.
- **The anchor pass** (`anchorEager`, lower.ts ~545-633) — defers a
  single-use def only when no conflicting effect (`schedFxConflicts`) sits
  between def and use; otherwise anchors at def position via a local.
- `tests/issue-1982-ir-emission-order.test.ts` — repros A+B are ALREADY
  regression-guarded (acceptance criterion 1 satisfied on main).
- #1924 (verifier framework) is DONE — `verifyIrFunction` exists.

**What is genuinely missing:**

1. **Two parallel effect tables with opposite failure polarities.**
   `passes/dead-code.ts isSideEffecting` is a hand-maintained boolean
   blocklist whose default for a NEW kind is "not side-effecting" (DCE may
   silently delete it) — the exact inverse of `schedFxOf`'s safe default.
   One table must be the single source of truth.
2. **No independent verifier of the computed schedule.** The anchor pass is
   the only guardian of ordering; a bug in it ships silently. The issue's
   acceptance criterion 2 (inject a deferred `class.get` past a `class.set`
   → verification fails) needs a checker that re-derives legality from first
   principles, not a re-run of the same loop.

## Design (dev-2912f, 2026-07-02)

**New module `src/ir/effects.ts`** — the effect analogue of `capability.ts`
(#2135's one-source-of-truth pattern; placed as a dependency-free `src/ir/`
leaf so the scheduler (`lower.ts`), DCE (`passes/dead-code.ts`), the verifier
(`verify.ts`), and future consumers (capability table #2135/dev-2138f,
selector arms #2856/dev-2856f) all import ONE classification):

```ts
export interface IrEffects {
  readsHeap: boolean; // mutable heap state (struct fields, globals, vec elems, host)
  writesHeap: boolean; // heap writes / arbitrary effects (calls, iterator advance)
  control: boolean; // throw / await / async.* — cannot be reordered or dropped
  allSlots: boolean; // statically-unknown Wasm-local access (raw.wasm, gen.*)
  readSlots: ReadonlySet<number>;
  writeSlots: ReadonlySet<number>;
}
export function effectsOf(instr: IrInstr, cache?: Map<IrInstr, IrEffects>): IrEffects;
export function effectsArePure(fx: IrEffects): boolean;
export function effectsConflict(a: IrEffects, b: IrEffects): boolean;
// DCE facet — kept as an explicit named export (not loosely derived) so the
// slice-1 refactor is provably behavior-identical; the honest derivation
// (writesHeap || control || allSlots || writeSlots.size > 0, plus the
// documented always-keep quirks like slot.read) is a LATER, equivalence-
// proven slice because today's list has deliberate policy quirks.
export function isSideEffecting(instr: IrInstr): boolean;
```

`control` is carried as its own facet (today folded into
`readsHeap+writesHeap` for throw/await): scheduling treats it as a full
barrier exactly as before (no behavior change), but DCE and future consumers
need "cannot drop" distinct from "touches heap".

**Verifier rule — `verifyEmissionSchedule` (in `effects.ts`, wired from the
scheduler; #1924-style error list):** an INDEPENDENT post-hoc check of the
anchor pass's output, algorithmically different from the pass itself
(pairwise over effectful instrs, not a re-run of the anchor loop):

> For every pair `i < k` in one block where `effectsConflict(fx_i, fx_k)`
> and both are emitted: the execution point of `i` must not be after `k`'s.
> Execution point = `emissionIdx[]` with the same-tree tie-break (equal
> index is legal only when `k`'s lazy tree transitively consumes `i`'s
> result — operands execute before consumers inside one tree).

Wiring: `lower.ts` calls it right after the anchor pass computes
`emissionIdx`/`isLazyAt`. Failure policy follows the existing IR-verifier
convention (#1921/#2137): hard error under `irVerifierHardFailureEnabled`
(CI / test / VITEST), demote-to-legacy warning channel otherwise — an
always-on tripwire that can never miscompile silently in production.
Acceptance criterion 2 is a direct unit test of the exported checker with a
forged schedule (`class.get` deferred past a `class.set`).

**Slices (each byte-neutral, proven):**

1. **Extract + unify (pure move)** — `SchedFx` machinery moves verbatim to
   `effects.ts` (renamed `IrEffects`/`effectsOf`/…); `isSideEffecting` moves
   beside it unchanged; `lower.ts` + `dead-code.ts` import from the new
   module. A drift-tripwire unit test asserts the cross-table consistency
   property (every `isSideEffecting` kind is non-pure per `effectsOf`).
   Proof: byte-identity over the playground corpus (hash compiled binaries
   main vs branch) + full `tests/ir/` + `issue-1982` suite.
2. **`verifyEmissionSchedule` + wiring + unit tests** — verify-only, no
   emission change; byte-identity holds by construction. Adds the
   criterion-2 forged-schedule test and a good-schedule pass test.
3. **(Follow-up issue, NOT this PR)** — derive the DCE facet from the table
   honestly (per-quirk equivalence proofs; e.g. today a dead `object.get`
   whose read could throw IS dropped — a policy decision to revisit), and
   offer effect facets to the #2135 capability table / selector arms.

**Coordination:** `effects.ts` is a new file — no collision with
dev-2138f's `capability.ts` or dev-2856f's selector arms; both consume it
later at their own pace. Interface frozen as above unless they object.
(dev-2138f ACKed: no clash with #2972; its new string-charAt call classifies
under the existing `call` row — conservative, correct. dev-2937f's #1930
TypeOracle seam ACKed both ways: effects keyed on IrInstr kind, oracle on
ts.Node/ts.Type; neither imports the other.)

## Test Results (2026-07-02, dev-2912f — slices 1+2 landed, all acceptance criteria met)

- **Acceptance 1** (#1982 repros A+B regression-guarded): pre-existing
  `tests/issue-1982-ir-emission-order.test.ts` — green before and after.
- **Acceptance 2** (deferred `class.get` past `class.set` fails
  verification): `tests/issue-2134.test.ts` — 11/11 green: forged-schedule
  rejection (def@0/past@1 attributed), anchored-schedule acceptance,
  same-tree consumption tie-break (accept + reject arms), never-emitted
  exemption, pure-commutes, cross-table drift tripwire over 20
  representative kinds, the documented `extern.regex` divergence pinned,
  control-facet assertions, conflict-relation basics, and a wired e2e
  (class read/write interleave computes 79, no verifier demotion under the
  vitest-HARD policy).
- **Acceptance 3** (no byte-diff on the corpus): compiled-binary SHA-256 of
  all 13 playground examples IDENTICAL to the pre-change baseline after
  slice 1 AND after slice 2 (hash probe in the PR).
- `check:ir-fallbacks` gate OK — zero post-claim demotions induced (the
  wired verifier fires nowhere on the corpus).
- `tests/ir/**` 138 green (the 8 failures in `passes.test.ts`/
  `inline-small.test.ts` are the known pre-existing #1167a/b breakage,
  verified identical on pristine main earlier this session);
  `tsc --noEmit` clean.
- Slice 3 (honest DCE-facet derivation + `extern.regex` divergence
  resolution + capability/selector consumption) filed as a follow-up issue.
