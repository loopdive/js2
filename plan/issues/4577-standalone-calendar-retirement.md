---
id: 4577
title: "Standalone IR: retire Calendar through explicit DOM interaction and clock capabilities"
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, runtime, capabilities, dom, modules
language_feature: dom-events-date-snapshots-module-state
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [3523, 4398, 4576]
required_by: [4585]
es_edition: n/a
assignee: ttraenkler/codex
horizon: l
lane: ir-retirement-r9-standalone-calendar
related: [1254, 2961, 3214, 3523, 3792, 4399, 4401, 4457, 4576]
origin: "Measured 2026-08-20 at the 31 IR / 6 legacy standalone checkpoint; Calendar is the complete remaining standalone family."
files:
  - plan/audit/host-import-policy-baseline.json
  - plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
  - plan/issues/3792-ir-optimization-retirement-gate.md
  - plan/issues/4401-ratchet-retire-implicit-js-host-semantics.md
  - plan/issues/4577-standalone-calendar-retirement.md
  - plan/log/ir-optimization-retirement-ledger.md
  - scripts/check-host-import-policy.ts
  - scripts/check-ir-fallbacks.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/check-ir-only.ts
  - scripts/ir-kind-neutrality-baseline.json
  - scripts/ir-only-baseline.json
  - src/adapter-manifest.ts
  - src/capability-registry.ts
  - src/codegen/calendar-codegen-planning.ts
  - src/codegen/closure-classifier.ts
  - src/codegen/closure-exports.ts
  - src/codegen/closures.ts
  - src/codegen/context/capability-state.ts
  - src/codegen/context/types.ts
  - src/codegen/dom-string-boundary.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/non-constructable.ts
  - src/codegen/index.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/codegen/ir-overlay-preparation.ts
  - src/codegen/program-abi-import-planning.ts
  - src/codegen/program-abi-intent-equality.ts
  - src/codegen/program-abi-planning.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-type-planning.ts
  - src/codegen/standalone-clock-capability.ts
  - src/codegen/standalone-dom-callback-authority.ts
  - src/dom-capability-contract.ts
  - src/host-import-policy.ts
  - src/ir/abi-bindings.ts
  - src/ir/ast-lowering-plans.ts
  - src/ir/backend/handles.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/ir/builder.ts
  - src/ir/calendar-selection-support.ts
  - src/ir/callable-bindings.ts
  - src/ir/capability-abi-validation.ts
  - src/ir/capability-provenance.ts
  - src/ir/closure-struct-registry.ts
  - src/ir/dom-capability.ts
  - src/ir/dom-boundary.ts
  - src/ir/fixed-literal-loop-proof.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/module-binding-value-kinds.ts
  - src/ir/module-bindings.ts
  - src/ir/nested-stackification.ts
  - src/ir/nodes.ts
  - src/ir/physical-ref-support.ts
  - src/ir/prepared-closure-support.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/prepared-component-ownership.ts
  - src/ir/prepared-vector-support.ts
  - src/ir/program-abi.ts
  - src/ir/promise-delay-lowering.ts
  - src/ir/select.ts
  - src/ir/string-carrier.ts
  - src/ir/type-key.ts
  - src/ir/types.ts
  - src/ir/value-references.ts
  - src/ir/vec-layout.ts
  - src/runtime.ts
  - src/runtime/clock-capability-adapter.ts
  - src/runtime/compiled-capability-authority.ts
  - src/runtime/dom-capability-adapter.ts
  - src/runtime/platform-capability-adapter.ts
  - src/runtime/standalone-dom-string-bridge.ts
  - src/runtime/standalone-timer-callback-bridge.ts
  - tests/issue-3520-program-abi-session.test.ts
  - tests/issue-3523-ir-calendar-retirement.test.ts
  - tests/issue-3523-ir-nested-stackification.test.ts
  - tests/issue-4398-capability-registry.test.ts
  - tests/issue-4576-standalone-dom-builtins.test.ts
  - tests/issue-4577-dom-interaction-bridge.test.ts
  - tests/issue-4577-dom-module-storage-provenance.test.ts
  - tests/issue-4577-standalone-calendar-retirement.test.ts
  - tests/issue-4577-standalone-clock-capability.test.ts
---
# #4577 — standalone Calendar through explicit interaction and clock capabilities

## Problem

After #4576, the authoritative standalone census is **31/37 IR, 6 legacy,
6 typed Unsupported, and zero Invariants**. Every remaining terminal belongs to
the Calendar playground: `el`, `renderCal`, `onDay`, `updFoot`, `main`, and
`<module-init>`. The other four Calendar functions are already IR-owned, but
they share one dependency-complete source component with those residual owners.

The remaining gap is not a second Calendar implementation. The JS-host lane
already prepares all ten terminals and proves their semantic and optimized
shape. Standalone still lacks the exact target projections for:

- two DOM interactions beyond the frozen `dom@1` subtree contract—event
  listener registration and `style.background` writes;
- provider-neutral `Date` snapshots backed by an explicit embedder clock;
- five nullable `HTMLElement | null` module globals whose producers and
  consumers are capability-provenanced;
- seven reusable zero-argument callbacks that must cross the DOM boundary
  without retaining `env.__make_callback` or the generic closure host bridge.

## Atomic scope

Prepare, seal, and emit the complete ten-terminal Calendar component once.
The source owners are all nine declared functions plus `<module-init>`; the
six legacy residuals may not be published as a partial component while the
four existing IR callees retain a different storage or callback ABI.

The exact standalone projection must:

- reuse the authenticated `dom@1` subtree root and native-string bridge from
  #4576 without widening its frozen eight-import contract;
- add a separately authenticated, exact DOM-interaction provider for only
  `HTMLElement.addEventListener` and `CSSStyleDeclaration.background` writes;
- add the registered `clock@1` embedder provider for
  `env.__date_now() -> f64`, preserving immediate snapshots under the
  established standalone UTC/zero-offset Date profile;
- admit only the five checker-owned nullable DOM module bindings whose writes
  originate in the exact DOM plan and whose reads/writes remain inside this
  component;
- authenticate a compiler-owned arity-zero callback dispatcher through the
  same instance-pinned lifecycle authority, with no raw-export or donor
  record able to establish authority;
- retain native stdout, number formatting, concatenation, and string
  operations, with no host Promise/string/number/console fallback.

## Fail-closed boundaries

Unknown DOM members, optional/computed access, shadowed globals, foreign nodes
or styles, wrong callback carriers, wrong import signatures, incomplete or
relabeled capability requirements, missing roots, and unbranded export records
remain rejected. A second source containing any DOM near miss must not acquire
ambient authority merely because the exact Calendar source also selects the
provider. `dom@1` itself stays byte-for-byte compatible for Builtins-only
modules.

## Acceptance criteria

- All ten Calendar terminals report one dependency-complete Prepared
  component, `legacyBodyEmitted: false`, and `irBodyEmitted: true`.
- Calendar ratchets standalone **31 → 37 IR** and **6 → 0
  legacy/Unsupported**, with zero Invariants and every residual bucket at zero.
  The current post-#4588 census is 38/38 in both lanes because the exact
  target-neutral timer shim is now an additional self-owned terminal.
- The exact runtime oracle matches the existing #3523 Calendar contract across
  deterministic clock values, repeated renders, selection/reselection,
  listener dispatch, footer totals, and all DOM text/style mutations.
- The module imports only the exact registered DOM subtree, DOM interaction,
  and clock provider ABIs. `__make_callback`, generic closure-host-bridge,
  host Date/console/string/number/concat helpers, and generic extern dispatch
  are absent.
- A direct-body poison proves all six former legacy owners are bypassed, while
  source/capability/storage/callback near misses still reach direct ownership
  or fail closed as appropriate.
- Existing Calendar optimization assertions remain true: typed scalar module
  globals and loops, direct prepared callees, immutable string/concat folds,
  specialized number conversion, bounded callback captures, and no generic
  dynamic call/boxing ladders.
- A frozen direct-versus-IR artifact and runtime A/B records raw/gzip/WAT/body,
  locals/calls/functions/imports and a warmed deterministic runtime oracle.
  Runtime parity is sufficient; no speedup claim may exceed bracket noise.
- Strict IR-only census, fallback, capability/manifest, authority, issue,
  optimization-retirement, typecheck, formatting, lint, LOC/function, and
  host-import-policy gates all pass on the final tree.

## Implementation summary

The exact Calendar source now publishes one dependency-complete component for
all nine functions and `<module-init>`, plus seven compiler-derived callback
bodies. All ten source terminals report `Prepared`, `irBodyEmitted: true`, and
`legacyBodyEmitted: false`. The bounded strict census is now symmetric:

| Lane | Entries | Terminals | IR bodies | Legacy bodies | Unsupported | Invariants |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JS host | 5/5 | 38 | 38 | 0 | 0 | 0 |
| standalone | 5/5 | 38 | 38 | 0 | 0 | 0 |

The standalone lane is therefore promoted from its temporary baseline-only
readiness mode to strict IR-only readiness for this bounded five-entry corpus.
Calendar moved its baseline from 31 to 37 emitted/IR bodies and from 6 to 0
legacy/Unsupported outcomes; #4588 subsequently reclassified the exact timer
shim to bring both current lanes to 38 emitted/IR bodies without adding a
legacy, Unsupported, or Invariant row.

The 59/59 final focused checks divide into Calendar 11/11, clock 23/23, DOM
interaction 7/7, and DOM module-storage/provenance 18/18. Together they prove:

- `dom@1` stays at its frozen eight-import ABI, while `dom-interaction@1` owns
  exactly the event-listener and background-write imports and `clock@1` owns
  exactly `env.__date_now() -> f64`;
- the five nullable DOM globals are source-qualified, capability-tagged
  `ProgramAbiMap` storage. Generic, donor, stripped, aliased, sixth-binding,
  foreign-call, and cross-source storage attempts cannot borrow that authority;
- the seven arity-zero callbacks use exact compiler-owned carriers and one
  `(externref) -> void` dispatcher. A private singleton identity check prevents
  an equal-layout ordinary closure from passing WasmGC structural type
  canonicalization; base-DOM tables have three slots, interaction tables four,
  and raw/donor/tampered export records cannot establish lifecycle authority;
- clock binding is captured once, finite and TimeClip-bounded, and attached to
  the exact compiler-certified import object. Shadowed `Date`, user-declared
  `__date_now`, wrong signatures/providers, relabeling, and cross-source demand
  fail closed instead of inheriting ambient clock authority; and
- single- and multi-source controls keep capability authority local to the
  certified source/component. Adding an authorized Calendar source cannot make
  a second source's DOM, storage, callback, or clock near miss admissible.

The 59/59 denominator does not absorb the older #3523 Calendar shape suite.
Its first final-tree rerun exposed three stale exact-shape expectations, and
that intermediate run was explicitly not reported green. After independent
attribution, the sound refresh pins `fdow`'s guarded remainder fast paths
(`i32.and` 7, `f64.trunc` 2, `i64.rem_s` 2), default `mname` inlining, direct
`renderCal` at 66 locals, direct aggregate at 151 locals, and IR aggregate at
no more than 137 and no more than direct. The related suite is now separately
green at 14/14.

The adapter manifest is a declarative record, not a bearer credential. It may
describe the selected provider and exact ABI, but authority additionally needs
compiler-owned import provenance and the registered complete-import contract;
DOM strings/callbacks then need the same instance-pinned root, export view,
manifest global, binding table, and private callback brand at runtime. A forged,
copied, relabeled, or incomplete manifest alone grants nothing.

Three initially plausible shapes were rejected during implementation. A
layout-only callback carrier was unsound because WasmGC canonicalizes equal
structural types, so the final dispatcher also checks an unforgeable
compiler-private singleton identity. Date snapshot lowering first retained only
a provider-agnostic import name, conflating host and standalone targets; the
final plan carries the exact `IrFuncRef` selected for its lane.
The first nested stackification rule crossed too broad an effect class; the
final optimization is limited to single-use native-string slot reads crossing
only independent slot reads, while writes and calls remain barriers.

## Frozen direct-versus-IR comparison

The comparator is the same exact Calendar source compiled through prepared IR
versus the legacy direct backend, both for the standalone target and both using
the same DOM, interaction, and clock runtime. Compile and instantiate time are
excluded. The optimized artifact record is:

| Metric | IR | Legacy direct |
| --- | ---: | ---: |
| raw bytes | 30,089 | 32,379 |
| gzip-9 bytes | 18,387 | 19,030 |
| pre-optimization WAT characters | 477,625 | 481,730 |
| selected function-body WAT characters | 62,481 | 69,234 |
| selected locals | 155 | 172 |
| selected calls | 172 | 172 |
| module functions | 156 | 167 |
| imports | 11 | 11 |

All 660/660 measured runtime executions preserve the deterministic 12-render
oracle and checksum. The direct/IR/direct bracket drifts enough that it does
not support a defensible speedup claim: this checkpoint establishes semantic
parity and an artifact-size/shape improvement against the legacy direct
backend, not a whole-program or Node performance claim.

The optimization-retirement ledger records this as aggregate checkpoint
evidence for the already-owned scalar-loop, direct-call, string/concat,
specialized number conversion, module-TDZ, and SSA-local decisions. Because
the aggregate comparison does not isolate each transform's runtime
contribution, pending per-row performance records remain pending and no row is
promoted solely from this A/B.

No coercion-site allowance is needed: the change-set has zero net sealed
coercion-vocabulary growth. The kind-neutrality baseline is refreshed only for
sanctioned source-line/evidence drift; its population remains 82 kinds, with 53
neutral, 26 JavaScript-dialect, 3 unresolved, and zero JavaScript kinds in core.

The host-import debt gate keeps every implicit-semantic, unknown-import,
generic-adapter, `runtime.ts`, and `resolveImport` ceiling unchanged. The
separate explicit-provider inventory for the authenticated timer, DOM,
DOM-interaction, compiled-authority, and clock leaves measures exactly 1,194
lines. Its audited ceiling is therefore ratcheted from the pre-Calendar 889 to
1,194 following explicit approval on 2026-08-20; no other host-import-policy
ceiling changes.

The final change-scoped LOC and function censuses need no exception. Across 66
changed `src/**/*.ts` files the branch adds 2,963 net lines, but no file grows
past its own grandfathered ceiling or newly crosses the 1,500-line threshold,
and no function grows past its own ceiling or newly crosses the 300-line
threshold. Accordingly this issue deliberately carries no `loc-budget-allow`
or `func-budget-allow` grant.

## Handoff

Only after this atomic checkpoint reached its historical 37/37 mark (now 38/38
after #4588) could the standalone legacy emitter be audited for physical
deletion. Passing this example census is
necessary evidence, not by itself proof that no other standalone legacy owner
or fallback remains in the wider compiler. The follow-on audit confirms that
physical retirement is still open: public direct toggles remain, single-source
non-prepared units still enter `compileDeclarations`, multi-source compilation
is still direct-first (and fast multi-source has no overlay), and class,
module-init, nested-expression, dynamic-code, WASI, and linear populations are
not represented by this five-entry census. R9 must make standalone fail closed,
complete the whole-program denominator, and prevent every standalone driver
from entering the legacy body walker before R10 can delete shared direct code
still used by JS-host/WASI paths.
