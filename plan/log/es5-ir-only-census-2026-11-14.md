# ES5 IR-only census (2026-11-14)

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only"). This census re-measures where that stands on
current main. The previous full census is from 2026-11-11 (main
`7ce9bc8fbf`).

## Method

- **Tree:** a clean `git archive` export of main `8e2a65b374` (`src`,
  `tests`, `scripts`), with the shared `node_modules` and `test262`
  checkout linked in. Main has since gained PR #7214 (#7341 S1, merge
  `963333e3d0`). It is not in these numbers; see the headline.
- **File list:** the same 9,174 files as on 11-11, reused exactly. That is
  `scratchpad/es5-map/es5-shuffled.txt`: the ES5 files by the edition
  ratchet's classifier (`classifyEdition(...) === 5`, `_FIXTURE` excluded),
  in a seeded shuffle (seed 7106). The 11-11 `per-file.jsonl` has the same
  files in the same order.
- **Compile:**
  - target standalone, with the original harness
    (`assembleOriginalHarness`);
  - `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`;
  - script `scratchpad/os7338/census.mts`. It is resumable, run in
    foreground chunks of 9.5 minutes appending to one output file.
- **One change to the script:** two things `es5-map/census.mts` had and
  `os7338/census.mts` lacked are restored.
  - The `kind` field: the analysis uses it to attribute a function unit to
    its harness file.
  - The 6,000-character detail cap (it was 400): with
    `MODULE_INIT_ALL_REJECTS` a module-init detail lists every refused
    statement, and 400 characters cut the list.
- **Analysis:** `es5-map/analyze.py`, unchanged except for its paths. This
  is the same reason normalisation as the 11-11 map, so reason names compare
  between the two.
- **Definitions:**
  - "sole blocker" = the only reason left in a blocked file;
  - "files carrying" = blocked files where the reason appears.

## 1. Headline

| | 2026-11-11 (`7ce9bc8fbf`) | 2026-11-14 (`8e2a65b374`) | change |
|---|---|---|---|
| ES5 files | 9,174 | 9,174 | |
| skipped (negative, raw, module) | 457 | 457 | |
| compile errors | 126 | 126 | 0 (the same files) |
| compiled | 8,591 | 8,591 | |
| **IR-only** | **1,505 (17.5 %)** | **1,601 (18.6 %)** | **+96** (104 gained, 8 lost) |
| blocked | 7,086 | 6,990 | −96 |
| files with post-claim errors | 32 | 33 | +1 |
| distinct refusal reasons | 576 | 578 | |

Blocked files by how many reasons they carry: one 1,653 · two 2,420 ·
three 1,274 · four 823 · five or more 820.

**Per-PR attribution, measured here.** I exported each merge on main's
first-parent line and compiled the 104 gained and 8 lost files there. Every
change is pinned to one PR:

| PR | issue | IR-only change | files |
|---|---|---|---|
| #7210 | #7130 (ES5 compound assignments) | +55 | 44 in `expressions/compound-assignment`, 10 in `statements/for` (`S12.6.3_A10`–`A12`), `types/reference/S8.7_A6.js` |
| #7212 | #7338 S1 + S2 (`Object` statics) | +39 | exactly the 39 files of its own measurement (quoted: "gained 39") |
| #7221 | #7340 S1 (primitive wrappers) | +10 | `expressions/grouping/S11.1.6_A3_T{1,2}`, 8 × `statements/for/12.6.3_2-3-a-ii-*`. Its own measurement (quoted): 10 on its 873-file population |
| #7209 | #7171 (local write identity) | **−8** | `language/line-terminators/S7.3_A7_T1`–`T8` |

- **The 8 losses are a regression, and nothing flagged it.** These files are
  IR-only after #7207 and #7210 and blocked after #7209.
  - They now carry `external-call(isPrimitive)`, with `assert.js`'s
    `formatIdentityFreeValue` / `formatSimpleValue` refused as
    `external-call`.
  - The same shape explains why `harness:assert.js` grew from 716 to 1,054
    files. Those two units are now refused in 872 files (`external-call`),
    against 515 on 11-11 (`late-preparation-unsupported`).
  - Only the 8 flips are measured per PR. That the reason growth also comes
    from #7209 is an inference from the shared reason.
- **#7214 (#7341 S1) landed after this census.** Its own 1,173-file
  measurement (quoted) is +23 IR-only, 0 lost. Current main is therefore
  expected at about 1,624, not measured here.
- **Renames, not moves:**
  - #7212 replaced `expr-object-define-property-target` (1,612 files on
    11-11) with `expr-object-static-*` (descriptor 1,290, operand 345,
    untrusted 137, proto 35). Most `expr-ident-not-in-scope(Object)` rows
    moved there too: 1,690 → 332.
  - #7221 replaced `expr-new-ctor-unknown(String|Number|Boolean)` with
    `expr-new-wrapper-*`.
  - `external-call(eval)` (78) is gone, and the files now carry other eval
    reasons.

## 2. Top 40 refusal reasons

### By files carrying

| # | reason | files carrying | sole blocker | family |
|---|---|---|---|---|
| 1 | `expr-object-static-descriptor` | 1290 | 70 | Object statics |
| 2 | `vardecl-let-closure` | 1090 | 9 | closures, IIFEs and local calls |
| 3 | `harness:assert.js` | 1054 | 36 | test262 harness (assert.js, sta.js, other helpers) |
| 4 | `expr-ident-not-in-scope(Function)` | 997 | 27 | function values: `Function` as a value |
| 5 | `harness:propertyHelper.js` | 899 | 0 | propertyHelper harness |
| 6 | `expr-module-scalar-method(.hasOwnProperty)` | 669 | 42 | own-property methods |
| 7 | `harness:sta.js` | 554 | 4 | test262 harness (assert.js, sta.js, other helpers) |
| 8 | `objectlit-ordinary-to-primitive-mixed` | 456 | 0 | other |
| 9 | `body-exprstmt-other(expr-call-callee-nonident)[IIFE]` | 403 | 100 | closures, IIFEs and local calls |
| 10 | `vardecl-module-storage-unrepresentable[object-literal]` | 402 | 43 | module-binding storage |
| 11 | `vardecl-module-storage-unrepresentable[empty-array]` | 357 | 8 | module-binding storage |
| 12 | `expr-object-static-operand` | 345 | 1 | Object statics |
| 13 | `expr-new-wrapper-use` | 337 | 21 | primitive wrappers (new String / Number / Boolean) |
| 14 | `expr-ident-not-in-scope(Object)` | 332 | 91 | Object statics |
| 15 | `expr-global-eval-statement` | 307 | 6 | dynamic code (eval, Function, with) |
| 16 | `forin-receiver-not-dynamic-externref` | 306 | 44 | module-binding storage |
| 17 | `expr-new-module-binding-callee` | 271 | 21 | module-binding storage |
| 18 | `expr-local-call-target` | 255 | 8 | closures, IIFEs and local calls |
| 19 | `closure-return-type` | 234 | 38 | closures, IIFEs and local calls |
| 20 | `unattributed-arm` | 231 | 19 | other |
| 21 | `expr-call-callee-nonident[IIFE]` | 226 | 61 | closures, IIFEs and local calls |
| 22 | `vardecl-module-storage-unrepresentable[array-literal]` | 216 | 22 | module-binding storage |
| 23 | `expr-ident-not-in-scope(f)` | 203 | 0 | other |
| 24 | `expr-ident-not-in-scope(String)` | 188 | 38 | ambient globals as values |
| 25 | `body-exprstmt-other(expr-delete-no-ir-lowering)` | 161 | 0 | other |
| 26 | `unattributed-arm:helper-internal {fn}` | 156 | 0 | other |
| 27 | `compound-dynamic-module-operand` | 147 | 1 | module-binding storage |
| 28 | `expr-module-extern-consumer` | 138 | 49 | module-binding storage |
| 29 | `expr-object-static-untrusted` | 137 | 3 | Object statics |
| 30 | `body-unhandled-stmt` | 132 | 26 | other |
| 31 | `expr-new-ctor-unknown(Object)` | 130 | 47 | `new Object()` |
| 32 | `expr-new-wrapper-realm` | 129 | 13 | primitive wrappers (new String / Number / Boolean) |
| 33 | `with-target-not-objectlit` | 126 | 4 | dynamic code (eval, Function, with) |
| 34 | `vardecl-module-storage-unrepresentable[other]` | 125 | 9 | module-binding storage |
| 35 | `expr-ident-not-in-scope(Number)` | 118 | 24 | ambient globals as values |
| 36 | `expr-regexp-literal` | 118 | 17 | other |
| 37 | `expr-new-regexp-target` | 115 | 39 | other |
| 38 | `external-call(isPrimitive)` | 111 | 0 | other |
| 39 | `vardecl-module-storage-unrepresentable[call <local fn>]` | 110 | 4 | module-binding storage |
| 40 | `expr-ident-not-in-scope(p1)` | 108 | 0 | other |

### By sole-blocker count (this ranks work)

| # | reason | files carrying | sole blocker | family |
|---|---|---|---|---|
| 1 | `body-exprstmt-other(expr-call-callee-nonident)[IIFE]` | 403 | 100 | closures, IIFEs and local calls |
| 2 | `expr-ident-not-in-scope(Object)` | 332 | 91 | Object statics |
| 3 | `expr-object-static-descriptor` | 1290 | 70 | Object statics |
| 4 | `expr-call-callee-nonident[IIFE]` | 226 | 61 | closures, IIFEs and local calls |
| 5 | `expr-module-extern-consumer` | 138 | 49 | module-binding storage |
| 6 | `expr-new-ctor-unknown(Object)` | 130 | 47 | `new Object()` |
| 7 | `forin-receiver-not-dynamic-externref` | 306 | 44 | module-binding storage |
| 8 | `vardecl-module-storage-unrepresentable[object-literal]` | 402 | 43 | module-binding storage |
| 9 | `expr-module-scalar-method(.hasOwnProperty)` | 669 | 42 | own-property methods |
| 10 | `expr-new-regexp-target` | 115 | 39 | other |
| 11 | `closure-return-type` | 234 | 38 | closures, IIFEs and local calls |
| 12 | `expr-ident-not-in-scope(String)` | 188 | 38 | ambient globals as values |
| 13 | `harness:assert.js` | 1054 | 36 | test262 harness (assert.js, sta.js, other helpers) |
| 14 | `expr-ident-not-in-scope(Math)` | 72 | 28 | ambient globals as values |
| 15 | `expr-ident-not-in-scope(Function)` | 997 | 27 | function values: `Function` as a value |
| 16 | `body-unhandled-stmt` | 132 | 26 | other |
| 17 | `body-if-cond` | 47 | 25 | other |
| 18 | `expr-ident-not-in-scope(Number)` | 118 | 24 | ambient globals as values |
| 19 | `vardecl-init-expr` | 103 | 24 | other |
| 20 | `vardecl-module-storage-unrepresentable[array-literal]` | 216 | 22 | module-binding storage |
| 21 | `expr-new-wrapper-use` | 337 | 21 | primitive wrappers (new String / Number / Boolean) |
| 22 | `expr-new-module-binding-callee` | 271 | 21 | module-binding storage |
| 23 | `expr-ident-not-in-scope(JSON)` | 54 | 20 | ambient globals as values |
| 24 | `unattributed-arm` | 231 | 19 | other |
| 25 | `expr-module-extern-call-brand` | 54 | 18 | module-binding storage |
| 26 | `external-call(Function)` | 21 | 18 | dynamic code (eval, Function, with) |
| 27 | `expr-regexp-literal` | 118 | 17 | other |
| 28 | `expr-logical-value-family` | 61 | 17 | other |
| 29 | `expr-call-callee-nonident[other]` | 37 | 15 | closures, IIFEs and local calls |
| 30 | `expr-static-predicate-operand` | 31 | 15 | other |
| 31 | `expr-new-wrapper-realm` | 129 | 13 | primitive wrappers (new String / Number / Boolean) |
| 32 | `expr-new-wrapper-argument` | 64 | 13 | primitive wrappers (new String / Number / Boolean) |
| 33 | `expr-binary-op-instanceof[instanceof]` | 69 | 12 | other |
| 34 | `expr-ident-not-in-scope(RegExp)` | 61 | 12 | ambient globals as values |
| 35 | `expr-new-ctor-unknown(Number)` | 77 | 11 | primitive wrappers (new String / Number / Boolean) |
| 36 | `expr-new-ctor-unknown(Function)` | 75 | 10 | dynamic code (eval, Function, with) |
| 37 | `forin-head-module-var` | 60 | 10 | module-binding storage |
| 38 | `expr-ident-not-in-scope(y)` | 15 | 10 | other |
| 39 | `external-call(Object)` | 10 | 10 | Object statics |
| 40 | `vardecl-let-closure` | 1090 | 9 | closures, IIFEs and local calls |

## 3. Greedy set cover

Each step removes one reason entirely: the one that makes the most blocked
files IR-only, given every reason removed so far. When several reasons tie,
or none frees a file, the step takes the reason that leaves the most files
one reason short. Start: 1,601 IR-only.

| step | reason | files unblocked | IR-only after |
|---|---|---|---|
| 1 | `body-exprstmt-other(expr-call-callee-nonident)[IIFE]` | 100 | 1701 |
| 2 | `harness:assert.js` | 102 | 1803 |
| 3 | `expr-global-eval-statement` | 93 | 1896 |
| 4 | `expr-local-call-target` | 104 | 2000 |
| 5 | `expr-ident-not-in-scope(Object)` | 93 | 2093 |
| 6 | `external-call(isPrimitive)` | 84 | 2177 |
| 7 | `expr-object-static-descriptor` | 82 | 2259 |
| 8 | `expr-module-scalar-method(.hasOwnProperty)` | 109 | 2368 |
| 9 | `vardecl-let-closure` | 130 | 2498 |
| 10 | `expr-new-module-binding-callee` | 113 | 2611 |
| 11 | `forin-receiver-not-dynamic-externref` | 116 | 2727 |
| 12 | `closure-return-type` | 93 | 2820 |
| 13 | `vardecl-module-storage-unrepresentable[object-literal]` | 89 | 2909 |
| 14 | `expr-object-static-operand` | 90 | 2999 |
| 15 | `expr-call-callee-nonident[IIFE]` | 88 | 3087 |
| 16 | `expr-ident-not-in-scope(f)` | 83 | 3170 |
| 17 | `body-unhandled-stmt` | 103 | 3273 |
| 18 | `body-exprstmt-other(expr-delete-no-ir-lowering)` | 68 | 3341 |
| 19 | `expr-new-wrapper-use` | 73 | 3414 |
| 20 | `compound-dynamic-module-operand` | 101 | 3515 |
| 21 | `expr-module-extern-consumer` | 67 | 3582 |
| 22 | `expr-new-regexp-target` | 69 | 3651 |
| 23 | `vardecl-module-storage-unrepresentable[empty-array]` | 64 | 3715 |
| 24 | `expr-ident-not-in-scope(String)` | 61 | 3776 |
| 25 | `expr-ident-not-in-scope(Math)` | 59 | 3835 |

After 25 reasons, 3,835 of 8,591 compiled files (44.6 %) would be IR-only.
The curve stays flat (59–130 files per step). No single lever dominates;
the order mixes nearly every family.

Step 6, `external-call(isPrimitive)` (84 files), is the #7209 regression
above. Fixing it is the cheapest step on the list.

## 4. Per test262 directory

Two path levels. For `harness/` and the top-level `intl402/` files, one
level.

| directory | files | compiled | IR-only | blocked |
|---|---|---|---|---|
| `built-ins/Object` | 2831 | 2831 | 281 | 2550 |
| `language/expressions` | 1375 | 1318 | 435 | 883 |
| `annexB/language` | 805 | 791 | 1 | 790 |
| `language/statements` | 732 | 565 | 79 | 486 |
| `built-ins/String` | 728 | 728 | 157 | 571 |
| `built-ins/RegExp` | 500 | 500 | 270 | 230 |
| `built-ins/Function` | 370 | 370 | 1 | 369 |
| `built-ins/Array` | 212 | 212 | 4 | 208 |
| `language/function-code` | 212 | 212 | 1 | 211 |
| `built-ins/Number` | 152 | 152 | 43 | 109 |
| `language/literals` | 145 | 115 | 77 | 38 |
| `language/types` | 105 | 94 | 30 | 64 |
| `language/asi` | 101 | 66 | 46 | 20 |
| `harness` | 98 | 98 | 7 | 91 |
| `built-ins/Math` | 81 | 81 | 67 | 14 |
| `language/directive-prologue` | 62 | 51 | 7 | 44 |
| `language/eval-code` | 58 | 57 | 0 | 57 |
| `language/future-reserved-words` | 55 | 29 | 22 | 7 |
| `language/identifiers` | 49 | 13 | 13 | 0 |
| `built-ins/JSON` | 47 | 47 | 18 | 29 |
| `language/arguments-object` | 44 | 43 | 2 | 41 |
| `language/line-terminators` | 41 | 17 | 5 | 12 |
| `language/white-space` | 40 | 35 | 20 | 15 |
| `annexB/built-ins` | 38 | 38 | 4 | 34 |
| `intl402/NumberFormat` | 34 | 0 | 0 | 0 |
| `intl402/Collator` | 31 | 0 | 0 | 0 |
| `intl402/DateTimeFormat` | 30 | 0 | 0 | 0 |
| `built-ins/global` | 27 | 27 | 0 | 27 |
| `language/keywords` | 25 | 0 | 0 | 0 |
| `intl402` | 22 | 0 | 0 | 0 |
| `language/comments` | 18 | 14 | 10 | 4 |
| `built-ins/Error` | 17 | 17 | 0 | 17 |
| `intl402/String` | 15 | 12 | 0 | 12 |
| `language/reserved-words` | 13 | 13 | 0 | 13 |
| `language/punctuators` | 11 | 1 | 0 | 1 |
| `language/identifier-resolution` | 11 | 11 | 0 | 11 |
| `intl402/Date` | 8 | 5 | 0 | 5 |
| `built-ins/Boolean` | 7 | 7 | 0 | 7 |
| `built-ins/NaN` | 5 | 5 | 1 | 4 |
| `built-ins/Infinity` | 5 | 5 | 0 | 5 |
| `intl402/Number` | 5 | 2 | 0 | 2 |
| `built-ins/Date` | 4 | 4 | 0 | 4 |
| `language/global-code` | 3 | 3 | 0 | 3 |
| `language/source-text` | 1 | 1 | 0 | 1 |
| `built-ins/parseInt` | 1 | 1 | 0 | 1 |

## 5. Families

Every reason is put in one family by its name. The pattern for each family
is in `rep.py` next to the data.

- "Files it alone blocks" = blocked files whose every reason is in the
  family. This is the gain if the family were solved completely.
- "Sum of sole counts" = files where one reason of the family is the only
  blocker.

| family | issue | reasons | files carrying | files it alone blocks | sum of sole counts |
|---|---|---|---|---|---|
| Object statics | #7338 S3–S5 | 12 | 2095 | 218 | 185 |
| own-property methods | #7339 S2 | 2 | 745 | 42 | 42 |
| propertyHelper harness | #7342 | 1 | 899 | 0 | 0 |
| dynamic code (eval, Function, with) | #3630 (eval); Function and with: no issue | 13 | 627 | 40 | 39 |
| function values: `Function` as a value | #7343 | 1 | 997 | 27 | 27 |
| closures, IIFEs and local calls | no issue | 26 | 2180 | 341 | 251 |
| primitive wrappers (new String / Number / Boolean) | #7340 S2/S3 | 8 | 653 | 78 | 74 |
| `new Object()` | #7341 (S1 in the merge queue; S2/S3) | 1 | 130 | 47 | 47 |
| ambient globals as values | no issue | 25 | 638 | 134 | 134 |
| module-binding storage | no issue (the `{}` / literal homes: #7280 / #7335, in progress) | 81 | 2411 | 340 | 272 |
| test262 harness (assert.js, sta.js, other helpers) | #7106 (assert.js + sta.js units) | 15 | 1119 | 42 | 42 |
| other |  | 393 | 3247 | 834 | 540 |

Notes on the issue column:

- **#7339 S2:** the issue file is not on main at `8e2a65b374`. The
  coordinator named it.
- **#7343** covers `Function` *mentioned* as a value, which today forces
  runtime-eval mode (`expr-ident-not-in-scope(Function)`). It does not cover
  closures, IIFEs or local calls. That family (2,180 files, 341 it alone
  blocks) has **no issue**.
- **#3630** is the runtime-eval compiler. `with` and `new Function` /
  `Function(...)` have **no issue**.
- **Ambient globals as values** (`String`, `Number`, `Math`, `JSON`,
  `RegExp`, `Array`, `parseInt`, …) have **no issue**.
- **Module-binding storage** has no issue of its own. Its `{}` and
  object-literal homes are #7280 / #7335 (in progress).
- **`propertyHelper.js` is never a sole blocker** (899 files, 0 sole). #7342
  frees no file on its own; it pays only together with the Object statics
  it travels with.
- **"other"** (393 reasons, 834 files it alone blocks) is led by:
  - `objectlit-ordinary-to-primitive-mixed` (456 files);
  - `unattributed-arm` (231);
  - cascades named after a refused local (`expr-ident-not-in-scope(f)` 203,
    `(p1)` 108);
  - `delete` (161);
  - `body-unhandled-stmt` (132);
  - RegExp literals and construction (118 / 115);
  - `external-call(isPrimitive)` (111).

## 6. What is not measured

- **One refusal per statement.** The selector reports the first refusal
  inside each statement or unit. A statement or function with several
  refusals shows only the first. So a "sole blocker" is an upper bound on
  how close a file is, and the greedy cover's gains are upper bounds too.
- **Behind the first refusal.** A refused `<module-init>` hides whatever its
  callees or later lowering would refuse. With
  `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1` each module-init statement is still
  reported, but only once.
- **Post-claim withdrawals** count as legacy units (33 files). Their reason
  is the from-ast message.
- **Not run:**
  - IR-only means no legacy unit, not a passing test; pass/fail was not
    run;
  - the JavaScript environment, linear, and WASI were not measured;
  - #7214 is not in the tree measured.
- **Per-PR attribution covers only the 112 files whose routing flipped.**
  Reason counts moving between PRs are not attributed, except where stated
  as an inference.
