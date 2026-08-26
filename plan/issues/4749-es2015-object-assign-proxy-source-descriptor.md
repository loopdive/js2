---
id: 4749
title: "ES2015 Object.assign Proxy source getOwnPropertyDescriptor trap"
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
assignee: ttraenkler/codex
sprint: current
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime, codegen
language_feature: object-assign-proxy
es_edition: 2015
goal: es6
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
coercion-sites-allow:
  - src/codegen/object-runtime-enumeration.ts
---

# #4749 — ES2015 Object.assign Proxy source descriptor trap

## Scope

Fix the compact `Object.assign` Proxy-source family where the source's
`[[OwnPropertyKeys]]`/`[[GetOwnProperty]]` protocol must reach a user
`getOwnPropertyDescriptor` trap. The exact Test262 rows are:

- `built-ins/Object/assign/source-own-prop-desc-missing.js`
- `built-ins/Object/assign/source-own-prop-error.js`

The missing-descriptor row is a required control for a Proxy `ownKeys` trap
that returns a key without a descriptor; the error row requires a throwing
`getOwnPropertyDescriptor` trap to abort `Object.assign`. The change must not
alter ordinary getter throws, `ownKeys` throws, or plain Object.assign copies.

## Ownership and duplicate audit

The current upstream GitHub open-PR search found no open PR or branch claiming
#4749 or either exact fixture. Existing plans #1336/#1630 cover earlier
Object.assign getter/Symbol and struct-target writeback work; neither owns the
remaining raw-struct Proxy default-own-key path. The target issue is therefore
unowned and remains narrow to Proxy source descriptor semantics.

## Live baseline

Measured against upstream/main `73d090d7251f8b49287e7051fce15dc44931d6dc`
(2026-08-26), with Test262 submodule
`b363f29d3c43c626dc852744ad64a0b48a003693`, using the authoritative local
`runTest262File` runner, original harness, and a 120-second timeout:

| Lane | Row | Baseline | Signature |
| --- | --- | --- | --- |
| host | `source-own-prop-desc-missing.js` | pass | `ownKeys` trap invoked once; missing descriptor is skipped. |
| host | `source-own-prop-error.js` | fail | expected `Test262Error`, but no exception was thrown. |
| standalone | `source-own-prop-desc-missing.js` | fail | `ownKeys` trap invocation count is `0`; standalone `__object_assign` skips `$Proxy` sources. |
| standalone | `source-own-prop-error.js` | fail | expected `Test262Error`, but no exception was thrown; `$Proxy` source is skipped. |

Nearby controls on the same upstream commit:

| Lane | Control | Baseline |
| --- | --- | --- |
| host | `source-own-prop-keys-error.js` | pass |
| host | `source-get-attr-error.js` | pass |
| host | `strings-and-symbol-order-proxy.js` | fail (separate symbol/ordering residual; not claimed here) |

The host failure is specifically the absent-trap forwarding path: a raw
WasmGC object target's default own-key enumeration is opaque to the JS Proxy,
so `attr` never reaches `getOwnPropertyDescriptor`. The standalone failures
are a distinct but adjacent path: native `__object_assign` only accepts
`$Object` sources and currently drops a `$Proxy` source before any MOP call.

## Plan

1. Add a host-mode raw-struct default `ownKeys` forwarder that enumerates the
   target's visible own string keys, preserving the existing custom-trap path
   and Proxy identity/invariant behavior.
2. Extend standalone native `__object_assign` only for `$Proxy` sources: obtain
   the Proxy own-key list through its existing ownKeys dispatch, query each key
   through `__getOwnPropertyDescriptor` (thereby invoking a user trap), skip
   missing/non-enumerable descriptors, then read the value through
   `__extern_get` and write it with the existing target setter. Keep the
   `$Object` fast path unchanged.
3. Add exact host and standalone pins plus ordinary-copy, missing-descriptor,
   and ownKeys-throw controls. Record baseline and post-fix statuses and Wasm
   SHAs in `## Test Results`.
4. Run focused Vitest and TypeScript/format checks, merge latest upstream main
   without rebasing, rerun the focused gates, and commit as Thomas Tränkler
   with a Codex co-author. The parent agent will fold this clean branch tip
   into the combined upstream ES6 PR.

## Acceptance

- Both exact rows pass in host and standalone lanes.
- `source-own-prop-desc-missing.js`, `source-own-prop-keys-error.js`, and
  plain Object.assign copies remain passing in both lanes. The nearby
  `source-get-attr-error.js` row remains a separate standalone accessor
  residual and is intentionally not claimed here.
- No unrelated Proxy trap or symbol-order behavior is claimed as fixed.
- The source change remains within the listed runtime/codegen files and no
  host imports are added to standalone.

## Test Results

Implementation and focused validation completed on the issue branch.

```text
upstream/main: 73d090d7251f8b49287e7051fce15dc44931d6dc
test262:      b363f29d3c43c626dc852744ad64a0b48a003693
runner:       runTest262File, original harness, 120000 ms

host:
  source-own-prop-desc-missing.js: pass (wasm daa6586ed038)
  source-own-prop-error.js:         fail — no Test262Error (wasm 17ea24758214)
  source-own-prop-keys-error.js:    pass (wasm b2dfed5079ed)
  source-get-attr-error.js:         pass (wasm 468bb8f0c397)

standalone:
  source-own-prop-desc-missing.js: fail — callCount remained 0 (wasm 128490d39227)
  source-own-prop-error.js:         fail — no Test262Error (wasm c5bd32876af3)

implementation:
  host raw-struct Proxy construction now uses its live `_wrapForHost` mirror as
  the native Proxy target, while the bridge restores the raw target in trap
  arguments and forwards absent `ownKeys` through `_ownStructKeys`.
  standalone `__object_assign` now has a Proxy-source arm that dispatches
  ownKeys/getOwnPropertyDescriptor, filters `enumerable`, then Get/Set-copies
  values. The ordinary `$Object` arm is unchanged.

post-fix (exact pins and controls, `tests/issue-4749.test.ts`):
  host:
    source-own-prop-desc-missing.js: pass (wasm daa6586ed038)
    source-own-prop-error.js:         pass (wasm 17ea24758214)
    Target-Object.js:                 pass (wasm e6f8c0a62fe9)
    source-non-enum.js:               pass (wasm 37f047980cce)
    source-own-prop-keys-error.js:    pass (wasm b2dfed5079ed)
  standalone:
    source-own-prop-desc-missing.js: pass (wasm 0fa514afc0ee)
    source-own-prop-error.js:         pass (wasm 4520b26197c7)
    Target-Object.js:                 pass (wasm 025faf839f19)
    source-non-enum.js:               pass (wasm ccecd33f24a2)
    source-own-prop-keys-error.js:    pass (wasm 9c1b861e5a7c)
  focused Vitest: 10/10 passed.
  focused TypeScript check: no diagnostics for changed source/test files.
  formatting and `git diff --check`: passed.

The standalone `source-get-attr-error.js` control was not added because it
still fails independently for ordinary accessor-source dispatch; the host
lane remains passing, and no accessor semantics are changed by #4749.
```
