---
id: 6503
title: "Registering ANY late import in emitClosureCallExportN silently moves 13 test262 rows — the shift is not fully remapped"
status: ready
sprint: current
created: 2026-09-18
updated: 2026-09-18
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: linked-modules
goal: test262-conformance
related: [6492, 6502, 1984, 1839, 3451]
---

# #6503 — an unused import changes the program

## The measurement

In `emitClosureCallExportN` (`src/codegen/closure-exports.ts`, at the existing
late-import block just before the `__box_number` / `__extern_is_undefined` /
`__unwrap_for_wasm` funcIdx snapshots), register **one import that nothing
reads**:

```ts
ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
flushLateImportShifts(ctx, null);
```

Nothing references the returned index. The emitted program should be
behaviourally identical. It is not — measured on the #6492 138-row linked set
(2026-09-18, `TEST262_ORACLE_MODE=linked`):

**44 → 49 pass: +9, −4.**

| direction | rows |
| --- | --- |
| **+9** | `{RegExp,Map,Array,Set,ArrayBuffer,Promise}/Symbol.species/symbol-species.js`, `TypedArray/prototype/Symbol.toStringTag/{,BigInt/}prop-desc.js`, `Promise/Symbol.species/prop-desc.js` |
| **−4** | `harness/asyncHelpers-asyncTest-{func-throws-sync,rejects-non-callable,return-not-thenable}.js`, `harness/proxytrapshelper-default.js` |

## Why this matters more than the 13 rows

Two unrelated #6502 candidate fixes were measured at exactly this delta —
identical rows, identical error messages — and both were read as evidence about
their own mechanism:

- **#6492 round 11**: make the `__call_fn_N` ladder's miss LOUD (throw instead
  of `ref.null.extern`). It registers `__throw_type_error` here.
- **#6492 round 14**: give a VOID closure the canonical `undefined`
  (`ensureCanonicalUndefinedExtern`). It registers `__get_undefined` here.

Both readings are now withdrawn. The common factor is not what either change
DID; it is that each registered **one late import at this point**. The delta is
the shift.

That also retires #6492's finding 32 ("two independent fixes with an identical
delta share one upstream cause") in its original form. The upstream cause is
real — it is this bug — but it is not the semantic one the finding proposed, and
the finding's method (treat an identical delta as evidence of a shared cause)
pointed at the wrong subject for a full round. The corrected rule is in that
issue.

## What is actually wrong

`flushLateImportShifts(ctx, null)` at this site does not remap every already
emitted call. `emitClosureCallExportN` runs late — after the bulk of function
bodies exist and near the #1984 index-space freeze — so a new import shifts
indices that earlier emitters baked in, and the ones this flush misses become
calls to the wrong function. Nine rows happen to get better and four worse; both
directions are corruption, not behaviour.

Note `ensureCanonicalUndefinedExtern` already guards `ctx.indexSpaceFrozen`, so
this is not the frozen-window case — it is an ordinary registration whose
remapping is incomplete.

## Consequences for anyone working here

- **Any measurement of an `emitClosureCallExportN` change that adds an import is
  measured against a corrupted baseline.** Subtract this delta first, or land
  the shift fix before measuring anything else in this emitter.
- The honest lane is not obviously affected (these are linked-lane rows), but
  the mechanism is lane-independent; an honest-lane A/B of the same probe is
  worth doing.

## Reproduce

Apply the two-line probe above under an env flag, then:

```
bash .tmp/r5/run.sh <tag> linked .tmp/r5/rows138.txt     # 49 with, 44 without
```

## Acceptance criteria

- Registering an unused import at this site leaves all 138 rows unchanged.
- The fix names WHICH already-emitted instructions the current flush misses
  (a targeted test that adds an import late and asserts an earlier body's call
  target is unchanged, rather than only asserting a row count).
- #6502's round 11 and round 14 candidates are then re-measured against the
  repaired baseline, since both of their published deltas are void.
