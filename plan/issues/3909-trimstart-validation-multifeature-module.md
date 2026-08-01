---
id: 3909
title: "__str_trimStart fails Wasm validation when JSON.stringify + regex + case conversion appear in one module"
status: done
created: 2026-07-31
updated: 2026-08-01
completed: 2026-08-01
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: string-methods
goal: performance
sprint: Backlog
horizon: m
es_edition: multi
related: [3900, 3910]
loc-budget-allow:
  - src/ir/integration.ts
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
---

# #3909 — `__str_trimStart` mis-validates in a multi-feature module

## Status: fixed

## Problem

A module that combines `JSON.stringify`, a regex, and a case-conversion call
fails Wasm validation in `__str_trimStart`. Each feature works in isolation;
the failure needs all three present, which points at a cross-feature
interaction — an import-index shift, a helper emitted under one gating
condition and consumed under another, or a shared-local collision between
runtime helpers.

That shape is worth taking seriously because we have now seen it twice in one
day: #3902 found that `import-collector.ts` gates `string_compare` on
`ctx.nativeStrings` but `number_toString` on `ctx.wasi || ctx.standalone`, so
fast mode got a native helper alongside a JS-host one and cast across them.
This may be the same family.

## Scope

1. Build the minimal repro (all three features, then bisect which pair is
   sufficient) and record the exact validation error.
2. Check the helper gating conditions in
   `src/codegen/declarations/import-collector.ts` for the same class of
   mismatch #3902 found.
3. Check `addUnionImports` index-shifting — per `CLAUDE.md`, late import
   addition shifts function indices and must also shift `ctx.currentFunc.body`.
   A module with more imported helpers is exactly when that goes wrong.

## Acceptance criteria

1. Minimal repro committed as a regression test.
2. Root cause identified and fixed, with the mechanism written down (not just
   the symptom).
3. If it is the same gating-mismatch family as #3902, say so and check whether
   a systematic audit of the gating conditions is warranted.

## Notes

Found by `issue-3900-case-convert` while probing case conversion. It verified
the failure **reproduces identically on the parent commit**, so it is
pre-existing and not caused by that work. Reported rather than fixed, correctly
— it was out of that issue's scope.

## Resolution

### Repro and exact error

Reproduced by enumerating all 455 three-feature fast-mode combinations from a
15-feature list. Exactly 13 fail in `__str_trimStart`, and every one of them is
`JSON.stringify` + a regex + one more feature:

```ts
export function run(): number {
  const s = "  Hello World Test String  ";
  const j = JSON.stringify({ a: 1, b: "x" });
  const lc = s.toLowerCase();
  const mm = s.match(/l/);
  return j.length + lc.length + (mm === null ? 0 : 1);
}
```

```
Compiling function #27:"__str_trimStart" failed:
  i32.trunc_sat_f64_s[0] expected type f64, found call of type i32
```

**The validator's wording is not stable across main** — it was
`call[0] expected type (ref null 6), found i32.trunc_sat_f64_s of type i32`
before #3907 (which removed fast mode's blanket i32 narrowing and so changed
the surrounding types). Re-verified on current `main`: same function, same
mechanism, different message. Do not key on the message text.

Decoding the emitted call targets is what actually identifies it. On current
`main` the module has 8 imports and 63 defined functions, and
`__str_trimStart`'s body reads:

```
call  9 -> __str_flatten     (correct)
call 24 -> __sh_str_isWs     (WRONG — should be 25, __str_ws_start)
call 14 -> __str_compare     (WRONG — should be 15, __str_substring)
```

The tail is `s.substring(i, len)`; it lands on `__str_compare`, which takes
**two** parameters, not three. The validator matches the 3-operand stack
against a 2-param signature and reports the mismatch at whichever operand
happens to line up. Off by exactly one, on **both** helper calls in the body.

### This is a DIFFERENT root cause from #3910

They share a surface (fast mode, validation failure, "needs several features")
and nothing else. #3910 is a mis-ordered coercion insertion in
`stack-balance.ts`. #3909 is a stale function index.

This was settled by A/B on current `main`, reverting each fix independently:

| build | regex repros | `__str_trimStart` |
| --- | --- | --- |
| both fixes | valid | valid |
| only #3910 fix | valid | **still broken** |
| only #3909 fix | **still broken** | valid |
| neither | broken | broken |

Each fix is necessary; neither is sufficient. Two root causes, not one.

### Root cause: a stable handle downgraded to a live index, then lost by the shift guard

`resolveNativeStrHelper` (`src/codegen/stdlib-selfhost.ts`) resolved a helper
by scanning `ctx.mod.functions` and returning `ctx.numImportFuncs + i` — a
**LIVE-regime** index — *before* consulting `ctx.nativeStrHelpers`. Since
#1916 S3 that map holds **STABLE-regime handles** (`mintDefinedFunc`,
`>= STABLE_FUNC_BASE`): layout-independent ids no shifter touches, which
`resolveLayout` maps to a concrete index once, at emit, off the final layout.
The name scan was preferred because of a comment that predates S3 ("the helpers
map bakes registration-time indices that late-import passes do not re-shift").
That premise is now inverted: the stable handle is the one that cannot go
stale, and the scan is the fragile option.

Why the live index then dies — and why it takes three features. Shifters decide
what to move with `inLiveShiftRange(idx, importsBefore)`, i.e.
`idx >= importsBefore`. A baked live index is a defined-function reference, but
on the wire it is only a number. Once enough imports accumulate that
`importsBefore` climbs **above** that number, the guard reads the stale
reference as "an import index below the insertion point" and stops shifting it.
It is then permanently short by the batches that crossed it.

Measured on the repro (instrumented `addImport`, instrumentation since removed):

```
bake:                        __str_substring -> 61   (numImportFuncs = 54)
addImport env.string_match   numImports=55  lastCall=61  trueSub=62  delta=-1
… 18 more union/typeof imports …
addImport env.__typeof       numImports=73  lastCall=61  trueSub=80  delta=-19
addImport env.JSON_stringify numImports=74  lastCall=79  trueSub=81  delta=-2
```

The divergence opens at the **first** import after the bake and is never fully
repaired; the deferred reconcile re-applies +18 where +19 was owed. After DCE
renumbering that residual lands as the observed off-by-one.

The feature-count threshold is now explicit: you need enough imports for the
running count to cross the baked index. One feature never gets there. A regex
contributes `RegExp_new` + `string_match`, `JSON.stringify` contributes
`JSON_stringify` plus the `__str_from_mem` / `__str_to_mem` /
`__str_extern_len` bridge, and the union/`typeof` block rides along — together
they clear it. "Only fails with three features" was a **threshold effect**, not
a feature interaction.

This is precisely the unsoundness `src/emit/resolve-layout.ts` documents:
*"identity must ride IN the instruction (a handle), because a numeric index is
ambiguous across shifts — any idx-keyed repair map is unsound."*

### Fix — one shared resolver, applied systemically

New `nativeStrHelperHandle(ctx, name)` in `src/codegen/func-space.ts` (the
handle authority module): **stable handle first**, then the historical
positional scan, then whatever the map holds. Helpers still on stable minting
skip the fragile step entirely; anything not yet migrated behaves exactly as
before, so the change is strictly safer at every site.

Seven call sites carrying the same outdated comment now route through it:

| file | site |
| --- | --- |
| `src/codegen/stdlib-selfhost.ts` | `resolveNativeStrHelper` (the #3909 site) |
| `src/codegen/statements/loops.ts` | `for…of` over a string — `__str_flatten` / `__str_substring` (#1186) |
| `src/codegen/string-builder.ts` | `lookupModuleFuncByName` — `__str_flatten` / `__str_buf_next_cap` (#1210) |
| `src/ir/integration.ts` | `computeStringBackend` — `__str_concat` / `__str_equals` / `__str_concat_owned` |
| `src/ir/integration.ts` | `IR_STRING_COMPARE_FN` → `__str_compare` |
| `src/ir/integration.ts` | `makeResolver`'s generic native-helper fallback (#1183) |
| `src/ir/integration.ts` | `emitStringCharAt` → `__str_charAt` |

Only the first was demonstrably failing; the other six were the same latent
hazard one import-count threshold away.

**The stale comments were also corrected, and that is part of the fix, not
cosmetics.** The bug's proximate cause was a comment that outlived its facts:
several sites asserted "`ctx.nativeStrHelpers` is stale post-shift, so resolve
by name against `ctx.mod.functions`", which stopped being true at #1916 S3 and
inverted into a hazard. Two such comments survived the call-site migration
(`src/ir/integration.ts` Phase-3 entry, and the `StringBackendIndices` doc) and
have been rewritten to state the current invariant. Leaving them would have
re-seeded this exact bug for the next reader. That rewrite is the growth the
`loc-budget-allow` / `func-budget-allow` keys above cover.

### Sweep for other stale-index consumers

1. **`nativeStrHelpers` is now provably clean.** Instrumenting
   `nativeStrHelperHandle` across 5 string/regex-heavy modules × host and fast
   modes, **every** resolution reported `STABLE` — 0 `LIVE`, 0 `MISS`. The
   positional-scan fallback is never taken in practice, so the fix is total
   for this family rather than partial. Every `nativeStrHelpers.set` site was
   confirmed to source its value from `mintDefinedFunc`.
2. **The remaining positional scan-by-name in the WasmGC path is safe.**
   `findFuncByName` in `stackBalance` (`src/codegen/stack-balance.ts`) resolves
   `__box_number` / `__unbox_number` by scan, but `stackBalance` is a post-hoc
   pass over the **final** module: it derives `numImports` and consumes the
   index within the same pass, with nothing appending after. No
   append-after-capture window exists.
3. **`ensureLateImport` sites are not this hazard** — e.g. the
   `__extern_toString` path in `array-methods.ts` uses the sanctioned
   late-import mechanism, which drives the shifters rather than baking behind
   their backs.
4. **Not swept: `src/codegen-linear/`.** `runtime.ts:4088` and `c-abi.ts:49`
   carry the same positional scan-by-name shape, but the linear backend is a
   separate pipeline that does not use the WasmGC late-import shifters. Both
   look like same-pass compute-and-consume, but this was **not verified** — see
   "Not verified" below.

### Verification

- All 13 `__str_trimStart` failures gone; zero Wasm validation failures remain
  in the 455-combo corpus.
- Both stale calls in the body are repaired (`24 → 25`, `14 → 15`).
- Benchmark suites (`strings`/`arrays`/`mixed`, host + fast) byte-identical
  before/after; playground + examples corpus identical.
- Tests in `tests/issue-3909-3910-index-and-argcoerce.test.ts` assert the
  module validates AND that `__str_trimStart`'s tail call resolves to
  `__str_substring` and specifically not to `__str_compare`. 5 of the 6 fail on
  the unfixed compiler; the 6th is a deliberate non-regression guard.
- Scoped suites green on current `main`: 431 tests across the self-host,
  native-string, standalone-string, regex, `for…of`-string, string-builder,
  JSON-stringify and IR-string surfaces.
- Gates green: `typecheck`, `lint`, `format:check`, `check:oracle-ratchet`,
  `check:stack-balance`, `check:coercion-sites`, `check:test-vacuity-shapes`.

### Not verified

- `src/codegen-linear/runtime.ts:4088` and `src/codegen-linear/c-abi.ts:49`
  were identified as carrying the same scan shape but **not** exercised or
  proven safe. They are in a separate backend that this change does not touch.
- The `check:godfiles` gate fails on `src/codegen/index.ts#generateMultiModule`
  and `#planIrOverlay`. That file is **not** touched by this change (empty
  diff) — the failure is pre-existing on `main`, not attributable here.
- `tests/imported-string-constants.test.ts` has 4 failures. Confirmed
  **pre-existing** by A/B against a fully-reverted tree on the same commit;
  identical failures with and without this change.

### Relationship to #3902's gating-mismatch family

Not that family. The scope note asked whether `import-collector.ts` gates a
helper one way and its consumer another (#3902). It does not here — this is an
index-identity defect, orthogonal to helper gating. No gating audit is
warranted on this evidence.

### Residual (separate issue)

The repro modules now validate but still fail at runtime, because fast-mode
regex passes native-string GC structs straight to the JS `RegExp` constructor
without the `__str_flatten` + `__str_to_extern` bridge — see the residual
section of #3910. Pre-existing, representation-level, out of scope here.
