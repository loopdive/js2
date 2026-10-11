# Native string/value actual consumer execution draft

Base: `2ccdcffd9d7939eb4b64e2d0f4910856acd13a9e` (#5786).
Branch: `codex/3518-native-string-consumer-execution-tests-20260909`.
Claim: canonical claim session 44377 exit 0; independent remote check 13471
exit 3 confirms `ttraenkler/codex-native-string-consumer-execution-tests`.

## Scope and population

Review revision (static, incomplete): original 52-case draft SHA256
`94821eb82bdbb8493cf9a083b7d528c3fc5734547242682128c4e0f3eb4a7c7d`
is the retained R1 receipt. All 52 cases remain. Added 16 dependency-order cases
(forward/reversed sources × immediate/deferred × GVN × UTF), for 68 authored
tests total. Dependency var initializes through string unbox, updates to 13,
then entry derives 132; both aliases execute on original/decoded fresh instances.

Unbox evidence now filters only selected projection occurrences while retaining
the full census, verifies each exact canonical callable attachment, checks a
unique complete canonical manifest row/signature and the prepared providers map.

High gap 2 is now authored, UNRUN: accepted native declarations join via
resourceKey -> binding.entry.id -> approved emittedProgramBindingIndex to actual
module globals/functions and flattened physical type definitions. Assertions
check i8 vs i16 storage and exact literal code units, global-only byte-overflow
and surrogate cases, oversized materializer chunk-global indices in body order,
and distinct UTF8 source-empty vs UTF16 flatten-empty indices. No producer is
invoked to construct expected resources. No observer/registry is added by this
lane; parent owns the approved accessor using its existing WeakMap.

Observation controls check frozen/repeated records, copied and unknown outputs,
unknown binding IDs, and actual alias equality; slotless entries are checked
when present in the actual program ABI (no guaranteed slotless fixture claim).
Existing no-startup and immediate/deferred adapter behavior stays asserted.
Matrix approval still requires composition, typecheck, execution and review.

Only the new `tests/issue-3518-native-string-value-consumer-execution.test.ts`
and this handoff are owned. Production, boundaries, manifests, and issue files
are untouched.

52 authored tests: 11 numeric literal fixtures × 2 GVN × 2 UTF modes = 44;
startup/re-export alias fixture × 2 GVN × 2 UTF modes × 2 initialization modes = 8.
Every case executes original and actually serialized/decoded prepared programs,
each on two fresh Wasm instances with repeated source-export calls. Expected
NaN and negative zero use Object.is. Original/decoded bytes, WAT, export order,
function ordinal map, startup index, and outcomes must agree within each option.

The test uses actual source preparation with explicit standalone-native
projection and native unbox policy, acceptPreparedIrProgram,
emitAcceptedIrProgram, emitBinary, and WebAssembly.instantiate without injected
imports. It requires an actual unbox demand/provider, exact emitted source unit
population, source exports and aliases, startup publication, observation phases,
and single-use acceptance. It creates no resource pack, helper body, resolver,
fake token, or replacement module.

## Pending integration and validation

UNRUN: no compiler, typecheck, Vitest, formatting command, or code hooks executed.
The base intentionally predates Maxwell's source option and the parent's actual
consumer join. These are required dependencies, not grounds for weakening or
skipping the test. Startup alias source support remains to be measured. No
full public cutover, declaration mutation coverage, or native helper ownership
completion is claimed from this static draft. Aggregate declaration/private
chunk corruption controls remain parent-owned.

After composition and explicit heavy-slot grant, run sequentially from the
composed checkout:

```sh
GOMEMLIMIT=2GiB GOMAXPROCS=1 NODE_OPTIONS=--max-old-space-size=2048 node_modules/.bin/tsgo --noEmit
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node_modules/.bin/vitest run tests/issue-3518-native-string-value-consumer-execution.test.ts --maxWorkers=1 --no-file-parallelism
```

These commands are proposed, not receipts. Preserve failures as source admission,
acceptance, emission, binary validation, or execution failures independently.
