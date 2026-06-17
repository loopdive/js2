---
id: 1899
title: "finalize funcIdx-authority contract: reconcile↔dead-elim native-string helper sibling-call mismatch (late-shift class recurrence-proofing)"
status: ready
updated: 2026-06-12
sprint: 63
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

---

## Ratification (arch1, 2026-06-16 — against upstream/main 319d43460)

### Live-repro check: NO LIVE REPRO post-#1225
I compiled the exact #1899 repro and three sibling forms in `--target standalone`
on current main and **all compile AND validate cleanly**:

| Case | Result |
|---|---|
| `let g:any; g = function(){return 42;}; export function test(){ return g(); }` (the #1899 repro) | compile-ok, **VALIDATE OK** |
| `const f:any = function(){return 1;}; …` | compile-ok, VALIDATE OK |
| closure-assign + native-string `.slice` in the same fn | compile-ok, VALIDATE OK |
| native-string-helper-heavy (`+`, `.slice`, `.repeat`) | compile-ok, VALIDATE OK |

The `__str_flatten ... call[0] expected (ref null 5), found i32.const` validation
failure the issue documents **no longer reproduces**. PR #1225's
`ensureGetUndefined` fix (under `ctx.nativeStrings`, return the native
`ref.null.extern` sentinel instead of importing `env::__get_undefined`) removed
the *specific* late finalize-import that triggered the extra 3rd
`reconcileNativeStrFinalizeShift` firing. With that trigger gone, the
incremental-monotonic reconcile no longer disagrees with the final import count
for the cited repro.

### Contract questions — ratified answers

**Q1 — Who OWNS finalize-emitted helper call-target resolution?**
RATIFIED: a **final, post-all-churn, by-name authority pass** is the single
source of truth. `reconcileNativeStrFinalizeShift` (incremental shift) and
`eliminateDeadImports` (remap) remain index-bookkeeping, but for *finalize-emitted
helper sibling-calls* the final pass overrides them by re-pointing each such
`call` to `nativeStrHelpers.get(<name>)` / `funcMap.get(<name>)`. Rationale: the
recurring class is precisely that two independent bookkeeping mechanisms
(incremental add vs. churn-aware remove) cannot agree on an index; a single
name-anchored authority that runs *after both settle* is the only design that
cannot drift. Option (A) (compute-shift-once) is correctly rejected in the issue
— it fights the load-bearing mid-stream incremental requirement.

**Q2 — Scope: native-string helpers only, or all finalize-emitted defined funcs?**
RATIFIED: **all finalize-emitted defined funcs**, not just native-string helpers.
The same class blocks #1888 S2 (`__apply_closure`→`__call_fn_method_N`) and
#1888 Slice 5 (accessor `__call_fn_method_N`). A native-string-only authority
would leave those two to recur. The final pass keys off a registry of
`(emittedFuncName → funcIdx)` covering every finalize-time-defined helper, so one
mechanism kills all three workstreams' exposure.

**Q3 — B1 (tag at emit) vs B2 (central reverse map)?**
RATIFIED: **B2 — central reverse map**, snapshotted at each helper registration.
B1 touches ~35 emit sites (high diff surface, easy to miss a site, and each new
helper must remember to tag — the same forgot-a-site failure mode that produced
5 recurrences). B2 is one central map maintained where helpers are *registered*
(a single chokepoint), so a newly-added helper is covered automatically with no
per-emit-site discipline. The reverse map is `Map<staleFuncIdxAtBake, helperName>`
populated when a helper sibling-call is baked; the final pass walks every
finalize-emitted body and, for each `{op:"call", funcIdx}` whose `funcIdx` is in
the reverse map, re-points it to the authoritative current index for that name.
(Edge: a helper may be baked at several stale indices over the run — the map
value is the *name*, which is stable, so collisions resolve correctly.)

**Q4 — Interaction with `flushLateImportShifts` (compilation-phase path)?**
RATIFIED constraint: the final by-name pass must operate **only on
finalize-emitted helper bodies** (the native-string helpers + the enumerated
finalize-time defined funcs), identified by membership in the central registry —
NOT on compilation-phase bodies that `flushLateImportShifts` already correctly
shifted. Double-shifting is avoided because the final pass *overwrites by name*
(idempotent: re-pointing an already-correct call to the same authoritative index
is a no-op) rather than applying a delta. The implementer must assert the final
pass never touches a `call` whose funcIdx is not in the reverse map, so
compilation-phase calls are untouched even if they happen to alias a stale index
numerically.

### Disposition: RATIFIED design, recommend **defer (not wont-fix), de-prioritise**

- There is **no live failing repro** on current main, so this is **not
  dispatchable as a bugfix right now** — a senior-dev implementing (B2) would be
  refactoring against a class with no reproducing case, which violates the s63
  "verify-still-repros-then-fix" discipline and risks a high-blast-radius (35
  bake sites / every standalone string program) change with no failing test to
  anchor correctness.
- **Recommend: keep at `status: ready` but DROP from the s63 dispatch queue.**
  Re-activate (and dispatch (B2) to a senior-dev) the moment EITHER:
  (a) #1888 S2 or Slice 5 surfaces a concrete `expected (ref null N), found
  i32.const`-class validation failure during their own implementation (the
  issue's keystone claim — those are the live consumers), OR
  (b) any new finalize-import addition re-triggers the reconcile/dead-elim
  mismatch with a reproducing case.
- When re-activated, the implementer has a fully-ratified blueprint above:
  final by-name authority pass (Q1), all-finalize-funcs scope (Q2), central
  reverse map B2 (Q3), registry-membership-gated to avoid double-shift (Q4).
- **Detection hardening (cheap, dispatchable now if desired):** extend #1209's
  `validateFuncRefs` (`src/emit/binary.ts`, env-gated) to flag a finalize-emitted
  helper sibling-`call` whose target *name* ≠ the expected helper name, once a
  name-anchored registry exists. This converts the silent in-range-wrong-target
  failure into a loud one and is the lowest-cost first step — but it presupposes
  the B2 reverse map, so it lands *with* (B2), not before.

This satisfies the task directive: 4 questions resolved, no live repro confirmed,
disposition = defer-with-ratified-blueprint (not wont-fix — the class can recur
via #1888; the design is locked in so the next occurrence is a mechanical
implementation, not a re-investigation).
