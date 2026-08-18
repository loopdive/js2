---
id: 4298
title: "Dynamic WasmGC properties are missing from reflection, breaking React clone props"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: objects, reflection
goal: npm-library-support
horizon: s
related: [2746, 2804, 3958]
loc-budget-allow:
  - src/codegen/object-ops.ts
origin: "React's original ReactElementClone test became scoreable after restoring the production build constant and exposed an Object.keys/deep-equality divergence."
---

# Dynamic WasmGC properties are missing from reflection

## Problem

React 19.2.6's original `ReactElementClone` test
`should extract null key and ref` passed every direct assertion against the
compiled package, but failed its final object equality assertion:

```js
expect(clone.props).toEqual({ foo: "ef", ref: null });
```

The values were present: compiled reads of `clone.props.foo` and
`clone.props.ref` returned `"ef"` and `null`. But `Object.keys(clone.props)`
returned `[]`, so the shared deep-equality matcher rejected the object.

React constructs this object through normal JavaScript operations: it aliases
`Object.assign`, copies into `{}`, then writes configuration properties through
a runtime key. On a WasmGC receiver those values live in `_wasmStructProps`.
Ordinary assignment does not need an explicit descriptor entry because its
attributes are the defaults: writable, enumerable and configurable.

The host `__object_keys` implementation nevertheless enumerated a sidecar key
only when `_wasmPropDescs` existed **and** contained that key. Thus a value was
readable and own, but invisible to reflection. The for-in host path already
implemented the correct rule: a descriptor-less sidecar entry is enumerable.

A related compiler shortcut made `obj.hasOwnProperty(dynamicKey)` and
`obj.propertyIsEnumerable(dynamicKey)` compare only against declared struct
field names. It therefore disagreed with the already-correct `Object.hasOwn`
path for the same sidecar/carrier property in both host and standalone modes.

## Fix

`__object_keys` now includes every live descriptor-less sidecar string key as
an enumerable own property. Existing filters remain authoritative:

- an explicit non-enumerable descriptor stays excluded;
- deleted/tombstoned keys stay excluded;
- `__get_`/`__set_` accessor bookkeeping never leaks;
- static struct fields and sidecar keys are deduplicated.

The old #2746 parity test is corrected to the JavaScript rule: ordinary writes
appear in both `Object.keys` and for-in. It had preserved both surfaces being
wrong instead of preserving the language semantics.

Computed-key `hasOwnProperty` and `propertyIsEnumerable` calls on concrete
struct receivers now use the shared runtime/native predicate. That predicate
already combines declared fields, ordinary dynamic properties and tombstones;
the former declared-name-only shortcut remains only as a fallback when no
predicate can be emitted.

## Measured result

Exact React upstream harness, same source on native Node and compiled Wasm:

| stage | scored | passed | failed |
| --- | ---: | ---: | ---: |
| prior published harness | 55 | 55 | 0 |
| production `__DEV__` restored | 64 | 63 | 1 |
| dynamic key enumeration fixed | **64** | **64** | **0** |

The corpus admits 272 of 273 upstream tests and executes 264; 200 are explicitly
`harness-incompatible` on both lanes and eight are compile-quarantined. The
full run uses 27 batches (4,506,838 total Wasm bytes) and took 247,024 ms to
compile on 2026-08-09.

## Acceptance criteria

- [x] A descriptor-less dynamic write on a WasmGC struct is visible to
      `Object.keys`.
- [x] `hasOwnProperty` and `propertyIsEnumerable` see the same computed-key
      property in host and standalone modes.
- [x] Explicit non-enumerability, tombstones and accessor bookkeeping remain
      filtered.
- [x] React's original scoreable upstream corpus passes 64/64 without changing
      or filtering the failing test.
- [x] Native and Wasm lanes execute the same matcher/test source; no result is
      cached or precomputed.

## Permanent tests

- `tests/issue-4298.test.ts`
- `tests/issue-2746.test.ts`
- `tests/dogfood/react-upstream-suite.test.ts` with
  `DOGFOOD_REACT_UPSTREAM=1`
