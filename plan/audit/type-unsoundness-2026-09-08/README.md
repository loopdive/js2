# TypeScript unsoundness audit, 2026-09-08

The original conditional-alias program now prints `x1` in both Wasm targets
(see [the preceding repair](../../issues/5386-conditional-alias-property-write-widening.md)).
This follow-up audits 26 additional programs and adds default compiler errors
for the measured unsupported constructs.

## Measured result

Each program runs once in Node after TypeScript erasure and once in each Wasm
target, in fresh processes. The 78 rows in each JSONL file include all 26 Node
references and 52 compiler executions; blank standalone lines count as output.

| Target | Baseline matches | Baseline mismatches | Candidate matches | Candidate diagnostics | Remaining measured mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| JS-host Wasm | 10/26 | 16/26 | 10/26 | 16/26 | 0/26 |
| Standalone Wasm | 2/26 | 24/26 | 9/26 | 17/26 | 0/26 |

Diagnostics are refusals, not conformance passes. The seven additional
standalone matches come from repairing the scalar stdout sink, which previously
dropped numeric/boolean arguments in legacy lowering. `array-oob-add` remains
accepted because JavaScript and Wasm both produce `NaN` for that expression.
A missing string-map lookup matches in JS-host Wasm but is refused in standalone.

The probe categories are based on [The Seven Sources of Unsoundness in TypeScript](https://effectivetypescript.com/2021/05/06/unsoundness/):
`any`, assertions, lookups, inaccurate declarations, array variance, refinement
invalidation, and structural interactions. A local overload with an inaccurate
return declaration represents the declaration category. Optional-property alias
writes/deletion and generic spread represent structural interactions. The vague
“five turtles” heading has no canonical complete test set; these specimens do
not exhaust it. Even disjoint generic spread currently fails the baseline, so
`generic-spread-control` is a defect reproducer, not an accepted safe control.

## Reproduce

From the repository root, with dependencies installed and Node 24.4.1:

```sh
node scripts/audit-type-unsoundness.mjs .tmp/unsoundness-candidate.jsonl
```

The runner verifies 26 distinct specimens, executes all three lanes, checks
source-located error identifiers, and fails on unexpected output or outcomes.
It enables Node's experimental Wasm exception support. Standalone observations
read the native stdout exports; no missing/empty observation is counted as a
successful printed value. Compilation never executes the user's source to
choose whether to issue a diagnostic.

- [cases.json](cases.json): exact inputs and expected outcomes per target.
- [baseline.jsonl](baseline.jsonl): measurements at immutable commit
  `3bb59a816bbaf7583df477af23aa82f780dfa379` (the preceding alias fix).
- [candidate.jsonl](candidate.jsonl): working-tree measurements at the recorded `compilerCommit`, including
  the CI repair to the diagnostic classifier. `dirty: true` explicitly distinguishes the candidate from the
  baseline. `sourceTreeSha256` hashes sorted source paths, NUL, file bytes, NUL;
  `specimensSha256` hashes the specimen file. The runner rejects source changes
  during execution.

## Compiler behavior and issues

| Issue | Behavior |
| --- | --- |
| [5388 — Reject primitive type claims that contradict runtime value origins](../../issues/5388-unsafe-primitive-flows.md) | Track visible primitive origins at the use point; reject incompatible assertions, typed assignments/parameters, and inaccurate local overloads. |
| [5389 — Reject missing lookup uses that lose JavaScript undefined semantics](../../issues/5389-missing-lookup-values.md) | Diagnose observable missing values only when a closed literal lookup proves absence and the selected target mishandles it. |
| [5390 — Reject unsupported mutations through widened arrays and object aliases](../../issues/5390-structural-alias-mutation-diagnostics.md) | Diagnose visible widened alias mutations and local calls that invalidate property refinements. |
| [5391 — Reject unresolved generic object spread until runtime values are preserved](../../issues/5391-generic-spread-diagnostic.md) | Refuse unresolved generic spreads. |
| [5392 — Render scalar console output in standalone legacy lowering](../../issues/5392-standalone-scalar-console-output.md) | Render numeric and branded boolean arguments using the existing native conversion path. |

Example error (`probe.ts:1:9`):

```text
[JS2WASM_UNSOUND_ASSERTION] Cannot preserve JavaScript: this number-typed operation receives string. Keep the value dynamic or explicitly convert it before this operation.
```

Errors apply in single-source, synchronous, and multi-source compilation,
independently of TypeScript diagnostic suppression and the `safe` option.
Locations map back through single-source preprocessing. They abort before Wasm
emission. The checks permit actual `typeof` narrowing, explicit conversions,
compatible mutations, and the preceding conditional-alias repair.

## Limits and validation

This is a finite audit, not a proof of JavaScript equivalence. Unresolved
higher-order calls, opaque library contracts, dynamic/prototype-dependent
lookups, and arbitrary alias graphs remain outside the proofs in these passes.
Primitive flows without sufficient value-origin evidence remain unclassified;
unknown is not evidence of a mismatch or a certificate of safety. Lack of a finding outside the covered forms does not certify safety.
No test262 population improvement is claimed.

The final focused run passes 117/117 tests across nine files: public-API/source-map diagnostics, safe-flow controls, structural and lookup classifiers, standalone output, and the preceding alias and mixed-primitive regressions. A separate adjacent run passes 37/37 tests in four files (before the final narrow generic-identity refinement); the final focused run includes the new identity regression and three unsafe generic controls. Type checking, lint, source-size/function-size,
coercion, and oracle checks are recorded with the pull request. The existing
moved-runtime checker still reports an open graph at nonliteral imports in
`optimize.ts` and `platform-capability-adapter.ts`; its preservation witnesses
pass 6/6, but it does not certify closure or deletion.

## CI repair

The initial PR missed compiler-inventory entries and over-rejected dynamic computations. The repair registers six introduced modules without weakening activated boundaries and distinguishes unknown value origins from established incompatible origins. Boolean-to-number calls are accepted when the parameter is proven to be used only for truthiness. Promise results remain outside this pass's async ABI model. All 17 equivalence files named by CI pass 217/217 tests, matching the preceding compiler; the updated primitive/source-location suites add 42 passing checks. The original 26-program matrix still gives 19 matching Wasm runs and 33 source-located refusals.
