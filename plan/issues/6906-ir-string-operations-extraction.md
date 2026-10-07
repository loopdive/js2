---
id: 6906
title: "Extract generic string operations from the IR lowering dispatcher"
status: in-progress
sprint: current
created: 2026-10-07
updated: 2026-10-07
assignee: ttraenkler/codex-ir-string-independent-architecture-20261007
branch: codex/6865-string-independent-architecture-20261007
priority: high
horizon: short
complexity: M
feasibility: straightforward
reasoning_effort: medium
task_type: refactor
area: ir, architecture
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir
model: gpt-6.1-sol
parent: 6865
depends_on: []
files:
  - src/ir/lower-generic.ts
  - src/ir/lowering/string-operations.ts
  - tests/issue-6865-lowering-string-operations.test.ts
  - tests/issue-3518-lowering-cycle.test.ts
  - tests/issue-3526-string-boundary-charcodeat.test.ts
---

## Problem and scope

The shared IR lowerer keeps seven string operations inside its large instruction
switch despite already having a generic typed terminal interface. Extract that
coherent family into one generic leaf, preserving operand order, receiver binding,
prepared evidence and the existing `emitInstrTree` driver. This architecture
packet is independent of parent 6865, **IR source maps: complete unmapped interval
recording and safe VLQ rendering**. It copies no prepared source-map overlay,
wrapper, physical source guard, C1 receipt, baseline, backend or runtime change.

Fresh canonical main is `3c671f11506f91f4eb91624cf9a8456ca95a6ce8`, fetched
from upstream on 2026-10-07. Its lowerer preimage SHA-256 is
`bfeb0cc9d88277b698751bea8f2ba90801179525da6e74fdab9deccfcf470c0f`.
The seven original arms match the reviewed parent preimage exactly, SHA-256
`caefbf36d49fc7086d88be3c5db0b42979dffb55c351c4826993fc1159e0fd04`.
Atomic allocation and actual upstream canonical JSON assign this independent
issue to `ttraenkler/codex-ir-string-independent-architecture-20261007`,
write id `98930-z5d1p870`. Source edits began only after that record was verified.
The isolated worktree is `/private/tmp/js2-ir-string-independent-architecture-20261007`.
The earlier object and source-map worktrees remain untouched.

## Reviewed implementation plan

The Astra V2 plan SHA-256 is
`7a4e7b50197ef967c1bbf3ea5f5e26ca1fbdcc80f6cae8ca94e5d132dab034d2`.
Its relevant complete sections follow verbatim. They describe the larger future
family program; this issue implements only the string packet and its exact graph
companion. Root separately approved standalone composition on canonical main.

## Disjoint writer ownership

Each writer owns only its listed **new** files. No writer edits the lowerer or another writer's files. Root alone imports helpers, wires once-per-function contexts, replaces the listed switch arms, and removes the vector scratch definitions when that adapter is installed. Root owns all adoption, issue/proof records and qualification scheduling.

| Packet | New production files | New focused test |
| --- | --- | --- |
| String | `src/ir/lowering/string-operations.ts` | `tests/issue-6865-lowering-string-operations.test.ts` |
| Object / ref-cell | `src/ir/lowering/object-cell-operations.ts` | `tests/issue-6865-lowering-object-cell-operations.test.ts` |
| Dynamic member | `src/ir/lowering/dynamic-members.ts`; `src/ir/backend/wasm-lowering/dynamic-members.ts` | `tests/issue-6865-lowering-dynamic-members.test.ts` |
| Vector | `src/ir/lowering/vector-operations.ts`; `src/ir/backend/wasm-lowering/vector-data.ts` | `tests/issue-6865-lowering-vector-operations.test.ts` |

Use named exported `emitStringOperation`, `emitObjectCellOperation`, `emitDynamicMember`, `emitVectorOperation`, each accepting an exact `Extract<IrInstr, {kind: ...}>` union, a typed context and `out: S`, returning void. Exhaustive switches have no catch-all success; maintain compile-time `never` exhaustiveness. Root groups the exact case labels and returns the helper call. No string-keyed function registry, boolean "handled" fallthrough, broad `IrInstr` helper, or dynamic dispatch table.

Existing emitter/handle contracts are reused by type-only import. Narrow `Pick` views retain the original receiver object; do not destructure methods that may use `this`. No common megacontext, per-instruction context, helper cloning, family-local SSA algorithm, or new target capability. Slots, binary/scalar families, statement-buffer/control-flow, physical audit/lifecycle repair, frontend/select/from-ast, B's Linear emitter/runtime/C ABI and unknown Session B claims are outside all packets.


### String: existing generic boundary, no adapter needed

Current captures are only `emitter` and `emitValue`. Context has exactly:

```ts
readonly emitter: StringBackendEmitter<S>;
readonly emitValue: (value: IrValueId, out: S) => void;
```

No resolver, function metadata, scratch, type queries, source-map context or map/set access. Preserve these argument sequences exactly: const forwards value/alloc/storage/materializer; concat emits lhs then rhs and forwards alloc, `concatMode ?? "immutable"`, provider; repeat emits value then count and forwards encoding evidence, provider and counted append trip count; eq emits lhs/rhs then negate/provider; len emits value then inputEncoding/provider; both character operations emit value then index, forwarding existing alloc where applicable, encoding and provider. Do not infer a provider, normalize UTF-16, select host/native policies, or move `requirePreparedStringProvider` (still used by `forof.string`) here. Actual encoding/storage/materializer recipes remain in current emitters.


## Shared state, initialization and source scope

All contexts/factories are created once after `emitValue` and `resolveVecType` are initialized, before the driver is invoked. `emitInstrTree` may lexically reference the later driver, but **no constructor calls emitValue or a resolver**: the first invocation remains the existing final `emitBlockBody`. This avoids the temporal dead zone. Do not pass a later const by value prematurely or add top-level cached function contexts. Empty maps may be created then; physical local creation remains lazy.

Root exclusively owns defBy/param maps, typeOf, use counts, crossBlock, needsLocal, localIdx and materialized. Families receive no access to these containers: they call emitValue, preserving parameter refinement, lazy subtree emission, local.tee/materialized updates and zero-use statement scheduling. Do not inline or duplicate those algorithms. Reader/mutator inventory for moved vector maps is complete: each has one allocator as sole reader/writer; call sites are only vec.set and vec.new_fixed respectively. Their associated locals list is shared: SSA allocation/slots populate it before emission; date/bitwise/minmax/dynamic/await/finally and vector scratch append during recursive emission; all allocators read its current length, and final TypeConverter projection reads all entries. The adapter must retain this exact live array rather than a snapshot. It must not use root's differently named `allocScratchLocal`, which appends an index suffix and would change local names.

The existing `emitInstrTree = withSite(instr, ...)` remains the outer source scope. Extracted functions are unscoped callees; each operand's emitValue re-enters its defining site and restores the parent before terminal emission. Dynamic raw recipes continue through emitter.pushRaw inside that parent scope. No family reconstructs physical instructions to repair attribution. Existing ownership, active/checked cycle guards, physical snapshot equality and audit failure behavior remain unchanged.


## Dependency and size floor

All four generic modules can have **zero runtime imports**: use type-only canonical `core/nodes`, `core/types`, existing narrow emitter/resolver contracts and handles where needed. Object helper functions arrive through its typed context. Both backend adapters can likewise have zero runtime imports, using only typed injected resolver/emitter operations and built-ins. Their type-only edge to the generic operation contract is allowed; generic modules never import the backend implementations, `lower-generic`, frontend, codegen, target resources or runtimes. Root composition imports the six implementations. This is a bounded clean family closure; the existing whole root lowerer's target dependencies are not claimed removed.

Each new test should bank an actual dependency boundary: resolve/transpile and load its generic module with a forbidden-runtime-import loader (follow the existing core-type/core-vocabulary seam test pattern); floor the expected exported function and exercise a nonempty operation. Include a positive denial control for a forbidden target import so an empty graph is not accepted as evidence. Count expected four generic roots/six production roots at composition. Static scans alone are supplemental. No target capability is inferred from type checking.

Replacing 20 arms with grouped dispatch (20 labels plus four returns) could remove approximately **229 driver lines** before comments/style changes: driver ~2011, still far above 300. Parent reduction is smaller because root adds four narrow contexts/two adapter factories; vector removes ~24 scratch implementation lines. These are arithmetic estimates, not gate results or promises. Plan each new function below 300 and module below 1500; expected family bodies are roughly 45–110 lines, adapter factories below 150. Do not rename the driver to shed its counter or move it wholesale.

Fresh static runs of `node scripts/check-loc-budget.mjs` and `node scripts/check-func-budget.mjs` both exited **1** in this inspected root. LOC reports lower-generic 4302 > 4280 (+22); function reports parent 3483 > 3460 (+23) and new driver 2240 > 300. Other red files include program-source, integration, both codegen drivers, compiler, frontend/select and public entry/context; this family slice does not clear them. Gate output also retains existing binary allowances; this plan adds none and does not own binary work. After composition rerun the actual gates against the actual resolved base, preserve full failures, and record total source growth; no baseline bumps, waivers or hashes substituted for tests.


## Standalone composition and proof obligations

Reuse the already reviewed generic string module and corrected focused test.
Change only three lowerer seams: runtime/type import, one stable two-field
context after `emitValue`, and grouped seven original string cases that invoke
`emitStringOperation` then return. Preserve the existing driver name and all
other lowerer code. No source-scope wrapper is introduced.

The exact lowering-cycle test expects the original runtime graph. The actual
leaf has no runtime imports; composition adds only one observed runtime edge
`src/ir/lower-generic.ts -> src/ir/lowering/string-operations.ts`. Extend its
module list, add that one edge occurrence in import order and change the root
edge count from 12 to 13. Retain every forbidden reverse-import control and
its fresh-process nonempty lowerer invocation. No proof hash is replaced with
an unauthenticated new pin. C1 authority and lowering-analysis receipt
populations do not include the lowerer; their bytes remain untouched.

## Acceptance and qualification

- [x] Exact canonical-base diff limited to the four listed source/test paths and this issue.
- [x] Production and new-focused-test TS7, scoped lint/format, dialect/pushRaw and actual changed-file budgets pass without grants or baseline edits; original test diagnostics are attributed against pristine main.
- [x] Actual dependency graph witnesses exactly one new leaf/edge and no target implementation edge.
- [x] Focused 19 string rows and original cycle/refusal/API rows complete with exact registered identities and statuses.
- [x] Existing string boundary, repeat, native output, character and round-trip suites qualify the actual standalone source epoch; no synthetic route is credited as native parity.
- [x] Collection/body evidence retains failures and source/config/test/tool custody before/after; no blanket retries.
- [ ] Freeze reviewed diff/results before commit, fork publication and ready PR; root owns queue integration.

Prior parent-source 19/19 and 73/73 receipts are historical only and do not
qualify this new canonical-main composition. At authoring time runtime bodies
remain held until root reviews the frozen candidate and actual collection.

## Frozen standalone implementation and candidate qualification

The actual parsed runtime graph adds exactly one module and one edge, as
witnessed by `.tmp/string-independent-architecture-20261007/actual-graph-witness.json`;
root edge occurrences are 12 before and 13 after. The three graph expectation
edits preserve all reverse-import refusals and fresh-process controls. Scoped
lint/format, dialect and pushRaw gates pass. Both real changed-file LOC and
function gates pass against canonical base `3c671f1150`; total source growth is
36 lines, with the lowerer shrinking and the new leaf remaining 69 lines. No
grants or baseline/proof edits were made.

The focused string test plus source closure passes TS7. Including the existing
cycle test exposes three unchanged errors: two old null constants lack their
`ty` field, and an old WebAssembly call has a BufferSource generic mismatch.
The same actual TS7 invocation on a separate pristine canonical-main worktree
reports the same three diagnostic messages, apart from the expected two-line
graph-list shift. Those assertions remain untouched; the baseline receipt is
`ts7-cycle-baseline.log` and exact normalized comparison is recorded.

Candidate collection completes 642 rows across 13 files: 19 focused string,
25 lowering-cycle, 27 original relocation, 355 unchanged C1, 36 native-output,
12 repeat, 6 fromCharCode, 7 native-round-trip, and 155 five-boundary rows.
No runtime body has executed for this standalone epoch. Root reviews the
frozen source/diff and chooses runtime qualification epochs; all failures
will be preserved rather than silently excluded or retried.

## First standalone runtime receipt and preserved failures

The instrumented collection reported 642 active JSON rows and 643 genuine IPC
registrations, including the unchanged original initial-relocation provenance
skip. The first runner stopped before body on that exact count difference.
Root approved narrow accounting of the captured collection only: 642 active
rows plus the explicit original skip predicate and raw IPC mode. No new
collection or skipped-row exclusion was used. The runner preimage and stopped
collection remain preserved.

The one authorized body then completed all 643 registered rows: 615 passed,
27 failed, one skipped. Exactly 642 active rows reached terminal status; all
JSON/IPC identities and per-row statuses agree, no IPC errors occurred and
all 15,904 custody inputs plus HEAD/branch/index/status stayed unchanged.
C1 passes 355/355, cycle/API/graph passes 25/25, focused extraction passes
19/19 and the native/string regressions pass 215/216.

Twenty-six original relocation-fixture rows fail before their assertions
when fixture Git commits cannot decrypt the configured SSH signing key.
The implementer omitted `SSH_AUTH_SOCK` from the runtime environment; its
actual inherited value was absent. Claim commands used the configured
socket explicitly. Signing was not disabled and no hook was bypassed.
The remaining failure is an unchanged raw character-code demand reader:
it searches integration.ts for `function irStringCharCodeAtDemand(`, but
canonical main already imports that function from `program/runtime-demands.ts`.
The complete test, integration and current demand-owner bytes exactly match
the canonical base. This source comparison is baseline attribution evidence,
not an unexecuted baseline pass.

All failed/stopped receipts are retained under
`.tmp/string-independent-architecture-20261007/qualification642-v1/` and
`qualification642-body-v2/`, with explicit status agreement and failure
signatures. No rerun, assertion change, commit or publication was performed.
Root decides any narrow environment rerun or existing-reader consequence;
the required full denominator remains unsatisfied. This paragraph is a
post-runtime issue update, outside the recorded custody window.

## Bounded blocker attribution and reader correction

Root approved two separate consequences of the failed full epoch. First, the
configured signing agent exposes ED25519 key
`SHA256:DR95AGYro71Tam9UvWGtJZtdhbvNVI+qlGMp/naIyHc`; a temporary git
signature control verifies successfully. An environment-only full relocation
file rerun with `/var/run/com.apple.launchd.PiCv9LrvUs/Listeners` completes
27 passing active rows and one original skip, exit 0, exact JSON/IPC identity
and status agreement, no IPC errors and full custody unchanged. The prior
raw population already contained 28 registered rows: one healthy pass,
26 signing failures, one skip. The extra healthy row was not fabricated.
A runner path bootstrap error before any test body is also preserved.

Second, the exact demand-scan failure reproduces on pristine canonical
`3c671f1150`: collection registers all 31 original rows; an explicit
name-pattern body selects exactly the failing row, which fails with the
same missing-function assertion, while 30 unselected rows are reported
as skipped rather than qualified. JSON/IPC identities and statuses agree,
all 15,886 baseline custody inputs remain unchanged and no IPC errors occur.
The baseline clean-status serialization bootstrap receipt is preserved.
The actual demand implementation is `src/ir/program/runtime-demands.ts`,
which integration.ts imports; all three baseline source/test bytes match
canonical main.

After that executed attribution, root authorized only a reader-location
correction: the existing marker slice helper gains an optional source path
defaulting to integration.ts, and only the demand-scan call passes the
actual canonical runtime-demands.ts owner. Every marker/refusal assertion
and positive/negative producer assertion remains unchanged. No provider,
runtime, source-map, C1 authority, proof or budget file changes. The prior
full 615/27/1 receipt is retained; corrected-file qualification is a separate
test-only epoch, not a claimed single all-green 643 run.

## Resolved obligations across explicitly separate epochs

The corrected character-code file runs its full original 31-row population
without a name filter: 31 pass, exit 0, no skips, exact JSON/IPC identities
and statuses, no IPC errors and all 15,905 custody inputs plus Git state
unchanged. All 110 assertion texts remain byte-identical. This resolves the
last of the 27 failed obligations from the original full body.

Evidence remains explicitly separate: original 643 registrations yielded
615 pass / 27 fail / one original skip; the environment-only relocation
epoch yields 27 pass / one original skip; the corrected reader epoch yields
31 pass. Removing the two affected original files leaves 584 unchanged
passing rows. Combining those 584 with the 27 and 31 current affected-file
passes accounts for exactly 642 active identities, plus the one original
skip. This is an identity-preserving obligation union, not a fabricated
single all-green 643 run. Full per-row epoch provenance is recorded in
`.tmp/string-independent-architecture-20261007/obligation-resolution.json`.
The original failures, baseline reproduction and stopped tooling receipts
remain preserved.

Root approved normal full-hook signed commit preparation after this bounded
qualification. Fork publication and a ready PR remain pending root's review
of the exact commit, hook receipt and six-path diff. The task stays
in-progress and claimed until main delivery is verified.

Final source TypeScript 7 and new focused-test TypeScript 7 pass. The existing
character-code suite also has four old test-inclusive typing diagnostics
at lines 198/280/354/502, all before the reader edit; actual TS7 on pristine
canonical main reproduces the exact diagnostic bytes. Alongside the three
old cycle-test diagnostics, these are disclosed baseline typing errors,
not repaired assertions or a waiver of production typing. Final lint,
formatting, dialect, pushRaw and both changed-file budget gates pass.
