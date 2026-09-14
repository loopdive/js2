---
id: 5366
title: "A class instance field assigned from a constructor-option object reads back null (hono `new Hono({ router })`)"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
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

## Resolution

**Mechanism — the `??` join, not the field and not `Object.assign`.**
`compileNullishCoalescing`'s tail (`finishNullishBranch`,
`src/codegen/expressions/logical-ops.ts`) joined its two arms by taking the
RIGHT arm's wasm type outright (`unifiedType = rType`) whenever the arms
differed. The left arm was then pushed through `coerceType(lhs → rhs)`, and an
unproven reference narrowing there is lowered as a GUARDED downcast —
`ref.test $Rhs`, else `ref.null`. So a left value of some other class did not
trap: it silently became `null`.

Measured on the hono dist: `options.router` compiles to `externref`,
`new SmartRouter({...})` to `ref $SmartRouter`. The join took `ref $SmartRouter`,
the `externref` was `any.convert_extern` + guard-cast into it, and a
`RegExpRouter` failed the `ref.test` → `app.router === null`.

None of the issue's three hypotheses was right, and the plan's minimal
four-variant probe did **not** reproduce — because its two classes were
structurally identical, so the guarded cast happened to succeed. What settled
it was a ten-row probe against the real hono dist
(`.tmp/probe-5366-hono2.mjs`); its discriminating rows:

| probe row                                            | base | reads |
| ---------------------------------------------------- | ---- | ----- |
| `new Hono({ router: new SmartRouter(...) })`          | PASS | the cast succeeds when the option IS the default arm's class |
| `new Hono({ router: new RegExpRouter() })`            | FAIL | `null` |
| `new HonoBase({ router: new RegExpRouter() })`        | PASS | the base's `Object.assign` copy is fine — **A4 exonerated** |
| `app.router = new RegExpRouter()` after construction  | PASS | the field slot accepts it — **A1/A2 exonerated** |
| `{ router: new RegExpRouter() }` read back directly   | PASS | the literal is fine |

so the only failing ingredient is `lhs ?? new Default()` with an `lhs` that is
not a `$Default`. A minimal two-file untyped-`.js` repro then reproduced it
exactly (`X` vs `Y` with *different* shapes), and dropping the `??` — the plan's
A3 dial — made it pass.

**Fix.** New `src/codegen/expressions/nullish-join-carrier.ts`:
`nullishJoinCarrier(ctx, lhs, rhs)` picks a carrier that holds BOTH arms —
`externref` when the left arm is on the host plane, the nearest declared struct
common ancestor (falling back to `externref`) when both are internal refs, and
`rhs` only where the coercion is a box/unbox rather than a downcast
(`$AnyValue` on exactly one side). `&&` and `||` have always joined a
non-numeric mismatch at `externref`, and `?:` already joins two internal refs at
their common ancestor with this exact rationale in its comment; `??` was the
outlier.

**Regression test** `tests/issue-5366-nullish-join-carrier.test.ts` — 19 rows
across three lanes (single module, two untyped `.js` modules in one unit,
library in a separately-linked package):

| lane                        | parent wrong | fix wrong |
| --------------------------- | ------------ | --------- |
| single module               | 4            | 0         |
| two modules, one unit       | 4            | 0         |
| separately-linked package   | 5            | 2         |
| **total**                   | **13**       | **2**     |

Parent's wrong rows: `optionRouter` `"null"`, `optionRouterIdentity`
`"different"`, `optionRouterThroughField` `"null"` in every lane, plus
`nullishShortCircuits` `THREW: dereferencing a null pointer` in the two
single-unit lanes. The two that remain are linked-lane only, identical on both
sides, contain no `??`, and are pinned as `LINKED_RESIDUALS` → new issue #6426.
Anti-vacuity controls that already passed on the parent: the default arm, a
same-class option, a post-construction store, the base class's own
`Object.assign`, and eight primitive/array `??` shapes.

**A/B — 17 dogfood suites, one HEAD (`upstream/main` 24411b6763), per test
file.** Base and fix runs are sequential runs of the same 17 suites with only
`logical-ops.ts` swapped.

| suite | base | fix | | suite | base | fix |
| --- | --- | --- | --- | --- | --- | --- |
| hono | 258/324 | **259/324** | | moment | 10/10 | 10/10 |
| axios | 208/231 | 208/231 | | prettier | 105/151 | 105/151 |
| clsx | 32/32 | 32/32 | | redux | 67/82 | 67/82 |
| cookie | 63740/63740 | 63740/63740 | | styled-components | 9/9 | 9/9 |
| jest | 335/356 | 335/356 | | stylelint | 108/108 | 108/108 |
| jsdom | 6/6 | 6/6 | | tailwindcss | 13/13 | 13/13 |
| lodash | 59/62 | 59/62 | | three | 17/18 | 17/18 |
| marked | 16/30 | 16/30 | | uuid | 75/75 | 75/75 |
| | | | | webpack | 16/16 | 16/16 |

Per-file movement across all 17 suites: **+1 / -0** — the single mover is
`hono src/helper/dev/index.test.ts` 1/8 → 2/8, and the test that flips is
`Should return the correct router name` (`getRouterName()`), which is exactly
this issue's acceptance criterion.

**Residuals.**

- hono `helper/dev` stays at 2/8; the other six are #5365 (host closure bridge
  loses `length`/`name`), untouched here.
- The separately-linked lane's `baseObjectAssign` / `otherOptionKey` → new
  issue #6426.
- `??=` / `||=` / `&&=` are a different lowering (`compileLogicalAssignment`
  writes into the target's declared slot type) and were not changed.
- `tests/logical-assignment.test.ts` (13 failures, stale hand-rolled import
  object missing `string_constants`) and
  `tests/issue-4616-nullish-spread-source.test.ts` (2 failures, `illegal cast`)
  fail identically on the parent — verified by re-running both files with
  `logical-ops.ts` reverted. Not caused by, and not reachable from, this change.
