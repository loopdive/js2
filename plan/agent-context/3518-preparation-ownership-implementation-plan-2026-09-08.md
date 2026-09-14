# Preparation ownership implementation checkpoint

Astra High specification, reviewed by the coordinator against published
`3a119a88b28bb347f4faaaa2146bd991acf61228` in PR5747. This implements executable
ownership/admission and freezing boundaries, not another declaration-only move.
Canonical main was verified as `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`.

## Decision

Move complete registry, capture/restore, immutable collection, freezing and
input admission implementations to canonical owners. Wire actual typed
preparation, source projection, historical wrapper and codec consumers to them.
Keep public dispatch unchanged until its original acceptance obligations pass.

The architect's lightweight literal runtime-import projection reaches 75 modules
from typed preparation and 61 from input admission. These are exploratory graph
counts, not strict closure proof. Admission unnecessarily imports mixed
`program.ts`, which imports final validation and provider machinery. Its own
algorithms only require canonical contracts, core types and ownership helpers.
`runIrProgramDriver` has no other `src` caller in this checkout; do not invent
a public compiler root from that internal API.

## Disjoint Astra Low assignments

### A: complete allocation ownership

Own only `src/ir/alloc-registry.ts`, new `src/ir/analysis/alloc-registry.ts`, and
`tests/issue-3518-allocation-runtime-seam.test.ts`.

Move `copyIrPreparationData`, `ALLOC_NAMESPACES`, private `Provenance`,
`assertAllocRegistrySnapshot` and the complete `AllocSiteRegistry` class,
including all methods, getters, private fields and initialization. Import
canonical core and existing allocation contracts directly. The old module
explicitly forwards the same constructor, function and constant objects; no
duplicate registry, algorithm change or facade import from the canonical owner.

### B: complete program data ownership and admission

Own only `src/ir/program.ts`, `src/ir/program-input.ts`, new
`src/ir/program/errors.ts`, `src/ir/program/data.ts`, `src/ir/program/input.ts`,
and `tests/issue-3518-program-ownership-runtime-seam.test.ts`.

- Errors: move the complete invariant-code union and single invariant-error class.
- Data: move private `FrozenMap` and `FrozenSet`, all four class/prototype freeze
  statements, `preparedIrReadonlyMap`, `preparedIrDataMismatch`,
  `invalidPreparedData`, `isRecursiveIrClassShape`, `immutableCopy`,
  `freezePreparedIrValue`, `hasNativeCollectionState`, and
  `freezePreparedIrRuntimeValue`.
- Input: move both exported ownership functions and all four private admission
  helpers. Import A's canonical registry and canonical data/error modules.

Preserve signatures and historical forwarding identities. Leave ABI lookup and
its validation dependency, owner lookup, backend tokens/options, candidate
builder and emission transaction in old `program.ts`. Preserve every retained
body and initialization statement. No authority cloning or new authentication.

### Coordinator integration

Only the coordinator edits `program-prepare-ir.ts`, `program-source.ts`,
`program-preparation.ts`, and `program-codec.ts` under `src/ir`: mechanically
redirect admission, registry, data and error imports as applicable. Preserve
source projection, environment controls, observation, GVN `finally`, final
validation and codec reauthentication. Coordinator also owns boundary policy,
existing receipt adaptation, end-to-end tests, issue handoff and PR publication.
Workers use isolated worktrees from the published source commit; preserve all
previous dirty worktrees. No worker commits, pushes or heavy tests until granted.

## Lifecycle and proof requirements

Preserve real-source registry creation and complete population; joint capture of
IR/globals/startup/allocation evidence; fresh transaction restoration with graph
sharing; optimization confined to that transaction; semantic freeze before
runtime authentication; in-place runtime freeze preserving authenticated object
identities; final validation before returning a prepared result.

Pin old/new constructor, error, function and constant identities. Preserve
collection iteration, `forEach`, getters and private fields. Exercise alias
chains, retired sites, next allocation ID, metadata order, explicit `undefined`,
unknown namespaces, shared references and recursive class shapes. Preserve
refusal/error identities and messages. The scope remains actual JavaScript
source and lossless internal transport, not redesigning hostile-object handling.

Execute canonical admission alone in a fresh process on a genuinely
source-produced packet. Forbid old program/registry/input facades, final
validation, provider implementations, frontend, legacy code and ambient-control
adapters; include a forbidden-load positive control. Keep the full pipeline's
separate census honest. Repeat eight standalone byte/WAT/value replay cases,
and preserve explicit TDZ, vector, async and live-record failures. Retain
allocation, typed preparation, codec and legacy prepared-program tests.

Record actual callers of moved functions, constructors and members; visiting a
class is not proof of method liveness. Disclose unproved members without fake
callers. Reconstruct existing program-data seam statements in original order,
preserving its 560-statement / 374-function denominator and initialization.

Boundary activation adds four mandatory modules: analysis minimum 1 to 2,
program 9 to 12, clean population 40 to 44. Add the exact analysis file root
beside `analysis/contracts`, not the remaining mixed analysis folder. Preserve
the historical 40-module / 109-edge fixture; update live-policy assertions
separately. No further allowed edge is proposed; validate the full composed
inventory and all new owners with type and value dependencies.

## Remaining migration work

Next split semantic verification from provider authentication, then close runtime
provider preparation and middle-end implementations, relocate the complete typed
transaction, and implement standalone physical acceptance/emission and public
cutover. Verification's counted-string provenance to AST-plan dependency is
type-only, not evidence of a runtime AST load. Program population, ABI assembly,
runtime wrappers, final validation and codec belong in program, not runtime.

Reuse canonical ABI unchanged; its fixed 30 obligations and absent public-root
`planningSealed` witness remain unresolved. Native allocation execution,
original-population conformance and direct-codegen retirement remain required.
Host/linear implementation remains deferred, not deleted from the full goal.
No hold removal, merge authorization, gate weakening or completion declaration.
