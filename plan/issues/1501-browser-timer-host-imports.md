---
id: 1501
title: "browser: setTimeout/setInterval/clearTimeout/clearInterval host imports"
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
related: [1326c, 1382, 1500]
---
# #1501 — Timer host imports: `setTimeout` / `setInterval` and their clearers

## Problem

Compiled TypeScript cannot schedule callbacks against the host event loop.
`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`,
`queueMicrotask`, and `requestAnimationFrame` are all unbound. Like `fetch`
(#1500), `setTimeout` resolves through `declared_global`
(`src/runtime.ts:4645`) but two layers break:

1. **Callback is a WasmGC closure, not a JS function.** When compiled code
   calls `setTimeout(fn, 1000)`, `fn` is a WasmGC closure struct — `typeof
   fn === "object"` from the host's perspective. `globalThis.setTimeout`
   silently fails (browsers stringify the callback and `eval` it, which
   throws `"function is not a function"` later when the timer fires).
2. **Handle return value is a number in the browser, an opaque `Timeout`
   object in Node.** Compiled `clearTimeout(handle)` would need to round-trip
   that value, but the externref bridge cannot distinguish the two cases.

The closure-bridging machinery from #1382 (`_wrapWasmClosure` at
`runtime.ts:293`) already knows how to wrap a WasmGC closure as a JS
function that dispatches through `__call_fn_0` — that's the exact piece
needed here, but no current host import calls it for timer callbacks.

## Use case

```ts
function delayedHello(ms: number): void {
  setTimeout(() => {
    console.log("hello after", ms, "ms");
  }, ms);
}

let tick = 0;
const handle = setInterval(() => {
  tick++;
  if (tick >= 3) clearInterval(handle);
  console.log("tick", tick);
}, 100);
```

Both should compile and behave identically to plain JS execution.

## Current behavior

- `setTimeout(closure, ms)` calls `globalThis.setTimeout(closureStruct,
  ms)`. The browser/Node coerces `closureStruct` to `"[object Object]"` (or
  fails an `instanceof Function` check) and the timer **never fires**.
  Silent failure — no error surfaces to compiled code.
- `setInterval` same.
- `clearTimeout(handle)` if a handle were obtained: in Node 18+,
  `setTimeout` returns a `Timeout` object (`Object` w/ `Symbol.toPrimitive`).
  Compiled code stores it as externref and passes it back into
  `clearTimeout` — that part round-trips. In browsers the handle is a
  number; reading it as externref also works. So clear is OK *if* the
  schedule worked. Today it doesn't.

## Implementation plan

1. **`src/index.ts`** (≈line 33): extend `ImportIntent` with
   ```ts
   | { type: "timer_set"; mode: "timeout" | "interval" | "microtask" | "raf" }
   | { type: "timer_clear"; mode: "timeout" | "interval" }
   ```
2. **`src/codegen/expressions/calls.ts`**: in the bare-identifier dispatch
   path, recognise `setTimeout`, `setInterval`, `clearTimeout`,
   `clearInterval`, `queueMicrotask`, `requestAnimationFrame`. Register them
   as host imports with signatures:
   - `set_timeout`: `(externref, f64) -> externref` — callback handle, ms;
     returns timer-handle externref.
   - `set_interval`: same shape.
   - `clear_timeout` / `clear_interval`: `(externref) -> ()`.
   - `queue_microtask`: `(externref) -> ()` — no return.
   - `request_animation_frame`: `(externref) -> f64` — returns frame id.
3. **`src/runtime.ts`** `resolveImport` (≈line 1700): add cases that wrap
   the callback through `_wrapWasmClosure` (`runtime.ts:293`):
   ```ts
   case "timer_set": {
     const host = intent.mode === "interval" ? setInterval :
                  intent.mode === "raf"      ? requestAnimationFrame :
                  intent.mode === "microtask"? queueMicrotask :
                                                setTimeout;
     return (cb: any, ms: any) => {
       const fn = typeof cb === "function" ? cb :
                  _wrapWasmClosure(cb, 0, callbackState);
       if (typeof fn !== "function") {
         throw new TypeError("js2wasm: timer callback is not callable");
       }
       return intent.mode === "microtask" || intent.mode === "raf"
         ? host(fn)
         : host(fn, ms);
     };
   }
   case "timer_clear": {
     const host = intent.mode === "interval" ? clearInterval : clearTimeout;
     return (h: any) => host(h);
   }
   ```
4. **Standalone-mode fallback (CLAUDE.md dual-mode)**: when targeting WASI
   (no `setTimeout`), the WASI `poll_oneoff` clock subscription is the
   correct lowering. Out-of-scope for the first cut — document as
   `"timers are JS-host-only for now"`. Throw a descriptive error in WASI
   target rather than silently dropping the call.
5. **Closure arity > 0**: browsers pass extra args to `setTimeout`
   callbacks (`setTimeout(cb, ms, a, b)`). Detect rest args at the call
   site and use `__call_fn_N` for the matching arity. For the first cut
   only the 0-arg form is required — extras can be a follow-up.
6. **Lifetime / GC**: WasmGC closures kept alive only by the JS-side timer
   handle. The wrapper closure created by `_wrapWasmClosure` captures the
   raw closure by closure-variable, which keeps it reachable until the
   timer fires (browser) or is cleared. No extra rooting needed.

## Acceptance criteria

`tests/equivalence.test.ts` block with these cases (using vitest fake
timers, `vi.useFakeTimers()`):

```ts
let log = "";
setTimeout(() => { log += "a"; }, 100);
setTimeout(() => { log += "b"; }, 50);
// vi.advanceTimersByTime(200) → log === "ba"
```

```ts
let tick = 0;
const h = setInterval(() => { tick++; }, 10);
// vi.advanceTimersByTime(35) → tick === 3
clearInterval(h);
// vi.advanceTimersByTime(100) → tick === 3 (no further ticks)
```

```ts
let order = "";
queueMicrotask(() => { order += "m"; });
order += "s";
// after microtask flush → order === "sm"
```

Pass means the timer host import dispatched the WasmGC closure via the
`__call_fn_0` wrapper, observable side-effect (`log` / `tick` / `order`)
matches the JS reference behavior.

## Files to modify

- `src/index.ts` (≈line 33) — extend `ImportIntent` with timer variants.
- `src/codegen/expressions/calls.ts` — register timer host imports on
  identifier resolution.
- `src/runtime.ts` (≈line 1700 switch; closure helper at line 293) — new
  cases, reuse `_wrapWasmClosure`.
- `tests/equivalence.test.ts` — new "timer host imports" block.
- `playground/examples/dom/` — adapt one example to use a real
  `setTimeout` for a live demo.

## Notes

- The microtask machinery from #1326c is orthogonal — that handles
  *internal* `Promise.then` continuations, this handles user-facing
  `queueMicrotask(cb)` from compiled code.
- `requestAnimationFrame` only makes sense in a browser; degrade
  gracefully in Node (alias to `setTimeout(cb, 16)`).

## Suspended Work

- **PR:** https://github.com/loopdive/js2/pull/403
- **Branch:** `issue-1501-browser-timer`
- **Worktree:** `/workspace/.claude/worktrees/issue-1501-browser-timer`
- **HEAD:** `5c7a46e5e2685f9d3c35189cfde508d49533c3ea`
- **Status:** ci-wait

### Implemented (committed in 5c7a46e5e)

- New `timer_set` / `timer_clear` ImportIntent variants in `src/index.ts`.
- `preprocessImports` auto-injects a typed timer shim when bare-id calls to `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are detected. Respects user-defined functions of the same name.
- Classifier routes `__timer_set_timeout` / `__timer_set_interval` / `__timer_clear_timeout` / `__timer_clear_interval` → new intents.
- Runtime resolver binds to `globalThis.{set,clear}{Timeout,Interval}`, bridges WasmGC closures through `_wrapWasmClosure(__call_fn_0)`. Warn-once on unresolvable callback (no throw). Verified end-to-end: setTimeout fires the compiled closure, setInterval+clearInterval cancel correctly.
- `tests/issue-1501.test.ts` — 8 tests (all pass).
- Plays nicely with #1484's WASI diagnostic — `function setTimeout(...)` name slot is filtered by `isNameSlot`, user's bare call still flagged.

### Resume steps

1. Wait for `/workspace/.claude/ci-status/pr-403.json` with matching `head_sha`.
2. Run `/dev-self-merge 403`. If MERGE: `GATE_BYPASS=1 gh pr merge 403 --admin --merge`.
3. Post-merge cleanup.

### Follow-ups

- `queueMicrotask` / `requestAnimationFrame` host imports (same pattern).
- Closure-arity > 0: detect rest-arg use-site and dispatch through `__call_fn_N`.
- Standalone-mode lowering of `setTimeout` via `__wasi_sleep_ms` (depends on #1484 follow-up).
