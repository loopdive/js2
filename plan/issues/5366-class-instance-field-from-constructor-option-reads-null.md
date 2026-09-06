---
id: 5366
title: "A class instance field assigned from a constructor-option object reads back null (hono `new Hono({ router })`)"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
const app = new Hono({ router: new RegExpRouter() });
app.router;        // native: the RegExpRouter instance   wasm: null
app.router.name;   // native: "RegExpRouter"              wasm: TypeError
```

Measured through the hono upstream harness (`target: gc`, `platform: web`,
`allowJs`), hono v4.12.16 published dist. The relevant source is two lines:

```js
// dist/hono-base.js — HonoBase declares the field with NO initializer
router;
// …and copies the constructor options onto the instance
const { strict, ...optionsWithoutStrict } = options;
Object.assign(this, optionsWithoutStrict);

// dist/hono.js — the subclass then assigns it
class Hono extends HonoBase {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
  }
}
```

The **default** path is fine: `new Hono()` produces a working `SmartRouter`
(routes register, `this.router.add(...)` runs, 11 routes recorded). Only the
path where the value comes from the *options object* yields `null`. Which of
the three candidate mechanisms is responsible is not yet bisected:

- the uninitialized `router;` field declaration re-nulling the slot after the
  subclass assignment (field-init ordering across `extends`);
- the field's inferred struct type being narrowed to the default
  `SmartRouter` shape so storing a `RegExpRouter` fails a `ref.cast`-style guard
  and writes null;
- `options.router` reading null out of the constructor-argument object literal
  (or through the `Object.assign(this, {...rest})` object-rest copy).

A short bisect of those three is the first step — each has a two-line repro.

## Impact

Found while fixing [#5339](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5339-hono-dev-index-whole-module-failure).
It is the last of hono `src/helper/dev/index.test.ts`'s 8 tests
(`getRouterName()` → `Cannot read properties of null (reading 'match')`); the
other six residual failures are
[#5365](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5365-host-closure-bridge-loses-length-and-name).
A constructor that copies options onto `this` is an extremely common library
shape, so the blast radius is likely wider than this one test.

## Acceptance criteria

1. The repro above returns the assigned instance in Wasm.
2. The responsible mechanism is named in the issue before the fix lands (the
   three candidates above are hypotheses, not a diagnosis).
3. Regression test under `tests/` with untyped `.js` two-file fixtures, failing
   on the parent and passing with the fix, plus an anti-vacuity control.
4. A/B over the 17 dogfood suites, per test file.

## Implementation Plan

1. **Bisect the three candidates with one probe file** (standalone `.mjs`,
   `compileAndRunUpstreamModule`, untyped `.js` two-file project, harness
   sanity-checked). Base shape, then one variant per candidate:

   ```js
   class B { r; constructor(o) { const { strict, ...rest } = o; Object.assign(this, rest); } }
   class H extends B { constructor(o = {}) { super(o); this.r = o.r ?? new Y(); } }
   export function probe() { return String(new H({ r: new X() }).r instanceof X); }
   ```

   - A1: delete the `r;` field declaration → flips? ⇒ field-init ordering
     re-nulls the slot after the subclass store.
   - A2: replace the default `new Y()` with `null` → flips? ⇒ the field's
     slot type was inferred from the default branch (`$Y`) and storing an `$X`
     fails a guarded cast and writes null.
   - A3: replace `o.r ?? …` with `o.r` → flips? ⇒ the `??` lowering narrows
     to the right operand's type.
   - A4: delete `Object.assign(this, rest)` → flips? ⇒ the object-rest copy
     is writing the field.
   Exactly one variant should flip; if none does, the literal `{ r: new X() }`
   is the suspect (its anonymous struct's field typed by `X`'s shape — cf.
   #5348 `shapeless-object-type.ts`), and `o.r` alone in a probe settles it.
2. **Fix at the mechanism named by step 1.** The likely one is A2: a class
   field assigned from a value whose static type is not a subtype of the
   inferred slot (a parameter-property read, `any`) must widen the slot to the
   common carrier at class-shape inference time — precedent
   `heterogeneous-scalar-var-widening.ts` (#2011/#4204) for scalars and the
   struct-carrier decision in `struct-carrier-inhabits.ts` (#5327). If A3, the
   `??` lowering's result type must be the union of both operands, never the
   right operand alone. If A1, the field initializer for a declared-but-
   uninitialised field must run *before* the derived constructor's body, at
   the base constructor's start — where JS runs it — not after `super()`
   returns to the subclass.
3. **Regression test**: the repro, the default path as the anti-vacuity
   control (`new H()` works today), and the `Object.assign(this, rest)`
   shape; untyped `.js` two-file fixtures; fails on parent, passes with fix,
   exact counts both ways.
4. **A/B at one HEAD**, 17 suites, per file. hono `helper/dev` +1
   (`getRouterName`). Option-copying constructors are everywhere (axios's
   `Axios` copies `instanceConfig`, jest's config objects) — improvements
   welcome, regressions not.

## Dispatch

Model: **opus**. One probe file names the mechanism; the fix lands in an
existing widening or ordering arm. Dispatch after PR #5676 lands (it carries
this file).
