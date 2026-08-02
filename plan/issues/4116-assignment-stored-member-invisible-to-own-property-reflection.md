---
id: 4116
title: "An assignment-stored member is invisible to own-property reflection — `hasOwnProperty`/`in`/`for-in`/computed read all say NO while the static read says YES"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: ES5
language_feature: own-properties
goal: standalone-mode
related: [4096, 4086, 4010, 3537, 3468]
---

# #4116 — an assignment-stored member exists for the static read and for nothing else

Split out of **#4096** with the evidence already measured. #4096 fixed the
*call* half (`o.f()` silently answered `undefined` and never ran the callee).
This is the *reflection* half, which is a different subsystem and was
deliberately not folded in.

## The disagreement

Standalone lane, top-level object literal, member added by assignment:

```js
var o = { a: 1 };
o.b = 42;
```

| probe | answer | correct? |
| --- | --- | --- |
| `o.b` (static read) | `42` | ✅ |
| `o.b = X; o.b = Y; o.b` | `Y` | ✅ — it is a **real runtime store** |
| `o.hasOwnProperty("b")` | `false` | ❌ |
| `"b" in o` | `false` | ❌ |
| `for (var k in o)` sees `"b"` | no | ❌ |
| `o["b"]` (computed read) | `undefined` | ❌ |
| `Object.keys(o)` includes `"b"` | yes | ✅ |

The **declared** field `a` answers every one of these correctly, so this is not
"closed structs have no reflection" — it is specifically the
assignment-added member that half the paths cannot see. `Object.keys` and the
static read agreeing while `hasOwnProperty` and the computed read disagree is
the sharpest statement of the bug: three different notions of "what properties
does this object have" are live at once and two of them are wrong.

Both halves reproduce identically with a `.ts` and a `.js` (expando-widening)
`fileName`, so this is not a TypeScript-mode artifact.

## Mechanism (measured, not inferred)

`object-ops.ts` answers a closed-struct `hasOwnProperty` from **two** sources:
the Wasm struct definition's field names (`resolveWasmType(receiverType)`) and
the checker's `receiverType.getProperties()`. The assignment-added member is in
**neither**:

- `ctx.oracle.propertyFactOf(o, "b")` answers `unresolvable` — the checker
  never learned about it (verified on both `.ts` and `.js` compiles).
- The struct that `resolveWasmType` resolves from the **TS type** is not the
  (wider) struct codegen actually built for the object, which is why the read
  succeeds and the reflection does not.

The native `__hasOwnProperty` only handles the OPEN `$Object` receiver
(`ref.test $Object` → 0 otherwise), so a closed-struct receiver never reaches a
runtime answer at all.

## Why this is not a one-line fix

Whatever makes the reflection see the member has to move `hasOwnProperty`, `in`,
`for-in` and the computed read **together** — they must not be cured one at a
time, or the object gains a fourth inconsistent notion of its own properties.
That is a change to which shape/struct the receiver resolves to, i.e. squarely
the #4086 / #4010 receiver-side-table unification territory. It is a bigger
blast radius than #4096's call arm, which was provably non-displacing (it sat in
front of a path that already produced `undefined`); this one is not.

## Acceptance criteria

- All six probe rows above answer correctly for an assignment-stored member, on
  both lanes.
- The declared-field rows stay correct (they pass today — a change that breaks
  them is wrong).
- `Object.keys` / `getOwnPropertyNames` / `for-in` / `in` / `hasOwnProperty`
  agree with each other for the same object, which is the actual invariant.
- Kill-switch seen to fail.
- Scoped standalone A/B with floored row counts and stated denominators; any
  apparent regression re-run solo.

## Not in scope

The **call** half — fixed in #4096. A RegExp receiver's expando member, where
even the static read is wrong (`var g = r.f; g()` is already incorrect), is a
third, separate defect and is not this issue either.
