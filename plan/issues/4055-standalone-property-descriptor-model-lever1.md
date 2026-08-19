---
id: 4055
title: "LEVER 1 — property-descriptor model in standalone: 835 ≤ES5 failures across defineProperty/defineProperties/create/gOPD"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
assignee: ttraenkler/L-descriptor
related: [4080, 4047, 3957, 3468, 3537, 4010, 4061, 4062, 4071]
# (#3102 / #3400) The fix itself is a NEW subsystem module,
# `src/codegen/carrier-bag-hasown.ts`. What lands in the two god-files is only
# the wiring that cannot live anywhere else:
#   - object-runtime.ts (+14 / +13 in `ensureObjectRuntime`): the native must be
#     registered where `registerNative`, `__hasOwnProperty` and `__obj_find` are
#     all in scope, which is inside that function. The comment explains WHY it is
#     a separate native and not a widening of `__hasOwnProperty` — that is the
#     #4017 park in one paragraph, and it is the load-bearing part.
#   - object-runtime-descriptors.ts (+6): two ToPropertyDescriptor call sites, 3
#     lines each. Already shrunk once (5-line comments → 3) since the rationale
#     lives in the module; the remainder is the `??` fallback plus its pointer.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
---
# LEVER 1 — property-descriptor model in standalone: 835 ≤ES5 failures across defineProperty/defineProperties/create/gOPD

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01** from the standalone baselines JSONL (`test262-standalone-current.jsonl`, run `20260801-010858`), scoped to ≤ES5 via `es5id:` frontmatter in the test262 corpus (8,262 files carry it; 8,115 official ran).

**Instrument validated first**: the same script reproduces the published default-lane figure exactly (30,500/43,096 = 70.8%), so the scoping and `scope_official` filter are correct. ≤ES5 standalone baseline = **5,652 pass / 8,115 run (69.6%)**, 2,463 failures.

**This lever, by area (fail/run):**

| area | fail/run | rate |
|---|---|---|
| `built-ins/Object/defineProperty` | 337/1113 | 30.3% |
| `built-ins/Object/defineProperties` | 272/620 | 43.9% |
| `built-ins/Object/create` | 152/314 | 48.4% |
| `built-ins/Object/getOwnPropertyDescriptor` | 35/305 | 11.5% |
| `built-ins/Object/prototype` | 23/103 | 22.3% |
| `built-ins/Object/isExtensible` | 16/36 | 44.4% |
| **total** | **835** | |

**Top signatures:** 67× `TypeError: Object.defineProperties unsupported descriptor shape in standalone mode (#N)` — an explicit codegen refusal, so the standalone descriptor path is deliberately incomplete rather than subtly wrong. Then 55× `accessed !== true`, 44× `Expected true but got false` (preventExtensions), 42× `data Expected SameValue`, 29× `Expected obj[N] to be writable, but was not`, 26× `desc.writable Expected SameValue`.

**Why this is the biggest lever:** it is 34% of all ≤ES5 standalone failures, concentrated in ONE subsystem, and the largest single signature is a named refusal — meaning the work is "implement the missing descriptor shapes", not "hunt an unknown bug".

**⚠️ Sizing caution — 835 is the population GATED, not the number that will FLIP.** Many of these tests assert several descriptor properties; fixing the refusal may expose a second-order failure in the same test. Before quoting a flip estimate, take a sample of ~40, fix, and measure the actual flip rate — then extrapolate with that ratio and state it.

**Check for overlap first** with tasks #28/#29/#30 (#3661/#3662/#3663 — writable/configurable read wrong in the DEFAULT lane) and #19 (#739 S2 descriptor `[[Get]]` fidelity, which has a validated fix already parked on a branch). Those are default-lane descriptor defects; this is the standalone refusal. They may share a root cause — establish that before doing the work twice.

---

# Resolution (2026-08-02, `ttraenkler/L-descriptor`)

Two mechanisms were root-caused. **One was measured and deliberately NOT
shipped.** Both are recorded, because the refuted one is the more useful record:
it tells the next person why the obvious fix here is inert.

Baselines force-refetched before any sizing
(`scripts/fetch-baseline-jsonl.mjs --force` and `--standalone --force`); rows
timestamped 2026-08-02 07:26, 48,619 standalone entries. Every arm below is a
back-to-back same-box A/B run by ONE script, 180 s per-test compile timeout
(above the contention floor #3957 measured), row counts floored (`rows ==
expected`, else exit 9), and the two arms' row SETS compared for identity before
any delta was computed. Harness: `runTest262File(…, "standalone")`, read from the
JSONL — never a vitest reporter tally.

## SHIPPED — ToPropertyDescriptor's HasProperty never saw the carrier bag

`src/codegen/carrier-bag-hasown.ts` (new) + a registration in `emitHasOwn`'s
enclosing function and a 3-line rewire at each of the two ToPropertyDescriptor
call sites.

#3468 gave `__extern_get` / `__extern_set` / `__extern_method_call` a fallback
for a receiver that is not a `$Object`: an identity-keyed side table mapping the
carrier to a `$Object` "bag" of its own properties. **The descriptor reader was
never wired to it**, and `__obj_define_from_desc`'s ToPropertyDescriptor
(§6.2.5.6) gates **every** field on HasProperty before reading it. So a
**function used as a descriptor** — the dominant test262 spelling,
`var descObj = function(){}; descObj.enumerable = true;` — produced an EMPTY
descriptor and CompletePropertyDescriptor filled in `undefined` plus all-false
attributes. Silently, even though `descObj.enumerable` *reads* `true`.

Instance **#7 of the #4080 family**: a correct treatment exists and one consumer
was never wired to it.

### The first version of this fix was auto-parked — and why the second is scoped

v1 widened `__hasOwnProperty` / `__object_hasOwn` themselves. Every flip held and
the PR was green, and the `merge_group` re-validation parked it for breaching the
standalone host-free floor by **-457** (the artifact diff later put it at **-684**).

Composition of the loss, from the merge-queue artifacts: **713 files lost
host-free pass**, of which **682 (95.7 %) are `name.js` / `length.js`** and
**696 fail with "descriptor should be configurable"**. `propertyHelper.js`
reaches `Object.prototype.hasOwnProperty` on every `built-ins/**/{name,length}.js`
test — a **~700-file population that is disjoint from every stratum v1 sampled**.

**The lesson is not that v1's arm was subtly wrong.** Its answers were the ones
asked for. It was wired at the most GENERAL point that could express the fix, and
generality there *is* blast radius. v2 puts the widening in `__desc_has_own`, a
native only ToPropertyDescriptor calls; `Object.prototype.hasOwnProperty`,
`Object.hasOwn` and `propertyIsEnumerable` are byte-identical to before.

`__desc_has_own` calls `__hasOwnProperty` **first** and consults the bag only if
that answered false — the bag can add a `true` the helper declined, never
override one it gave. Additive, not a redirection.

**The harness-only trigger was never isolated, and that is recorded on purpose.**
Three candidate mechanisms were measured and all three failed to reproduce
outside the full harness assembly: `gOPD(Math.ceil,"length").configurable` reads
`true` on BOTH arms; `isConfigurable`'s real body (`delete obj[name]; return
!__hasOwnProperty(obj,name)`, with the harness's `Function.prototype.call.bind`
alias) already answers wrong on BOTH arms — pre-existing, not the delta; and
`verifyProperty`'s vacuity gate `__hasOwnProperty(desc,'configurable')` is `true`
on BOTH arms. **When a mechanism resists isolation, narrowing the change until
the mechanism is out of scope beats chasing it.**

### Why a fixed-key presence query over the bag is sound

#4047 measured a carrier-bag arm at +6 and reverted it: resolving a `Properties`
MAP through the bag needs a COMPLETE own-key source, and the bag is not one —
`props.p = v` lands in the bag while `Object.defineProperty(props,"p",…)` lands
in the separate #3251 overlay (Array) or nowhere (Function). It enumerated
empty, defined nothing, and returned normally.

HasProperty over a **fixed key** needs no key source at all, and the bag is
exactly where `__extern_set` put the write, so presence and read agree by
construction. `Object.defineProperty(fun,"p",…)` still lands nowhere and this
still answers `false` for it — the same answer as before.

### Measured

| check | result |
| --- | --- |
| function-carrier flip **census**, all 78 files | **14 pass** — every v1 flip survives the rescope |
| `Math/ceil/length.js` + `Array/prototype/fill/name.js` (the park repro) | 2/2 pass (v1: 0/2) |
| **`built-ins/**/{name,length}.js` acceptance stratum**, 972 files | **971/972 agree with baseline; 0 baseline-pass → FAIL**, 1 baseline-fail → PASS |
| unit + neighbour guard suites (9 files) | 100/100 |

The 972-file stratum is a **standing control adopted from this park**: it is
uniformly hit by `propertyHelper.js` and invisible from descriptor-area sampling.
One arm is exact here because every row is baseline-scored.

### Why v1's controls could not have caught it

Not "my controls missed it" — **the controls were incapable of seeing it**, two
ways, and both are now closed:

1. **`runTest262File` does not apply the #2961 host-import refusal.**
   `standaloneHostImportError` is called only from `runSyntheticTest262File`, so
   every runner-based control is structurally blind to `host_import_leak_class`
   — the axis the floor scores. An imports check now goes into every standalone
   control from the start (`WebAssembly.Module.imports` / `result.imports`, with
   a positive control, since "0 imports everywhere" is otherwise indistinguishable
   from a broken probe).
2. **The affected population was disjoint from every stratum sampled.** v1's
   controls were 45 negative-`hasOwnProperty` files and 40 descriptor-area
   passing files. The regression lived in ~700 `name`/`length` files asserting
   `configurable: true` on a property that legitimately exists — a *third*
   direction neither stratum covers.

A corpus-wide 220-file pass→fail sweep run during the diagnosis did catch it
independently (**7 pass→FAIL, all `name.js`/`length.js`, all "descriptor should
be configurable"**, 3.2 % vs the artifact diff's 2.6 %) — so the sweep *axis* was
sound and only the *stratum* was wrong.

### Deliberately NOT shipped — the ARRAY half

A vec arm was written, **measured unreachable, and removed rather than shipped as
decoration**. `fillVecHasOwnHelpers` (`vec-overlay.ts`) **unshifts** a prologue
into `__hasOwnProperty` that answers from `__vec_gopd` and `return`s for EVERY
vec receiver. Probe: `a=[1,2,3]; a.q=5` gives `a.q === 5`,
`a.hasOwnProperty("0") === true`, `a.hasOwnProperty("9") === false`, but
`a.hasOwnProperty("q") === false`. That is the #3251-overlay-vs-#3537-bag split
filed as **#4010**. Pinned by a test so it stays a decision, not an oversight.
**This slice fixes a symptom, not the substrate.**

## REFUTED and NOT shipped — `isOpenDescriptorShape` is worth +0

`isOpenDescriptorShape` (`src/codegen/property-descriptor-shape.ts`) excludes any
anon struct carrying an `enumerable` field from `fillClosedStructExternGetArms`'
closed-struct read arms — and **from nothing else**:
`fillClosedStructHasOwnArms` and `fillClosedStructOwnPropertyNamesArms` never
consult it. The object therefore reports it OWNS the key and enumerates it, then
reads `undefined` for it:

```js
var d = {};  d.enumerable = true;
d.hasOwnProperty("enumerable");        // true
Object.getOwnPropertyNames(d);         // includes "enumerable"
d.enumerable;                          // undefined   <- the defect
```

Attribution proven by kill-switch A/B on a minimal probe (0 → 1), with a
same-program control on the key `zzz` (works) isolating the key name as the
discriminator. **It is a real defect.** It also flips nothing:

| stratum | denominator | n | fail→PASS | pass→FAIL |
|---|---|--:|--:|--:|
| failing files with `.enumerable =` (the exact trigger) | **census** — all 35 | 35 | **0** | 0 |
| failing files with an `enumerable:` literal | 40 sampled of 270 | 40 | 0 | 0 |
| spillover: failing descriptor-area files with no `enumerable` at all | 30 sampled of 390 | 30 | 0 | 0 |
| currently-PASSING control | 40 sampled of 757 | 40 | 0 | **0** |

Instrument validated **145 / 145** against the published baseline.

**Why it is inert, which is the part worth keeping:** the test262 shapes in this
lever build their descriptors on **exotic carriers** — `descObj = function(){}`,
`new RegExp()`, `new Date(0)`, `new Error()` — not on widened plain objects, so
they never reach the excluded shape at all. A global read-path change with 0
measured benefit and an interception hazard that could not be cleared (the
docstring cites descriptor structs being intercepted via WasmGC layout
canonicalisation, and no repro was found) is not worth the risk. Left in place.

## Also refuted: this does NOT subsume #4062

#4062's repro (`arr.hasOwnProperty("length")` vs
`getOwnPropertyDescriptor(arr,"length")`) is **byte-identical base vs treatment**
under both mechanisms above. Different root cause; no subsumption. #4061
(descriptor-ARGUMENT validation) is untouched — it is about *rejecting*
malformed descriptors, this is about *reading* well-formed ones.

## What the 835 was

835 is the population GATED by the descriptor model, never a flip forecast — the
sizing caution in the original body was correct. This slice takes the
function-carrier stratum of it, 78 files, and flips 14.

## Residual for the next lane

- **Non-function exotic carriers** (`RegExp`, `Date`, `Error`) have **no bag at
  all**: `new RegExp("a").zzz = true` does not round-trip in standalone, so their
  descriptor reads cannot be fixed by wiring an existing substrate. That needs a
  new carrier bag (or the #4010 reconciliation), and stratum **W** measuring 0/40
  is consistent with it.
- **Array carriers** — #4010, per the boundary above.
- **`isOpenDescriptorShape`** — real defect, currently inert; revisit if a
  consumer ever appears.
