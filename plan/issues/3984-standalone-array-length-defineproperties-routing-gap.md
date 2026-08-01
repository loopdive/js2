---
id: 3984
title: "Standalone: `Object.defineProperties(arr, {length: {...}})` never reaches ArraySetLength — the array length is silently left unchanged"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-01
assignee: ttraenkler/g-arraylen
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, property descriptors
es_edition: es5
goal: standalone-mode
related: [3251, 3661, 3662, 3663, 1906, 739, 2668]
origin: "2026-08-01: highest-confidence unowned lever in the standalone ES5+untagged goal scope; identified in plan/log/analysis-2026-08-01-descriptor-dedup-map.md as the largest uncovered descriptor family."
---

# `Object.defineProperties` never reaches `maybeEmitVecLengthDefine`

## Problem

`maybeEmitVecLengthDefine` (`src/codegen/object-ops.ts`) implements §10.4.2.4
ArraySetLength for WasmGC vec receivers: RangeError validation of the new
length, rejection of accessor descriptors on `length`, the illegal
attribute-change TypeError, the backing-store grow, and the actual length set.

It had **exactly one call site** — inside `compileObjectDefineProperty`. The
static object-literal expansion inside `compileObjectDefineProperties`
**re-parses the descriptor inline** instead of delegating, so it never reached
that machinery.

The consequence is not a refusal. It is a **silent wrong answer**:

```js
var a = [0, 1, 2];
Object.defineProperties(a, { length: { value: 2 } });
a.length; // 3  — WRONG, and nothing throws
```

Nothing downstream can detect this. A refusal (`compile_error`, an explicit
"not yet supported" throw) is visible to the report's root-cause classifier and
to the standalone floor; a wrong *value* is not. That is the priority argument:
this defect is invisible by construction.

This is a **routing gap over already-working machinery** — the singular
`Object.defineProperty(arr, "length", …)` form is correct today, including the
RangeError and accessor-rejection paths. It is therefore distinct from the
**#3251 per-index overlay-substrate epic** (XL, fable-pinned), which is about
giving array indices real descriptor records. #3984 adds no substrate; it routes
an existing, tested code path to a second caller. The two do not collide.

## Evidence

All probe files were **validated against Node first** — all 11 pass on a real
engine, so every failure below is a compiler defect and not a wrong assertion.
Probes live in `.tmp/probe-arraylen/` (gitignored); `node-oracle.mjs` is the
validator.

| # | probe | Node | host lane | standalone (main) |
|---|---|---|---|---|
| c0 | control: `a.length`, `a[1]` on a fresh array | PASS | PASS | PASS |
| g2 | `defineProperty(a,"length",{value:2})` | PASS | PASS | **PASS** |
| g1 | `defineProperties(a,{length:{value:2}})` | PASS | PASS | **FAIL — length stays 3** |
| c1 | `gOPD(a,"length")` on a fresh array | PASS | PASS | **FAIL — `undefined`** |
| d1 | `gOPD(a,"0")` | PASS | PASS | PASS |
| d2 | `gOPD({x:7},"x")` | PASS | PASS | PASS |
| d3 | `a.hasOwnProperty("length")` | PASS | PASS | PASS |
| d4 | `gOPN(a)` includes `"length"` | PASS | PASS | **FAIL — not listed** |
| d5 | `gOPD({length:3},"length")` | PASS | PASS | PASS |
| w1 | `defineProperty(a,"length",{writable:false})` → `gOPD().writable` | PASS | **FAIL — reads back `true`** | FAIL (confounded, see below) |
| w2 | `defineProperties(a,{length:{writable:false}})` → `gOPD().writable` | PASS | **FAIL — reads back `true`** | FAIL (confounded) |

`g1` failing on standalone while **passing on the host lane** is what makes this
a standalone-lane routing defect rather than a shared front-end bug.

## Three distinct defects, not one

The probe sweep separated three defects that were previously entangled. **Only
the first is in scope for #3984.**

### D1 — the routing gap (standalone-only) — THIS ISSUE

`compileObjectDefineProperties`' static expansion never called
`maybeEmitVecLengthDefine`. Fixed here.

### D2 — array `length`'s `writable` is silently dropped on store (BOTH lanes)

**This closes the open question the dedup map flagged as blocking.** An earlier
two-step probe was withdrawn as ambiguous between a `[[DefineOwnProperty]]` gap
and a failure to *store* `writable:false`. The single-step readback resolves it.

On the **host lane**, where `gOPD` on array `length` is fully functional —
proven by control `c1`, which correctly reports `{value: 3, writable: true}` on
a fresh array — setting `writable:false` and reading straight back with **no
intervening define** returns `true`:

```js
var a = [0, 1, 2];
Object.defineProperty(a, "length", { writable: false });
Object.getOwnPropertyDescriptor(a, "length").writable; // true — WRONG
```

This is unambiguous: the readback instrument is sound on that lane (`c1` proves
it), and the store still does not take. It affects **both** the singular and
plural forms (`w1` and `w2` fail identically), so it is **not** the routing gap
and the #3984 fix does not touch it. It is a **second defect underneath**, and
it is invisible to this issue's A/B — exactly as predicted. `maybeEmitVecLengthDefine`
is explicit about this: `writable` is in the ignored-names list, commented
`// \`writable\` (freeze deferred)`.

### D3 — array `length` is absent from descriptor reflection (standalone-only)

On standalone, `gOPD(arr,"length")` returns `undefined` (c1) and
`getOwnPropertyNames(arr)` omits `"length"` (d4) — while
`arr.hasOwnProperty("length")` answers `true` (d3). The discriminators rule out
the obvious alternatives: `gOPD` works on array *indices* (d1), on plain-object
properties (d2), and on the key `"length"` when the receiver is a plain object
(d5). So the vec's `length` is a struct field with no descriptor record, and
`hasOwnProperty` has a special case the reflection surface lacks.

D3 is why the `writable` question **cannot** be answered on the standalone lane
at all: there is nowhere to store an attribute for a property that does not
exist in the descriptor model. D2 and D3 should be filed and funded separately;
both are plausibly prerequisites for #3251.

## Fix

`src/codegen/object-ops.ts`, in the per-key loop of
`compileObjectDefineProperties`' static object-literal expansion: delegate to
`maybeEmitVecLengthDefine` before the inline descriptor parse.

The helper is **fully self-gating** (string key `"length"`, object-literal
descriptor, side-effect-free receiver resolving to a WasmGC vec struct) and
returns `false` for everything it does not own, so the call is a no-op for every
other property and every non-array receiver.

Two downstream effects had to be handled explicitly:

- **Stack balance.** The helper is written for the singular form, whose call
  result *is* the receiver, so it leaves a value on the stack. This loop's
  per-key code must leave the stack empty (the receiver is pushed once at the
  end from `objLocal`), so the value is dropped. The throw branches emit
  `unreachable` before returning, which makes the trailing `drop` validate as
  unreachable code.
- **Key order.** The check sits *inside* the per-key loop, so descriptors are
  still applied in source key order, as §7.3.26 DefinePropertiesRoutine requires.

The receiver is recompiled by the helper rather than read from `objLocal`; that
is safe precisely because the helper's own `isSideEffectFreeReceiver` gate
requires it, and it keeps this call site identical to the existing one.

## Acceptance criteria

- `Object.defineProperties(arr, {length: {value: n}})` sets the length on the
  standalone target, matching the singular form.
- RangeError / accessor-rejection / illegal-attribute behaviour reaches the
  plural form too (same machinery, same call).
- No regression in the default lane, and no movement in the in-sweep controls.
- Attribution demonstrated by kill-switch removal, not by a before/after count.

## Measurement

Instrument validated before any claim: the scan reproduces standalone official
**43,106 run / 25,460 pass (59.1%)** and the ES5+untagged goal scope
**8,545 / 6,004 (70.3%)** exactly.

**The population is GATED, not a forecast.** Results, denominators and the
paired A/B are recorded in the "Result" section below.
