---
id: 4055
title: "LEVER 1 — property-descriptor model in standalone: 835 ≤ES5 failures across defineProperty/defineProperties/create/gOPD"
status: done
sprint: current
created: 2026-08-02
updated: 2026-08-02
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
# `src/codegen/carrier-bag-hasown.ts`. What lands in the god-file is the
# irreducible splice: one import, a three-line rationale comment, one call, and
# one entry in the locals list — +4 LOC, +3 in `ensureObjectRuntime`. The bail
# body (including its terminal `i32.const 0; return`) was deliberately moved
# INTO the module so the arm and the answer it falls through to stay one
# decision; that is what took the growth from +17/+16 down to +4/+3. There is no
# smaller shape: `emitHasOwn` registers the helper, so the local must be declared
# at the registration site.
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
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

## SHIPPED — `__hasOwnProperty` never got the carrier own-property bag

`src/codegen/carrier-bag-hasown.ts` (new) + a 4-line splice into `emitHasOwn`.

#3468 (closures) gave `__extern_get` / `__extern_set` / `__extern_method_call` a
fallback for a receiver that is not a `$Object`: an identity-keyed side table
mapping the carrier to a `$Object` "bag" of its own properties.
**`__hasOwnProperty` was never wired to it** and still bailed with `0` on
`ref.test $Object`. So a function denied a property it had just stored *through
the same substrate*:

```js
var f = function () {};
f.enumerable = true;
f["enumerable"];                 // true   — __extern_get reads the bag
f.hasOwnProperty("enumerable");  // false  — the gap
```

That is not merely a wrong boolean. `__obj_define_from_desc`'s
ToPropertyDescriptor (§6.2.5.6) gates **every** descriptor field on
`HasProperty` before reading it, so a **Function descriptor carrier** — the
dominant test262 spelling, `var descObj = function(){}; descObj.enumerable =
true;` — produced an EMPTY descriptor and CompletePropertyDescriptor filled in
`undefined` plus all-false attributes. Silently: no refusal, wrong content.

This is **instance #7 of the #4080 family**: a correct treatment exists and one
consumer never got wired to it.

### Why this is NOT the carrier-bag arm #4047 measured at +6 and reverted

That arm resolved a **`Properties` map** through the bag. Enumerating a map needs
a COMPLETE own-key source and the bag is not one — `props.p = v` lands in the
bag while `Object.defineProperty(props,"p",…)` lands in the separate #3251
overlay (Array) or nowhere (Function) — so it enumerated empty, defined nothing
and returned normally.

`hasOwnProperty(k)` is a **fixed-key presence query**. It needs no key source at
all, and the bag is exactly where `__extern_set` put the write, so presence and
read agree by construction. `Object.defineProperty(fun,"p",…)` still lands
nowhere and this arm still answers `false` for it — the same answer as today, so
no new inconsistency is introduced. `tests/issue-3957.test.ts` and
`tests/issue-3468-closure-own-props.test.ts` both still pass.

### Measured: +14 flips, 0 regressions

Instrument validated first: the BASELINE arm agreed with the published standalone
baseline on **203 / 203** rows.

| stratum | denominator | n | base pass | treat pass | fail→PASS | pass→FAIL |
|---|---|--:|--:|--:|--:|--:|
| **T** failing ≤ES5 descriptor-area files with a FUNCTION descriptor carrier | **census** — all 78 | 78 | 0 | 14 | **+14** | 0 |
| **W** failing with an expando descriptor build on a NON-function carrier | 40 sampled of 98 | 40 | 0 | 0 | 0 | 0 |
| **N** currently-PASSING files asserting a **FALSE** `hasOwnProperty` result | 45 sampled of 206 | 45 | 45 | 45 | 0 | **0** |
| **C** currently-PASSING descriptor-area files | 40 sampled of 1,775 | 40 | 40 | 40 | 0 | **0** |

Stratum **N** exists because this change is **bidirectional** — it flips
`hasOwnProperty` false→true, so the failure mode to detect is OVER-reporting. It
is sampled from files that assert a *negative* `hasOwn` result across
`built-ins/{Object,Function,Array}`. Zero moved.

- **Flip ratio on the targeted population: 14 / 78 = 17.9 %** — a CENSUS of the
  function-carrier stratum, not a sample, so no extrapolation is involved.
- Load was 11.98 entering the baseline arm and 10.52 entering the treatment arm;
  both arms produced **0 `compile_error`** rows, so no contention flake to
  re-run solo.
- Attribution proved by **kill-switch removal**: the baseline arm is the same
  worktree with the carrier arm suppressed, so `emitHasOwn`'s bail falls straight
  through to `i32.const 0`. The shipped source was then re-run over the T census
  to confirm it reproduces the treatment arm exactly (see below).

### Vacuity audit of the 14 flips

Every one carries at least one POSITIVE assertion; none is satisfiable by a
silent no-op:

- `obj.property === "Function"` / `"functionGetProperty"` — a real value, and in
  `-3-218` a **getter that must fire** (`create/15.2.3.5-4-244`,
  `defineProperties/15.2.3.7-5-b-{125,204}`, `defineProperty/15.2.3.6-3-{139,218}`)
- `accessed !== true` — for-in must SEE the property
  (`create/15.2.3.5-4-59`, `defineProperties/15.2.3.7-5-b-19`,
  `defineProperty/15.2.3.6-3-33`)
- `result1 === true` (`create/15.2.3.5-4-112`, `defineProperties/15.2.3.7-5-b-72`)
- `beforeWrite && afterWrite` — `writable` honoured (`15.2.3.6-3-165`);
  `beforeDeleted === true` — `configurable` honoured (`15.2.3.6-3-86`)
- `hasProperty !== true` + `data === "overrideData"` — a **setter that must
  fire** (`create/15.2.3.5-4-279`, `defineProperty/15.2.3.6-3-248`)

`15.2.3.6-3-248` asserts `obj.hasOwnProperty("property")`, which would be
circular if `obj` were the changed receiver — it is not: `obj` is a plain `{}`
and the carrier is `funObj`. Its companion `data === "overrideData"` is an
independent positive.

### Deliberately NOT shipped in this slice — the ARRAY half

A vec (array) arm was written, **measured unreachable, and removed rather than
shipped as decoration**. `fillVecHasOwnHelpers` (`vec-overlay.ts`) **unshifts** a
prologue into `__hasOwnProperty`/`__object_hasOwn` that answers from
`__vec_gopd` and `return`s for EVERY vec receiver, so no arm placed in the body
can be reached for an array. Probe: `a=[1,2,3]; a.q=5` gives `a.q === 5`,
`a.hasOwnProperty("0") === true`, `a.hasOwnProperty("9") === false`, but
`a.hasOwnProperty("q") === false`.

That is the #3251-overlay-vs-#3537-bag split — the two disjoint identity-keyed
side tables filed as **#4010** — and reconciling them is that issue's job. The
boundary is pinned by the last case in `tests/issue-4055.test.ts` so it stays a
decision rather than an oversight. **This slice fixes a symptom, not the
substrate**, and says so.

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
