---
id: 4576
title: "Standalone IR: retire Builtins through explicit subtree-DOM capability"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, runtime, capabilities, dom
language_feature: DOM calls, Number.toFixed, String.indexOf
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [3522, 4398, 4574]
assignee: ttraenkler/codex
horizon: m
lane: ir-retirement-r8-standalone-dom-builtins
related: [1254, 2955, 2961, 3175, 3522, 3523, 3792, 4399, 4401, 4457, 4574]
origin: "Measured 2026-08-20 at the 27 IR / 10 legacy standalone checkpoint; Builtins is the shortest clean remaining family."
loc-budget-allow:
  # The implementation keeps the DOM contract, source authorization, string
  # bridge, and provider runtime in new subsystem leaves. These are the exact
  # existing integration seams that still grow while wiring those leaves.
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/codegen/index.ts
  - src/runtime.ts
  - src/ir/lower.ts
  - src/codegen/context/types.ts
  - src/codegen/extern-declarations.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/select.ts::isPhase1Expr
  - src/ir/from-ast.ts::lowerExpr
  - src/ir/integration.ts::makeResolver
  - src/ir/select.ts::isPhase1StatementListInScope
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::buildImports
files:
  - plan/audit/host-import-policy-baseline.json
  - scripts/check-host-import-policy.ts
  - scripts/ir-kind-neutrality-baseline.json
  - scripts/ir-only-baseline.json
  - src/adapter-manifest.ts
  - src/capability-registry.ts
  - src/codegen/context/types.ts
  - src/codegen/dom-string-boundary.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/object-method-rest-abi.ts
  - src/codegen/index.ts
  - src/codegen/ir-async-frame.ts
  - src/codegen/ir-inline.ts
  - src/codegen/number-format-native.ts
  - src/compiler.ts
  - src/dom-capability-contract.ts
  - src/host-import-policy.ts
  - src/ir/capability.ts
  - src/ir/dom-capability.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/number-to-string-provider.ts
  - src/ir/passes/inline-small.ts
  - src/ir/select.ts
  - src/ir/string-runtime.ts
  - src/runtime/dom-capability-adapter.ts
  - src/runtime/standalone-dom-string-bridge.ts
  - src/runtime.ts
  - tests/dom-capability-adapter.test.ts
  - tests/ir/inline-small.test.ts
  - tests/issue-4574-standalone-native-async-family.test.ts
  - tests/issue-4576-ir-ascii-case-selection.test.ts
  - tests/issue-4576-standalone-dom-builtins.test.ts
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
  - plan/issues/4401-ratchet-retire-implicit-js-host-semantics.md
  - plan/issues/4576-standalone-dom-builtins.md
---

# #4576 — standalone Builtins through an explicit subtree-DOM capability

## Problem

After #4574, the authoritative standalone terminal census is **27/37 IR,
10 legacy, 10 typed Unsupported, and zero Invariants**. The residue is exactly
Calendar six plus Builtins four. Builtins is already one dependency-complete IR
component in the JS-host lane, with a full fake-DOM semantic oracle and explicit
optimization-shape tests, but standalone rejects the family:

- `el` and `main` stop at `host-surface-unavailable`;
- `crd` and `rw` are then withdrawn by `call-graph-closure`;
- native strings cannot cross the current externref DOM argument boundary;
- native IR lacks the exact `Number.toFixed` and `String.indexOf` routes used by
  `main`;
- standalone has no authenticated DOM root/provider, and its direct artifact
  relies on unauthenticated fallback extern imports.

This is a provider and representation projection of an existing IR program,
not a second Builtins lowering.

## Scope

- Register an exact `dom@1` embedder provider for target environment `none`.
  It must receive an explicit root and authorize only values inside that
  subtree; ambient `document` access is not a fallback.
- Replace the flat JS-host selector check with an exact DOM-capability query.
  Do not admit arbitrary host extern surfaces or claim native strings are host
  strings.
- Project native strings into the DOM boundary carrier explicitly.
- Reuse the existing native string `indexOf` implementation and native number
  formatting substrate for a carrier-correct `toFixed` provider. Do not create
  duplicate formatting/string engines.
- Materialize and seal the DOM root and all provider callables before prepared
  component/Program-ABI sealing, then emit all four Builtins owners once through
  IR with no legacy bodies.
- Preserve the exact JS-host Builtins component and leave Calendar unsupported.

## Capability contract

A real DOM cannot be zero-import in a Wasm module unless it is statically
component-linked. For this slice, “standalone” means environment `none`, native
semantic providers, and one explicit embedder-owned `dom@1` boundary—not
JS-host mode and not zero total imports. The allowed ABI is exactly:

- `global_document`
- `Document_createElement`
- `Document_get_body`
- `Element_set_innerHTML`
- `Element_set_textContent`
- `CSSStyleDeclaration_set_cssText`
- `HTMLElement_get_style`
- `Node_appendChild`

Every import must be classified as `dom@1`, selected for the standalone
embedder, signature-checked, and absent when the family is not used. Arbitrary
`extern:<Class>`, `global:document`, or user-linked `env` imports remain leaks.
The runtime adapter must fail closed when no root is supplied, the root cannot
authenticate a value, metadata is tampered with, or a value escapes the
authorized subtree.

## Semantic and optimization parity

The existing #3522 oracle remains authoritative: **81 elements and 24 values**
must match, including DOM mutations, reads, array-derived text, number
formatting, and string search. Exact direct-body poison must be bypassed while
a capability/shape near miss stays direct/Unsupported.

Preserve every recorded optimization:

- fixed CSS concatenations remain folded;
- the dynamic array string retains pairwise updates plus one batched
  three-part concat;
- immutable `includes` remains constant-folded while the dynamic control keeps
  runtime work;
- constant bitwise results stay folded while dynamic controls retain native
  operations;
- `toFixed`, `indexOf`, and number/string conversion reuse existing providers;
- no generic extern dispatch, boxing ladder, argc/arguments frame, `call_ref`,
  or `call_indirect` appears in the exact component.

Run direct and IR artifacts through the same fake-DOM provider and compare raw,
gzip, WAT, body, local, call, function, and import metrics. IR must be on par
with or better than the valid direct optimization envelope; byte identity is
not required.

## Acceptance criteria

- `el`, `crd`, `rw`, and `main` each report `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and one sealed prepared component identity.
- Standalone ratchets **27 → 31 IR** and **10 → 6 legacy/Unsupported**, with
  zero Invariants. The remaining six are exactly Calendar.
- `host-surface-unavailable` moves **4 → 2** and `call-graph-closure` moves
  **3 → 1** without changing other buckets.
- The 81-element/24-value oracle, direct-body poison, near misses, capability
  authentication, import inventory, WAT shape, and direct/IR artifact/runtime
  comparisons all pass.
- `check:ir-only`, fallback, optimization-retirement, allocation, adoption,
  oracle, issue/issue-ID, LOC/function, coercion, stack, dead-export, typecheck,
  lint, and formatting gates pass.

## Handoff to Calendar

Do not split Calendar merely to bank its module initializer. Once Date/clock is
admitted, nullable DOM module storage becomes the next blocker, and #3523's
module-init/global-storage/readers/callback contract is atomic. After this
slice, retire Calendar's final six together for **31 → 37 IR** and **6 → 0
legacy/Unsupported**.

## Checkpoint result

The exact Builtins component now seals `el`, `crd`, `rw`, and `main` once
through prepared IR in the standalone lane. The authoritative standalone
census is **31/37 IR bodies, 6 legacy bodies, 6 typed Unsupported outcomes,
and 0 Invariants**. `select/host-surface-unavailable` fell **4 → 2** and
`select/call-graph-closure` fell **3 → 1**; the unchanged Calendar residue is
exactly two host-surface, two body-shape, one call-graph, and one Date-
constructor outcome.

The standalone artifact declares exactly the eight `dom@1` imports listed in
the capability contract. They bind only through the explicit embedder provider
and an authenticated root; the native-string bridge fails closed for missing,
foreign, donor, stale, or tampered authority. The focused Builtins suite is
**14/14** after adding the JS-host control. It proves the exact
**81-element/24-value** oracle in both IR and direct artifacts, live direct-body
poison, conservative near misses, and capability-boundary authentication.

The optimized IR artifact is no worse than the direct optimization control on
every frozen metric: **23,955 vs 24,500 raw bytes**, **16,867 vs 17,065 gzip-9
bytes**, **455,697 vs 465,391 compiler-WAT characters**, **49,949 vs 61,257
function-body WAT characters**, **105 vs 136 locals**, and **105 vs 116 calls**;
both contain **124 functions** and the same eight explicit DOM imports. The
shape checks preserve literal CSS folding, the pairwise-plus-batched concat
plan, immutable `includes`/`indexOf` folding, constant bitwise folding, proven-
ASCII case helpers, and fused native number-format carrier recovery without
generic extern or indirect-call ladders.

The final frozen runtime benchmark establishes parity. Fresh-process
direct/IR/direct medians were **88.375 / 76.750 / 72.833 us** over 5,001
samples after 3,000 warmups. The direct endpoints drifted **17.59%**, so that
bracket is deliberately treated as inconclusive. The paired control measured
**96.334 vs 97.334 us**, with an IR/direct ratio of **0.991725x** and p10-p90
**0.7051-1.4552**; the noise band does not support a speed claim. Every sample
preserved the 81-element/24-value/216-boundary oracle and checksum `b27b8021`,
and all source/test/harness fingerprints were identical before and after.

The final publication matrix is green. Strict IR-only reports host **37/37**
and standalone **31/37**, with **6 legacy/Unsupported** and **0 Invariants**.
All fallback, optimization-retirement, issue/ID, oracle, adoption, allocation,
dead-export, coercion, LOC/function, host-policy, kind-neutrality, stack,
harness-budget, typecheck, formatting, lint, and diff-integrity gates pass. The
host-policy census remains non-vacuous at **33 probes / 393 imports / 0
legacy-semantic / 0 unknown**, and the optimization ledger validates at **50
decisions / 36 IR-owned / 3 retirement-ready / 2 source-anchored**.

## PR #4663 Test262 follow-up

The [post-merge Test262 report](https://github.com/loopdive/js2/pull/4663#issuecomment-5360874330)
identified one newly lost standalone pass and a neighboring assertion failure
that had both become null dereferences. The closed-struct direct-call route was
padding an object method's `...[pattern]` tuple formal with `ref.null`, because
only ordinary identifier rest formals publish `$Vec` metadata.

The direct route now declines that fixed-tuple binding-pattern ABI so the
existing generic dispatcher performs rest initialization. Ordinary
`...identifier` object methods recover their already-materialized `$Vec`
layout and remain direct calls. The #4576 matrix hash-pins and executes both
exact Test262 sources: `scope-meth-param-rest-elem-var-close.js` passes again,
while `scope-meth-param-rest-elem-var-open.js` returns to its exact pre-merge
assertion failure rather than trapping. A WAT/runtime control independently
proves the ordinary identifier-rest direct path.
