---
id: 3624
title: "Optional chaining does not short-circuit for element access or call chains — `a?.[++x]` evaluates `++x` when `a` is nullish"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
goal: core-semantics
created: 2026-07-25
---

## Problem

Per §13.3.9 / §13.3.10, when the LHS of `?.` evaluates to `null`/`undefined`
the **entire chain short-circuits** and the RHS is _not evaluated_. We only
honour that for plain member access.

Measured (`.tmp/probe-optchain.mts`), `a = undefined`, `x = 1`, **inside a
function body** — a position unrelated to #3615, with #3615's arm **disabled**,
so this is independent of that change. Identical in the host and standalone
lanes:

| expression           | expected      | actual                          |
| -------------------- | ------------- | ------------------------------- |
| `a?.b.c;`            | x stays 1     | correct                         |
| `const v = a?.b.c;`  | x stays 1     | correct                         |
| **`a?.[++x];`**      | **x stays 1** | **x = 2 — `++x` WAS evaluated** |
| **`a?.b.c(++x).d;`** | **x stays 1** | **threw**                       |

So the short-circuit is implemented for the member-access step but **not** for
the element-access step, and the chain-continuation after a call is not
short-circuited either (it throws instead of yielding `undefined`).

## How it surfaced

`test/language/expressions/optional-chaining/short-circuiting.js` scored a
**vacuous pass**: its whole body is

```js
a?.[++x]; // short-circuiting.
a?.b.c(++x).d; // long short-circuiting.
undefined?.[++x];
undefined?.b.c(++x).d;
assert.sameValue(1, x);
```

Every probe statement is a bare top-level property/element read, which #3615
showed was **dropped from `__module_init` entirely**. `x` therefore stayed 1 and
the assertion passed — while testing nothing. With #3615 landed the statements
execute, the defect is reached, and the test correctly fails.

This is the exact vacuity pattern #3613 is about: a dropped statement produced a
test that passed without doing anything, and it hid a real spec violation for as
long as it survived.

## Where to look

The `?.` lowering — the member-access arm gets the nullish guard, the
element-access arm and the post-call continuation do not. Note the argument
(`++x`) must not be evaluated at all, so the fix is a guard on the _whole chain
evaluation_, not a null-check on the result.

## Reproduce

```bash
npx tsx .tmp/probe-optchain.mts     # (see #3615's branch; ~40 lines)
```

or minimally:

```ts
export function test(): number {
  const a: any = undefined;
  let x = 1;
  try {
    a?.[++x];
  } catch (e) {
    return -1;
  }
  return x; // 1 = correct, 2 = the bug
}
```

## Acceptance criteria

- [ ] `a?.[++x]` with nullish `a` leaves `x` unchanged (both lanes)
- [ ] `a?.b.c(++x).d` with nullish `a` leaves `x` unchanged and does not throw
- [ ] The member-access and consumed-read cases stay correct (no regression)
- [ ] `test/language/expressions/optional-chaining/short-circuiting.js` passes
      — it is currently the ONE gated regression declared in #3615
- [ ] A regression test covering element access, call chains, and the
      already-working member case as a control
