---
id: 3326
title: "tests/issue-2036.test.ts: 7 'refuses loudly' expectations are stale — #3169 gave these methods a working native path, they now succeed instead of refusing"
status: done
completed: 2026-07-17
assignee: dev-684
sprint: current
created: 2026-07-16
priority: low
feasibility: trivial
task_type: bug
area: codegen
goal: standalone-mode
related: [2036, 3169, 3361]
origin: "found as a side-effect of #3317 (array search-method coercion) validation, 2026-07-16 — pre-existing on main, unrelated to #3317 itself"
---

# #3326 — stale refuse-loudly test expectations after #3169

## Problem

`tests/issue-2036.test.ts` documents that borrowed `Array.prototype`
search/result-building methods over an array-like `$Object` receiver had
**no working native standalone path** and must **refuse loudly** (a clean
compile error) rather than emit invalid Wasm or a silently-wrong value.

7 of its cases now fail on unmodified `origin/main` — confirmed via a clean
worktree, not caused by any in-flight PR. Root cause: #3169 (S3,
carrier-agnostic strict-eq/truthiness/concat for `$AnyValue` union locals)
gave these methods enough of a working native path that they now **succeed**
instead of refusing — a genuine improvement, but it makes the test's "must
refuse loudly" assertions wrong for those 7 cases. Not caught by CI because
this test file isn't in any scoped-suite CI run.

## Task

1. Reproduce: run `tests/issue-2036.test.ts` on current `main`, identify the
   exact 7 failing cases.
2. For each, confirm the method now genuinely produces the CORRECT result
   (not just "doesn't refuse" — verify actual correctness), then update the
   test's expectation from "refuses loudly" to the correct success case.
3. Leave any remaining genuinely-still-unimplemented cases as-is (don't
   force all 45 to pass if some still lack a native path).

## Acceptance criteria

- `tests/issue-2036.test.ts` passes in full, with expectations reflecting
  the current (post-#3169) real behavior — refusals only where a native
  path genuinely still doesn't exist.

## Resolution (2026-07-17, dev-684)

The 6 "refuses loudly" cases (`indexOf`, `lastIndexOf`, `includes`, `map`,
`reduce`, `reduceRight` over an array-like `$Object` receiver in standalone) now
have a working native arm (#3169) and genuinely SUCCEED. Replaced the stale
`expect(r.success).toBe(false)` / `Codegen error:` refusal loop with per-method
**runtime-correctness** `it` blocks, each result verified against native JS
`Array.prototype.<m>.call({0:5,1:7,length:2}, …)`:

- `indexOf(7) === 1`, `indexOf(99) === -1`; `lastIndexOf(5) === 0`
- `includes(7) === true`, `includes(99) === false`
- `map(x=>x*2)` → `[10,14]` (length 2, `r[0]*100+r[1] === 1014`)
- `reduce((a,x)=>a+x,0) === 12`; left-fold order `((0*10+5)*10+7) === 57`
- `reduceRight` sum `=== 12`; right-fold order `((0*10+7)*10+5) === 75`

Removed the now-unused `compileStandalone` helper. The pre-existing
`filter threads thisArg` failure is a DISTINCT bug (filter's native arm drops the
3rd `thisArg` argument), out of this issue's stale-expectation scope — filed as
**#3361** and marked `it.fails` in the test so the suite is green and flips to a
hard failure once #3361 lands. Full file: 28/28 (27 pass + 1 documented
expected-failure).
