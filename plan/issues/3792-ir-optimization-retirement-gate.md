---
id: 3792
title: "Fail-closed optimization parity gate before direct codegen retirement"
status: in-progress
sprint: current
created: 2026-07-30
updated: 2026-08-20
priority: critical
horizon: m
complexity: M
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ir, codegen
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
parent: 3518
depends_on: [3521]
required_by: [3090]
related: [2949, 3090, 3518, 3521, 4577]
files:
  - plan/log/ir-optimization-retirement-ledger.md
  - scripts/check-ir-optimization-retirement.mjs
  - tests/issue-3792-ir-optimization-retirement-gate.test.ts
  - package.json
---

# #3792 — Fail-closed optimization parity gate before direct codegen retirement

## Objective

Make optimization parity a machine-checkable prerequisite for deleting legacy
direct handlers. Every tracked direct-path optimization must have a stable
identity, explicit direct and IR owners, typed IR disposition, three evidence
records, and a retirement-readiness verdict.

This is a deletion gate, not an IR-selection gate. The current hybrid compiler
continues to use direct implementations for typed Unsupported units. A passing
ledger means its inventory is well-formed; it does **not** mean all listed
optimizations have migrated.

## Why this is required

#3518 moves the compiler to fail-closed IR-only ownership. #3521 establishes
prepare-before-emit ownership so a function body is emitted exactly once.
#3090 may delete direct AST-to-Wasm handlers only after those structural gates
close and a fresh reachability audit proves the handlers dead.

That sequence still needs a parity inventory. Without one, a handler can become
unreachable while carrying an output-shape or performance decision that the IR
path never adopted. The retirement gate makes that omission visible and rejects
a row that claims readiness without complete executable IR ownership and
evidence.

## Ledger contract

`plan/log/ir-optimization-retirement-ledger.md` contains a JSONL region inside
a readable Markdown explanation. Each row has:

- stable `id` and `family`;
- a repository-relative direct owner and symbol;
- a repository-relative IR owner, one of `lowering`, `pass`,
  `runtime-intent`, or `typed-unsupported`, plus a completion bit;
- semantic, output-shape, and performance evidence with explicit
  `verified`, `pending`, or narrowly allowed `not-applicable` states; and
- `retirementReady`, which is rejected unless executable IR ownership and all
  required evidence are complete.

`typed-unsupported` is deliberately a terminal non-ready state: it documents
why hybrid operation still needs the direct path without pretending that path
can be deleted.

## Seed scope

The initial ledger records the Acorn parity requirements identified while
migrating the runtime-dynamic entry:

1. proven numeric switch lowering;
2. grounded numeric ABI/local propagation;
3. retained direct generic closure targets;
4. guarded direct `this.m()` calls;
5. typed receiver `this` handling;
6. safe argc-frame omission;
7. native RegExp brand ordering;
8. fixed closed token tables;
9. proven `Parser.options` open-object reads;
10. dynamic string-method dispatch; and
11. mutable numeric-loop coercion.

Incomplete items remain explicitly pending or typed Unsupported. No seed row is
marked retirement-ready.

## Checker behavior

`pnpm run check:ir-optimization-retirement` parses the committed ledger without
network or generated state. It fails on:

- missing or duplicate markers, invalid JSON, or an empty inventory;
- malformed IDs/families and duplicate stable IDs;
- missing direct/IR owners or evidence references;
- invalid ownership/evidence statuses;
- IR ownership assigned to `src/codegen/`;
- `typed-unsupported` combined with completed ownership; and
- readiness without complete executable IR ownership and accepted semantic,
  output-shape, and performance evidence.

The repository's required `check:issues` package script chains that normal
consistency validation after issue-index validation. It intentionally does not
require retirement readiness while hybrid compilation remains active.

For #3090 deletion after #3518 R9,
`pnpm run check:ir-optimization-retirement -- --require-ready` adds the terminal
condition: every row must be retirement-ready or the command fails with the
remaining stable IDs.

Focused fixture tests exercise every failure family and use the committed
ledger as the positive control.

## Acceptance criteria

- [x] Machine-readable ledger exists under `plan/log/` and records the current
      direct-optimization parity inventory.
- [x] Every seed has stable identity, owners, typed IR status, three explicit
      evidence records, and retirement readiness.
- [x] Incomplete migrations are represented without claiming deletion
      readiness.
- [x] Deterministic offline checker rejects malformed rows, duplicate IDs,
      missing owners/evidence, invalid status combinations, and premature
      readiness.
- [x] Focused tests cover the committed positive control and each required
      failure mode.
- [x] Required `check:issues` validation checks ledger consistency on every PR
      without requiring readiness in hybrid mode.
- [x] `--require-ready` provides a tested fail-closed deletion-time gate for
      #3090/R9.
- [ ] #3518 R9 closes, every ledger row becomes retirement-ready, and #3090's
      refreshed reachability audit authorizes deletion. This remains future
      migration work, not acceptance for the current hybrid gate machinery.

## Result (2026-08-20)

The committed inventory measures **50 total rows**, **36 with complete IR
ownership**, **3 retirement-ready**, and **2 source-anchored direct owners**.
The result is intentionally
fail-closed for deletion while remaining green for the hybrid compiler: pending
evidence is explicit and cannot be mistaken for completed parity. Normal
`check:issues` passes; deletion-time `--require-ready` remains red as expected.
In particular, `IR-OPT-SSA-LOCAL-COALESCING` remains guarded by semantic,
output-shape, and runtime evidence rather than treating a smaller aggregate
binary as proof that every direct allocation decision has migrated.

#4577 adds a Calendar checkpoint for the existing scalar-loop, direct-call,
string/concat, specialized number-conversion, module-TDZ, and SSA-local
decisions. The same exact source and standalone DOM/interaction/clock runtime
produce 30,089/32,379 raw bytes, 18,387/19,030 gzip-9 bytes,
477,625/481,730 pre-optimization WAT characters, 62,481/69,234 selected body
characters, 155/172 locals, 172/172 calls, 156/167 functions, and 11/11 imports
for IR/direct. All 660/660 measured executions preserve the deterministic
12-render oracle. This is aggregate evidence, not an isolated runtime
attribution, so it changes no pending performance status and makes no speedup
claim.
