---
id: 3387
title: "standalone: NESTED async generators with for-await bodies leak the host buffer — close the nested-vs-module-scope drivability gap (~577 for-await-of rows)"
status: done
assignee: ttraenkler/fable-dev-3
completed: 2026-07-18
sprint: current
created: 2026-07-17
updated: 2026-07-18
priority: high
horizon: l
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: async-generators, for-await-of, destructuring
goal: standalone-mode
umbrella: 3178
related: [3132, 3228, 2906, 2865, 2895, 3388, 3389]
origin: "2026-07-17 fable-3178 umbrella decomposition — the for-await-of cohort of the standalone host_import_leak baseline; probe matrix isolated NESTING as the gate."
# intentional +47 in async-cps.ts: the for-await dstr HEAD exemption in
# asyncGenBodyHasPatternLocals + the forAwaitHeadPatternAdmissible predicate
# (nested-with-init correct-or-legacy guard), the load-bearing #3387 seam fix.
loc-budget-allow:
  - src/codegen/async-cps.ts
---

# #3387 — nested async-gen for-await bodies: close the drivability seam

## Problem

577 official-scope `host_import_leak` rows in
`test/language/statements/for-await-of/` (measured 2026-07-17, promoted
standalone baseline). Prefixes: `async-gen-dstr-{const,var,let}[-async]`
(86×3 + 59×3), `async-gen-decl-dstr-array*` (67), `async-gen-decl-dstr` (64).
Template shape:

```js
var callCount = 0;
async function* fn() {
  for await (const [x = 23] of [[undefined]]) { /* asserts */ callCount += 1; }
}
fn().next().then(...).then($DONE, $DONE);
```

Dominant combos:
`Promise_reject,Promise_resolve,Promise_then2,__create_async_generator,__gen_create_buffer,__gen_next,__get_caught_exception` (384)
and the same without `Promise_*` (121).

## The decisive probe matrix (2026-07-17, current main)

| shape                                                         | module scope | wrapped in `export function test(){}` |
| ------------------------------------------------------------- | ------------ | ------------------------------------- |
| `async function* fn() { for await (const [x] of [[1]]) {…} }` | HOST-FREE    | **LEAKS**                             |
| same, non-capturing (no outer binding touched)                | HOST-FREE    | **LEAKS**                             |
| `async function* g() { yield 1; }` (plain yield, capturing)   | HOST-FREE    | HOST-FREE                             |

**Nesting — not capture — is the gate.** Every test262 file compiles inside the
runner's `export function test(){}` wrapper, so the whole cohort rides this one
seam. The same seam also gates `yield*` (#3388) and `return` (#3389); this
issue owns the SEAM ROOT-CAUSE + the for-await shape, and its findings must be
written back to umbrella #3178 for the sibling issues.

## Root cause (verified gates)

The NESTED-declaration lane routes through:

- `src/codegen/statements/nested-declarations.ts:678` and `:1104` —
  `isGenerator && isAsync && isAsyncGenDriveCandidate(ctx, stmt)` →
  `emitAsyncGenerator`, else the legacy `__create_async_generator` buffer.
- `isAsyncGenDriveCandidate` (`src/codegen/async-frame.ts:2073`):
  under the carrier → `asyncGenDrivableUnderCarrier` (async-frame.ts:2062)
  → `isBoundedAsyncGenBody` → `analyzeAsyncGen` (`src/codegen/async-cps.ts:2240`);
  carrier off → `isAwaitFreeAsyncGenBody` (same analyzer).
- `analyzeAsyncGen` REJECTS a for-await statement: it is a lead statement and
  `containsAwaitOrYield(st)` (async-cps.ts:~2310) returns null → non-drivable
  → legacy buffer. A non-drivable gen also sets
  `moduleHasNonDrivableAsyncGen` (import-collector.ts:1047-1074), turning the
  module's native `$Promise` carrier OFF → the `Promise_*` co-leak in the
  384-row combo.

Yet at MODULE scope the identical body compiles host-free. **Step 1 of this
issue is locating and validating that module-scope arm**: candidates are the
#2906 CFG machinery (`planAsyncCfg` with `allowLoops`, async-cps.ts:1156-1178,
whose `planForAwaitAsyncCfg`/`planForAwaitCfg` arms already build for-await
loop CFGs) reached via a lane the nested path never enters. CAUTION: the
module-scope arm is corpus-UNDER-TESTED (the runner wraps everything), so
before reusing it, verify its RUNTIME semantics on driven shapes
(values, completion order, `callCount` visibility) — not just the import set.

## Implementation Plan

1. **Root-cause the seam** (investigation commit, written into this issue +
   umbrella #3178): instrument/trace which planner admits
   `async function* fn() { for await … }` at module scope
   (`declarations.ts` emit path vs `planAsyncCfg(allowLoops)` vs an
   inline-drive of `fn().next()`), and confirm runtime correctness of that arm
   with executed probes (`.tmp/`, values asserted). If the module-scope arm is
   silently WRONG (e.g. sync-driving a genuinely-async source), file that
   finding immediately — the fix then targets the arm itself first.
2. **Wire the nested lane to the same machinery.** Preferred shape: extend
   `analyzeAsyncGen` with a FOR-AWAIT segment kind instead of rejecting it as
   a lead — embedding the proven `analyzeForAwait` shape
   (async-cps.ts:1460) as an inner-loop construct of the async-gen CFG:
   - states: iterator-acquire → step (`await inner.next()`) → binding
     destructure (sync IteratorBindingInitialization on the settled step value
     — the #3228 mechanism) → body leads → back-edge; `done` → continue with
     trailing segments.
   - frame: reuse `computeForAwaitSpills` (async-frame.ts) for the loop's
     spill layout inside the async-gen `$AsyncFrame` (#2865 carrier).
     Because `analyzeAsyncGen` is the SINGLE gate propagated to
     `isBoundedAsyncGenBody` / `isAwaitFreeAsyncGenBody` /
     `isAsyncGenDriveCandidate` / `asyncGenDrivableUnderCarrier` /
     `sourceNeedsGeneratorHostImports` / the import-collector carrier verdict,
     widening it flips admission, import retirement, AND carrier-on in lockstep
     — no mirror edits (verify the lockstep with leak probes in a module mixing
     drivable + newly-admitted gens).
3. **Sources to admit in slice 1** (correct-or-legacy): array-literal source
   (the corpus shape `of [[undefined]]`), identifier-held driven async-gen
   source, sync-iterable identifier (through the existing
   AsyncFromSync-equivalent arm in `planForAwaitAsyncCfg`). Keep bailed:
   `yield` inside the dstr initializer (`*-elem-init-yield-expr` files —
   needs expression-level suspend numbering, note residual), `await` in the
   source expression.
4. **Binding forms**: `const`/`let`/`var` × array/object patterns with
   defaults ride the SYNC destructure once the step value is settled — reuse
   the #3228 IteratorBindingInitialization path verbatim; do not re-implement.

## Edge cases

- Abrupt inner `next()` rejection → the driven `next()` promise rejects; the
  for-await must run IteratorClose per §14.7.5.
- Loop body throw → same close path; `finally` interaction stays bailed if the
  body contains try/finally across the await (note residual).
- `moduleHasNonDrivableAsyncGen` flip: a module where SOME gen stays
  non-drivable must keep carrier-off behavior for ALL (the #3132 mix-safety
  invariant) — pre-pass ⊆ emit must hold after the widen.

## Test plan

- Executed (not just leak) probes for: values yielded, `callCount` visibility,
  completion ordering vs V8, all under the test262 WRAPPER shape.
- Construct-sampled corpus flip on the 577-file cohort; zero pass→fail on the
  adjacent for-await non-dstr + async-function scans.
- `prove-emit-identity` on gc/host lane; standalone floor via merge_group.

## Regression risks

- The carrier verdict is module-wide: a bug in the widened analyzer can flip a
  previously-host-pipeline module onto the carrier with a legacy-buffer gen
  still inside (invalid mix). The #3132 S2 lockstep tests are the template.
- Do not touch `wrapAsyncCallInTryCatch` host-lane arms; standalone arm only.

## Implementation notes (fable-dev-3, 2026-07-18) — DONE

### Root cause — the seam was NOT a missing planner arm

The spec hypothesized the fix would need to locate a "module-scope arm" that
admits for-await async-gen bodies and wire the nested lane to it (extend
`analyzeAsyncGen` with a for-await segment kind). **The probe matrix proved
that framing wrong.** On current main, a driven async gen whose body is a
`for await (const IDENTIFIER of …)` already compiles host-free at BOTH module
and nested scope — the for-await statement rides the bounded body as an
ordinary suspend-free **LEAD** statement. The sync for-await lowering
(`loops.ts` step loop + element unwrap) runs the whole loop inside ONE dispatch
of the #2906 resume fn; no suspend crosses the loop, so `analyzeAsyncGen`
accepts it as a lead (it is neither a top-level `yield` nor
`containsAwaitOrYield`-positive at the statement's own scope). The
"module-scope vs nested" table in the spec was measuring a DIFFERENT gate — the
`#680` native-generator CE for a *directly-driven* top-level gen — not the
nested wrapper's leak.

**The sole rejector of the whole `async-gen-dstr-*` cohort was
`asyncGenBodyHasPatternLocals`** (async-cps.ts): it bails any async-gen body
that declares a non-identifier (destructuring) VariableDeclaration — and a
`for await (const [x] of …)` HEAD is such a declaration. But the head pattern
is NOT a frame-spilled own local (its names bind fresh per element, entirely
within one dispatch — never across a suspend), so bailing on it was
over-conservative. Identifier heads slipped through only because they are
`ts.isIdentifier(name)`.

### The fix (2 hunks, async-cps.ts)

1. `asyncGenBodyHasPatternLocals` now EXEMPTS a for-await HEAD binding
   (`isForAwaitHeadDecl`) from the pattern-local bail.
2. `forAwaitHeadPatternAdmissible` gates that exemption: everything is admitted
   EXCEPT a **nested sub-pattern carrying an initializer** (`[[x] = [7]]`,
   `{ w:{x} = {…} }`). The sync for-await destructure deliberately skips nested
   defaults under `awaitModifier` (the #2692 capture-box / #2566
   iterator-over-consume guard in for-of-destructuring.ts), so admitting those
   shapes would run with the default UNapplied — a wrong-value run instead of
   the legacy refusal. Probe-verified: `for await (const [[x,y,z]=[4,5,6]] of
   [[]])` binds nothing, so it must stay legacy (correct-or-legacy).

Because `analyzeAsyncGen` is the single gate propagated to
`isBoundedAsyncGenBody` / `isAwaitFreeAsyncGenBody` / `isAsyncGenDriveCandidate`
/ `asyncGenDrivableUnderCarrier` / `sourceNeedsGeneratorHostImports` / the
import-collector carrier verdict, widening it flips admission, import
retirement AND carrier-on in lockstep — no mirror edits. Verified the
carrier-lockstep with leak probes.

### Validation

- New `tests/issue-3387-asyncgen-forawait-dstr.test.ts` — 13 cases: corpus
  array/obj dstr shapes, leaf/call defaults, elision, rest, nested-no-init,
  renamed/defaulted props, multi-iteration `.then` ordering + done flags, empty
  source, class async-gen METHOD lane, next()-promise reject on body throw, and
  the four correct-or-legacy refusals.
- Head-shape correctness matrix (`.tmp`): 14 shapes, all deliver correct
  runtime values or stay legacy; zero wrong-value runs after the admissibility
  predicate.
- Real test262 corpus (standalone runner lane), every-6th `async-gen-dstr*` /
  `async-gen-decl-dstr*` file: **45/103 pass, ZERO fails** (was near-0 pass
  pre-fix). Adjacent cohorts (async-func-dstr, identifier for-await) scanned
  pre/post — the 10 fails are ALL pre-existing on the merged base, byte-for-byte
  identical with async-cps.ts reverted.
- Async/generator blast-radius suites (#2906 3a/3b/3d-i/3d-ii, #3132 S1/S2,
  #3228, #2865, #3120, #3207, #2570 delegation): no NEW failures. The one
  residual failure (#3132 "elision hole in yield* literal") is pre-existing on
  the merged base, independent of this change.

### Residuals (belong to sibling issues, NOT this fix)

- for-await bodies whose ELEMENTS are promise-typed under the carrier-off
  standalone lane still leak `Promise_*` — that is the #2980 carrier-widen /
  #3388 lane, not the dstr-head admission this issue owns.
- `yield` inside a dstr initializer and nested-with-init heads stay legacy
  (correct-or-legacy, noted above).
