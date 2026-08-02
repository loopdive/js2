---
id: 4092
title: "Fixed-key reflective queries (`in` / gOPD / propertyIsEnumerable / delete) are blind to the carrier own-property bag — wire them at the CONSUMER, not the general helper"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: property-descriptors
goal: standalone-mode
related: [4090, 4055, 4047, 4010, 4071, 4080, 3468, 3537, 3251]
umbrella: 4055
origin: "Harvested 2026-08-02 from the stranded draft fork PR ttraenkler/js2#12 (its `#3979` item 2). Population split and the blast-radius hazard contributed by the `L-descriptor` lane, which owns #4055."
---

# Fixed-key reflective queries cannot see the carrier own-property bag

## Measured on `upstream/main` @ `2ad68955e` (2026-08-02)

`--target standalone`, host-free (zero `env` imports asserted — the #2961
refusal that `runTest262File` does **not** apply). Write one expando, then read
it back eight ways:

| receiver | `get` | `hasOwnProperty` | `hasOwn.call` | `in` | gOPD | `propertyIsEnumerable` | for-in | `Object.keys` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `{}` *(positive control)* | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `function () {}` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `[1,2,3]` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `new Date(0)` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `new Error("x")` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `/ab/` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

The value **is** stored and readable for the closure and vec carriers (#3468 /
#3537 bags) — the whole *reflective* half of the MOP is blind to it. Date /
Error / RegExp lose the write outright (no bag at all); that is **#4010**, not
this issue.

## Scope — split by whether a COMPLETE own-key source is required

This split is load-bearing. It is the difference between #4055's shipped fix and
#4047's measured-and-reverted one.

**IN SCOPE — fixed-key queries.** `in` (`__extern_has`), `getOwnPropertyDescriptor`,
`propertyIsEnumerable`, `delete` (`__delete_property`). Each asks about **one
named key**. No key source is needed, and the bag is precisely where
`__extern_set` put the write, so presence and read agree by construction.

**OUT OF SCOPE — enumeration.** `Object.keys`, for-in (`__object_keys_forin`).
These need a **complete** own-key source and the bag is not one:
`props.p = v` lands in the bag while `Object.defineProperty(props,"p",…)` lands
in the #3251 overlay (Array) or nowhere (Function). #4047 measured exactly this
arm at **+6 test262 files** and reverted it, because it bought those six with a
**silent no-op** on the more idiomatic spelling. Do not fold enumeration in.
Sequencing: **#4090** is the prerequisite that makes a closure bag complete;
enumeration becomes discussable only after it lands.

Live control confirming the enumeration gap is real and not instrument
blindness — #4071's vec index arm answers, the named expando does not:

```js
const a = [10, 20, 30];             Object.keys(a).length;  // 3  ✓ (#4071)
a.q = 7;                            Object.keys(a).length;  // 3  ✗ (spec: 4)
```

## ⚠ Two hazards, both already paid for once

1. **Scope the fix to the CONSUMER, not the general helper.** #4055's first cut
   widened `__hasOwnProperty` itself and was **auto-parked**: it cost **684
   standalone host-free passes** (713 files lost, 682 of them `name.js` /
   `length.js`, 696 failing "descriptor should be configurable"), because
   `propertyHelper.js` reaches `hasOwnProperty` on essentially every
   `built-ins/**/{name,length}.js` test. The shipped fix is a separate native
   (`__desc_has_own`, `carrier-bag-hasown.ts`) called only by
   ToPropertyDescriptor. The arm was not wrong — it was wired at the most general
   point that could express it, and generality there is blast radius.

2. **For vec carriers, an arm in the helper BODY is unreachable.**
   `fillVecHasOwnHelpers` (`vec-overlay.ts`) **unshifts** a prologue that answers
   every vec receiver from `__vec_gopd` and returns. A vec arm was written,
   measured unreachable, and deleted rather than shipped as decoration.
   Array-side reconciliation is **#4010**.

## Acceptance strata — do not sample the descriptor area alone

`built-ins/**/{name,length}.js` (~972 files) is uniformly hit by
`propertyHelper.js` and is **invisible from descriptor-area sampling**. It is the
stratum that caught the 684-pass regression. Any change here must carry it as an
explicit control stratum, alongside a currently-**passing** stratum that asserts
a **FALSE** presence answer — this change is bidirectional, so the failure mode
to detect is **over**-reporting.

Instrument note: `runTest262File` does **not** apply the #2961 host-import
refusal, so a runner-only control cannot see `host_import_leak_class` at all.
Read `WebAssembly.Module.imports(mod)` directly, base vs branch.

## Instance of #4080

Same shape as the collected instances: the correct treatment (`__closure_bag_lookup`
/ `__vec_bag_lookup`, and #4032's `__integrity_bag` resolver in
`object-integrity-carrier.ts`) already exists; these consumers were never wired
to it.

## Owner routing

Lands in `src/codegen/object-runtime.ts` and
`src/codegen/object-runtime-descriptors.ts` — the `L-descriptor` lane's active
files (PR #4017, #4055). Filed **for** that lane after confirming with it that
neither this nor #4090 is already queued there. The harvest that produced this
issue deliberately touched neither file.

## Measurement provenance

Baseline JSONL force-refreshed before any sizing (48,346 entries, 2026-08-02).
All probes compiled `target: "standalone"` with zero `env` imports asserted;
verdicts computed **inside** the module and returned as numbers (a `string`
returned from an exported standalone function does not marshal and reads
`undefined` for every case, *including a positive control* — the first cut of
this probe fell into exactly that and was discarded). **No flip count is
claimed**: the population sits inside #4055's 835 ≤ES5 standalone failures, and
gated is not flipped.
