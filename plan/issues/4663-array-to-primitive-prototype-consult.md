---
id: 4663
title: "standalone: `__array_to_primitive_string` is a hard-coded join(\",\") with no prototype consult — `\"\" + a` ignores an overridden Array.prototype.toString (FIXED: gated Array-companion consult; the recursion blocker was real only through the native-proto SEEDER)"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-24
completed: 2026-08-24
assignee: ttraenkler/senior-dev-4663
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: to-primitive
goal: standalone-gap
related: [4655, 4492, 4641, 3580]
loc-budget-allow:
  # (#4663) `protoIndexBrandCompanionHasInstrs` — the Array-companion-ONLY
  # presence probe — belongs HERE and nowhere else: it is built from
  # `resolveFillDeps`, which is module-private, and from the brand-offset
  # constants. Hosting it elsewhere would mean exporting the store's fill
  # dependencies, which is strictly worse coupling than +69 lines. Most of
  # those lines are the doc explaining why `__protoidx_has_r` is the WRONG
  # helper for a caller standing at a level the builtin already owns — the
  # part that stops the next lane reintroducing the Object.prototype tail.
  - src/codegen/proto-index-store.ts
origin: "dev-4492 measured the defect; dev-4655 read the emitter, confirmed the root, and DECLINED it with a named blocker — 'real target, correct root, wrong size'. Filed by the lead so the blocker is not rediscovered from the call site."
---

# #4663 — the `+` path never consults `Array.prototype.toString`

## Root (confirmed by reading the emitter, not inferred)

`fillArrayToPrimitive` (`src/codegen/array-to-primitive.ts`, 207 lines) builds
`__array_to_primitive_string` as a hard-coded `join(",")` loop with **no
prototype consult**, and `__to_primitive`'s vec arm calls it. So with
`Array.prototype.toString` overridden:

| receiver | `String(x)` | `x.toString()` | `"" + x` |
| --- | --- | --- | --- |
| `var a = new Array` | ✓ | ✓ | **✗** |

`String(a)` and `a.toString()` honour the override; `"" + a` does not.

## Why this is NOT a small fix — read before starting

The obvious repair is the machinery #4655 shipped for the element step:
`m = __extern_get(arr,"toString"); if (m) return ToString(__apply_closure(m,arr,null)); else <inline join>`.
dev-4655 is the lane that just built that and **declined this anyway**:

- **The consult resolves `"toString"` whether or not the user overrode it.** If
  any path installs `Array.prototype.toString` reflectively, the driver calls a
  `toString` that routes back through `__to_primitive`'s vec arm →
  **unbounded recursion on a hot path**: `Number([1])`, `"1,2" == [1,2]`,
  `1 + [2]`, every array-in-string-concat.
- There is **no cheap "is this the builtin?" test** in that driver — no identity
  carrier for the builtin to compare against.
- The shape that works is a **user-override flag**: a module-level global set
  when user code assigns to `Array.prototype.toString`, with the driver
  consulting only when the flag is set. That is an assignment-site change in
  another subsystem plus a runtime global — a slice, not a rider.

**Start from the recursion question, not from the consult.**

## Measurement warning specific to this area

A JS-level probe does NOT establish what `__extern_get` sees. dev-4655 hit this
in #4655: an object literal is a CLOSED `$__anon_N` struct, so
`__extern_method_call` resolves null on it while the *same* object reached via a
computed member call works. Any "does the reflective read see it" claim here must
come from an **emitted arm**, not from a probe.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully.
   Especially methodology 6 (a table only evidences the axes it varies), 8 (a
   residual is a CLAIM — probe the negative case; carry positive controls), the
   counts rule (`total > 0 && passed + failed == total` off the summary line,
   never the exit status), the contention trap (serially re-verify every
   apparent flip AND regression), and the `test262` GITLINK hazard.
2. Settle the recursion design FIRST and record it before writing the consult.
   Establish where a user assignment to `Array.prototype.toString` can be
   observed, and whether a module-level override flag is sound for the
   reflective-install paths as well as the syntactic one.
3. Absent-not-wrong: if the flag cannot cover a reflective install, DECLINE the
   consult for that shape rather than recursing or answering wrongly.
4. Pins must EXECUTE the concatenation and read the result, and carry a positive
   control — an array whose prototype has NO override must still render
   `join(",")` — so the suite claims the prototype consult rather than "string
   concatenation works". dev-4492's residual pins in
   `tests/issue-4492-wave5.test.ts` cover this row and should be flipped from
   `it.fails` by whoever lands it.

## Related: the inline-vs-named receiver half is NOT filed here

dev-4492 measured that an INLINE receiver (`String([1,2])`) ignores the override
while a NAMED one honours it — the shape `built-ins/String/S15.5.1.1_A1_T8`
uses. dev-4655 reframed that half, and the reframing is the useful part: it is
**carrier selection decided before the operation runs**, the same axis as its own
#4655 residuals R3 (`toString/S15.4.4.2_A1_T2` — a var whose wasm carrier was
fixed to `f64` first renders `",1,0,3"` while a fresh var renders `",1,,3"`) and
R4 (`concat` results whose slot stays statically `number[]`, turning holes and
inherited indices into `NaN`). So it belongs with the **value-rep carrier** work
alongside #4641 and #3580, not with the String-conversion path — and a lane
fixing it there will likely move all three rows at once.

## Lead ruling: the recursion blocker is already solved in-tree — do NOT build a runtime override flag (2026-08-24)

#4655 declined this issue on the grounds that "there is **no cheap 'is this the
builtin?' test** in that driver", so the only sound shape was "a module-level global
set when user code assigns to `Array.prototype.toString` … an assignment-site change
in another subsystem plus a runtime global — a slice, not a rider."

**That test exists.** `src/codegen/builtin-proto-member-override.ts` is the same
problem, already solved, for method **call** sites. Read its header before anything
else. Its shape is:

```
__protoidx_has_r(recv, "<m>") ? apply the companion entry : the builtin
```

and the load-bearing sentence is in its own doc:

> Under `protoNamedDirty` alone the companion is seeded with NOTHING
> (`protoMemberDirty` drives seeding and a proto WRITE deliberately does not set it),
> so `has` is exactly **"the user overrode this member"**, not "this member exists".

That is the missing predicate. **The recursion this issue is blocked on cannot happen
through it**, because a companion hit can only ever be a value user code installed —
`__protoidx_has_r` can never hand back the builtin `toString` that would route back
into `__to_primitive`'s vec arm. The unbounded-recursion hazard was a property of
`__extern_get`-and-resolve, not of the consult as such.

(If the user's own override does `"" + this`, that recurses — but that is the user's
own infinite recursion and V8 does the same. Not our problem to prevent.)

### Gating — this is what makes it a rider, not a slice

Three gates, all compile-time, all already built:

1. `ctx.standalone`
2. `ctx.protoNamedDirty` — a **pre-scan** flag, so a module that never overrides does
   not merely leave the arm dead, it never builds it (byte-identical output)
3. `ctx.protoNamedWrittenMembers.has("toString")` — the #4492 wave-5 member-name set.
   `src/codegen/callable-any-to-string.ts:157,235` **already uses this exact predicate**
   for the `Function.prototype.toString` side. Copy that precedent; do not invent a new
   flag.

`isProtoNamedWrite` (`src/codegen/array-holes.ts:690`) reaches
`Array.prototype.toString = f` through its property-access-assignment arm, which has no
Array exclusion.

### The one thing you must MEASURE, not assume

`isProtoNamedWrite` **deliberately excludes `Array.prototype`** from its element-access
and `defineProperty` arms, on the stated grounds that those forms already set
`protoIndexDirty`, "which reserves the same store". So:

- `Array.prototype.toString = f` → sets `protoNamedDirty` **and** records `"toString"`. Covered.
- `Object.defineProperty(Array.prototype, "toString", …)` → sets `protoIndexDirty` but
  **not** `protoNamedDirty`, and records **no member name**.

Establish from an **emitted arm** (not a JS probe — see the measurement warning above)
whether the companion is armed and `__protoidx_has_r` answers for the `defineProperty`
form. If it does not, that shape is **absent-not-wrong**: leave it on the inline join,
say so in the report, and do not widen `isProtoNamedWrite` to reach it as part of this
issue — that predicate's Array exclusion is load-bearing for `protoIndexDirty` and
changing it is its own blast radius.

### Revised sizing

Rider, not slice. One gated two-arm branch in `fillArrayToPrimitive`
(`src/codegen/array-to-primitive.ts`), modelled on `builtin-proto-member-override.ts`
and gated by `callable-any-to-string.ts`'s predicate. A module that does not override
`Array.prototype.toString` must compile **byte-identically** — verify that with a
`wasm_sha` comparison, which is a stronger and far cheaper zero-regression argument
than a wide sweep (the technique #4655 used when its own full sweep was OOM-killed).

### Correction to the ruling above — the gate alone is NOT sufficient (lane-4663, 2026-08-24)

The lane objected before writing any code, and it was right. Recorded here because the
ruling as first written would have shipped a regression.

`ctx.protoNamedWrittenMembers` is **member-name-only, not ctor-qualified** —
`array-holes.ts:96` is `ctx.protoNamedWrittenMembers.add(lhs.name.text)`. And
`__protoidx_has_k`'s walk (`fillHasKBody`, `src/codegen/proto-index-store.ts` ~L922)
probes `firstOff`'s companion **and then falls back to Object's** whenever
`firstOff != OBJ_OFF`.

Composed, those two facts break a shape that works **today**: a module writing only
`Object.prototype.toString = f` arms the gate, and the arm then answers *Object's*
override for `"" + [1,2]` — where real JS keeps `Array.prototype.toString`'s join,
because Array's builtin **shadows** Object's (`[1,2].toString()` stops at
`Array.prototype`). Consulting Object's companion here is wrong, not merely coarse.

**Ruled: make the RUNTIME probe precise, leave the compile-time gate coarse.**

Build an Array-companion-**only** probe from `companionProbeArm` at `ARR_OFF` — the same
first arm `fillHasKBody` uses, **without** the Object tail:

- Object-only override → gate arms, arm builds, arm **misses** → inline join → today's
  correct answer preserved.
- `Array.prototype.toString` override → hits → user value applied.

The gate then only decides whether to *build* the arm; it can no longer make the arm
answer wrongly. This is strictly preferable to ctor-qualifying `protoNamedWrittenMembers`,
which would mean editing the `array-holes.ts` pre-scan whose Array exclusions are
load-bearing for `protoIndexDirty` — the blast radius this issue is explicitly scoped out of.

**Required pin (negative control), not a note:** a module that writes ONLY
`Object.prototype.toString = f` must still render `"" + [1,2]` as `"1,2"`. Alongside the
positive control (no override at all → `join(",")`).
---

## Implementation record (dev, 2026-08-24)

Branch `issue-4663-array-to-primitive-proto-consult`, worktree
`/home/user/js2wasm/.claude/worktrees/agent-a9f9eebcfb244eff0`, based on the campaign
tip `a8a611344` (merged in as `6fde4ceb7`).

### Root cause

Confirmed by reading the emitter, and the ruling's framing is right: the whole of
`fillArrayToPrimitive` was the join, and `__to_primitive`'s vec arm
(`object-runtime.ts` ~L4739) is the ONLY caller. `String(a)` and `a.toString()` never
reach it — they are claimed by compile-time lowerings that already consult the
override — which is exactly why the three spellings disagreed.

### Fix

Two files, +193 lines, no behaviour outside the gate.

1. **`src/codegen/proto-index-store.ts`** — new export
   `protoIndexBrandCompanionHasInstrs(ctx, brandOff, key, scratchLocal)`: a presence
   probe against ONE brand companion with **no `Object.prototype` tail**, plus
   `PROTOIDX_ARRAY_BRAND_OFF`. Lookup-only (`create = 0`).
2. **`src/codegen/array-to-primitive.ts`** — `buildArrayToStringOverrideArm`, prepended
   to the driver body:

   ```
   if (arrayCompanionHas("toString")) { <shared §7.1.1.1 walk, order ["toString"]> }
   <the existing inline join, byte-for-byte>
   ```

   The walk is `buildOrdinaryToPrimitiveProbe` (`ordinary-to-primitive-probe.ts`) —
   the same builder the #4492 wave-5 callable arms use — so IsCallable, the arity-0
   `__call_accessor_get` bridge, the primitive test and the fall-through are shared,
   not re-implemented. A primitive result is returned **raw**, not stringified: the
   driver owes `__to_primitive` an `externref` and `__to_primitive` returns it
   verbatim, so a number-returning override makes `1 + a` yield `8`, not `"17"`.

Three locals are appended AFTER the join's four, so the join's own local indices — and
therefore its bytes — never move.

### The recursion blocker: the ruling is correct, but INCOMPLETE — measured

The ruling's argument holds as stated: under `protoNamedDirty` alone the brand
companion is seeded with nothing, so a companion hit can only be a user value and the
builtin is unreachable through it.

**It does not hold under `protoMemberDirty`, and that is a real regression, not a
theoretical one.** Reading a builtin prototype as a VALUE (`var p = Array.prototype`,
`Object.getPrototypeOf([])`) arms `ensureNativeProtoCompanionSeeder`
(`native-proto.ts`), which fills the brand companion with the GLUE's own members —
`toString` among them. The probe then hits the BUILTIN and the walk calls it. Measured
with the first cut of the arm: three modules that answer `"1,2"` on base threw
`WebAssembly.Exception` (`.tmp/p2.mts` rows F1/F2/F4). #4655's hazard, arriving through
the one door the companion predicate does not close.

Closed by a fourth gate: `nativeProtoSeedersByBrandOffset(ctx).has(ARR_OFF)` ⇒ decline.
The seeder REGISTRY is the exact question, not `protoMemberDirty` — a brand whose
`$NativeProto` was never materialized has no seeder and its companion stays user-only.
With the gate the three modules are **byte-identical to base** (`e9977134c767eaa3`,
`483da10785b6a8c3`, `09b472825fdea015`), which is what proves the arm is not built
rather than merely inert.

### The gate is COARSE and that is deliberate — I disagreed with the ruling and it was revised

The ruling first said to gate on `ctx.protoNamedWrittenMembers.has("toString")` and use
`__protoidx_has_r`. That combination answers **wrongly** for one shape:

- `protoNamedWrittenMembers` is member names only (`array-holes.ts:96` adds the bare
  `lhs.name.text`), so `Object.prototype.toString = f` arms it;
- `has_r` = `has_k(key, brand_off(recv))`, and `fillHasKBody` probes the receiver's
  brand companion **and then Object's** (`proto-index-store.ts` ~L922).

So a module overriding only `Object.prototype.toString` would have had `"" + [1,2]`
answer `"__OBJ__"` — but `Array.prototype.toString` is a real builtin (§23.1.3.32) and
SHADOWS `Object.prototype`'s, so `"1,2"` is correct. The lead's revised ruling: keep the
compile-time gate coarse (it only decides whether to BUILD the arm) and make the runtime
probe precise. That avoids ctor-qualifying `isProtoNamedWrite`, whose Array exclusions
are load-bearing for `protoIndexDirty`.

Measured both directions: an `Object.prototype.toString`-only module builds the arm
(bytes change, `7abc5acb8d023687` → `3b985c77646a77e3`) and MISSES at runtime, keeping
`"1,2"`. Pinned as a required negative control.

### The `defineProperty` shape: ABSENT, not wrong — measured from the emitted arm

`Object.defineProperty(Array.prototype, "toString", …)` **alone** does not arm the gate,
and the evidence is byte-identity, not a JS probe: that module compiles to
`wasm_sha b37f7e0e0971aeb4` on **both** arms — the arm is never built.
`isProtoNamedWrite` excludes `Array.prototype` from its `defineProperty` arm, so no
member name is recorded.

The companion itself is **fine**. Add any OTHER `X.prototype.toString =` write to the
same module and the same `defineProperty` install is honoured: `.tmp/p2.mts` row G1 flips
`0 → 1`. So the gap is purely the pre-scan's member-name recording, and closing it is a
one-line widening of `isProtoNamedWrite` — deliberately NOT done here, per the ruling.
Left on the inline join, pinned `it.fails`.

(Side finding, not mine to fix: on base, `a.toString()` in that same module also fails
(`B2 = 0`) and passes once another `toString` write arms `protoNamedDirty` (`G2 = 1`),
so `builtin-proto-member-override.ts`'s call-site arm has the same dependency.)

### Measurements (all runs executed by this lane, serial where noted)

Method: file-copy A/B (`.tmp/base-array-to-primitive.ts`, `.tmp/base-proto-index-store.ts`
captured at the first edit), `git diff HEAD --stat` before every arm. That detector
earned its keep once: a `.tmp/new-*.ts` snapshot taken BEFORE the seeder-gate edit
restored a partial change, and the 105-vs-124 line count in `git diff HEAD --stat` is
what caught it.

**Flips, `"" + a` family** (base → after, one module each, `.tmp/p1.mts` / `p3.mts` / `p4.mts`):

| spelling (override returns `"OV"`) | base | after |
| --- | --- | --- |
| `"" + a` (`new Array`) | ✗ | ✓ |
| `"" + a` (`[1,2]`) | ✗ | ✓ |
| `a + ""` | ✗ | ✓ |
| `a == "OV"` | ✗ | ✓ |
| `1 + a` | ✗ | ✓ |
| `+a` / `a - 1` / `a * 2` (override `"7"`) | `undefined` | `7` / `6` / `14` |
| override returns `7` → `1 + a` | `undefined` | `8` |
| override reads `this.length` | ✗ | ✓ |
| `String(a)` / `a.toString()` | ✓ | ✓ (unchanged) |
| `` `${a}` `` | ✗ | ✗ (residual, below) |

**Byte-identity (the zero-regression argument).** Nine adjacent modules, `wasm_sha`
identical on both arms: no-override `"" + [1,2]` `30590fb19f68a3c6`, `"" + []`
`31467a2f105368dc`, `Number([1])` `2ed66ac0ed41c836`, `a + ""` `f30dc6624a202578`,
`` `${a}` `` `e046629181026ca3`, `[7] - 1` `207427ee35f63ea3`, holes `[1,,3]`
`6dbcf98b67b64db7`, `Array.prototype.join`-override-only `086e3f1b584f8cb0`, and the
three seeder modules above. A module that does not write `<BrandedBuiltin>.prototype
.toString` emits the same bytes it did before.

**Corpus reach.** The gate can only be armed by a syntactic
`<BrandedBuiltin>.prototype.toString =` write. `Test262Error` is NOT in
`BUILTIN_BRAND_TABLE`, so `harness/sta.js:18` — present in essentially every test262
module — does **not** arm it. Exactly **41** corpus files arm it (sweep A below).

### Test Results

- `tests/issue-4663.test.ts` (new, 23 tests): `Tests 23 passed (23)`, no `skipped` on
  the file line. Sensitivity: with only the two source files reverted, **10 of the 23
  fail**; the residual `it.fails` pins keep failing-as-expected.
- `tests/issue-4492-wave5.test.ts`: `Tests 34 passed (34)`. Its `"" + a` residual pin is
  flipped from `it.fails` to a plain `it`; on reverted source that pin fails, giving
  `11 failed | 46 passed (57)` across the two files.
- Scoped standalone test262 sweep, **serial** (one worker, to keep the contention trap
  out of the numbers): 631 rows × 2 arms. See `## Sweep` below.

### Residuals (with owners)

1. **`` `${a}` `` ignores the override** — measured 0 on BOTH arms; a different
   dispatcher claims the template substitution before `__to_primitive`. Same
   carrier-selection axis as #4492's R1 and #4655's R3/R4 ⇒ **value-rep carrier work
   (#4641 / #3580)**, not this issue. Pinned `it.fails`.
2. **`Object.defineProperty(Array.prototype, "toString", …)` alone** — absent, not
   wrong; see above. Owner: whoever takes the `isProtoNamedWrite` member-name widening.
   Pinned `it.fails`.
3. **`Number(a)` traps ("illegal cast") when the override returns a NUMBER** —
   PRE-EXISTING and unchanged (identical on both arms; with a STRING-returning override
   `Number(a)` already answered `7` on base, so it does not go through this driver).
   Pinned `it.fails` so it is not misread as a consequence of the raw-primitive return.
4. **`Array.prototype.valueOf` overrides are out of scope** — the gate is keyed on
   `toString` and the walk's `order` is `["toString"]`. Arrays inherit
   `Object.prototype.valueOf`, which returns the object, so §7.1.1.1 reaches `toString`
   for both hints and the omission is invisible except for an explicit `valueOf`
   override.
5. **A `null`-returning override keeps the join** — deliberate, inherited from
   `ordinary-to-primitive-probe.ts`: standalone `null` and `undefined` are one
   externref, and the module carries both renderings, so the walk declines rather than
   picking one. An `undefined`-returning override DOES now answer `"undefined"` (the
   spec answer; base rendered the join). Both pinned.

### Sweep

**Serial** (one worker), standalone lane, `runTest262File(..., 20000, "standalone")`,
both arms run by this lane from the same worktree via file-copy A/B. Serial deliberately:
three lanes were sweeping this 4-core box concurrently and a parallel run manufactures
timeouts that read as regressions.

| arm | rows | pass | fail | compile_error | skip |
| --- | --- | --- | --- | --- | --- |
| base (`6fde4ceb7`, source reverted) | 187 | 101 | 75 | 3 | 8 |
| after | 187 | 101 | 75 | 3 | 8 |

**Flips: 0. Regressions: 0. Other status changes: 0.** The 3 `compile_error` rows are the
real `standalone dynamic import is unsupported` refusal on both arms (not timeouts); the
8 skips are `staging/sm`.

**Scope, and why it is small on purpose.** The arm can only be BUILT by a syntactic
`<BrandedBuiltin>.prototype.toString =` write, and outside that the module is
byte-identical (nine `wasm_sha` pairs above). So the sweep is not a sample of a large
blast radius — **sweep A is the COMPLETE reachable set corpus-wide**: 42 files,
regenerated from the actual `BUILTIN_BRAND_TABLE` rather than a hand-typed name list
(`.tmp/armset.mjs`; the hand-typed first pass missed
`built-ins/TypedArray/prototype/sort/BigInt/sortcompare-with-no-tostring.js`, which was
then measured separately, `fail -> fail`). Sweep B adds 145 rows of the operation
families the arm sits under — `Array/prototype/{toString,join,toLocaleString}`,
`Object/prototype/{toString,toLocaleString}`, `language/expressions/addition` — as the
"did the arm's presence perturb the join path" check.

**Dropped deliberately, and named:** `built-ins/String` root + `String/prototype/split`,
`built-ins/Date` root, `built-ins/Error`, `built-ins/Array` root,
`language/expressions/property-accessors`, `built-ins/Number/prototype` — **minus their
arming files, every one of which is in sweep A**. Those directories' non-arming rows are
byte-identical by construction, and the first attempt at sweeping them whole was running
at ~20 s/row under three-lane contention (631 rows × 2 arms ≈ 7 h) for zero information.

### Verdict — state this plainly: NO conformance movement

The fix is correct and regression-free, and it moves **no test262 row**. That is not a
gap in the sweep — the reachable set is complete, so no row anywhere in the corpus can
move. The corpus simply has no `"" + <array>` row under an `Array.prototype.toString`
override; the census row #4492 attached to this family,
`built-ins/String/S15.5.1.1_A1_T8`, is the **inline-receiver** half (`String(new Array)`)
which #4655 reframed as value-rep carrier selection (#4641/#3580) and which correctly
does not move here.

What it buys: a real spec divergence closed on five spellings (`"" + a`, `a + ""`,
`a == s`, `1 + a`, the whole number-hint family), #4492 wave-5's `"" + a` residual pin
flipped from `it.fails` to green, and #4655's "no cheap is-this-the-builtin? test"
blocker retired with the seeder caveat documented so the next lane does not rediscover it
as a trap.
