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
  but 3 stop in the harness prelude. On main the first gap is `typeof` in
  `assert.js` (6,488 files); on `claude/7354-ty` it moves to the `String()`
  call in `assert.js`, on `claude/7354-perf2` to a dynamic member read.
- **Behind the prelude (stand-in harness): 148 pass**, 8,074 stop at a gap,
  495 crash the compiler. The largest first gaps are function values
  (Fa + Fb + C: 2,802 files), built-in globals (B: 2,275), object and array
  literals (O: 1,863).
- **Ordinary pipeline: 1,767 IR-only files (+166 since 2026-11-14, 0 lost)**,
  1,759 of them passing. The re-run of the 2026-11-14 tree reproduces that
  census exactly (1,601 IR-only), so the two are comparable.
- No new issue is filed: every Prepared mechanism with 20 or more files has
  an owner (table in section 1.3).

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
| main `ee3fcdd610` | 8,717 | 0 | `dyn.typeof` has no Prepared intrinsic, `assert.js` line 131/132 (6,488) |
| `claude/7354-perf2` `8acc48e25e` | 8,717 | 0 | `dyn.member_get` has no Prepared intrinsic, `assert.js` line 151/152 (6,472) |
| `claude/7354-ty` `308bf179b7` | 8,717 | 0 | direct call to `String` has no exact AST-site plan, `assert.js` line 135/136 (6,472) |

The other groups are the same on all three trees:

| first gap | files | where it really is |
|---|---:|---|
| script-var binding `not-direct` (`obj` 871, `x` 127, `arrObj` 96, `proto` 92, …) | 1,683 | the test's own `var` (O / H follow-ups, see 1.2) |
| direct call to `String` in `propertyHelper.js` `verifyProperty` (on perf2: `assert` not in scope) | 325 | `propertyHelper.js` (B, #7342) |
| other direct calls, string array literal in `testIntl.js`, unknown class, … | about 230 | includes |
| no body producer for `class-constructor` | 3 | test body |

So the prelude walls after T are `String()` (slice B) and the dynamic member
read (Perf2 / O).

### 1.2 Behind the prelude: first gap by mechanism

8,717 positive files: **148 pass**, 8,074 compile errors, 495 crashes. First
gap location: test body 6,104 · stand-in 942 (873 of them `__assert_throws`
calling its function argument) · `propertyHelper.js` 885 · other includes
140 · crash 495.

| # | mechanism | slice · issue | files | in an include | top names |
|---|---|---|---:|---:|---|
| 1 | script `var` initialised with an object literal has no dynamic home | O · #7352 | 1,383 | 280 | `obj` 227, `o` 29 |
| 2 | call through a value (873 via `assert.throws`) | Fb · #7349 | 1,225 | 17 | |
| 3 | `new` on a plain function, `this`, `instanceof` | C · #7349 | 924 | 21 | `new Test262Error` 606, `this` 264 |
| 4 | built-in global as a value | B · #7350 | 860 | 17 | `Object` 487, `Number` 151, `String` 117, `Function` 37 |
| 5 | built-in call or method | B · #7350 | 763 | 383 | `String()` 442, `isNaN` 70, `Function` 70 |
| 6 | built-in constructor `new X` | B · #7350 | 448 | 0 | `String` 164, `Object` 56, `Number` 52, `Boolean` 49 |
| 7 | function expression or closure as a value | Fa · #7349 | 381 | 3 | |
| 8 | crash: RegExp `.exec` / `.test` / `.source` capability-deferred | #7364 (refusal), #7369 | 259 | 0 | |
| 9 | script `var` initialised with an array literal | O · #7352 | 258 | 172 | |
| 10 | script `var` declared twice (`var x = +0; … var x = -0;`) | S10 script-scope issue, slice 1b (id pending) | 255 | 0 | |
| 11 | "nested var declaration" (196 a top-level `for (var k in …)` head, 63 a `with` body) | S10 script-scope issue (id pending); the for-in heads also need O + a for-in runtime | 245 | 0 | |
| 12 | function declaration read as a value | Fa · #7349 | 226 | 1 | |
| 13 | array literals | O · #7352 | 198 | 59 | |
| 14 | crash: certified global eval lost an owning predicate | #7363 slice 1 (PR #7310) | 196 | 0 | |
| 15 | other (a tail of single-digit labels) | | 167 | 4 | |
| 16 | `eval` | #7363 slices 2+ | 96 | 0 | |
| 17 | RegExp methods | #7369 | 83 | 0 | |
| 18 | native intrinsic provider missing | B · #7350 | 75 | 0 | |
| 19 | function declaration in a block | S10 script-scope issue (id pending) | 69 | 0 | |
| 20 | script `var` initialised with `new X` | C / B | 58 | 13 | |
| 21 | assignment to an undeclared global | S10 script-scope issue (id pending) | 53 | 0 | |
| 22 | dynamic `+`, compare, update (`__ir_dyn_add` 13) | Str2 · #7354 | 53 | 0 | |
| 23 | script `var` initialised with a RegExp literal | B · #7369 | 46 | 0 | |
| 24 | script `var` initialised with an IIFE result | Fb · #7349 | 38 | 25 | |
| 25 | `delete` | S10 script-scope issue (id pending) | 37 | 0 | |
| 26 | crash: `Object.defineProperty` is not an admitted Object static | #7364, #7368 | 26 | 0 | |
| | the rest (no initialiser 23, async test 22, member get/set 22, call result 22, other crashes 14, `with` 13, …) | | 157 | | |

### 1.3 By slice, and who owns it

| slice / issue | files (first gap) | mechanisms |
|---|---:|---|
| B · #7350 (+ #7369 RegExp) | 2,275 | built-in globals, calls, constructors, RegExp methods and literals, native providers |
| O · #7352 | 1,863 | object / array literals in script vars and expressions, member get / set |
| Fb · #7349 | 1,263 | calls through a value, IIFE results |
| C · #7349 | 924 | `new` on a plain function, `this`, `instanceof` |
| Fa · #7349 | 615 | function expressions and declarations as values |
| S10 script-scope issue (id pending) | 659 | repeated `var`, for-in / `with` var heads, block functions, undeclared writes, `delete` |
| compile crashes · #7364, #7363 | 495 | RegExp 259, eval 196, Object statics 26, other 14 |
| `eval` · #7363 | 96 | |
| Str2 · #7354 | 53 | dynamic operators |
| unmapped tail | 167 | |

Function values together (Fa + Fb + C, all #7349) are the largest single
foundation at 2,802 first gaps; built-in globals (B) are next.

**Issues filed: none.** Each mechanism with 20 or more files has an owner,
confirmed with the lane on 2026-11-19: S10 (script scope, one issue with
slices; id not yet assigned), S12 (#7364 crash → refusal, #7368, #7369), S2
(#7363 eval). `with` (13 files) and a missing initialiser (23) are below the
threshold.

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

Pending: the first-parent bisect of the 166 gained files is running; this section is filled in by the next commit of this PR.

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
