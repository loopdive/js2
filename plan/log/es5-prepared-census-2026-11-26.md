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

## The 777 run-time failures, by cause

Every failure is a Wasm `unreachable` trap. The census now records the
innermost Wasm frame of the trap and, when that function got an **abort body**
(#7354 U: a function whose body the Prepared path cannot lower is compiled as
a run-time abort instead of refusing the program), the refusal the abort
stands for (`requiredPreparedAbortBodies`, matched by the frame's function
name). Re-run of the 777 files on the same tree:

- **716 traps are abort bodies**: the program called a function whose body was
  refused; the refusal names the cause.
- **61 traps are the run-time kind abort `__js_value_unsupported`**
  (`js.value.unsupported`, #7354 C2): an operation on a dynamic value whose
  kind turns out at run time to be one the realm cannot answer (42 of them
  in `built-ins/String/prototype`, e.g. `str.trim()`). This abort carries no
  reason on main; see row 5 by reason below.

| # | cause | files | Session B | example (trap frame) |
|---|---|---:|:---:|---|
| 1 | `eval` statement has no eval provider | 154 | no | `annexB/language/eval-code/direct/func-if-decl-else-decl-a-eval-func-skip-early-err-block.js` (`<module-init>__closure_13`) |
| 2 | name not in scope: `f` 83 (Annex B block-level function hoisting), others 12 | 95 | no | `annexB/language/function-code/if-decl-else-decl-b-func-skip-early-err-switch.js` |
| 3 | built-in global as a value: `JSON` 23, `Object` 21, `Function` 15, `Array` 11, `String` 4 | 78 | partly (`Array`, `Object`, `Math`) | `built-ins/Object/prototype/propertyIsEnumerable/S15.2.4.7_A13.js` |
| 4 | member read or write on a function: `caller` 38, `apply` 12, `call` 10, `bind` 10 | 70 | no | `built-ins/Function/15.3.5.4_2-84gs.js` |
| 5 | run-time kind abort `js.value.unsupported`: a member read the realm cannot answer (see below) | 61 | no | `built-ins/String/prototype/trim/15.5.4.20-2-44.js` (`__js_value_unsupported_at`) |
| 6 | `arguments` not in scope | 54 | yes | `language/arguments-object/10.6-13-a-3.js` (`test2`) |
| 7 | nested function without annotations | 39 | no | `language/identifier-resolution/S10.2.2_A1_T8.js` (`f1`) |
| 8 | function declaration in a block | 37 | no | `annexB/language/function-code/switch-case-func-skip-param.js` |
| 9 | statement shape before or at a function tail | 37 | no | `built-ins/Function/15.3.5.4_2-20gs.js` |
| 10 | compound property write on a dynamic value | 22 | no | `language/expressions/compound-assignment/11.13.2-23-s.js` |

The rest (130): assignment to an undeclared identifier 18, a closure
capturing a non-local binding 15, redeclaration 10, an unknown class 9, a
direct call to a built-in 9, `null` in a number context 8, and a tail of
one-to-six-file causes (`arguments.length` 4, `delete` 3, `with` 2, …).
Session B's share: row 6 (54), part of row 3 (`Array` 11, `Object` 21 and
`Math`), `arguments.length` 4, `with` 2.

**Row 5 by reason.** [#7486](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7486-prepared-kind-abort-site-ids)
(PR #7468) gives each kind-abort site an id and records its reason next to
the abort bodies. Re-run of the 61 files: every trap carries its site, with 0
frame contradictions, and all 61 still fail.

| reason | files | keys |
|---|---:|---|
| member read of a string needs String.prototype's properties | 42 | `trim` 11; `replace`, `search`, `lastIndexOf`, `indexOf`, `substring`, `slice` 3 each; `charCodeAt`, `charAt`, `concat` 2 each; 7 others 1 each |
| member read of a function needs Function.prototype's properties | 11 | `bind` 5, `call` 2, `caller` 2, `constructor` 1, `apply` 1 |
| `new` with a `prototype` that is a function, not an ordinary object | 3 | |
| member read `length` of a string needs its own length and index properties | 3 | |
| `Object.defineProperties` of a string needs the String object's own properties | 1 | |
| member read `toString` of an object without it (Object.prototype's own) | 1 | |

So 56 of the 61 come down to one lever: String.prototype and Function.prototype
methods read off a dynamic value. The 11 function-member rows use the same
mechanism as row 4 (70 files).

## Reproduce

```bash
npx tsx scripts/ir-census/es5-files.mts
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/prepared-real.jsonl --harness real
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/ir-census/prepared-real.jsonl
```

About 50 minutes on 4 cores, now that most files compile and run.
