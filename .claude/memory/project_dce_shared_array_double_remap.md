---
name: project_dce_shared_array_double_remap
description: "DCE remappers (remapFuncIdxInBody/remapTypeIdxInBody in dead-elimination.ts) double-apply a chained remap to an Instr[] shared across >1 tree position — the"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

`eliminateDeadImports` (src/codegen/dead-elimination.ts) removes a dead func
import and chains every funcIdx/typeIdx DOWN via `remapFuncIdxInBody` /
`remapTypeIdxInBody`, which drive `walkInstructions`. That walker visits an
instruction once **per occurrence** in the body tree (no visited-set). So when the
SAME `Instr[]`/`Instr` object is aliased into more than one position in a function
body, a mutate-in-place remapper applies the chained remap to it TWICE (e.g. 53→52
then 52→51) → the operand lands N slots off → invalid Wasm.

Concrete instance fixed 2026-06-20 (PR #1787 / #2520, the −84 standalone floor
breach): the native DataView setter's §24.2.1 bounds-RangeError template
(`rangeThrow` in `emitDataViewAccessor`, dataview-native.ts) is ONE `Instr[]`
spliced into BOTH the ToIndex `if.then` and the bounds `if.then`. When #1787's
host-import gating newly made an import dead (triggering the DCE remap), the shared
template's `call __new_RangeError` (externref ctor) was remapped twice → landed on
`__to_bigint` (i64-returning) → `throw[0] expected type externref, found call of
type i64` on 132/133 built-ins/DataView tests.

**Fix applied:** dedupe shared instruction objects in BOTH DCE remappers via a
`WeakSet<Instr>` (skip if already seen) so each operand is chain-remapped exactly
once. Fixes the class at the SINK.

**Why / history:** this is the documented **#1302** shared-array double-shift
hazard. It recurs because producers spread shared `Instr[]` consts into many
positions. Prior instances were worked around PRODUCER-side by never sharing:
`iterator-native.ts` `buildVecArm` (fresh arm per branch), `json-codec-native.ts`
`cloneBody` (JSON deep-clone, NOT structuredClone which preserves aliasing). NOTE:
a SEPARATE pass `fixupModuleGlobalIndices` has the same hazard for GLOBAL indices
(see the still-failing `tests/issue-1302.test.ts` "lodash flow.js" case on main) —
my sink fix covers the DCE func/type remap only, not that global-index pass.

**How to apply:** symptom = a standalone (or any) invalid-Wasm cluster where a
`call`/`struct.new`/`ref.cast` operand is off by a small N (often manifesting as a
wrong-type callee, e.g. an i64-returning helper where externref was expected), AND
the offending instruction sits in a template/helper `Instr[]` reused at multiple
body positions, AND a dead import was eliminated that run. Don't chase the
late-import shift first — check DCE remap + shared arrays. Related:
[[project_standalone_floor_only_on_merge_group]] (why it only failed on
merge_group), [[project_standalone_hostimport_gate_index_shift]] (the #1787
trigger), [[project_type_index_shift_and_deadelim]].
