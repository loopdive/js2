# WASI PR Audit — 2026-05-21

Audit of four sprint-53 PRs whose conflict resolution happened under
crash-and-respawn pressure. Source-only review (no commits). Each diff
inspected for dropped/duplicated changes, broken signatures, import-index
hazards, and TS errors.

Pre-existing baseline TS error (unrelated to these PRs):
- `src/codegen/expressions/calls.ts:5750` — `argValType.kind !== "externref"` comparison flagged by tsc on `main`. Not introduced by any of the four PRs (the file is dirty in the working tree of `main` per `git status` at audit start).

---

## PR #351 — issue-1438-keyed-collections — **LGTM**

src/runtime.ts only.

- New `_convertIterableForHost` helper added cleanly, scoped to wasm-struct
  detection (`_isWasmStruct` first). No duplication.
- `isIterableCtor` branch inside `resolveImport` is mutually exclusive with
  `isBufferConsumer` via `else if` — no double-conversion of `args[0]`.
- `Map/Set .forEach` wrapping uses `_wrapWasmClosure(cb, 3, callbackState)` —
  3-arity matches the spec callback signature `(value, key, map)` /
  `(value, value, set)`.
- `getOrInsertComputed` now captures the wrapped callback into a local
  `callback` variable and reuses it on the success path (`callback.call(...)`)
  — previously the un-wrapped `wrappedArgs[1]` would have been called,
  defeating the wrap. Conflict resolution kept the right side here.
- `convertToJS` inversion now early-returns on **plain** JS objects (non-wasm)
  including non-iterable WeakMap keys — correct relative to the comment.
- `WeakMap` symbol-key acceptance — spec-correct per ES2023.

No concerns.

---

## PR #392 — issue-1482-wasi-environ-get — **LGTM (minor note)**

Files: `context/create-context.ts`, `context/types.ts`, `codegen/index.ts`,
`codegen/property-access.ts`, `runtime.ts`, new test.

- Three new context fields declared as **required** (not optional) in
  `types.ts` and initialized to `-1` in `create-context.ts`. Consistent with
  existing `wasiPathOpenIdx` style. ✓
- `registerWasiImports` detection covers both `process.env.X` (Property) and
  `process.env["X"]` (Element) AST shapes. ✓
- After each `addImport`, the index is captured via
  `ctx.funcMap.get(<base_name>)!` — same naming convention used by sibling
  WASI imports. ✓
- `property-access.ts` + `compileElementAccess` short-circuit symmetric;
  both push key → externref → call `wasiEnvGetStrIdx`. Guard
  `ctx.wasiEnvGetStrIdx >= 0` prevents firing when the import wasn't
  registered. ✓
- `runtime.ts` polyfill: `buildWasiPolyfill` signature widened with
  `envImports` field; `environ_sizes_get` / `environ_get` correctly
  compute and write `KEY=VALUE\0` byte layout consistent across both calls.
- **Minor**: `wasiEnvironSizesGetIdx` / `wasiEnvironGetIdx` are recorded but
  never consumed in this PR (only `wasiEnvGetStrIdx` is read by codegen).
  They are reserved for the follow-up pure-WASI lowering — the PR
  description acknowledges this. Not a defect.

No correctness concerns.

---

## PR #393 — issue-1483-wasi-clock-time-get — **LGTM (architectural change, intentional)**

Files: `context/types.ts`, `codegen/expressions/calls.ts`,
`codegen/expressions/new-super.ts`, `codegen/index.ts`, `runtime.ts`, new test.

**Architectural refactor in this PR**: helper-function emission moved out of
`registerWasiImports` into a new exported `emitDeferredWasiHelpers(ctx)`
function, called from both `generateModule` (line 752+) and
`generateMultiModule` (line 2817+) **after** `emitToUint32Helper`. Reason
(quoted from diff): direct `addImport` callers later in the pipeline
(lib-globals scan adding `eval`/`parseInt`) silently shift past helper
funcMap entries, corrupting later lookups.

Audit of the refactor:
- Five helpers moved behind pending-flag gates: fd_write, console-stderr,
  path-open (write_file_sync), clock (date/perf-now), fd_read (read-stdin).
- Idempotent: each emit is guarded by `!ctx.funcMap.has(<name>)`. ✓
- Both top-level codegen entry points get the new call. ✓
- Original stderr-helper coupling preserved (only emitted if fd_write
  helper also pending) — same semantics as pre-refactor inline form. ✓
- `wasiClockTimeGetIdx` and the five `wasi*Pending*` fields declared as
  **optional** (`?:`) while sibling fields like `wasiFdCloseIdx` are
  required. Cosmetic inconsistency only — code paths read them via `!`
  non-null assertion or guarded `=== undefined` check.
- `__wasi_date_now` / `__wasi_performance_now` correctly recombine the
  64-bit nanosecond timestamp from two i32.load_u operations (i64.load
  intentionally avoided per inline comment). f64 conversion via
  `f64.convert_i64_s` — signed, but the comment correctly notes the range
  is safe (~292 years past epoch).
- `new Date()` no-arg + `Date.now()` + `performance.now()` are all wired.
- Polyfill `clock_time_get` is wired through `view.setBigUint64(out_ptr, …, true)`
  matching the little-endian load layout the helper emits. ✓

**Cross-PR concern — see § Merge Order below.**

---

## PR #395 — issue-1484-wasi-async-stubs — **LGTM (merge-order risk)**

Files: `context/types.ts`, `codegen/index.ts`, `runtime.ts`, new test.

- `wasiPollOneoffIdx?: number` added to context type (optional, no
  initializer needed in create-context). ✓
- `rejectTimersUnderWasi` is non-fatal — it calls `reportError(ctx, …)` but
  does **not** short-circuit codegen. Since `registerWasiImports` runs at
  line 664 (before `checkWasiDomUsage` / `rejectTimersUnderWasi` at line
  675 in current `main`), the `__wasi_sleep_ms` helper is still emitted
  even when the source will fail compilation. That's safe — the compile
  reports errors and never ships a binary — and `emitWasiSleepMsHelper`
  has a defensive `wasiPollOneoffIdx === undefined || < 0` early return.
- The `isNameSlot` predicate correctly suppresses false-positives on
  `obj.setTimeout` member-name positions.
- Sleep-helper memory layout (subscription_t at offset 64, event_t at
  112, nevents at 144) matches the polyfill shim's expectations
  (32-byte zero-fill on event_t, u32 nevents writeback).
- Polyfill `poll_oneoff` is a no-real-sleep shim suited for vitest;
  documented as such in the inline comment. Not a defect, but
  callers in wasmtime get real blocking — that's the intent.

### Merge-order risk (cross-PR)

PR #395 calls `emitWasiSleepMsHelper(ctx)` **inline** inside
`registerWasiImports`:

```ts
if (needsPollOneoff) {
  emitWasiSleepMsHelper(ctx);
}
```

PR #393 moved every other helper emission out of `registerWasiImports`
into the deferred-batch `emitDeferredWasiHelpers` precisely because
direct `addImport` callers later in the pipeline shift funcMap indices
past inline-emitted helpers, corrupting subsequent lookups.

**If #393 lands before #395, the sleep-helper will recur the exact bug
#393 fixed.** When merging main into the #395 branch, the resolver
needs to:

1. Move `emitWasiSleepMsHelper(ctx)` out of `registerWasiImports` and
   into `emitDeferredWasiHelpers`, gated on a new
   `ctx.wasiPendingPollOneoffHelper` flag set inside
   `registerWasiImports`.
2. Add a `!ctx.funcMap.has("__wasi_sleep_ms")` guard in
   `emitDeferredWasiHelpers` for idempotency.

The inline emission in #395 will **silently** miscount when fd_write /
console-stderr / clock helpers re-shift funcMap on later passes —
identical symptom to what #393 documented.

---

## Cross-PR notes

All three WASI PRs (#392, #393, #395) touch `src/codegen/context/types.ts`
and `src/runtime.ts:buildWasiPolyfill`. Conflicts are additive (new
fields, new return-type members) and should resolve cleanly with
`union-of-both-sides` semantics. **Watch that no field is dropped during
manual conflict resolution.**

The polyfill return type ends up with: `clock_time_get` (#393),
`environ_sizes_get` + `environ_get` + `envImports` (#392), `poll_oneoff`
(#395). All required keys; missing any one will fail TS compile of
callers in tests/.

## Verdict

| PR  | Status | Re-review needed |
|-----|--------|------------------|
| #351 | LGTM | No |
| #392 | LGTM | No |
| #393 | LGTM | No |
| #395 | LGTM** | **Yes if #393 merges first** — needs deferred-helper conversion |

Pre-existing tsc error in `calls.ts:5750` is on `main` and unrelated.

Total issues found: **1** (PR #395 merge-order hazard re: #393's
deferred-helper refactor).

Safe to merge in this order: #351, #392, #393, then re-base #395 with
the inline `emitWasiSleepMsHelper` call converted to deferred form
before merging.
