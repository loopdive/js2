---
id: 1502
title: "browser: localStorage / sessionStorage host imports with standalone fallback"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: browser-support
sprint: 52
related: [1500, 1501]
---
# #1502 — `localStorage` / `sessionStorage` host imports

## Problem

Compiled TypeScript cannot read or write the browser's
`Storage` interface. The TS `lib.dom.d.ts` declares
`localStorage: Storage` and `sessionStorage: Storage` as globals, but:

1. The compiler has no `extern_class` entry for `"Storage"` — `localStorage`
   resolves through `declared_global` (`runtime.ts:4645`) so the read
   itself works (yields the real `Storage` instance).
2. The method dispatch path in `extern_class` (`runtime.ts:1909-1945`) does
   `self[m] ?? _sidecarGet(self, m)`. For real `Storage` instances `self.getItem`
   is defined and the call dispatches correctly — **as long as** the args
   are coerced. A WasmGC-string argument (`localStorage.getItem(keyVar)`
   where `keyVar` is a Wasm string ref) crosses the boundary fine because
   `wasm:js-string` interop already auto-marshals string refs.
3. **However**, no test or example exercises this path, and there is no
   **standalone-mode fallback**: a Wasm binary running outside a browser
   (Node, Bun, edge runtime) crashes with `"localStorage is not defined"`
   on first access because `declared_global` returns `() => undefined` from
   its fallback at `runtime.ts:4660`. Then `undefined.getItem("x")` traps.

The cost of not having this is high: every "settings persistence" pattern
(theme picker, saved-form-state, draft autosave) is unreachable from
compiled code in non-browser environments and undocumented in browser
environments.

## Use case

```ts
function saveDraft(text: string): void {
  localStorage.setItem("draft", text);
}
function loadDraft(): string {
  return localStorage.getItem("draft") ?? "";
}
function clearDraft(): void {
  localStorage.removeItem("draft");
}

// Should work in playground (browser) AND in vitest (jsdom) AND in
// standalone Node (where the runtime supplies an in-memory polyfill).
```

## Current behavior

- **Browser (playground)**: `localStorage.setItem("k","v")` *probably* works
  via the generic `extern_class` method dispatch — but is not covered by
  any test, so silent breakage on future runtime refactors is likely.
- **Node**: `globalThis.localStorage` is `undefined`, the
  `declared_global` fallback returns `() => undefined`, the subsequent
  `.setItem("k","v")` traps with "Cannot read properties of undefined".
- **WASI target**: same trap.

## Implementation plan

1. **`src/index.ts`** (≈line 33): add intent variant
   ```ts
   | { type: "web_storage"; which: "local" | "session" }
   ```
   This gives the codegen a first-class hook to differentiate from the
   generic `declared_global` path.
2. **`src/codegen/expressions/member-access.ts`** (or the equivalent
   identifier resolver): on identifier `localStorage` / `sessionStorage`
   register a host import using the new intent.
3. **`src/runtime.ts`** `resolveImport` (≈line 1700): add a `case
   "web_storage":` that returns:
   ```ts
   const w = intent.which;
   const real = typeof globalThis !== "undefined" ?
     (globalThis as any)[w + "Storage"] : undefined;
   if (real) return () => real;
   // Standalone fallback: in-memory polyfill so compiled code that
   // doesn't rely on cross-session persistence still runs.
   const polyfillStore = new Map<string, string>();
   const polyfill: Storage = {
     get length() { return polyfillStore.size; },
     clear: () => polyfillStore.clear(),
     getItem: (k: string) => polyfillStore.has(k) ? polyfillStore.get(k)! : null,
     setItem: (k: string, v: string) => { polyfillStore.set(k, String(v)); },
     removeItem: (k: string) => { polyfillStore.delete(k); },
     key: (i: number) => { let n=0; for (const k of polyfillStore.keys()) { if (n===i) return k; n++; } return null; },
   };
   return () => polyfill;
   ```
4. **Per-instance polyfill memoization**: create one polyfill `Map` per
   `buildImports()` call (closure-local to `resolveImport`) so different
   Wasm instances don't share state — except when the host *does* expose
   a real `localStorage`, in which case all instances share it (matching
   browser semantics).
5. **Method coercion**: `getItem(key)` must coerce a WasmGC string ref
   to a JS string — the `wasm:js-string` interop already does this for
   `extern_class` method calls, so no extra work in the bridge needed.
   `setItem(key, value)` likewise. Verify against a WasmGC-typed
   `keyVar` argument in the new tests.
6. **`Storage` events** (`window.addEventListener("storage", ...)`): out
   of scope — listed as follow-up. Most apps just call setItem/getItem.

## Acceptance criteria

`tests/equivalence.test.ts` block, running both as JS and compiled Wasm:

```ts
function roundtrip(): string {
  localStorage.setItem("k1", "v1");
  const v = localStorage.getItem("k1") ?? "MISSING";
  localStorage.removeItem("k1");
  const after = localStorage.getItem("k1") ?? "GONE";
  return v + "/" + after;
}
// Expected: "v1/GONE"
```

```ts
function sessionVsLocal(): string {
  localStorage.setItem("scope", "L");
  sessionStorage.setItem("scope", "S");
  return localStorage.getItem("scope") + "|" + sessionStorage.getItem("scope");
}
// Expected: "L|S" — two separate stores.
```

Run the same test under jsdom (real `localStorage`) and under plain Node
(polyfill fallback). Both must produce the same output.

## Files to modify

- `src/index.ts` (≈line 33) — `ImportIntent` extension.
- `src/codegen/expressions/member-access.ts` (or `calls.ts` near the
  identifier-binding code that already resolves globals) — recognise the
  two storage globals.
- `src/runtime.ts` (≈line 1700 switch in `resolveImport`) — new case +
  in-memory polyfill closure.
- `tests/equivalence.test.ts` — new "web storage" block, two cases.
- `playground/examples/` — optional "theme picker" demo using
  `localStorage.getItem("theme")`.

## Notes

- The polyfill is intentionally **per-instance**, **not** persisted across
  `instantiateWasm` calls in the same process. Users who want persistence
  must supply a real `localStorage` via `deps` or run in a browser /
  jsdom environment.
- Follow the same dual-mode pattern as #682 (RegExp): real host first,
  in-Wasm fallback second. Don't ship a binary that depends on a host
  global without a fallback.
