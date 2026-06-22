---
id: 2622
title: "Standalone native `class X extends Set/Map/WeakMap/WeakSet` subclass — construction + [[SetData]] algebra + iteration + instanceof"
status: backlog
sprint: Backlog
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: collections
language_feature: Set, Map, class
goal: standalone-mode
parent: 2162
depends_on: 2620
---

# #2622 — Native subclass of a native-collection builtin (standalone)

Substrate follow-up split from **#2620**. #2620 landed the safe index-shift-lane
fix: a standalone subclass of a native-collection builtin
(`Set`/`Map`/`WeakMap`/`WeakSet`) is now a **clean compile error** (no
host-import leak, no invalid Wasm). This issue is the real feature — make such a
subclass *work* natively so the conformance rows pass.

## Problem

`class MySet extends Set {}` (and Map/WeakMap/WeakSet) under `--target
standalone`/`wasi` is currently refused (#2620). The base collections are served
by the WasmGC-native `$Map` runtime (#1103a/#2162), but a *subclass* has no
native path: the generic host-constructible subclass machinery
(`BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`) lowers `new`/`super` to the host
`__new_<Name>` import, which standalone cannot satisfy.

## Acceptance criteria (the rows)

`test/built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,
isSubsetOf,isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js` (~7 rows).
Each constructs `class MySet extends Set { size(){…} has(){…} keys(){…} }`,
`const s1 = new MySet([1,2])`, then e.g. `s1.union(s2)` and asserts:

- `[...combined]` spreads the right elements (native iteration over the result);
- `combined instanceof Set === true` and `combined instanceof MySet === false`
  (the result is a base Set, not the subclass);
- `sizeCount === hasCount === keysCount === 0` — the set-algebra methods read the
  internal `[[SetData]]` slot directly and MUST NOT call the subclass's
  overridden `size`/`has`/`keys`.

## Direction

- Route `class X extends Set/Map/WeakMap/WeakSet` under `nativeStrings` to a
  native `$Map`-backed instance (the way base `new Set([...])` is intercepted in
  `new-super.ts`), instead of the host-constructible path. The subclass instance
  needs the `$Map` backing PLUS room for the subclass's own fields (a hybrid
  struct, or a `$Map`-carrying field on the user struct).
- `super.size`/`super.has`/`super.add`/`super.keys` in subclass methods → native
  `__map_*`/`__set_*` helpers (not the host externClass dispatch).
- Set-algebra methods on the subclass receiver read `[[SetData]]` directly
  (never the overridden methods — the conformance assertion).
- `instanceof` discrimination: `combined instanceof Set` true,
  `instanceof MySet` false (the algebra methods return a base Set).
- Remove the #2620 refusal (`isNativeCollectionBuiltin` guard in
  `class-bodies.ts`) once this lands.

## Lane

Value-rep / collection-runtime substrate (#2162 / #2580 M2). Index-shift-sensitive
and broad-impact — validate via merge_group / full local-ci, not a scoped sweep.
