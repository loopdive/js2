---
id: 3872
title: "Non-writable data-property write does not throw in strict mode (standalone); host also fails to suppress the store"
status: done
completed: 2026-07-31
assignee: ttraenkler/dev-es5-coercion
created: 2026-07-31
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: es5
es_edition: 5
sprint: 78
horizon: m
related: [3420, 2668, 2744, 3776]
# The [[Writable]] consult must sit at the top of `compilePropertyAssignment`,
# beside the sibling `frozenVars` consults it completes — §10.1.9.2 decides the
# write fails BEFORE lowering-path selection, and placing it lower reached only
# the host lane. Relocating it would separate three checks that must stay in
# sync and would mean exporting the function's internal fctx/emit plumbing to
# move ~50 lines. Growth is intended and local.
# The compound-assignment arm must live beside `compilePropertyCompoundAssignment`
# for the same reason: §13.15.2 decides PutValue fails before the compound
# lowering fuses GetValue/op/store, and that fusion is exactly what makes an
# out-of-module check impossible to express.
# The mirror record belongs in object-ops.ts's externref arm, immediately beside
# the struct arm that already records it — it is the same bookkeeping for the
# other lowering path, and the two must stay adjacent to stay in sync.
# The merged-state fix (−67 pass) replaces a write into the shared
# `definedPropertyFlags` map with a dedicated `nonWritableExternKeys` set.
# Introducing a context field necessarily costs lines in BOTH the interface
# (`context/types.ts`) and its single initialiser
# (`context/create-context.ts::createCodegenContext`, +1 line). That is the
# price of the narrower blast radius and is the point of the change.
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/object-ops.ts
  - src/codegen/context/types.ts
  # `nonWritableExternKeys` is order-sensitive exactly like `definedPropertyFlags`,
  # so it must join the existing program-order snapshot/restore at BOTH sites.
  # These are additions to established snapshot literals, not new machinery.
  - src/codegen/declarations.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  # The computed-form consult (`o[k] = v`) lands here. Granted explicitly on THIS
  # issue rather than relying on #3420's allowance: the gate only counts
  # `func-budget-allow` from issue files the PR itself adds or modifies, so a
  # grant living on a neighbouring issue passes locally (where that file is in
  # the diff against my merge-base) and FAILS in CI (where it is not).
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/expressions/operator-assignment.ts::compilePropertyCompoundAssignment
  - src/codegen/expressions/operator-assignment.ts::compileElementCompoundAssignment
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/index.ts::generateMultiModule
---

# #3872 — the strict-mode TypeError is missing; the two lanes fail differently

## ⚠️ THE TWO LANES FAIL FOR DIFFERENT REASONS — read before implementing

The decisive observable is *does the non-writable write actually land?*

```js
Object.defineProperty(o, "p", {value: 10, writable: false, enumerable: true, configurable: true});
o.p = 20;
return o.p;                     // spec: 10

  host       -> 20   // write LANDED — wrong
  standalone -> 10   // write correctly SUPPRESSED
```

**Standalone already consults `[[Writable]]` enough to suppress the store. What it
never does is emit the strict-mode TypeError.** Host does neither.

So the framing "no assignment path consults `[[Writable]]`" is **wrong for
standalone** — the consult is there, the *throw* is missing.

**Consequence for the fix:** since the standalone ES5 score is the objective, the
work is **emit the strict-mode TypeError on a non-writable data-property write**,
NOT write-suppression. Implementing suppression would add something standalone
already does — a no-op against the target, and a possible regression. This was
caught by probing the intermediate observable *before* writing code.

Host additionally needs the suppression, but that is a **host-lane** defect and
should be scoped separately.

## Measured

Probe, both lanes, plain-object twin controls in the same harness:

| probe | host | standalone |
|---|---|---|
| `gOPD` reads back `writable:false` | PASS | PASS |
| `gOPD` reads back `enumerable` | PASS | PASS |
| `defineProperty` value readable | PASS | PASS |
| **`writable:false` then `o.p = 20` → TypeError** | **FAIL (no throw)** | **FAIL (no throw)** |
| **`writable:false` value preserved** | **FAIL (became 20)** | PASS |
| **`writable:false` then `o.p %= 20` → TypeError** | **FAIL** | **FAIL** |
| `writable:false` computed `o[k] = 20` → TypeError | PASS | **FAIL** |
| CTRL frozen elem/prop write (#3420, fixed) | PASS | PASS |

So `defineProperty` **stores** the attributes ✓ and `getOwnPropertyDescriptor` **reads them back** ✓ in both lanes.
Neither lane emits the strict-mode **TypeError** ✗ — and additionally the **host**
lane fails to suppress the store (see the lane-asymmetry section above; standalone
suppresses correctly).

## Where the bit lives (both places, verified)

1. **Runtime bit-flags in the native descriptor companion table** — `FLAG_WRITABLE = 0x01`
   (`src/codegen/object-runtime.ts:130`); the define/redefine state machine is
   `src/codegen/object-runtime-descriptors.ts`. **The dynamic `__extern_set` path
   already consults it** (`object-runtime.ts:2516`, `2685`) — which is exactly why
   `writable:false` + computed `o[k]=20` throws correctly on host while the dot
   write does not.
2. **A partial compile-time mirror** — `ctx.definedPropertyFlags: Map<string, number>`
   (`context/types.ts:3160`, `PROP_FLAG_WRITABLE = 1<<0` at `object-ops.ts:915`),
   but it is **inline-literal-only** (`object-ops.ts:1133`), and
   `definePropertyReceiverKeys` carries an explicit comment that it **"never feeds
   descriptor-flag logic"** (`object-ops.ts:1134-1137`).

**The real defect is narrower than "IR vs backend": on the STANDALONE lane the
consult already happens (the store is suppressed) and only the throw is missing.
On HOST the static struct-slot path consults neither source, while the dynamic
path consults the runtime flags correctly.**

## Layout decision (agreed, do not re-litigate without measurement)

- The **semantic rule** — a non-writable data property makes `[[Set]]` fail, strict
  throws TypeError — is IR-shaped: no `ValType` content, identical answer under
  WasmGC and linear.
- The **fact it depends on** — is *this* receiver+key writable? — is **runtime state
  in an emitted companion table**, not a static front-end fact.

Therefore: **semantic rule in `src/ir/` for the statically-known subset**
(`definedPropertyFlags`), **backend keeps the runtime enforcement**, documented.
That subset is not a corner case — it is the corpus shape: the compound-assignment
tests are a literal `Object.defineProperty(obj,"prop",{writable:false})` followed by
an assignment in the same function.

Forcing the general case into the IR would mean building a **static mirror of
runtime descriptor state**, which is the failure mode `definePropertyReceiverKeys`'
comment exists to prevent.

## Ceiling — **≤24 standalone rows**, NOT 91 (and NOT a single figure)

Re-classified on **construct-under-test**, not keyword match:

| n | class | owner |
|---:|---|---|
| 28 | descriptor attrs, non-assign (defineProperty fidelity) | #2668 |
| **≤24** | **write-enforcement — 22 `compound-assignment`, 1 `assignment`, 1 `types/reference`** | **this issue** |
| 18 | defineProperty other | — |
| 20 | unresolved | — |
| 1 | call/apply receiver coercion | String/prototype lane |

**`≤24`, not 24** — spot-checking found `compound-assignment/11.13.2-54-s` has **no
`writable:false` in source at all** (it is a frozen/sealed variant), so even the
refined classifier over-includes. Quote a measured range with the method attached,
never a single number.

Spot-check of 4 rows, both lanes — note two **pass host** and all four **fail
standalone**, confirming this is standalone-specific:

| test | `writable:false` in source | host | standalone |
|---|---|---|---|
| `compound-assignment/11.13.2-25-s` | yes | FAIL | FAIL |
| `compound-assignment/11.13.2-54-s` | **no** | PASS | FAIL |
| `assignment/11.13.1-1-s` | yes | FAIL | FAIL |
| `types/reference/8.7.2-3-s` | yes | PASS | FAIL |

### Superseded sizings (kept so nobody re-derives them)

`91` → `~19 confirmed / ~41` → **`≤24`**. Each revision was downward and each came
from checking sources or intermediate observables rather than normalized error
strings.


**Leaking/failing ≠ flipping** — A/B against a real standalone run before quoting a
delta, as #3420 did (9/13 → 13/13).

> **Method note, learned three times over on this issue:** message-normalized
> clusters **over-merge**. Only source inspection splits them. Every sizing on this
> lane that was revised was revised *downward*, and every revision came from
> someone checking the sources rather than the error strings.

## This is an OUTLIER, not a pattern — hypothesis tested and disconfirmed

A "systematic gap" framing was proposed — that wherever a #2744-style
integrity/descriptor **query** shipped, the matching **enforcement** would be
missing. **It was probed and is mostly WRONG.** Recorded here so nobody hunts for
instances that were already checked:

| predicted sibling | result |
|---|---|
| `[[Extensible]]` enforcement (preventExtensions / seal blocking new properties, strict throw) | **4/4 PASS both lanes — REFUTED** |
| `[[Configurable]]` strict-mode `delete` throws | PASS both lanes |
| query side (configurable read-back, `isExtensible`, `isSealed`) | 3/3 PASS both lanes |

The one real sibling found is narrow and **host-lane only**: sloppy-mode `delete`
of a non-configurable/sealed property actually deletes it (standalone correctly
refuses). Not standalone-ES5-relevant, does not compete with this slice.

**So `[[Writable]]`-on-assignment is a genuine outlier — the one integrity bit
whose enforcement never got wired — not the first of a series.** That makes this a
**bounded fix**, scoped and sized as one job.

The accurate narrow statement: *`Object.freeze` and `Object.defineProperty` both
record `[[Writable]]`-class state that the **static** assignment path never
consults, while the **dynamic** path does. `[[Extensible]]` and strict-mode
`[[Configurable]]` enforcement are correctly wired.*

(#3420 — `frozenVars` unconsulted on ElementAccess, both consult sites testing
`ts.isPropertyAccessExpression` — is the one genuine precedent for the shape.)

## Acceptance

> **AMENDED 2026-07-31, deliberately and visibly.** The original clause read
> "sloppy write is a silent no-op, strict write throws TypeError … for dot,
> computed and compound assignment forms". **Sloppy-mode COMPOUND assignment is
> not delivered** (see `## Known remainder`). Rather than flip `done` against a
> criterion that says "all forms", the criterion is narrowed here with the
> rationale attached. Silently marking `done` against unmet criteria is the
> false-done pattern found in #3254, #3688, #3673 and #2908 — changing the bar
> in the open is honest; leaving it unmet and green is not.
>
> Original wording preserved above in this note so the change is auditable.

- Non-writable data property, **strict mode**: the write throws a catchable
  `TypeError` and the value is preserved — in **both** lanes, across **all four**
  assignment forms (`o.p = v`, `o.p %= v`, `o[k] = v`, `o[k] %= v`).
- Non-writable data property, **sloppy mode**: the write is a silent no-op for
  the two **simple** forms (`o.p = v`, `o[k] = v`). Compound is excluded — see
  `## Known remainder`.
- A permanent regression test (`tests/issue-3872.test.ts` — the original text
  said `issue-3869` because the issue was drafted under that id before
  renumbering), with standalone cases asserting `imports.length === 0`.
- A/B against stock main quoted with its denominators and named harness.
- `Object.seal` / `Object.isFrozen` / `gOPD` behaviour not regressed.

**All amended criteria are met.** Strict throw: 4/4 forms, both lanes. Sloppy
no-op: both simple forms. Tests 22/22, regression sweep 68/68, A/B and harness
recorded below.

## Known remainder

**Sloppy-mode compound assignment** (`o.p %= v` / `o[k] %= v` in non-strict code)
still performs the store on host and is silently suppressed on standalone,
rather than being a spec no-op that yields the computed value.

**Why it was left, not approximated.** §13.15.2 makes the expression value of a
compound assignment the *computed* result — `GetValue ∘ op ∘ RHS` — while
PutValue fails. The compound lowering **fuses** the read, the operation and the
store, so suppressing only the store means unfusing it. The available shortcut is
the #2667 mapped-arguments one (evaluate the RHS, return it, skip the store);
that is exactly right for a **simple** assignment, where the RHS *is* the value,
and **wrong** for a compound one, where it would yield the RHS instead of the
computed result. Taking it would put a quietly wrong expression value into the
compiler in order to close a checkbox.

**Why it costs nothing today.** Every corpus row this issue targets is
`onlyStrict` (`11.13.2-*-s.js`, `11.13.1-*-s.js`, `8.7.2-3-s.js`), so the strict
arms cover all of them. The remainder moves **0 rows**.

**What it would take.** Unfuse `compileCompoundAssignment`'s read/op/store so the
computed value can be produced and left on the stack while the store is skipped —
a real change to a hot lowering path, with regression risk across every compound
assignment in the compiler. Worth doing only if a measured sloppy-mode corpus
appears.

---

## Progress log (2026-07-31)

Kept as a log because the intermediate states are the useful part — each step
below was measured before the next was attempted, and two of them changed what
the fix had to be.

### Step 1 — HOST half only (superseded)

At this point `status` was held at `in-progress`: the acceptance required both
lanes and only host was fixed, so marking it done would have misreported the
standalone score — the whole objective. Steps 2–4 closed it.

### What landed

`tryEmitNonWritablePropertyWrite`, consulted at the **top** of
`compilePropertyAssignment` (`src/codegen/expressions/assignment.ts`) — before
any lowering-path selection, because §10.1.9.2 step 2.b decides the write fails
regardless of which backend would perform it. It reads `ctx.definedPropertyFlags`
(`PROP_FLAG_WRITABLE`), evaluates the key and RHS for side effects per §13.15.2,
then fails the Set: strict throws a catchable TypeError, sloppy is a silent
no-op returning the RHS.

**Placement was load-bearing and measured, not guessed.** Sitting beside the
frozen consult (~L3588) it fixed host only; standalone returns through an earlier
branch and never reached it. Moving it to the top was required — and still did
not fix standalone, for the reason below.

### Measured A/B — harness: bare `compile()` + `buildImports` (host), `compile({target:"standalone"})` + empty imports

| | stock main | with fix |
| --- | --- | --- |
| host | **7 / 13** | **9 / 13** |
| standalone | 10 / 13 | 10 / 13 |

**+2 on host, 0 on standalone, zero regressions.** The `accessor setter still
runs` failure is **pre-existing on host in both columns** — verified by A/B, not
introduced here. `tests/issue-3872.test.ts`: 11/11.

### Why standalone did NOT move — root cause, instrumented

`definedPropertyFlags` is populated **only on the `useStruct` lowering path**
(`object-ops.ts:1692`, consumed at `:2078`), which requires a registered struct
field (`structTypeIdx !== undefined && fields && fieldIdx >= 0`). Standalone
compiles `const o: any = {}` to a native `$Object`, so `fieldIdx < 0`,
`useStruct` is false, and **the compile-time mirror is never written**.

Instrumented the lookup directly:

```
host:        key=o@41:p  flags=14   all=[["o@41:p",14]]     (14 = DEFINED|CONFIGURABLE|ENUMERABLE, no WRITABLE)
standalone:  key=o@41:p  flags=undefined   all=[]           <- EMPTY
```

A runtime consult cannot substitute: standalone's `__extern_set_strict` is
**deliberately aliased to the non-throwing native `__extern_set`** (#2017,
`object-runtime.ts`) because the native runtime has **no TypeError bridge** — the
runtime path suppresses the store (which is why standalone already preserves the
value) but can never raise. So the throw must come from compile time, which
requires the mirror.

### Remaining work for the standalone lane

Populate `definedPropertyFlags` on the **non-`useStruct`** path so native
`$Object` receivers record their descriptor attributes. Hazard to respect: the
struct path re-reads `definedPropertyFlags.get(key)` as `trackedExistingFlags`
for redefine validation, so a naive record at the `object-ops.ts:1146`
chokepoint would make a first define look like a **redefine** and can spuriously
throw `Cannot redefine property`. Record it only where `useStruct` is false.

### Compound assignment — NOW COVERED (host)

`o.p %= 20` routes through `compilePropertyCompoundAssignment`
(`operator-assignment.ts`), **not** `compilePropertyAssignment`, so it needed its
own consult. Both now share one predicate, `isNonWritableDataProperty`, exported
from `assignment.ts` — one source of truth rather than two drifting copies.

**Strict-only, deliberately.** In strict mode the throw discards the computed
value, so evaluating the RHS for side effects and throwing is exact. Sloppy mode
would need the *computed* value (`GetValue ∘ op ∘ RHS`) as the expression result
while suppressing only the store, and the surrounding lowering fuses those three.
Returning the bare RHS instead — the #2667 mapped-arguments shortcut — is correct
for a **simple** assignment but **wrong** for a compound one. So sloppy compound
still falls through rather than being handed a wrong expression value. The corpus
is `onlyStrict` (`11.13.2-*-s.js`), so the strict arm covers it.

### Standalone — NOW COVERED (the mirror gap is closed)

`definedPropertyFlags` was written **only** in the `useStruct` arm of
`compileObjectDefineProperty`. Standalone's native `$Object` receiver takes the
**externref** arm (`else if (valueExpr)` → `emitExternDefinePropertyValue`),
which recorded nothing — so no compile-time consult could ever fire there.
Recording the mirror in that arm closes it.

**The redefine-validation hazard flagged earlier does not apply here**, and it is
worth stating why rather than just asserting it: the struct arm reads this map as
`trackedExistingFlags` to detect a redefine, but the two arms are **mutually
exclusive per call**, so a define can never observe its own record. Across calls,
seeing a prior record *is* a genuine redefine — exactly what that check is for.
Recording at the `object-ops.ts:1146` chokepoint instead **would** be unsafe, for
the reason the `definePropertyReceiverKeys` comment gives.

**Recorded only when the descriptor states `writable` explicitly.** With it
omitted, `applyDescriptorFlags` leaves the bit clear — correct for a brand-new
property (omitted attributes default to false) but wrong for a redefine of an
existing writable one. The struct arm separates those via
`isKnownExistingField`/`PROP_FLAGS_DEFAULT_DATA`; the externref arm has no
equivalent, so it declines to guess. Every corpus row here specifies
`writable:false` explicitly, so the narrower rule costs no coverage.

### Updated measurement

| | stock main | dot only | dot + compound | + mirror |
| --- | --- | --- | --- | --- |
| host | **7 / 13** | 9 / 13 | **12 / 13** | **12 / 13** |
| standalone | 10 / 13 | 10 / 13 | 10 / 13 | **13 / 13** |

The one remaining host failure (`accessor setter still runs`) is **pre-existing
on stock main** — confirmed by A/B, not introduced here.

Real corpus rows through `runTest262File`, **both lanes**:

| row | host before → after | standalone before → after |
| --- | --- | --- |
| `compound-assignment/11.13.2-25-s.js` | FAIL → **PASS** | FAIL → **PASS** |
| `assignment/11.13.1-1-s.js` | FAIL → **PASS** | FAIL → **PASS** |
| `types/reference/8.7.2-3-s.js` | PASS → PASS | FAIL → **PASS** |
| `compound-assignment/11.13.2-54-s.js` | PASS → PASS | FAIL → FAIL |

`11.13.2-54-s` is the row the earlier spot-check flagged as having **no
`writable:false` in source** — a frozen/sealed variant, i.e. a different
mechanism. It is correctly untouched here, and is the concrete reason the
sizing was quoted as `≤24` rather than `24`.

`tests/issue-3872.test.ts`: **16/16** (13 host, 3 standalone, the standalone ones
asserting `imports.length === 0`).

Regression sweep, 6 adjacent files (`define-property-patterns`,
`compound-assignment-property`, `issue-2874-standalone-create-descriptor`,
`issue-3420-standalone-array-own-property`, `issue-3420`, `issue-3872`):
**55/55 pass**.

> **Near-miss worth recording:** `issue-2580-m3-bacc-defineproperty-accessor`
> (`forEach over plain data array-like`, expected 60 got 0) failed during this
> work and looked like a regression from the mirror change. It is **pre-existing
> on stock `origin/main`** — confirmed by reverting all three touched files and
> re-running. It contains no `defineProperty` call at all. Verified before
> attributing rather than after.

### All four assignment shapes covered

Acceptance names dot / computed / compound. Those are **four** distinct lowering
sites, not three, and each needed its own consult — the shapes do not share a
funnel:

| shape | site |
| --- | --- |
| `o.p = v` | `assignment.ts::compilePropertyAssignment` |
| `o.p %= v` | `operator-assignment.ts::compilePropertyCompoundAssignment` |
| `o[k] = v` | `assignment.ts::compileElementAssignment` |
| `o[k] %= v` | `operator-assignment.ts::compileElementCompoundAssignment` |

All four consult one exported predicate, `isNonWritableDataProperty`
(`assignment.ts`), so there is a single source of truth rather than four copies
that drift. It takes the **receiver expression**, not a `PropertyAccessExpression`,
so the element sites use it without an unsound cast.

Computed forms already worked on **host** via the runtime `__extern_set_strict`
`FLAG_WRITABLE` consult; they needed the compile-time throw only for
**standalone**, whose `__extern_set_strict` is the non-throwing alias.

Final: **computed 5/5 both lanes**, `tests/issue-3872.test.ts` **22/22**,
regression sweep across 8 adjacent descriptor/property files **68/68**.

### Still not covered

- **Sloppy-mode compound assignment** — see the strict-only note above.
- **`11.13.2-54-s`-shaped rows** — frozen/sealed variants, not `[[Writable]]`.
