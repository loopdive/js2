---
id: 6914
title: "Linear IR array-forwarding runtime provider: cohesive body and exact preservation"
status: in-progress
created: 2026-10-07
updated: 2026-10-07
priority: high
task_type: refactor
area: ir, codegen-linear
goal: ir-full-coverage
model: gpt-6-astra
reasoning_effort: high
related: [3526, 3528, 6893, 6897, 6896, 6911]
---

## Objective and truthful boundary

Keep the existing, actually used Linear IR array-forwarding provider in a
cohesive target runtime module. Consume A's published forwarding layout and
defined-helper contract unchanged. Deliver implementation and regression tests,
including actual compiler callers and native custody, not an unused adapter.
This is architectural provider work; it does not add frontend/source-array
admission, prove whole-program equality, or permit legacy retirement.

## Frozen baseline and ownership

Canonical main:3146af9a349bb20a5a398fba37e8b69b16fb4ab9.
Issue reservation6914 and planning slice `6914:linear-forwarding-provider-plan-20261007`
are unique canonical upstream claims. Plan owner:
`ttraenkler/codex-linear-b-forwarding-astra-20261007`.

Proposed production scope for Session B only:

- `src/codegen-linear/runtime.ts`: import and the body factory in private
  `ensureArrayResolveRuntime`, leaving its registration/idempotence/ABI unchanged.
- New `src/codegen-linear/runtime/arrays/forwarding-resolver.ts` pure instruction
  builder, and at most its target-local README.
- New owned regression test; this issue and its own evidence/handoff.

Do not touch `__arr_new`/`__arr_grow` (active6896 source claim), vec initializer
(6905), string slice(6899), charCodeAt(6911), shared compiler/entry/registry,
preparation/provenance/physical emitters, or source-map files. Open runtime PRs
were inspected by function scope, not just file names.6896 source commit
b749becb4b4e44c5722b742de0dfd83cf7f0a04e changes only allocation/growth callbacks
and its helper import, not the resolver. A6897 uses the existing runtime resolver
and changes shared read emission, not its runtime body. No active claim is taken.

## Implementation Plan

### Current-source grounding and release gate

This is a source-derived specification, not a measured candidate. At the pinned
main the provider remains inline at `runtime.ts:797–825`; the proposed leaf does
not exist. Parent reports claims tip037767 and inspected runtime PR6572/6575/6577/
6583 scopes as disjoint. Parent must retain the pending planning-claim effect
receipt and acquire/verify each exact source/test slice before dispatch; this
document does not claim those implementation reservations already exist.

Read [target architecture](../../docs/architecture/target-architecture.md): generic
semantics/contracts precede target representation; one authoritative algorithm,
cohesive subfolders, no speculative backend interface. No optimizer, DCE or
inlining work belongs here. The leaf emits an existing target body, not a generic
forwarding policy or another allocator. Its real caller must delegate immediately.

Actual dependency chain, retained without edits:

- `addArrayRuntime:848` and `addUint8ArrayRuntime:532` call private
  `ensureArrayResolveRuntime`. Registration is defined-function-name idempotent;
  `addRuntimeFunc:4239` owns the function/type insertion and callback invocation.
- `__arr_get`, `__arr_set`, `__arr_push` and `__u8arr_from_arr:728` already call
  the defined resolver. `findFuncIndex:4225` counts function imports only.
- Published [6897 — Linear IR vector reads: resolve relocated array headers
  before length and payload access](6897-linear-ir-vector-read-forwarding.md)
  is present: `LinearEmitter.emitVecLen:249` and `emitVecDataPtr:263` request the
  closed `{ family: "vector", operation: "resolve-forwarding" }` contract.
  `linear-integration.ts` demands it for vec.len/get/set/forof.vec, preflights
  before frozen-body consumption, and `resolveLinearRuntimeOperation:2237`
  binds the actual defined `(i32)->i32` helper plus function-import offset.
  No loop is copied into that emitter, no namesake import becomes authority.
- These are real compiler-owned prepared/frozen IR read callers. They are NOT
  proof that the source-free whole-program PreparedIR allocation/materialization
  gap in issue3528 is closed. Source scalar-return examples below retain actual
  owner/consumer evidence; no claim of new frontend array or array-return admission.
  The separate B6893 C ABI repair is not installed by this extraction.

### Exact disjoint writer scopes

K, Sol6.1 source: only `src/codegen-linear/runtime.ts` (one new import and the
body callback of private `ensureArrayResolveRuntime`) and new
`src/codegen-linear/runtime/arrays/forwarding-resolver.ts`. Export
`buildArrayForwardingResolverBody(forwarding: Readonly<{ tag: number;
tagOffset: number; pointerOffset: number }>): Instr[]`. This small structural
argument contains only the three existing concrete instruction operands; it is
not a new runtime schema, metadata record or proof authority. It needs NO module,
callback, function index, scratch index, reservation, allocator or frontend argument.
Parameter local0 is the existing fixed ABI; there are no scratch locals.

Import `Instr` directly as a type from `../../../wasm/model/instructions.js`
(canonical export at line368), not `ir/types` or another compatibility barrel.
The leaf imports no layout barrel. Its authentic registration caller passes the
SAME frozen `LINEAR_ARRAY_FORWARDING` object, already imported by runtime.ts from
`../ir/analysis/linear-memory-plan.js` (actual definition lines82–87, NOT exported
from contracts/linear-memory-layout). Structural typing accepts its extra
pointerBytes field without widening this factory's input. One named-fields object
is clearer than three positional numbers and avoids transposed tag/pointer offsets.
Read its scalar fields while constructing instructions; never retain/mutate the
object or embed it in the emitted tree. No defaults, magic-number copies, new
validation, configuration registry or shared constant move/export. Keep root's
other imports intact: it still uses the forwarding constant when growing arrays.

T, independent Sol6.1 test: only new
`tests/issue-6914-linear-ir-array-forwarding-provider-body.test.ts`.
Parent alone owns evidence and optional new
`src/codegen-linear/runtime/arrays/README.md` for R-OWN: target body generation,
canonical Wasm model types and caller-supplied layout data, fresh objects, no registration/module
mutation/frontend imports. Do not edit root runtime/README.md (6911 ownership).
If that parent README is absent at this baseline, coordinate its existing owner;
do not manufacture a replacement or expand K's scope to satisfy a docs gate.

Excluded: all other runtime functions, addRuntime/heap/linked chunks (foreign
4540 — Heap coexistence in one linear memory: relocate the bump arena above the
engine’s heap base, passive data segments only), active6896 new/grow,6905 vector
initializer,6899 slice,6911 charCodeAt,6897 shared readers and every A entry,
integration, preparation, emitter, source-map and registry file. No ABI changes.

### Exact body and registration preservation

Move the sole existing array expression into the builder, using the three supplied
fields at precisely the existing operand positions. Delegate with
`() => buildArrayForwardingResolverBody(LINEAR_ARRAY_FORWARDING)` from the
existing callback position, preserving the guard, name `__arr_resolve`, `(i32)->i32`,
empty local list, type name, non-exported state, registration order and callback
timing. Do not export the private registration function or change addRuntimeFunc.
Preserve precisely this nested instruction tree and all operands:

```text
block empty
  loop empty
    local.get 0
    i32.load8_u align=0 offset=LINEAR_ARRAY_FORWARDING.tagOffset
    i32.const LINEAR_ARRAY_FORWARDING.tag
    i32.ne
    br_if 1
    local.get 0
    i32.load align=2 offset=LINEAR_ARRAY_FORWARDING.pointerOffset
    local.set 0
    br 0
local.get 0
```

Canonical current values are tag6, tagOffset0, pointerOffset4, pointerBytes4.
The complete tree contains12 instructions, including block/loop nodes; each
iteration's conditional break leaves no value, and the final get returns i32.
Return fresh top-level/nested arrays, instruction objects and both empty block
type objects on every call; share no mutable nodes within or across bodies.
No precomputed body constant or shallow copy. No stores, calls, path compression,
allocation, validation, cycle detection or changed null/malformed-pointer behavior.
Zero-hop means a genuine current array header, NOT address zero. Exercise only
well-formed bounded chains generated by production runtime operations.

### Finite new test population: 13 cases, identical on both arms

Use existing public/runtime APIs, never import the new leaf in the paired test:
the SAME bytes must execute on pristine main where that leaf does not exist.
Test its actual installed body through addArrayRuntime/addUint8ArrayRuntime;
static review checks the sole callback delegates to the new builder.

Four compiler cases:

1. `source-alias31`: copy the exact aliasScalar31 source from the published
   `tests/issue-6893-linear-ir-read-forwarding.test.ts` originalObligations;
   `target:linear, abi:c, optimize:false`, `JS2WASM_LINEAR_IR=1`, native3.75.
2. `source-push31`: exact existing pushed-values fixture, only `target:linear`
   defaults and original whitespace, native69.
3. `source-alias-push21`: exact existing alias-growth fixture, same original
   default options, native40. Restore environment between cases, not global flags.
4. `source-import-custody`: reuse that suite's final generateLinearModule /
   analyzeSource fixture, source `export function test(): number { const a=[1.5];
   a[31]=3.75; return a[31]; }`, unchanged options with preceding `probe.unused`
   and `(i32)->i32` `probe.__arr_resolve` imports. Native3.75, namesake calls0.

For every compiler case, call real compilation, not hand-authored IR or a replaced
consumer. Use call-through capture at the existing addArrayRuntime and
consumeFrozenIrBodyBatchWithFactories seams, as in the published suite; preserve
arguments, receiver, return/errors and restore spies. Require nonzero actual
consumption, current IR function unitId joined to compiled ownerEvidence and
report.funcs, and real defined resolver call(s) in that owner's physical body.
Record installed helper/type/index and final valid binary. A global report getter
alone is insufficient attribution. Do not infer successful source-array admission
from a runtime-built module or change a failing fixture to obtain it.

Nine runtime/structural cases:

5–7. `resolve-zero-hop`, `resolve-one-hop`, `resolve-three-hop`: real addRuntime +
addArrayRuntime, create cap4, initialize `[1.5,-2.25]` through __arr_set. Produce
exactly0/1/3 relocations using real __arr_grow(current,currentCapacity+1), observing
each new header and canonical tag/link. Export actual helpers with real import
counts. Call resolver on oldest, intermediate and current pointers repeatedly;
require current-header identity, preserved f64 payload/length, all header links,
full-memory equality and allocator-used equality around read-only calls. Allocate
an adjacent sentinel before snapshots. No fabricated headers or huge allocations.
8. `legacy-u8-forwarded`: real __u8arr_from_arr on a genuinely grown dense byte
array `[1,2,255]`, observe exact output bytes/length and unchanged source chain.
Its destination allocation/writes are expected: do NOT claim whole-memory or
allocator invariance for this allocating conversion.
9–10. `registration-array-first`, `registration-u8-first`: register both builders
in each order and repeat. Exactly one defined resolver and its associated type;
same resolver slot/body/type identity after repeats. Other builder functions are
not promised idempotent; do not require whole-module counts to remain constant.
11. `installed-exact-body-abi`: compare the full installed instruction tree above,
all branch depths/offsets/alignments, function/type names, signature, no locals,
non-exported flag. A load opcode count alone is insufficient.
12. `import-offset-artifact`: preceding two function imports plus a table import,
one function named __arr_resolve; genuine defined helper is separately exported
using function-import count. Execute real chain, host namesake/decoy calls0;
retain exact body/ABI/module tables and full binary for baseline/candidate equality.
13. `fresh-object-custody`: independently build two equal runtime modules; all
resolver arrays/instructions/blockTypes have disjoint identities, with no internal
aliases. Mutate a nested instruction/blockType in one disposable module and prove
the other's body and emitted bytes unchanged; a third registration builds clean
original objects. Do not emit or use the deliberately corrupted module as evidence.

Keep common module construction/observations cohesive within this one test file.
Use cast-free ArrayBuffer-backed byte copies at WebAssembly APIs, no broad any or
TS exclusions. Preserve original assertions/fixtures in all existing suites.

### Paired evidence, gates and acceptance

Parent serializes every heavy run after its current C ABI build ends. First freeze
new-test bytes, then run identical baseline3146af9 and exact candidate with only
the two authorized production paths changed. Record full commits, dirty/input
hashes, test SHA, Node/V8, flags/options, command/deadline, stdout/stderr and exit.
One provenance record plus13 named case witnesses =14 structured records per arm;
require all13 collected/completed/passing, no skips/it.fails or missing witnesses.
Each witness includes full relevant instruction/ABI/binaryBase64/native/custody
observations, not just hashes or booleans. Exclude only enumerated provenance
fields from exact arm equality. Require byte-identical complete binaries, helper
trees, module ordering and semantic observations; this extraction has no intended
runtime or artifact delta. Observers must not mutate real production artifacts.

Existing companion population, unchanged: forwarding suite30 and issue1977 suite8
(38 total, collection verified before interpretation). Preserve A's original
3.75/69/40 and all missing-helper/wrong-ABI/import-only preflight negatives; do not
edit A tests. Historical30/30 and8/8 are not measurements of this new epoch.
Record all fresh failures and compare full diagnostics on identical baseline;
no test repair or broader scope follows automatically. New13 plus unchanged38
give a finite51-case qualification, not whole-compiler or C ABI98 qualification.

Pinned source SHA-256 at authoring:
- runtime.ts: `2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f`.
- linear-memory-plan.ts: `5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52`.
- forwarding test: `01d3d64c885888e3cf80b33295bfcd43d37520e64c78a2e2daa94da6db979cf9`.
- issue1977 test: `2131321ce2694abac729cdc3f508db53d1ee8d487e64d5ab7248cfcf8bd4e13c`.

Require strict new-test-inclusive TS7 and source typing, scoped format/lint, normal
build/architecture checks and actual changed-file/function budgets. Root runtime
is over-limit and must shrink; no allowance is currently justified for moving this
small body. Preserve all inherited failures and diagnose against the same base,
never borrow another issue's grant or weaken configuration. Parent reviews exact
two-source diff and paired evidence before publication; A owns final queue landing.
No performance claim, new IR coverage, frontend allocation release or retirement.

## Narrow test typing repair — 2026-10-07

Parent reports the original paired51 cases passed with exact13 observation rows,
16 binaries and10 memory observations. Preserve that epoch, original test commit
`da6d5ceed9bceb02c648a09801f5d186421db228`, test bytes/hash and all raw evidence.
Candidate strict test-inclusive TS7 exited1: TS2339 at new-test lines622 and629,
because `TypeDef.name` is not present on `RecGroupDef`. Parent subsequently
confirmed baseline strict at da6d5 also exited1, with both complete diagnostics
identical to candidate06533320 and no source errors. Both failures are preserved;
this does not establish repaired qualification.

Actual canonical `src/wasm/model/module-records.ts:5–37` defines TypeDef as
FuncTypeDef | StructTypeDef | ArrayTypeDef | RecGroupDef | SubTypeDef. Only the
`kind: "rec"` arm lacks name; function name is optional, and the other three
non-rec arms require it. No shared model change is needed or authorized.

After parent confirms the test writer's exact scope, repair ONLY two expressions
inside `registration` in
`tests/issue-6914-linear-ir-array-forwarding-provider-body.test.ts`:

1. `typeNames`: use
   `module.types.map((entry) => entry.kind === "rec" ? null : entry.name ?? null)`.
   Preserve one output per type and its order; recursive groups and unnamed
   functions still produce null. Do not flatten groups or drop unnamed entries.
2. Resolver-type count: use
   `module.types.filter((entry) => entry.kind !== "rec" && entry.name === "$type___arr_resolve")`.
   Keep the existing `.toHaveLength(1)` assertion exactly. Do not narrow to only
   function types, which would weaken the original all-named-types count.

Use discriminant narrowing only: no casts, any, suppressions, helper/schema,
configuration changes or new fixtures. All remaining assertions, consumer/owner
joins, imports, source strings, flags, ABI, binaries and evidence fields stay intact.
This is test typing, not production behavior or additional IR coverage.

Parent retains both original strict failures, then freezes identical
repaired test bytes in both exact production arms. Require unchanged strict TS7
to pass both; archive new logs beside the original failures. Rerun the unchanged
13+38=51 population in both arms with zero skips; require every case identity and
status, all13 complete observation rows,16 binaries and10 memory observations to
equal the original passing epoch within each arm and across arms. Exclude only
explicitly enumerated provenance changes (test hash/revision), never typeNames,
resolver counts, route, body, byte or memory data. Preserve all unexpected failures
and stop for parent review rather than widen scope. Normal scoped gates and A's
integration authority remain; no acceptance or queue release is implied here.

## Session B implementation checkpoint and handoff

Branch: `codex/6914-linear-forwarding-provider-20261007`.
Canonical remote: upstream, `loopdive/js2`. No queue submission is delegated.
Source execution HEAD: `06533320a4a1a47414d953a6f1656eabb05d6ad6`;
test-only main execution HEAD: `da6d5ceed9bceb02c648a09801f5d186421db228`.
Source source-writer commit: `f8d931b5ede5964ae1a536a16fa16a8ea1ed5431`.
Reviewed two-site typing repair integrated at `fab503f4ae`; current repaired
test hash `59ccfd57937a8d5a15635e746247e83b714b60abebffab4853010bc22dd01a23`.

Canonical claims use unique owners and exact keys:

- Plan: `6914:linear-forwarding-provider-plan-20261007`, owner
  `ttraenkler/codex-linear-b-forwarding-astra-20261007`.
- Source: `6914:linear-forwarding-provider-source-20261007`, owner
  `ttraenkler/codex-linear-b-forwarding-sol61-20261007`.
- Tests: `6914:linear-forwarding-provider-tests-20261007`, owner
  `ttraenkler/codex-linear-b-forwarding-tests-sol61-20261007`.
- Evidence: `6914:linear-forwarding-provider-evidence-20261007`, owner
  `ttraenkler/codex-linear-b-forwarding-evidence-20261007`.

Exact source ownership is the private resolver callback/import and new target
leaf only; the new arrays README, new test, this issue and own evidence are B's
documentation/test scope. No active shared/other-provider claim was taken.
All source/test writers are frozen. Shared compiler entry points, frontend,
preparation/provenance, physical emitters and source-map files remain A's.

Original-instrument qualification:51/51 on both arms, zero skips, all13 complete
observation rows equal,16 complete validated binary witnesses and10 full-memory
witnesses per arm equal. Both original strict TS7 runs exit1 with the exact same
two test-only TS2339 diagnostics. Original tests, complete logs, complete JSON
case reports and a replayable exact comparator are preserved under
`plan/log/6914-linear-forwarding-20261007`. They are not erased by the repair.

The first normal push passed source typecheck, lint, formatting, oracle/coercion
ratchets,18 numeric parity tests and issue integrity, but GitHub rejected it for
one missing390-byte LFS diagnostic object. That exact object was uploaded using
its verified object ID; no broad LFS upload, filter/hook bypass or rewrite.
Retry and remote/PR HEAD verification remain required. Repaired strict typing
is running; repaired paired runtime comparison, current3146 build and architecture
checks remain unproven. Keep the PR non-draft HOLD; A owns integration acceptance
and protected queue landing. No new frontend coverage or retirement is claimed.
