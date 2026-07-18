---
id: 3428
title: "Host async-verdict: 'async completion marker not observed' on 4,617 async tests + 'asyncTest called without async flag' (225) under oracle v8"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: m
feasibility: medium
task_type: bug
area: test262-runner, async
language_feature: async-functions, async-generators, promises
es_edition: multi
goal: test262-conformance
related: [3370]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host `other` sub-bucket, largest single non-strict-rerun class @ oracle 8."
---

# #3428 — 'async completion marker not observed' (oracle-v8 async verdict)

## Problem

The single largest host `other`/uncategorized failure class after the
strict-rerun own-property work is the async completion verdict:

| Signature | Records |
| --- | ---: |
| `async completion marker not observed` | 4,617 |
| `asyncTest called without async flag` | 225 |

All affected tests are async — async-function, async-generator, dynamic-import
namespace, for-await, AsyncFromSyncIterator:

```
test/language/expressions/async-generator/yield-star-next-not-callable-undefined-throw.js
test/language/expressions/async-generator/yield-star-getiter-sync-returns-number-throw.js
test/language/expressions/class/async-gen-method-static/yield-star-next-then-non-callable-string-fulfillpromise.js
test/language/expressions/dynamic-import/namespace/await-ns-delete-non-exported-strict.js
test/built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js   (asyncTest-no-flag)
test/built-ins/AsyncFromSyncIteratorPrototype/return/return-null.js                            (asyncTest-no-flag)
```

## Root cause (hypothesis)

Consequence of #3370 (authoritative harness). The upstream harness signals async
test completion via `$DONE` / `asyncTest` + the `async` negative/flags metadata.
The two signatures indicate the runner's async-verdict path is incompletely
wired to the literal harness:

- `async completion marker not observed` — the async test ran but the runner
  never saw the harness's completion callback fire (so it can't distinguish
  pass from hang/failure and records a generic failure).
- `asyncTest called without async flag` — the harness's `asyncTest` helper was
  invoked for a test the runner did not classify as async (flags/metadata
  mismatch between the authoritative harness and the runner's frontmatter
  parse).

#3370's acceptance criteria explicitly require "Preserve Test262 strict reruns
and negative/**async** verdict semantics" — this class suggests the async half of
that contract is not fully satisfied. Needs triage on whether the completion
marker is a runner-integration gap (high ROI, ~4.8k tests) vs genuine async
codegen failures now honestly surfaced.

## Acceptance criteria

- Triage: determine how many of the 4,617 are runner async-verdict wiring vs real
  async codegen failures (compile a handful of the samples locally and inspect
  whether the async body actually completes).
- The async completion marker is observed for tests that do complete; the
  `asyncTest called without async flag` mismatch is resolved (correct async
  classification from the authoritative harness metadata).
- The `async completion marker not observed` class drops materially from 4,617.

## Cross-reference

Consequence of #3370. Overlaps the async/generator codegen families (#680/#3178)
only if triage shows real codegen failures; lead hypothesis is runner-side
verdict wiring.
