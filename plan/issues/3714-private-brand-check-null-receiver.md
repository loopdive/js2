---
id: 3714
title: "Private brand check (#x in obj) on a null receiver does not throw a catchable TypeError"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: low
horizon: s
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: n/a
goal: property-model
origin: "#3690 — new tests/differential/corpus/private-fields/05-brand-checks.js surfaced this on first run"
related: [3690]
---

# #3714 — `#field in obj` with `obj === null` should throw a catchable TypeError

## Repro

```js
class Box {
  #v;
  constructor(v) { this.#v = v; }
  static isBox(obj) { return #v in obj; }
}
const b = new Box(1);
console.log(Box.isBox(b));   // true
console.log(Box.isBox({}));  // false
try {
  Box.isBox(null);
} catch (e) {
  console.log(e instanceof TypeError); // true
}
```

## Symptom

- V8: `true\nfalse\ntrue`
- js2wasm: `true\nfalse` (third line never printed)

The first two brand-check cases (own instance → `true`, unrelated plain
object → `false`) already match — see #3690's `private-fields/01-fields.js`
through `04-accessors.js`, all matching. Per spec, the ergonomic
brand-check form `#x in obj` must return `false` for any non-`Box`
*object*, but throw a `TypeError` when `obj` is not an object at all (e.g.
`null`/`undefined`/a primitive). js2wasm appears to either trap
uncatchably or silently swallow the case rather than raising a JS-catchable
`TypeError`, so the `try`/`catch` never logs its line — worth checking
whether this shares a root cause with other brand-check-vs-uncatchable-trap
issues (`tests/issue-private-access-brand.test.ts` fixed an analogous
`.call(nonInstance)` case).

## Repro file

`tests/differential/corpus/private-fields/05-brand-checks.js` (see #3690).

## Root cause (investigated 2026-07-27)

Confirmed the spec detail first, since a comment in the codebase disagrees
with it: ECMA-262 §13.10.1 step 5 (`RelationalExpression : PrivateIdentifier
in ShiftExpression`) says *"If `rval` is not an Object, throw a TypeError
exception."* — verified empirically against real Node 22 too: `#v in x`
throws `TypeError` for `x` = `null`, `undefined`, a number, a string, AND a
boolean, not just `null`. `src/codegen/binary-ops-in.ts` (lines 32-36)
carries a comment claiming the opposite — *"the result is `true` iff `obj`
carries the brand... and `false` otherwise (no throw, even when obj isn't
an object)"* — which is incorrect per spec and per real-engine behavior;
worth fixing that comment regardless of the runtime fix.

The actual runtime gap: `emitPrivateBrandPredicate`
(`src/codegen/expressions/helpers.ts`) implements the check as a single
`ref.test $declaringClassStruct` — which is correct for "does obj have this
brand" but `ref.test` simply evaluates to `0` for ANY non-matching anyref
(including `null` and boxed primitives), so every non-instance receiver —
object or not — silently becomes `false` with no distinction and no throw.

**Not fixed here.** A correct fix needs a runtime "is this anyref value a
JS object" classification that `ref.test` alone can't provide (it can only
ask "is this a *specific* struct type", not "is this *any* struct/array,
i.e. not null/i31/primitive-boxed") — needs to correctly cover js2wasm's
existing value representations (i31-boxed small ints, `undefined`'s
tag-1-externref-not-null-externref encoding per `type-coercion.ts`'s
`__extern_is_undefined`, wasm:js-string values, etc.), which is more
surface area than the fix's `low` priority justified investigating deeper
in this pass. The two already-passing brand-check cases (own instance,
unrelated plain object) cover the common path; this residual gap is the
non-object-receiver edge specifically.
