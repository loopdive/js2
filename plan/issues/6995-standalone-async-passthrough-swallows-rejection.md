---
id: 6995
title: "standalone async: the legacy synchronous pass-through lane silently miscompiles every shape the drive engine declines — a rejected `await` inside nested try/catch/finally is swallowed (function fulfils), `await <thenable>` returns the thenable, `await <struct object>` traps `illegal cast`; the #3587 loud refusal returns early for standalone/wasi"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: async-await, try-finally, promises
goal: standalone-gap
related: [3587, 2895, 2865, 6428, 6996]
---

# Standalone async: declined shapes fall to a lane that cannot see rejection

Found by the 2026-10-15 audit (control-flow lane). Standalone only; the gc lane REFUSES to compile the same shape (#3587 loud refusal), standalone miscompiles silently.

## Repro (node → wasm, `target: "standalone"`)

```js
async function a(){ let s=""; try { try { await Promise.reject(1); } catch(e){ s+="c"; throw e; } finally { s+="f"; } } catch(e2){ s+="o"+e2; } return s; }
a().then(v => console.log(v));     // node "cfo1", wasm "f" — and the promise FULFILS
```
Same with no rethrow (`"cf"` vs `"f"`), with an outer try/finally (`"cfF"` vs `"fF"`), with the inner try wrapped in a `{}` block, or preceded by `await null`. Non-nested try/catch/finally around the await is fine (admitted by the drive engine).

```js
async function a(){ return await { then(res){ res(42); } }; }   // node 42, wasm "[object Object]"
async function a(){ const o={k:1}; const r = await o; return r.k; } a().then(log)   // node 1, wasm RuntimeError: illegal cast (after the following statement ran)
```

## Root cause

- `src/codegen/async-activation.ts:86-92` — on the native-`$Promise` carrier lane the only admission is `asyncFnNeedsDrive` (`src/codegen/async-frame.ts:968-1046`); a try/catch/finally nested inside another `try` has no linear/loop/try-catch plan (`planLinearAwaits` → null, `computeTryCatchSpills` → null) ⇒ decline ⇒ legacy synchronous pass-through.
- `src/codegen/async-activation.ts:225` — `reportDeclinedAsyncRejectionHazard` returns early `if (ctx.wasi === true || ctx.standalone === true)`, so the decline is silent on exactly the lanes that miscompile.
- `src/codegen/async-value-sink-unwrap.ts:38-66` `emitStandaloneAwaitUnwrap` (called from `src/codegen/expressions.ts:1611-1618`) does `ref.test $Promise` → `struct.get $Promise.value` WITHOUT checking `.state`; a rejected `$Promise`'s reason is treated as the fulfilled value. `elseBody` passes a non-`$Promise` externref through untouched (no `then` lookup), and a non-externref operand returns its own static type, which the completion path later `ref.cast`s.
- It also sets `$Promise` field 4 (handled) on every legacy await, so the swallowed rejection never surfaces as unhandled either.

## Implementation Plan

Two layers, both in this PR; the first is the safety net, the second the fix for the common shapes.

1. **Never silent.** Make `reportDeclinedAsyncRejectionHazard` apply to standalone/wasi: when the drive engine declines a body that has a real suspension inside a `try` (same condition the host lane uses), emit the same loud compile error (or a typed refusal) instead of falling to the pass-through. Keep the `ASYNC_CPS_ENABLED` and `realSuspension` conditions. Measure the blast radius first: compile `tests/equivalence/*async*` and a test262 stride of `built-ins/Promise` + `language/statements/async-function` with the refusal on and record how many files flip from pass to compile-error in this issue file. If it is large, keep the refusal but ALSO land step 2 so the common shapes keep compiling.
2. **Make the unwrap honest.** In `emitStandaloneAwaitUnwrap`: read `$Promise.state` (field index per `getOrRegisterPromiseType`); fulfilled → value; rejected → mark handled and `throw` the reason through the standard exception tag (`ensureExnTag` / the same path `throw` statements use in standalone, see `statements/exceptions.ts`); pending → this lane cannot suspend: refuse at compile time (step 1 covers it; at runtime `unreachable` is acceptable only if the compile-time gate guarantees it is dead). Keep `src/ir/lower-generic.ts`'s `await` arm in lockstep (the file says so at `ir/backend/lower-contracts.ts` L272) — update both or the IR path drifts.
3. Thenable: in the `else` arm, if the operand is a non-null externref that is an object with a callable `then`, route through the existing `__promise_thenable_job` / promise-resolve machinery used by `promise-combinators.ts`; if that helper is host-only, restrict this PR to refusing (`await` of a provably-non-promise object is a compile-time refusal on this lane) and note the gap here.
4. Struct operand: in `expressions.ts:1611-1618`, when the operand's static type is a `ref` to a struct (not externref), either box to externref before the unwrap (so the result type is uniformly externref) or refuse. Do not return `operandType` unchanged.
5. Tests: the four repros above plus the audit's variants (outer try/finally, block-wrapped inner try, `await null` before). Assert the swallowed case now either throws `"cfo1"`-equivalent output or fails to compile with the refusal — the test must pin whichever you ship, and the PR body must say which.

## Acceptance

- No standalone compile of a real-suspension-in-try shape produces a fulfilled promise for a rejected await. Either correct output or a compile-time refusal; never silent.
- `tests/equivalence/*async*` pass; standalone test262 `built-ins/Promise` + `async-function` stride does not regress beyond the files you listed as newly-refused (list them).
- gc lane byte-identical.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6995-standalone-async-passthrough-swallows-rejection.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
