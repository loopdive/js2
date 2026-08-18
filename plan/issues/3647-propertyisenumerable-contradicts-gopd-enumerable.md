---
id: 3647
title: "Object.prototype.propertyIsEnumerable returns true for a non-enumerable class prototype method, contradicting getOwnPropertyDescriptor().enumerable === false"
status: done
completed: 2026-07-31
assignee: ttraenkler/dev-enumerable
sprint: 78
created: 2026-07-26
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: property-reflection
goal: core-semantics
related: [3603, 3646, 2984, 3479]
origin: "cohort tracker for failures exposed by #3603 S1 host de-inflation (PR #3635)"
# (#3647) The defect IS in `_wrapForHost`'s getOwnPropertyDescriptor trap, which
# lives in the runtime god-file — the proxy trap is the ECMAScript
# `[[GetOwnProperty]]` the engine calls, so there is nowhere else this bit can
# be corrected. The change is one expression plus the comment recording why the
# two obvious `propertyIsEnumerable` sites are NOT on this path, which is the
# thing that cost the previous attempt its cycle.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::_wrapForHost
---

# #3647 — `propertyIsEnumerable` contradicts `getOwnPropertyDescriptor().enumerable`

## RESOLVED 2026-07-31 — root cause was in the host proxy, not in any `propertyIsEnumerable` code

**Fix:** one expression in `_wrapForHost`'s `getOwnPropertyDescriptor` trap
(`src/runtime.ts`, the generic tail of the trap). Tests: `tests/issue-3647.test.ts`.

### The dispatch question the previous diagnosis left open, answered

`C.prototype` **is a WasmGC struct** on host (`_isWasmStruct` → true), and the
borrowed call reaches **neither** of the two localized dispatch sites. Measured
with a positive-controlled instrument (a log at the top of `resolveImport`
fired on the first import — `structuredClone` — proving the channel worked,
while **no import whose intent mentions `numerable` was ever resolved**):

```
[INSTR] __proto_method_call Object.propertyIsEnumerable args=["m"] isStruct=true wrapped=true ret=true
```

`Object.prototype.propertyIsEnumerable.call(C.prototype,"m")` is dispatched by
**`__proto_method_call`**, which `_wrapForHost`-wraps the receiver in the
live-mirror **Proxy** and invokes the **engine's own**
`Object.prototype.propertyIsEnumerable`. §20.1.3.4 therefore reads
`[[GetOwnProperty]]` — the proxy's `getOwnPropertyDescriptor` trap — and that
trap hardcoded `enumerable: true` for every key without a sidecar flags entry,
class prototype members included.

`_readOwnDescriptor` arm 2a (#1364a) had returned `enumerable: false` for those
same names all along, and the trap's **static**-method arm already deferred to
it (#3479). Only the **prototype**-method case fell through. That asymmetry _is_
the filed self-inconsistency.

### Correction to the previous diagnosis (please don't inherit the bad inference)

The earlier note reasoned that because reordering
`_wasmStructPropertyIsEnumerable`'s `if (sc && prop in sc) return 1`
short-circuit didn't move the probe, "the receiver is evidently not taking that
branch". The observation was right; the inference was too narrow. **The function
is not on this path at all** — nor are `Object_propertyIsEnumerable`
(`runtime.ts:12628`) or `__propertyIsEnumerable` (`:12759`). No edit to any of
them could ever have moved this probe. The sidecar short-circuit remains a real
latent bug worth its own issue and its own evidence.

### Measured (fix in place)

Harness: `runTest262File`, both lanes, controls that must hold under any spec
version (`pIE(plain own)===true`, `pIE(absent)===false`). Base-4 probe codes:

| shape                                       | host before | host after | standalone before | standalone after |
| ------------------------------------------- | ----------- | ---------- | ----------------- | ---------------- |
| inline `Object.prototype.pIE.call(C.p,"m")` | **true** ✗  | false ✓    | false ✓           | false ✓          |
| variable-extracted `f.call(C.p,"m")`        | **true** ✗  | false ✓    | false ✓           | false ✓          |
| uncurried `call.bind(...)` (propertyHelper) | **true** ✗  | false ✓    | false ✓           | false ✓          |
| direct `C.prototype.pIE("m")`               | false ✓     | false ✓    | false ✓           | false ✓          |

Whole-probe codes: host `1365 → 2457` (all 6 observations correct);
standalone `2473 → 2473` and `2729 → 2729` — **byte-identical, structurally
untouched**, which was the standing requirement.

### Real-corpus attribution, decomposed (NOT a promised pass delta)

12 baseline rows carrying `descriptor should not be enumerable`, host lane:
**0/12 → 2/12 pass.** The honest decomposition of the other 10:

- **4 class/elements rows moved PAST the enumerable assertion** onto a _later,
  different_ one (`obj['a'] descriptor value should be undefined`,
  `obj['b'] descriptor should be writable`). See "UNMASKED defect" below — this
  is a finding with its own identity, not a shortfall of this fix.
- **6 rows unmoved**: `Object/defineProperties/15.2.3.7-6-a-*`,
  `Object/defineProperty/15.2.3.6-4-*`, `arguments-object/mapped/*`,
  `Array/prop-desc.js`. These are `defineProperty`/mapped-arguments/global
  receivers travelling the `scFlags` sidecar path this change does not touch.

The full signature spans **957 baseline rows** (47,837 host records, baseline
`20260731-061403`). That is a **ceiling, not an expectation**: the sample says
class-prototype-method rows are addressed, while the `defineProperty` and
mapped-`arguments` families need separate work. Each row must still pass
everything else it asserts.

### Regression guard

60 baseline-**passing** rows sampled across `class/`, `Object/assign`,
`Object/keys`, `Object/entries|values`, `getOwnPropertyDescriptor|Names`,
object-spread and for-in: **59/60 pass**. The single failure
(`built-ins/Object/keys/name.js`) was attributed by **kill-switch removal** —
it fails identically with the fix reverted on stock `origin/main`, so it is
pre-existing baseline drift, not a regression from this change.

`tests/issue-3647.test.ts` (19 rows) was kill-switched: **10 fail with the fix
reverted**, and the 9 that stay green are exactly the controls, the
already-correct direct form, the over-fire guards and the standalone rows.

**Full `tests/equivalence/` suite (213 files, 1,646 rows), run on BOTH trees.**
With the fix and with `src/runtime.ts` reverted to `origin/main`: `12 failed |
201 passed` files, `32 failed | 1611 passed | 3 todo` rows — identical. Then the
12 failing files were re-run with the fix restored and the failing **test-name
sets diffed**: `IDENTICAL FAILURE SETS`. So the attribution is at set level, not
merely matching counts (matching counts alone could mask a swap). **Zero of the
32 is attributable to this change**; they are pre-existing on `origin/main`
(mostly `standalone`/`standalone-O` coercion rows failing `unreachable`).

### UNMASKED defect — class FIELD descriptors on the instance (needs an id)

Fixing `m` lets `verifyProperty` proceed to keys it previously never reached,
which **exposes** a second, independent defect. In
`class/elements/same-line-gen-computed-names.js` the sequence is

```js
verifyProperty(C.prototype, "m", { enumerable: false, configurable: true, writable: true }); // now passes
verifyProperty(c, "b", { value: 42, enumerable: true, writable: true, configurable: true }); // now REACHED, fails
```

with `obj['b'] descriptor should be writable`, and in the `literal-names`
variant `obj['a'] descriptor value should be undefined`. `b`/`a` are class
**fields** read off the **instance**, not the prototype — a different receiver,
a different code path, and nothing this change touches. It was invisible while
`m` aborted the test first.

This is the #3468 F1 pattern again: an honest fix **exposes** the next cohort
rather than banking it. Recorded here with its own identity so it is not read
as "the fix only got 2 of 12", and so the next implementer starts from the
instance-field descriptor path, not from `propertyIsEnumerable`.

### Adjacent findings — routed, deliberately NOT folded in

- Standalone `hasOwnProperty` false for an existing class method → **#3875**.

- **#3646 — `gOPD(C.prototype,"m")` trapping with `illegal cast in
  __module_init`: NOT REPRODUCED in this work's harness.** This is a *harness
  difference to state*, not a contradiction to resolve by picking a winner. Two
  agents, two apparatus, one saw a trap and one did not — so both observations
  are recorded with their apparatus attached:
  - #3646/the earlier probe: bare `compile()` + `buildImports` → trap.
  - **This work**: `runTest262File` (both lanes) for the corpus rows, and
    `compile()` + `buildImports` **plus `setInstance` + `__module_init`** for
    `tests/issue-3647.test.ts` → **no trap**; the gOPD-agreement row passes on
    host. The `setInstance` wiring is a real behavioural difference (without it
    the runtime has no exports record and `_wrapForHost` sees an empty field
    set), so it is a plausible source of the divergence and worth checking
    first on #3646.

- **NEW, standalone-only defect → filed as #3895.** (`--allocate` looked like it
  had failed twice — a Node crash dump, then a >600 s timeout — but the second
  invocation had in fact reserved the id in the background. Verified by reading
  `origin/issue-assignments:3895.json` (`status: reserved`), **not** by trusting
  an exit code. No id was burned.) Summary, with the detail in
  `plan/issues/3895-standalone-variable-extracted-borrowed-propertyisenumerable.md`:

  > **Standalone: the variable-extracted borrowed `propertyIsEnumerable`
  > returns `false` for a plainly enumerable own property.**
  > `var f = Object.prototype.propertyIsEnumerable; f.call({a:1}, "a")` yields
  > **false** in standalone; spec requires `true`. Measured via
  > `runTest262File`, standalone lane, probe code `2473` (see probe3 table
  > above) — the **inline** `Object.prototype.propertyIsEnumerable.call(o,"a")`
  > and the **uncurried** `call.bind` forms both answer `true` correctly on the
  > same run, so this is specific to the variable-extracted shape.
  > **Root cause (located):** the borrowed-call synthesis in
  > `src/codegen/expressions/calls.ts` (the `ctx.standalone && …` arm, ~:6962)
  > matches only an *inline* member chain. With the method extracted to a
  > variable the receiver never reaches `compilePropertyIntrospection`, so the
  > call lands on the wasm-native `__propertyIsEnumerable`
  > (`src/codegen/object-runtime.ts:3081`), whose first act is
  > `ref.test $Object` — a closed compiler struct like `{a:1}` fails that test
  > and the helper returns `0`. Host is unaffected (it routes through
  > `__proto_method_call`).
  > **Not a regression from this PR** — the same code was measured before the
  > change (probe3 standalone `2473` both before and after).
> **Claim banner (from the handoff commit) — now RESOLVED, kept for the record.**
> The `issue-assignments` entry had gone stale at `ttraenkler/dev-es5-coercion`
> because the release tooling could not execute (**#3880** — five failures on
> 2026-07-31 across `claim`, `--allocate` and `--release`), and the predecessor
> correctly declined to hand-edit a shared ref. The issue was subsequently
> force-claimed by `ttraenkler/dev-enumerable` **after the predecessor confirmed
> stand-down in writing**, and the record now reads that assignee on branch
> `issue-3647-property-is-enumerable`. Nothing here is available to take.
>
> **The "HOST-LANE ONLY — do not touch standalone" warning was correct and was
> honoured**: the shipped fix touches only the host-side `_wrapForHost` proxy
> trap, and the standalone probe codes are byte-identical before and after
> (`2473 → 2473`, `2729 → 2729`).

> **Cohort tracker.** One of the two failure cohorts EXPOSED (not caused) by
> #3603 S1's host-lane de-inflation. Per the #3468 F1 landing recipe, every
> exposed cohort is routed to a tracker — that is what makes a de-inflation
> honest rather than banked. **This defect predates #3603 S1 and reproduces on
> stock `upstream/main`.**

## Problem

`Object.prototype.propertyIsEnumerable.call(C.prototype, "m")` returns **true**
for a class prototype method, while every other reflective route on the _same
object and key_ correctly reports it as non-enumerable.

Class methods are non-enumerable per ES2015+ (§14.6, MethodDefinition →
`DefineMethod` with `enumerable: false`), so `true` is spec-wrong. More
importantly it is **self-inconsistent**: our own `getOwnPropertyDescriptor`
disagrees with our own `propertyIsEnumerable`.

## Re-measured 2026-07-31 — reproduces; host-lane only; two adjacent findings

**Harness:** `runTest262File`, test262-shaped probe, **both lanes**, with controls
that must hold under any spec version. Controls passed in both lanes
(`({a:1}).propertyIsEnumerable("a") === true`, `…("zz") === false`), which is
what licenses reading the rows below (#3885).

```
host:        ctl_own=true  ctl_bogus=false | pIE=true  | hasOwn=true  | keys_has_m=false
standalone:  ctl_own=true  ctl_bogus=false | pIE=false | hasOwn=false | keys_has_m=false
```

**1. The defect is HOST-LANE ONLY.** Host reports `propertyIsEnumerable → true`
while `Object.keys` on the same object+key correctly omits `m` — the filed
self-inconsistency, confirmed. **Standalone already answers `false` correctly.**
Any fix must not "fix" the lane that is already right.

**2. Standalone has a DIFFERENT defect on the same probe:** `hasOwnProperty`
returns **false** for `C.prototype.m`, which does exist. That is #3875's
finding (*gOPD is correct, hasOwnProperty is broken*), not this issue —
recorded so nobody folds the two together.

**3. NEW — `getOwnPropertyDescriptor(C.prototype,"m")` TRAPS on host.** Not the
`null` that #3646 documents: it raises `RuntimeError: illegal cast in
__module_init()`. Two independent probes crashed on that exact line. This is
strictly worse than a wrong value and probably belongs on #3646 as a severity
correction.

### Dispatch paths located (both gate on `_isWasmStruct`)

- `Object_propertyIsEnumerable` — `src/runtime.ts:12628`
- `__propertyIsEnumerable` — `src/runtime.ts:12759`

Both delegate to `_wasmStructPropertyIsEnumerable` (`src/runtime.ts:5258`) when
the receiver is a wasm struct, else fall through to the host's own
`Object.prototype.propertyIsEnumerable`.

### A latent bug found there, which is NOT this defect

`_wasmStructPropertyIsEnumerable` short-circuits `if (sc && prop in sc) return 1`
— *present in the sidecar ⇒ enumerable*, unconditionally, without consulting the
descriptor. Correct for assignment-created properties (§10.1.6.1 gives those
`enumerable:true`) and wrong for anything whose descriptor disagrees.

**Reordering it to read the descriptor first did NOT change the probe**, so the
receiver here is evidently *not* taking that branch — `C.prototype` is likely not
a wasm struct in host mode, so the native JS fallback answers. The reordering was
reverted rather than shipped: an unvalidated change that fixes nothing measurable
should not land. It is recorded here because it is a real latent inconsistency
worth fixing on its own evidence.

**Next step for the implementer:** determine what `C.prototype` actually is in
the host lane (wasm struct vs plain JS object vs wrapper) and which of the two
dispatch paths the call takes. That single fact decides whether the fix belongs
in `_wasmStructPropertyIsEnumerable`, in the fallback, or upstream in how class
methods are installed on the prototype.

## Measured (stock `upstream/main`, host lane, no test262 harness involved)

```js
var C = class {
  m() {
    return 42;
  }
};
```

| query                                                             | observed |      spec |
| ----------------------------------------------------------------- | -------: | --------: |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').enumerable`     |    false |     false |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').writable`       |     true |      true |
| `Object.getOwnPropertyDescriptor(C.prototype,'m').configurable`   |     true |      true |
| for-in over `C.prototype` — key count                             |        0 |         0 |
| `Object.keys(C.prototype).length`                                 |        0 |         0 |
| **`Object.prototype.propertyIsEnumerable.call(C.prototype,'m')`** | **true** | **false** |

Five routes agree; `propertyIsEnumerable` is the lone dissenter. Verified
**identical with #3603 S1 applied and reverted**, so S1 does not influence it.

All observations use a **numeric** return channel — a string channel is
unreliable across lanes, and `typeof X === "..."` comparisons are unreliable on
host (see #3603's probe notes).

## Why it matters

`propertyHelper.js`'s `isEnumerable` is

```js
return stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name);
```

and `verifyProperty` fails when `desc.enumerable !== isEnumerable(obj, name)`.
So a wrong `propertyIsEnumerable` produces a genuine
`obj['m'] descriptor should not be enumerable` failure for any test that
verifies a class method's descriptor — a large share of the `class/elements`
cohort surfaced by #3603 S1.

It also silently corrupts any user program using `propertyIsEnumerable` for
filtering, independently of test262.

## Acceptance criteria

- `Object.prototype.propertyIsEnumerable.call(C.prototype, 'm')` is `false` for
  a class prototype method.
- `propertyIsEnumerable` agrees with `getOwnPropertyDescriptor().enumerable`,
  `Object.keys`, and `for-in` for the same key — assert the **agreement**, not
  each in isolation, so a future divergence is caught.
- Covered for both the direct call and the uncurried
  `Function.prototype.call.bind(Object.prototype.propertyIsEnumerable)` form
  (the shape `propertyHelper.js` actually uses).
- Assert across **shapes** (simple class, computed-name fields, generator/async
  methods, object literal, plain assignment) — #3642's lesson: an unvaried axis
  is an assumption, not a measurement.

## Reproduction

`.tmp/3603/enum-check.mts` and `.tmp/3603/attribution.mts` in the #3603 S1
worktree; self-contained `compile()` + `buildImports()` probes, no harness.
