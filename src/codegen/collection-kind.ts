// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3171 / #6419) The keyed-collection brand tag, alone in an **import-free
 * leaf**.
 *
 * Which keyed collection a `$Map` struct instance backs. All four collections
 * share the `$Map` hash table (Set/WeakSet store key === value), so struct
 * identity alone cannot distinguish `[[MapData]]` / `[[SetData]]` /
 * `[[WeakMapData]]` / `[[WeakSetData]]` for the spec receiver brand checks
 * (`Map.prototype.get.call(new Set())` must throw a TypeError). The immutable
 * `kind` field (`MAP_LAYOUT.M_KIND`, map-runtime.ts), stamped at construction
 * by `__map_new`, carries the brand.
 *
 * **Why its own file (#6419).** It used to live in `map-runtime.ts`, which sits
 * inside an import cycle: `map-runtime.ts → statements/nested-declarations.js →
 * … → expressions/calls.ts → collections-brand.ts → map-runtime.ts`. When a
 * module that enters that cycle at `nested-declarations.js` is evaluated FIRST,
 * `collections-brand.ts` runs its top-level `KIND_OF` initializer while
 * `map-runtime.ts` is still mid-evaluation, so the `COLLECTION_KIND` binding is
 * still `undefined` and the initializer dies with
 * `Cannot read properties of undefined (reading 'MAP')`. The failure is
 * ORDER-dependent — it disappears as soon as almost anything else is imported
 * first — which is why CI stayed green while `tests/issue-1058-function-hoist-
 * facts.test.ts` could not even be collected standalone.
 *
 * A leaf with no imports of its own can never be mid-evaluation when someone
 * reads it, so this shape is the fix rather than a re-ordering of the cycle.
 * `map-runtime.ts` re-exports both names, so no existing importer changed.
 */
export const COLLECTION_KIND = {
  MAP: 0,
  SET: 1,
  WEAKMAP: 2,
  WEAKSET: 3,
} as const;

export type CollectionKind = (typeof COLLECTION_KIND)[keyof typeof COLLECTION_KIND];
