---
id: 3521
title: "IR-only R2: prepare-before-emit free-function ownership"
status: blocked
sprint: Backlog
created: 2026-07-21
updated: 2026-07-30
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r2
model: gpt-5.6-sol
parent: 3518
depends_on: [3520]
required_by: [3522, 3523, 3525, 3526]
related: [2138, 2855, 3143, 3203, 3518, 3519]
origin: "#3518 R2 — invert single-source free functions from compile/patch to prepare/emit"
files:
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/index.ts
  - src/compiler.ts
  - tests/issue-3521-prepared-ir-program.test.ts
loc-budget-allow:
  - src/codegen/program-abi-session.ts
---

# #3521 — IR-only R2: prepare-before-emit free-function ownership

## Objective

Introduce `PreparedIrProgram` and invert the default single-source top-level
free-function pipeline so every in-scope function is classified before any
function body emitter runs:

```text
source + ProgramAbiMap
        |
        v
prepare all free-function components
        |
        +-- Prepared    -> emit IR body exactly once
        `-- Unsupported -> emit direct body exactly once (temporary hybrid)

Invariant at any stage -> fail; never retry through direct codegen
```

R2 is deliberately limited to top-level `FunctionDeclaration` units in the
ordinary single-source pipeline. It establishes the ownership mechanism that
later slices extend. It does not absorb class/member/closure inventory,
module-init execution, multi-source/M0, runtime-family migration, async, or the
linear backend.

## Current evidence

The current “IR-first” path is still a conditional overlay:

- `src/codegen/index.ts:1568-1591` documents that `planIrOverlay` was extracted
  so the same mutation-bearing planner can run before or after direct body
  compilation. Type and class-shape state may depend on body-emitter effects.
- `src/codegen/index.ts:1671-1708` describes `computeIrFirstSkipSet` as a narrow
  positive allowlist. A selected function outside that numeric/boolean subset
  still compiles direct and is later patched.
- `src/codegen/index.ts:3068-3100` plans a skip set, calls
  `compileDeclarations`, and installs `unreachable` placeholders for the
  allowed subset.
- `src/codegen/index.ts:3107-3144` then builds, optimizes, lowers, and patches IR
  after `compileDeclarations`. Host callback, Date, and Promise support is
  finalized only after legacy declaration/body side effects.
- `src/codegen/declarations.ts:2251-2277` decides at body-emission time whether
  to compile direct or write a placeholder, keyed by a string name.
- `src/ir/integration.ts:168-247` mixes selection, IR build, allocation
  registry setup, and concrete Wasm registry mutation. At `:589-714` it runs
  middle-end passes; at `:748-773` it allocates new Wasm slots; and at
  `:918-1004` it lowers and patches already-created functions.
- The measured allowlist ceiling is only **441/1,568 (28.1%)**. Widening that
  allowlist cannot make the remaining 71.9% compile once.

Therefore “selected” and even “IR-emitted” are not ownership proofs. R2 makes
`Prepared` a pre-emission fact and removes the allowlist from free-function
ownership.

## `PreparedIrProgram` contract

Add a program object whose construction completes before the first in-scope
body instruction is emitted. Exact names may follow repository conventions,
but the contract is fixed:

- `abi: ProgramAbiMap` — the R1 identity/slot plan.
- `units` — one terminal R0 outcome for every inventoried in-scope unit.
- `preparedUnits` — verified, post-pass typed IR keyed by `IrUnitId`, with
  source location, final signature, export intent, and backend-legality proof.
- `directUnits` — temporary hybrid `Unsupported` units with their stable code;
  this is a routing plan, not an untyped catch/retry path.
- `supportIntents` — the complete set of imports, globals, types, literals,
  helpers, closure/callback support, runtime entry intents, and exports that a
  Prepared body may reference.
- `components` — local call-graph components and their frozen ownership. If a
  cross-unit ABI/call edge cannot be proven safe, the entire component becomes
  typed `Unsupported` before emission rather than partially emitting and
  discovering the mismatch later.

`Prepared` means AST→IR build, verification, hygiene, inline/mono transforms,
symbolic resolution validation, support-intent collection, target legality,
and final ABI/signature checks succeeded. Backend body emission is a consumer,
not another capability probe.

## Prepare/emit split

Refactor `compileIrPathFunctions` into explicit phases:

1. **Inventory and plan.** Consume R0 outcomes and R1 identities/ABI. Run the
   selector for every top-level free function even if tracking/logging is off.
2. **Build all candidate IR.** Build every selected local-call component into
   an `IrModule`; do not allocate or patch concrete function bodies.
3. **Optimize and verify.** Run current hygiene, inline, monomorphization,
   allocation provenance, and target-legality checks. Any failure before the
   Prepared boundary becomes the typed outcome required by R0.
4. **Materialize support intents.** Inventory every symbolic ref and helper
   request and resolve it through `ProgramAbiMap` before body emission. Lazy
   creation of an unplanned import/type/global/helper after this seal is an
   `Invariant`, not a reason to retry direct codegen.
5. **Freeze ownership.** Every in-scope component is now exactly one of
   Prepared, Unsupported, or Invariant. No later code can mutate that choice.
6. **Emit once.** Direct compilation receives only the Unsupported ID set and
   emits each once. IR emission receives only Prepared units and emits each
   once into its planned slot. No `unreachable` placeholder is a shipping
   ownership mechanism.

The temporary `JS2WASM_IR_FIRST=0` / `disableIrFirst` compatibility policy may
still force a unit to the typed legacy policy until R9, but it may not create a
compile-twice unit: it must classify that unit before body emission and direct
compile it once. R9 deletes the options and this forced-legacy outcome.

## Exact emission accounting

Extend the R0 unit ledger with counters keyed by `IrUnitId`:

- `prepareAttempts`
- `directBodyEmissions`
- `irBodyEmissions`
- `legacyBodyEmitted` and `irBodyEmitted` compatibility booleans derived from
  those counters

For every R2 free function:

| Outcome                 | Direct emits | IR emits | Compile succeeds |
| ----------------------- | -----------: | -------: | ---------------- |
| Prepared                |            0 |        1 | yes              |
| Unsupported (hybrid)    |            1 |        0 | yes              |
| Invariant               |            0 |        0 | no               |
| Post-Prepared invariant |            0 | 0 or 1\* | no               |

`\*` A backend may have begun writing only to an isolated transaction/buffer;
the module must not publish it. It may never direct-compile the unit. Counters
record the attempted emission and fatal outcome without claiming success.

The sum of Prepared + Unsupported + Invariant must equal the inventory
denominator, and no successful unit may have `direct + IR != 1`.

## Bounded landing sequence

### Commit 1 — split preparation from emission, no routing change

- Introduce `PreparedIrProgram` and pure/intermediate build/pass/verify APIs.
- Collect and seal support intents; make emission consume a prepared value.
- Preserve the existing routing while tests prove build/emit separation and
  byte/runtime parity.

### Commit 2 — freeze single-source free-function ownership

- Replace `computeIrFirstSkipSet` for R2 free functions with terminal outcomes.
- Pass ID sets, not names, into direct compilation.
- Direct-compile Unsupported functions once; emit Prepared functions once.
- Turn every failure after Prepared into a typed fatal Invariant with no legacy
  catch/retry.

### Commit 3 — remove free-function patch/placeholder compatibility

- Stop allocating free-function body slots as a side effect of legacy body
  compilation. Use `ProgramAbiMap` slots directly.
- Delete the free-function `unreachable` placeholder/patch branch and derive
  transitional `irFirstSkipped` / `irCompiledFuncs` telemetry from exact
  counters.
- Retain class/module overlay code untouched for #3522/#3523.

## Prepared-program-core structural slice (2026-07-30)

The first R2 landing is intentionally structural. `src/ir/program.ts` and
`src/ir/prepare.ts` define and validate the immutable prepared-program boundary
without wiring it into `src/codegen/index.ts`:

- the denominator is exactly the R1 inventory's top-level free-function
  terminals, with every unit represented once;
- asserted IR/direct/invariant routes, signatures, exports, legality,
  inline-small/monomorphization results, symbolic support, allocation, and
  provenance are retained only as explicitly **unvalidated candidates**;
- caller-supplied component groupings are likewise non-authoritative hints.
  This slice does not infer the call graph, use those groupings to claim atomic
  ownership, or reject a mixed grouping as though it were a proven component;
- a capability-only, one-shot isolated transaction exercises candidate-route
  accounting and publishes only an explicitly unvalidated candidate snapshot;
- every input is defensively copied, functions/accessors and other executable
  or mutable non-data objects are rejected recursively, and any staging,
  freezing, direction, duplication, or partial-publication error atomically
  aborts the transaction without retry.

The later production-routing slice must derive call/ABI components and
Prepared evidence from the actual post-pass IR, symbolic references,
`ProgramAbiMap`, backend legality results, allocation registry, and provenance
registry. Only that reconciliation may promote a candidate to terminal
`Prepared`, `Unsupported`, or `Invariant` ownership and feed a real emitter.

This slice does **not** change production routing and its expected
legacy-body reduction is therefore exactly **0**. It does not claim the issue's
compile-once cutover acceptance criteria; the later routing slices must consume
this boundary.

Future routing work must preserve optimization parity rather than treating the
loss of the legacy discovery pass as acceptable churn. In particular, complete
program preparation must retain inline-small eligibility, monomorphized clone
identity/signatures, and allocation provenance, and
`check:ir-optimization-retirement` remains fail-closed until its committed
parity evidence is retirement-ready.

## Scoped prepared-component ABI prerequisite (2026-07-30)

The next file-disjoint prerequisite adds a scoped seal to
`ProgramAbiSession`; it does not activate production routing. A one-shot
component transaction starts from exact terminal `IrUnitId`s, automatically
closes over source and pass-derived callables plus existing aliases/exports,
and accepts only explicitly discovered external/support binding IDs.

Successful scope sealing proves, before unrelated direct-body planning:

- source/derived callable and support identities are complete;
- callable/global structured type contracts match their planned signatures;
- required slots have an observed structural reservation and an exact
  allocator locator already present in the module;
- later derived units, aliases, exports, unit-owned support, type-contract
  additions, or locator replacement cannot extend or mutate the sealed
  component.

The whole `ProgramAbiSession` intentionally remains in planning state, so
unrelated direct bindings and support can still be registered. Whole-program
seal and final publication rebuild each scoped ABI, compare every materialized
contract while ignoring only whole-program dense-order renumbering, and fail
closed on missing/drifted identities, contracts, reservations, or locators.
Explicit type-layout remaps advance the scoped structured contracts through the
same validated remap rather than hiding an unreported mutation.

Focused evidence in
`tests/issue-3521-scoped-prepared-abi-seal.test.ts` covers a non-empty source
callable plus monomorphized clone, alias, export, and support closure; continued
unrelated planning; missing locator/reservation rejection; prepared-owned late
support/derived rejection; signature drift at publication; exact final
reconciliation; and transaction abort/retry without partial scope publication.

Adversarial review further pins the boundary:

- every registered lifted/monomorphized executable beneath a prepared terminal
  must already own exactly one source-callable reservation, structured
  contract, structural reference, and locator;
- explicitly requested bindings are limited to canonical external/support
  dependencies, cannot import another terminal's source callable/global, and
  cannot overlap a previously sealed component;
- type/class cells retain an immutable canonical layout contract. Direct cell
  remaps and in-place layout mutation fail, while the complete validated
  `applyTypeLayoutRemap` event advances the pinned layout and callable/global
  structured contracts together only when each replacement is canonically
  equal to the prior layout under that exact index remap;
- imported callable/global locators are re-read for exact host module/name,
  callable signature, global storage type, and mutability during
  reconciliation, so mutating the same import object cannot bypass the seal;
- malformed/custom binding IDs, alias cycles, duplicate dependency discovery,
  and removal of a pinned allocator object all reject before publication.

The follow-up ownership hardening uses the complete structural inventory
rather than treating a terminal row as the whole component:

- every inventoried nested function, function expression, arrow, object
  method/accessor, and class-member/support unit whose terminal ownership
  resolves to a prepared root is part of that root's sealed unit denominator;
  any existing callable is closed into the scope, while later callable or
  support planning for those units fails closed;
- every binding in the final alias/export/support closure retains the terminal
  owner resolved from its canonical encoded owner. Class owners resolve
  transitively through `IrClassRecord.lexicalOwnerId`, so a binding beneath a
  different terminal cannot be auto-claimed through an alias/export edge or
  explicitly requested as support;
- scoped type evidence pins the full transitive graph reachable from type and
  class cells plus callable/global reference contracts. An exact index
  permutation must preserve each reachable payload definition, including
  fields, mutability, and supertype relationships, under the same remap.
  `StructTypeDef.superTypeIdx === -1` remains the open-root sentinel rather
  than being traversed or rewritten as a concrete type index;
- semantic-preserving type reorders refresh alias contracts through their
  canonical callable/global owner. Aliases intentionally carrying no sidecar
  of their own therefore remain valid without weakening the exact graph
  comparison.

Focused coverage includes all inventoried nested callable kinds in the R2
component, late nested planning rejection, cross-component nested-unit and
nested-class dependency rejection, disjoint nested-class scopes,
foreign-owned alias/export closure rejection, referenced payload-shape swap
rejection, and non-vacuous callable/global inherited-alias reorder success.

This prerequisite changes neither `compileDeclarations` nor
`compileIrPathFunctions`. Production adoption and legacy-body reduction remain
exactly **0**, and all inline-small, monomorphization, allocation-provenance,
and retirement-parity obligations remain assigned to the later prepare/emit
wiring slice.

## File ownership and locks

Lock `src/codegen/index.ts`, `src/codegen/declarations.ts`,
`src/ir/integration.ts`, `src/ir/prepare.ts`, and `src/ir/program.ts` to one R2
developer. The split crosses the ownership boundary and cannot be safely
implemented as independent edits to those files.

Changes to `class-bodies.ts`, module-init body construction, multi-source
`generateMultiModule`, `src/codegen-linear/`, runtime/builtin providers, or
async frame code are out of scope. If preparation exposes one of those as a
required follow-up, record a typed Unsupported outcome and update its assigned
R3–R8 issue instead of absorbing it.

## Anti-vacuity tests

`tests/issue-3521-prepared-ir-program.test.ts` must include:

1. A numeric allowlist function and an IR-supported function outside the old
   allowlist both become Prepared and each record exactly `direct=0, IR=1`.
   This proves the result is not merely the old skip set under a new name.
2. A selector-rejected free function becomes typed Unsupported and records
   exactly `direct=1, IR=0`; there is no IR attempt or second direct compile.
3. A local-call component with one unsafe ABI edge is classified before
   emission. No member has an emitted body when the component outcome is still
   undecided.
4. Injected build/verify/backend-legality failures before Prepared yield the
   correct typed outcome. An injected failure after Prepared is a fatal
   Invariant and direct emission stays zero.
5. An unplanned symbolic import/global/type/helper requested after the support
   seal is fatal. A planned host callback, Date snapshot, Promise delay, string
   literal, lifted closure, and monomorphized clone all resolve without lazy
   fallback.
6. `JS2WASM_IR_FIRST=0` / `disableIrFirst` (while still supported) can select
   the temporary direct policy but never cause `direct=1, IR=1`.
7. Inventory, outcome, and emission denominators reconcile; duplicate/missing
   counters and a shipping placeholder fail the test.

Run these with `tests/issue-3143.test.ts`, `tests/issue-3203.test.ts`,
`tests/issue-3214-imported-hof.test.ts`, the inline/mono pass suites, and the
full equivalence/cross-backend gates.

## Acceptance criteria

- [ ] `PreparedIrProgram` is complete and immutable before any R2
      free-function body emission starts.
- [ ] Preparation includes final typed IR, verification/passes, target legality,
      ABI validation, and every support intent; emission performs no new
      capability decision.
- [ ] Component ownership is frozen before body emission. Each free function
      has exactly one terminal outcome and at most one successful body emitter.
- [ ] Prepared free functions never invoke `compileFunctionBody`, never receive
      a legacy placeholder, and record `direct=0, IR=1` regardless of whether
      they belonged to the old numeric allowlist.
- [ ] Unsupported free functions direct-compile exactly once in temporary
      hybrid mode. Invariants fail without direct retry.
- [ ] Any failure after Prepared is fatal and cannot demote, patch back, or ship
      a partial/unreachable body.
- [ ] Transitional fallback/adoption/R0 telemetry is derived from the exact
      ledger and retains label/count parity where policy did not intentionally
      change.
- [ ] Existing runtime behavior, public ABI, equivalence, cross-backend,
      standalone/WASI validity, and full merge-group Test262 are
      net-non-negative.

## Risks and mitigations

- **Preparation side effects:** a failed unit could leave imports, helpers, or
  slots behind. Build in an isolated transaction and publish only a terminal
  Prepared component.
- **Mixed-component ABI drift:** direct callers and Prepared callees may
  disagree on signatures. Freeze ownership by call/ABI component and validate
  every edge against `ProgramAbiMap` before any body emission.
- **Late support discovery:** strings, callbacks, lifted units, or runtime
  helpers may be requested during lowering. Inventory typed support intents
  during preparation and make a post-seal request an Invariant.
- **Lost inlining behavior:** the second legacy phase currently populates an
  inlinable registry. Run optimization over the complete Prepared program and
  retain explicit performance/equivalence evidence without a discovery pass.
- **Coarse fallback hiding progress:** component-atomic Unsupported may direct-
  emit more bodies initially. Report both root cause and affected component;
  never split ownership merely to improve the headline count.

## Out of scope

- Class declarations/members, constructors, class expressions, object methods,
  or nested closure ownership (#3522).
- Module-init preparation, static field/block execution, TDZ/start semantics,
  or removal of the two direct init passes (#3523).
- `generateMultiModule` whole-program ownership (R5), new runtime semantic
  intrinsics (R6), async ownership (R7), or shared linear consumption (R8).
- Removing public/env escape hatches (R9) or deleting direct handlers
  (#3090/R10).

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3521-prepared-ir-program.test.ts tests/issue-3143.test.ts tests/issue-3203.test.ts tests/issue-3214-imported-hof.test.ts tests/ir/inline-small.test.ts tests/ir/phase3c.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include inventory and outcome denominators, a per-unit
direct/IR emission table, the old-allowlist vs Prepared delta, all post-Prepared
failure injections, and proof that no in-scope placeholder or compile-twice
unit shipped. “IR emitted” without `directBodyEmissions: 0` is not acceptance.

## 2026-07-30 Program ABI session-seal prerequisite

The bounded `3521:program-abi-session-seal` slice separates
`ProgramAbiSession` into an explicit deterministic `sealPlan()` boundary and a
later `bindAndPublish()` boundary. The existing `publish()` API remains a
behavior-preserving wrapper over both phases, so production routing is
unchanged.

After sealing, new ABI drafts, derived units, contracts, locators, and
structural-reference registrations are rejected. Exact function/global
locator replacement, type-layout remapping, provisional index resolution, and
final binding remain available until publication. `sealPlan()` exposes only a
frozen read-only view; the bind-capable `ProgramAbiMap` is rebuilt privately
from frozen structural intentions and the current post-DCE type sidecars.
Final locators, indices, and collisions are validated into a temporary set
before any index is committed or a publication becomes observable.

Focused coverage proves late-plan and missing-locator rejection, post-seal
function replacement, callable/global/type-cell DCE remapping, late-import
index shifts, capability-safe sealed views, atomic failure on a later missing
locator, exact final-index binding, post-publication closure, and one-shot
publication.

This is a prerequisite seam only. Prepared free-function ownership, terminal
component outcomes, support-intent collection, and direct/IR emission
accounting remain for the main R2 implementation.
