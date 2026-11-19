# ES5 IR-only census (2026-11-19)

Program goal: every ES5 test262 file passes on `--target standalone` on the
IR-only path. Since 2026-11-16 that path is the **Prepared whole-program
path** (`TEST262_COMPILER_PATH=ir`, front door
`wholeProgram: { kind: "prepared-program-required", version: 1 }`; CLAUDE.md,
"IR migration: foundations first"). So this census has two parts:

1. **Prepared path** (primary): where every positive ES5 file stops, with the
   real prelude and behind it.
2. **Ordinary pipeline** (secondary): files with zero legacy units, the
   measure of the 2026-11-14 census, as a trend and to catch losses.

Every number here was measured in this session on main `ee3fcdd610`
(2026-11-19 07:39 UTC) unless it names another tree. The scripts are in
`scripts/ir-census/`; each census is one command (see "Reproduce").

## Summary

- **Prepared path, real prelude: 0 of 8,717 positive ES5 files pass.** All
  but 3 are reported in the harness prelude or an include; 1,683 of those are
  the test's own script `var` (1.1). On main the first gap is `typeof` in
  `assert.js` (6,536 files); on `claude/7354-ty` it moves to the `String()`
  call in `assert.js`, on `claude/7354-perf2` to a dynamic member read.
- **Behind the prelude (stand-in harness): 148 pass**, 8,074 stop at a gap,
  495 crash the compiler. The largest first gaps are function values
  (Fa + Fb + C: 2,659 files), built-in globals (B: 2,296), object and array
  literals (O: 1,896).
- **Ordinary pipeline: 1,767 IR-only files (+166 since 2026-11-14, 0 lost)**,
  1,759 of them passing. The re-run of the 2026-11-14 tree reproduces that
  census exactly (1,601 IR-only), so the two are comparable.
- No new issue is filed. Four Prepared mechanisms with 20 or more files have
  no owner yet (1.3): a read of an undeclared name (109), compound assignment
  with a non-numeric right side (30), the `arguments` object (28), a script
  `var` without an initialiser (23). `with` (60) is deferred.

## 1. Prepared path

### Method

- Population: the 9,174 ES5 files of the 2026-11-14 census
  (`scripts/ir-census/es5-files.mts`: `classifyEdition(...) === 5`,
  `_FIXTURE` excluded, mulberry32 shuffle with seed 7106). Negative tests
  are skipped (457): a compile failure is their expected outcome. **8,717
  positive files.**
- Compile: `src/test262/test262-prepared-entry.ts` with the options the CI
  worker passes for an original-harness row (`scripts/test262-worker.mjs`:
  standalone, `allowJs`, `skipSemanticDiagnostics`, `deferTopLevelInit`,
  `hostBridge: "always"`, `scriptGoal`). A compiled file is instantiated and
  its `__module_init` run: returning is a pass. Async tests are compiled, not
  run.
- **Real prelude** (`--harness real`): the literal runner assembly
  (`assembleOriginalHarness(...).primary`), the program CI measures.
- **Stand-in** (`--harness stand-in`, `scripts/ir-census/stand-in-harness.mjs`):
  the runtime shim, `assert.js` and `sta.js` are replaced by plain functions
  with untyped (dynamic) parameters (`__assert`, `__assert_sameValue`,
  `__assert_notSameValue`, `__assert_throws`, `__assert_compareArray`,
  `__error`, `Test262Error`), and the body and metadata includes are
  rewritten `assert.sameValue(` → `__assert_sameValue(` and so on. The
  rewrite keeps every line. Only the stand-ins a file names are emitted, so a
  mechanism a stand-in needs (`__assert_throws` calls its function argument)
  is charged only to the files that use it. 50 files name harness API the
  stand-in does not model; they are counted, not excluded. The #7354
  stand-in of 2026-11-16 is not in the repository; this one is a rebuild, so
  its numbers are not comparable to the 404-row sample in #7354.
- **What it cannot see:** the Prepared path stops at its first gap. Each file
  is charged to exactly one mechanism, and nothing behind that gap is seen.
  There is no sole-blocker or files-carrying count for this path; the numbers
  below are first-gap counts, so the files a mechanism frees are an upper
  bound on what it frees alone.
- **Gap location** is the refusal's line, sorted into a harness file, the
  stand-in or the test body. It is wrong for one class: a module-binding
  refusal (`module binding x has no exact typed storage`) on a test's own
  `var` is reported at the program's first lines, inside the prelude. Those
  rows are counted under their mechanism, not as prelude gaps.

### 1.1 Real prelude: main and the two in-flight branches

| tree | positive | pass | first gap of the largest group (files) |
|---|---:|---:|---|
| main `ee3fcdd610` | 8,717 | 0 | `dyn.typeof` has no Prepared intrinsic, `assert.js` (6,536; 6,488 at line 131/132) |
| `claude/7354-perf2` `8acc48e25e` | 8,717 | 0 | `dyn.member_get` has no Prepared intrinsic, `assert.js` (6,520; 6,472 at line 151/152) |
| `claude/7354-ty` `308bf179b7` | 8,717 | 0 | direct call to `String` has no exact AST-site plan, `assert.js` (6,520; 6,472 at line 135/136) |

The line differs where an include precedes `assert.js`. The other groups are
the same on all three trees, except that 16 files of the main group stop at
`JSON` not in scope in `assert.js` on both branches:

| first gap | files | where it really is |
|---|---:|---|
| script-var binding `not-direct` (`obj` 896, `arrObj` 141, `x` 127, `proto` 109, …) | 1,683 | the test's own `var` (O / H follow-ups, see 1.2) |
| direct call to `String` in `propertyHelper.js` `verifyProperty` (on perf2: `assert` not in scope) | 383 | `propertyHelper.js` (B, #7342) |
| string array literal in `testIntl.js` 58, unknown class 21, direct call to `print` 14, … | 112 | includes |
| no body producer for `class-constructor` | 3 | test body |

So the prelude walls after T are `String()` (slice B) and the dynamic member
read (Perf2 / O).

### 1.2 Behind the prelude: first gap by mechanism

8,717 positive files: **148 pass**, 8,074 compile errors, 495 crashes. First
gap location: test body 6,104 · stand-in 942 (873 of them `__assert_throws`
calling its function argument) · `propertyHelper.js` 885 · other includes
143 · crash 495.

| # | mechanism | slice · issue | files | in an include | top names |
|---|---|---|---:|---:|---|
| 1 | script `var` initialised with an object literal has no dynamic home | O · #7352 | 1,418 | 280 | `obj` 1,065, `proto` 124, `o` 89 |
| 2 | call through a value (873 via `assert.throws`) | Fb · #7349 | 1,225 | 17 | |
| 3 | `new` on a plain function, `this`, `instanceof` | C · #7349 | 923 | 21 | `new Test262Error` 606, `this` 264 |
| 4 | built-in global as a value | B · #7350 | 866 | 17 | `Object` 487, `Number` 151, `String` 117, `Function` 37 |
| 5 | built-in call or method | B · #7350 | 763 | 383 | `String()` 442, `isNaN` 70, `Function` 70 |
| 6 | built-in constructor `new X` | B · #7350 | 449 | 0 | `String` 164, `Object` 56, `Number` 52, `Boolean` 49 |
| 7 | function expression or closure as a value | Fa · #7349 | 381 | 3 | |
| 8 | crash: RegExp `.exec` / `.test` / `.source` capability-deferred | #7364 (refusal), #7369 | 259 | 0 | |
| 9 | script `var` initialised with an array literal | O · #7352 | 258 | 172 | `arrObj` 141, `arr` 81 |
| 10 | array literals | O · #7352 | 198 | 59 | |
| 11 | crash: certified global eval lost an owning predicate | #7363 slice 1 (PR #7310) | 196 | 0 | |
| 12 | `for (var k in …)` head in top-level code (11 of them also have a `var` in a `with` body) | O follow-up: #7352 plus a for-in runtime | 196 | 0 | |
| 13 | script `var` declared twice (`var x = +0; … var x = -0;`) | S10 · #7372 slice 1b | 195 | 0 | `x` 123 |
| 14 | other (largest labels: compound assignment with a non-numeric right side 30, redeclaration 18, empty statement 11) | | 167 | 4 | |
| 15 | read of an undeclared name (98: the read must throw a ReferenceError; 11: a `var` of a nested statement) | no issue yet | 109 | 1 | `x` 51, `y` 35 |
| 16 | `eval` | #7363 slices 2+ | 96 | 0 | |
| 17 | function declaration read as a value | Fa · #7349 | 83 | 0 | |
| 18 | native intrinsic provider missing | B · #7350 | 75 | 0 | |
| 19 | `RegExp` constructor or global (`new RegExp` 53, as a value 16, `RegExp()` 5) | B · #7369 | 75 | 0 | |
| 20 | function declaration in a block | S10 · #7372 slice 2 | 69 | 0 | |
| 21 | script `var` initialised with a RegExp literal | B · #7369 | 68 | 0 | |
| 22 | script `var` initialised with `new X` | C / B | 62 | 13 | |
| 23 | assignment to an undeclared global | S10 · #7372 slice 3 | 53 | 0 | |
| 24 | dynamic `+`, compare, update (`__ir_dyn_add` 13) | Str2 · #7354 | 53 | 0 | |
| 25 | `var` in a `with` body | deferred, no issue | 47 | 0 | |
| 26 | script `var` initialised with an IIFE result | Fb · #7349 | 39 | 25 | |
| 27 | `delete` (first `delete` of the file: `this.x` 15, a member 13, a name 6, `arguments` 2, `this` 1) | by operand: O · #7352 and C / B for the 28 member and `this.x` files, #7372 slices 3/4 for the other 9 | 37 | 0 | |
| 28 | `arguments` object | no issue yet | 28 | 0 | |
| 29 | crash: `Object.defineProperty` is not an admitted Object static | #7364, #7368 | 26 | 0 | |
| | the rest (no initialiser 23, async test 22, member get/set 22, call result 22, primitive literal 16, other crashes 14, `with` 13, …) | | 155 | | |

Corrections of 2026-11-19 (second pass, same rows; the classifier is
`scripts/ir-census/prepared-mechanisms.mjs`):

- **Row 13 was 255 files; 60 of them declare the binding once.** The
  detector read a quoted `var x` in an assertion message or a comment as a
  declaration (40 files) and a comma inside a call's arguments as a list
  separator (20: `var newObj = Object.create({}, props)`). Those 60 are now
  under their initialiser: object literal 35, RegExp literal 14, primitive
  literal 6, `new X` 4, IIFE 1. The S10 lane's count on its branch (not
  re-measured here): with slice 1b, 243 of the 255 get past this gap; of the
  12 that do not, 8 stop at `Object.defineProperty(props, …)` (O) and 4 at
  `this.x = 1` (C). Not seen by the detector: 7 `future-reserved-words` files
  repeat the `var` through a Unicode escape (under primitive literal).
- **Rows 12 and 25 were one row, "nested var declaration" (245).** By the
  compiler's own rule (`isModuleInitVarList`): 185 files have a for-in head
  only, 47 a `var` in a `with` body only, 11 both (in 6 the for-in head is
  inside the `with` body), 1 a for-of head, 1 a `catch` parameter
  redeclared. The S10 lane counts 188 / 47 / 8 / 1 / 1; the difference is the
  3 files whose only unmodelled `var` is a for-in head inside a `with` body.
  A file with a for-in head is listed under row 12.
- **Rows 15, 17 and 28 were one row, "function declaration read as a value"
  (226).** Only 83 name a function. 98 read a name the file never declares
  (`try { x == 1 } catch (e) { e instanceof ReferenceError }`), 11 a `var` of
  a nested statement, 28 `arguments`, 6 `Intl` (now row 4).
- **Row 19 was "RegExp methods" (83).** None is a method gap (those crash,
  row 8); 8 were a script `var` named `regexp…` (now row 21).

### 1.3 By slice, and who owns it

| slice / issue | files (first gap) | mechanisms |
|---|---:|---|
| B · #7350 (+ #7369 RegExp) | 2,296 | built-in globals, calls, constructors, `RegExp` constructor and literals, native providers |
| O · #7352 | 1,896 | object / array literals in script vars and expressions, member get / set |
| Fb · #7349 | 1,264 | calls through a value, IIFE results |
| C · #7349 | 923 | `new` on a plain function, `this`, `instanceof` |
| compile crashes · #7364, #7363 | 495 | RegExp 259, eval 196, Object statics 26, other 14 |
| Fa · #7349 | 472 | function expressions and declarations as values |
| S10 · #7372 | 317 | repeated `var` (slice 1b) 195, block functions (slice 2) 69, undeclared writes (slice 3) 53 |
| O follow-up: #7352 plus a for-in runtime | 196 | for-in `var` heads |
| no owner yet | 137 | read of an undeclared name 109, `arguments` object 28 |
| `eval` · #7363 | 96 | |
| `with`, deferred (no issue) | 60 | `var` in a `with` body 47, `with` statement 13 |
| Str2 · #7354 | 53 | dynamic operators |
| `delete`, by operand | 37 | O / C / B 28, #7372 slices 3/4 9 |
| unmapped tail | 167 | compound assignment with a non-numeric right side 30, redeclaration 18, … |
| not in a row above | 160 | script `var` from `new X` 62 (C / B), without initialiser 23, from a call result 22 (Fb / B), from a primitive literal 16; async test 22; cascade 10; other 5 |

Function values together (Fa + Fb + C, all #7349) are the largest single
foundation at 2,659 first gaps; built-in globals (B) are next.

**Issues filed: none.** Owners, confirmed with the lanes on 2026-11-19: S10
(script scope, #7372, slices 1b to 4), S12 (#7364 crash → refusal, #7368,
#7369), S2 (#7363 eval). Four mechanisms with 20 or more files have no owner
yet: a read of an undeclared name (109), compound assignment with a
non-numeric right side (30, in the unmapped tail), the `arguments` object
(28), a script `var` without an initialiser (23). `with` (60 files) is
deferred.

## 2. Ordinary pipeline (secondary)

### Method

The 2026-11-14 method, rebuilt as committed scripts (the old ones were
session scratch): the same 9,174 files; `--target standalone`, the original
harness, the runner's own compile options, `trackIrOutcomes: true`;
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`; negative,
`raw` and `module` files skipped. New: every IR-only file is run with the
runner's `runTest262File` (strict rerun included).

**Check of the rebuild:** the same scripts on a `git archive` export of
`8e2a65b374` (the 2026-11-14 tree) give 1,601 IR-only, 6,990 blocked, 33
files with post-claim errors, 126 compile errors and 457 skipped, exactly the
2026-11-14 figures. Reason labels are rebuilt too, so reason names can differ
from the 2026-11-14 tables; every comparison below uses the re-run.

### 2.1 Headline

| | 2026-11-14 (`8e2a65b374`, re-run) | today (`ee3fcdd610`) | change |
|---|---:|---:|---:|
| ES5 files | 9,174 | 9,174 | |
| skipped (negative, raw, module) | 457 | 457 | |
| compile errors | 126 | 126 | 0 |
| compiled | 8,591 | 8,591 | |
| **IR-only** | **1,601** | **1,767** | **+166** (166 gained, 0 lost) |
| IR-only AND standalone pass | 1,601 | 1,759 | +158 |
| blocked | 6,990 | 6,824 | −166 |
| files with post-claim errors | 33 | 30 | −3 |

- Blocked files by reasons carried, today: one 1,838 · two 2,167 · three
  1,194 · four 588 · five or more 1,037.
- **The 8 IR-only files that do not pass** are
  `language/line-terminators/S7.3_A7_T1`–`T8`: their run needs the QuickJS
  eval provider, which is not built in this container. They are unmeasured,
  not failing. They are the 8 files #7209 cost on 2026-11-14; they are
  IR-only again.
- **No file was lost.** The 166 gains are pinned to merges in 2.4.

### 2.2 Top reasons by sole-blocker count

| # | reason | files carrying | sole blocker | mechanism · issue |
|---|---|---:|---:|---|
| 1 | `body-exprstmt-other(expr-call-callee-nonident)[IIFE]` | 403 | 124 | function values · #7349 |
| 2 | `expr-ident-not-in-scope(Object)` | 330 | 93 | built-in globals · #7350 |
| 3 | `expr-object-static-descriptor` | 1,230 | 85 | Object statics · #7338 |
| 4 | `expr-call-callee-nonident[IIFE]` | 254 | 74 | function values · #7349 |
| 5 | `closure-return-type` | 226 | 73 | function values · #7349 |
| 6 | `external-call(eval)` | 73 | 71 | eval · #3630 |
| 7 | `body-exprstmt-other(expr-ident-not-in-scope)` | 119 | 68 | unresolvable reference (`x + 1` on an undeclared `x`, names in a `with` body): no issue yet |
| 8 | `forin-receiver-not-dynamic-externref` | 308 | 62 | storage agreement · #7348 (parked) |
| 9 | `vardecl-module-storage-unrepresentable[object-literal]` | 402 | 43 | literals · #7352 |
| 10 | `expr-new-regexp-target` | 115 | 43 | RegExp: no issue yet on this pipeline |
| 11 | `expr-ident-not-in-scope(String)` | 188 | 38 | built-in globals · #7350 |
| 12 | `expr-ident-not-in-scope(Math)` | 72 | 38 | built-in globals · #7350 |
| 13 | `expr-new-wrapper-use` | 405 | 34 | primitive wrappers · #7340 |
| 14 | `expr-global-eval-statement` | 312 | 33 | eval · #3630 |
| 15 | `vardecl-init-expr` | 102 | 29 | no single mechanism |

By files carrying, the largest are `expr-object-static-descriptor` 1,230,
`vardecl-let-closure` 1,069, `expr-ident-not-in-scope(Function)` 1,002 and
`harness:propertyHelper.js` 899 (sole blocker in none).

Row 4 is not all IIFEs: 14 of its files (11 of the 74 sole blockers) carry
the label only for `(0, eval)(…)` or `(new Function(…))(…)`, which is
dynamic code, not a function value (`[IIFE]` is any parenthesised callee,
`scripts/ir-census/reasons.mjs`).

### 2.3 Levers: alone and stacked

"Frees" = blocked files whose every reason belongs to the lever (or to the
levers stacked with it). The levers are ordered by what they free alone.
Mapping: `scripts/ir-census/levers.mjs`.

| lever | issue | files carrying | frees alone | with the two before | all so far |
|---|---|---:|---:|---:|---:|
| function values | #7349 | 2,156 | 483 | 483 | 483 |
| built-in globals | #7350 | 1,881 | 301 | 806 | 806 |
| object / array literals | #7352 | 1,861 | 161 | 1,018 | 1,018 |
| dynamic code (eval, `with`) | #3630; `with`: no issue | 638 | 138 | 659 | 1,214 |
| storage agreement | #7348 (parked) | 754 | 132 | 524 | 1,465 |
| Object statics | #7338 | 1,638 | 114 | 409 | 2,214 |
| primitive wrappers | #7340 | 688 | 89 | 504 | 2,609 |
| RegExp | no issue yet | 261 | 78 | 318 | 2,797 |
| `assert.js` / `sta.js` units | #7106 | 702 | 40 | 211 | 3,171 |
| `delete` | no issue yet | 217 | 32 | 152 | 3,323 |
| post-claim errors | no issue yet | 29 | 25 | 97 | 3,348 |
| parameter carriers | #7353 | 174 | 17 | 74 | 3,425 |
| own-property methods | #7339 | 114 | 2 | 44 | 3,494 |
| `propertyHelper.js` | #7342 | 899 | 0 | 19 | 4,217 |
| call-graph bridge | #7333 | 164 | 0 | 2 | 4,254 |
| other harness files | no issue yet | 124 | 0 | 0 | 4,296 |
| `new Object()` | #7341 | 3 | 0 | 1 | 4,298 |

2,526 blocked files also carry a reason no lever covers. Function values,
built-in globals and literals together free 1,018 files on this pipeline,
the same three foundations that lead the Prepared ranking.

**No ordinary-pipeline issue is filed** (RegExp 78, unresolvable references
68, `delete` 32): since 2026-11-16 the goal is measured on the Prepared path,
and new mechanisms are built there (CLAUDE.md, "foundations first").

### 2.4 Gains pinned to merges

`scripts/ir-census/bisect-flips.mjs --from 8e2a65b374 --to ee3fcdd610` over
the 166 gained files: a binary search per file over the 133 first-parent
commits, each probe a `census.mts` run on a `git archive` export. Every file
is pinned to one merge (`.tmp/ir-census/gained-pinned.tsv`, not committed).

| PR | issue | merge | files | where |
|---|---|---|---:|---|
| #7234 | #7339 own-property rows | `907f7f7838` | 53 | `built-ins/Object`: `defineProperty` 35, `create` 10, `getOwnPropertyDescriptor` 5, `defineProperties` 3 |
| #7246 | #7338 S3 / S4a | `454add8741` | 41 | `built-ins/Object`: `defineProperty` 17, `defineProperties` 13, `create` 11 |
| #7251 | #7346 string module binding | `ba09c845fe` | 30 | `built-ins/String` 12, `language/expressions` 9, `language/types/string` 6, `language/statements` 2, `language/source-text` 1 |
| #7214 | #7341 `new Object` | `963333e3d0` | 23 | `language/expressions` 22 (one per operator directory), `language/types/reference` 1 |
| #7231 | #7343 `Function` inert uses | `0d08afaef4` | 9 | `built-ins/Object`: `getOwnPropertyDescriptor` 4, `isFrozen` 2, `isSealed` 2, `isExtensible` 1 |
| #7239 | #7345 eval file call targets | `1e1b26ffba` | 8 | `language/line-terminators/S7.3_A7_T1`–`T8` |
| #7243 | #7340 / #7341 S2 construction args | `4ad0b21bb7` | 2 | `language/expressions/grouping` 1, `language/statements/for` 1 |
| | | | **166** | |

- #7214's 23 is the +23 its own measurement quoted in the 2026-11-14 census.
- #7239's 8 are exactly the files #7209 lost on 2026-11-14: that regression
  is repaired.
- Lost: none, so nothing else to pin.

## Reproduce

```bash
npx tsx scripts/ir-census/es5-files.mts                  # .tmp/ir-census/es5-files.txt, 9,174 files

# Prepared path (about 5 minutes per run on 4 cores)
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/prepared-standin.jsonl --harness stand-in     # or --harness real
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/ir-census/prepared-standin.jsonl
node scripts/ir-census/prepared-lists.mjs --rows .tmp/ir-census/prepared-standin.jsonl \
  --out plan/log/es5-ir-only-census-2026-11-19-lists

# Ordinary pipeline (about 60 minutes on 4 cores with --run ir-only)
JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 \
  npx tsx scripts/ir-census/census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/rows.jsonl --run ir-only
node scripts/ir-census/analyze.mjs --rows .tmp/ir-census/rows.jsonl [--base <older rows>]
node scripts/ir-census/bisect-flips.mjs --from <old> --to <new> --files <flipped list>
```

Both censuses are resumable (a file already in `--out` is skipped) and
`--tree <dir>` measures another checkout: a `git archive` export of `src`,
`tests`, `scripts`, `package.json` and `tsconfig.json` with `node_modules`
and `test262` linked in. The per-file rows are not committed; the
Prepared first-gap file lists are, in `plan/log/es5-ir-only-census-2026-11-19-lists/`.
