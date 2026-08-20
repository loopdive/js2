---
id: 4576
title: "Standalone IR: retire Builtins through explicit subtree-DOM capability"
status: ready
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
related: [1254, 2955, 2961, 3175, 3522, 4399, 4457, 4574]
origin: "Measured 2026-08-20 at the 27 IR / 10 legacy standalone checkpoint; Builtins is the shortest clean remaining family."
files:
  - src/capability-registry.ts
  - src/host-import-policy.ts
  - src/ir/capability.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/from-ast.ts
  - src/ir/number-to-string-provider.ts
  - src/runtime/platform-capability-adapter.ts
  - src/runtime.ts
  - src/codegen/declared-global-cache.ts
  - tests/issue-3522-ir-builtins-retirement.test.ts
  - tests/issue-4398-capability-registry.test.ts
  - tests/issue-4399-adapter-extraction.test.ts
  - tests/issue-4576-standalone-dom-builtins.test.ts
  - scripts/ir-only-baseline.json
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
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
