# ES5 Prepared census (2026-11-26)

The number the user sees: ES5 test262 on the Prepared whole-program path
(`TEST262_COMPILER_PATH=ir`), standalone, with the real test262 harness.

- **Tree:** main `6694a8b8` (merge of PR #7419, 2026-11-26 05:30 UTC).
- **Population:** the 9,174 ES5 files of the 2026-11-19 census
  (`scripts/ir-census/es5-files.mts`); 457 negative tests skipped, **8,717
  positive files**.
- **Method:** `scripts/ir-census/prepared-census.mts --harness real`: the
  literal runner assembly, compiled through `src/test262/test262-prepared-entry.ts`
  with the CI worker's options; a compiled file is instantiated and its
  `__module_init` run, returning is a pass. The Prepared path stops at its
  first gap, so every wall below is a first-stop count: each file is in one.
- Earlier figures: `plan/log/es5-ir-only-census-2026-11-19.md` (main
  `ee3fcdd610`: 0 pass, every file stopped in the harness prelude).

## Totals

| outcome | files |
|---|---:|
| **pass** | **1,351** (15.5 %) |
| fail (runs, then traps) | 777 |
| compile error (first gap) | 6,587 |
| crash (compile throws) | 2 |
| positive files | 8,717 |

- **The harness prelude now compiles.** On 2026-11-19 no file got past it;
  today 1,351 pass.
- **The 777 failures are all a Wasm `unreachable` trap** at run time, not
  yet sorted: 292 of them use `assert.throws`, 154 call `eval`; by
  directory, `annexB/language` 264, `built-ins/Function` 109,
  `language/statements` 70.

## Top 15 first-stop walls

"Session B" marks the walls in Session B's area: arrays and iteration,
descriptors and integrity, Math, `with`, `arguments`, the global object and
top-level `this`.

| # | wall (first gap) | files | Session B | note |
|---|---|---:|:---:|---|
| 1 | identifier `Array` is not in scope | 930 | yes | 830 are `propertyHelper.js` (`var __isArray = Array.isArray`, line 27) |
| 2 | run-time trap `unreachable` | 777 | no | not yet sorted, see above |
| 3 | module-init contains a nested `var` declaration | 404 | yes | for-in heads (352) and `with` bodies (49) |
| 4 | identifier `Object` is not in scope | 346 | yes | `Object` read as a value (the Object statics live with descriptors and integrity) |
| 5 | RegExp literal has no provider | 346 | no | #7369 |
| 6 | identifier `globalThis` is not in scope | 309 | yes | the runtime shim's `global: globalThis` |
| 7 | unknown class `String` (`new String`) | 281 | no | primitive wrappers |
| 8 | `eval` statement has no eval provider | 225 | no | #7363 |
| 9 | identifier `Number` is not in scope | 221 | no | |
| 10 | identifier `String` is not in scope | 206 | no | |
| 11 | `this` reference outside an instance method body | 196 | yes | top-level and function `this` |
| 12 | unknown class `Number` (`new Number`) | 174 | no | primitive wrappers |
| 13 | unknown class `Boolean` (`new Boolean`) | 172 | no | primitive wrappers |
| 14 | direct call to `Function` has no exact AST-site plan | 154 | no | `Function(…)` / `new Function` |
| 15 | empty array escapes before its element type is closed | 128 | yes | array literals |

Session B's walls hold 2,313 of the 6,589 first stops (rows 1, 3, 4, 6, 11
and 15). Next in line: `delete` 111, an array literal the resolver cannot
register 111, string arrays 112, dynamic `+` on a string 109, `Object` as a
class 91, `eval(…)` as a direct call 84, `Function` 79, `RegExp` as a
class 74, `Math` 66, `Date` 63.

## Reproduce

```bash
npx tsx scripts/ir-census/es5-files.mts
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/prepared-real.jsonl --harness real
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/ir-census/prepared-real.jsonl
```

About 50 minutes on 4 cores, now that most files compile and run.
