---
id: 1500
sprint: 52
title: "browser: fetch() host import with Response bridge"
status: in-progress
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: browser-support
related: [1043, 1044, 1490]
---

# #1500 — `fetch()` host import with Response bridge

## Problem

Compiled TypeScript has **no working path** to make an HTTP request from the
browser (or Node ≥18, which also ships a global `fetch`). Today the only
mechanism is the generic `declared_global` import (`src/runtime.ts:4645`)
which resolves `fetch` from `globalThis.fetch` — but two layers downstream
fail:

1. **Return value is opaque.** `await fetch(url)` resolves to a JS `Response`
   object that the compiler hands back as an externref. Compiled code calling
   `.json()` / `.text()` / `.status` on it goes through `extern_class` method
   dispatch (`src/runtime.ts:1909-1945`), which works for primitives but breaks
   for promise-returning methods because the await machinery (`case "await"`
   import) only unwraps real `Promise` instances — not the value the callback
   eventually returns.
2. **No type wiring.** The bundled `lib.dom.d.ts` declares `fetch` as
   `(input, init) => Promise<Response>`, so TS *type-checks* the call, but no
   import descriptor is registered for it in `collectPromiseImports` or
   anywhere else in `src/codegen/`. Result: at run time the compiled
   `fetch(...)` resolves to `() => undefined` from the
   `declared_global` fallback at `src/runtime.ts:4660`.

`fetch` is table-stakes for any browser-targeted Wasm app; without it
js2wasm cannot serve "compile a React-style component to Wasm" use cases
(#1033) or any data-fetching example.

## Use case

```ts
interface User { name: string; }

async function loadUser(id: number): Promise<string> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) return "error";
  const user = (await res.json()) as User;
  return user.name;
}

// Works in browser (playground), in Node 18+ with a real fetch global,
// and in Deno/Bun. Fails in a no-fetch environment by throwing.
```

## Current behavior

- `fetch("/x")` compiles (TS sees the lib.dom type) but executes
  `() => undefined` from `declared_global`'s ambient fallback.
- `await undefined` resolves to `undefined`.
- The body `res.ok` then dispatches `extern_get` on `undefined` → `undefined`.
- The whole chain silently returns `"error"` (or NaN / throws further on).
- No error is raised — silent failure is the worst possible outcome.

## Implementation plan

1. **`src/index.ts`** (≈line 33): add a new intent variant
   ```ts
   | { type: "fetch" }
   ```
   so the codegen has a first-class hook (rather than relying on
   `declared_global` resolution).
2. **`src/codegen/expressions/calls.ts`**: in the same area that already
   detects `Promise` calls (collectPromiseImports, around the dispatcher
   that recognises bare `Promise(...)`), add a branch for identifier `fetch`.
   Register `fetch` as a host import with signature
   `(externref, externref) -> externref` (url, init → Response handle).
   Bind the await result the same way Promise instance methods do
   (`Promise_then`).
3. **`src/runtime.ts`** `resolveImport` (≈line 1700): add a `case "fetch":`
   that returns:
   ```ts
   (url: any, init: any) => {
     if (typeof fetch !== "function") {
       throw new Error("js2wasm: fetch is not available in this environment");
     }
     // Coerce WasmGC init struct to a plain JS object so the host can
     // read .method / .headers / .body — reuse _wasmToPlain from runtime.ts:870.
     const exports = callbackState?.getExports();
     const plainInit = init == null ? undefined : _wasmToPlain(init, exports);
     return fetch(url, plainInit);
   };
   ```
4. **Response method bridge**: the methods `text()`, `json()`, `blob()`,
   `arrayBuffer()`, `formData()` and the properties `ok`, `status`,
   `statusText`, `url`, `headers` already route through the
   `extern_class` import for class `Response` (`runtime.ts:1817`). Verify
   each round-trips correctly:
   - `res.status` (number) — primitives pass through.
   - `res.ok` (boolean) — primitives pass through.
   - `res.json()` → returns a JS object; the await machinery should unwrap
     it. Add `_wrapForHost` so compiled code can read fields with
     `_safeGet` (runtime.ts:995). Today this works for unknown classes but
     the proxy path has not been exercised against `Response`-shaped values.
   - `res.headers.get("content-type")` — needs `Headers` class entry
     similar to existing `Map` / `Set` handling.
5. **Standalone-mode fallback**: per the dual-mode principle (CLAUDE.md
   Architecture Principles), throw a descriptive `Error("fetch is not
   available")` when `globalThis.fetch` is undefined. Do NOT add a
   polyfill — users targeting WASI / standalone should use a WASI HTTP
   module if/when one is wired (out of scope for this issue, but document
   in the spec).
6. **AbortController / AbortSignal**: the second-arg `init.signal` field
   needs to be unwrapped via `_wrapForHost` so compiled code can pass a
   compiled AbortController. Out-of-scope for the first cut — document as
   follow-up.

## Acceptance criteria

The following test in `tests/equivalence.test.ts` passes both as plain JS
and as compiled Wasm running under the JS host:

```ts
async function getStatus(url: string): Promise<number> {
  const res = await fetch(url);
  return res.status;
}
async function getName(url: string): Promise<string> {
  const res = await fetch(url);
  const obj = await res.json();
  return obj.name as string;
}
```

with a mocked global `fetch` (vitest spy returning a `Response` with
`status: 200` and JSON body `{"name":"Alice"}`). Expected:

- `await getStatus("/x")` → `200`.
- `await getName("/x")` → `"Alice"`.

Also add a "fetch not available" path: when `globalThis.fetch` is deleted
before instantiation, the compiled `fetch(...)` call throws an `Error`
whose message starts with `"js2wasm: fetch is not available"`.

## Files to modify

- `src/index.ts` (≈line 33) — add `"fetch"` to `ImportIntent`.
- `src/codegen/expressions/calls.ts` — register the `fetch` host import
  next to where bare identifier calls are resolved.
- `src/runtime.ts` (≈line 1700, switch statement; ≈line 4924 `buildImports`
  iteration) — implement the new case + `_wasmToPlain` init marshaling.
- `tests/equivalence.test.ts` — new "fetch round-trip" block with vitest
  `vi.spyOn(globalThis, 'fetch')` mock.
- (Optional follow-up) `playground/examples/dom/` — add a "fetch a quote"
  example.

## Notes

- Once #1326c (microtask queue) lands the await machinery is more robust,
  but `fetch` only needs the existing JS host await path — no microtask
  changes required for the JS-host target.
- The Node-builtin path `node_builtin` (#1044) is **not** the right model
  here — `fetch` is a global, not a module. Keep the new `fetch` intent
  separate from `node_builtin`.
