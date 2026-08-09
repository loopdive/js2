---
id: 3717
title: "acorn-harness.mjs was the only acorn dogfood script not passing skipSemanticDiagnostics — hard-failed on legitimate strict-mode TS noise, not a compiler bug"
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: testing
language_feature: n/a
goal: core-semantics
origin: "tests/dogfood/acorn-harness.mjs — re-run 2026-07-27 while investigating #3715/#3716"
related: [3715, 1710, 1711, 1725]
---

# #3717 — acorn-harness.mjs missing `skipSemanticDiagnostics` (NOT a checker bug)

## Original (incorrect) claim — retracted

This issue was originally filed as a checker regression: "scalar `var x =
(void 0)` locals stay permanently typed `undefined`, rejecting later
reassignment, unlike real `tsc`." That claim was **wrong** and is retracted
here rather than left to mislead a future reader.

The verification repro was checked against `tsc --noEmit --target es2022
--lib es2022 --skipLibCheck` — **without `--strict`**. js2wasm's checker
(`src/checker/index.ts`) hard-codes `strict: true` unconditionally for
every compile. Re-running the identical repro with `--strict` added:

```ts
function test(): number {
  var elt = (void 0);
  if (Math.random() > 0.5) { elt = null; } else { elt = 5; }
  return elt as any;
}
```

```
$ npx tsc --noEmit --target es2022 --lib es2022 --skipLibCheck --strict repro.ts
error TS2322: Type 'null' is not assignable to type 'undefined'.
error TS2322: Type '5' is not assignable to type 'undefined'.
```

**Real `tsc` under strict mode produces the identical errors js2wasm
does.** There is no missing "evolving type" feature, no checker gap, no
regression — js2wasm's checker matches real strict-mode TypeScript exactly
for this pattern. `var x = (void 0)` genuinely stays typed `undefined`
under `strictNullChecks`; reassigning it to another type is a real TS
error under `--strict`, full stop.

## Actual root cause

Acorn is plain, pre-strict-mode-TS JavaScript. Running it through
TypeScript with `strict: true` surfaces a wall of legitimate-but-irrelevant
strict-mode diagnostics that have nothing to do with whether compiled
acorn actually works correctly — the exact same category of noise as the
pre-existing `ts-property-noise` bucket (`Property 'X' does not exist on
type 'Y'`, #1679/#1690).

The project already has a sanctioned, first-class mechanism for this:
`compile(source, { skipSemanticDiagnostics: true })` (`src/index.ts:451`,
threaded through `src/compiler.ts` and `src/checker/index.ts`), which
still preserves genuine ES-spec early errors
(`ES_EARLY_ERROR_CODES`, `src/checker/index.ts:414`) — it only suppresses
TS semantic/type diagnostics, not real syntax/spec violations.

**`acorn-corpus.mjs`, `acorn-probe.mjs`, and `acorn-test262.mjs` already
pass this flag.** `acorn-harness.mjs` (#1710 — the harness the dogfood
README documents as "the" acorn entry, and the one #3716's marked-parity
comparison was made against) was the sole outlier that never got it, so it
alone sat permanently red on noise the other three scripts had already
solved.

## Fix

One line in `tests/dogfood/acorn-harness.mjs`:

```diff
- result = await compile(acornSource, { fileName: "acorn.mjs" });
+ result = await compile(acornSource, { fileName: "acorn.mjs", skipSemanticDiagnostics: true });
```

## Verification

`npx tsx tests/dogfood/acorn-harness.mjs --json` before → after:

| | before | after |
|---|---|---|
| `compile.success` | `false` | `true` |
| `binaryValidates` | `false` | `true` |
| diagnostics | 491 | 0 |
| fixtures `equal` | 0 (all skipped) | 7 / 7 |

All 7 fixtures (`arith.js`, `class.js`, `control.js`, `fn.js`,
`member-keyword-props.js`, `strings.js`, `vardecl.js`) now run and
structurally diff equal against node-acorn (same pinned tarball, zero
version skew). Oracle self-check still passes.

## Lesson for future dogfood packages

Any new pinned-tarball dogfood harness compiling **plain JS** (not authored
against strict-mode TS) should pass `skipSemanticDiagnostics: true` from
the start, matching `acorn-corpus.mjs`/`acorn-probe.mjs`/
`acorn-test262.mjs`/`marked-harness.mjs`'s own default `compile()` call —
worth checking marked-harness.mjs doesn't hit the same class of noise
separately from the real #3715 (evolving array types) blocker it's
currently red on.

## Acceptance criteria

- [x] Retract the false checker-bug claim with the corrected repro
      (`--strict` matching js2wasm's real compiler options).
- [x] Fix `acorn-harness.mjs` to pass `skipSemanticDiagnostics: true`.
- [x] `pnpm run dogfood:acorn` (`acorn-harness.mjs`) is green:
      `compile.success: true`, binary validates, 7/7 fixtures equal.
- [x] Pin the invariant permanently in
      `tests/issue-3717-dogfood-skip-semantic-diagnostics.test.ts` (#2093):
      every acorn dogfood script that calls `compile()` passes
      `skipSemanticDiagnostics: true`, asserted as a set so a future script
      cannot silently drift out of step the way `acorn-harness.mjs` did.
      `tests/dogfood/acorn.test.ts` drives the harness end-to-end but its
      compile case is opt-in (`DOGFOOD_ACORN=1`) and skipped in the default
      sweep, so it cannot catch this drift on an ordinary PR.
