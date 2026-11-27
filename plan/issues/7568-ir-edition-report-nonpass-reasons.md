---
id: 7568
title: "The merge-queue ES5 IR report prints the ranked reasons why rows do not pass"
status: done
completed: 2026-11-27
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/ir-nonpass-reasons
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, test262
goal: ci-hardening
sprint: current
horizon: s
es_edition: ES5
related: [7551, 7354]
---

# #7568 — rank why ES5 rows do not pass on the IR path

## Problem

Since #7551 every merge-queue run measures the current edition (ES5) on the IR
(Prepared) path, and `scripts/test262-edition-scope.ts report` prints how many
rows pass and which rows changed. It does not say WHY the ~7,000 non-passing
rows fail, so nobody can rank the work toward "100 % of ES5 on the IR path,
frequent errors first". Agents cannot download artifacts (only job logs are
readable), and compiling the 9,029 tests locally takes hours. The data is
already in `ir-measurement/results.jsonl` when the report runs.

## Implementation Plan

- **Module.** A small sibling module `scripts/lib/test262-nonpass-reasons.ts`
  (the report script is already ~515 lines) exporting one builder and one
  renderer. `cmdReport` in `scripts/test262-edition-scope.ts` calls them, adds
  the section to the markdown summary and stdout, and adds `nonPassReasons` to
  the JSON report. On by default; no workflow change and no new flag.
- **Reuse.** A reason starts from `normalizeErrorSignature`
  (`tests/test262-shared.ts`) — the normaliser that already stamps every row's
  `error_signature` (line/column, offsets, hex, numbers, whitespace). It moves
  to a shared module so the report and the row writer call the same function;
  row output stays byte-identical. The report adds only what that signature
  keeps but the ranking must not: file paths, and quoted literals in
  value-mismatch messages. Quoted names that ARE the cause (`identifier "Array"
  is not in scope`, `direct call to "X"`) stay.
- **Content.** Per non-pass status: top 40 reasons (count, share of all rows,
  rows including `harness/propertyHelper.js`, up to 3 example paths). For
  `compile_error`: missing built-in / identifier → rows. Rows without error
  text group under `(no message)`. Sorted count desc, reason asc; lines
  capped; the whole section ≤ 120 lines.
- **Safety.** Building the section never changes the exit code or verdict: a
  throw prints one line and the report continues without the section.
- **Quality criterion.** One normaliser (no second one beside the writer's),
  one builder + one renderer, no baseline, no pinned numbers.

## Acceptance criteria

- Unit test on a synthetic ~12-row results.jsonl: grouping across paths/lines,
  ordering, propertyHelper count, missing-built-in table, `(no message)`, and a
  malformed row that does not change the exit code.
- Real-data section from a local run on the Prepared path pasted below (or the
  synthetic output, with the reason the real run was not possible).

## Result (2026-11-27)

Real data: 61 ES5 tests (every 150th file of the edition list) run locally on
the Prepared path as the shard job runs them (`TEST262_COMPILER_PATH=ir`,
standalone, QuickJS eval engine, honest oracle), then `report` on that
`results.jsonl`. The section it printed:

````markdown
## Why rows do not pass (#7568)

Of 61 rows. A reason is the first diagnostic of the error, normalised; full lists and 3 examples per reason are in the JSON report (`nonPassReasons`).

### `compile_error`: 45 rows (5 include propertyHelper.js), 25 reasons

| rows | of all | propertyHelper | reason | example |
|---:|---:|---:|---|---|
| 5 | 8.2% | 5 | ir/from-ast: identifier "Array" is not in scope | `test/built-ins/Object/defineProperties/15.2.3.7-6-a-231.js` |
| 5 | 8.2% | 0 | ir/from-ast: identifier "Object" is not in scope | `test/built-ins/Object/create/15.2.3.5-3-1.js` |
| 5 | 8.2% | 0 | ir/from-ast: module-init unit contains a nested var declaration | `test/built-ins/Object/create/15.2.3.5-4-94.js` |
| 3 | 4.9% | 0 | ir/from-ast: eval statement has no eval provider | `test/annexB/language/eval-code/direct/global-if-stmt-else-decl-eval-global-skip-early-err-for.js` |
| 3 | 4.9% | 0 | ir/from-ast: identifier "globalThis" is not in scope | `test/annexB/language/eval-code/direct/func-switch-case-eval-func-existing-block-fn-no-init.js` |
| 2 | 3.3% | 0 | ir/from-ast: 'this' reference outside an instance method body | `test/built-ins/String/S15.5.1.1_A1_T9.js` |
| 2 | 3.3% | 0 | ir/from-ast: RegExp literal has no provider | `test/built-ins/RegExp/S15.10.2.7_A5_T11.js` |
| 2 | 3.3% | 0 | ir/from-ast: empty array '…' escapes before its element type is closed | `test/built-ins/Array/length/15.4.5.1-3.d-3.js` |
| 2 | 3.3% | 0 | ir/from-ast: identifier "Function" is not in scope | `test/built-ins/Function/prototype/bind/15.3.4.5-9-1.js` |
| 1 | 1.6% | 0 | Expression expected. | `test/language/asi/S7.9_A5.1_T1.js` |
| 1 | 1.6% | 0 | a direct call of ReturnThis installs no receiver for its 'this' | `test/language/expressions/this/S11.1.1_A3.1.js` |
| 1 | 1.6% | 0 | dynamic operation String.prototype is not reachable on this path yet (## B3bc) has no Prepared intrinsic | `test/built-ins/String/prototype/trim/15.5.4.20-2-27.js` |
| 1 | 1.6% | 0 | dynamic operation new Boolean (a wrapper object; ## B3bc) has no Prepared intrinsic | `test/language/expressions/conditional/S11.12_A4_T1.js` |
| 1 | 1.6% | 0 | dynamic operation new Number (a wrapper object; ## B3bc) has no Prepared intrinsic | `test/language/statements/for/12.6.3_2-3-a-ii-4.js` |
| 1 | 1.6% | 0 | host provider or async demand is outside this numeric presentation contract | `test/built-ins/Math/abs/S15.8.2.1_A2.js` |
| 1 | 1.6% | 0 | ir/from-ast: '+' operands not provably both-number or string-concatenable (string/unprovable) — the unboxed numeric-add / string-concat fas… | `test/built-ins/RegExp/S15.10.2.15_A1_T19.js` |
| 1 | 1.6% | 0 | ir/from-ast: Phase # requires matching operand types for '&' | `test/language/expressions/bitwise-and/S11.10.1_A3_T1.5.js` |
| 1 | 1.6% | 0 | ir/from-ast: Phase # requires matching operand types for '<=' | `test/language/expressions/less-than-or-equal/S11.8.3_A2.2_T1.js` |
| 1 | 1.6% | 0 | ir/from-ast: delete has no IR lowering | `test/built-ins/Object/defineProperties/15.2.3.7-5-b-96.js` |
| 1 | 1.6% | 0 | ir/from-ast: direct call to "eval" has no exact AST-site plan | `test/language/eval-code/direct/cptn-nrml-empty-for.js` |
| 1 | 1.6% | 0 | ir/from-ast: dynamic compound -= of string has no carrier | `test/language/expressions/compound-assignment/S11.13.2_A4.5_T2.5.js` |
| 1 | 1.6% | 0 | ir/from-ast: method call .indexOf(...) on string not in slice # | `test/built-ins/String/prototype/indexOf/S15.5.4.7_A2_T2.js` |
| 1 | 1.6% | 0 | ir/from-ast: unknown class "Date" | `test/annexB/built-ins/Date/prototype/setYear/date-value-read-before-tonumber-when-date-is-valid.js` |
| 1 | 1.6% | 0 | ir/from-ast: unknown class "Object" | `test/built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T2.js` |
| 1 | 1.6% | 0 | ir/from-ast: unsupported body ExpressionStatement shape | `test/language/expressions/prefix-decrement/target-cover-id.js` |

### `fail`: 4 rows (0 include propertyHelper.js), 4 reasons

| rows | of all | propertyHelper | reason | example |
|---:|---:|---:|---|---|
| 1 | 1.6% | 0 | aborted in unlowerable unit <unit>: ir/from-ast: Math.floor arg must be f64, got dynamic | `test/language/expressions/modulus/S11.5.3_A4_T7.js` |
| 1 | 1.6% | 0 | aborted in unlowerable unit <unit>: ir/from-ast: nested func must have a return type annotation | `test/language/function-code/10.4.3-1-39-s.js` |
| 1 | 1.6% | 0 | aborted in unlowerable unit <unit>: ir/from-ast: redeclaration of '…' | `test/annexB/language/function-code/if-decl-no-else-func-existing-var-no-init.js` |
| 1 | 1.6% | 0 | aborted in unlowerable unit <unit>: ir/from-ast: switch disc must lower to i32/f64 | `test/language/statements/switch/S12.11_A1_T1.js` |

### `compile_error`: missing built-in or identifier (9 names)

| rows | name |
|---:|---|
| 6 | `Object` |
| 5 | `Array` |
| 3 | `globalThis` |
| 2 | `Function` |
| 1 | `Date` |
| 1 | `String.prototype` |
| 1 | `eval` |
| 1 | `new Boolean` |
| 1 | `new Number` |
````
