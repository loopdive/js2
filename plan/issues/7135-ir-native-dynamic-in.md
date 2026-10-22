---
id: 7135
title: "IR: native dynamic in operator and async harness property probes"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/codex-session-b"
---

## Problem and current evidence

The integrated census in **IR test262 harness units** (#7106) identifies
`doneprintHandle.js` as a blocker in 35/266 sampled tests. `$DONE` contains
`'name' in error`, and the existing IR `in` selection requires a host-string
key carrier. It therefore rejects native-string standalone/WASI lanes even
though `preregisterInOperatorSupport` already registers their native
`__extern_has` implementation. The census is historical; this task must
reproduce the blocker on current main before changing selection.

Base: upstream `9967e915cdbb5e81b1f5a4d56df0905e1df573e0`.
The complete open-PR scan and current claim book contain no competing native
`in` slice. Existing constructor, intrinsic, closure and script-var PRs stay
with their owners. This task does not change existing PR heads or queue state.

## Implementation Plan

- `src/ir/native-in.ts` owns native key boxing, receiver validation and the
  ordered ToPropertyKey/HasProperty call. Reuse the IR boxer, callable pack,
  canonical TypeError constructor and native property-search engine.
- `src/codegen/ir-dynamic-parameter-abi.ts` owns the existing physical externref
  slot proof for JSDoc and explicit-any caller boundaries. The planner wires
  the proof; it does not duplicate it inline or broaden the fast carrier.
- Selection requires both receiver and native-key capabilities. The existing
  host-string arm, comma/static-fold exclusion and private-brand check remain.
- The shared object runtime registers its one ToPropertyKey implementation on
  WASI as well as standalone. Frozen direct-AST body emitters are unchanged.
- Quality acceptance: no second property lookup/converter/boxer, no new giant
  function, independently readable modules, and no long-function growth.
  Fresh-context adversarial review is required from the lead before release;
  no hold disposition is performed by this branch.

## Acceptance

Preserve one property-search implementation and its source evaluation order.
Prove the native key and receiver carriers before admitting them; do not
remove the host-string guard without replacing its representation proof.
Keep bare-selector missing-certificate refusals, comma-key static-fold
exclusions, private-brand checks and fast-carrier exclusions honest.

- [x] Reproduce actual IR refusals and establish legacy/runtime controls.
- [x] Check primitive RHS errors, own/inherited/absent properties, numeric and
      dynamic keys, Proxy traps, key effects and receiver effects before
      publishing broader native admission. Record existing semantic defects
      rather than treating legacy equality alone as correctness.
- [x] Reuse native HasProperty and boxing providers; no second runtime search.
- [x] Prove actual IR emission, no post-claim demotion, no JS-host imports, and
      runtime answers on the supported native targets.
- [x] Recompile unchanged `doneprintHandle.js`; report remaining blockers
      separately and claim no async/test262 gain without measured executions.
- [ ] Run meaningful existing `in`/dynamic carrier controls and normal gates;
      publish a reviewed, ready PR and report it through coordination.

Regression file: `tests/issue-7135-native-dynamic-in.test.ts`.

## Bounded findings and preserved failures, 2026-10-22

The first exact-base run failed all 13 initial controls: eight real IR-emission
checks were refused, and the five primitive-RHS cases returned false instead
of throwing, already with experimentalIR=false. The IR implementation
validates the receiver before HasProperty, reusing the
canonical typeof classifiers and TypeError constructor. Native keys preserve their scalar brand through the existing boxer; observable
ToPropertyKey runs after receiver validation, once. The old direct-AST path
retains its measured primitive-RHS defect under the development freeze.

A second dependency was the caller-direction closure: explicit any parameters
were not certified even when their registered legacy slot was proven to be
externref. The production planner now uses that exact existing physical-slot
proof for non-fast host-free any positions, as it already does for JSDoc
projections. Fast carriers and refined object slots remain excluded.

Two independent existing gaps were exposed by expanding the controls:

- `(function () {}).prototype` presence through the canonical property helper
  answers false on base (JS answers true). The native operator delegates to
  that existing helper; this is a function-object property/runtime issue in the
  active Stage 2/constructor work, not evidence of full property correctness.
  The initial failing prototype fixture and raw result remain in
  `.tmp/7135-target-tests.log`; callable receiver acceptance is also checked
  against a genuinely absent key, whose correct answer is false.
- `Symbol.for(...)` as the key expression itself is refused before IR lowering
  (`body-shape-rejected`), independently of property search. The symbol-key
  runtime control passes a real symbol through an any key parameter to test
  the operator without claiming that separate intrinsic-call syntax is fixed.

WASI is not `ctx.standalone`: the latter now means nativeRegime and deliberately
excludes WASI. Capability checks must use the actual host-free environment plus
standalone-or-WASI. The existing native ToPropertyKey body is reused on WASI as
well, rather than minting a second converter. JS-host admission is unchanged.


## Current qualification and remaining limits

The 40-case native matrix passes on standalone and WASI with
`JS2WASM_IR_I32_DOMAIN=1`. Every operator helper emits an actual IR body,
with no post-claim error, and every runtime module has zero imports. Numeric
signed/unsigned expressions, boolean parameters, dynamic strings/symbols,
Proxy lookup, primitive RHS errors, inherited/absent/present-undefined keys,
operand order and single object-key conversion are executed. On the exact
base `9967e915cdbb5e81b1f5a4d56df0905e1df573e0`, the same 40 cases all fail.
This proves the bounded helper bodies, not IR-only ownership of each module.

WASI's old `Object.create({name:3})` also loses the closed-struct prototype.
The initial failing source and result remain in `.tmp/7135-target-tests.log`.
The property-search matrix builds an actual open prototype with
`Object.create(null)` and an assignment, then links the child to it. This
exercises inherited lookup in both targets without claiming the independent
literal materialization defect is fixed. Unpublished AST-emitter repairs were
removed when the development-freeze rule was rechecked.

Unchanged `test262/harness/doneprintHandle.js` was compiled with explicit IR
selection and allowJs on both targets. Both function units still emit legacy
bodies: `__consolePrintHandle__` reports `param-type-not-resolvable`, and
`$DONE` reports `call-graph-closure`. Both runs also report the remaining
`env.print` host-import diagnostic. No post-claim errors occur. These are
remaining refusals/diagnostics, not successful host-free harness executions;
no async or Test262 population gain is claimed.

Exact-base comparison of the older comma/in suite preserves six pre-existing
failures (four comma-emission checks and two default-host in controls). No
failure is waived or relabelled as a pass.


The host controls in the older comma/in file now explicitly select
`semanticProviders: "host-assisted"`: they pass real host JavaScript objects
and observe host console logs. The original six default-native failures remain
in the exact-base logs; the corrected host-lane instrument passes 17/17.
The separate native matrix continues to use standalone/WASI native providers.

The broader 139-test control run initially passes 121 and fails 18; exact-base
runs reproduce the same 18 older failures, plus all 40 new runtime cases.
After the host-instrument correction, the remaining broader-suite failures are
11/44 in the existing ABI differential suite (claim expectations and a moved
IrType source locator) and 1/16 in the dynamic-lowering suite (native
`__str_replaceAll` nullable-argument validation). They remain outside this
change and are not counted as green tests.

Quality: the two new subsystem modules are registered as migration debt in the
compiler-boundary inventory. Inventory validity does not certify retirement.
LOC and function gates pass without allowances; the main planner shrinks and
from-ast does not grow. No budget baseline or conformance baseline is changed.
Fresh-context adversarial review is pending with the migration lead before
release; no claim is made that this review has already happened.


Final focused validation: **79/79 tests across five files**, plus **47/47** in
this issue's file with `JS2WASM_IR_I32_DOMAIN=1`. Typecheck, repository lint,
oracle and coercion ratchets pass. Dead-export preservation passes 6/6 full
source and 6/6 cut witnesses, with the strict modeled graph still open; this
is not retirement certification. Boundary inventory is valid and explicitly
architecture-incomplete. Normal hooks remain enabled.
