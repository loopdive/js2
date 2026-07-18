---
id: 3414
title: "Original-harness sandboxes omit TypedArray constructor globals"
status: done
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: test262, runner
language_feature: global-identifiers, typed-arrays
goal: test262-conformance
assignee: codex/root
related: [3087, 3412, 3413]
files:
  - scripts/test262-sandbox.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/test262-worker.mjs
  - tests/test262-runner.ts
  - tests/issue-3414.test.ts
---

# #3414 — expose the VM realm's standard globals to every original-harness lane

## Problem

After #3412 and #3413 let the literal Test262 TypedArray harness compile to a
valid module, its deferred top-level initializer throws `Cannot convert null to
object`. The failing upstream statement is:

```js
var TypedArray = Object.getPrototypeOf(Int8Array);
```

The host/GС lane already resolves bare TypedArray constructor names as host
values (#3087). However, every original-harness runner builds a fresh VM realm
and copies only a short allowlist of globals into its sandbox. That list omits
`Int8Array` and every other TypedArray constructor. Global resolution therefore
finds no `Int8Array`; the missing value crosses into Wasm as null and reaches
`Object.getPrototypeOf`.

This is runner isolation drift, not a Test262 or compiler-semantics bug. The
upstream harness and test body must remain untouched, and the project, worker,
and FYI lanes must populate sandboxes identically.

## Acceptance criteria

- The sandbox exposes the fresh VM realm's standard globals, including all
  TypedArray constructors supported by that host.
- `Object.getPrototypeOf(Int8Array)` succeeds in an unmodified Script assembly.
- The behavior remains correct when the `$262.global: globalThis` runtime shim
  is present.
- Project, worker, and FYI original-harness lanes use one shared sandbox
  implementation.
- Add focused regression coverage and rerun representative literal-harness
  TypedArray tests through the authoritative project runner.

## Resolution

All original-harness lanes now share one sandbox builder. It discovers the
fresh VM realm's own standard globals instead of maintaining three incomplete
allowlists, while preserving the required immutable descriptors for
`undefined`, `Infinity`, and `NaN`.

Verified by three focused sandbox/harness tests and the maintained project,
worker-backed, and FYI runner paths.
