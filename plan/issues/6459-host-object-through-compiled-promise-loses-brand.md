---
id: 6459
title: "A host object resolved through a COMPILED function's promise loses its WebIDL brand — `crypto.subtle.verify` answers `2nd argument is not of type CryptoKey`"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

Split out of [#6430](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6430-hono-signed-cookie-hmac-zero-signature)
while fixing it, and it is the whole of that issue's residual: the last 8 rows
of hono's `src/utils/cookie.test.ts` (27/35 after #6430).

A host object that a compiled function hands back **as the resolution of a
promise** arrives on the far side as something that answers property reads
correctly but FAILS a host WebIDL brand check. Awaiting the same host promise
in the frame that created it is fine.

Measured on `upstream/main` a172bc7404 + #6430 (`.tmp/6430/probe-i.mjs`, gc/web,
untyped two-file project):

```js
// dep.js
export async function getKeyAsync(s) {
  return await crypto.subtle.importKey('raw', new TextEncoder().encode(s), algorithm, false, ['sign','verify']);
}
export function getKeyPromise(s) {          // returns the HOST promise, unawaited
  return crypto.subtle.importKey('raw', new TextEncoder().encode(s), algorithm, false, ['sign','verify']);
}
```

| call shape                                                   | `crypto.subtle.verify(algorithm, key, …)` |
| ------------------------------------------------------------ | ----------------------------------------- |
| `await crypto.subtle.importKey(…)` in the SAME frame          | `true` — works                            |
| `await getKeyPromise(secret)` (compiled fn returns a promise) | **TypeError: 2nd argument is not of type CryptoKey** |
| `await getKeyAsync(secret)` (compiled async fn)               | **TypeError: 2nd argument is not of type CryptoKey** |

The value is not obviously wrong on inspection — which is why #5371 was filed
and then "disproved" against it:

```
Object.prototype.toString.call(key)  →  "[object CryptoKey]"
key.type                            →  "secret"
```

Both of those hold for a MIRROR of the key as well. The brand check is the only
probe that separates them, so "`.type === 'secret'`, therefore the key is real"
is not evidence — a wrapper proxies property reads and fails
`webidl.converters.CryptoKey`.

## Production witness

hono `src/utils/cookie.ts`:

```js
const getCryptoKey = async (secret) => { … return await crypto.subtle.importKey(…) }
const verifySignature = async (b64, value, secret /* CryptoKey */) => {
  try { … return await crypto.subtle.verify(algorithm, secret, signature, …) }
  catch { return false }            // ← swallows the TypeError
}
```

`parseSigned` awaits `getCryptoKey` and threads the key into `verifySignature`,
whose `catch { return false }` converts the brand TypeError into a silent
`false`. So every signed-cookie READ answers `false`:

```
Should parse signed cookies                           boolean:false != string:choco
Should parse signed cookies with binary secret        boolean:false != string:choco
Should parse signed cookies containing the separator  boolean:false != string:choco.chip
Should parse one signed cookie specified by name      boolean:false != string:strawberry
Should parse signed cookies and ignore regular ones   boolean:false != string:strawberry
Should ignore NBSP-prefixed signed cookie names       boolean:false != string:choco
(+2 "…and return false for wrong/corrupt signature" rows that assert a real value first)
```

SIGNING is unaffected and correct after #6430 — `makeSignature` uses the key in
the frame that awaited it.

## What to determine first

Which boundary mints the mirror: the compiled function's RETURN marshalling, or
the promise-resolution path (`__async_resume_*` restoring the settled value).
`getKeyPromise` is the sharper probe of the two — it is a plain synchronous
compiled function that returns the untouched host promise, and its result is
already wrong, so the async-frame machinery is not required to reproduce.

A host object should cross a compiled boundary as ITSELF wherever it has no
compiled representation. Where a mirror is genuinely needed, unwrapping it on
the way back OUT to a host call is the other half.

## Acceptance criteria

1. A standalone probe (untyped `.js` two-file project) showing the three rows of
   the table above, and a one-line statement of which boundary mints the mirror.
2. `crypto.subtle.verify` accepts a key obtained through both compiled shapes.
3. hono `src/utils/cookie.test.ts` above 27/35; state the exact number.
4. Regression test under `tests/`, failing on the parent, passing with the fix,
   exact counts both ways — with a brand check (not a property read), since a
   property read passes on the broken value.
5. A/B over the 17 dogfood suites at one HEAD, per file; no regressions.

## Reproduction

`.tmp/6430/probe-i.mjs` in the #6430 worktree; the shape is reproduced in full
in the table above.
