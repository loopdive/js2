---
id: 3415
title: "Host-import errors bypass compiled try/catch in Test262 sandboxes"
status: done
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: runtime, test262
language_feature: errors, realms, strict-assignment
goal: test262-conformance
assignee: codex/root
related: [3374, 3414]
files:
  - src/runtime.ts
  - tests/issue-3415.test.ts
---

# #3415 — create runtime bridge errors in the executing sandbox realm

## Problem

The strict setter added in #3374 correctly throws when `[[Set]]` fails. During
original-harness execution, however, that JavaScript exception crosses a Wasm
host-import boundary as a raw host throw. V8 does not route it through the
module's exception tag, so the compiled `try`/`catch` is bypassed entirely.
The runtime bridge can also create the `TypeError` with the runner process's
constructor while the test's bare `TypeError` identifier resolves to its fresh
VM sandbox constructor.

The upstream `propertyHelper.js` relies on that identity while probing
non-writable properties. Strict reruns of TypedArray `name` tests therefore
escape with `Cannot assign to read only property 'name' of object` instead of
recognizing the expected TypeError.

## Acceptance criteria

- Host-import throws are wrapped in the module's exported exception tag once
  exports are wired, so compiled `try`/`catch` observes them.
- Standard errors are rehomed to the active sandbox realm when one is present.
- Error kind and message are preserved.
- Non-sandbox execution and non-Error thrown values remain unchanged.
- The literal strict `propertyHelper.js` writable probe catches its TypeError.
- Representative strict-rerun TypedArray property tests pass.

## Resolution

Once module exports are wired, host-import failures are rethrown through the
module's externref Wasm exception tag. Standard host errors are rehomed to the
active Test262 sandbox realm before the throw, and runtime `instanceof` lookup
uses that same realm. Generic numeric inference also keeps SameValue-style
helpers dynamic when equality depends on the original value type.

Verified by the focused sandbox TypeError test, the literal property-helper
probe, and both strict `name.js` tests in the five-file batch.
