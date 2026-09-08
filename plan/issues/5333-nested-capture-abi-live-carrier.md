---
id: 5333
title: "P0 — main emits invalid Wasm: reserved nested-capture plan pins a stale carrier onto a live local"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
assignee: ttraenkler/senior-dev
---

## Problem

`main` compiled several npm packages to Wasm that **fail `WebAssembly.compile`**. The
modules build (`compile.success: true`) and are then rejected by the validator:

```
CompileError: WebAssembly.compile(): Compiling function #721:"__closure_47" failed:
  call[25] expected type (ref null 84), found struct.get of type i32 @+437566
```

Measured on clean detached worktrees:

| package  | before (`4946cf70fe`) | after regression (`104dc660fb`) |
| -------- | --------------------- | ------------------------------- |
| moment   | 10/10, `compile.validated` 6/6 | 0/10, `compile.validated` 0/6 |
| prettier | 61/151                | 2/151                           |

The per-test `wasmError` is `null` and `compile.details[N].errors` is `[]` — the message
lives in **`compile.details[N].validationError`** of
`tests/dogfood/report/<pkg>-upstream-suite.json`. Several agents read the empty `errors`
array as "no error"; it is not.

## Bisect

`4946cf70fe..104dc660fb` is 90 commits / 17 first-parent. Measured on `moment`
(`compile.validated == 0` as the binary signal, ~2 min per point):

| commit | what | moment |
| ------ | ---- | ------ |
| `4946cf70fe` | pre-window main | **6/6 validated, 10/10** |
| `88bdfda594` | #5585 IR literal computed methods | 6/6, 10/10 |
| `b08dd4589c` | #5503 npm-compat refresh (first parent of the culprit) | **6/6, 10/10** |
| `470ceba797` | **#5390 `codex/1058-typescript-binder`** | **0/6, 0/10** |
| `944643dcde` | #5598 multi-source module-init census | 0/6, 0/10 |
| `104dc660fb` | main at report time | 0/6, 0/10 |

**#5598 is NOT the culprit.** It was the attribution handed to this investigation; the
window immediately before it (`470ceba797`, #5390) is already broken with the *identical*
error at the *identical* byte offsets. #5598 may have caused the separate
`multi-prepared-module-init-census:terminal-join` error another agent saw on prettier —
that error never appears in the moment lane and is not this defect.

**Do not bisect inside #5390's branch commits.** They sit on a ~4-day-older base which is
itself bad for moment, so every branch point measures BAD regardless of content
(`3aca301c5f`, a nearly test-only commit, measures BAD for exactly this reason). The
merge-vs-first-parent comparison is the only sound one.

File-level A/B on current `main` (restore one file to its pre-#5390 content, re-measure):

| tree | moment |
| ---- | ------ |
| main | 0/6, 0/10 |
| main + pre-#5390 `stack-balance.ts` + pre-#5390 `nested-declarations.ts` | 6/6, 10/10 |
| main + pre-#5390 `nested-declarations.ts` only | **6/6, 10/10** |
| main − #5390's `94a08e3c05` hunks in that file | 0/6, 0/10 |
| main − `94a08e3c05` − `edf9e48389` hunks | 0/6, 0/10 |

⇒ the defect is `src/codegen/statements/nested-declarations.ts`, introduced by
**`82be803ac7` "fix(typescript): preserve reserved sibling capture ABI"** (the only other
commit that touches that file).

## Root cause

`82be803ac7` added `canonicalReservedCapturePlan`. A nested `function` declaration's
capture vector is published at Phase 0 (`preRegisterOnly`) because an earlier sibling can
already compile a direct call or mint a closure artifact against it. On the real compile
the function re-derives its captures and the new code **replaces** the freshly observed
plan with the Phase-0 one, refreshing only `localIdx` / `tdzFlagIdx`:

```ts
return canonical.map((planned) => {
  const live = observedByName.get(planned.name);
  const merged = cloneNestedFunctionCapturePlan([planned])[0]!;
  if (live !== undefined) {
    merged.localIdx = live.localIdx;      // live frame
    merged.tdzFlagIdx = live.tdzFlagIdx;  // live frame
  }
  return merged;                          // type / alreadyBoxed / forwardUnboxed: Phase 0
});
```

Between Phase 0 and the real compile the declaring frame can **box** a binding. Phase 0
saw a raw slot (`alreadyBoxed:false`, `type` = the value carrier); the live frame holds
the canonical ref cell (`alreadyBoxed:true`, `type` = the cell, `boxedValType` = the
value). The guard above the merge passes on exactly that pair — by construction, because
`nestedCaptureValueParamType` boxes the raw carrier into the same cell and
`nestedCaptureMetadataValueType` unwraps the cell to the same inner type. They are two
spellings of ONE ABI, so nothing is "changed" and nothing throws.

But the entry the merge emits is **internally inconsistent**: it claims "unboxed value at
local N" while local N holds a cell. Downstream consumers that key off `alreadyBoxed` /
`forwardUnboxed` (`valueCaptureParamTypes`, the lifted body's `boxedCaptures`
registration, and #5303's `forwardUnboxed` value-forwarding) then disagree with the
frames that actually hold the value — a capturing closure forwards the raw `struct.get`
field where the lifted function's ref-cell param is expected.

Measured on one moment module: **70 declarations diverge, 164 captures flip
`alreadyBoxed`**, e.g.

```
handleStrictParse  updateInProgress
  canonical: i32(boolean):mut @4                       => param (ref 101) / meta i32(boolean)
  observed : (ref 101):mut:boxed:inner i32(boolean) @279 => param (ref 101) / meta i32(boolean)
```

Source-mapping the failing offset lands on `moment.js:3665` — the closure
`createAdder` returns, calling the later-declared `addSubtract`, which captures
`updateInProgress`.

## Fix

Keep the canonical plan as the authority for **name, membership and ORDER** — that vector
is what an earlier sibling baked in and it may not move. Take the **live entry's carrier**
whenever the binding is still physically observed; its ABI has just been proven equal to
the reserved one by the guard directly above. Only a promotion-only capture (no live
entry, sourced from the representation-checked global) keeps its Phase-0 record.

```ts
return canonical.map((planned) => {
  const live = observedByName.get(planned.name);
  return cloneNestedFunctionCapturePlan([live ?? planned])[0]!;
});
```

Three lines of behaviour. It defers to the pre-existing #5303 reconciliation
(`reorderToPreRegisteredAbi` + `forwardUnboxed`), which already runs on the observed
captures immediately before this merge and already handles "the declaring slot was boxed
after Phase 0" for the read-only case.

## Evidence

| tree | moment | prettier |
| ---- | ------ | -------- |
| `4946cf70fe` (pre-regression) | 6/6 validated, 10/10 | 61/151 (reported) |
| `104dc660fb` / `b67ab1fc0e` (main) | 0/6, 0/10 | 2/151 (reported) |
| main + this fix | **6/6 validated, 10/10** | 3/16 validated, **2/151** |
| **merged result** (`d5f6acfb28`, branch + `upstream/main` @ `82394ba491`) | **6/6 validated, 10/10** | — |

`node scripts/equivalence-gate.mjs` with the fix: `24 failing, 1718 passing, 24
known-failures in baseline — no new equivalence regressions`.

**prettier does not recover, and that is expected: it has a SECOND, independent
regression in the same window** — not invalid Wasm but a hard codegen error, so 13 of its
16 modules never produce a binary:

```
Codegen error: multi-prepared-module-init-census:terminal-join: executable source
ir-source:v1:…src%2Fcommon%2Fast-path.js lost its exact module-init terminal
```

That is **#5332** — `export default <identifier>;` in a dependency of a multi-file
project, root-caused there to the #3525 census work (`2c18cd7a6f`, PR #5598). Thirteen of
prettier's sixteen modules hit it. The measured prettier cost has been added to that
issue's `## Cost, measured` section.

All 13 of #5390's own regression tests still pass with the fix
(`issue-1058-reserved-sibling-capture-abi` 7, `issue-1058-function-type-branding` 1,
`issue-1058-stack-balance-dag` 5) — the freeze's intent (a sibling-visible capture ABI
that cannot silently change shape or order) is preserved.

## No minimal regression test — reproduction is package-level

The divergence path reproduces easily in a small program (a nested declaration
pre-registered by an earlier sibling whose captured `let` is boxed before the real
compile — see the probe output above), but every reduced fixture tried still emits a
VALID module. The invalid-Wasm consequence needs a further consumer that the moment
module supplies and the reductions did not. Shapes tried and rejected, all under both the
`standalone` and the dogfood `compileProject`/web/IR lane:

- capturing arrow that also mutates the binding;
- arrow that only calls the lifted sibling;
- arrow minted inside a second nested declaration;
- moment's own `createAdder`/`addSubtract` factory-returns-closure shape, with and without
  the earlier-sibling pre-registration trigger;
- an `async` declaring frame (force-boxed spill cells).

So the guard for this defect is the dogfood suite, not a unit test.

**Follow-up worth filing:** `main` shipped invalid Wasm through five merges with all six
required checks green. `tests/dogfood/moment-upstream-suite.test.ts` runs its heavy arm
only under `DOGFOOD_MOMENT_UPSTREAM_SUITE=1` and asserts nothing about
`compile.validated` or the Wasm pass count, so nothing in CI observed a 10/10 → 0/10
collapse. A cheap `compile.validated` floor on the dogfood packages would have caught
this on the culprit PR.
