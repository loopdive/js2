---
id: 3469
title: "Object.create must use a host-visible compiled prototype"
status: done
created: 2026-07-19
updated: 2026-07-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, test262
language_feature: Object.create, Reflect.ownKeys, prototype-chain
goal: test262-conformance
related: [1345, 1466, 1513, 2739]
---

# #3469 — Object.create must use a host-visible compiled prototype

## Problem

The JS-host `Object.create(proto)` bridge installed an opaque WasmGC struct
directly as the new object's `[[Prototype]]`. V8 cannot perform ordinary
property operations on that prototype. A sloppy child assignment therefore
fell back into the runtime sidecar instead of creating a native own property,
so `Reflect.ownKeys(child)` returned `[]`; a strict child assignment threw
`TypeError: WebAssembly objects are opaque`.

This caused
`built-ins/Reflect/ownKeys/return-array-with-own-keys-only.js` to pass the old
synthetic project harness and fail the literal Test262 FYI harness.

## Resolution

Wrap a compiled prototype with its existing live host mirror before passing it
to native `Object.create`. Make the mirror's `set` trap honor the ECMAScript
receiver: when the mirror is reached through a child's prototype chain, define
the property on the child (while retaining inherited accessor and
non-writable-data behavior) instead of mutating the prototype sidecar.

No Test262 source or harness helper is changed.

## Acceptance criteria

- An assignment to an `Object.create(compiledProto)` result creates an own
  property visible to `Reflect.ownKeys` and `Object.getOwnPropertyNames`.
- Inherited reads and `Object.getPrototypeOf` identity remain intact.
- Assigning over an inherited writable data property updates the child, not the
  prototype.
- The literal FYI harness passes
  `built-ins/Reflect/ownKeys/return-array-with-own-keys-only.js`.

## Validation

- `pnpm exec vitest run tests/issue-3469.test.ts --reporter=dot`
- `pnpm run test:262:fyi -- --filter built-ins/Reflect/ownKeys/return-array-with-own-keys-only.js --workers 1`
- `pnpm exec vitest run tests/issue-1466.test.ts tests/issue-460.test.ts tests/issue-1355c.test.ts tests/issue-2046.test.ts tests/issue-2541-propertyisenumerable.test.ts tests/issue-2668.test.ts tests/issue-2747.test.ts tests/issue-3469.test.ts --reporter=dot`

The broad focused run passed 92/94 tests. The two failures reproduce unchanged
at parent commit `0a388bd596a144` and are not regressions from this fix.
