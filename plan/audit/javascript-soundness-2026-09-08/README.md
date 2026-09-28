# General JavaScript differential audit, 2026-09-08

This extends the earlier 26-program TypeScript unsoundness audit to 168 JavaScript
programs: 120 existing differential corpus programs and 48 additional programs.
Each program is assigned five fresh worker observations: Node, host, optimized
host, standalone, and optimized standalone. Unsupported loading protocols are
recorded without execution. Each row records the source hash and available
stage-specific evidence: compiler options, emitted binary hash, and runtime
output where those stages run successfully.

## Scope and results

The 840 baseline observations contain 168 Node references and 672 Wasm comparisons.
All observations completed and the recorded compiler/observer source state stayed
unchanged throughout the run. Baseline commit: `f816631c2ee108bd75ae916f94aac4f9ef9abcf5`.

| Verdict | Baseline | Candidate |
| --- | ---: | ---: |
| Exact observed match | 528 | 594 |
| Output mismatch | 100 | 0 |
| Completion mismatch | 16 | 0 |
| Invalid Wasm | 2 | 0 |
| Compiler refusal | 10 | 62 |
| Inconclusive Node reference | 16 | 16 |
| Total | 672 | 672 |

The original corpus covers arrays, builtins, classes, closures, control flow,
generators, numbers, objects, private fields, and strings. The new programs add
coercion/evaluation order, holes and property presence, reference identity and
aliasing, descriptors/prototypes, receivers and arguments, abrupt completion,
scope/dynamic code, class initialization, iterator mutation, Promise ordering,
and static module graphs. The same programs run with optimization disabled and
enabled. This is a finite collection of shapes, not a population estimate or a
proof that arbitrary accepted JavaScript is sound.

## Observation contract

Output is exact: no trimming, whitespace normalization, dropping empty lines, or
merging stdout and stderr. Host console calls use Node's formatter; standalone
output is read from its native sink and must require no imports. Synchronous
execution must reach a source-specific marker, so empty output is not sufficient
to count as completion. Timeouts, missing observations, opaque thrown values, and
unsupported observation protocols remain inconclusive. Compiler refusals are
never counted as conformance passes.

The three existing Promise corpus programs do not declare a completion marker;
their four comparisons each remain inconclusive even when partial output agrees.
The dynamic-import graph is explicitly outside this runner's loading contract,
adding four inconclusive comparisons. The four new async programs put an explicit
marker in their final reaction. This checks those finite reaction sequences; it
does not establish general event-loop quiescence.

Thrown primitives are compared by type and value, including NaN and signed zero.
Native Error observations compare the error category; arbitrary object throws
remain unknown. Exception stacks and all object properties are not compared.
Separate stdout/stderr strings do not establish ordering between both channels;
none of the 168 Node references emits stderr. The baseline contains no matching
abrupt completions and no empty normal Node outputs; separate real-worker controls
exercise those observer paths.

## Tracked defects and response

- [Preserve console call argument grouping in the JavaScript host target](../../issues/5394-console-argument-grouping.md): group arguments in one host call, preserving evaluation order and exceptions.
- [Preserve boolean result brands in standalone console output](../../issues/5395-standalone-boolean-result-brand.md): retain boolean identity at intrinsic and comparison producers.
- [Preserve array spread arguments passed to compiled rest parameters](../../issues/5396-rest-spread-call-representation.md): build a fresh rest array and repair literal Math spread; unsupported fixed/rest boundaries receive a located error.
- [Preserve generic reference values in standalone console output](../../issues/5397-standalone-generic-reference-output.md): route Map.get's reference carrier through the existing native stringifier.
- [Reject unsupported generator resumption and live array iterator semantics](../../issues/5398-generator-iterator-semantic-safety.md): reject measured unsupported generator/iterator shapes while retaining supported neighboring forms.
- [Refuse concrete unsupported JavaScript runtime operations found by the audit](../../issues/5399-javascript-runtime-safety-refusals.md): repair exact BigInt string conversion and diagnose concrete remaining carrier limitations.

- [Throw TypeError for primitive receivers of standalone private-brand checks](../../issues/5400-standalone-private-brand-primitive-receiver.md): preserve the primitive receiver error instead of returning false.
- [Reject unsupported enumeration and deletion carrier flows](../../issues/5401-enumeration-safety.md): diagnose the measured target-specific key order, deletion, and key-collection failures.
- [Reject Number parameter calls that incorrectly dispatch to the builtin](../../issues/5402-number-parameter-shadowing.md): a separately minimized review finding outside the 168-program manifest; the renamed callback control agrees in all four lanes.

- [Preserve negative zero and BigInt suffixes in standalone console output](../../issues/5403-standalone-console-numeric-inspection.md): another separately minimized finding outside the manifest; repair console inspection while preserving explicit String conversion and unbranded native integer output.

A review of the observation harness separated compiler exceptions from program
throws and disabled VM error decoration that had executed an Error.name getter.
The recorded baseline has no matching abrupt observations, so neither correction
invalidates an existing baseline match. Real-worker regression tests cover these
paths, including positive completed-empty-output controls.

The candidate repairs 66 previously divergent comparisons and replaces the other
52 divergences with source-located compiler errors. The ten existing refusals and
16 inconclusive references remain visible. All 62 refusals have error severity, a
source file, and positive line/column coordinates. Each candidate lane has 168
comparisons: host and optimized host each record 148 matches, 16 refusals, and
four unknowns; standalone and optimized standalone each record 149 matches,
15 refusals, and four unknowns.

The final candidate records the dirty source fingerprint on the CI-repaired base
commit; its initial and final compiler/observer fingerprints agree. The later
commit packages these exact measured sources. See [validation.json](validation.json)
for final verification, and the individual issue records for measured triggers
and limits of each refusal.

All eight equivalence gates pass without expanding the 22 known failures.
Separate runs pass 223 focused tests, 341 required-guard/type-flow tests, and
32 final enumeration tests. The enumeration suite overlaps the focused run;
these counts are separate runs, not a sum of unique tests.

## Reproduce

```sh
node scripts/audit-javascript-soundness.mjs \
  --manifest plan/audit/javascript-soundness-2026-09-08/manifest.json \
  --out .tmp/javascript-soundness.json \
  --concurrency 3 --timeout-ms 45000
```

The runner detects available V8 Wasm feature flags and uses isolated workers.
It returns a nonzero status when a comparison is not an observed match, including
explicit refusals and unknowns. Read the complete verdict rows before attributing
a failure: an earlier error or output defect can mask a later operation in the
same program. Fixes are checked again with the entire manifest.
