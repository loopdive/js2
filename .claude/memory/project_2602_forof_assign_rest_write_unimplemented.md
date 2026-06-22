---
name: project_2602_forof_assign_rest_write_unimplemented
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

#2602 (blocks #2580 M2 slice 1): `for ([x, ...y] of [[1,2,3]])` —
ASSIGNMENT-destructuring loop head where targets are pre-declared — **never writes
the rest slice `[2,3]` to `y`**. Root cause in `src/codegen/statements/loops.ts`:
the per-element loops in the for-of assignment-destructuring paths `continue` on
`ts.isSpreadElement` (`compileForOfAssignDestructuringExternref` ~line 2144, and
~line 3741); the tuple/vec assignment paths don't handle spread at all. So `...y`
is never PutValue'd (spec §13.15.5.5 ArrayAssignmentPattern rest step). `y` is a
pre-declared global in the test shape (`localMap.get('y')` is `undefined` at the
read site), so it keeps a stale/source value.

**Latent on main** — the 8 `for-await-of/async-*-dstr-array-rest-*` test262 files
PASS because nothing currently re-reads `y` to surface the missing write. The
**#2580 `.length`-on-any reader EXPOSED it**: it recompiles the `y` identifier and
reads the SOURCE array (length 3), not the rest slice (length 2). Diagnostic at
the reader site: `[2602] .length on 'y' localMap=undefined`.

**Scope (the corrections that matter):**
- NOT async-specific — the SYNC `for ([x,...y] of …)` ALSO fails under the reader
  (faithful `runTest262File`). It is the for-of/for-await ASSIGNMENT-destructuring
  rest path in general.
- BINDING destructuring (`const [a, ...rest] = …`) and string-rest DO handle rest
  (via `__extern_slice` → `local.set restIdx`, loops.ts ~1375, destructuring.ts
  ~1253). The gap is specifically the **assignment** form in the for-of head.
- The earlier "async-state-machine local-versioning" framing (memory
  `project_2602_forawait_rest_aliases_source_recompile`) was the *symptom*; the
  *root cause* is the unimplemented rest-assignment write — the recompile reads a
  global that was never updated, not an SSA alias.

**NOT a bounded canonical-local fix** (tech-lead STOP-AND-FLAG guard fired):
implementing the rest ASSIGNMENT write means computing the rest slice and
PutValue-ing it across 2–3 distinct for-of destructuring paths (externref / tuple
/ vec), each with its own element loop, to a general LHS target (identifier local
OR global, property access, element access — per the #1258 LHS generality already
in the externref path), intersecting sync AND the async state machine. Spec
§13.15.5.5 rest-step work → flagged for a destructuring/async specialist (related
#1373b IR async CPS, #2574 array-destructure-default).

Root cause + fix direction are in the issue file
(`plan/issues/2602-forof-assign-rest-element-write-skipped.md`, branch
`issue-2602-forawait-rest`, commit 49d90fde4). Validate any fix via the faithful
`runTest262File` on the 8 for-await + sync for-of array-rest tests + the #2580
slice-1 reader re-enabled. See [[project_2580_m1a_length_reftest_dispatch]].
