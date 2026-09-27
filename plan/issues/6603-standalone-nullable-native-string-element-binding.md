---
id: 6603
title: "standalone: `const c = m[7]` binds a NULL native string to a non-null slot, so every later read of the binding asserts non-null (truthiness, `||`, `??`, concat all trap)"
slug: 6603-standalone-nullable-native-string-element-binding
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
parent: 5383
goal: standalone-gap
assignee: ttraenkler/dev-5383-s16
created: 2026-09-13
completed: 2026-09-14
loc-budget-allow:
  # 2026-09-13 (#6603, S16) — the mechanism lives entirely in the NEW module
  #   src/codegen/nullable-native-string-elem-binding.ts. What grows here is the
  #   SECOND of its two call sites and cannot move out of the god-file:
  #   statements/variables.ts  +5  `compileVariableStatement`'s `wasmType`
  #     cascade now ends in the filter, plus the note saying WHY a second call
  #     site exists at all. The authoritative slot-typer is the let/const
  #     pre-hoist in index.ts and a let/const normally REUSES its pre-hoisted
  #     slot — but `saveBlockScopedShadows` removes a block-scoped name from
  #     `localMap` on block entry, and the re-allocation then runs this cascade
  #     instead. A reader who deletes this call as redundant reopens the defect
  #     for exactly the bindings that live inside a nested block, which is a
  #     shape no byte A/B over the flat reduction would show.
  - src/codegen/statements/variables.ts
func-budget-allow:
  # 2026-09-13 (#6603, S16) — same five lines, counted against the enclosing
  #   function. The filter has to be applied where `wasmType` is finally
  #   settled, which is inside `compileVariableStatement`; hoisting it out would
  #   mean recomputing the whole cascade in a second place, i.e. the two-sources
  #   -of-truth hazard the #6602 module note warns about.
  - src/codegen/statements/variables.ts::compileVariableStatement
---

> **Issue id reserved?** NO, and it has already COLLIDED once. `claim-issue.mjs
> --allocate` exits **6** (`open-PR id scan DEGRADED — gh
> offline/unauthenticated`) for this whole session and pushes are 403 for every
> lane, so the id was hand-picked.
>
> This file was first written as **#6476**. While it was unpushed, `main` landed
> the whole `linked-harness` family on 6474–6477, and
> `check:issue-ids:against-main` went red on all four of this stack's ids at
> once (6474 → `linked-harness-prelude-module-goal`, 6475 →
> `linked-provider-realm-error-constructors`, 6476 →
> `linked-harness-async-done-marker`, 6477 →
> `linked-harness-descriptor-reads`) — reported by the S17 lane, reproduced here
> on a fresh catch-up merge. The four were renumbered to **6601–6604**, leaving
> 6600 to the S17 lane, from a `--allocate --dry-run` preview (`next free id
> would be #6600`).
>
> **6603 is therefore still UNRESERVED and unchecked against in-flight PRs** —
> the same exposure that caused the first collision. The required
> `check:issue-ids:against-main` gate is the backstop.

## Problem

S15 (#6602) fixed the array-HOF callback boundary for a nullable vec element,
which unblocked the polyfill's `t.every(…)` guard in the minified
`ToTemporalDuration` (`sn`). The 22-row bucket then moved **one step later in
the same function** — 18 rows now trap at `__str_flatten` on a null pointer,
inside exactly this source:

```js
const t = Ye.exec(e);
…
const n = "-" === t[1] ? -1 : 1, …, c = t[7], d = t[8], h = t[9], u = t[10], l = t[11];
let m = 0, f = 0, y = 0;
if (void 0 !== c) {
  if (d ?? h ?? u ?? l) throw new RangeError("only the smallest unit can be fractional");
  …
```

`d ?? h ?? u ?? l` is a nullish chain over four bindings that are **null native
strings** whenever their capture group did not participate, and the implicit
ToBoolean of the chain's result traps.

### The defect is the BINDING, not the operator

Reduced on this tree (`.tmp/s16/red.mjs`, `.tmp/s16/red2.mjs`, one standalone
module per row, no provider and no link):

| source | standalone answer |
| --- | --- |
| `m[1] ? "T" : "F"` (inline) | `"F"` ✓ |
| `const a = m[1]; a ? "T" : "F"` | **TRAP** null pointer |
| `const a = m[1]; String(a \|\| "fb")` | **TRAP** |
| `const a = m[1]; String(!a)` | **TRAP** |
| `const a = m[1]; "" + a` | **TRAP** |
| `const a = m[1]; String(Boolean(a))` | **TRAP** |
| `"" + m[1]` (inline) | `"undefined"` ✓ |
| `const a = m[1]; String(a === undefined)` | `"true"` ✓ |
| `const a = m[1]; typeof a` | `"string"` ✗ (should be `"undefined"`) |
| `const a: string \| undefined = m[1]; a ? "T" : "F"` | `"F"` ✓ |
| `(a) => a ? "T" : "F"` applied to `m[1]` | `"F"` ✓ |

Every *inline* read of the element is correct, and so is every read through a
parameter or an explicitly-`| undefined`-annotated binding. Only the plain
`const`/`let` binding is wrong — and it is wrong for **all** of its consumers at
once, which is why the symptom looked like a ToBoolean bug. `emitToBoolean`
already has the right arm (#3548 routes a `ref_null $anyStr` through the
null-guarded `__str_truthy`); it simply never sees `ref_null`.

### Root cause

`walkStmtForLetConst` (the **authoritative** let/const slot-typer,
`src/codegen/index.ts`) ends its cascade at `resolveWasmType(ctx, varType)`.
The checker types `t[7]` as `string` — `RegExpExecArray extends Array<string>`
— and `resolveWasmType`'s native-string arm returns the **non-null**
`{kind:"ref", typeIdx: anyStrTypeIdx}`. The stored value is `ref_null $anyStr`.

The slot is *physically* fine (the encoder gives a `ref` local a defaultable
nullable slot, so the store neither traps nor fails validation) — what is wrong
is the compiler's **model** of the slot. `getLocalType` answers `ref $anyStr`,
so every later read reports a non-null native string and takes the arm that
dereferences it: `__str_flatten` for truthiness and for `+`, `ref.as_non_null`
elsewhere. The null survives storage and dies on first use.

This is the same shape of defect as #6602 — a checker type that is a
**nullability lie** about a carrier the compiler knows is nullable — at the
next boundary along: #6602 was the HOF callback parameter, this is the
variable binding.

## Implementation Plan

1. **New module** `src/codegen/nullable-native-string-elem-binding.ts` — a pure
   post-filter `nullableNativeStringElemBindingType(ctx, fctx, decl, resolved)`
   that returns `resolved` unchanged unless **all** of:
   - native strings are live (`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`);
   - the declaration is `let`/`const` (a `var` is reassignable from anywhere,
     which is a wider question than this slice);
   - the initializer (parens/`as`/`!` stripped) is an **element access**;
   - the receiver's wasm carrier is a **vec struct** whose element type is
     exactly `{kind:"ref_null", typeIdx: ctx.anyStrTypeIdx}`;
   - `resolved` is exactly that element type's **non-null twin**.

   Then, and only then, it answers the nullable twin.

2. **Two call sites, one function, so they cannot diverge**: the authoritative
   pre-hoist cascade in `walkStmtForLetConst` (`src/codegen/index.ts`) and
   `compileVariableStatement`'s `wasmTypeBase`
   (`src/codegen/statements/variables.ts`), which is what a block-scoped shadow
   re-allocates from. Both apply it as the last step of their cascade.

### Why the filter is narrowed to a native-string element

A general "any `ref_null` element" version is one predicate away and was
deliberately not taken. `resolveWasmType` returns a non-null `ref` for **class
and object struct types** too, so the general form would re-type every
`const x = objArray[i]` binding in both lanes — a large byte-level blast radius
for a value domain where the consumers have no proven null-aware arms.

For a **native string** the nullable carrier is not an accident of
representation: it IS the compiler's `undefined` for a value TypeScript types
`string` (documented at `ensureRegexMatchVecType` /
`emitRegexExecArrayCall`), and every consumer already has the correct
null-aware arm — the inline-read column of the table above is the proof that
`+`, `===`, `typeof` and ToBoolean all answer correctly once they are *told*
the value is nullable. The general version stays a measured residual.

## Acceptance criteria

- `const a = m[1]` for a non-participating capture group: truthiness, `!`,
  `||`, `&&`, `??`, `+` and `typeof` all answer as JS does, with no trap.
- The `gc` lane is byte-identical on a fixed corpus.
- The three linked Temporal families do not lose a row.
