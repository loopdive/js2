# Descriptor cluster dedup map — standalone ES5+untagged goal scope

**Date:** 2026-08-01 · **Produced by:** `g-descriptors` (worktree lost before it could
commit; content captured from its reports by the coordinator) · **Cross-checked by:**
`g-function`

## Scope and instrument validation

Instrument validated **before** any claim: the scan reproduces standalone official
**43,106 run / 25,460 pass (59.1%)** and default **43,096 / 30,500 (70.8%)** exactly.

Goal scope = files carrying `es5id:` frontmatter **or** none of `es5id`/`es6id`/`esid`:
**8,545 run / 6,004 pass / 2,541 fail (70.3%)**. (A 7-file delta from an earlier
8,552/6,010 figure is files absent from the local test262 checkout, dropped by an
`exists` filter.)

Descriptor cluster within that scope: **819 files.**

## HEADLINE: the four tracked issues are near-disjoint and cover under a third

| population | files in the 819 | of which standalone-ONLY |
| --- | ---: | ---: |
| #1906 standalone refusal | 72 | 29 |
| #3663 wrongly-FALSE (over-restricted) | 67 | 23 |
| enforcement family (from `g-function`'s 117) | 67 | 34 |
| #739-S2 `accessed !== true` | 53 | 18 |
| #3662 value-wrong | 31 | 12 |
| #3661 wrongly-TRUE | **11** | 11 |

- **Covered: 299 / 819 (36.5%).**
- **Total overlap across all five populations: 2 files** (both `#3662 + #3663`).
- **Uncovered: 520 (63.5%)**, of which **192 standalone-only**.

The tracker made this subsystem look owned. Nearly two-thirds of it has no owner.

## The #3661-vs-#3663 "opposite directions" trap — resolved, and inverted

#3661 was sized 202+134 = **336** off the default-lane #3603 regression set. In the
standalone ES5 goal scope it maps to **11 files**, against #3663's **67** — over-restriction
outnumbers over-permissiveness **6:1**, the reverse of the default-lane ratio.

The two populations are **disjoint (zero shared files)**, so a fix for one cannot
mechanically regress the other. Carry them as separately-reported arms regardless.

## Corrections to the prior record

1. **The 2026-08-01 baseline predates the #3957 / PR-3945 merge** (merge 05:01 UTC;
   baseline's first record 02:56 local). The 72-file #1906 refusal bucket is therefore
   **already partly retired on current main — do not re-count it.** Use current main as
   the arm-A base wherever it disagrees with the baseline jsonl.
2. **500 / 819 (61.1%)** also fail the default lane, not the previously-stated 57%.
   319 are standalone-only. Per area (shared/total): defineProperty 217/337,
   defineProperties 183/272, create 69/152, gOPD 24/35, prototype 7/23.

## Cross-instrument reconciliation

Two independent censuses of the `Expected a TypeError to be thrown but no exception was
thrown` signature both return **158** goal-wide (not the 108 estimated by summing three
directories). `g-function`'s 117-file family list is a **strict subset**, 117/117 present,
0 missing. Sibling signatures they excluded: RangeError 16, ReferenceError 15, SyntaxError 2.

**48 of the 117 descriptor-caused files live outside `Object/`** — a directory-scoped
census misses every one. Load-bearing example: `compound-assignment/11.13.2-40-s.js`
is filed under compound-assignment but its body is
`Object.defineProperty(obj,'prop',{set:undefined})` then `obj.prop >>= 20`. The defect has
nothing to do with `>>=`.

**The hazard runs both ways.** Directory-scoping hid two `built-ins/Array/length/` files
from `g-descriptors`; a `.call`-pattern census hid 16 transfer-by-assignment files from
`g-function`. Same failure mode, opposite directions, both found only by cross-checking
two independent instruments.

## The proposed lever — in the uncovered 63%, owned by nobody

**Array receiver / `length` target.** Population **102 by mechanism / 100 reachable /
55 standalone-only**. (The two unreachable files are
`built-ins/Array/length/15.4.5.1-3.d-{1,2}.js`: they fail the default lane too, so a
standalone-lane fix cannot flip them. **State it as 102/100/55 so 102 is never read as a
flip ceiling.**) 69 of the 100 are in `defineProperties`, 31 in `defineProperty`.

**Root cause, confirmed in source and by probe:** `maybeEmitVecLengthDefine`
(§10.4.2.4 ArraySetLength — RangeError validation, accessor rejection, the length set) has
**exactly one call site**, `src/codegen/object-ops.ts:1299`, inside
`compileObjectDefineProperty`. **`compileObjectDefineProperties` never reaches it.**

Probe on current main, standalone target, control holding at 3 in every arm:

| case | result |
| --- | --- |
| `Object.defineProperty(arr,"length",{value:2})` | 2 — correct |
| `Object.defineProperty(arr,"length",{value:123.5})` | RangeError — correct |
| `Object.defineProperty(arr,"length",{get(){…}})` | TypeError — correct |
| `Object.defineProperties(arr,{length:{value:2}})` | **3 — WRONG, silently** |

A **silent wrong answer**, not a refusal: nothing downstream can detect it. That is the
argument for priority.

This is a **routing gap over already-working machinery**, distinct from the #3251
per-index overlay-substrate epic (XL, fable-pinned) — so it does not collide with it.

### ✅ CLOSED 2026-08-01 by `g-arraylen` — and the answer is YES, there is a second defect

The open question was whether array `length`'s `writable` is silently dropped on store,
which would be a defect **underneath** the routing gap and invisible to its A/B. The
prescribed single-step probe (set `writable:false`, read straight back via `gOPD`, no
intervening define) was run. Answer: **it is dropped on store.**

**The standalone lane could not answer it.** There `gOPD(arr,"length")` returns
`undefined` even on a **fresh, untouched array**, so the readback instrument is itself
broken and the result is confounded — caught by the in-sweep control, not by the pass
count. **The question was settled on the HOST lane, where the instrument works:** control
`c1` correctly reports `{value: 3, writable: true}` on a fresh array, and yet

```js
var a = [0, 1, 2];
Object.defineProperty(a, "length", { writable: false });
Object.getOwnPropertyDescriptor(a, "length").writable; // true — WRONG
```

Confirmed in source: `maybeEmitVecLengthDefine` lists `writable` among its ignored
descriptor names, commented `// \`writable\` (freeze deferred)`.

It hits `defineProperty` and `defineProperties` **identically**, so it is **not** the
routing gap and #3984's fix does not touch it — exactly as predicted. Two follow-ups fall
out, both unowned and neither fixed in #3984 (queued as TaskList items; ids allocated only
when picked up, to avoid burning reservations as #3890/#3891 were):

- **D2 — `writable` dropped on store for array `length`, BOTH lanes.**
- **D3 — array `length` absent from descriptor reflection on standalone**: `gOPD` returns
  `undefined` and `getOwnPropertyNames` omits it, while `hasOwnProperty` answers `true`.
  Discriminators rule out the alternatives — `gOPD` works on array *indices*, on
  plain-object properties, and on the key `"length"` when the receiver is a plain object.
  D3 is *why* D2 cannot be measured on standalone at all: there is nowhere to store an
  attribute for a property absent from the descriptor model.

All 11 probe files were validated against **Node first** — all pass on a real engine — so
every failure measured is a compiler defect, not a wrong assertion.

## Instrument artifacts caught during this work

Both were caught by the in-sweep control or by reading the failure **signature**, never by
the pass count:

- First probe scored **8/8 compile errors including a bare `return 999` sentinel** —
  `compile()` is async and had not been awaited.
- Second probe reported the **singular** `defineProperty` form broken (12/12 BAD) — false.
  `Object.defineProperty(a as any, …)` defeats `maybeEmitVecLengthDefine`'s
  `resolveWasmType` gate, and **test262 has no casts**. Dropping the cast isolated the real
  defect to the plural form alone. *The unvaried axis was in the harness.*

## Reproducing the 117-file enforcement family from scratch (deterministic)

Both agents lost their worktrees before committing their file lists. The derivation is
fully deterministic — re-derive rather than guess:

1. `.test262-cache/test262-standalone-current.jsonl`, keep `scope_official === true`
   → **must be 43,106 rows / 25,460 pass (59.1%)**. This is the instrument check.
2. Keep files whose test262 frontmatter has `es5id:` **or** none of
   `es5id`/`es6id`/`esid` → **8,545 run / 6,004 pass / 70.3%**.
3. Keep `status !== 'pass'` (2,541) and `error` matching
   `/Expected a TypeError to be thrown but no exception was thrown/` → **158**.
4. The **117** are those matching either
   `^test/built-ins/Object/(defineProperty|defineProperties|create|getOwnPropertyNames)/`
   **or** `^test/language/expressions/(compound-assignment|assignment)/|^test/language/types/reference/|^test/language/arguments-object/|^test/built-ins/global/10\.2\.1|^test/built-ins/Function/15\.3\.5\.4_2-`

**48 of the 117 are outside `Object/`** — an area census under-counts by 40%. All 22
compound-assignment and all 8 assignment files carry `flags:[onlyStrict]` and share one
shape: a **setter-less accessor not enforced on write**; the `>>=` in
`11.13.2-40-s.js` is incidental.

### The 117 is a SIGNATURE, not a MECHANISM (`g-enforce`, 2026-08-01)

`g-enforce` classified all 117 by **what each body actually does**, rather than by the
error string they share:

| mechanism | files | status |
| --- | ---: | --- |
| assignment / compound-assignment | **37** | #3983 — fixed |
| Array-receiver define path | **35** | #3984 — this issue |
| non-Array define path | **31** | **UNOWNED** (TaskList #48) |
| `Function.prototype.caller` poisoning | **11** | — |
| `Object.getOwnPropertyNames` arg validation | **2** | — |
| `arguments.callee` | **1** | — |

**Rule, and it directly reinforces the denominator discipline above: a shared error
string is a SYMPTOM CLASS, not a mechanism. Only reading the bodies yields a mechanism —
sizing a fix off this signature census overstates by ~3×.** "158 files throw the same
message" is a starting point for triage, never an estimate of what one fix will flip.

### Measured mechanism (direct `compile()`, standalone)

Descriptor attributes **are** stored and reflected correctly, and configurability **is**
enforced on redefine — but **attributes are not consulted on the ordinary write path.**

⚠ **RETRACTED 2026-08-01 by `g-enforce` — do not act on this.** The original claim here
was that sloppy-mode assignment to a `writable:false` property traps with a raw
`WebAssembly.Exception` that is not a catchable TypeError, and that the blast radius
therefore exceeded the 117. It **is** a catchable TypeError in-module. The observation
came from a probe with **no try/catch**, where *any* standalone throw surfaces as an
opaque `WebAssembly.Exception` by construction — **the instrument produced the finding,
not the compiler.** There is no blast radius beyond the 117.

**Root cause, found and fixed (#3983) — one line:**
`ctx.funcMap.set("__extern_set_strict", externSetIdx)` aliased the **strict** `[[Set]]`
helper onto the **sloppy** one, whose refusals are all silent `return`s, so every strict
write ES §6.2.5.6 requires to throw did nothing. Measured **+24 / 0 regressions**; the
control's 5 apparent flips were `compile_timeout` contention flakes (re-run solo, 5/5
pass) — counting them would have reported +29.

## Family 3 — builtin prototype methods are not first-class receiver-taking values

34 files, one root cause, **architectural**. Three observation shapes: 14 via
`.call`/`.apply` with a nullish receiver, 4 via `.call` with a wrong-type object, and
**16 via method transfer by assignment** (`s1.toString = Boolean.prototype.toString;
s1.toString()`) — that shape contains **no `.call` at all**, so a `.call`-pattern census
misses half the family.

Evidence, with passing controls: `typeof Object.prototype.hasOwnProperty === 'function'` ✓ ·
`.call` correctly rebinds `this` for **user** functions ✓ · `o.hasOwnProperty('tag')` → true ✓ ·
`o.valueOf() === o` ✓. But `Object.prototype.hasOwnProperty !== o.hasOwnProperty`
(identity fails) and `hasOwnProperty.call(o,'tag')` → **false** via every route.
Architectural cause stated in-source at `src/codegen/expressions/calls.ts:6378`:
*"For standalone functions (no `this`), drop thisArg and call directly."*

**Denominator, so this is not oversold: 106 of the 176 goal-scope files using
`<Builtin>.prototype.<m>.call/apply(` already PASS.** Gap-filling in a mostly-working
special-case table (`tryEmitNativeProtoReflectiveCall`), not a blanket defect.

⚠ **Reification without brand checks would make some files pass *coincidentally*** off a
dropped-receiver `undefined` — the same trap that made 2 of #2928's 5 flips fake.
**Recommendation: do not fund this on 34 files.** If funded, fund it as value-reification
work judged against the combined #3571-refutation and `instanceof`-bound evidence.

## Other families triaged out of this cluster

- **`'use strict'` directive prologue inside a function body does not take effect** — 11 of
  the 15 ReferenceError-signature files are `language/directive-prologue/*-runtime.js`.
  Every one is **standalone-only = 0**, i.e. it fails in **both lanes** — a shared
  front-end/scope-analysis defect, fixable without touching standalone codegen. Unowned.
- **`with` 2** (`language/statements/with/12.10.1-1{0,2}-s.js`) belong to the already
  root-caused global-object-aliasing `with` cluster.
- **RangeError 16** are descriptor-cluster (including 2 in `built-ins/Array/length/`).
