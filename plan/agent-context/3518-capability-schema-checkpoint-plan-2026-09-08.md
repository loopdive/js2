# Capability schema checkpoint — Astra High implementation plan

Issue #3518, IR-only default and direct front-end retirement. This is a
dependency-cohesive extraction toward the approved standalone WasmGC folder
separation, not a new host implementation or retirement claim.

## Base, ownership and publication

Independent base: `16498efb481cb022ee5c4dcc9bb137b6d4c91a50` on
`loopdive/js2/main`. It does not incorporate held PRs #5738, #5739, #5741 or
#5742. Astra High reviewed the exact source map below; Astra Low native
workers implement the source and disjoint tests. The parent integrates,
validates and publishes a non-draft checkpoint PR with the inherited merge
hold. Green PR-head checks alone do not clear the N1/queue-safety hold.

Live ledger before dispatch: `abf49cbd1413db5be1ad5f13af0f570f85cb974b`,
814 held records. Historical capability claims remain recorded, not released:
`3526:a1` has merged PR #4983; `3526:f3s2` has merged PR #5504. The inspected
source includes their work. No open capability-schema PR was found. The
coordinator's suspended-session recovery authority applies; no old worktree
is resumed, modified, reset, or pruned by this extraction.

Fresh preserved drafts: P at `6037ac8bcf07be4f71839cea33cf8c90ecc87f94`
retains eight modified plus four untracked paths; C at
`9feb7bf8fc0f8fddccf87235c7664651eb338e92` retains two modified plus three
untracked paths. Neither set intersects the source/test paths below. Other
held runtime/producer claims retain their scope; no provider-selection or
resource-planning edits are included. Root main remains untouched.

Scoped dirty-content fingerprints (SHA-256 of the sorted JSON `{path,blob}`
list, where `blob` is Git's file-content hash) are
`ecb33cddf6a6d0049b5c6d4b8440a2d95415ae60bf7a108172c396dc62816494`
for P's twelve files and
`73665f99262a0bae9dac0b48e21c1cbd0c1ec247b39885fc087e826c2047e73f`
for C's five files. These are preservation receipts, not implementation
validation of those drafts.

## Exact source map

Old implementation: `src/ir/runtime-host-capabilities.ts`.
New canonical leaf: `src/runtime/contracts/host-capability-schema.ts`.
Move exactly **25 types/interfaces and 14 constants**, with zero imports
(including type imports) in the destination. Preserve declaration text and
attached documentation. The old path explicitly imports what it uses and
re-exports every moved public binding, without wrappers or copied tuples.

Types/interfaces prefixed `RuntimeHostCapability`:

```text
FuncId FuncFamilyId GlobalId ExportId Id ValueType
FuncModule GlobalModule Kind FieldScheme GlobalField FuncFamilyFieldScheme
ExportPublication HostSelectionEnvVar HostSelectionCondition HostSelection
FuncFamilyField FuncFamilyParams FuncRecord GlobalRecord FuncFamilyRecord
ExportRecord Record
```

Also move `HostCallbackExceptionPolicy` and
`ResolvedRuntimeHostCapabilityFuncFamilyRow`.

Constants prefixed `RUNTIME_HOST_CAPABILITY_`:

```text
FUNC_IDS FUNC_FAMILY_IDS GLOBAL_IDS EXPORT_IDS IDS
FUNC_MODULES GLOBAL_MODULES KINDS FIELD_SCHEMES FUNC_FAMILY_FIELD_SCHEMES
EXPORT_PUBLICATIONS HOST_SELECTION_ENV_VARS HOST_SELECTIONS
```

Also move `HOST_CALLBACK_EXCEPTION_POLICY`. Preserve all literal tuples,
ordering, aggregate-ID sorting, generic constraints/defaults, optional fields
and all four discriminated record arms. A synthesized family row remains
distinct from a canonical catalog record. Async-facing types remain narrowed
to `externref | i32`; no widening or new host/linear support is allowed.

**Stay unchanged in the old module:** every function; every private
constant/set/map; private factory options; `RUNTIME_HOST_CAPABILITY_RECORDS`;
`HOST_CALLBACK_WRAP_CAPABILITY_RECORD`. In particular, catalog construction,
guards, validators, canonicalizers, resolvers and authentication sets retain
one authority and the same object identities. No functions move, so existing
function-liveness populations cannot drop through this extraction.

## Worker split and parent acceptance

- Source worker owns only the two source paths and
  `tests/issue-3518-capability-schema-seam.test.ts` in its isolated worktree.
  Prove 25/14 census, old/new runtime identity, exact declaration preservation,
  generic/discriminant type compatibility and canonical-record rejection.
- Evidence worker owns only
  `tests/issue-3518-capability-schema-boundary.test.ts` in its isolated
  worktree. Use the existing compiler-boundary instrument with positive
  controls, required-file failure, type/runtime/re-export/transitive back
  edges, missing/nonliteral loading and malformed source controls.
- Parent owns `scripts/compiler-boundaries.json`, this plan and the issue
  handoff. Activate only this leaf in `runtime-contracts`, keeping its
  unfinished index/dependent contracts explicit. No allowed-edge widening,
  policy exemption, LOC/function budget baseline edit or denominator change.
  The old mixed implementation stays migration debt, not a clean facade.
- Serialize bounded tests at 2 GiB. Run the new controls and existing callable,
  string-schema, concat-family and async-provider controls; typecheck and
  normal commit/push hooks. Do not run local Test262 or a broad suite.
- Compare explicit base/candidate source revisions using actual public
  standalone WasmGC compilation, emitted bytes/imports/order and execution.
  Keep exact provider/catalog identity and no-host checks. Report measured
  denominators; do not extrapolate a bounded probe to full retirement.

## Next architectural obligation

This leaf lets subsequent manifest schemas name capability records without
importing catalog implementation. It does **not** permit IR core to import
runtime contracts. `IrFunction.asyncRuntime` still carries selected providers,
layouts and authenticated manifests; the semantic-function/prepared-attachment
split requires its own complete reader/mutator/pass/codec map. Preserve
`preparedManifestByPlan`, currentness, provider object/order identity and codec
reauthentication. Do not erase them with `unknown`, weaker attachments or
generic defaults that silently lose information. Full `core/nodes.ts`, pure
program preparation, standalone backend integration and direct retirement
remain open. Strict closure unknowns and all existing held evidence survive.

High's next connected map places semantic bodies/identities/`asyncPlan` in
core and the full prepared-function extension in program/runtime. Audit
verifier, program/runtime validation, component dependencies, body receipts,
physical planner and backend readers before that change. Preserve the
prepared-state provenance refusal guards in `inline-small`/`monomorphize`,
including nested functions and module copies. Runtime attachment creation,
`extern-support` body rewriting and vector-layout attachment are the writers.
Codec reauthentication must continue regenerating and checking runtime
projections while retaining persisted semantic IR; decoded clones are not
authenticated attachments. Attachment-preserving copies, stale/cloned/donor
rejection and codec parity are required. This map is not a dispatch of the
preserved P/C contracts.

## Validated implementation and frozen handoff

Astra Low's source blobs are
`22dcbfe8f87bfc8b1c58010feb67edcc264505a9` (old implementation),
`b6806719418d8e17e3b0498070502e231549eb05` (canonical schema) and
`85909364a5e6dfd4d560e59dc716e153dcd49336` (seam test). Parent copied
these exactly. The evidence worker supplied 49 controls; parent amended
only the core-edge assertion to accommodate #5742's separately approved
pure Wasm-model edge, never runtime-contracts. Final boundary-test blob:
`8d2892cf713b283531ec05326d24dda28b3776b7`.

Independent base/candidate AST comparison accounts for every declaration:
39 moved plus 48 retained, including all 28 functions; declaration text and
attached documentation match. Old source 1,237 -> 961 lines, new source
376 lines, net **+100 LOC** for the real canonical import/re-export seam.
No budget baseline or function allowance changed.

Validation on Node 22.23.2 with the serialized 2 GiB settings:

- Low seam 27/27 and typecheck pass. Parent final seam + boundary + existing
  D0 regression controls: 118/118. The six-file broader focused run was
  174/175; total distinct focused population is 217, with 216 passing and
  one pre-existing local failure, not 217/217.
- The existing concat-many async website fixture fails its old 10,021-byte
  pin on both untouched main and the candidate. Base file run: 32/33.
  Exact paired fixture outputs are equal: 10,122 bytes, SHA-256
  `9cc61132c3cea9c609e93fc3ec5fa85af99e7d17bca888eb457373d3c9fa3450`,
  28 function imports with `__concat_5` at index 22, seven IR outcomes and
  14 pool entries. The old test expects 27 imports/index 21. Its expectations
  remain unchanged; this proves no extraction delta, not a passing fixture
  or host execution. The original cause of the prior mismatch is not resolved.
- Three public standalone WasmGC programs (scalar/vector/closure) preserve
  complete bytes, WAT, descriptors/order, pool, IR outcomes and twice-executed
  values; all validate and instantiate with zero Wasm imports. Scalar yields
  85, vector/closure 42. Both complete async manifests (standalone/host)
  retain seven providers; their canonical host-record counts remain 0/7.
  All 32 catalog records match. The host comparison is preservation only.
- The complete 1,245-module inventory passes: seven clean, two compatibility
  adapters, 1,236 unmigrated; 9,751 resolved edges (2,485 type / 7,266 runtime),
  four recorded unknowns and zero inventory errors. Full architecture mode
  still exits 1. N1 preservation exits 0 with all six full/cut witnesses and
  the original 25-entry legacy baseline unchanged; strict mode still exits 1
  on the same two dynamic-import receipts. Retirement remains false.

Local reproduction receipts are in the parent's isolated `.tmp/` directory:
`capability-tests.json`, `capability-boundary-final-tests.json`,
`capability-concat-base-tests.json`, `capability-paired-{base,candidate}.json`,
`capability-host-async-{base,candidate}.json`, `capability-inventory.json`,
`capability-complete.json`, `capability-preservation-v1.json` and
`capability-strict.json`. Public probes use unoptimized `compile`,
`target: standalone`, `experimentalIR: true`, `trackIrOutcomes: true`.
The exact host failure uses the existing unit test's source/options.
No local Test262 or broad conformance run. Astra High reviewed source,
controls and both exact failing-fixture receipts and approved held publication.
