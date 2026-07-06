---
id: 3026
title: "negative_test_fail: residual early-error / static-semantics gaps (~79 default-lane, 64 unenforced SyntaxErrors)"
status: done
completed: 2026-07-06
sprint: current
created: 2026-07-03
updated: 2026-07-06
status_note: "DONE — bounded parser/static-semantics early-error lane complete (slices 1–8). Residual triage 2026-07-06 (see final section) re-ran all 55 `negative_test_fail` entries still in the fetched baseline (run 20260705) through the live runner on current main: 49/55 already PASS (stale baseline — slice 1–8 work + adjacent early-error landings fixed them; the fetched baseline just hadn't refreshed). Only 6 genuinely fail, and NONE is a parse-time early-error point-fix — all deferred-class (eval / module+top-level-await / `using` explicit-resource-management / runtime strict-PutValue / restricted-global runtime SyntaxError). Acceptance criterion (`negative_test_fail` materially below 79) met: 79 → 6 real. Residuals handed to their feature owners; closing the bounded lane."
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

## Slice 6 landed — at most one `default` clause in a switch (2026-07-05)

**Delivered:** an early error for a switch statement whose `CaseBlock` contains
more than one `DefaultClause`. ES `CaseBlock : { CaseClauses_opt DefaultClause
CaseClauses_opt }` Static Semantics: Early Errors — it is a Syntax Error if a
CaseBlock contains more than one `DefaultClause`. Covers test262
`language/statements/switch/S12.11_A2_T1.js`.

**Root cause:** TypeScript's parser accepts a second `default:` clause with no
diagnostic (it parses two `DefaultClause` nodes into the same `CaseBlock`), so
nothing in the early-error pass detected it. The fix adds
`checkDuplicateDefaultClause` — a linear scan of `caseBlock.clauses` that flags
the second and any later `DefaultClause` — wired into the existing
`ts.isCaseBlock(node)` branch of the per-node walk (so it fires for nested
switches too).

**Files:** `src/compiler/early-errors/duplicates.ts` (new
`checkDuplicateDefaultClause`) and `src/compiler/early-errors/node-checks.ts`
(import + one call in the `CaseBlock` branch). Tests: `tests/issue-3026.test.ts`
(+3 reject, +4 valid-control). Byte-inert for valid programs — verified: a switch
with a single default, no default, a default-before-cases, a nested switch, and
fallthrough all compile to byte-identical Wasm (sha256-compared against the
pre-change compiler); only a switch with two-or-more default clauses newly raises
the early SyntaxError.

## Slice 7 landed — no line terminator between `throw` and its expression (2026-07-05)

**Delivered:** an early error for the restricted production `ThrowStatement :
throw [no LineTerminator here] Expression ;`. A LineTerminator right after
`throw` triggers ASI, which would leave `throw;` (no operand) — a SyntaxError.
Covers test262 `language/asi/S7.9_A4.js`.

**Root cause:** unlike `return` / `break` / `continue` (where ASI produces a
valid statement), TypeScript's parser silently reparses the expression after the
newline as its own statement and synthesizes a **zero-width (missing)** throw
operand, emitting no diagnostic — so nothing in the early-error pass detected it.
The fix flags any `ThrowStatement` whose `expression` has `getFullWidth() === 0`
(a missing operand). This also covers a bare `throw;` with no operand at all.

**Files:** `src/compiler/early-errors/node-checks.ts` (one additive check in the
per-node walk). Tests: `tests/issue-3026.test.ts` (+3 reject, +3 valid-control).
Byte-inert for valid programs — verified via sha256: `throw <expr>` on the same
line (including a `throw` whose operand itself wraps across lines, e.g.
`throw new Error(\n …)`, and a `throw` inside a switch case) all compile to
byte-identical Wasm against the pre-change compiler; only a `throw` with a
missing operand (newline immediately after `throw`, or bare `throw;`) newly
raises the early SyntaxError.

## Slice 8 landed — escape sequences in a meta-property keyword (2026-07-05)

**Delivered:** an early error for a `MetaProperty` (`new.target` / `import.meta`)
whose contextual keyword carries a Unicode escape. Per ES grammar notation
(5.1.5) a terminal symbol must appear exactly as written — so `new.target`
(and, in module code, `import.meta`) are SyntaxErrors. Covers test262
`language/expressions/new.target/escaped-target.js`.

**Root cause:** TypeScript parses `new.target` as a `MetaProperty` whose name
node has the canonical `.text` (`"target"`) but a raw `.getText()` that still
carries the escape, with **no** parse diagnostic — so nothing detected it. The
fix flags any `MetaProperty` where `name.getText() !== name.text` (the raw source
differs from the canonical keyword ⇒ an escape was used). The same check also
covers escaped `import.meta` in module code.

**Files:** `src/compiler/early-errors/node-checks.ts` (one additive per-node
check). Tests: `tests/issue-3026.test.ts` (+2 reject, +2 valid-control).
Byte-inert for valid programs — verified via sha256: `new.target` in a
constructor, in a plain function, and in a comparison all compile to
byte-identical Wasm against the pre-change compiler; only an escaped meta-property
keyword newly raises the early SyntaxError.

## Residual triage (2026-07-06) — bounded early-error lane COMPLETE; issue closed

Re-ran **all 55** `negative_test_fail` entries still present in the fetched
baseline (`.test262-cache/test262-current.jsonl`, run `20260705`) through the
**live runner** (`runTest262File`) on current `main`. Result:

- **49 / 55 already PASS.** They are **stale baseline entries** — slices 1–8
  plus adjacent early-error landings already fixed them; the fetched baseline
  simply had not been refreshed (the committed baseline auto-refreshes via the
  `promote-baseline` job on the next push to main). Notably, ALL the class /
  private-name / rest / switch / throw / meta-property / `class let {}` samples
  now pass (several are caught by TypeScript's own parser once the class body /
  strict context is in play).
- **6 / 55 genuinely fail**, and **none is a parse-time early-error point-fix**.
  Each is a deferred-class residual belonging to a different feature area:

  | # | file | expected | why it's NOT a bounded early-error fix |
  |---|------|----------|-----------------------------------------|
  | 1 | `eval-code/direct/strict-caller-global.js` | runtime SyntaxError | direct **eval** with a strict caller → `strictEval` rejects `var public` (eval is skip-listed; needs eval strict-mode semantics) |
  | 2 | `eval-code/direct/var-env-global-lex-non-strict.js` | runtime SyntaxError | **eval** `var x` colliding with a global lexical `let x` (EvalDeclarationInstantiation var/lex collision) |
  | 3 | `global-code/decl-lex-restricted-global.js` | runtime SyntaxError | `let undefined;` at **global-script** scope → GlobalDeclarationInstantiation `HasRestrictedGlobalProperty`. `phase: runtime` — the runner requires a real **runtime throw** (or a compiler *warning*); an early compile-**error** is reported as `compile_error`, NOT a pass, so a parse check does not satisfy it |
  | 4 | `identifier-resolution/assign-to-global-undefined.js` | runtime ReferenceError | strict-mode assignment to an **unresolvable reference** (`PutValue` on `IsUnresolvableReference` in strict) — runtime strict-assign semantics / value-rep substrate |
  | 5 | `module-code/top-level-await/await-dynamic-import-rejection.js` | — | **module linking + top-level-await + dynamic `import()`** (all three skip-listed) |
  | 6 | `statements/using/global-use-before-initialization-in-prior-statement.js` | runtime ReferenceError | `using` **explicit-resource-management** TDZ (unsupported feature) |

**Verdict:** the bounded parser / static-semantics early-error lane for #3026
is **complete** (slices 1–8; `negative_test_fail` 79 → 6 real). The 6 residuals
are each out of the early-error lane and are owned by their feature epics
(eval; module/top-level-await; `using`/ERM; and the strict-runtime / value-rep
substrate). Closing this issue as **done**; the residuals should be tracked
under those areas rather than re-opened here.

**Method note for future harvests:** the fetched baseline jsonl lags current
`main` (here 49/55 entries were phantom). **Always re-verify a
`negative_test_fail` cluster against `runTest262File` on current `main` before
coding** — do not trust the baseline snapshot as a live failure list.
