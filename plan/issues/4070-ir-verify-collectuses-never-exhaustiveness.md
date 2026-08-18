---
id: 4070
title: "Add a `never` exhaustiveness check to `verify.ts` `collectUses` — a new IR kind currently fails at runtime, not compile time"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: n/a
goal: backend-agnostic-ir
# (#3102) An exhaustiveness guard has exactly one legal home: the `default` arm
# of the switch it guards. It cannot be "added to the subsystem module instead"
# the way the gate's advice assumes — moving it anywhere else stops it from
# being an exhaustiveness check at all. Both files are god-files at their
# ceiling; the growth is +28 (lower.ts) and +18 (verify.ts), all of it guard
# arms and the comments explaining why the runtime arm throws.
loc-budget-allow:
  - src/ir/lower.ts
  - src/ir/verify.ts
# (#3400) Same reasoning at function granularity. `emitInstrTree` and
# `renameInstrOperands` ARE the switches being gated, so the guard cannot live
# anywhere else; `lowerIrFunctionBody` grows only because `emitInstrTree` is
# nested inside it. Splitting a 78-arm dispatch switch is a real refactor and
# is out of scope for a guard-only change.
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/passes/inline-small.ts::renameInstrOperands
---
# Add a `never` exhaustiveness check to `verify.ts` `collectUses` — a new IR kind currently fails at runtime, not compile time

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found by the #2952 slice-4 dev (2026-07-25) while adding two new IR instruction kinds. Small, high-leverage type-safety fix.

PROBLEM: the local `collectUses` switch in `src/ir/verify.ts` has NO `never` exhaustiveness default. When a new IR instruction kind is added without a corresponding case, it does not fail to compile — it surfaces as a **runtime TypeError at claim time**. That is the worst failure shape for this codebase: the IR path demotes failures to a severity-`warning` channel, so a claim-time throw can become a silent legacy fallback rather than a loud error.

WHY IT MATTERS NOW: the IR migration's whole remaining programme is "add more IR kinds" (#2952 tail-position switch + string-literal cases, for-in, #3518's R2-R8 spine, #2949 dynamic values). Every one of those is an opportunity to hit this. The cost of the gate is a few lines; the cost of not having it is a silent miscompile discovered later.

PRECEDENT: this pattern is already the established convention elsewhere in the repo — per CLAUDE.md, the emitter's `default` case IS a `never` exhaustiveness check, so "a new union variant without an encoding case is a compile error." `collectUses` simply never got the same treatment. This is bringing one straggler in line with an existing house rule, not inventing a policy.

SCOPE:
1. Add the `never`-typed default to `collectUses` in `src/ir/verify.ts` so a missing case is a compile error.
2. Sweep for sibling switches over the IR instruction union that lack the same guard (verify.ts, lower.ts, passes/, from-ast.ts) and fix them the same way. Do not change behavior — this is purely making an existing hole loud.
3. Confirm `pnpm run typecheck` still passes and that deliberately removing a case now fails to compile (prove the gate actually works; a guard that doesn't fire is worse than none).

ALSO RECORDED (separate, pre-existing, do NOT conflate): `tests/issue-1169n`'s `??` fallback test fails identically on pristine main — a hard `[IR-FALLBACK]` where a demote was expected. Already documented in #2952; not caused by slices 3/4.

## Findings (2026-08-16, implementation)

Measured on `upstream/main` @ `d38224d53`. The survey script used is
`.tmp/survey-switches.mjs` + `.tmp/kinds.mjs` (scratch, not committed): it
brace-matches every `switch (<x>.kind)` under `src/ir/` and compares its
top-level `case` labels against the 78 `kind` literals of the `IrInstr` union.

**67 `*.kind` switches in `src/ir/`; 8 already carried a `never` guard, 26 have
a deliberate `default:`, 33 were bare.** Restricting to switches whose scrutinee
is an `IrInstr`, six were bare — and they are NOT one uniform hole. The split
matters more than the count:

| site | returns | covers | what a NEW kind did before this fix |
| --- | --- | --- | --- |
| `src/ir/lower.ts` `emitInstrTree` | **`void`** | 78/78 | **fell through and emitted NOTHING — silent miscompile** |
| `src/ir/verify.ts` `checkInstr` (type rules) | `void` | **16/78** | deliberately partial — see below |
| `src/ir/verify.ts` `collectUses` | `readonly IrValueId[]` | 78/78 | `tsc` already errored (TS2366) |
| `src/ir/lower.ts` `collectIrUses` | `readonly IrValueId[]` | 78/78 | `tsc` already errored (TS2366) |
| `src/ir/passes/monomorphize.ts` `collectUses` | `readonly IrValueId[]` | 78/78 | `tsc` already errored (TS2366) |
| `src/ir/passes/inline-small.ts` `renameInstrOperands` | `IrInstr` | 78/78 | `tsc` already errored (TS2366) |

**The issue's premise was half right, and the half it missed was the dangerous
one.** For the four VALUE-returning switches — including `collectUses`, the one
this issue is named after — the compiler *already* rejected a missing case:
`strict: true` implies `strictNullChecks`, so a switch that can fall through to
an implicit `undefined` violates the declared return type. The failure was never
purely a runtime one; it was a real compile error whose message
("Function lacks ending return statement") points at the **function signature**
rather than at the switch, which is why it reads as a runtime surprise in
practice. The `never` default moves the diagnostic onto the offending line.

The genuinely unguarded case was **`emitInstrTree` in `src/ir/lower.ts`** — a
`void` switch, so nothing in the type system ever forced it to be total. A new
IR kind without a lowering arm fell straight through, emitted zero
instructions, and produced structurally wrong Wasm (a missing operand on the
stack) with **no error at any stage**. That is the silent-miscompile shape
CLAUDE.md warns about, and it was not named in the original scope.

**Deliberately NOT changed: `checkInstr` (`src/ir/verify.ts`, type rules).** It
covers 16 of 78 kinds by design — it encodes the kinds that HAVE type rules, not
every kind. Forcing a `never` guard there would mean adding 62 empty cases and
would convert an opt-in policy switch into an opt-out one. That is a real design
question (should a new kind be required to declare "no type rules"?), not the
"make an existing hole loud" change this issue scopes, so it is left alone and
recorded here instead.

**Runtime arm — a bare `Error`, deliberately.** Each new `default` throws rather
than returning `[]`/`inst` unchanged. Per #4035/#4502 a bare `Error` from the IR
path classifies as `unexpected-internal-throw`, which #3341/#3519 **hard-error**
— it does not demote to legacy. That is the correct classification here: an
`IrInstr` outside the union is a producer-promise violation, not a capability
gap, so the sites carry the `// invariant (producer-promise):` marker that
convention requires. Returning a benign value would be the unsound direction —
every one of these functions is consulted to decide something (which values are
live, which need a Wasm local, which ids to rewrite), so a silently-empty answer
means "nothing to see" exactly when the analysis cannot see.

## Test Results

**The gate was PROVEN by measurement, not assumed** (the issue's step 3). A
scratch probe member (`IrInstrProbe4070`, `kind: "probe.4070"`) was added to the
`IrInstr` union in `src/ir/nodes.ts` — i.e. exactly the event this gate exists
to catch — and the four guarded files were typechecked against the real union
(TS 5.9.3, `strict: true`, scoped `tsconfig` over the four files + their
transitive imports; 2m50s vs the full-tree run, which did not finish under a
load average of 22 on this box). Both arms of the A/B were run:

**WITH the guards (this PR) — 5 errors, each ON its own guard line:**

```
src/ir/lower.ts(3525,15):                error TS2322: Type 'IrInstrProbe4070' is not assignable to type 'never'.   <- emitInstrTree
src/ir/lower.ts(3886,13):                error TS2322: ... 'never'.   <- collectIrUses
src/ir/passes/inline-small.ts(976,13):   error TS2322: ... 'never'.   <- renameInstrOperands
src/ir/passes/monomorphize.ts(950,13):   error TS2322: ... 'never'.   <- collectUses
src/ir/verify.ts(1225,13):               error TS2322: ... 'never'.   <- collectUses
```

**WITHOUT them (`verify.ts` + `lower.ts` reverted to pre-fix, same probe):**

```
src/ir/lower.ts(3675,41):   error TS2366: Function lacks ending return statement and return type does not include 'undefined'.
src/ir/verify.ts(1027,57):  error TS2366: Function lacks ending return statement and return type does not include 'undefined'.
```

That is the whole finding in two lines of output:

1. The two **value-returning** switches were already caught — but as TS2366 at
   **column 41 / 57 of the function SIGNATURE line**, not at the switch. The
   error says "this function might return undefined", never "you forgot a case".
2. **`emitInstrTree` produced NO diagnostic at all.** It is absent from the
   pre-fix output entirely. The `void` switch was the genuinely silent one, and
   it is the one that emits the Wasm.
3. `checkInstr` produced no diagnostic in either arm, confirming it is
   deliberately partial rather than accidentally unguarded.

Controls: `src/ir/effects.ts(287)` and `src/ir/nodes.ts(3085/3251/3420)` — the
four guards that already existed — errored identically in BOTH arms, so the
probe was live in both and the differences above are attributable to the guards
under test. The probe was reverted; it is not committed.

- Scoped typecheck of the four guarded files on the committed tree — **clean,
  exit 0** (this is the positive control for the A/B above: same config, no
  probe, no errors).
- The full-tree `pnpm run typecheck` did NOT complete locally and is left to
  CI's `quality` lane. Two reasons, neither of them a result: the box was at
  load 22 (two runs were killed at 33 and 52 minutes), and separately
  `pnpm run typecheck` cannot run in a worktree at all today: it invokes
  `node_modules/typescript7/lib/tsc.js` and the `typescript7` alias is not
  installed in this container (nor in `/workspace`), so the script dies with
  `MODULE_NOT_FOUND` before typechecking anything. CI installs it; local runs
  must call the TS5 binary by path.
- `tests/issue-4070.test.ts` — 4/4 pass, including a positive control that a
  KNOWN kind (`binary`) still renames its operands, so the throw assertions are
  not passing vacuously.
- `npx biome lint` + `npx prettier --check` on the four edited files — clean.
- Diff is **purely additive**: 69 insertions, 0 deletions across 4 source files.
  No behavior change on any input the type system permits — the new `default`
  arms are unreachable while the union and the switches agree.
