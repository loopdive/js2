---
id: 3681
title: "Differential whole-program target matrix — Node oracle vs JS-host, standalone, WASI, and linear"
status: backlog
sprint: Backlog
created: 2026-07-26
updated: 2026-08-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing, compiler, codegen-linear
language_feature: whole-program-semantics
es_edition: multi
goal: test-infrastructure
related: [1203, 1854, 1941, 2711, 3518, 3781, 4567, 4568, 4569, 4570, 4572]
---

# #3681 — Differential whole-program target matrix

## Objective

Extend the existing differential corpus into one explicit target matrix that
compares observable whole-program behavior against Node while keeping Test262
as the standards oracle. Every applicable compiler lane must either run the
program or report a typed, visible reason that the lane is inapplicable.

## Existing foundation

The repository already has the harness proposed by this issue's first draft:
`tests/differential/corpus/`, `scripts/diff-test.ts`, and the #1203 delta gate.
The JS-host lane compares Node and compiled-Wasm stdout and writes
`benchmarks/results/diff-test.json`; CI blocks regressions while allowing known
failures to remain visible. The corpus currently contains roughly 120 source
programs.

The open work is therefore an extension, not a second harness:

- stderr and exit status are not compared;
- standalone/WASI and linear applicability are not a first-class matrix;
- observable thrown-error class and exported results are not captured where a
  lane exposes them;
- deliberate normalizations and target-specific divergences need a maintained
  ledger with owners and evidence.

## Target matrix

For each corpus program, record an explicit row for:

| Lane | Oracle / comparison | Minimum observables |
| --- | --- | --- |
| Node | reference execution | stdout, stderr, exit status, thrown error |
| JS-host WasmGC | Node | byte output, exit/error class, exposed exports |
| standalone/WASI WasmGC | Node where portable | byte output, exit/error class |
| JS-host linear | Node and WasmGC | byte output, exit/error class, exports |
| standalone/WASI linear | Node and WasmGC where portable | byte output, exit/error class |

Target-inapplicable source is a measured result with a stable diagnostic code,
not a missing row. The artifact reports per-lane denominators and counts for
pass, known divergence, unsupported, compile failure, runtime failure, and
harness failure. A zero-sized or silently skipped lane fails anti-vacuity
checks.

## Observable contract

- Compare stdout and stderr as bytes, preserving ordering when the runner can
  observe it, plus exact exit status.
- Capture thrown error name/class and stable message portions without treating
  engine-specific stack paths as semantics.
- Compare exported primitive/structured results when both runners expose them;
  use the repository's established canonicalization rather than ad hoc string
  conversion.
- Keep every normalization narrow, numbered, documented, and tested with a
  positive control proving the unnormalized difference would be detected.
- Separate compiler semantic divergences from host API/WASI environment
  differences. A capability absent from a target is not normalized into a pass.

## Corpus growth and safety

Grow the corpus with real multi-feature programs and minimized regressions from
Test262/npm work. Give priority to feature interactions, initialization order,
exceptions, async scheduling, closures/classes, dynamic values, host adapters,
and lifetime/rooting stress. Where native sanitizer tooling is not applicable
to WasmGC, add equivalent allocation/collection/rooting stress and engine
validation; do not claim sanitizer coverage that the lane did not execute.

Generated cases record seed and generator version. Handwritten cases state the
behavioral interaction they protect. Test262 remains authoritative for
language conformance, and its license/metadata rules are preserved when a
minimized case is derived from it.

## Node API contract corpus

Add a focused corpus partition for provider-backed `node:*` APIs. Its manifest
records the canonical module/member, import shape, arguments, environment and
capabilities, applicable targets, and observables. Coverage of one member is not
reported as coverage of its whole module.

In addition to stdout and exit behavior, Node API fixtures compare:

- returned values and stable object fields;
- error name/class, `code`, selected stable message fragments, and first-error
  ordering;
- argument coercion and side effects that occur before provider dispatch;
- callback cardinality and relative `nextTick`/microtask/timer/event-loop order;
- emitted import/provider selection and explicit target-inapplicability reason.

Every module/member/target row remains in the denominator as pass, known
divergence, unsupported, unknown, compile failure, runtime failure, or harness
failure. A missing provider or unseen dynamic member is not a skipped pass.

## Reusable corpus interchange

Define a small, documented fixture manifest for source files, arguments,
environment, expected observables, target applicability, normalization IDs,
seed/generator data, license, and provenance. Keep the runner repository-native,
but make individual fixtures portable enough for compiler/runtime/tooling
projects to exchange minimized failures and feature-interaction cases without
adopting one another's architecture or support policy.

Imported fixtures retain attribution and are reviewed against this project's
language contract. Exported fixtures contain no repository-only absolute paths,
secrets, or implicit host setup. Shared cases improve the oracle; another
implementation's pass/fail classification never becomes authoritative here.

## Divergence ledger

Maintain a machine-readable ledger and a rendered documentation view. Each
entry includes a stable ID, affected lanes, exact normalization or intentional
difference, motivation, owner/follow-up issue, first and last verified commit,
and a focused regression fixture. Expired or unmatched entries fail CI; broad
wildcards and output deletion are forbidden.

## Acceptance criteria

- [ ] The existing runner captures stdout, stderr, exit status, and thrown
      error class for Node and JS-host WasmGC without weakening the #1203 gate.
- [ ] Standalone/WASI, JS-host linear, and standalone/WASI linear are explicit
      lanes with per-program applicability and typed reasons for unsupported
      rows.
- [ ] Result artifacts report the corpus revision plus per-lane denominators
      and pass/divergence/unsupported/compile/runtime/harness failure counts.
- [ ] Applicable target lanes compare exports where observable and distinguish
      compile failure, trap, exception, nonzero exit, and harness failure.
- [ ] Every normalization/divergence has a stable ledger entry, owner, focused
      test, and positive control; stale or unused entries fail the gate.
- [ ] CI blocks new regressions in every established lane. A new lane may begin
      advisory only with a committed baseline and a named promotion issue/date.
- [ ] Corpus growth includes feature-composition and lifetime/rooting cases;
      generated cases record reproducible seeds and versions.
- [ ] A versioned fixture manifest can import/export a focused case without
      losing arguments, observables, applicability, seed, license, or
      provenance; at least one round-trip fixture proves the interchange.
- [ ] The Node API partition reports per-module, per-member, import-shape, and
      per-target denominators, with unsupported and unknown rows retained.
- [ ] Focused Node API fixtures compare stable errors, validation/side-effect
      order, and callback scheduling, with positive controls proving the
      harness detects each kind of divergence.
- [ ] Test262 remains a separate, authoritative standards signal; differential
      pass counts are not labeled conformance.

## Out of scope

- Replacing Test262, equivalence, import-leak, or artifact-validity gates.
- Treating target-inapplicable programs as passes or omitting them from the
  denominator.
- Normalizing away host capability gaps, error classes, or substantive output.
- Adding another backend solely to increase the number of matrix columns.
