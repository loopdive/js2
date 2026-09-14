# Native Wasm foundation: integration evidence and next handoff

Issue 3518 remains open. This extraction moves the canonical instruction model,
function-handle primitives and native microtask queue builders into their owning
folders. Real scheduler/function-space/emitter consumers use those modules;
old paths preserve the same types/function objects through one-way re-exports.
No queue algorithm, allocator ownership, runtime behavior or public compiler
dispatch is changed. The remaining Wasm module/compiler metadata split and
module-authenticated physical resources are not complete.

## Exact candidate and retained validation

Parent composition: `codex/3518-native-foundation-checkpoint-20260907`, based on
`a877767aa16406e945ce9fed0742fb1907ec18f2` (published F0 in ready PR 5733).
The ten N1 files were copied from Maxwell's completed native-subagent draft;
the original checkout is preserved. The parent owns policy, composition,
verification and ready-PR publication. No dirty root edits were adopted.

The following results apply to the uncommitted N1 source at that base:

- Five-file regression set: **34/34 passed**, covering the new foundation,
  existing native queue execution/fresh-process isolation, issue 1326c drain
  integration, issue 1916 function handles and issue 2918 Promise import shifts.
- Normal repository typecheck: **exit 0** on 2026-09-08.
- D0 detector's positive/negative controls: **42/42 passed** on this composition,
  including type-only/barrel/symlink edges, activation history and all ten held
  B findings. Default complete mode returned **exit 1** as required, with a
  valid inventory and incomplete architecture; this is an expected refusal,
  not a passing full-separation check.
- Independent declaration comparison: all **11 moved model declarations**,
  **21 remaining declarations**, both physical primitives and all queue bodies
  preserve their original contents, apart from the intended imports/exports.
- D0 inventory: **valid**, **1244 modules** (1241 tracked, three new untracked
  source modules at this measurement), **9748 resolved edges** (2484 type-only,
  7264 runtime), **four unknown**, zero unresolved, zero inventory errors.
  Six clean modules comprise three F0 contracts and the three new N1 leaves.
  Architecture remains incomplete; inventory success is not full separation.

Inventory policy hash:
`92c3ac1be4404b95dbfd5196c10e30ce7481265921dd92e3cd130352dc8ccfb9`.
Independent comparison policy at F0:
`4532bda64f372a691a25306d6d1f7ae06614bc79d8715e49cf36388d9a9c3b37`.
Dirty-content fingerprint:
`6f679352ecd377c176085af851ab6e86bdc5eed8da9000f9f584f6ea48621f99`.
Later composed/committed validation must record its own provenance.

After these checks the unpublished parent checkpoint fast-forwarded normally
to d71. The only incoming files were six npm-compat benchmark JSONs; N1 source
edits and all three new-source blob hashes remained unchanged. This aligns
the ABI and N1 integration bases without pushing the queued foundation PR.

## Paired behavior-preserving comparison

Harness: local Node + tsx, unoptimized standalone/WASI WasmGC. The same script
uses direct queue registration and the public `compile` / instantiate route.
Baseline is clean `d71fab8b9565ad3a2bb567ed82f22e8750e804a4`; candidate is
F0 `a877767aa16406e945ce9fed0742fb1907ec18f2` plus the N1 source edits.
There is **no source diff** between those two base commits; d71 adds only the
main refresh's benchmark JSON files. This is not a CI comparison or an
optimization-on result.

Exact deep equality of the two retained evidence records passed, including
full binary byte strings (not only hash prefixes), WAT, imports, exports,
string pools, queue names/types/globals/function order and observed values:

- Queue: **10 types, six globals, three functions**, **508 bytes**, empty drain
  returns; SHA-256
  `d4c600a0bfee1f7e2f8d250182fc9c073023eced02299d7519b05e6901615a4d`.
- Assignment-form closure / late import, standalone: **52626 bytes**, value
  **42**; `6bad8c2477dab8d77a37efc3810fed57d174d798dcfa1dfd2ff5bc9bb1c72224`.
- Stable-handle / string-helper churn, standalone: **54614 bytes**, value
  **7**; `056a6fbe3712e659540321ab79744f67aa13b1e9844498036670bad8d3fd11ca`.
- Native Promise queue / late import, WASI: **110318 bytes**, value **1**,
  actual exported drain invoked; queue grow body present in WAT;
  `4281102f3b0171eaf993015d95a135c72191e5ec572a7d03036d2a022d4cab9c`.

All binaries validated and instantiated with **zero imports**. The queue
idempotence and explicit expected runtime values are positive controls. The
34-test cohort independently covers FIFO growth, capture identity, reentrant
growth and throw/resume. These fixtures do not establish full conformance.

Candidate new-source Git blob hashes:

- Native queue body: `8edee0e1a394848dd32f616635130f2f00810f87`.
- Wasm instruction model: `699c7b386f529b6017659a2f4b0f3c5671235969`.
- Physical function handles: `8b91e2391b574e75ee6db331ebaa5aaa9da5d436`.

Full local records and the harness are retained in the composition checkout's
`.tmp/n1-before.json`, `.tmp/n1-after.json`, `.tmp/n1-paired-evidence.mjs` and
`.tmp/n1-boundaries-inventory.json`. Permanent regression tests use explicit
fixtures; they never require historical Git objects in shallow CI.

## Gate and publication state at this handoff

Boyle's final structured-diagnostic audit passed **105/105 controls**: the
original **39** unchanged plus **66** additive approval/provenance controls.
Pre-relocation production retained six full/cut witnesses and the old 25/25
dead-export ratchet, with both nonliteral imports still strict failures.

Parent copied all four validated files byte-for-byte and explicitly wired
`check:dead-exports` to the user-approved
[two-verdict contract](./3518-open-import-preservation-contract-2026-09-08.md).
At parent base `20f45a778b95190dc2772fe52cf00f0d56ca07f7` plus this checkpoint,
the actual composed **preservation invocation exited 0**, and the raw
**strict invocation exited 1**. Both serialized evidence records are identical.
All **6/6 canonical targets** have full and dispatch-cut source witnesses,
with **14680 full** and **11603 cut** visited nodes. Both original unknowns
remain in each search; no unrecorded reachable diagnostic exists. The old
ratchet remains **25/25**, with zero additions/removals. Closure and retirement
certificates remain **false**. No optimizer/platform source was edited.

Admission now joins structured diagnostic IDs to exact receipts; human-readable
message grouping never controls the verdict. The original control file stays
`e8e7972e8ee2c18b4969f5958bdd5178bbabfd5e`; auditor
`0d78cb4cf73d08216b135f04664c88abe2122c60`, manifest
`6ca62ebb2427ae05d0d151988f8ae76c0ed8fe32`, additive controls
`a645327d265b9c84bbee85deb10fe29b39de9243` (Git blob hashes).
The first normal commit hook rejected the additive missing-certificate test's
`delete` syntax under the existing lint rule. Parent changed only that operation
to `Reflect.deleteProperty`, preserving actual property absence (not replacing
it with an undefined value); the delivered hash above identifies the original
worker evidence. Normal commit hooks rerun all changed test files on the fix.
Retained composed records: `.tmp/n1-composed-preservation.json` and
`.tmp/n1-composed-strict.json`; SHA-256 of either report is
`9f1b540379baaa9f8c006477599692021c14a75e6651d1d4ec0a4668b090caf6`.
Normal hooks and final committed validation are required before publication;
their actual results are recorded on the PR.

PR 5733 merged at `fa9e1ea0c7986b53f290e88822b262ab10ca62f4` on
2026-09-07 at 22:22:20 UTC. Parent fetched upstream/main and verified that the
published F0 head `a877767aa16406e945ce9fed0742fb1907ec18f2` is an ancestor;
the fetched merge and d71 have identical tracked content. Merge-group Test262
run 34165082130 finished successfully. Its regression gate used a cached
ancestor five commits behind the exact base; that CI result is not the exact
local A/B comparison recorded above. Parent never pushed the redundant d71
refresh into the queued foundation PR.

Maxwell's existing native Astra Low context is continuing the approved
seven-file ABI seam in `codex/3518-program-abi-seam-20260908`, isolated at d71.
Its claim was reconciled before writing. The isolated draft passed **59/59**
tests (20 new seam/boundary controls and 39 existing lifecycle controls) and
normal typecheck. The two existing source files matched the reviewed base;
none overlaps N1's source edits. Parent must still complete historical artifact
pairing, moved-symbol policy/gate integration and validation with N1 before
accepting that later extraction. The draft remains preserved, uncommitted.

The [lowering-cycle plan](./3518-lowering-cycle-plan-2026-09-08.md) records the
next bounded architectural proposal. It is not dispatched: fresh ownership
reconciliation and actual composed validation remain prerequisites.

## Advisory review reconciliation

The user's separate structural review used the older root checkout at e4c3e3c
with mixed local edits; its counts are not a census of this candidate.
Its identity-foundation finding is addressed by F0. Its physical-model finding
is partly addressed by N1; larger module metadata remains mixed. Its ABI
dependency finding is covered by the existing next-seam dispatch, not a new
competing task. The concrete lowerer/emitter cycle and orchestration/shared
analysis separation remain later work. Keep BackendEmitter/TypeConverter,
symbolic bindings, effect contracts and the checked ABI lifecycle; no replacement
framework or bare folder renaming is proposed.

Preserved P/C drafts, held B's ten unresolved functions and D's unchanged full
population remain outstanding. No checkpoint closes the eleven epic criteria,
certifies physical ownership, or turns internal prepared emission into a
public IR-only compiler route.
