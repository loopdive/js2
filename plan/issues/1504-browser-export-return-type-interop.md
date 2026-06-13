---
id: 1504
title: "browser: marshal compiled export return values (structs/arrays) to plain JS"
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
related: [1308, 1382, 1500]
---
# #1504 — Marshal compiled return values to plain JS at the export boundary

## Problem

When a compiled TypeScript function returns a value to its JS caller, the
JS host receives a *raw WasmGC handle* for any non-primitive shape:

- A returned object `{ name: "Alice", age: 30 }` arrives as an opaque
  WasmGC struct: `typeof === "object"`, `Object.keys()` is `[]`, dot
  access throws `"WebAssembly objects are opaque"`.
- A returned array `[1, 2, 3]` arrives as a WasmGC vec struct: `length`
  is unreadable, indexing throws.
- A returned closure was fixed in #1308 (`wrapExports` at
  `runtime.ts:5047` wraps callable returns via `__call_fn_0/1`). But the
  *object* and *array* cases are still raw.

This is the **biggest single barrier** to using js2wasm as a library
backend for any JS app — every interop pattern other than "primitive in,
primitive out" requires the JS caller to manually thread the result
through a `_wasmToPlain`-style conversion, which is not exposed.

`runtime.ts` already has the machinery:

- `_wasmToPlain` (≈line 870) recursively converts WasmGC structs ↔ plain
  JS objects, and vecs ↔ JS arrays, using `__struct_field_names` +
  `__sget_*` + `__vec_len` + `__vec_get` exports.
- `_wrapForHost` (≈line 1265) creates a live-mirror Proxy.
- `wrapExports` (≈line 5047) already wraps callable closure returns.

What's missing is a wiring step that uses `_wasmToPlain` (or
`_wrapForHost`) on the result of every user-visible export — so
`exports.makeUser()` returns `{ name: "Alice", age: 30 }` as a real JS
object, not a raw WasmGC handle.

## Use case

```ts
// Compiled to Wasm:
export function getProfile(id: number): { id: number; name: string; tags: string[] } {
  return { id, name: "Alice", tags: ["a", "b"] };
}
export function listIds(): number[] {
  return [1, 2, 3];
}
```

JS caller:

```ts
const { instance } = await WebAssembly.instantiate(binary, imports);
const exports = wrapExports(instance.exports);
const profile = exports.getProfile(1);
console.log(profile.name);            // expected "Alice"
console.log(profile.tags.length);     // expected 2
console.log(exports.listIds());        // expected [1, 2, 3]
console.log(JSON.stringify(profile)); // expected {"id":1,"name":"Alice",...}
```

Today every line after `exports.getProfile(1)` either throws "objects are
opaque" or silently returns `undefined`.

## Current behavior

- `profile.name` → throws `TypeError: WebAssembly objects are opaque`.
- `profile.tags` → throws same.
- `exports.listIds()` → returns a WasmGC vec ref. `listIds()[0]` throws,
  `listIds().length` is `undefined`.
- `JSON.stringify(profile)` → returns `"{}"` (Object.keys is empty).

`_wasmToPlain` would convert all three cases correctly — it's just not
called.

## Implementation plan

1. **`src/runtime.ts`** `wrapExports` (≈line 5047): extend the export
   wrapper so that, when an export returns a non-callable object that is
   a WasmGC struct, it goes through `_wasmToPlain(result, rawExports)`
   before being handed to the caller.

   Current loop body (line 5083):
   ```ts
   wrapped[key] = function (this: any, ...args: any[]): any {
     const result = (val as Function).apply(this, args);
     if (result != null && _isWasmStruct(result)) {
       return makeCallableClosureWrapper(result);   // closure case only
     }
     return result;
   };
   ```
   New body:
   ```ts
   wrapped[key] = function (this: any, ...args: any[]): any {
     const result = (val as Function).apply(this, args);
     if (result == null) return result;
     if (!_isWasmStruct(result)) return result;
     // Closures stay live-callable.
     if (typeof (rawExports as any).__call_fn_0 === "function" &&
         _looksLikeClosure(result, rawExports)) {
       return makeCallableClosureWrapper(result);
     }
     // Plain structs / vecs → marshal to plain JS.
     return _wasmToPlain(result, rawExports as any);
   };
   ```
   where `_looksLikeClosure` calls `__is_closure(result)` if available,
   else falls back to "no field names registered AND vec_len throws".
2. **Closure discriminator export**: codegen-side, emit a tiny
   `__is_closure(externref) -> i32` export that returns 1 for any value
   whose type is one of the registered closure struct types, 0 otherwise.
   That gives `wrapExports` a fast, unambiguous discriminator. Add this
   in `src/codegen/index.ts` next to where `__call_fn_0` is emitted.
3. **Identity-preserving alternative (`_wrapForHost`)**: marshal-by-copy
   loses identity — mutating the returned object on the JS side won't
   reach back into the Wasm heap. For users who want a live view (rare
   but possible), expose `wrapExports(rawExports, { live: true })` that
   uses `_wrapForHost(result, rawExports)` (line 1265) instead of
   `_wasmToPlain`. Default to copy — that's what 99% of callers expect.
4. **`wrapExports` opt-out**: some advanced users (e.g. the test262
   runner) want the raw struct. Add a flag
   `wrapExports(rawExports, { marshal: false })` to disable the marshal
   step. Default `{ marshal: "copy" }`.
5. **`instantiateWasm` / `instantiateWasmStreaming`** (≈line 5097 /
   ≈line 5127): change the wrapped-exports return so the playground and
   all callers get plain objects automatically. Verify the test262
   runner is not affected (it generally calls compiled tests via
   primitive-returning `main()`).

## Acceptance criteria

`tests/equivalence.test.ts` "export return marshaling" block:

```ts
// compiled
export function user(): { id: number; name: string; tags: string[] } {
  return { id: 7, name: "Alice", tags: ["a", "b"] };
}
export function ids(): number[] {
  return [10, 20, 30];
}
export function nested(): { items: { x: number }[] } {
  return { items: [{ x: 1 }, { x: 2 }] };
}
```

JS-side asserts (after `wrapExports`):

```ts
const u = exports.user();
expect(u.name).toBe("Alice");
expect(u.tags).toEqual(["a","b"]);
expect(JSON.stringify(u)).toBe('{"id":7,"name":"Alice","tags":["a","b"]}');
expect(exports.ids()).toEqual([10, 20, 30]);
expect(exports.nested().items[1].x).toBe(2);
```

Closure-return still works (regression guard for #1308):

```ts
export function makeFn(): () => number { return () => 42; }
const fn = exports.makeFn();
expect(typeof fn).toBe("function");
expect(fn()).toBe(42);
```

## Files to modify

- `src/runtime.ts` (≈line 5047, `wrapExports`) — extend the wrapper.
- `src/runtime.ts` (≈line 5097 / 5127) — pipe `wrapExports` through
  `instantiateWasm` / `instantiateWasmStreaming`.
- `src/codegen/index.ts` — add `__is_closure` export (search for
  `__call_fn_0` to find the right spot).
- `tests/equivalence.test.ts` — new "export return marshaling" block.
- `playground/main.ts` — verify the playground's run-button path picks
  up the new behavior (it already uses `wrapExports`).

## Notes

- `_wasmToPlain` is **already used** in `JSON_stringify` (`runtime.ts`
  line ≈2022) so we know it correctly converts the shapes that the
  codegen emits. This issue just widens its scope from "JSON only" to
  "any export return".
- Copy semantics is the right default: it matches every other host
  binding (wasm-bindgen, embind), it side-steps GC-rooting headaches,
  and it makes returned values immediately compatible with `console.log`,
  `JSON.stringify`, React reconcilers, etc.
- Memory cost: marshaling N items walks the struct/vec once. For huge
  return values (>10k elements) users can opt into `marshal: false` and
  do their own targeted reads via the `__sget_*` / `__vec_get` exports.

## Suspended Work

- **PR**: https://github.com/loopdive/js2/pull/404
- **Branch**: `issue-1504-browser-export-interop`
- **Worktree**: `/workspace/.claude/worktrees/issue-1504-browser-export-interop`
- **HEAD SHA**: `5742e3da255a3c133a863d4b4c3516815a61ae9e`
- **Status when suspended**: in CI-wait — background wait loop submitted

### What's implemented
- `wrapExports` (`src/runtime.ts:~5047`) now calls `_wasmToPlain` on user-visible callable returns that look marshalable. Closures (#1308) still get JS-callable wrappers. Added `options.marshal: false` opt-out.
- New `__is_closure(externref) -> i32` codegen export: ref.test against base wrapper struct types from `ctx.closureInfoByTypeIdx`. Emitted from both `generateModule` and `generateMultiModule`. Used by `wrapExports` as the authoritative discriminator (because `__vec_len` returns 0 for both empty arrays and non-vec structs).
- `emitVecAccessExports` (`src/codegen/index.ts:~2322`) no longer gated on `__iterator/JSON_stringify/__make_iterable`; emits when `vecTypeMap.size > 0` so array returns get `__vec_len/__vec_get` for the marshal path.
- New `tests/issue-1504.test.ts` — 6 tests passing; `tests/issue-1308.test.ts` regression intact (7/7); 55 equivalence tests passing.

### Resume steps
1. Check `/workspace/.claude/ci-status/pr-404.json` — if `head_sha` matches `5742e3da2` and net positive: `gh pr merge 404 --merge --admin`.
2. If regressions, run `/dev-self-merge 404` to see analysis. Watch for impact on test262 since the `emitVecAccessExports` widening adds exports to every module with vec types (low risk: pure additive).
3. After merge: set `status: done` in this file, `rm /workspace/.claude/agent-status/issue-1504-browser-export-interop.json`, `git worktree remove /workspace/.claude/worktrees/issue-1504-browser-export-interop`.
