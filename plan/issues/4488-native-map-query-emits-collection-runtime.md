---
id: 4488
title: "#4461's native-map capability QUERY emits the $Map runtime, putting it in every module with a `new`"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-15
assignee: ttraenkler/opus-4462
priority: high
horizon: s
feasibility: easy
task_type: fix
area: ir
goal: ir-full-coverage
related: [4461, 4583, 1103, 2955]
loc-budget-allow:
  # +37: the split of one resolver capability into a pure query and an explicit
  # materializer, plus the doc block that records WHY (a query that emits cost
  # 508 wasm-hash changes). The arms must stay beside the call sites they gate.
  - src/ir/from-ast.ts
  # +12: the same split on the resolver side, in the object that holds every
  # other capability method.
  - src/ir/integration.ts
func-budget-allow:
  # +12: one capability method became two (pure query + explicit materializer),
  # in the object that already holds every other resolver capability.
  - src/ir/integration.ts::makeFromAstResolver
---

# #4488 — a capability query with an emission side effect

#4583 (#4461, native `$Map` module-binding storage) merged as `60d1db4f` and put a
real regression on `main`: the `merge_group` run measured **net −475**
(33 improvements / 508 regressions), **297** of them in
`test/language/expressions/class/elements`, **all 508 with wasm-hash changes**,
plus a failing standalone high-water floor. The PR was auto-parked; the park did
not hold and it landed anyway.

## Root cause

`makeFromAstResolver.nativeMapStorageType()` (`src/ir/integration.ts`) called
`ensureMapHelpers(ctx)` — which **emits the entire twelve-function `$Map`
runtime plus its struct types**. It is a *capability query*, and both from-ast
callers asked it **before** they knew they were looking at a `Map`:

- `lowerNewExpression` asked on **every `new` expression**;
- `nativeMapModuleBinding` asked on **every method-call receiver**.

So in any lane where `ctx.nativeStrings` is true (native strings, standalone,
WASI), **every module containing a `new` expression received the whole
collection runtime**, whether or not it ever mentions `Map`. Class-element tests
all construct (`new C()`), which is exactly the 297-file bucket; the size blowup
is what failed the standalone floor.

The host `gc` lane was untouched because the query early-returns on
`!ctx.nativeStrings` — which is why the damage looked selective.

## Measured evidence

Two-class module, **no `Map` anywhere**, native-strings lane, pre-#4583 main
(`793b5c0e`) vs `main` at `60d1db4f`:

| | pre-#4583 | with #4583 | delta |
|---|---|---|---|
| binary | 22,214 B | 23,588 B | **+1,374 B** |
| functions | 59 | 71 | **+12** |
| type section | 348 B | 484 B | +136 B |

The 12 added functions are exactly the `$Map` runtime: `__map_new`, `__map_get`,
`__map_set`, `__map_has`, `__map_delete`, `__map_clear`, `__map_size`,
`__map_iter_new`, `__map_iter_next`, `__map_lookup_idx`, `__hash_anyref`,
`__same_value_zero`.

**The three `__ir_map_*` adapters were ABSENT from that list.** That is the
decisive datum: it proves `addAdapter` never ran, so the originally-suspected
`ir-native-map.ts` late-minting / function-index-shift hypothesis (the
documented `addUnionImports` hazard class) is **not** the cause here.
`ensureIrNativeMapAdapters` is correctly gated on `usesNativeMapAdapters` and
correctly placed before Phase 3; the leak is upstream of it, in the resolver.

## Fix

Split the one method into a pure query and an explicit materializer, and make
each call site use the right one:

1. `nativeMapStorageType()` is now **PURE** — returns `undefined` while
   `ctx.mapTypeIdx < 0` and never registers anything.
2. New `ensureNativeMapStorageType()` keeps the materializing body. Its only
   caller is `tryLowerNativeMapConstruction`, **after** that function has
   syntactically proven an ambient zero-arg `new Map()`.
3. `nativeMapModuleBinding` resolves the module binding **first** — the cheap
   discriminator, and for a genuinely native-map binding that resolution is
   itself what registers `$Map` (`resolveModuleBindingGlobal`'s `native-map`
   arm) — then consults the pure query.

No change to what the Map feature lowers; only *when* the runtime is
materialized.

## Verification

**Hard invariant — a no-Map module must be byte-identical to pre-#4583 main.**
Compiled on the fix branch and on `793b5c0e`, sha256 of the binary:

| case | lane | pre-#4583 main | fix branch | |
|---|---|---|---|---|
| `plain-class` | native | `2ddb2df6f6a00df9` | `2ddb2df6f6a00df9` | identical |
| `private-method` | native | `3c93ee509b6a87ef` | `3c93ee509b6a87ef` | identical |
| `plain-arith` | native | `fe43ab03f38e48f8` | `fe43ab03f38e48f8` | identical |
| `plain-class` | standalone | `9a01fc5d4b279c0b` | `9a01fc5d4b279c0b` | identical |
| `private-method` | standalone | `bfdf3ce748f8d3aa` | `bfdf3ce748f8d3aa` | identical |
| `plain-arith` | standalone | `6503d0643ab23fca` | `6503d0643ab23fca` | identical |
| `with-map` | native | `8f2cb840d92aebd4` | `d08dda763ae74dc6` | **differs — the feature** |
| `with-map` | standalone | `af225a9fa998d49d` | `a0bc1a44940559ab` | **differs — the feature** |

All four cases in the host `gc` lane are identical across all trees.

`tests/issue-4461.test.ts`: **5/5 pass** on the fix branch — the Map adoption
survives; only the collateral damage is removed.

### Stated honestly: what I did NOT verify

I could **not** reproduce the two named test262 files
(`new-no-sc-line-method-private-names.js`,
`after-same-line-method-rs-private-method.js`) trapping locally. Compiled raw,
they hash **identically** on pre-#4583 main, on damaged main, and on the fix
branch, and my hand-assembled harness bundle CEs identically on all three — so
my probe does not reproduce the runner's harness assembly and is not a
discriminating test. The synthetic two-class repro above *is* discriminating and
is what localises the defect; CI's `merge_group` re-run is the authority on the
508 files.

## Follow-up worth having

A resolver capability query that emits is a repeatable trap — this is the same
shape as the `addUnionImports` hazard, one layer up. Consider a naming rule
(`ensure*` may materialize, everything else must be pure) and, if cheap, a
debug-mode assertion that non-`ensure*` resolver methods do not grow
`ctx.mod.functions`.
