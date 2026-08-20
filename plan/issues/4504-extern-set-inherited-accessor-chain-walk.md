---
id: 4504
title: "Standalone: inherited [[Set]] nearest-descriptor walk across objects and native companions"
status: done
sprint: current
created: 2026-08-15
updated: 2026-08-20
assignee: ttraenkler/codex
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [2175, 1888, 2668, 4206, 4479, 4491, 4515]
loc-budget-allow:
  # The shared four-state [[Set]] decision/result channel must live at the
  # existing public runtime boundary; the remaining entries are narrow
  # dispatcher/index-fixup integrations for that same decision.
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/typed-this.ts
  - src/codegen/registry/imports.ts
  - src/codegen/proto-index-store.ts
func-budget-allow:
  # These are existing reserve/finalize chokepoints whose instruction trees
  # must share one decision/result ABI. Splitting only the new branches would
  # duplicate index/local ownership across modules and recreate the remap risk
  # called out in this issue's principal risks.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/closed-struct-extern-set.ts::fillClosedStructExternSetArms
  - src/codegen/closed-struct-extern-set.ts::buildReceiverArms
  - src/codegen/vec-props.ts::fillVecPropHelpers
  - src/codegen/member-set-dispatch.ts::fillMemberSetDispatch
coercion-sites-allow:
  # Proxy [[Set]] must ToBoolean the set-trap result. This is one new call
  # into the existing shared __is_truthy engine, not a hand-rolled coercion.
  - src/codegen/object-runtime-proxy.ts
---

# #4504 — inherited `[[Set]]` nearest-descriptor walk

Split out of #2175's "P1" after a baseline probe disproved that issue's premise.
#2175 P1 framed this as a defect in the builtin-prototype COMPANION store; it is
not. The companion case is one special case of a general missing feature.

## Problem — §9.1.9 OrdinarySetWithOwnDescriptor step 3 is not implemented for
## inherited accessors

Assigning to a property whose nearest definition on the prototype chain is an
ACCESSOR must invoke that accessor's `[[Set]]` with the original receiver and
create **no** own property. Standalone instead creates an own data property,
silently shadowing the accessor.

### Evidence A — plain prototype chain, no builtin proto, no companion

`.tmp/q1.js` — `var proto = {}; Object.defineProperty(proto, "acc", {get, set});
var o = Object.create(proto); o.acc = 7;`

| assertion | spec | measured |
| --- | --- | --- |
| setter runs | yes | **no** |
| no own property created on `o` | none | **an own property IS created** |
| `o.acc` re-reads as 42 (the getter) | 42 | **not 42** |
| inherited DATA control: `o2.d = 5` creates an own prop, `proto2.d` unchanged | yes | yes OK |

Provenance: `--target standalone`, host-free. Measured on HEAD **and** on the
pre-P2 commit `3e69b1e34` — both return the same `700`, so the defect is
pre-existing and unrelated to #2175 P2 (which touched only `__hasOwnProperty` /
`__getOwnPropertyDescriptor`).

### Evidence B — builtin prototype via the companion store (the original "P1")

`.tmp/p4.js` — `Object.defineProperty(Array.prototype, "acc", {get, set});
var arr = [1,2,3]; arr.acc = 7;`

| step | spec | measured |
| --- | --- | --- |
| `arr.acc` read BEFORE the write | 42, getter runs | **42, getter runs** OK |
| `arr.acc = 7` | setter runs, no own prop | **setter never runs** |
| `arr.acc` read AFTER | 42 (still the getter) | **not 42** |
| `hasOwnProperty(arr, "acc")` | false | **true** |

The READ side is already correct on both shapes (`.tmp/p3.js`: the #4176 data
path and the accessor getter both work on an instance receiver). So this is
purely a `[[Set]]` gap, not a store or visibility gap.

## Root cause — a deliberate deferral, recorded in the source

`__extern_set`'s accessor write gate (`src/codegen/object-runtime.ts` ~L2846,
added by #1888 S5b) states it:

> "Inherited-accessor set (proto-chain) is out of scope for this slice;
> `__obj_find` walks only the own table."

So `[[Set]]` implements the OWN-accessor branch of §9.1.9 and skips the
prototype-chain branch entirely. `__obj_find` is own-table-only by construction.

## Why it must be fixed generally, not for companions only

Diverting only the companion case would make `Array.prototype`'s accessor fire
while a plain prototype's accessor still silently shadows — a half-consistent
`[[Set]]` whose behaviour depends on which store the accessor happens to live
in. That is the same failure mode the one-boundary rule exists to prevent, and
the reason #2175 P2 landed `hasOwnProperty` and `gOPD` together rather than
shipping the contained half alone.

## Historical scope (2026-08-15)

The ~11 companion candidates carried over from #2175 P1
(`.tmp/p1-cands.json`, regex-scoped) are a **LOWER BOUND**: they only count
tests whose source installs a setter on a *builtin prototype*. The general
defect affects every inherited accessor — user prototype chains, `Object.create`
chains and class hierarchies included — so the real target set must be
re-scanned, not inherited from that list.

## Implementation Plan (fable, dictated 2026-08-15)

1. **Template = the GET path's chain walk.** The read side already works on
   BOTH plain and companion protos, so locate that traversal and mirror its
   order exactly. Divergence between the get-walk and set-walk order is itself
   a bug.
2. **At the #1888 S5b gate site** (`object-runtime.ts` ~L2846), before the
   own-property create on a set-miss: find the first proto-chain entry for the
   key.
   - ACCESSOR **with** a setter → invoke it with the ORIGINAL receiver, create
     nothing.
   - **Getter-only** accessor → measure what the existing OWN getter-only set
     path does on base FIRST and mirror it exactly. Record the measured
     behaviour; do NOT invent strict/sloppy semantics.
   - DATA, or absent → today's own-property create, untouched.
3. **Companion protos are one ARM of the same walk**, via the #2175 P2
   receiver-substitution — not a separate code path.
4. **Gates.**
   - `prove-emit-identity` all 60, via conditional emission (the P2 pattern).
   - `.tmp/q1.js` and `.tmp/p4.js` both flip.
   - Negative controls on ONE binary: inherited DATA property still shadows;
     an OWN accessor still works; an absent key unchanged; getter-only mirrors
     the measured own-path behaviour.
   - Scoped run: the 11 companion candidates + `tests/issue-2175-*.test.ts` +
     `tests/issue-4447-forof-dstr-standalone.test.ts` + whichever test262
     bucket a fresh candidate scan says actually exercises inherited-accessor
     assignment. **Record the scan; pick measured, not guessed.**
   - Zero pass→non-pass on both lanes.
5. **One boundary**, keep/revert recommendation with plain numbers. 0 flips is
   acceptable if the gates hold, but real flips are expected here because the
   defect is general.

No git mutations. Stop and report on any surprise.

## Pre-implementation measurements (required by plan steps 1–2)

### Template — the GET path's chain walk (`__extern_get`, `object-runtime.ts` ~L2074)

```
block { loop {
  if (o == null) break
  e = __obj_find(o, key)
  if (e != null) {
    if (e.flags & FLAG_ACCESSOR) {
      getter = extern.convert_any(e.$get)
      if (getter == null) return undefined       // §6.2.5.5 step 3
      return __call_accessor_get(<ORIGINAL receiver>, getter)
    }
    ... data resolve ...
  }
  o = o.$proto ; br 0
} }
```

The load-bearing detail to mirror: the accessor is invoked with the **original
receiver** (param 0), never the proto-walk cursor. The set walk must use the
same start point (own layer first, then `$proto`) and the same order.

### Own getter-only `[[Set]]` — MEASURED on base, to be mirrored

`.tmp/q6.js`: `o = {}; defineProperty(o,"g",{get(){return 11}}); o.g = 5`

| observable | measured |
| --- | --- |
| throws | **yes** |
| `e instanceof TypeError` | **yes** (catchable, not a trap) |
| `o.g` afterwards | 11 — accessor intact, no own data property |

Confirmed via `WebAssembly.Exception` at the boundary + an in-module
`try/catch`. So the inherited getter-only arm mirrors: **throw a catchable
TypeError, create nothing, leave the accessor intact.**

**Recorded deviation, deliberately NOT changed here:** §9.1.9 makes a
setter-less assignment a silent no-op in SLOPPY mode and a TypeError only in
strict. We throw unconditionally. The #1888 S5b comment says the opposite was
intended ("a null setter is a sloppy no-op (strict TypeError deferred)"), so
base behaviour and its own comment disagree. Mirroring the measured behaviour is
what this plan requires; making sloppy/strict correct is a separate change and
must not be smuggled in here.

## Gate results (claude/es6-team-reflection, 2026-08-15)

Integrates as ONE commit with the #2175 P2 follow-up fix — same files. See
"FOLLOW-UP FIX — the first cut shipped INVALID WASM" in
`plan/issues/2175-standalone-builtin-prototype-readers.md` for that change-set's
evidence; it is a prerequisite here (it unblocked the p4 gate).

### What landed

The `$Object` `$proto`-chain accessor walk in `__extern_set`, spliced after the
own-entry block (which returns for every own case) and before the frozen gate +
own-create. Gated on `ctx.vecAccessorDescriptorDirty` — the #4159 pre-scan flag
for "a non-data descriptor may exist in this module". No non-data descriptor
anywhere ⇒ no accessor ⇒ no inherited accessor ⇒ the walk is dead code, so
accessor-free modules stay byte-identical.

**Step 3 (companion/vec receivers) is NOT in this change** — see below.

### Behavioural gates

| probe | before | after |
| --- | --- | --- |
| `.tmp/q1.js` plain-chain inherited accessor | 700 | **715** — setter fires, no own prop, getter still governs |
| `.tmp/q1.js` inherited-DATA control (same binary) | correct | correct — still creates an own prop, proto unchanged |
| `.tmp/q6.js` OWN getter-only assignment | 1111 | 1111 — unchanged |
| `.tmp/p4.js` companion/vec receiver | 203 | 203 — unchanged, step 3 not implemented |
| `prove-emit-identity` | — | **IDENTICAL, all 60** |

### Scans — how they were built, and why the inherited list was the wrong metric

- **The 11 carried-over #2175-P1 candidates: 0/11 flip.** Correct and expected —
  every one installs the accessor on a BUILTIN prototype, so the receiver
  reaches the companion store (step 3), not the `$Object` chain this walk
  covers. Counting them would have measured unimplemented work. Recording this
  rather than quoting "0 flips" flat: the list was inherited from a differently
  scoped issue and does not test what landed.
- **Fresh scan built for what DID land** (`.tmp/q-scan.ts`, recorded there in
  full): non-passing standalone entries whose source has an accessor definition
  AND a property assignment, reachable through an ORDINARY `$Object` chain, with
  builtin-prototype shapes explicitly excluded. Three shapes matched separately
  so the mix is visible: **24 candidates** — 16 `B-class-accessor` (a class body
  `set x(v)` lives on the prototype, so `new C().x = 1` is exactly this defect),
  7 `A-create/proto`, 1 `C-setproto`.
- **Result: 1/24 flips.** `built-ins/Object/defineProperty/15.2.3.6-4-591.js`.
  Verified as a GENUINE flip by A/B, not baseline staleness: on the pre-#4504
  tree it fails `assert(e instanceof TypeError)` at L50; with the walk it passes
  — the getter-only arm's mirrored TypeError is what satisfies it.

### Test sweep

9 files / 70 tests green: `issue-2175-p2-own-view-companion` (incl. the new
accessor-descriptor row), `issue-2175-{v2s3b,s3b3,native-proto-brands,
typeof-function-arm,v2s2}`, `issue-4447-forof-dstr-standalone`, `issue-2885`,
`issue-4160-proto-index-store`. Zero pass→non-pass anywhere.

### Measured, out of scope, NOT changed here

A setter-less assignment throws unconditionally where §9.1.9 makes it a silent
no-op in SLOPPY mode (TypeError only in strict). Base behaviour and #1888 S5b's
own comment ("a null setter is a sloppy no-op (strict TypeError deferred)")
disagree. The plan required mirroring the measured own-path behaviour, so the
inherited arm reproduces the throw rather than inventing sloppy/strict handling.
Worth its own id after review — note it currently makes 15.2.3.6-4-591 pass, so
"fixing" it would need that test re-checked.

### Next slice (named, not started)

**Step 3 — companion/vec receivers.** A vec/instance receiver never reaches
`__extern_set`'s `$Object` branch at all, so `arr.acc = 7` (p4) is a separate
site, not another arm of this loop. `__protoidx_own_recv` (from the P2 fix) is
the natural substitution primitive for it. Its gate is p4 flipping plus a re-run
of this battery.

## Implementation Plan — authoritative re-ground, 2026-08-20

This section supersedes the implementation recommendations above while retaining
them as issue history. The 2026-08-15 partial walk proved the seam, but it is not
an ES `[[Set]]` implementation: it handles only inherited accessors on an
ordinary `$Object`, treats every inherited data descriptor as writable, and
throws for a setter-less accessor even in sloppy code. The remaining work is the
nearest inherited **descriptor** decision across explicit `$Object` prototype
links, fnctor prototype links, and implicit native-prototype companions.

Authoritative baseline: compiler `0d87f21636f88cf416e67fc176760987d3b0bbb1`,
Test262 `b363f29d3c43c626dc852744ad64a0b48a003693`, honest host-free
`--target standalone`, oracle v13. ES5 is **8619 pass / 385 fail / 25 compile
error / 0 skip = 9029 total, 410 non-pass**. All eleven diagnostic rows below
are reached runtime failures in `.test262-cache/test262-standalone-current.jsonl`.

### Exact scope and denominator

The original eleven-row diagnostic cohort contains only **nine #4504 targets**.
Do not report this issue as 11/11, and do not make either excluded failure a
condition of the descriptor-walk implementation.

| Test262 row | Runtime shape and nearest descriptor | Baseline symptom | #4504 outcome |
| --- | --- | --- | --- |
| `15.2.3.6-4-410` | JSON; `Object.prototype` companion, non-writable data | own shadow yields `"unlikelyValue"` | refuse; no own property; read `1001` |
| `15.2.3.6-4-415` | three-level ordinary `Object.create` chain, non-writable data at different depths | `verifyNotWritable` returns false | refuse at the nearest matching descriptor; create no own property |
| `15.2.3.6-4-579` | Array carrier; `Array.prototype` companion setter | array receives an own property | invoke setter once with the array as receiver; no own property |
| `15.2.3.6-4-581` | Number wrapper; `Number.prototype` companion getter-only accessor | `verifyNotWritable` returns false | sloppy refusal; no own property; retain `"data"` |
| `15.2.3.6-4-584` | Date carrier; `Date.prototype` companion setter | captured data remains `"data"` | invoke setter once with the Date receiver; no own property |
| `15.2.3.6-4-586` | JSON; `Object.prototype` companion getter-only accessor | `verifyNotWritable` returns false | sloppy refusal; no own property |
| `15.2.3.6-4-594` | bound function; `Function.prototype` companion setter | bound function receives an own property | invoke setter once with the bound function receiver; no own property |
| `15.2.3.6-4-596` | bound function; `Function.prototype` companion getter-only accessor | own shadow yields `"unlikelyValue"` | sloppy refusal; no own property; retain `"data"` |
| `8.14.4-8-b_1` | `__fnctor_proto_start` chain, inherited non-writable data; `noStrict` | instance receives an own property | silent refusal; no own property; retain `"unwritable"` |
| `15.2.3.6-4-408` | Date plus inherited **writable** data | `dateObj.hasOwnProperty("prop")` is false | **Excluded:** the correct set decision is “create own”; Date expando storage/own-view visibility is a separate follow-up |
| `15.2.3.6-4-589` | ordinary inherited setter, Date object RHS | setter stores the Date in an externref ref-cell, but the getter's statically inferred f64 result ABI unboxes it to `NaN` | **Excluded:** descriptor getter/result-carrier widening loses Date identity; extend #4515 or file a narrower follow-up |

The exclusions now have explicit in-repo owners: #4491 records Date carrier-bag
and `hasOwnProperty` visibility for 4-408, while #4515 records the accessor
dynamic-boundary work for 4-589. Do not silently assign either row to completed
#1212. In 4-589 the setter input already crosses as externref; the remaining
loss is the getter's f64 result ABI.

### Required semantics

Implement ES5.1 [`[[CanPut]]`/`[[Put]]`](https://262.ecma-international.org/5.1/#sec-8.12.5),
equivalent here to current [`OrdinarySet`](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryset)
and [`OrdinarySetWithOwnDescriptor`](https://tc39.es/ecma262/2026/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetwithowndescriptor):

- Inspect the receiver's own layer first, then walk prototypes from nearest to
  farthest. Stop at the first live descriptor; storage backend must not alter
  precedence.
- An inherited writable data descriptor permits creation of an own data property
  on the original receiver. It also stops the search; never consult a farther
  accessor or non-writable descriptor.
- An inherited non-writable data descriptor refuses the write and creates no own
  property.
- An inherited accessor with a setter calls it exactly once with the original
  receiver as `this` and the unmodified RHS. A getter-only accessor refuses.
- Refusal is a silent no-op for sloppy assignment, a catchable `TypeError` for
  strict assignment, and boolean `false` for `Reflect.set`. A successful setter
  or data write makes `Reflect.set` return `true`; a setter-thrown exception
  propagates. The assignment expression still evaluates to the original RHS.

### Runtime changes

**`src/codegen/object-runtime.ts` — `ensureObjectRuntime`, `__extern_set`
(current lines 2781–3137), `__reflect_set` (3140–3282).**

- Keep the public `__extern_set(externref, externref, externref) -> void` ABI.
  Replace `inheritedAccessorArm` (2797–2913) with one shared four-state decision:
  `MISS`, `ALLOW_OWN`, `HANDLED`, `REFUSED`. The decision may invoke a setter;
  callers must therefore consume it once and must not replay it. `MISS` and
  `ALLOW_OWN` are deliberately distinct: a nearer writable data descriptor
  terminates lookup and must not expose a farther companion descriptor.
- For a `$Object` own miss, start at `receiver.$proto`; for a non-`$Object`
  fnctor, start at `__fnctor_proto_start(receiver)` (registered near 1766).
  Walk `$Object` links with `__obj_find`. Test `FLAG_ACCESSOR`, `$set`, and
  `FLAG_WRITABLE`; return immediately on the first entry. On explicit-chain
  exhaustion only, consult the implicit native companion helper below.
- In sloppy `__extern_set`, `HANDLED` and `REFUSED` both return. `ALLOW_OWN`
  reaches today's frozen/extensibility and own update/create tail without
  consulting another provider; `MISS` may consult the next provider and, after
  the final miss, reaches that same tail. Remove the current inherited
  getter-only `buildThrowJsErrorInstrs` arm. Own and inherited refusal must have
  the same strictness owner.
- Make `__reflect_set` use the same decision/result rather than its current
  own-`$Object`-only preflight. Return true for `HANDLED`, false for `REFUSED`,
  and perform the existing allowed own write after `ALLOW_OWN` or the final
  `MISS`. Never invoke an inherited setter once in the preflight and again
  through `__extern_set`.

**`src/codegen/proto-index-store.ts` — reservations (111–248),
`fillProtoIndexStore` (497–515), `fillGetKBody` (896–981), and
`fillBrandOffBody` (1019–1169).**

- Reserve before `__extern_set`, then finalize alongside the existing helpers,
  `__protoidx_set_r(origRecv, key, value) -> i32` using the same four statuses.
  Follow `fillGetKBody`: classify with `__protoidx_brand_off`, probe the receiver
  brand's companion with `create = 0`, then Object's companion when distinct,
  and stop on the first live entry.
- Add local constants for `$PropEntry.$set` and `FLAG_WRITABLE = 0x01` beside
  the existing entry-field/accessor constants. Accessor+setter calls
  `__call_accessor_set(origRecv, setter, value)` and returns `HANDLED`;
  getter-only or non-writable data returns `REFUSED`; writable data returns
  `ALLOW_OWN`; only absence returns `MISS`. Probe Object's companion only after
  a brand-companion `MISS`, never after `ALLOW_OWN`.
- Preserve reserve/fill discipline: fresh placeholder instruction arrays,
  finalized type/function indices, appended locals only, and no helper/import
  index shifts in flag-clear modules.

**Carrier own layers — `src/codegen/instance-props.ts` (set arm 229–252,
`__instance_prop_set` 415–433), `src/codegen/vec-props.ts` (set arm 133–159,
`__vec_prop_set` 432–488), `src/codegen/closure-props.ts` (set arm 166–177,
`__closure_prop_set` 756–778), and `src/codegen/error-props.ts` (set arm 58–80,
helper 233–293).**

- Change the terminal carrier write sequence from unconditional `bagEnsure` to:
  look up an existing bag without allocation; resolve a live own bag descriptor;
  on an own miss run the inherited decision with the **original carrier**; only
  `ALLOW_OWN` or a final `MISS` may ensure a bag and create the own property.
- A carrier-bag accessor must also receive the original carrier, not the hidden
  `$Object` bag. Own writable data updates the bag; own non-writable data and
  getter-only accessors refuse. Do not run the inherited resolver on the bag:
  doing so substitutes the wrong receiver and can consult Object's companion
  twice. Preserve higher-precedence physical fields, vec indices/`length`, and
  builtin-function `name`/`length` refusal arms.

**`src/codegen/object-runtime-strict-set.ts` — `buildStrictSetHelper`
(95–149).**

- Remove the current semantic split where non-`$Object` values blindly delegate
  to `__extern_set`. For every admitted standalone receiver, consume the same
  four-state result as `__reflect_set`; throw the existing catchable
  TypeError only for `REFUSED`. Do not turn an unadmitted host boundary into an
  inherited-property claim.

**Conditional emission — `src/codegen/context/types.ts`,
`src/codegen/context/create-context.ts`, and `src/codegen/array-holes.ts`'s
`scanForArrayHoles`.**

- Do not reuse `vecAccessorDescriptorDirty` as the semantic gate: it is a typed
  vec optimization flag and a provably data-only non-writable descriptor such
  as row 4-415 leaves it clear. Add a dedicated pre-scan fact (for example
  `inheritedSetDescriptorDirty`) covering a descriptor that may be accessor or
  non-writable, accessor declarations, and dynamic code. A provably writable
  data descriptor alone need not arm the walk; when the flag is armed, it still
  must stop a walk before any farther descriptor.
- Native companion reservation remains governed by the existing
  `protoIndexDirty || protoNamedDirty || protoMemberDirty` substrate. Prove that
  the new set helper emits only when both the descriptor decision and relevant
  runtime substrate can be observed.

### IR ownership and non-goals

There must be no Test262 call-site patch and no parallel descriptor algorithm in
IR. Legacy assignment already chooses symbolic `__extern_set` or
`__extern_set_strict` in `compilePropertyAssignmentExternSet`
(`src/codegen/expressions/assignment.ts` 4353–4467). Prepared IR direct open
writes use `irRuntimeFuncRef("__extern_set")` (`src/ir/from-ast.ts` near 5406);
`dyn.member_set` is lowered symbolically through `__dyn_member_set`
(`src/ir/from-ast.ts` 5465–5518; `src/ir/lower.ts` 2008–2030), whose standalone
implementation uses `__reflect_set` and delegates allowed writes to
`__extern_set` (`src/codegen/dyn-read.ts` 826–970). Fixing the runtime seam
therefore covers both producers.

The standalone prepared-IR resolver still declines ambient
`Object.defineProperty` (`src/ir/integration.ts` 4255–4258); typed descriptor
reification remains #2668. The nine acceptance rows already reach the legacy
runtime `Object.defineProperty` implementation, so widening the IR selector is
neither necessary nor permitted in #4504.

### Staged delivery and acceptance

1. **Ordinary `$Object`.** Introduce the four-state decision, handle inherited
   writable/non-writable data and accessors, correct sloppy/strict/Reflect
   ownership, and flip exactly scoped row 4-415. Recheck 4-589 only as a control:
   the setter must still run, but its Date-value failure remains excluded.
2. **Fnctor explicit chain.** Add the `__fnctor_proto_start` entry point without
   allocating a sidecar first; flip `8.14.4-8-b_1`.
3. **Native companions and carriers.** Add `__protoidx_set_r`, wire own-bag miss
   ordering, and flip rows 4-410, 4-579, 4-581, 4-584, 4-586, 4-594, and 4-596.
   Row 4-408 remains an explicit Date own-view follow-up, even if incidental
   movement occurs.
4. **Consolidate and remove the historical arm.** No duplicate walk, no
   unconditional sloppy throw, and no per-Test262 special cases remain.

Each stage requires a same-population A/B: record candidate compiler SHA while
holding corpus SHA, oracle v13, honest standalone lane, harness, and all **9029
ES5 tests** fixed. The targeted #4504 denominator is **9**: all nine fail on A
and must pass on B. With exactly nine flips and zero regressions the full ES5
floor is **8628 pass** and the non-pass ceiling is **401**; do not quote 8630/399
from the eleven-row diagnostic cohort. Report 4-408 and 4-589 separately.

Add `tests/issue-4504-inherited-set.test.ts` with focused controls for inherited
writable and non-writable data, setter and getter-only accessors, two-or-more
prototype levels, nearest-descriptor shadowing, original receiver identity,
sloppy no-op versus catchable strict TypeError, `Reflect.set` true/false, setter
exception propagation, and unchanged assignment-result RHS. Keep passing
`15.2.3.6-4-591.js` as a regression control after removing its historical
unconditional sloppy throw. Final gates:

- all nine exact Test262 rows pass; zero pass-to-non-pass across all 9029 ES5;
- the full eleven-row diagnostic report makes the two exclusions visible;
- targeted host-mode controls remain unchanged;
- `prove-emit-identity` is identical for all 60 flag-clear modules, or any
  measured drift is reported and blocks the slice rather than being waived.

### Principal risks

- Looking past an inherited writable data descriptor changes “nearest wins” and
  can invoke the wrong farther setter.
- Ensuring a carrier bag before prototype resolution fabricates an own property;
  resolving on the hidden bag loses receiver identity.
- A side-effecting preflight can call a setter twice unless `__reflect_set` and
  strict assignment consume `HANDLED` directly.
- The current `vecAccessorDescriptorDirty` gate misses row 4-415 and class
  accessor shapes; an unconditional walk breaks emission identity.
- Late helper/type registration can invalidate baked Wasm indices. Follow the
  existing proto-index reserve/fill pattern and append locals.
- Rows 4-408 and 4-589 are real failures but different defects; including either
  in the #4504 denominator would hide whether the inherited descriptor decision
  itself is correct.

## Final implementation and evidence (2026-08-20)

Implemented the inherited `[[Set]]` decision at the shared standalone runtime
boundary. Ordinary objects, fnctors, native companions, and carrier sidecars now
share one nearest-descriptor decision with distinct `MISS`, `ALLOW_OWN`,
`HANDLED`, and `REFUSED` outcomes. Sloppy assignment, strict assignment, and
`Reflect.set` consume that result without replaying setters. Both legacy and IR
producers continue to lower symbolically through the same runtime helpers; no
Test262 call-site workaround or parallel IR descriptor algorithm was added.

The implementation is commits `03800c09703215` and `4006a1706563f4`, based on
and merged with `origin/main` compiler `12c93a7ba49755e8a203c61afa66c918a690894f`.
The fixed Test262 checkout was
`b363f29d3c43c626dc852744ad64a0b48a003693`.

The clean-main full official standalone control covered all **43,621** rows and
classified the fixed **9,029-test ES5 population** as **8,621 pass / 385 fail /
23 compile error / 0 skip**. Compiler `4006a1706563f4` then ran those exact
9,029 paths: **8,631 pass / 375 fail / 23 compile error / 0 skip**. This is a
measured **+10 ES5 passes**, with **zero pass-to-non-pass**, timeout, or other
population-noise changes.

The ten improvements are the nine planned rows — `15.2.3.6-4-410`,
`15.2.3.6-4-415`, `15.2.3.6-4-579`, `15.2.3.6-4-581`, `15.2.3.6-4-584`,
`15.2.3.6-4-586`, `15.2.3.6-4-594`, `15.2.3.6-4-596`, and `8.14.4-8-b_1` —
plus the adjacent strict sibling `8.14.4-8-b_2`.

Additional gates:

- focused #4504 suite: **36/36**;
- #4504 plus #3251 strict/sloppy related suites: **57/57**;
- TypeScript 7 and TypeScript 5 typechecks: pass;
- conditional-emission oracle: **IDENTICAL 60/60** (36 successful emissions,
  24 expected compile errors);
- broad carrier same-population A/B: no attributable regressions;
- Proxy `set` trap results use the shared `__is_truthy` coercion engine; the
  narrow frontmatter allowance records that single required call site;
- formatting, repository budgets, oracle ratchet, and commit hooks: pass.

The two diagnostic exclusions remain deliberately open under their existing
owners: `15.2.3.6-4-408` is Date expando/own-view visibility in #4491, and
`15.2.3.6-4-589` is accessor result-carrier widening in #4515. Neither is an
inherited-descriptor-decision failure, and neither was counted in #4504's
acceptance denominator.
