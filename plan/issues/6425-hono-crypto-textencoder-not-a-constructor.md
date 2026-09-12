---
id: 6425
title: "hono crypto: `new TextEncoder()` in compiled code answers `TextEncoder is not a constructor` — the whole of src/utils/crypto.test.ts (4 tests)"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

hono's `src/utils/crypto.test.ts` reads **0/4** in the Wasm lane, 4/4 native.
Three of the four carry the same host-boundary failure:

```
sha256                                              TextEncoder is not a constructor
sha1                                                TextEncoder is not a constructor
Should not be the same values - compare difference  unhandled rejection: TypeError: TextEncoder is not a constructor;
                                                                        TypeError: TextEncoder is not a constructor
Should create hash for Buffer                       update is not a function
```

`TextEncoder` **is** supplied to the worker: `getWebHostConstructors()`
(`src/runtime/web-host-constructors.ts`) forwards it whenever
`typeof globalThis.TextEncoder === "function"`, which holds on every Node the
harness runs on. So the binding reaches the import object and the compiled
`new TextEncoder()` still does not construct — the defect is on the
compiled-code side of the extern-constructor boundary, not in the dependency
map.

It has been visible but unowned: #5338 named it "adjacent, do not chase" and
closed without filing it.

## Why it is filed now

The third test used to read **passed**. It compares two values that are
unawaited Promises (the
[#5371](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5371-await-hands-back-the-promise)
family), so the comparison was trivially satisfied while two `TextEncoder`
rejections were dropped on the floor unobserved.
[#5369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5369-unhandled-host-rejection-zeroes-test-module)
now attributes those rejections to the test that leaked them, so the file reads
0/4 honestly instead of 1/4. hono's headline moved 258/324 → 257/324 for that
reason alone — an accuracy correction, and the reason this defect now has a
number.

## Acceptance criteria

1. `new TextEncoder()` in compiled JS-host-lane code constructs a real host
   `TextEncoder`, and `.encode()` on it returns something the host accepts.
2. hono `src/utils/crypto.test.ts` reads at least 3/4 (the fourth,
   `update is not a function`, is a separate Buffer-surface gap — diagnose but
   do not bundle).
3. A regression test in `tests/` that constructs a `TextEncoder` from compiled
   code and round-trips a string, independent of hono.
4. A/B over the 17 upstream suites at one HEAD: hono up, nothing else down.

## Notes

Start by checking how the extern constructor is resolved for the web lane's
forwarded constructors versus the `node:` namespace ones — hono's other
`TextEncoder` uses may go through a different path, since only this file
reports the failure.
