---
id: 6477
title: "standalone: `void 0 === x` / `void 0 !== x` answers WRONG for an undefined `x` — the nullish-comparison arm recognises only the identifier `undefined`, so every minified `undefined` test is miscompiled"
slug: 6477-standalone-void-0-undefined-comparison
status: in-progress
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
parent: 5383
goal: standalone-gap
assignee: ttraenkler/dev-5383-s16
created: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6477, S16) — the predicate itself lives in the NEW module
  #   src/codegen/void-undefined-operand.ts. What grows in the god-file is the
  #   one place it can go:
  #   binary-ops.ts  +21  the two operand tests in `compileBinaryExpression`'s
  #     nullish-comparison arm, plus the lane gate and the note that justifies
  #     it. Almost all of the growth is that note, and it is load-bearing: it
  #     records the MEASUREMENT (`.tmp/s16/gcprobe.mjs`, all seven shapes
  #     correct on the JS-host lane BEFORE the fix) that says the host lane must
  #     NOT take this arm. A reader who deletes the gate as an inconsistency
  #     moves host-lane bytes for an answer that was already right, and no
  #     behavioural test would catch it. The tests cannot move either: this arm
  #     RECOGNISES its operand instead of compiling it, so the predicate has to
  #     be read at the same point the arm decides.
  - src/codegen/binary-ops.ts
func-budget-allow:
  # 2026-09-13 (#6477, S16) — the same 21 lines counted against the enclosing
  #   function. `compileBinaryExpression` is where the nullish shortcut decides;
  #   extracting the decision would need the whole operand cascade passed out,
  #   which is a refactor of the arm, not of this fix.
  - src/codegen/binary-ops.ts::compileBinaryExpression
---

> **Issue id reserved?** NO. `scripts/claim-issue.mjs --allocate` exits **6**
> (`open-PR id scan DEGRADED — gh offline/unauthenticated`) for the whole of
> this session, and GitHub pushes are refused with HTTP 403. The id **6477** is
> the next one after #6476 (this slice's first issue, itself unreserved for the
> same reason). It has not been checked against in-flight PRs.

## Problem

`compileBinaryExpression`'s null-and-undefined comparison shortcut
(`src/codegen/binary-ops.ts`) recognises the undefined literal as the
**identifier** `undefined` only:

```ts
const rightIsUndefinedId = ts.isIdentifier(expr.right) && expr.right.text === "undefined";
```

A `void 0` operand falls past it into the generic reference equality, which
compares an `externref` undefined sentinel against whatever carrier the other
operand has. On standalone that comparison is structural, and it answers "not
equal" for a value that **is** undefined.

Measured standalone on this tree (`.tmp/s16/red4.mjs`, one module per row, no
provider and no link):

| source | base | correct |
| --- | --- | --- |
| `let a = undefined; void 0 !== a` | `true` | `false` |
| `const a = m[1]; void 0 === a` (unmatched group) | `false` | `true` |
| `const a = m[1]; void 0 === a ? "u" : "S"` | `"S"` | `"u"` |
| `undefined !== a` (identifier form) | `false` | `false` ✓ |

Every minifier emits `void 0`, never `undefined`, so this is not an exotic
form — it is the **only** form a bundled dependency uses.

## Why it gates #5383

`@js-temporal/polyfill`'s `ToTemporalDuration` (minified `sn`) guards each
fractional capture group before concatenating it:

```js
const c = t[7], d = t[8], h = t[9], u = t[10], l = t[11];
if (void 0 !== c) { if (d ?? h ?? u ?? l) throw …; y = 3600 * _e((c + "000000000").slice(0, 9)) * n; }
```

The guard admitted a NULL group, so `c + "000000000"` dereferenced it: **8
Duration + 3 ZonedDateTime rows** in the #5383 three-family sample were failing
with `dereferencing a null pointer in __str_concat() … via sn`. That bucket is
the whole residue of the 18-row `sn()` bucket that #6476 moved one step.

## Root cause

The predicate is syntactic and was never widened past the identifier form. The
arm **recognises** the literal operand rather than compiling it, which is why
the obvious widening (`ts.isVoidExpression`) is not safe on its own: `void f()`
must still evaluate `f()`.

## Fix

`src/codegen/void-undefined-operand.ts` — `isInertUndefinedLiteral(expr)`,
true for the identifier `undefined`, the `undefined` keyword, and
`void <inert literal>` (numeric / bigint / string / template / regex / `true` /
`false` / `null`). An identifier operand is deliberately **excluded** from the
`void` arm: a TDZ read of a `let` throws, which is an effect.

**Applied on the native-semantics lane only, and that is measured.** With a JS
host the generic fallback hands both operands to the host `===`, which already
implements §7.2.16 for this shape — probed on both trees with
`.tmp/s16/gcprobe.mjs`, all seven shapes correct **before** the fix. Widening
the predicate there would move bytes for an answer that is already right.

## Acceptance criteria

- `void 0 === x` / `!==` / `==` answer as JS does on standalone, for an
  `undefined` binding, a null native-string element and a non-nullish value.
- `void f() === x` still evaluates `f()`.
- The `gc` lane is byte-identical, including on the `void 0` shapes.
