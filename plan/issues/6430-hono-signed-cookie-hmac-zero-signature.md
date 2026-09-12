---
id: 6430
title: "hono signed cookies: HMAC signature comes back all-zero (`macha.AA%3D%3D`) and `serialize` emits a spurious `Max-Age=0` — 11 of 35 in `src/utils/cookie.test.ts`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Split out of [#5371](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5371-await-compiled-async-returning-host-promise).
#5371 was filed on the hypothesis that hono's signed-cookie failures were
caused by `await getCryptoKey(...)` handing back a pending Promise. That
hypothesis is now **disproved**: measured on `upstream/main` cf82f78d6d
(2026-09-12), `await` of a compiled async function returning
`crypto.subtle.importKey(...)` already yields a real `CryptoKey` (`.type ===
"secret"`), with and without the inner `await` — #5823 fixed that. And #5371's
own fix left hono at 258/324 with a byte-identical failure list.

So these 11 failures are a separate, still-unexplained defect. They are the
whole gap in `src/utils/cookie.test.ts` (24/35).

## Evidence (hono upstream suite, `src/utils/cookie.test.ts`, both before and after #5371)

Two distinct symptoms:

**(a) The HMAC signature is all-zero bytes.** `AA%3D%3D` is the URL-encoded
base64 of a zero-length/zero-valued buffer:

```
Should serialize a signed cookie
  got:  delicious_cookie=macha.AA%3D%3D; Max-Age=0
  want: delicious_cookie=macha.diubJPY8O7hI1pLa42Q...
Should serialize signed cookie with all options
  got:  great_cookie=banana.AA%3D%3D; Max-Age=1000; Domain=example.com; …
```

Parsing mirrors it — every signed-cookie read returns `false` (signature
mismatch) where the value is expected:

```
Should parse signed cookies                         boolean:false != string:choco
Should parse signed cookies with binary secret      boolean:false != string:choco
Should parse signed cookies containing the separator boolean:false != string:choco.chip
Should parse one signed cookie specified by name    boolean:false != string:strawberry
Should parse signed cookies and ignore regular ones boolean:false != string:strawberry
Should ignore NBSP-prefixed signed cookie names     boolean:false != string:choco
```

The `false` results are *consistent* with (a): `verifySignature` compares a
zero signature against the real one and correctly returns `false`. Whether
`crypto.subtle.sign`'s `ArrayBuffer` result is being read as empty, or the
`Uint8Array`/base64 conversion drops it, is the thing to determine first.

**(b) `serialize` emits a spurious `Max-Age=0`:**

```
Should serialize cookie
  got:  delicious_cookie=macha; Max-Age=0
  want: delicious_cookie=macha
```

An absent `maxAge` option is being treated as present-and-zero. Likely
independent of (a) and probably the cheaper of the two.

## Acceptance criteria

1. Reduce (a) and (b) to standalone probes (untyped `.js` two-file projects,
   `compileAndRunUpstreamModule`) and state which compiler mechanism each one
   is — they may be two separate fixes.
2. `src/utils/cookie.test.ts` above 24/35; state the exact number.
3. Regression tests under `tests/`, failing on the parent, passing with the
   fix, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD, per file; no regressions.

## Reproduction

```bash
node --import tsx tests/dogfood/hono-upstream-suite.mjs > .tmp/hono.log 2>&1; echo exit=$?
# then read tests/dogfood/report/hono-upstream-suite.json, results.tests,
# filtered to file == "src/utils/cookie.test.ts"
```
