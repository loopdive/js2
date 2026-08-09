---
id: 3553
title: "IR typed-outcome boundary misclassifies the designed extern-arg coercion rejection as an invariant — 80/178 hard CEs in the standalone RegExp guard suite (`arg 0 of new RegExp expects externref but got string`)"
status: done
assignee: ttraenkler/fable-3549
created: 2026-07-23
completed: 2026-07-23
updated: 2026-07-24
priority: high
sprint: 76
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [3519, 3483, 1539, 1169]
files:
  - src/ir/from-ast.ts
loc-budget-allow:
  - src/ir/from-ast.ts
---

# #3553 — designed extern-coercion fallback reclassified as hard invariant by #3519's typed-outcome boundary

## Symptom (reported 2026-07-23 by fable-2860, attributed here by bisect)

`tests/issue-1539-standalone-regex.test.ts` fails **80 of 178** on main with:

```
Codegen error: IR path failed for run: ir/from-ast: arg 0 of new RegExp
expects externref but got string (run) [IR-FALLBACK]
```

(also `arg 0 of RegExp.test`, `RegExp.exec`, etc. — every standalone shape
where a native-strings `string` value meets an extern-class host-arg
position). Minimal repro:

```ts
export function run(): boolean {
  const re = new RegExp("b");
  return re.test("xxbx"); // hard CE under target: standalone
}
```

## Attribution — measured bisect, NOT today's identity work

Manual first-parent bisect over `origin/main` with the minimal repro
(`.tmp/repro-3553.mts` pattern: compile under `target: "standalone"`,
exit 1 on CE):

| commit             | date        | PR                                    | result  |
| ------------------ | ----------- | ------------------------------------- | ------- |
| `efa0680af90cd3`   | 07-20 23:43 | #3455                                 | PASS    |
| `2b9fa44bda5120`   | 07-21 07:24 | #3473                                 | PASS    |
| `ab0cbdf7666b76`   | 07-21 13:29 | #3480                                 | PASS    |
| `3e53969618a85d`   | 07-21 17:13 | #3482                                 | PASS    |
| **`3d7ad776f86418`** | **07-21 17:48** | **#3483 `symphony/3519-ir-outcomes`** | **FAIL** |
| `9e813698d08141`   | 07-21 22:38 | #3490 (identity-ABI)                  | FAIL    |
| `08615d58bb655e`   | 07-23 14:50 | #3512 (HEAD at attribution time)      | FAIL    |

So the culprit is **PR #3483 ("feat(ir): complete the typed R0 migration
boundary", #3519)**, merged 2026-07-21 17:48 — NOT the #3520 identity work
(#3490 merged 5h later, already red before it) and NOT anything from
2026-07-23. The regression sat on main for ~2 days because no required
PR-level check runs this suite (#3552 closes that gap).

Control (measured by fable-regfix): main + the #3551 cascade fix reproduces
the identical 80/178 — #3513/#3514 are excluded as factors.

## Root cause — a missed migration site, not a wrong design

#3483 introduced the typed outcome boundary (`src/ir/outcomes.ts`):
`classifyIrFailure` treats any **plain `Error`** escaping build/lower as
`kind: "invariant", code: "unexpected-internal-throw"`, and
`formatIrPathFallbackDiagnostic` (`src/codegen/index.ts`) surfaces invariant
outcomes as **hard compile errors** instead of the legacy-fallback warning.
That is the honest-gate design working as intended — unknown throws SHOULD
be loud.

But `coerceToExpectedExtern` in `src/ir/from-ast.ts` still ended in a plain
`throw new Error(...)` for its leftover-mismatch case, and that throw is
**designed non-claimability**, documented in its own doc block since slice 10
(#1169i): a native-strings `(ref $AnyString)` value can never satisfy an
externref host-arg position, so the function is supposed to *reject and fall
back to legacy* — which owns the native lowering (for `new RegExp` /
`RegExp.test` under `target: standalone`, the native regex engine of #682).
#3483 migrated the sibling coercion sites to
`IrUnsupportedError("operand-coercion-unsupported", "build", …)` (six sites
in from-ast) but missed this one, so the designed fallback became a CE for
every claimed function containing a standalone extern-class RegExp use.

## Fix

Throw the typed error at that site, exactly like the sibling sites #3483
itself migrated:

```ts
throw new IrUnsupportedError(
  "operand-coercion-unsupported",
  "build",
  `ir/from-ast: ${where} expects ${expected.kind} but got ${describeIrType(t)} (${cx.funcName})`,
);
```

Under the hybrid policy an `unsupported` outcome with a legacy body emitted
is NOT a blocker (`evaluateIrOutcomePolicy`), so the pre-#3483 behavior is
restored *within* the typed-outcome design — no gate weakened: a genuinely
unknown throw still classifies as an invariant, and `ir-only` policy still
counts this unit as a blocker (honest gate preserved).

Why not "teach the IR to lower standalone RegExp natively" instead: that is
real feature work (IR-native regex lowering), orthogonal to this regression;
the correct classification of this rejection is `unsupported` either way.

## Measured results

- Minimal repro: CE → compiles + runs correctly.
- `tests/issue-1539-standalone-regex.test.ts`: **80 failed / 98 passed →
  178/178 passed** (denominator 178).
- `pnpm run check:ir-fallbacks`: OK — no unintended/post-claim/module-level
  bucket growth (host-mode corpus never reaches the demote-throw, since
  `stringIsExternref() !== false` passes strings through).
- `npx tsc --noEmit`: clean. Prettier: clean.
- Outcome suites green: issue-3519-ir-outcomes, issue-3529-selector-preclaim,
  issue-3529-dataflow-outcomes, issue-3529-ir-producer-parity (124/125 across
  the 5 files; the 1 failure is `issue-1923.test.ts` "ratchet gate PASSES on
  clean corpus" **35s subprocess timeout — fails identically on plain
  `origin/main`**, pre-existing and unrelated; it needs a longer testTimeout
  on loaded boxes).

## Notes for reviewers

- One-site change; the shared helper serves 6 call sites (extern-class ctor
  args, extern method args, element stores, `.push`, console args, property
  writes) — for all of them the pre-#3483 contract was "mismatch ⇒ legacy
  fallback", so this restores, not invents, behavior.
- The broader question "should from-ast's remaining ~hundreds of plain
  `Error` throws be audited for other designed-rejection sites?" belongs to
  #3519's follow-up program, not this regression fix. This site is the one a
  measured 80-test regression proves reachable.
