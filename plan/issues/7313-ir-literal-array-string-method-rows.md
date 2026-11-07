---
id: 7313
title: "IR: array-search and string-method rows for literal receivers / arguments in test module-init"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7108, 7106, 7310]
assignee: "ttraenkler/c-r11"
loc-budget-allow:
  # 2026-11-07 (#7313): +3 in from-ast's lowerStringMethodArgument, the one
  # place a string method's argument is lowered by its role. A search or fill
  # literal now folds to its ToString text, beside the existing ToNumber fold
  # for a position; the (role, literal) dispatch is that function's job.
  - src/ir/from-ast.ts
---

# #7313 — literal array-search and string-method rows

## Problem

The `<module-init>` single-lever census
(`plan/log/ir-module-init-single-lever-census.md`, stub-and-recheck section)
found 5 passing files whose only blocker is a builtin search or string
method on a literal receiver or argument:

| file | call | refusal |
| --- | --- | --- |
| `Array/prototype/indexOf/15.4.4.14-7-4.js` | `[1, 2, 3].indexOf(1, 1)` | `expr-array-search-shape` (no `fromIndex`) |
| `Array/prototype/lastIndexOf/15.4.4.15-8-b-i-2.js` | `[true, true, true].lastIndexOf(true)` | `expr-array-method-not-lowerable` |
| `String/prototype/indexOf/S15.5.4.7_A1_T7.js` | `String("undefined").indexOf(undefined)` | `expr-string-method-argument` |
| `String/prototype/normalize/form-is-not-valid-throws.js` | `'foo'.normalize('bar' / 'NFC1' / null)` | `expr-string-method-surface` |
| `String/prototype/replaceAll/getSubstitution-0x0024.js` | `str.replaceAll('é', '$…')` | `expr-string-method-surface` |

A sixth file, `lastIndexOf/15.4.4.15-5-14.js` (`[0, true].lastIndexOf(true, NaN)`),
also needs a mixed-family array literal. It is recorded here and not chased.

## Implementation (rows in the existing tables, no new arm)

- **Array search** (`src/ir/array-methods/`, #7108's module):
  - `lastIndexOf` joins `IR_VEC_SEARCH_JOIN_METHODS`.
  - `indexOf`, `lastIndexOf` and `includes` take an optional `fromIndex`.
    The selector admits it only as a proven number, so its
    ToIntegerOrInfinity has no side effect.
  - `lowerSearch` is one scan, parameterised by direction. Its start is
    computed in `emitSearchStart`:
    - upward: §23.1.3.17 steps 4–9;
    - downward: §23.1.3.20 steps 4–7;
    - computed in f64, then saturated to i32, so an infinite start never
      enters the loop.
  - `boolean` is an element family, but only for an IR-materialized literal
    vec. This is the rule string vecs already follow, renamed `isLiteralVec`.
    A `boolean[]` from legacy has no proven carrier.
- **String methods** (`src/ir/string-method-surface.ts`):
  - `staticStringMethodArgument` returns the literal itself (`"undefined"`,
    `"null"`, `"true"`, `"false"`). The builder folds:
    - its ToNumber for a position or a length, as before;
    - its ToString for a search or a fill (new);
    - an `undefined` that has an omitted value still takes the omitted value
      (a pad fill).
  - `replaceAll` is a row beside `replace` (one `replaceRow` helper for
    both). It uses legacy's own `__str_replaceAll`, which expands `$`
    patterns through `__str_getSubstitution`, under the same
    `literalArguments` gate.
- **`normalize` is refused and noted.** Legacy validates the form and throws
  the RangeError inline (`normalize-native.ts`, `emitNormalizeFormMode`);
  `__str_normalize` takes only an already-validated mode. A row would need a
  new runtime helper, so per the brief it stays legacy.

## Measured

Base `cc27f70dfd` (main), head = this branch.

- **Target files:** 4 of the 5 reach **zero legacy units and pass** on gc
  and standalone: `indexOf` with `fromIndex`, boolean `lastIndexOf`,
  `indexOf(undefined)`, `replaceAll`. `normalize` stays legacy, by design.
- **Wrapped stride-40 ledger (standalone):**
  - zero-legacy files 32 → **36**;
  - legacy units 4493 → 4489;
  - the only per-file changes are those 4 files;
  - 0 newly-legacy units; 0 `compileOk` changes; invariants 0.
- **test262 A/B:** the families `Array/prototype/{indexOf,lastIndexOf,includes}`
  and `String/prototype/{indexOf,lastIndexOf,includes,startsWith,endsWith,padStart,normalize,replaceAll}`
  (648 files), plus 100 random (seed 7313); 745 files in all.
  - gc and standalone: **0 differences** in status or error text.
- **Playground corpus (gc / standalone / wasi):** 78 of 78 rows
  byte-identical.
- **WASI:** the 6 files and both probe fixtures validate, with the same
  legacy counts as base (the IR does not claim them on WASI).
- **Probes:** two node-generated fixtures are fully IR on head and pass on
  gc and standalone:
  - 990 array asserts (4 receivers × 3 methods × needles × 22 `fromIndex`
    values: ±0, NaN, ±Infinity, fractions, beyond ±2^31);
  - 32 string asserts (static-literal search and fill, `$&` / `` $` `` /
    `$'` / `$$` / `$1` / `$<n>` replacements).
- **Base bug fixed as a side effect:** base answers
  `[true, false, true, true].includes(true)` as `false`.
- **Compile time:** about 1.35× base on the array probe, and linear (50–400
  asserts). The full 990-assert probe hit the runner's timeout only while
  another A/B run loaded the box.

## Tests

`tests/issue-7313-ir-literal-array-string-method-rows.test.ts`:
- the node-checked array and string fixtures, zero legacy, gc + standalone;
- the 4 census files, zero legacy and passing;
- refusals: a mixed-family vec, a non-number `fromIndex`, `normalize`.

`tests/issue-7108-ir-array-search-join.test.ts`: the refusal row
`xs.indexOf(1, 1)` is claimed now, so it becomes a string `fromIndex`.

Pre-existing failures, identical on base (not caused here):
- `tests/identity-array-search-fast-path.test.ts`, 1;
- `tests/issue-5155-string-indexof-no-argument.test.ts`, 2. Its
  `indexOf(undefined)` spelling now compiles through the IR, so the hashes
  it compares change. The test was already red on base, where the two
  spellings already differed.
