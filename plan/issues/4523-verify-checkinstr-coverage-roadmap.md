---
id: 4523
title: "checkInstr type rules cover 16/78 IR kinds by construction — decide the opt-in→opt-out question and own the roadmap"
status: done
sprint: current
created: 2026-08-16
completed: 2026-08-21
# The TYPE_RULE_STATUS map (78 classified kinds + reasons) and the default-arm
# backstop live NEXT TO `checkInstr` on purpose — the plan's mechanism is that
# the map and the switch are two halves of one contract, and splitting them
# into a sibling module reintroduces exactly the drift this issue exists to
# prevent. +208 lines, all additive (0 deletions).
loc-budget-allow:
  - src/ir/verify.ts
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [4070, 3518]
origin: "opus-ir-1's #4070 writeup + tech-lead IR review, 2026-08-16"
files:
  - src/ir/verify.ts
  - tests/issue-4523-type-rule-coverage.test.ts
  # NOTE (2026-08-21): `plan/agent-context/opus-ir-1.md` — cited by this issue
  # as the #4070 writeup — does not exist on `main` or on the branch this
  # issue file came from; only `opus-ir-2.md` does. The implementation did not
  # depend on it (the anchors were re-verified against the source directly),
  # but the pointer is dead and the rationale it held may be lost.
---

# #4523 — per-instruction type-rule coverage is an undecided policy, not a hole

## Problem

The #4070 sweep (PR #4623) hardened every IR-union switch that could fail
silently, but deliberately left `checkInstr` in `src/ir/verify.ts` unguarded:
it implements type rules for **16 of 78** IR kinds and is partial BY
CONSTRUCTION — an opt-in policy where a kind without a rule is simply not
type-checked. Adding a `never` guard there would mean 62 empty cases and
would flip the policy to opt-out. That is a design decision, and the #4070
dev correctly wrote it up (`plan/agent-context/opus-ir-1.md`) rather than
deciding it unilaterally. Undecided, it has a real cost: a new IR kind gets
NO type verification and nothing reminds its author that the omission was a
choice. Meanwhile the rest of verify.ts (def-use, dominance, branch arity/
types) IS total, so the partial region is easy to mistake for covered.

## Acceptance criteria

- [x] A decision, recorded in this file: (a) opt-out — every kind needs a
      rule or an explicit `case: skip` with a reason, enforced by the switch;
      or (b) opt-in stays — but a generated coverage table (kinds with/
      without rules) is emitted and ratcheted so coverage can only grow; or
      (c) a hybrid (e.g. new kinds require a rule; the 62 legacy kinds are a
      grandfathered baseline that ratchets down).
      → **(c) hybrid**, per the plan below. Implemented as `TYPE_RULE_STATUS`.
- [x] The chosen mechanism implemented; deliberately removing one existing
      rule must fail loudly (prove the gate fires, per the #4070 method).
      → proven with a counterfactual; see "AC 2 proof" below.
- [x] The 62 uncovered kinds triaged at least into "type rule meaningful" vs
      "nothing to check" (e.g. kinds whose operands are untyped by design),
      so the roadmap has a real denominator.
      → 5 categories, counts below; denominator is **17** `rule-worth-adding`.

## Implementation Plan (Fable, 2026-08-21)

**Decision (recorded per AC 1): option (c) hybrid, implemented so the
classification lives in the type system, not a doc.** Rationale: (a) pure
opt-out — 62 empty cases — is noise that invites copy-paste rules nobody
verified; (b) pure opt-in + external table keeps the policy outside the
compiler where it can drift. The hybrid makes *new kinds* impossible to add
without an explicit decision (compile error), makes *removing a rule* fail
loudly at verify time, and gives the roadmap a in-code denominator.

Verified anchors (2026-08-21, branch of `bc588f2f3`): `checkInstr` is a
closure at `src/ir/verify.ts:1543`, dispatched via `forEachInstrDeep` at
`:1788`; it implements rules for exactly **16 kinds**: `binary`, `intrinsic`,
`slot.read`, `slot.write`, `string.char_at`, `string.char_code_at`,
`string.concat`, `string.const`, `string.eq`, `string.len`, `unary`,
`vec.get`, `vec.len`, `vec.new_fixed`, `vec.set`, `vec.set_length`. The
`IrInstr` union in `src/ir/nodes.ts` has **78 members** (count them exactly —
some interfaces are multi-line; do not trust this plan's regex).

**Mechanism:**

1. In `verify.ts`, add an exported exhaustive map
   `TYPE_RULE_STATUS: Record<IrInstr["kind"], TypeRuleStatus>` where
   `TypeRuleStatus = "checked" | { skip: string }` and every skip string is a
   one-line reason from the triage below. `Record` over the kind union is the
   compile-time gate: a NEW IrInstr kind fails `pnpm run typecheck` (src/ is
   in the CI typecheck project) until its author classifies it. Keep the map
   adjacent to `checkInstr` with a comment binding the two.
2. Restructure `checkInstr`'s dispatch: every existing rule arm ends by
   marking the kind handled (either return-early style or a
   `handled.add(instr.kind)` set); add a `default:` arm that consults
   `TYPE_RULE_STATUS[instr.kind]` — if it says `"checked"` but no case
   handled the instr, push a verifier error
   (`type-rule missing for '<kind>' — TYPE_RULE_STATUS says checked`).
   That makes *deliberately deleting a rule* fail loudly on the first
   verified function using the kind (AC 2's #4070-method proof: delete the
   `vec.len` case in a scratch build, run the IR test suite, observe the
   error; restore).
3. Triage all non-checked kinds into the map with real reasons. Categories to
   use: `structural (operands are instr buffers, def-use already total)` —
   e.g. `if`, `while.loop`, `switch`, `labeled.block`, `try`;
   `resolver-typed (carrier decided at lowering, nothing to check mid-end)`;
   `dynamic-by-design (operates on boxed/dynamic values)` — e.g.
   `dyn.truthy`, `dyn.to_number`; `rule-worth-adding (TODO #4523-roadmap)` —
   kinds where a real i32/f64/ref rule is derivable (candidates: `box`,
   `unbox`, `tag.test`, `select`, `global.get/set`, `const`, `call` arity).
   The `rule-worth-adding` bucket IS the roadmap denominator (AC 3).
4. Ratchet: a unit test (`tests/issue-4523-type-rule-coverage.test.ts`) pins
   (a) checked-count ≥ 16 (must not decrease), (b) map keys == union (already
   compile-time, but the runtime pin survives type-stripping test runners),
   (c) the verifier-error path from step 2 fires on a synthetic
   checked-but-unhandled kind (inject via a test-only map override argument
   or a small seam — do not weaken production wiring for testability).

**Bar:** no behavior change for valid IR (the map only adds errors for
desync/removal); ts7 typecheck; full IR test files green
(`ir-*.test.ts`, `issue-3519-ir-only-gate`); `check:ir-fallbacks` /
`check:ir-only` unchanged. Record the final per-category counts in this file.

## Outcome (2026-08-21)

Implemented as planned. `src/ir/verify.ts` gains `TYPE_RULE_STATUS`
(`Record<IrInstr["kind"], TypeRuleStatus>`, 78 entries), the exported
`typeRuleCoverageProblem` decision function, and a `default:` arm in
`checkInstr` that calls it. **+208 lines, 0 deletions** — no existing rule
was touched, which is why valid IR is bit-identical.

### Final per-category counts (AC 3)

The union is **78** kinds (counted via the TS compiler API, not a regex).

| Category | Count | Meaning |
| --- | ---: | --- |
| `checked` | **16** | a `checkInstr` case implements a real type rule |
| `checked-elsewhere` | **12** | a real rule already runs in `verifyInstrStructure`, not `checkInstr` |
| `resolver-typed` | **23** | carrier chosen at lowering from data not on the instr |
| `rule-worth-adding` | **17** | **the roadmap denominator** — no rule anywhere, one is derivable |
| `dynamic-by-design` | **5** | boxed/host values with no static type constraint |
| `structural` | **5** | no typed value operands at all (labels, buffers, literals) |

**Finding that changed the triage:** the plan's suggested `rule-worth-adding`
candidates `box` / `unbox` / `tag.test` are **already type-checked**, just in
`verifyInstrStructure` (verify.ts:574) rather than `checkInstr` — along with
the five `dyn.*` kinds and the `while.loop` / `for.loop` / `if.stmt` /
`switch` condition rules. Counting those 12 as uncovered would have inflated
the roadmap by 70 %. Hence the fifth category, `checked-elsewhere`: the
denominator is **17**, not 29. "16/78" is a statement about `checkInstr`, not
about type-rule coverage of the IR — **28 of 78 kinds have a real type rule
somewhere in verify.ts**.

The 17 roadmap kinds: `const`, `call`, `global.get`, `global.set`, `select`,
`if`, `object.new`, `closure.new`, `class.new`, `class.super_init`,
`class.instanceof`, `coerce.to_externref`, `iter.done`, `forof.vec`,
`forof.iter`, `forof.string`, `early.return`. Each carries the specific
derivable rule in its skip reason. Two residual gaps are noted in-place but
left out of the denominator (they belong to kinds that already have a rule):
`switch.discSlot` and `try.payloadSlot` bounds.

### AC 2 proof — the #4070 method, with a counterfactual

Deleted the `case "vec.len":` arm and ran `tests/ir-vec-new-fixed.test.ts` +
`tests/ir-vec-two-backend.test.ts` (24 tests) against both builds:

| build | `vec.len` rule | result |
| --- | --- | --- |
| pre-#4523 base (`HEAD:src/ir/verify.ts`) | **deleted** | 24/24 pass, 0 errors — **silent** |
| post-#4523 | **deleted** | 5 failed / 19 passed, **10** desync errors — **loud** |
| post-#4523 | intact | 24/24 pass |

The error text: `IR path failed for emptyLen: type-rule missing for 'vec.len'
— TYPE_RULE_STATUS says checked, but no checkInstr case handled it (#4523)`.
The base run is the load-bearing half: it shows the deletion used to be
*completely* invisible, which is what the issue claimed and what is now fixed.

### Ratchet

`tests/issue-4523-type-rule-coverage.test.ts` (12 tests) pins: checked-count
≥ 16, map keys == the 78-kind union (a runtime pin — the `Record` gate is
type-only and a type-stripping runner would not enforce it), every skip reason
categorised with real prose, the per-category counts above, and the desync
error firing both as a unit and end-to-end through `verifyIrFunction`.

**Ordering note:** an instr with a kind absent from the map never reaches the
`default:` arm — #4070's `collectUses` exhaustiveness guard throws first. So
`typeRuleCoverageProblem`'s `undefined` branch is a defensive backstop, and
the end-to-end test induces the *real* desync (a kind the map calls `checked`
with no case handling it) instead. Both behaviours are pinned by tests.
