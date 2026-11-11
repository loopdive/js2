---
id: 7160
title: "All lanes: `#x in C` with C the class constructor returns true instead of false"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7150, 7159, 7158]
---

# #7160 — `#x in C` is true for the constructor itself

Found while implementing #7150 (PR #6915). Pre-existing on `origin/main` on
every lane, host-assisted included:

```js
class C {
  #x = 1;
  static has(v: unknown) { return #x in v; }
}
console.log(C.has(new C()));   // true
console.log(C.has(C));         // true   (node: false)
```

## Cause (as diagnosed; verify before fixing)

The brand test lowered for `#x in v` (`compileInOperator`, private arm,
`src/codegen/binary-ops-in.ts`) is a struct-type test (`ref.test` on the
class's instance struct). On the no-host lanes the constructor value shares
(or is represented by) the instance struct, so it passes; the same
constructor-as-instance misclassification is #7159 (JSON.stringify) and the
twin-layout collapse is #7158. On the host-assisted lane the host import for
the brand check answers true as well — check whether it tests the prototype
chain instead of own brand ownership.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce on gc host-assisted, gc native-first, standalone and wasi; also
   `#x in C.prototype` (node: false) and `#x in Object.create(new C())`
   (node: false — brands are own, not inherited).
2. Make the brand test an own-brand test: after the struct test passes,
   require the instance brand (the field/slot the `#x` private name is stored
   in, or the class's brand marker) to be present on the receiver itself, not
   found through the prototype. Land the no-host lane fix first; if the
   host-assisted answer needs a host-import change, keep that lane's bytes
   byte-identical and record the gap in the Resolution section instead
   (host lane is being sunset).
3. Tests: `tests/issue-7160-private-in-constructor.test.ts` with the three
   programs on the no-host lanes vs node; keep #7150's 39 rows green.

Acceptance: `#x in C`, `#x in C.prototype`, `#x in Object.create(new C())`
are `false` on gc native-first, standalone and wasi; `#x in new C()` stays
`true`; host-assisted gc bytes unchanged; equivalence gate no new regressions.

## Resolution (2026-10-31, Opus)

**Cause (verified).** The class VALUE `C` and, on wasi, `C.prototype` are
lazily built singletons (`__class_<C>` / `__proto_<C>` externref globals) of
the same struct type and `__tag` as an instance, so the struct + tag predicate
(`emitPrivateBrandPredicate`) accepted them. `Object.create(new C())` and a
Proxy already answered false.

**Fix (local to the private arm of `compileInOperator`).** After the brand
predicate, `emitExcludeClassSingletons` (`src/codegen/binary-ops-in.ts`)
clears the brand when the receiver is `ref.eq` to the class-object or
prototype singleton of the declaring class or any subclass — the same
identity test `__typeof_function` uses for class values (#5383 S2f R13 /
#7159), but against only the relevant classes' globals. An unmaterialised
global is null and its arm answers false. `collectClassAndDescendants` was
lifted out of `collectClassAndDescendantTags` (`expressions/helpers.ts`) with
the same BFS order, so the tag ladder is byte-identical. No shared `ref.test`
legality, type API or classifier category changed; no host import.

**Tests.** `tests/equivalence/issue-7160-private-in-constructor.test.ts`, 16
rows × gc native-first / standalone / wasi vs node: base 6/16, head 16/16.

**Left out / overlap.**
- #7162: `#m() {}`, `get #g()` and `static #s` still fall to the compile-time
  path (`resolveDeclaringClassForPrivateName` requires an instance field
  slot): `#m in new C()` / `#g in new C()` / `#s in C` answer false (node:
  true). Same function, different arm; not touched.
- #7163 (typed nullable receiver) not touched; a typed non-null receiver
  holding the constructor (`static ht(v: C)`) is fixed by this change and
  pinned.
- `C.#x` (a private READ with the constructor as receiver) shares
  `emitPrivateBrandPredicate` and is not changed here.
