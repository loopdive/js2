---
id: 6691
title: "standalone: Web/Fetch globals (URL, Request, Response, Headers, addEventListener) emitted env:: host imports (hono)"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6664, 6675, 6659, 2717, 1792, 1244, 6692]
---

# #6691 — Web/Fetch globals leak `env::` imports into a standalone binary

## What you will see

Measured 2026-09-26 on upstream/main `58ca19b6d2` (after
[#2717](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2717-array-flat-flatmap-host-import-only-standalone)):

```
npx tsx scripts/generate-npm-compat-report.mjs --only hono --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: host-import-error — "standalone binary retained 8 host import(s)"
  env.addEventListener, env.Headers_new, env.URL_new, env.URL_set_pathname,
  env.URL_get_pathname, env.Request_new, env.Response_new, env.Request_get_method
```

hono's `HonoBase` / `Context` / `HonoRequest` merely CONTAIN these
(`mount()`'s `new URL(request.url); url.pathname = …; new Request(url, request)`,
`createResponseInstance`, `new Headers()`, `fire()`'s
`addEventListener("fetch", …)`). The lane's sample op —
`new Hono(); app.get("/users/:id", () => "ok"); app.routes.length` — reaches
none of them, but the lib.dom extern-class machinery lowered every mention to an
`env::` import, so the module could not be instantiated host-free.

## Implementation Plan

Executed 2026-09-26. Decided per global with the
[#6664](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6664-standalone-unavailable-dom-globals-host-imports)
/ [#6675](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6675-standalone-timer-globals-no-event-loop)
precedent — an engine without the global (`typeof X` is `"undefined"`, a
reference throws `ReferenceError: X is not defined`), no new host import:

1. **`Request` / `Response` / `Headers` — unavailable.** A standalone module has
   no network stack; the sample op (`tests/dogfood/npm-compat-perf-specs.mjs`)
   never constructs one during route registration, so a minimal native carrier would only serve
   dead code. `standalone-unavailable-globals.ts` gets a second name set,
   `STANDALONE_UNAVAILABLE_FETCH_GLOBALS`, consulted by both
   `isStandaloneUnprovidedExternClass` (no `<Class>_new` / `<Class>_get_*`
   extern-class registration) and `isStandaloneUnavailableConstructorGlobal`
   (read / `new` throw, `typeof` fold). The new set additionally requires
   `targetProfile.environment === "none"`, so the opt-in JS-environment native
   regime (`JS2WASM_NATIVE_REGIME_JS=1`) keeps its host's constructors.
2. **`URL` / `URLSearchParams` — unavailable too (deviation from the dispatch
   brief, which proposed a Wasm-native minimal URL).** hono's sample op never
   reaches `URL` either (only `mount()` does), and a minimal
   pathname/search/hash splitter would silently diverge from WHATWG on
   relative input, percent-encoding and dot-segment normalisation — worse than
   a named `ReferenceError`. A spec-shaped Wasm-native URL stays with
   [#1792](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1792-node-url-builtin-impl)
   (its approach step 4).
3. **`addEventListener` / `removeEventListener` — no event loop.** Added to the
   #6675 set in `standalone-timers.ts`: the lib `declare function` stub is no
   longer registered as `env.addEventListener`, the call throws
   `ReferenceError` before argument evaluation, `typeof` folds to
   `"undefined"`. Method forms (`el.addEventListener`, the #4576 DOM
   capability) are untouched — only the bare ambient global.

## Resolution

- Regression test `tests/issue-6691-standalone-fetch-globals.test.ts` (4 cases,
  two-file untyped `.js` fixtures incl. a hono-shaped class with class-field
  arrows and `instanceof Request/Headers`): parent **3 failed / 1 passed**, fix
  **4 / 4**. The passing-both-ways case is the anti-vacuity control (user
  `class URL` / `class Headers` / `function addEventListener` keep their own
  semantics).
- npm-compat hono standalone-dynamic lane, same checkout, parent vs fix:

  | | parent | fix |
  | --- | --- | --- |
  | status | `host-import-error` — "standalone binary retained 8 host import(s)" | `result-mismatch` — "checksum mismatch: Wasm 8, Node 9" |
  | imports | 8 (list above) | 0 |

  The next blocker is not a host import: `app.get(...)` — a closure installed
  per HTTP method by `this[method] = (args1, ...args) => {…}` in the
  constructor — does not run when called as a method, so `app.routes.length`
  is 0 (Node: 1). Filed as
  [#6692](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6692-standalone-computed-this-key-closure-method-call).
- Scoped STANDALONE test262 (`scripts/run-test262-paths.mts --standalone`, 131
  rows: `language/expressions/typeof`, `language/expressions/new`,
  `language/identifier-resolution`, `language/global-code`): parent
  **109 pass / 22 fail**, fix **109 / 22**, identical non-pass set. No test262
  or harness file references any of the gated names.
- JS-host and WASI output byte-identical (sha256 of `target: "gc"` / `"wasi"`
  compiles of a URL/Request/Response/Headers/addEventListener fixture, and of
  hono's `dist/index.js` under `gc`, parent vs fix).
- JS-host hono dogfood control: `271/324` admitted upstream tests pass (unchanged).

## Residuals

- A standalone `URL` is a ReferenceError, not a parser — #1792.
- `event.respondWith` style service-worker entry points are unreachable by
  construction in standalone; hono's `app.fetch(request)` would need a native
  `Request` carrier — not required by any measured lane today.
- Id #6688 was reserved for this same task by an earlier, abandoned attempt
  (no PR, no issue file); it is an unused hole in the sequence.
