---
id: 3026
title: "negative_test_fail: residual early-error / static-semantics gaps (~79 default-lane, 64 unenforced SyntaxErrors)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-04
status_note: "Slices 1–3 landed. Slice 3 (PR): private-name grammar early errors — (a) private name referenced in a class heritage clause, (b) private name as a destructuring-pattern key (10 test262 files). Issue stays open — remaining unenforced-SyntaxError samples (module-code, import.meta, top-level-await) decompose into further independent point-fixes per the issue's own triage note."
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: parser
language_feature: early-errors, static-semantics
goal: spec-completeness
test262_category: language/expressions/class/elements/syntax/early-errors, language/statements/for-of/dstr, language/expressions/object
test262_fail: 79
related: [927, 1091, 1435, 1805, 1931, 2912, 2920]
---

# #3026 — residual negative_test_fail: early-error / static-semantics gaps

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`),
`negative_test_fail` records — tests where test262 expects an early
(parse-time) or runtime error and the compiler instead accepts/executes the
program. **79** total, a residual after a long line of prior early-error
issues (#927, #1091, #1435, #1805, #1931, #2912, #2920) each closed a wave of
these; new specific gaps keep surfacing as the parser/static-semantics
coverage grows (expected pattern for this project — not a regression).

## Breakdown

| pattern                                                                        | count |
| ------------------------------------------------------------------------------ | ----: |
| expected `SyntaxError`, compiled with no diagnostic (early error not detected) |    64 |
| expected runtime `ReferenceError` but succeeded                                |     9 |
| expected runtime `SyntaxError` but succeeded                                   |     3 |
| expected resolution `SyntaxError`, no diagnostic                               |     2 |
| expected runtime `TypeError` but succeeded                                     |     1 |

## Sample failing files

- `language/expressions/class/elements/syntax/early-errors/grammar-private-environment-on-class-heritage-function-expression.js`
- `language/statements/for-of/dstr/array-rest-elision-invalid.js`
- `language/expressions/object/prop-def-invalid-async-prefix.js`

## Suggested approach

Same procedure as the prior early-error issues in `related:` — for each of
the 64 unenforced-`SyntaxError` files, identify the specific static-semantics
rule (grammar-level early error, usually documented directly in the ECMA-262
production's "Early Errors" clause) and add the missing check to the
parser/semantic-analysis pass. Given the pattern of this project's prior
early-error issues, expect this to decompose into several small, unrelated
point-fixes rather than one shared root cause — triage each sample
individually before batching.

## Acceptance criteria

- `negative_test_fail` count in the default lane drops materially below 79.
- No new `negative_test_fail` regressions introduced (verify via a
  differential test262 run before/after).

## Slice 1 landed — trailing comma after a rest element (2026-07-03)

**Delivered:** a precise parse-time early error for a trailing comma following
a rest element in every destructuring-pattern position — an
`AssignmentRestElement` / `BindingRestElement` / `AssignmentRestProperty` /
`BindingRestProperty` must be the final element with no trailing comma
(elision) after it:

- `[...x,] = y` (array assignment pattern) and the for-of/for-in head form
  `for ([...x,] of ...)` — covers the issue sample
  `language/statements/for-of/dstr/array-rest-elision-invalid.js`.
- `const [...x,] = y` (array binding pattern).
- `({...x,} = y)` (object assignment pattern).
- `const {...x,} = y` (object binding pattern).

**Root cause:** the pre-existing "rest must be last" check only fired when an
_element_ followed the rest (`[...x, y]`); TypeScript's parser accepts the bare
trailing comma `[...x,]` silently and does NOT insert a trailing
`OmittedExpression`, so nothing detected it. Fix keys off the NodeArray's
`hasTrailingComma` flag when the last element is the rest.

**Files:** `src/compiler/early-errors/assignment.ts` (array + object assignment
patterns), `src/compiler/early-errors/node-checks.ts` (array + object binding
patterns). Tests: `tests/issue-3026.test.ts` (5 reject + 5 valid-control
cases). Byte-inert for all valid programs — spread-with-trailing-comma in an
array/object literal _value_ (`const v = [...x,]`, `{...x,}`) and a trailing
comma after a non-rest element (`[a,]`, `{a,}`) all remain valid.

**Remaining:** the other unenforced-`SyntaxError` samples (private-name grammar,
`prop-def-invalid-async-prefix`, etc.) are independent point-fixes per the
issue's own triage note — issue stays open for follow-up slices.

## Slice 2 landed — `async` prefix on a shorthand property (2026-07-03)

**Delivered:** a precise parse-time early error for `async` used as the prefix
of a shorthand object property. `PropertyDefinition : IdentifierReference`
(shorthand) is a bare IdentifierReference and admits no modifier; `async` is
only valid as the prefix of an `AsyncMethod`, which requires a `(` parameter
list. Covers the issue sample
`language/expressions/object/prop-def-invalid-async-prefix.js` (`({async async})`)
and the cover-initialized-name form `({async x = 1})`.

**Root cause:** TypeScript's parser silently accepts `({async async})` /
`({async x = 1})` as a `ShorthandPropertyAssignment` carrying an `AsyncKeyword`
modifier with **no** parse diagnostic — unlike `({get x})` / `({set x})` /
`({* x})`, which it already flags. So nothing in the early-error pass detected
it. The fix checks for an `AsyncKeyword` modifier on a
`ShorthandPropertyAssignment` (the only modifier that produces this node shape
without a TS parse diagnostic).

**Files:** `src/compiler/early-errors/node-checks.ts` (one additive check next
to the existing shorthand-property checks). Tests: `tests/issue-3026.test.ts`
(+2 reject, +4 valid-control cases). Byte-inert for all valid programs —
`async` as a plain shorthand name (`({async})`), alongside other shorthands
(`({async, x})`), as an async method (`({async foo(){}})`), and as a normal key
(`({async: 1})`) all remain valid.

**Remaining:** further unenforced-`SyntaxError` samples (private-name grammar on
class heritage, `array-rest-elision-invalid` residuals, etc.) remain independent
point-fixes — issue stays open for follow-up slices.

## Slice 3 landed — private-name (`#x`) grammar early errors (2026-07-04)

**Delivered:** two precise parse-time early errors for private-name grammar
rules, clearing all **10** `elements/syntax/early-errors` unenforced-`SyntaxError`
samples (verified: 10/10 now pass, 0/113 related passing files regressed):

- **(a) Private name in a class heritage clause.** `class C extends class { x =
this.#foo; } { #foo; }` — per §15.7.14 ClassDefinitionEvaluation the
  `ClassHeritage` is evaluated with the OUTER PrivateEnvironment, so `C`'s own
  `#foo` is not yet in scope in `C`'s `extends` clause → SyntaxError. Covers
  `grammar-private-environment-on-class-heritage{,-function-expression,-recursive,-chained-usage}`
  (both class-expression and class-statement forms).
- **(b) Private name as a destructuring-pattern key.** `const { #x: v } = this`
  / `({ #x: v } = this)` — `ObjectBindingPattern` / `ObjectAssignmentPattern`
  property names are `PropertyName`, which excludes `PrivateIdentifier` →
  SyntaxError even when `#x` is declared in the enclosing class. Covers
  `grammar-private-field-on-object-destructuring`.

**Root cause:** (a) `isInsideClassWithPrivateName` walked ALL enclosing classes
and counted a class's own private members even when the reference lived in that
class's heritage clause — it now skips a class's members when the reference is
within that class's `heritageClauses`. (b) the existing PrivateIdentifier check
only enforced "must be declared in an enclosing class"; a private name used as a
`BindingElement.propertyName` or an object-pattern property key was silently
accepted by TS's parser (no diagnostic under `skipSemanticDiagnostics`) — a new
additive branch flags it before the enclosing-class rule.

**Files:** `src/compiler/early-errors/predicates.ts` (heritage-scoped
`isInsideClassWithPrivateName` + `isNodeWithin` helper),
`src/compiler/early-errors/node-checks.ts` (destructuring-pattern private-key
branch). Tests: `tests/issue-3026.test.ts` (+4 reject, +3 valid-control cases).
Byte-inert for all valid programs — private field reads (`this.#x`), `#x in o`,
normal object/array destructuring, and sibling classes with independent private
fields all remain valid.

**Remaining:** the module-code / `import.meta` / top-level-await
unenforced-`SyntaxError` samples are independent point-fixes (several need module
linking/resolution) — issue stays open for follow-up slices.

## Slice 4 landed — "rest must be last" completion (element after rest) (2026-07-05)

**Delivered:** three additional early errors completing the "rest must be last"
grammar rule — Slice 1 caught the trailing-comma-after-rest forms; this slice
adds the **element-after-rest** forms that TS drops as semantic diagnostics under
`skipSemanticDiagnostics`:

- **Object binding pattern:** `const {...rest, b} = y` — a `BindingRestProperty`
  must be the final element.
- **Object assignment pattern:** `({...rest, b} = y)` — an `AssignmentRestProperty`
  must be last.
- **Rest parameter not last:** `function f(a, ...b, c) {}` / `(a, ...b, c) => …`
  — a `BindingRestElement` in a `FormalParameterList` must be last.

Covers `language/expressions/assignment/dstr/obj-rest-not-last-element-invalid`,
`language/statements/for-of/dstr/obj-rest-not-last-element-invalid`, and
`language/rest-parameters/position-invalid` (5/5 affected pass; 120/120 valid
function/param/destructuring files regression-checked, 0 regressions).

**Files:** `src/compiler/early-errors/node-checks.ts` (object-binding
element-after-rest + rest-parameter-not-last), `src/compiler/early-errors/assignment.ts`
(object-assignment spread-not-last). Tests: `tests/issue-3026.test.ts` (+4 reject,
+3 valid-control; 30 total pass). Byte-inert for valid programs — object rest as
last element, rest param as last param, and object spread in a value position
(`{...x, b: 1}`) all remain valid.

## Slice 5 landed — duplicate binding name within a destructuring parameter (2026-07-05)

**Delivered:** an early error for a parameter list that binds the same name twice
via a destructuring pattern — `BoundNames` of a `FormalParameterList` /
`ArrowFormalParameters` must contain no duplicates. The pre-existing
`checkDuplicateParams` caught INTER-parameter duplicates (`(x, x) => …`) but
collapsed INTRA-parameter duplicates that a single destructuring parameter binds
more than once (`([x, x]) => …`, `({y: x, x}) => …`) — a plain `Set` deduped
`[x, x]` down to one `x`, so the duplicate was lost.

**Root cause:** `collectBindingNames` accumulated each parameter's bound names
into a fresh `Set`, which cannot represent an intra-pattern duplicate. Switched to
the existing `collectBindingNamesWithDuplicateCheck(name, seen, dupes)` collector
with a single `seen` set shared across all parameters — it flags both intra- and
inter-parameter duplicates. Covers `language/expressions/arrow-function/syntax/early-errors/arrowparameters-cover-no-duplicates-{binding-array,binding-object}-*`
(2/2 affected pass; 130/130 valid arrow/param/destructuring files regression-checked,
0 regressions).

**Files:** `src/compiler/early-errors/duplicates.ts` (`checkDuplicateParams`).
Tests: `tests/issue-3026.test.ts` (+4 reject, +3 valid-control; 37 total pass).
Byte-inert for valid programs — distinct names in a destructuring parameter, and
the same name reused across two SEPARATE (non-parameter) destructuring bindings,
all remain valid; sloppy-mode simple-parameter duplicates (`function f(x, x) {}`,
still legal) are unaffected (the non-simple / arrow / strict gate is unchanged).
