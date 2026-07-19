---
id: 3444
title: "negative_test_fail residual (v8 harvest): early-error not detected + negative test mis-passes — 89 default / 45 standalone"
status: ready
created: 2026-07-19
priority: medium
task_type: bug
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
related: [3417, 3026, 721, 418, 2920]
---

# #3444 — negative_test_fail residual (v8 harvest, 2026-07-19)

## Summary

Per the harvest protocol (inspect `negative_test_fail` — real conformance bugs,
not noise), the 2026-07-19 baselines show a standing negative-test residual that
has **no open tracker** — the prior trackers (#3026, #721, #418, #2920) are all
`status: done`. #3417 explicitly flagged `fail::negative_test_fail` (88) as
"REAL conformance bugs — needs sub-bucket triage". This issue is that tracker.

Negative tests either (a) should raise an **early/parse SyntaxError** but the
compiler accepts the code with no diagnostic, or (b) should throw at **runtime**
but execution succeeds.

## Sub-buckets (both lanes, official)

| signature | default | standalone |
| --- | ---: | ---: |
| `expected SyntaxError but compiled with no diagnostic (early error not detected)` | 44 | — |
| `expected resolution SyntaxError but compiled with no diagnostic` (module instantiation) | 22 | 22 |
| `expected runtime ReferenceError but succeeded` | 12 | 12 |
| `expected runtime Test262Error but succeeded` | 6 | 6 |
| `expected runtime SyntaxError but succeeded` | 3 | 3 |
| `expected runtime TypeError but succeeded` | 2 | 2 |
| **total** | **89** | **45** |

## Sample paths

- `test/language/statements/labeled/value-await-module.js` (early SyntaxError not detected)
- `test/language/module-code/import-attributes/import-attribute-newlines.js` (resolution SyntaxError)
- `test/language/statements/switch/scope-lex-class.js` (runtime ReferenceError not thrown — lexical scope / TDZ)

## Root cause (hypothesis)

The compiler's early-error / static-semantics pass under-enforces several
grammar-level restrictions (labeled `await` in module context, duplicate
import-attribute keys, lexical-declaration scope collisions), and some runtime
TDZ / ReferenceError paths resolve the binding instead of throwing. The v8
harness runs the real negative-test verdict, exposing these.

## Suggested fix

Sub-triage by the specific early-error rule (each is a small static-semantics
check). Start with the `early error not detected` cluster (44) since it is the
largest and purely a parse-time validation gap. Cross-check the done #418 /
#3026 fixes for which rules regressed vs newly-surfaced under v8.

## Regression note

Prior negative-test trackers closed at earlier baselines; this residual is the
current v8-baseline standing surface with no open owner. Low-to-medium count but
genuine conformance bugs.

## Implementation Plan (architect, 2026-07-19 — mechanism sites verified)

### Where early errors are enforced today (read before changing anything)

The compiler has TWO early-error levers, both diagnostic-code-driven — there is
NO custom static-semantics AST walk today:

1. `ES_EARLY_ERROR_CODES` (`src/checker/index.ts:406-419`) — TS diagnostic
   codes NOT suppressed even under `skipSemanticDiagnostics` (1100, 1102/1103,
   1210/1211, 1213/1214, 1359/1360, 2300, 2480, 18050).
2. `HARD_TS_DIAG_CODES` (`src/compiler.ts:93-109`) — semantic TS codes promoted
   to hard compile errors (1213/1214 reserved-word-in-strict, #1435).
   The gate that turns these into a failed compile is
   `src/compiler.ts:1368-1379` (`hasSyntaxErrors || hasHardTypeErrors`).

The residual exists because several ES early-error rules have **no TS
diagnostic at all** (TS is more permissive than the ES grammar) — so no code
list can catch them. Those need a small dedicated walk.

### Changes (per sub-bucket)

**Sub-bucket 1 — `early error not detected` (44, largest)**
- Sample `language/statements/labeled/value-await-module.js`: `await: 1` as a
  LABEL in module code must be a SyntaxError (`await` is reserved in module
  goal). TS accepts it (it only restricts `await` as an *identifier
  expression* in modules).
- Add a `collectEsEarlyErrors(sourceFile, { isModule, isStrict })` syntactic
  walker in a new `src/checker/early-errors.ts`, invoked next to the
  syntactic-diagnostics collection feeding `src/compiler.ts:1373`; its findings
  join `errors` and set the same `hasSyntaxErrors` gate so `negative.phase:
  parse` verdicts see a failed compile.
- Rules to implement first (pull the exact list by bucketing the 44 sample
  paths from the harvest jsonl before coding — do NOT guess): labeled
  `await`/`yield` (module / generator context), and whichever 2-3 rules
  dominate the remaining samples.

**Sub-bucket 2 — module `resolution SyntaxError` (22+22, both lanes)**
- Sample `import-attributes/import-attribute-newlines.js` family: duplicate
  attribute keys / grammar restrictions on import attributes. Same walker,
  module-goal rules (ImportAttributes: duplicate keys → SyntaxError).

**Sub-bucket 3 — runtime `ReferenceError`/`TypeError`/`SyntaxError` not thrown (12/6/3/2)**
- Sample `statements/switch/scope-lex-class.js` — TDZ/lexical-scope semantics,
  NOT parse-time. These are codegen bugs (binding resolves where the spec
  requires a throw). Triage separately; if the TDZ cluster is coherent, split
  it into its own issue rather than bolting runtime fixes onto this
  parse-focused one. `expected runtime Test262Error but succeeded` (6) usually
  means an assertion path was optimized away — check against the #3285
  weakened-assertion class before treating as codegen.

### Edge cases
- The walker must be **goal-sensitive**: script vs module vs strict-mode
  function bodies (the compiler's module detection feeds `isModule`).
- Never fire on valid TS-only syntax (type annotations, enums) — walk the
  ORIGINAL parse tree only for constructs that are pure JS grammar.
- Verify no false positives across the existing equivalence suite —
  early-error over-enforcement fails positive tests, which is worse than the
  44 misses.

### How to test
- Negative fixtures: the 3 sample paths above via `runTest262File` — verdicts
  must flip to pass (compile fails with a diagnostic, which the negative-test
  protocol counts as the expected SyntaxError).
- Positive control: `tests/equivalence.test.ts` green; a labeled statement
  named `await` in SCRIPT (non-module, non-async) code must still compile.
- Both lanes benefit (parse-time is lane-independent) — the 45-standalone
  column should drop in lockstep.
