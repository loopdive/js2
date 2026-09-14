# Lowering cycle: generic implementation plus explicit Wasm wrapper

2026-09-08; native Astra High advisory integration. Proposal for the existing
implementation owner after N1/ABI, not a dispatch. Source is pinned to
`d71fab8b9565ad3a2bb567ed82f22e8750e804a4` in the read-only foundation
checkpoint. No source/tests/hooks/git mutations or new agents were run.

## Finding and decision

The reported cycle is real: `ir/lower.ts:60` imports `WasmGcEmitter`, creates
it at `:530` and as the default argument at `:596`; the concrete emitter
imports `emitConstInstr` and `IrLowerResolver` from lower at `:16`, then calls
the constant helper at `:197`. The helper implementation starts at lower:4572.
`LinearEmitter:50` consumes that same helper; duplicating it is incorrect.

Move generic lowering to `lower-generic.ts`, convenience assembly to
`backend/wasm-lowering.ts`, constants to `backend/wasm-constants.ts`, and the
resolver/result types to `backend/lower-contracts.ts`. Keep `lower.ts` as an
explicit compatibility facade. The pinned in-memory projection below supports
this value-cycle removal without rewriting callers or selecting a concrete
backend in generic lowering; the actual composed candidate remains unverified.

Moving only constants leaves backend selection in generic lowering. Moving only
wrappers while re-exporting them from the implementation creates another
wrapper/implementation cycle. The separate facade avoids both.

## Exact source/test write map — one reconciled Low owner

Four new source files:

1. `src/ir/lower-generic.ts`: mechanically relocate the existing implementation
   except the types, constants and wrappers below. Retain `lowerIrFunctionBody`,
   `lowerIrTypeToValType`, `bufferHasBrLabel`, `collectForOfBodyUses` and all their
   private helpers. Export the existing private
   `projectIrFunctionSignatureWithConverter` for the wrapper to share; its
   algorithm and explicit emitter/converter arguments remain unchanged.
2. `src/ir/backend/lower-contracts.ts`: move `IrLowerResolver`, `IrLowerResult`,
   `IrLoweredValue`, `IrLoweredBody`, `IrLoweredSignature` and the nine existing
   layout-type re-exports. Type imports only; same fields, optionality and
   signatures. Use F0's canonical unit brand, existing nodes/layout types and
   Wasm data. No CodegenContext, checker, generic/concrete implementation import.
3. `src/ir/backend/wasm-lowering.ts`: move `wasmValueTypeConverter`,
   `projectIrFunctionSignature`, `lowerIrFunctionToWasm`, `flattenWasmValues`
   and `flattenSlots`. Import the canonical generic functions directly.
   Keep the optional third emitter parameter and its WasmGC default exactly;
   an explicitly supplied compatible Wasm emitter still works. Signature
   projection alone still creates the same emitter but emits no body.
4. `src/ir/backend/wasm-constants.ts`: move `emitConstInstr` unchanged, importing
   `IrInstr` as a type and N1's canonical instruction model type. No lowerer,
   facade, resolver implementation or concrete emitter dependency.

Five existing source files:

5. `src/ir/lower.ts`: explicit re-exports from those four canonical files;
   no wrapper bodies, registrations, singleton copies or default factories.
6. `src/ir/backend/wasmgc-emitter.ts`: import constants from the new constant
   module and resolver type from the new contracts; method bodies unchanged.
7. `src/ir/backend/linear-emitter.ts`: the identical two import redirections
   only. This preserves shared behavior; no new linear implementation.
8. `src/ir/backend/contract.ts`: redirect its resolver type import and
   `IrLowerResolver`/`LayoutResolver` re-export to `lower-contracts.ts`.
   Keep `BackendEmitter` and `TypeConverter` unchanged.
9. `src/ir/backend/frozen-body-consumer.ts`: import the real generic body
   directly and resolver/result types from contracts. No acceptance/session,
   factory, receipt, allocation or failure-handling edits.

One new test: `tests/issue-3518-lowering-cycle.test.ts`, covering identities,
contract compatibility, cycle/import controls and behavior below. All other
source consumers and existing tests retain their imports and behavior.

## Exports, signatures and real callers

Every old runtime export remains the identical object as its new-path export,
including all eight originally exported functions. No forwarding lambdas.
All original type exports remain aliases to single canonical declarations;
`contract.ts#LayoutResolver` remains the same `IrLowerResolver` type. The
newly exported generic projector has exactly one implementation and is called
by both signature-only projection and body lowering.

Preserve `lowerIrFunctionBody<S, Slot>(func, resolver, emitter:
BackendEmitter<S>, typeConverter: TypeConverter<Slot>)` with both arguments
required. Preserve its backend-mismatch check, legality checks and result slot
grouping. The resolver's existing typed hooks remain; no unrestricted context
callback, new service locator, provider selector or replacement framework.

Production remains connected: `ir/integration.ts:551,602` uses the convenience
body/signature wrappers, and `codegen/stdlib-selfhost.ts:722` uses the body
wrapper. C's `program-consumer.ts` uses explicit generic body/converter imports
through the preserved facade. `frozen-body-consumer.ts` directly drives the
canonical generic implementation; `linear-integration.ts` consumes that batch
path. Existing Porffor and bytecode callers remain compatible. Neither C nor
its preserved drafts need edits.

Required dependency direction: facade -> wrapper -> generic; wrapper -> emitter
-> constants; generic/emitter/contract -> resolver types. The generic module
must not reach the facade, wrapper or concrete emitter through value imports
or re-export barrels. Contracts/constants must not import those implementations.
Read-only AST projection at d71 moved the five wrapper functions and constant
helper out, removed the concrete import, and retained every other original
value import (type-only contract redirections add no value edges). Traversal
resolved relative imports/re-exports against pinned Git blobs and inspected
direct dynamic import/require, import-equals and dynamic-code constructs,
without importing compiler modules or running tests. Result: **17 modules,
19 value edges; no path to `lower.ts`, `backend/wasm-lowering.ts`,
`backend/wasmgc-emitter.ts` or `backend/linear-emitter.ts`; zero observed parse,
external-resolution or nonliteral-import unknowns in that projection.**
The original graph had 19 modules/23 edges and exposed both reported cycle edges.

The twelve direct dependencies, all under `src/ir/`, are
`backend/{legality,wasm-int32-coercion,wasm-math-minmax}.ts`, `nodes.ts`,
`effects.ts`, `js-tag-domain.ts`, `outcomes.ts`, `callable-bindings.ts`,
`date-runtime.ts`, `nested-stackification.ts`, `lowering-dynamic-scratch.ts`
and `string-runtime.ts`. All seven further edges were inspected:
legality -> nodes -> tag-domain; js-tag-domain -> js-tag and tag-domain;
callable-bindings -> identity-values -> `src/shared/contracts/identity-values.ts`
(a real re-export); nested-stackification -> effects. No remaining forbidden
source path was found. This is bounded source-witness evidence, not universal
runtime closure: supplied resolver/emitter callbacks, the type graph and the
future N1/ABI composition are not certified. Existing Wasm-shaped branches
remain. Recheck the actual candidate; retain any new path/unknown as a blocker,
not an exemption. The whole-compiler two-hook closure verdict is unchanged.

## Necessary relocation bookkeeping — parent, after current work

No redesign of Boyle's gate or ABI. The move must not erase existing checks.
Exact parent-only files: `scripts/compiler-boundaries.json`,
`scripts/check-pushraw.mjs`, `scripts/pushraw-baseline.json`,
`plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md`, plus
new `tests/issue-3518-lowering-relocation-coverage.test.ts`.
**No writes to either LOC/function budget baseline or either budget checker.**

Record all four new modules, compatibility facade and original/new symbol paths
as the actual mixed/adapter state. The pushRaw checker currently scans only
`src/ir/lower.ts`; follow its moved implementation and continue checking the
facade/wrapper so new escapes cannot hide there. Compare moved bodies against
their old-path base, preserving every existing site/tag and rejecting new
untagged calls; absence of the new implementation must fail, not yield zero.
Relocation controls must exercise the real pushRaw checker with a moved
existing site and an injected new site.

Budget correction: `check-loc-budget.mjs:177` and
`check-func-budget.mjs:263` expressly prohibit PR baseline edits.
`lib/change-scope.mjs:144` uses `--no-renames`; its current per-path comparison
does not automatically transfer this split's provenance. In the PR-visible
issue-3518 frontmatter, replace only `loc-budget-allow: src/ir/lower.ts` with
`src/ir/lower-generic.ts`, and replace the two `func-budget-allow` keys
`src/ir/lower.ts::{emitInstrTree,lowerIrFunctionBody}` with their exact
`src/ir/lower-generic.ts::...` counterparts. Retire these three old allowance
keys, not historical baseline entries; preserve unrelated owners' declarations.
No duplicated allowance, wildcard, `total` grant, new budget or growth credit.

The allowance parser grants paths, not relocation equivalence. Therefore the
same issue amendment and relocation controls must carry exact old/new paths,
base/candidate SHAs, body hashes and checker-defined sizes. Measured d71 source
is 4595 newline LOC; function spans are `emitInstrTree` 2297 and
`lowerIrFunctionBody` 3380 (not the stale committed ceilings). SHA256 of exact
AST body text including braces is respectively
`75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424` and
`ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739`.
Candidate bodies must match these at this base, each span unchanged, with one
implementation and none under the old keys. Recompute both sides if the dispatch
base changes. Candidate after-sizes/hashes are **pending**, not measured here.
Account for all five resulting files against the old file, itemizing only
import/re-export/type-declaration scaffolding separately; moved bodies gain no
lines or semantic edits. Report the actual aggregate LOC delta under unchanged
total rules. A passing allowance alone cannot certify no growth; reject changed
bodies, duplicates, missing destinations or extra credit. Post-merge baseline
refresh remains the existing main-only workflow.

## Focused acceptance and ownership prerequisites

Parent runs validation later. Require old/new function-object identity and type
compatibility; direct generic import must not load wrapper/concrete/facade.
Resolve actual imports/re-exports for cycle assertions; injected reverse edges
must fail. Do not claim the entire compiler import graph is closed.

Compare exact constant instruction sequences for i32/i64/f32/f64/bool, signed
zero/NaN handling, and unchanged null/undefined errors. Preserve the emitter's
separate typed-null branch. Compare wrapper/default versus explicit emitter
results, and custom sink/slot signatures with the existing bytecode proof.

For standalone fixtures compare pinned base and composed candidate bytes,
function/type/local order, signature slot flattening, resolver call sequence
and returned values. Preserve body-before-final-signature/interning order,
the exact `name$1` multi-slot naming, allocation/provider identities, effect scheduling, exception
and terminal-unreachable behavior. Existing focused controls include
`backend-contract.test.ts`, `ir-bytecode-proof.test.ts`,
`issue-3521-linked-string-parser-abi.test.ts` and
`issue-3523-ir-nested-stackification.test.ts`; add a public standalone scalar
branch/loop fixture and existing selfhost wrapper control. Preserve refusals;
no narrowing to scalar-only implementation or new host/linear campaign.

The five existing source paths are clean against pinned d71 in the checkpoint;
scoped reads found no pending changes to them in the retained P and C checkouts.
They are outside N1 and the proposed ABI write maps. This is not ownership
clearance. Read-only cached authoritative upstream ledger
`df46c34148149f67c1247a204a2c9977aeed4687` records held
`3528:l0-p1-frozen-body-batch` for `ttraenkler/luna-ir-r8-l0p1-20260905` and
`3518:integration-consolidation` for `ttraenkler/astra-ir-integration-20260905`.
That cached snapshot is not a fresh remote/liveness check. Parent revalidates
the exact five paths and these owners at the composed dispatch base; retains
all historical claims and routes an existing reconciled implementation owner.

Only this draft was written. Public cutover, full retirement, the approved
two-hook preservation/strict-closure distinction and pending ABI work are
unchanged.
