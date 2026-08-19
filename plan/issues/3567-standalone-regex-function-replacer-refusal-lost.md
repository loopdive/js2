---
id: 3567
title: "standalone: regex function-replacer refusal silently LOST — compiles a broken binary instead of refusing (#1539 guard red)"
status: done
completed: 2026-07-26
sprint: 78
created: 2026-07-24
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: regexp, string-replace, standalone
es_edition: es2015
goal: standalone-gap
related: [1539, 1474, 2868, 3008]
origin: "2026-07-24 bounded standalone-test audit (dev-opus / #3565 lane): tests/issue-1539-standalone-regex-replace.test.ts silently red on main — outside required checks (#3008)."
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
files:
  - src/codegen/regexp-standalone.ts
  - src/codegen/string-ops.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - tests/issue-1539-standalone-regex-replace.test.ts
  - tests/guard-suite.json
---

# #3567 — standalone regex function-replacer refusal silently defeated

## Problem

`tests/issue-1539-standalone-regex-replace.test.ts` is **silently red on current
main** (not PR-touched, not in the required guard suite — #3008 gap). The
subtest "refuses function replacer" asserts that a standalone
`s.replace(/\d/, (m) => ...)` **REFUSES to compile** (clean `#1539`/`#1474`
compile error) because a function replacer is not supported host-free. That
refusal has **silently regressed**: the compile now SUCCEEDS and emits a
**broken binary** instead of refusing.

This is a **lost-refusal regression** in the same family as #3562 (a leaf
exclusion silently defeated) and #3558/#3561 (stale-guard rot): a guard that
protected against silent-wrong-output was defeated, so the compiler now produces
a binary that traps at runtime rather than failing cleanly at compile time.

## Measured evidence (current main, `--target standalone`)

```ts
export function f(s: string): string {
  return s.replace(/\d/, (m: string) => m + m);
}
```

- `compile(...).success` → **true** (the test expects `false` — a `#1539`/`#1474`
  refusal). No refusal error, no warning.
- Instantiate + run `f("a1b")` → **throws `type incompatibility when transforming
from/to JS`** (expected `"a11b"`). So it is NOT "the feature is now supported"
  — the binary is broken; the refusal was the correct behavior and it was lost.

Verified red on clean `origin/main`.

## Root cause (pointer, not yet fixed)

Standalone regex with a **function replacer** is RegExp-carrier substrate
(#2868) — genuinely unsupported host-free. The FIX in scope is to **restore the
`#1539`/`#1474` refusal** (detect a function-argument replacer under
`--target standalone`/`wasi` and emit the clean compile error) so it fails loud
instead of emitting a trapping binary. That refusal path regressed somewhere in
the RegExp-carrier rework; restoring it is more contained than supporting the
feature, but still needs the RegExp-lowering owner. Out of scope for the
guard-audit lane; filed for tracking.

## Guard status

`tests/issue-1539-standalone-regex-replace.test.ts` already detects this
post-merge but is unenforced. Cannot fold into the required suite (#3552) while
red. Fold once the refusal is restored (green).

## Implementation Summary

- **What was done:** restored the narrowed compile-time refusal for RegExp
  function/non-string replacers on the standalone and WASI targets. Both
  `String.prototype.replace`/`replaceAll` and direct
  `RegExp[Symbol.replace]` calls now fail with a source-located `#1539`
  diagnostic instead of emitting a broken fallback binary.
- **Root cause:** `emitStandaloneRegExpReplaceCore` reported the intended
  diagnostic and returned `null`. The `#1919` transactional expression wrapper
  treats `null` as a speculative lowering miss, rolls the transaction back
  (including `ctx.errors`), and substitutes a default value. Returning a typed
  `unreachable` result commits the fatal diagnostic while keeping the dead body
  well typed.
- **Supported behavior:** literal/string-expression RegExp replacements,
  including `$` substitutions, keep their existing standalone lowering. The
  WASI preflight only claims unsupported replacers; supported WASI dispatch is
  unchanged. Default host-mode function replacers continue to compile and run.
- **Guard enforcement:** added
  `tests/issue-1539-standalone-regex-replace.test.ts` to
  `tests/guard-suite.json`, closing the #3008 hole that allowed this guard to
  stay red on main.
- **LOC contract:** the issue explicitly allows the measured 42-line
  standalone lowering and 14-line WASI dispatch growth. Both additions are
  required to preserve the fatal diagnostic across the distinct transaction
  and direct-symbol call paths described above; no project-wide baseline was
  relaxed. The corresponding `compileTailDispatch` function allowance is
  limited to the same 14-line WASI preflight. It must run inside the existing
  tail dispatcher before the unsupported direct-symbol call can enter fallback
  lowering, so extracting it would obscure rather than isolate that ordering
  invariant.
- **What did not work:** committing the diagnostic only inside the shared
  RegExp replacement core did not cover WASI's direct `Symbol.replace` form,
  because that dispatcher did not enter the standalone helper. A narrow WASI
  preflight at the symbol-call dispatch boundary now claims only the unsupported
  replacement shape.
- **Files changed:** `src/codegen/regexp-standalone.ts`,
  `src/codegen/string-ops.ts`,
  `src/codegen/expressions/call-tail-dispatch.ts`,
  `tests/issue-1539-standalone-regex-replace.test.ts`, and
  `tests/guard-suite.json`.

## Test Results

- Reproduction on fetched `origin/main` (`932e042a20d45c`): existing
  `issue-1539` guard was **16 passed / 1 failed**; standalone compilation
  succeeded with no errors and calling the exported function threw
  `type incompatibility when transforming from/to JS`. WASI failed later on
  unrelated host-string imports rather than emitting the RegExp refusal.
- Fixed focused guard:
  `pnpm exec vitest run tests/issue-1539-standalone-regex-replace.test.ts
--reporter=verbose` — **23 passed / 0 failed**.
- Adjacent standalone refusal and host behavior:
  `tests/issue-1474-standalone-regex-refuse.test.ts`,
  `tests/issue-1439.test.ts`, and `tests/issue-1329-b3.test.ts` —
  **27 passed / 0 failed**.
- Required guard suite: `pnpm run test:guard` —
  **182 passed / 4 skipped / 0 failed** across 14 files.
- `pnpm run typecheck` — passed.
- Prettier check for all touched files — passed.
