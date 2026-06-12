---
id: 1899
title: "finalize funcIdx-authority contract: reconcile↔dead-elim native-string helper sibling-call mismatch (late-shift class recurrence-proofing)"
status: ready
updated: 2026-06-12
sprint: 62
created: 2026-06-05
priority: medium
feasibility: hard
task_type: refactor
area: codegen
goal: standalone-mode
related: [329, 1677, 1809, 1839, 1886, 1891, 1257, 1888, 1209]
---
# #1899 — finalize funcIdx-authority contract (recurring late-shift class kill)

**Architect input from sd-1472c's #329 trace. The architect ratifies the
finalize funcIdx-authority contract; a senior-dev then implements (B) off it.
Do NOT blind-implement — high blast radius (35 bake sites, every standalone/WASI
string program). One careful change, not a guess.**

## The recurring class (5th occurrence)
A defined-function `call <funcIdx>` baked **mid-finalize** goes stale when
finalize-time imports are added (and/or later removed), because the index space
shifts under the already-baked call. Prior occurrences: #1677, #1809, #1839,
#1886, #1891 (and the @@toPrimitive/#118 trigger), now #329. Each was patched
point-wise; this issue ratifies the *contract* so it stops recurring.

## Keystone (why it's worth a contract, not another point-fix)
The SAME reconcile↔dead-elim funcIdx mismatch blocks three in-flight workstreams:
- **#329** — `__str_flatten`→`__str_copy_tree` (native-string sibling call).
- **#1888 S2** — `__apply_closure` baked calls into `__call_fn_method_N`.
- **#1888 Slice 5 (live)** — accessor `__call_fn_method_N` baked calls.
Fix the authority once → unblocks all three.

## Trace / evidence (sd-1472c, --target standalone, instrumented)
Repro: `let g: any; g = function () { return 42; }; export function test(): number { return g(); }`
fails validation: `__str_flatten ... call[0] expected (ref null 5), found i32.const`.
(`const f:any=fn` / `let f:any=fn` initializer forms are already valid.)

`reconcileNativeStrFinalizeShift` (late-imports.ts:355) firings
`(base, numImportFuncs, added)`:
- INIT (valid):   `(0,1,+1)`, `(1,1,0)`
- ASSIGN (broken): `(0,1,+1)`, `(1,1,0)`, **`(1,2,+1)`** ← extra

The extra 3rd firing is triggered by `env::__get_undefined` (the `let g`
undefined-init host import) landing at import idx 1 AFTER the native-string
helpers were emitted mid-finalize.

## Why the current design mis-handles it
- `reconcileNativeStrFinalizeShift` runs **incrementally** and **re-bases**
  `nativeStrHelperImportBase = numImportFuncs` each call, shifting helper-map
  entries + helper-body sibling-calls UP by the per-call delta. It assumes
  imports are **monotonic** (only added).
- It is called at 5 points (index.ts:1050/1111/4308/4336/7886) **interleaved
  with body compilation** — bodies emitted between calls bake `call <helper>`
  reading the CURRENT (already-shifted) helper index. So the incremental shift
  is **load-bearing**: a single end-of-finalize shift would break every body
  emitted before the final import settles. (Option A is therefore NOT a small
  change — see below.)
- `eliminateDeadImports` (dead-elimination.ts:221, called index.ts:1504/4496)
  can later **REMOVE** a now-dead finalize import and remap all call targets —
  the add-then-remove churn the incremental monotonic reconcile cannot model.
  The cumulative incremental deltas then disagree with the FINAL import count →
  the baked sibling call is off-by-one.

## Options
- **(A) compute the shift ONCE from FINAL numImportFuncs vs original base.**
  Net-zero for the monotonic case, correct for churn — BUT it fights the
  load-bearing mid-stream incremental requirement (bodies emitted before the
  final count need correct indices at their emit time). Not feasible as a small
  change without restructuring when bodies are emitted vs when imports settle.
- **(B) RECOMMENDED — post-dead-elim by-name re-resolution as the authority.**
  After ALL finalize import churn (the last reconcile AND `eliminateDeadImports`)
  settles, run one final pass that re-points every finalize-emitted helper body's
  sibling-helper `call` to the authoritative `nativeStrHelpers.get(<name>)`
  (and `funcMap.get(<name>)` for the broader set). Requires anchoring each
  sibling call to a NAME, since `{op:"call",funcIdx}` carries no name today.
  Two sub-approaches for the contract to choose:
  - (B1) tag each helper sibling-call with `helperName` at the ~35 emit sites
    (flatten→copyTree, slice→substring, includes→indexOf, trim→isWhitespace+
    substring, padStart→concat+repeat+substring, repeat→concat, …), then the
    final pass re-points by tag. Most explicit; touches 35 sites.
  - (B2) build a stale-index→name reverse map snapshotted at each helper
    registration, and re-point in the final pass. No emit-site changes; one
    central map. Prefer if the contract finds it sound.

## Contract questions for the architect
1. Who OWNS finalize-emitted helper call-target resolution — reconcile (shift),
   dead-elim (remap), or a final by-name authority pass? (Recommend: a final
   by-name pass is the single source of truth; reconcile/dead-elim become
   index-bookkeeping that the final pass overrides for helper sibling-calls.)
2. Scope: native-string helpers only, or all finalize-emitted defined funcs
   (so it also covers `__call_fn_method_N` for #1888 S2 + Slice 5)?
3. B1 (tag at emit) vs B2 (central reverse map) — ratify one.
4. Interaction with `flushLateImportShifts` (compilation-phase path) — confirm
   the final pass doesn't double-shift compilation-phase baked calls.

## Already landed (independent, keep)
PR #1225 (#329 targeted fix): under `ctx.nativeStrings`, `ensureGetUndefined`
returns undefined → callers use the native `ref.null.extern` sentinel instead of
the `env::__get_undefined` host import. Removes THIS trigger + fixes a real
standalone/wasi host-import leak. Regression test:
`tests/issue-329-assign-closure-lateshift.test.ts`. #1899 is the durable
class-level kill on top; #1225 does not block it.

## Net / detection
#1209's `validateFuncRefs` (src/emit/binary.ts, env-gated) only catches
OUT-OF-RANGE/-1 funcIdx, NOT this IN-RANGE-but-wrong-target case. The #1899 fix
is the real prevention; consider extending the guard to flag helper sibling-calls
whose target name≠expected once the by-name authority exists.

## Resilience
Full context also in `plan/agent-context/sd-1472c-329.md`.
