---
id: 2568
title: "standalone: nested destructuring-param default OBJECT yields 0 — two-level `{ w: {x,y,z} = {…} } = { w: {…} }` reads sentinels in standalone mode"
status: done
sprint: 64
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: sd-5
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: standalone-completeness
related: [2545, 2544, 2158, 1712]
origin: "2026-06-21 — found by sd-1 while regression-guarding #2545: the host nested-default value flow is correct, but the SAME source returns 0 in standalone mode."
resolution: "2026-06-21 (sd-5): two struct-representation mismatches (a #1712-family bug). (1) OUTER default: the in-method/in-function default object literal was compiled against the externref param type, boxing the nested field to externref → a struct shape `{ w: externref }` that does NOT match the `{ w: (ref null $inner) }` shape the destructuring ref.test/ref.cast derives from the pattern type → ref.test fails → __extern_get else-branch reads 0. Fixed by compiling the default against the binding-pattern's STRUCT type (new structHintForBindingPattern) at both the class-method (class-bodies.ts) and plain-function (function-body.ts) param-default sites. (2) INNER default: in the externref destructuring path the nested default object was a closed struct, but bindings are read back via __extern_get (which only indexes a $Object) → 0. Fixed by materializing the inner default as a $Object via compileObjectLiteralAsExternref (destructuring-params.ts), mirroring literals.ts:272. Host mode uniform-JS-object, unaffected. Verified: outer→123, inner→456, provided→123, single-level→7, last-field→9, plain-function→1, all standalone. New test tests/issue-2568-standalone-nested-dstr-default.test.ts."
---

# #2568 — standalone nested destructuring-param default object reads sentinels

## Problem

#2545 verified the **host-mode** nested destructuring-param default value flow
is correct. The identical source returns `0` in **standalone** mode (`target:
"standalone"`):

```ts
class C {
  method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
    return x * 100 + y * 10 + z; // host: 123  standalone: 0
  }
}
new C().method(); // outer default fires
```

Both branches diverge in standalone:

- outer default fires → `0` (expect 123)
- `{ w: undefined }` → inner pattern default fires → `0` (expect 456)

## Scope boundary

A **single-level** standalone object param default works:

```ts
class C {
  method({ x }: { x: number } = { x: 7 }): number {
    return x;
  }
}
new C().method(); // standalone: 7  ✓
```

So the gap is specific to the **two-level nested** object default in standalone
mode — the inner object-pattern destructuring of a default object value does not
read the object's fields under the standalone (no-JS-host) object
representation. Likely the nested default object literal is materialized via a
path that the standalone field-read can't index (cf. #2545's host fix went
through the JS-host plain-object machinery; standalone uses a different object
representation).

## Acceptance criteria

- The #2545 repro returns 123 (outer default) and 456 (inner default) in
  `target: "standalone"`.
- No regression in the single-level standalone object-default case.
- Extend `tests/issue-2545-nested-dstr-param-default.test.ts` (or a new
  `tests/issue-2568-*.test.ts`) to cover the standalone lane.

## Notes

Found while closing #2545 (sd-1, 2026-06-21). #2545's regression test is
deliberately host-scoped so it stays green; this issue owns the standalone lane.
Senior-dev / standalone-object-representation focus.

**Cross-ref — scoped instance of the #1712 canonical-struct-representation
family.** This fix and #1712 (sd-acorn) are the _same family, different sites_:
this one is the **build site** (a param-default object literal must be
_materialized_ in the representation its destructuring reader expects — the
binding-pattern struct for the typed/`ref.test` fast path, or a `$Object` for
the externref/`__extern_get` path); #1712 is the general **dynamic read-path**
canonical-representation unification. The narrow fix here lands a real
standalone win without waiting on the hard general fix. If sd-acorn's #1712
read-path unification later subsumes the per-site materialization choices made
here, this issue's logic can fold into it — tracked via this cross-ref.
