# Prepared path on the integration branch, round by round

Each round of `claude/7354-integration` (lane S8) is re-measured with the
census of `plan/log/es5-ir-only-census-2026-11-19.md`: all 8,717 positive ES5
files through the strict Prepared entry, behind the real prelude and behind
the stand-in harness. The baseline is main `ee3fcdd610` from that census.
First-gap counts only: the Prepared path stops at its first gap.

```bash
# <tree> = git archive export of the round's head (src tests scripts package.json tsconfig.json),
#          with node_modules and test262 linked in
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/integ-<sha>-standin.jsonl --harness stand-in --tree <tree>
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/integ-<sha>-real.jsonl --harness real --tree <tree>
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/ir-census/integ-<sha>-standin.jsonl \
  --base <previous round's stand-in rows>
```

## Rounds

| round | head | real prelude: pass | real prelude: largest first gap (files) | stand-in: pass | stand-in: crash |
|---|---|---:|---|---:|---:|
| main (baseline) | `ee3fcdd610` | 0 | `dyn.typeof` in `assert.js` (6,536) | 148 | 495 |
| 1 | `bc07f68fc0` | 0 | `typeof test for function` in `assert.js` (6,536) | 153 | 16 |
| 3 | `43f5fb1ffd` | 0 | `typeof test for function` in `assert.js` (6,536) | 154 | 15 |

## Round 1: `bc07f68fc0` (2026-11-19)

- **Real prelude:** still 0 pass. The `assert.js` gap moved one step, from
  `dyn.typeof` to `typeof test for function has no Prepared intrinsic` (6,536).
  That refusal is an integration-only alarm S8 added where two lanes meet
  (Fa's `function` carrier kind × Ty's kind-test table), so it is a
  cross-lane gap, not one lane's own refusal. The round merges 9 lanes
  (realm, fa, fb, ty, arrays, prepared-eval, crashes, perf3-readers; not yet
  c/o and perf2).
  Unchanged: the test's own script `var` without a home (1,683) and the
  `String()` call in `propertyHelper.js` (397).
- **Stand-in: 153 pass** (+6, −1 against main):
  - gained: `language/expressions/function/{name,param}-{arguments,eval}-non-strict.js`,
    `language/expressions/function/param-duplicated-non-strict.js`,
    `language/expressions/object/prop-dup-data-data.js`;
  - lost: `language/statements/with/12.10.1-13-s.js`, now a crash
    ("with target did not lower to an object").
- **Crashes 495 → 16.** The RegExp crash is now a refusal
  ("RegExp literal has no provider", 329 files) and the eval crash too
  (eval first gaps 96 → 292).
- **`assert.throws` moved one step:** its 873 files stop at "box of a native
  call result (no carrier kind) has no Prepared intrinsic" in the stand-in,
  not at `__ir_dyn_call_value`: the call through a value works, boxing its
  result into the dynamic value is next (Fb follow-up, #7349).

| # | first gap (stand-in) | slice · issue | files |
|---|---|---|---:|
| 1 | script `var` initialised with an object literal | O · #7352 | 1,530 |
| 2 | `new` on a plain function, `this` (`new Test262Error` 639) | C · #7349 | 960 |
| 3 | built-in global as a value | B · #7350 | 877 |
| 4 | boxing a native call result (`assert.throws`) | Fb follow-up · #7349 | 873 |
| 5 | built-in call or method | B · #7350 | 765 |
| 6 | built-in constructor `new X` | B · #7350 | 466 |
| 7 | RegExp (literal provider, constructor, methods) | B · #7369 | 406 |
| 8 | call through a value | Fb · #7349 | 356 |
| 9 | `eval` | #7363 | 292 |
| 10 | script `var` initialised with an array literal | O · #7352 | 258 |
| 11 | array literals | O · #7352 | 199 |
| 12 | for-in head `var` | O follow-up, for-in runtime | 196 |
| 13 | repeated script `var` (not yet in this tree) | #7372 slice 1b | 195 |
| | everything else | | 1,191 |

Rows were written twice by an accidental double start of the run; they were
deduplicated, and the two copies of every file agreed.

## Round 3: `43f5fb1ffd` (2026-11-19)

Adds slice C (`96c46eb826`, carrying O `4a31677561`), perf2 (`ec0843a754`)
and the reworked Fb (`5770d7dedd`, Fa rework `1474338c53`). Round 2 was not
sent for measurement.

- **Real prelude:** still 0 pass, the same 6,536-file `assert.js` wall (the
  cross-lane `typeof` alarm). New: the `propertyHelper.js` gap moved from the
  `String()` call to `identifier "assert" is not in scope in verifyProperty`
  (383).
- **Stand-in: 154 pass** (+1, −0 against round 1): gained
  `language/function-code/S10.2.1_A5.1_T1.js`. Crashes 16 → 15.
- **The 873 `assert.throws` files got past the stand-in:** "box of a native
  call result" is gone, as S8 expected. They now stop in the test body:
  built-in global as a value (`ReferenceError` 161 is the
  `assert.throws(ReferenceError, …)` argument), a call through a value (114),
  `new` on an unknown class (111), and `var obj = {…}`.
- **`propertyHelper.js` includes:** 383 files now stop at its
  `var failures = []` (array literals in an include, O), instead of at
  `String()`.
- New refusals sorted: `dyn.current_this` (109, slice C) and the integration
  alarm "+ / ToString of a function value" (17, Fa × Str2 / Ty per-kind
  tables).

| # | first gap (stand-in) | slice · issue | files |
|---|---|---|---:|
| 1 | script `var` initialised with an object literal | O · #7352 | 1,587 |
| 2 | built-in global as a value (`Object` 498, `ReferenceError` 161) | B · #7350 | 1,272 |
| 3 | `new` on a plain function, `this` (`new Test262Error` 750) | C · #7349 | 1,036 |
| 4 | array literals (`propertyHelper.js` `failures` 383) | O · #7352 | 647 |
| 5 | built-in constructor `new X` | B · #7350 | 494 |
| 6 | call through a value | Fb · #7349 | 484 |
| 7 | RegExp (literal provider, constructor, methods) | B · #7369 | 411 |
| 8 | built-in call or method | B · #7350 | 318 |
| 9 | `eval` | #7363 | 313 |
| 10 | script `var` initialised with an array literal | O · #7352 | 258 |
| 11 | for-in head `var` | O follow-up, for-in runtime | 206 |
| 12 | repeated script `var` (not yet in this tree) | #7372 slice 1b | 195 |
| | everything else | | 1,342 |
