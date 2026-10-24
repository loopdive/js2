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

## Implementation Plan

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
- [x] Canonical dynamic operator protocol and meaningful negative controls pass for actual native carriers.
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

## Resource-only protocol census (before the operator follow-up)

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

## Native operator / IR follow-up, 2026-10-22

Resource prerequisite PR 6881 remains at exact published head
`b4776f6cc3b102a427316e8e44a7d5fab3f10f99`. Its CI run was still in progress
when the follow-up began; the new branch
`codex/7139-ir-native-instanceof-operator-20261022` preserves that head and all
predecessor HOLDs, queues and tests. Fetched main is
`dc3a066330a47f210632f507189849846d24e752`; its changes after `2fe8c1e0d5`
are artifacts/baselines, with no `src/` difference.

### Structure and code-quality criterion

- `native-dynamic-instanceof.ts` owns the full shared native operator and
  OrdinaryHasInstance. It reuses canonical Get, IsCallable, Call/argument-vector,
  ToBoolean and prototype walking. Bound targets delegate through the same full
  operator; their dispatcher reserves its slot early and fills it after carrier
  registration. No new body is minted at finalization.
- `ir/native-instanceof.ts` evaluates the already lowered operands through the
  exact runtime provider, consumes its 0/1/2 result and emits the shared native
  TypeError on 2. `ir/native-errors.ts` factors the identical error construction
  out of native `in` and function-object lowering as well. No new opcode,
  parallel property protocol or AST body semantic arm is added.
- Native dynamic-operand admission reuses the physical externref certificate;
  source expressions evaluate once, left then right, before RHS validation.
  Static/concrete operand admission and class/builtin value producers remain
  separate unfinished migration work.
- `dyn-ops.ts` observes the operator through the existing provider registry.
  Its generic observer is the same owner already extended in own PR 6878 for
  dynamic addition; integration must retain both needs when the branches join.
- The exact allocator provider registry exposes its live signature. The existing
  Program ABI declaration projection adds observed runtime signatures without
  replacing logical/nominal contracts. A final verifier pass after provider
  registration checks them before component sealing or body emission, including
  async state buffers. Only direct runtime calls receive this physical signature
  projection; intrinsic calls retain their semantic adapter contracts. This removes the gap where a malformed single call was
  only detected by the Wasm engine after binary generation.
- `object-ops.ts` changes only the existing accessor-value ABI choice to the
  canonical no-JS-host predicate. WASI now uses the same native closure carrier
  as standalone. The import collector uses the matching guard. The getter
  tests require zero imports outside `wasi_snapshot_preview1` and run the real
  Node WASI adapter; a supplied host getter stub is not accepted as evidence.

Quality acceptance: one shared operator/error/projection owner; unchanged JS
boundary bytes; no new size/cycle allowance, baseline change, direct AST body
semantics or duplicate helper registry. Fresh-context adversarial review must
check these claims before readiness/release.

### Measured evidence

- New actual-carrier protocol suite: **50/50** behavior tests across standalone
  and WASI. Class identities, primitive left operands, real TypeError/RangeError
  identity, invalid RHS/handler/prototype, exact getter counts, bound and
  bound-of-bound handlers, handler receiver/argument/ToBoolean, operand order
  and exception order are executed.
- Five checker/forward/operand functions are explicitly IR-owned with zero
  direct-body emissions. Some factory and error-classification helpers remain
  legacy-owned; this is not whole-program IR-only qualification.
- Four malformed-call injections (arity and argument carrier, both targets) now fail in verifier stage with
  **zero binary bytes**, no legacy body and no IR body. Together with declaration
  controls, **86/86** tests pass. Provider-discovery and Date-adapter controls
  bring that group to **95/95**. Before the final provider verification the
  arity injections failed: the compiler returned failure but retained an invalid
  binary, so that intermediate implementation was rejected.
- **258/258** neighboring tests pass across unsigned members, numeric class
  domains, native `in`, function-object evidence/stage 2, public hasInstance,
  custom handlers and the resource prerequisite. **72/72** protocol/resource
  tests pass with the i32 domain enabled.
- **14/14** bounded standard gc binaries remain byte-identical to b477's
  resource baseline (the same corpus was also identical to dependency 5479).
- Exact b477 before-control with the original 44 protocol rows plus five public
  descriptor/method controls: **13 failed, 14 passed, 22 skipped out of 49**.
  WASI beforeAll rejects the old host getter import; its 22 skipped cases are
  unmeasured, not claimed failures. The two descriptor tests also fail on b477
  because their empty import object lacks the existing runtime-eval namespace.
  These old failures are retained separately from the passing protocol suite.
- Raw logs are retained under own `.tmp/`: `7139-provider-post-registration-tests.log`,
  `7139-registered-provider-regressions.log`, `7139-provider-i32-tests.log`,
  `7139-provider-gc-bytes.jsonl`, `7139-early-arity-verified.log`. The exact-parent
  log is retained in the audit checkout as `7139-protocol-exact-parent-tests.log`.

### Remaining full-program failures

The corrected-start 44-program census improves from **19/44** oracle matches
on b477 to **35/44** on the operator candidate. Nine rows remain wrong: the
legacy static RHS arm omits an operand call (two targets), WASI ordinary-function
and builtin-constructor producers, computed-literal custom-handler producers
(two targets), standalone static null-prototype vivification, and static class
custom-handler producers (two targets). Raw before/after logs retain all rows;
there is no Test262 population claim. Issue 7139 and migration epic 3518 remain
in progress until the missing producers/callers and the epic's full acceptance
are qualified. C's held dyn.instanceof lane is recorded in coordination comment
6348051966; do not rewrite or take over that branch.

### Adversarial review and corrections

A fresh-context read-only review found four blockers: a bound dispatcher left
unfilled without a separate custom-handler demand; wrong scalar argument
carriers reaching backend validation; native prototype returns followed by
unreachable compatibility instructions; and duplicate binary-probe reservation
code. It also found the missing TypeError for a Symbol prototype. All were fixed
and covered by actual native controls. The ordinary helper now registers the
full operator after publishing its own slot, and reciprocal registration
rechecks the completed operator rather than minting it twice. Binary probes
share one reserve function; native and compatibility bodies are chosen at
generation time.

The shared declared-call rule now checks known argument carrier kinds and
accepts safe non-null-result widening into a nullable reference slot; the reverse
narrowing has its own negative control. This preserves the existing native Map
provider and intrinsic adapter boundary. Repeated post-hygiene/inline/mono
verification failure construction is shared to stay within both size budgets.
The canonical helper is also exposed by its existing compatibility barrel so
source-validation contract tests retain their exact export identity.

The reviewer rechecked all fixes and independently ran **86/86** protocol and
declaration/global tests: **no blocking findings remain**. This verdict covers
the reviewed local source, not full-program IR coverage or corpus-wide parity.
Review notes and the reviewer's own execution log are retained in `.tmp/`.

The broader async ownership/source-preservation group has **nine existing
failures**, with the same failure names and assertion texts on exact b477 and
the operator candidate. The newly discovered Map-result false rejection was
fixed; the provider-discovery test now passes. The existing two descriptor
failures remain outside the positive protocol denominator. Dead-export strict
closure is still open; no retirement/deletion certification is claimed.

### Final local qualification before publication

Typecheck, full lint, default and explicit-dc3 LOC/function budgets, coercion and
oracle ratchets, import cycles, IR layering, flat-directory and retirement-policy
checks pass. No new allowance or baseline was added. Stable-source dead-export
preservation passes 6/6 full and cut witnesses; strict closure remains open for
the two previously recorded nonliteral imports. One intermediate preservation
run saw source movement during execution and was discarded; the retained
stable-source log is `7139-preservation-stable-source.log`.

Final source/compatibility-barrel plus protocol tests pass **107/107**. The
reviewed 44-program census still records **35/44** matches with the same nine
remaining rows (`7139-reviewed-program-census.jsonl`). The independent reviewer
log is `review7139-recheck.log`; final standard byte evidence is
`7139-closed-review-gc-bytes.jsonl`; i32 evidence is
`7139-closed-review-i32.log` (**72/72**).
