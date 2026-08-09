---
id: 3537
title: "standalone: expando own-properties on array ($Vec) receivers are silently dropped — writes no-op, reads answer undefined"
status: done
assignee: ttraenkler/fable-exposed
created: 2026-07-23
completed: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: property-write, dynamic-property, arrays
es_edition: es5
goal: standalone
umbrella: 2860
sprint: 75
horizon: m
related: [3468, 3251, 2860, 3180]
origin: "#3468 cliff clustering (2026-07-23, fable-exposed): cluster 6 — 26/458 sampled regressions (~208 projected) trace to array expando drops, NOT to RegExp .index (exec().index works; the harness arrays' `__expected.index = 0` expando is what drops)"
# (#3102) The substrate is the NEW leaf module src/codegen/vec-props.ts; these
# god-file touches are the unavoidable arm/wiring minimum (mirrors the #3468
# C-core grant): 3 arm call-site swaps in object-runtime.ts, the reserve/fill
# ctx flags in context/types.ts, and the finalize calls in index.ts.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
---

# #3537 — standalone: array ($Vec) expando own-properties dropped

## Problem

Under `--target standalone`, assigning a **named expando property to an
array** is silently dropped, and reading it back answers `undefined`:

```js
var __expected = ["abc", "a"];
__expected.index = 0;          // write reaches __extern_set, dies in the
__expected.input = "abc";      // non-$Object arm (silent no-op)
__expected.index;              // undefined
```

All four probed shapes fail on current main (verified 2026-07-23, WAT shows the
write DOES reach the dynamic runtime — this is a runtime dead-arm, not a
front-end drop):

| shape | result |
| --- | --- |
| top-level `a.index = 0` on array var (`.js`, harness shape) | dropped |
| in-function `(a as any).x = 5; (a as any).x` | undefined |
| aliased `var g: any = a; g.x = 7; g.x` | undefined |
| identity `g.x = 9; (a as any).x` | undefined |

## Why it matters (measured, #3468 cliff clustering)

- **Cluster 6 of the #3468 exposure histogram: 26/458 sampled regressions
  (~208 projected of the 3,664 cliff)** are test262 files whose *harness
  arrays* carry expandos (`__expected.index/.input` in the classic RegExp
  suites, etc.). `RegExp.exec().index` itself WORKS — the mirage "regexp
  .index" cluster label was killed by probing; the actual drop is the
  **expected-array expando**.
- Part of the own-property family (~2,100–2,500 tests total: #3468 closures ×
  this array arm × builtin namespaces × class prototypes + the ~1,591
  F3-unmasked `verifyProperty` rows). Routed to this lane by the tech lead
  (2026-07-23); closure receivers stay #3468-owned, descriptor/attribute
  fidelity stays #3251-owned.

## Root cause

`a.p = v` / `a.p` on a `$Vec` receiver route to `__extern_set` / `__extern_get`
(`src/codegen/object-runtime.ts`), which gate on `ref.test $Object`. A real
array is a `__vec_<kind>` struct subtyping `$__vec_base` — NOT a `$Object` — so
the write falls into the (#3468-filled-for-closures) non-object arm, which
today only handles capturing-closure receivers and otherwise no-ops/answers
undefined. Same family as the #3468 closure gap, receiver kind = array.

## Fix (this PR) — mirror of the #3468 C-core side table, ARRAY arm

New leaf module `src/codegen/vec-props.ts` (closure-props.ts is NOT edited —
it is #3468-owned; composition happens in the arm builders):

- `$VecPropEntry { next; key: eqref; bag: externref }` + module global
  `$__vec_prop_head`, standalone/wasi only (host lane byte-identical — the
  `env::__extern_*` imports own that path).
- Reserved-then-filled helpers (same funcIdx-ordering discipline as
  `reserveClosurePropHelpers`/`fillClosurePropHelpers`):
  `__is_vec_prop_carrier` (single `ref.test $__vec_base`), `__vec_bag_lookup`,
  `__vec_bag_ensure`, `__vec_prop_get`, `__vec_prop_set`.
- The three `__extern_*` non-object arms now route through composed builders
  (`buildVecOrClosureProp*` in vec-props.ts) that test the vec carrier FIRST
  and fall through to the UNCHANGED #3468 closure arm otherwise.
- **`"length"` is excluded at SET time** (native-string compare, the
  `fillBuiltinFnMeta` classify pattern): the bag can never shadow the real vec
  length, regardless of which read path answers `.length`.

Out of scope (documented boundaries):
- reflection (`in`/`delete`/`Object.keys`/`hasOwnProperty`/gOPD) over the bag —
  family follow-on, same C-complete boundary as #3468;
- numeric index keys — vec ELEMENTS, and per-index descriptor fidelity is
  #3251's overlay epic;
- builtin-singleton expandos (`Math[0]`, #3180 bucket 3) — different receiver
  rep, follow-on can reuse this substrate pattern.

## Test plan

`tests/issue-3537.test.ts`, `--target standalone`:
- write/read round-trip on array expando (top-level and in-function);
- alias identity (`g.x = 9` visible via `a.x`);
- distinct arrays don't cross-talk;
- `.length` NOT shadowable (`(a as any).length = 99` → `a.length` unchanged);
- elements unaffected by expando writes;
- host lane (`gc`) byte-identical on a no-expando program.

## Implementation notes (WHY, found during implementation)

The side table alone was NOT sufficient — the dynamic helpers have
**finalize-spliced vec arms that terminally swallowed every named key before
the miss arms could run**. Both had to be restructured to fall through:

1. **Write:** `fillExternSetVecArms` (#3190) prepended an arm to `__extern_set`
   whose vec branch ended in an unconditional `return` — a non-numeric key
   (`ToNumber(key)` = NaN) was a silent drop. The `return` moved INSIDE the
   numeric-key branch: numeric keys stay terminal (element write / deferred
   grow no-op — bagging them would be incoherent with `__extern_get_idx`
   element reads), NaN keys fall through to the composed miss arm.
2. **Read:** `fillDynamicForinVecArms`' `__extern_get` arm (#3183) ended in
   `getMiss(); return` for every non-"length"/non-index key. Tail removed —
   fallthrough reaches the miss arm, whose vec branch consults the bag and
   itself answers the identical undefined-miss sentinel on absence, so
   no-expando programs keep byte-equal observable behavior.

Composition boundary held: `closure-props.ts` (#3468-owned) untouched; the
`buildVecOrClosureProp*` builders in `vec-props.ts` wrap the closure builders
(vec test first, unchanged closure arm as the else/fallthrough).

Verified NOT-regressions during development (verify-first):
- `(a as any).length = 99` mutating `a.length` to 99 is PRE-EXISTING correct
  spec behavior via the specialized length setter (not this PR's path);
- the 7 failing tests in `tests/issue-3183.test.ts` (2) / `tests/issue-2190.test.ts`
  (5, heterogeneous anytuple nested reads) fail IDENTICALLY on clean
  `origin/main` src — pre-existing main breakage, not introduced here;
- `check:godfiles` exits 1 on clean `origin/main` too (stale committed
  profile; none of its 6 flagged functions are touched by this PR).

## Measured validation (2026-07-23, CI-exact worker driver, pool 3)

All four measurements ran the REAL `scripts/test262-worker.mjs` fork pool
(originalHarness + strict-rerun + standalone verdicts):

| measurement | n | result |
| --- | --- | --- |
| floor safety: stride-8 of the 28,655 standalone baseline passes, main@f9d8c75 vs main+fix | 3,582 | **agree 3,582 / regressions 0 / improvements 0** — byte-level additive, zero floor risk |
| cliff bank: the 458 #3468-cliff sample regressions, harness(main+routing-revert) vs harness+fix | 458 | **26 fail→pass (every cluster-6 file), 0 fail→CE, 0 new failures** → projected **−208 of the ~3,664 cliff** |
| today-main upside probe: 146 baseline-FAIL rows under RegExp/Array-from dirs, main vs main+fix | 146 | 0 flips either way (those fail for other reasons) |

Honest accounting: this PR is **floor-NEUTRAL on current main** (the expando
tests vacuous-pass today) and its +208 materializes when the #3468 harness
routing lands — it is the first measured, validated shrink of the #3468 cliff
(3,664 → ~3,456), plus the array arm of the own-property family program.

Plus: 4/4 probe shapes, 13/13 guard probes, 11/11 vitest (`tests/issue-3537.test.ts`),
28/28 in the adjacent #3418/#3468 suites, tsc clean, prettier clean,
`check:loc-budget`/`check:coercion-sites`/`check:oracle-ratchet`/`check:stack-balance` green.
