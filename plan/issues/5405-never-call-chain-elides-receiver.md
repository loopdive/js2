---
id: 5405
title: "codegen (BOTH lanes): a property read on the result of a `never`-returning call ELIDES the whole receiver expression — `(new C).m().p` never runs `C`'s constructor, so its throw is silently lost and the read answers a non-`undefined` placeholder"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: high
requested_by: ttraenkler/dev-5383-s2d
created: 2026-09-08
---

# #5405 — a `never`-returning call in a member chain drops its receiver's side effects

## Problem

When the RESULT of a call is read as a property, and that call's declared return
type is `never` (its body is only a `throw`), the compiler emits **nothing for
the receiver expression at all**. Constructor side effects do not happen, a
constructor throw is lost, and the read answers a value that is not `undefined`.

Measured 2026-09-08 (`.tmp/s2d/probe18`), on **both** lanes — `--target
standalone --hostBridge off` AND the default `gc` lane, byte-for-byte the same
answers:

| spelling | throws? | constructor ran? |
| --- | --- | --- |
| `(new NS.C).m().p` — `m()` returns `never` | **NO** | **0 times** |
| `(new C).m().p` — same, direct binding | **NO** | **0 times** |
| `(new NS.C).m()` — no trailing property read | yes | 1 |
| `new NS.C()` | yes | 1 |
| `const x = new NS.C; x.m();` | yes | 1 |
| `(new NS.V).m().p` — `m()` RETURNS A VALUE | yes | 1 |

So the trigger is precisely: **a property read on a call whose return type is
`never`**. Drop the trailing `.p`, or give `m()` a value-returning body, and the
receiver is compiled normally.

### Reduction (10 lines, no Temporal, no linking)

```js
let hits = 0;
class C {
  constructor() { hits++; throw new RangeError("ctor"); }
  m() { throw new RangeError("m"); }        // returns `never`
}
const NS = { C: C };
export function chain() {
  try { const v = (new NS.C).m().p; return v === undefined ? 0 : -1; }
  catch (e) { return 1; }
}
export function ctorHits() { return hits; }   // → 0, must be 1
```

`chain()` answers `-1` (no throw, a non-`undefined` value); it must answer `1`.
`ctorHits()` answers `0`; it must answer `1`.

## Why this matters

This is a **silent wrong answer with a lost side effect**, not a missing
feature: the program observes neither the exception nor the construction. It is
the general form of a real failure — `Temporal.Now.timeZoneId()` on the
standalone lane answers a value instead of the refusal its
`(new Intl.DateTimeFormat).resolvedOptions().timeZone` body must raise (#5383
S2c/S2d), because the shim's methods all have `throw`-only bodies. Any refusal
shim, assertion helper, or `assertUnreachable()`-style API has `never`-returning
methods, so the pattern is not exotic.

## Where to look

The receiver is dropped, so the fault is on the READ side, not in `new`: the
property-access lowering resolves the receiver's type to `never`, finds no shape
to read from, and takes a "cannot type this receiver → answer the placeholder"
path **without first compiling the receiver for effect**. Everything that
type-checks the member (`src/codegen/property-access.ts`,
`property-access-dispatch.ts`, `property-access-exact-shapes.ts` — the last one
already filters `TypeFlags.Never` out of its member set) is the neighbourhood.

The fix shape is the standard one for an unusable-value path: still compile the
receiver, then `drop` it, and only then answer the placeholder — the same
discipline the `VOID_RESULT` sentinel enforces elsewhere. Better still, a call
whose static type is `never` should be emitted followed by `unreachable`, since
control cannot continue past it.

## Acceptance criteria

- The reduction above answers `chain() === 1` and `ctorHits() === 1` on the
  `gc` lane and host-free `--target standalone`.
- The five non-triggering spellings in the table keep their current answers
  (they are already correct; a test pins them so a fix cannot regress them).
- `Temporal.Now.timeZoneId()` raises the shim's `RangeError` in a standalone
  build of the polyfill (measured in #5383 as `no-throw` today).
- No change to any module that has no `never`-returning member call: byte A/B.
