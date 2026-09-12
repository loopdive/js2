---
id: 6414
title: "hono's `adapter/cloudflare-pages` emits an invalid module — `struct.set[1] expected type i32, found local.get of type externref` in an async resume"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

`hono/dist/adapter/cloudflare-pages/index.js` compiles successfully and then
fails `WebAssembly.compile`:

```
Compiling function #318:"__async_resume_fanon_467" failed:
  struct.set[1] expected type i32, found local.get of type externref @+117395
```

An async resume continuation stores a spilled local back into its frame struct
with the wrong representation: the frame field was laid out as `i32` but the
value being written is `externref`. The other hono adapters
(`aws-lambda`, `bun`, `cloudflare-workers`, `deno`, `lambda-edge`, `netlify`,
`service-worker`, `vercel`) all compile and validate, so the disagreement is
specific to what this module's captured anonymous async function spills.

Likely related to
[#6412](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6412-hono-jwt-async-resume-extern-convert-any)
— both are `__async_resume_*` frames mixing `i32` and `externref` for one slot
— but they fail at different instructions and this has not been verified as one
root cause.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12).

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/adapter/cloudflare-pages/index.js
```

## Acceptance criteria

1. The module compiles to a binary that passes `validateEmittedBinary`.
2. Its row is deleted from `KNOWN_INVALID_MODULES` in
   `scripts/check-dogfood-validation.mjs`.
3. A regression test that fails on the parent commit and passes with the fix.

## Implementation Plan

**Verified on `23a0ddaa26` (2026-09-12):** the probe still reports `invalid` (`struct.set[1] expected type i32, found local.get of type externref` in `__async_resume_fanon_467`). Reduced to a 6-line untyped-JS shape from `handler.js`'s `handleMiddleware`:
`let response = void 0; try { response = await m(x); } catch (e) { x.error = e; } return response;` — also fails WITHOUT the try (`response = await m(x); await m(x); return response`) and as a plain named `async function`. With `let response;`, `= undefined` or `= null` it validates. So the trigger is exactly **a `void`-expression initializer on a resume-binding local that is spilled across a later await**; the try/catch in hono only makes `response` spill (the 3c layout spills every own local).

**Root cause (confirmed, not the #6412 defect):** under the compiler's strict checker `let response = void 0` has declared type `undefined` (a bare `undefined` initializer gets evolving `any`). `resumeBindingValType` (`src/codegen/async-frame.ts:773`) types the frame field from `resolveWasmType(checker.getTypeAtLocation(target))`, which lowers a pure `undefined`/`void` type to **i32**. The resume body's `let response = void 0` then goes through `localTypeForDeclaration` → `varBindingNeedsExternrefForUndefined` (#2806, `src/codegen/index.ts:13628`) → **externref**, and the var-decl retype arm (`statements/variables.ts:~2292`, `!(existingIsRef && newIsPrimitive)`) silently retypes the i32 resume local to externref. `stack-balance.ts`'s `local-set-coerce` patches the restore (`struct.get; f64.convert_i32_s; call __box_number`) but `storeSpills` (`frame-core.ts:180`) writes `local.get externref` into the i32 field with no coercion → invalid module. #6412 is a different instruction (`extern.convert_any` on an already-external value in `importPublicKey`); do not fold them.

**Fix (one function, all three consumers agree by construction):** in `resumeBindingValType`, before the checker query, resolve `rb.target`'s symbol declaration; if it is a `ts.VariableDeclaration` and `varBindingNeedsExternrefForUndefined(decl, ctx)` is true, return `{ kind: "externref" }`. That makes the spill field type equal the type the var-decl path will give the local. Callers that must stay in lockstep (no other edits needed, verify they all route through the one function): the spill-safety gates at `async-frame.ts:283` and `:1002`, the three layout builders (`:1025` non-try, `:1108` try/catch `computeTryCatchSpills`, `:1222` `computeAsyncSpills`), and the delivery-local typing at `:1943` (which already prefers the existing spill local's type). Order-preservation: do NOT touch `storeSpills`/`restoreSpills` (adding coercions there would change every existing frame), and do not widen `resolveWasmType`'s undefined→i32 arm (the `#1112` delete/undefined f64-sentinel machinery depends on it — that is why #2806 was scoped to void-EXPRESSION initializers). Prefer the more general form if it is still one-line: `resolveSpillBindingValType(ctx, decl)` when the target's declaration is a body `VariableDeclaration` and returns non-null — but then re-run the async equivalence suites, since it also changes f64/ref-typed resume bindings' fields; the narrow void-only arm is the safe default.

**Probe first (already written, keep under `.tmp/`):** `.tmp/6414/probe2.mjs` compiles cases e/g/j (must flip INVALID→valid) and f/h/i (anti-vacuity controls: valid before and after). Then re-run `node --import tsx tests/dogfood/dogfood-surface-probe.mjs --package hono --modules dist/adapter/cloudflare-pages/index.js` → `"verdict":"valid"`.

**Regression test `tests/issue-6414-void-init-async-resume-spill.test.ts`:** untyped `.js` two-file fixture via `compileProject` (or `compile` with `allowJs: true, skipSemanticDiagnostics: true`), `target: "gc"`: (1) validation — `validateEmittedBinary(result.binary).valid === true` for the try/catch shape and the no-try two-await shape (fails on parent with the struct.set message, passes with fix); (2) behaviour — instantiate with `buildImports` and assert the awaited value survives the second await (`return response === 42`) so the field is not merely well-typed but carries the value; (3) control — `let response;` variant valid on both parent and fix. Add a standalone-target case of the same source: expected to already validate on parent (the standalone lane's native drive layer uses the same layout; confirm — if it is also invalid there, it is covered by the same one-function fix).

**Acceptance:** delete the `dist/adapter/cloudflare-pages/index.js` row from `KNOWN_INVALID_MODULES` (`scripts/check-dogfood-validation.mjs:171`) and run `npm run -s check:dogfood-validation`. Dogfood movement: none expected in test counts (hono 259/324, others unchanged) — this module is not exercised by the hono upstream suite; the gain is validation-only. Run `npm test -- tests/async` equivalence files and the ratchet gates before commit.

## Dispatch

**opus** — the diagnosis is complete and the fix is a one-arm change in `resumeBindingValType` with a ready reduction, but the spill-layout/gate/delivery lockstep and the #1112 sentinel constraint need judgment beyond a mechanical edit.
