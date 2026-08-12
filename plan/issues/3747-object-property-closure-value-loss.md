---
id: 3747
title: "Silent runtime bug: assigning a closure to an existing object-literal property loses callability (typeof reports 'object', call throws/returns null) — no diagnostic"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-08-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: dynamic-property-assignment
goal: core-semantics
origin: "surfaced testing more npm packages for tests/dogfood/ — dayjs@1.11.21's dayjs.min.js is a UMD bundle (module.exports = factory()); reaching its export via a module.exports shim compiled clean and validated, but every call through the exported value failed with 'null is not a function' instead of running dayjs code. Reduced to a minimal repro fully independent of dayjs."
related: [3720, 3721, 3743, 1710, 3716]
---

# #3747 — object-property closure assignment silently loses callability

## Severity

This is **not a compile-time diagnostic gap** (unlike #3721) and **not a
thrown error** (unlike #3720) — it is a **silently wrong runtime result**.
`compile()` reports `success: true`, the binary validates, instantiates,
and runs without throwing anywhere near the actual bug — the property
just quietly stops being callable. That makes it the most dangerous class
of the three: nothing in the existing pipeline flags it.

## Minimal repro (fully independent of dayjs/npm)

```js
var obj = { fn: null };
obj.fn = function inner() { return 42; };

export function t1() { return typeof obj.fn; } // expect "function", got "object"
export function t2() { return obj.fn(); }        // expect 42, got: throws "null is not a function"
```

```ts
import { compile } from "./src/index.js";
import { wrapExports } from "./src/runtime.js";

const result = await compile(src, { fileName: "min.js", skipSemanticDiagnostics: true });
// result.success === true, binary validates, instantiates fine
const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
exp.t1(); // "object" — WRONG, should be "function"
exp.t2(); // throws "null is not a function" — WRONG, should return 42
```

Confirmed independently reproducible three ways, isolating exactly what
triggers it:

1. `var obj = { fn: null }; obj.fn = function(){...}` — **broken**
   (property pre-declared with a non-function initializer, function
   assigned later).
2. `var module = { exports: {} }; module.exports = function(){...}` —
   **broken**, same shape (this is the literal UMD `module.exports =`
   pattern every CJS/UMD-bundled npm package uses).
3. `var obj2 = {}; obj2.fn = function(){...}` (property NOT present in
   the initial literal, added dynamically) — **works correctly**
   (`typeof` is `"function"`, call returns `43`).
4. Plain variable (not an object property) reassigned from `null`/
   undeclared to a function — **works correctly**:
   `var x = null; x = function(){return 42}; x();` → `42`.

So the bug is scoped precisely to: **an object-literal property that
exists in the literal at construction time (with ANY value — `null`,
`{}`, a number, etc.) later reassigned to a function/closure value.**
Adding a brand-new property dynamically, or reassigning a plain variable,
both work fine — only the "pre-existing object property, later holds a
closure" combination is broken.

## Hypothesis (not verified against actual codegen — next step)

The property's storage representation is very likely decided from its
initializer at the object-literal construction site (matches the
project's broader "evolving type" gap class — see #3715, "TS evolving
array type inference unimplemented", and the fnctor field-typing work
in #3739/#3715-PR) and locked in as a non-closure slot (e.g. plain
externref/boxed-null) at that point. A later assignment of a genuinely
different runtime representation (a closure struct, which per
`CLAUDE.md` and `src/runtime.ts` has its own `__is_closure`/
`__closure_arity` marshaling) into that already-typed slot writes
something that doesn't round-trip as a callable — worth checking whether
the store side silently drops/mistypes the closure, or the load side
fails to recognize it's holding one.

## Why this matters beyond dayjs

Every CJS/UMD-bundled npm package (the majority of the npm ecosystem
predating full ESM adoption — confirmed hit by dayjs, and structurally
would also block mustache/diff's `module.exports = ...` pattern once
their own compile-stage blockers, #3720 and #3721 respectively, are
fixed) uses exactly the `module.exports = <value>` shape that triggers
this. It is a real blocker for the "single self-contained bundle" dogfood
pattern (`tests/dogfood/`, #1710/#3716) on any UMD-shaped package, not
just an academic corner case.

## Scope

- [ ] Trace the actual codegen path for `obj.fn = function(){...}` where
      `obj`'s property was seeded with a non-function value in the
      object literal — find where the closure value gets mis-stored or
      mis-typed on write, or mis-read on the later `.fn` access.
- [ ] Fix so a dynamic property reassignment to a closure value is
      correctly stored/read regardless of the property's initial-literal
      value.
- [ ] Regression test pinning the minimal repro above (all 4 shapes:
      broken-null-init, broken-object-init i.e. `module.exports`, working
      new-property, working plain-variable — to lock in both the fix and
      the still-correct cases).
- [ ] Once fixed, dayjs's `dayjs.min.js` (module.exports shim) becomes
      viable for a real `tests/dogfood/dayjs-harness.mjs` run+diff
      harness — not committed here (this issue is the root-cause finding
      only; the harness is a natural follow-up once this unblocks it).

## Acceptance criteria

- [ ] Minimal repro's `t1()`/`t2()` return `"function"` / `42`
      respectively after the fix.
- [ ] The `module.exports = function(){...}()` UMD shape (repro #2 above)
      also fixed — verified with the same test pattern.
- [ ] No regression in the two currently-working shapes (new dynamic
      property; plain variable reassignment) — both stay correct.
- [ ] Equivalence/regression test added and passing.

## 2026-08-12 CommonJS split

The CommonJS rewriter can now synthesize an ambient `module`/`exports` carrier,
so real ambient UMD branches and `module.exports = identifier` default imports
work. The original explicit-local carrier remains broken:

```js
var module = { exports: {} };
module.exports = factory();
export default module.exports;
```

Calling that imported value still reports `[object Object] is not a function`.
The regression suite marks this exact case as an expected failure while keeping
the newly working ambient UMD cases as ordinary passing tests. This issue stays
open for the underlying pre-existing-property carrier change.
