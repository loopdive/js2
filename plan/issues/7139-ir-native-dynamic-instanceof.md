---
id: 7139
title: "IR: lower native dynamic instanceof with complete prototype demand"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
parent: 3518
depends_on: [7138]
related: [6457, 6845, 7121, 2026]
assignee: "ttraenkler/codex-session-b"
---

## Problem and measured base

Reserved atomically with a complete open-PR scan on upstream/issue-assignments;
base is the published member boundary head
`5479dca8464ecabe0c5a26b562123131798b65e7` (PR 6879).
A separate read-only control checkout is exact main
`2fe8c1e0d5bd46adc071f484db4b0bdc8a2d54dd`.

For same-layout classes C and D, `check(o: any, K: any) { return o instanceof
K ? 1 : 0; }`, called as C/C + 10*D/C + 100*D/D, answers **0 instead of 101**
on both bases, standalone and WASI, with experimental IR disabled and enabled.
The check and caller remain legacy-owned (body-shape-rejected) even with IR on.
An explicit `K.prototype` read restores standalone on main and both native
targets on the member base. This is a missing implicit resource demand, not a
regression attributed to the member changes. Raw paired probes are retained in
the member and main audit worktrees under `.tmp/7138-dynamic-class-rhs-audit.*`.

## Implementation plan

1. Audit the shared native operator, ordinary-instance test, class prototype
   demand and their finalize order. Register implicit prototype consumption at
   the canonical native runtime owner, before idempotent reuse, guarded so the
   standard JS boundary resource graph remains unchanged.
2. Measure positive/negative class identities, inheritance, primitives and
   invalid RHS/prototype cases, custom Symbol.hasInstance and effects. Existing
   comments describing partial behavior are not correctness evidence.
3. Integrate a typed IR producer/provider through the existing native physical
   parameter proof and ProgramAbiMap. Reuse canonical runtime semantics and the
   Wasm TypeError owner; no direct AST body semantics, permissive fallback or
   duplicate instanceof algorithm. Generic any-RHS admission must stay closed
   until its actual runtime protocol is qualified. Audit class-value producers
   rather than assuming a class identifier has an IR binding.
4. Qualify actual IR ownership, values/order/error identity, default/i32 native
   targets, exact-base regressions, and standard gc byte identity. Run quality
   gates against current upstream main, with no baseline changes.
5. Publish the isolated dependent PR and obtain fresh-context adversarial review
   before readiness/release. Preserve predecessor heads, HOLDs, queues and tests.

## Acceptance

- [x] Implicit native class prototype demand fixes the measured direct case.
- [ ] Canonical dynamic operator protocol and meaningful negative controls pass.
- [ ] Supported producer/check/caller units use IR with exact provider evidence.
- [ ] Exact-base, byte identity, source gates and limitations recorded.
- [ ] PR and independent review recorded.

## Scope

Native IR/shared runtime only. Closed issue 6457 supplied explicit prototype
reads; 6845 is a separate JS-host scope. C retains Number/harness providers and
its static self-guarded function-constructor lane. This issue does not claim full
IR migration, strict closure, handler retirement or Test262 population gains.

## Qualified shared-runtime prerequisite, 2026-10-22

The canonical native dynamic helper records class prototype demand before its
idempotent return. The class arm of the existing closure/prototype identity edge
uses the canonical `__extern_get(target, "prototype")` after matching the exact
class singleton. That getter invokes the existing lazy builder, preserving its
methods, constructor identity and parent chain. No second prototype object or
algorithm is introduced. Resolving a builder index directly during the edge's
fill was rejected: multi-source fills that edge before it mints builders. The
runtime Get delegation passes both pipelines without changing finalize order.

The demand set's readers were enumerated: class prototype/instance lookup,
prototype-read arms, static sidecars/builders and instance proto arms. Its
mutators are monotonic per compilation; no program-order snapshot is lost.
`hostFreeEnvironment` guards both new demand and delegation so the JS boundary
retains its resource graph. The pre-existing primitive-classifier sequence was
moved intact to a module helper to keep the native helper under its size limit.
No source budget grant or baseline was added.

Qualification on the final source:

- **62/62** across six files: the new 18 native controls plus dynamic residual,
  constructor-name shadow, error-family, class-instance collision and
  Symbol.hasInstance suites. **18/18** separately with i32 enabled.
- The identical new 18-test file on exact dependency parent `5479dca846`
  gives **14 failures / four passing primitive-left controls out of 18**.
- **14/14** successful standard gc binaries byte-identical against that exact
  parent: arithmetic, strings, static classes, dynamic class and function
  instanceof, source effects and compileMulti, each IR off/on. This is a bounded
  byte corpus, not a full equivalence claim.
- Typecheck, lint, current-main LOC/function budgets, coercion vocabulary,
  checker-oracle ratchet, import cycles and IR layering pass. Cycle allowances
  belong to the existing console prerequisite; this change introduces none.
  Dead-export preservation passes; strict closure remains OPEN for the two
  existing nonliteral imports in optimize.ts/platform-capability-adapter.ts.
- Raw logs in the own `.tmp/`: `7139-instanceof-final.log`, `7139-i32.log`,
  `7139-gc-bytes.jsonl`, `7139-typecheck-final.log`, `7139-func-final.log`,
  `7139-cycles-final.log`, `7139-lint.log`. Same byte script/JSON and before-test
  log are retained in the parent worktree. Early failed probes and the rejected
  direct-builder/finalize-order variants remain as diagnostics, not successes.

## Remaining protocol and IR work

A separate 22-shape / two-native-target probe runs actual Node oracles and records
**44 rows** on exact main `2fe8c1e0d5` and on the candidate. On the measured
candidate **19/44** match the oracle; the only changed outcomes against main are
six corrected class identity/memberless/inheritance rows (0 to 101/11). This
probe's check function is still legacy-owned. It does not certify generic IR
admission. Both raw JSONL logs are preserved in the audit and own worktrees.

Remaining failures include dynamic invalid RHS values answering false instead
of throwing TypeError, custom hasInstance dispatch, WASI function/builtin
identities, and a call-expression RHS whose effect is omitted by a legacy
static arm. The general IR selector stays closed; the production direct AST
body emitters remain untouched. The successful resource-only prerequisite must
not be described as completing this issue or the migration epic. Continue with
canonical operator/error semantics and exact IR provider/producer evidence;
never hide these failures by adding explicit prototype reads to programs.
