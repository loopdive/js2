---
id: 3957
title: "standalone Object.defineProperties: descriptor read must be [[Get]], and a statically-shaped Properties map must expand"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
priority: high
horizon: m
complexity: M
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: property-descriptors, object-defineproperties
es_edition: es5
goal: es5
related: [1906, 3246, 2992, 3251, 3782, 3661, 3662, 3663, 739]
assignee: ttraenkler/sendev-descriptors
origin: "2026-08-01 sprint-78 LEVER 1 measurement of the ≤ES5 STANDALONE descriptor-model failure population."
# (#3102 ratchet) Both fixes are edits to EXISTING helpers that only exist in
# these two files, so there is no subsystem module to move them to:
#   - object-runtime-descriptors.ts (+37): the `__defineProperties` gather body.
#     ~30 of the 37 lines are the two rationale comments — the [[Get]]-vs-slot
#     explanation, and the load-bearing note on why the `ref.test $Object` gate
#     must STAY (removing it silently no-ops and manufactures vacuous passes;
#     that is exactly the trap this PR measured and rejected, so the comment is
#     the guard against the next agent redoing it).
#   - object-ops.ts (+15): widening #3782's own `stableDescriptorMapEntries`
#     receiver gate, in place, plus its rationale.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-ops.ts
# (#3400 R-FUNC) Same growth seen per-FUNCTION. Both edits are in-place changes
# to the one existing builder/compiler for this operation; splitting either to
# dodge the ratchet would separate a wasm instruction sequence from the
# rationale comment that explains why it must not be "simplified" — which is
# the specific regression this PR measured and rejected.
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-ops.ts::compileObjectDefineProperties
---

# #3957 — standalone `Object.defineProperties`: `[[Get]]` the descriptor, and expand a statically-shaped `Properties` map

## Measured population (instrument validated before use)

Baselines: `.test262-cache/test262-standalone-current.jsonl` and
`test262-current.jsonl`, both from promote cycle `20260801-010858`. Scope =
files carrying `es5id:` frontmatter in the corpus (8,262 files) ∩
`scope_official: true`.

**Instrument validation.** The same scoping script applied to the DEFAULT lane
unscoped, `scope_official && status != skip`, yields **30,500 pass** — the
published landing-page figure exactly. Standalone ≤ES5 then reproduces the
sprint baseline exactly: **5,652 / 8,115 = 69.6 %, 2,463 failures**, and the
per-area failure counts match the dispatch brief row for row
(`defineProperty` 337, `defineProperties` 272, `create` 152,
`getOwnPropertyDescriptor` 35, `Object/prototype` 23, `isExtensible` 16).

### The partition that reshapes the lever

The descriptor-model areas (`Object/{defineProperty,defineProperties,create,
getOwnPropertyDescriptor,prototype,isExtensible,preventExtensions,isSealed,
isFrozen,seal,freeze,keys,getOwnPropertyNames}`) carry **903 ≤ES5 standalone
failures out of 2,740 run**. Cross-referencing each failing file against the
DEFAULT lane:

| partition                                         | count | owner                        |
| ------------------------------------------------- | ----: | ---------------------------- |
| **A — standalone-specific** (default lane PASSES) |   387 | this lane                    |
| **B — shared defect** (default lane fails too)    |   516 | #3661 / #3662 / #3663 / #739 |

**57 % of the "standalone descriptor" lever is not standalone-specific at all.**
Part B tests fail in _both_ lanes on the same descriptor semantics
(`accessed !== true`, `writable` reading back wrong, `Expected a TypeError …`),
which is why the _ownership_ split matters: Part B is the assigned population
of #3661/#3662/#3663, and this issue deliberately stays off their ground by
fixing only standalone-side mechanics.

**But the partition is NOT a flippability predictor — measured, not assumed.**
The natural prior ("if the default lane fails the same file, standalone can at
best reach the same failure, so Part B cannot flip") predicted +0 on Part B. The
census measured **+8 there vs +3 on Part A** — the prior was wrong, because a
standalone _refusal_ and a default-lane _semantic_ failure can be independent
defects in the same file. Neither 835 nor 387 is a flip forecast; only the
measured census below is.

## Root causes (two, both in the plural gather path)

The largest explicit signature in Part A is the refusal
`TypeError: Object.defineProperties unsupported descriptor shape in standalone
mode (#1906)` — 26 Part-A records (67 across both partitions). Reading the
gather helper `__defineProperties` in
`src/codegen/object-runtime-descriptors.ts` found two distinct defects behind
it.

### RC1 — the descriptor was read from a raw SLOT, not `[[Get]]`

Pass 1 took each descriptor straight out of the enumerated `$PropEntry`'s
`value` field:

```
{ op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },   // entry.value
```

§20.1.2.3.1 step 3.b requires a real `[[Get]]`. The slot read is observably
wrong two ways:

1. **An ACCESSOR entry has its value slot cleared to null** by
   `__defineProperty_accessor` ("accessors hold no value" — it explicitly
   `struct.set`s `fieldIdx 1 <- ref.null`). So the slot read produced `null`,
   the null-descriptor guard rejected it, and the _entire call_ was refused —
   **even for a plain `{}` Properties map**. Building a `Properties` map with
   `Object.defineProperty(props, "prop", { get() {…}, enumerable: true })` is
   the single most common way test262 constructs one, so this refused a large,
   ordinary family.
2. A getter that must run for its **side effects** never ran.

Fix: `rawDesc = __extern_get(Properties, key)` — the accessor-aware `[[Get]]`
the rest of the runtime already uses. Its proto-walk is harmless here because
`__obj_ordered` has already restricted the KEY set to own enumerable keys.

### RC2 — a statically-shaped `Properties` map never reaches the helper

`var properties = { a: { value: 100, … } }` used only as
`Object.defineProperties(obj, properties)` is closed by shape inference into a
nominal struct. The helper's `ref.test $Object` gate then refuses it.

#3782 already built the right remedy — expand the plural call into per-key
`Object.defineProperty` calls when the map's key set is provably fixed — but
gated it on the receiver being a **function `prototype`**. That gate's real job
is to keep the receiver _re-evaluable without observable side effects_ (the
expansion compiles `objArg` once per key); "is a function prototype" was never
the load-bearing part. Widened to also accept a **bare identifier**, which is
the ordinary spelling.

## What was tried and REJECTED (recorded so it is not retried)

**Rejected: widen the `Properties` gate to a generic enumeration.** The obvious
fix — drop `ref.test $Object` and walk the map with
`__object_keys`/`__extern_length`/`__extern_get_idx` (the trio
`__extern_rest_object` uses) — is **unsound**, because
`__object_keys` (`src/codegen/object-runtime-enumeration.ts`) carries the
**identical** `ref.test $Object` gate and _returns an empty `$ObjVec`_ for every
other receiver:

```
{ op: "ref.test", typeIdx: objectTypeIdx },
{ op: "i32.eqz" },
{ op: "if", …, then: [{ op: "local.get", index: 7 }, { op: "return" }] },  // empty vec
```

So the "generic" route is not generic: it trades a loud refusal for a **silent
no-op**. Measured directly — with the gate removed,
`Object.defineProperties(obj, { a: { value: 100, … } })` on a closed-struct
literal defined _no properties_ and returned normally.

**This produced VACUOUS PASSES and would have been reported as a win.** The
unsafe variant scored **+5 / 26** on the targeted stratum. Four of those five —
`create/15.2.3.5-4-18`, `-4-21`, `defineProperties/15.2.3.7-3-3`, `-3-6` — are
tests whose whole assertion is `assert.sameValue(obj.hasOwnProperty("prop"),
false)` (an _inherited_ enumerable property must NOT be defined). A complete
no-op passes them. Only `create/15.2.3.5-4-19`, which asserts
`hasOwnProperty("prop") === true`, was a real flip. Fail-loud is a deliberate
#1906 property and it is kept; widening it needs the exotic-receiver own-key MOP
substrate (#2992 slices 2/5, #3251), which those issues declare has no bounded
slice.

**Rejected: pin the `Properties` map to `$Object` via shape widening.** Added a
`markStandalonePropertiesMapArgs` marker to
`src/codegen/declarations/object-shape-widening.ts` (arg-1 counterpart of the
existing arg-0 receiver pins). Two findings: (a) that pass only handles
`var X = {}` — an **empty** literal (`if (decl.initializer.properties.length >
0) continue`), so it is dead code for the shape that matters; (b) with it
enabled the probe `var obj = {}; var properties = {a:…,c:…};
Object.defineProperties(obj, properties)` **hit a 40 s compile timeout**.
Removing the marker (removal control) made the same probe pass in normal time,
so the marker was the cause. Dropped.

## Measurement protocol

Arms are same-box, same-run, same harness (`runTest262File(…, "standalone")`,
whose **pass/fail status only** is trustworthy — see
`reference_runtest262file_not_ci_path_status_only`). Row counts are floored
(`rows == expected` asserted, else exit 9) and the two arms' row SETS are
compared for identity before any delta is computed.

Stratified sample, deterministic seed:

- **targeted** — all 26 Part-A `unsupported descriptor shape` records;
- **spillover** — 20 random other Part-A failures (detects collateral);
- **regress-control** — 20 currently-PASSING ≤ES5 `Object/*` standalone tests
  (positive control: proves the harness can report `pass`, and detects
  pass→fail).

Baseline arm agreed with the CI baseline on **66/66** rows (targeted 0/26 pass,
spillover 0/20, control 20/20 pass).

### Box contention manufactures `compile_error` rows — control for it

A first treatment arm at a 30 s per-test compile timeout produced **9
`compile_error` rows** that the baseline arm did not have. They were **not
real**: the box was at load average **19.7 on 8 cores** (other agents), and two
of the nine (`15.2.3.7-6-a-110`, `-111`) had **passed in an isolated probe of
the identical source minutes earlier**. Re-running at a 180 s timeout gives zero
compile errors.

Two rules follow, and the final numbers below obey both:

1. **Raise the timeout above the contention floor** — a wall-clock timeout is
   not a property of the code under test when the box is oversubscribed.
2. **Run the two arms BACK-TO-BACK in one script** (`.tmp/lever1/both-arms.sh`)
   so they see comparable load. An arm measured at load 5 and compared against
   one measured at load 20 manufactures a delta in whichever direction the load
   happened to move. The A/B source swap uses **file copies**, never
   `git stash` (`refs/stash` is one shared stack across all worktrees).

## Measured result

**+11 flips, 0 regressions.** Every number below is a back-to-back same-box A/B
with floored, identity-checked row sets and a 180 s compile timeout; the
BASELINE arm is the removal control (the same worktree with both source files
reverted by file copy, run minutes after the treatment arm).

| stratum                                         | denominator         | n run | fail→PASS | pass→FAIL |
| ----------------------------------------------- | ------------------- | ----: | --------: | --------: |
| refusal signature, Part A (default lane passes) | **census** — all 26 |    26 |    **+3** |         0 |
| refusal signature, Part B (default lane fails)  | **census** — all 41 |    41 |    **+8** |         0 |
| Part-A non-refusal failures (collateral probe)  | 20 sampled of 361   |    20 |         0 |         0 |
| currently-PASSING ≤ES5 `Object/*` (regression)  | 20 sampled of 1,892 |    20 |         0 |     **0** |

- **Flip ratio on the targeted population: 11 / 67 = 16.4 %** — the population
  is the complete `unsupported descriptor shape` refusal signature, run as a
  CENSUS, not a sample, so this is the actual flip count for that signature and
  needs no extrapolation.
- Against the sprint's ≤ES5 standalone denominator (**8,115 run**), +11 is
  **+0.14 pp**: 69.6 % → 69.7 %. Against the 835-test lever the dispatch brief
  cited, it is **1.3 %** — 835 was the population GATED by the descriptor model,
  never a flip forecast.
- The collateral probe measured **0 / 20** flips outside the refusal signature.
  The point estimate for the remaining 341 Part-A failures is therefore 0; no
  positive extrapolation is claimed from a zero observation.
- **Part B was expected to be unflippable and was not.** The prior — "if the
  default lane fails the same file, standalone can at best reach the same
  failure" — predicted +0 there and measured **+8**, more than Part A. Recorded
  because it is a reusable correction: lane-partition is a good _ownership_
  split (it keeps this work off #3661/#3662/#3663's ground) but a poor
  _flippability_ predictor.

### Vacuity audit of the 11 flips

Every flipped test was re-read for the failure mode this issue already caught
once: a test whose entire assertion is "nothing was defined" passes vacuously
under a silent no-op. **All 11 carry at least one POSITIVE assertion** —
`assert(newObj.hasOwnProperty("prop"))`, `assert(result)` (a getter side
effect), `assert.sameValue(obj["a"], 100)`, or `verifyProperty(...)`. None is
satisfiable by a no-op. `15.2.3.7-3-8` carries a negative assertion too, but
its companion `assert(obj.hasOwnProperty("prop2"))` is positive, so it is a
real flip.

## Files

- `src/codegen/object-runtime-descriptors.ts` — RC1: `[[Get]]` the descriptor;
  spec-accurate `ToObject(null/undefined)` message; explicit comment pinning
  _why_ the `$Object` gate stays.
- `src/codegen/object-ops.ts` — RC2: widen the #3782 static-expansion receiver
  gate to any re-evaluable receiver.

**Lane gating.** RC2 is explicitly `ctx.standalone`-gated. RC1 lives in the
native object runtime, which `ensureLateImport` routes to only under
`(ctx.standalone || ctx.wasi)` (`src/codegen/expressions/late-imports.ts:444`) —
so it covers standalone **and wasi**, and the JS-host lane (which goes through
the `__defineProperty_desc` / `__defineProperties` host imports) is
byte-identical.
