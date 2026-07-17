---
id: 3163
title: "`new (Fn as any)()` on a function-style constructor returns null (dynamic-callee construct drops the instance)"
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-b
sprint: current
priority: medium
horizon: m
feasibility: medium
created: 2026-07-12
updated: 2026-07-17
task_type: bugfix
area: codegen
language_feature: function-constructors, new-expression, any-callee
goal: self-hosting-dogfood
related: [1725, 1632, 3033, 3005]
origin: "blocked minimal repros while investigating #3033 Bug 2a (dev-3051c)"
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
---

# #3163 — `new (Fn as any)()` on a fnctor returns null

## Problem

Constructing a function-style constructor (fnctor) through an `any`-typed /
cast callee expression returns **null** instead of the instance. The direct
`new Fn()` (bare identifier callee) works; routing the callee through
`(Fn as any)` (or any expression whose type erases the concrete ctor) takes the
dynamic-construct path, which drops the instance and yields null.

## Minimal repro (compiled returns null, node/V8 returns the instance)

```ts
function P(this: any): void { this.v = 7; }
export function test(): string {
  const p: any = new (P as any)();   // p === null  (should be { v: 7 })
  return p === null ? "NULL" : ("ok v=" + (p.v as number));
}
```

Both `new (P as any)()` and a `new (P as any as { new(): any })()` cast return
NULL. The bare `new P()` identifier-callee path is unaffected (works).

## Why it matters

This blocks **minimal-scale reproduction** of every fnctor-instance codegen bug:
any probe that constructs a fnctor via a cast/`any` callee (the natural way to
write a compact repro without a full type-annotated ctor) gets a null instance
and masks the behavior under test. It surfaced while validating #3033 Bug 2a
(`var ty = this.type` off a fnctor `this`) — the fix could only be verified at
acorn scale because the 2-3-line repros all hit this null. Likely also affects
real code that stores a constructor in an `any`/loosely-typed slot and `new`s it
(the acorn `new this(...)` / `new C(...)` dynamic-ctor idioms, cf. #1632b's
`__construct_closure` follow-up).

## Suggested approach

The dynamic-callee `new` path (grep `new-super.ts` for the `any`/externref
callee arm and the `_wrapCallableForHost.construct` host bridge, runtime.ts)
must return the constructed instance, not null. Compare against the working
bare-identifier fnctor `new` path (`__fnctor_<Name>_new`, new-super.ts ~1426)
and the host construct trap (`_wrapCallableForHost`, runtime.ts ~6800) — the
instance is built but not threaded back through the `any`-callee coercion.
Check the return-value coercion of the dynamic construct expression (the result
is likely coerced externref→struct and null-dropped, mirroring #1725's
ref.cast-null family).

## Acceptance

- `new (P as any)()` returns `{ v: 7 }` (not null); `new P()` regression-free.
- A minimal fnctor-via-cast construct + field read round-trips.
- No test262 regression.

## Fix (fable-b, 2026-07-17)

Root cause was simpler than the suggested dynamic-path theory: the CLASS and
FNCTOR identifier arms in `compileNewExpression` (new-super.ts) gated on the
RAW callee node — `ts.isIdentifier(expr.expression)` — so any cast/paren
wrapper missed both arms entirely and fell to the dynamic path's null base.
No host bridge was even reached (traced: zero imports fire; the null is
static). The #1528b unwrap (`unwrappedNonId`) already existed for the
non-constructor GUARDS; the fix routes the identifier ARMS through the same
unwrapped node (`calleeIdent`), including the `getSymbolAtLocation`
resolution (a cast node has no symbol of its own).

Fixed shapes (tests/issue-3163.test.ts, 5/5): `new (P as any)()`,
`new (P as any as { new(): any })()`, `new (C as any)()` for a compiled
class (same raw-node gate), bare `new P()` unregressed, and the
`new ((() => {}) as any)()` / `new (Math as any)()` TypeError guards still
fire (they run before the arms).

Observed pre-existing residual (NOT this issue, present on bare `new Pt(2,5)`
too): a 2-arg fnctor whose ctor sums params yields the second arg only
(`this.s = x + y` reads 5, not 7) — the cast path now matches the bare
path's behavior exactly, which is this issue's acceptance bar.
