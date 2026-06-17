---
id: 1536
title: "Wasm-native exception types: $Error WasmGC struct + throw / try_table / catch_ref"
status: done
completed: 2026-06-16
assignee: ttraenkler/dv3
created: 2026-05-20
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: errors
goal: standalone-wasm
sprint: 62
related: [1535, 1470, 1471, 1472, 1473]
---
# #1536 — Wasm-native exception types ($Error + Wasm 3.0 EH)

## Problem
`new Error(msg)`, `__throw_type_error`, `__throw_reference_error`, and `__get_caught_exception` currently all bridge through the JS host (`runtime.ts`). This blocks standalone (WASI) mode from throwing or catching any exception cleanly: the compiled binary cannot construct a JS Error and the host must materialise an externref for every `throw`.

## Proposed solution
Adopt Wasm 3.0 exception handling end-to-end:

1. Define WasmGC struct types for `$ErrorBase`, `$TypeError`, `$ReferenceError`, `$RangeError`, `$SyntaxError` (extending `$ErrorBase`) — each carrying a `(field $message i16-array-ref)` (native string).
2. Declare Wasm `tag` exports (one per error class, or a single tag parameterised by a `ref $ErrorBase`).
3. Replace `__throw_type_error(msg)` / `__throw_reference_error(msg)` codegen with: `(struct.new $TypeError) ; throw $err_tag`.
4. Replace `try { ... } catch (e) { ... }` lowering: emit `try_table (catch $err_tag $catch_label)` ... `catch_ref $err_tag` block. Bind `e` as the caught `ref $ErrorBase`; downstream code uses `ref.test`/`ref.cast` for `instanceof TypeError` etc.
5. Keep a host-import fallback path for the JS-host mode where `new Error()` must produce a JS-visible Error (Node interop). Default to native in `--standalone` / `--wasi`.

## Library/approach
No external library — pure Wasm 3.0 EH. Binaryen wasm-opt has `exnref` support (with caveats — block-parameter limitation in issue #3114; may need legacy EH on first pass and migrate).

## Binary size impact
+2-3 KB Wasm (struct definitions + tag declarations + 3-4 emitter helpers). Net **reduction** vs current pipeline because we drop 3 host import shims (~1 KB each in the host glue) and remove the boxed externref allocations on every throw.

## Test262 impact (estimated)
- Today: many `try`/`catch` tests pass only because the JS host happens to round-trip the externref correctly. Standalone mode currently fails on any error.
- After: unlocks ~300-500 test262 tests that depend on cross-error-class `instanceof`/`name` properties in WASI mode (currently they all `Compile-Error` or `RuntimeError` in standalone).

## Implementation steps
1. Add `$ErrorBase` struct and class hierarchy to `src/codegen/registry/types.ts`.
2. Declare wasm tags via Binaryen `module.addTag(...)`.
3. Update `src/codegen/typeof-delete.ts` (or wherever `__throw_*` is emitted) to use `throw` / `throw_ref`.
4. Update try/catch lowering in `src/codegen/statements.ts` to `try_table` + `catch_ref`.
5. Migrate `__get_caught_exception` callers to read the caught `ref` directly.
6. Keep host imports as fallback under `if (ctx.jsHost && !ctx.wasi)`.
7. Add unit tests: throw → catch round-trip; cross-class `instanceof`; stack of try blocks; rethrow.

## Risk
Binaryen `exnref` is still rough; may need to land on legacy EH (`try`/`catch $tag`) first and migrate to `exnref` once Binaryen catches up.

## Implementation Plan (architect, 2026-06-16)

### Status correction (recon)
Most originally-proposed work already landed (#1104 Phase 1, #1473, #1536 Phase 2, #2077). Confirmed in-tree:
- `$Error_struct` exists — `src/codegen/registry/error-types.ts:79` `getOrRegisterErrorStructType` registers `struct { tag:i32, message:(mut externref), name:externref }` (tag from `BUILTIN_TYPE_TAGS`).
- Wasm-native `__new_<ErrorName>` constructors exist — `emitWasiErrorConstructor` (error-types.ts:117); all 8 (Error/TypeError/RangeError/SyntaxError/URIError/EvalError/ReferenceError/AggregateError).
- `.message`/`.name` reads work standalone — `property-access.ts:1547-1640` reads struct fields under `ctx.wasi || ctx.standalone`, incl. the #2077 `catch (e)` any-binding path.
- `instanceof TypeError` works standalone — `identifiers.ts:1112-1166` discriminates via `$tag` vs `collectErrorInstanceOfTags`; no `__instanceof` import.
- `throw`/`try`/`catch` lower without host import standalone — `statements/exceptions.ts:209-250` coerces thrown value to externref + `throw $tag`; `catch_all`+`__get_caught_exception` already skipped when `ctx.wasi || ctx.standalone` (exceptions.ts:549 `skipCatchAll`).

So the only EH host import is `__get_caught_exception`, already DCE'd in standalone. **Re-scope to the four real gaps.**

### Remaining gaps & decisions
1. **`error.stack` returns nothing** — no `$stack` field; `err.stack` falls to host `__extern_get` (null standalone).
2. **User `class MyError extends Error {}` not modeled** — a user subclass is a normal class struct, not `$Error_struct`, so `instanceof Error` + `.message` via `super(msg)` aren't wired through the tag machinery.
3. **REJECT per-class tags** (issue step 2) — single `__exn(externref)` tag (`registry/imports.ts:116`) + struct `$tag` discrimination is already shipped and simpler. Document.
4. **DEFER `try_table`/`catch_ref` migration** (issue step 4) — emitter (`emit/binary.ts:1387`) emits legacy `try`/`catch`/`catch_all`/`rethrow`; legacy EH is accepted by current V8/wasmtime. Split to `#1536b`.

### Changes
- `registry/error-types.ts`: add 4th field `stack:(mut externref)` after `name` (fieldIdx 3; keeps message=1/name=2 indices stable). `emitWasiErrorConstructor`: init `stack = ref.null.extern` (= undefined; `.stack` is non-standard, no normative test262 coverage; real stack-capture needs no Wasm primitive → out of scope).
- `property-access.ts`: extend the `(wasi||standalone)` Error fast path (1547) with `propName === "stack"` → fieldIdx 3, null-tolerant like message/name.
- User subclass `instanceof Error` (`identifiers.ts:42` `collectErrorInstanceOfTags`, 1117 block): **(a) preferred** reuse `BUILTIN_TYPE_TAGS["Error"]` as the discriminant for any class transitively `extends Error` (heritage walk); **(b) fallback** standalone-only compile-time heritage check. If it balloons, ship gap #1 + decisions #3/#4 here and split user subclasses to `#1536c`.
- `super(msg)` propagation (only if subclasses in-scope): route `super(m)` to `struct.set $Error_struct fieldIdx 1` via the class-bodies super-call lowering.

### Edge cases
`throw "str"`/`throw 42` (already works; `.stack` on non-Error caught value → undefined not trap); `catch(e){throw e}` rethrow (already optimized, exceptions.ts:209-228); nested try/catch/finally (depth bookkeeping handled — do NOT touch); `new Error()` no-arg → `.message === ""` (§20.5.1.1); `error.name = "Custom"` write → `$name` currently immutable, flip to mutable only if a test requires (§20.5.3); AggregateError `.errors` out of scope.

### Scoping / gate
All gated `ctx.wasi || ctx.standalone`; JS-host unchanged (V8 gives real `.stack`). No new host imports.

### test262 gate
`built-ins/Error/`, `built-ins/NativeErrors/{TypeError,RangeError,SyntaxError,ReferenceError,EvalError,URIError}/`, `language/statements/{try,throw}/` standalone; `.stack` has no normative coverage — unit-test that reads return undefined without trapping. `tests/issue-1536.test.ts` `{target:"standalone", testRuntime:true}`.

## Resolution (2026-06-16, dv3) — gap #1 implemented here; gap #2 → #1536c

Per the architect recon, the bulk of #1536 (the `$Error_struct`, native
`__new_<Error>` constructors, standalone `.message`/`.name` reads, standalone
`instanceof`, and host-import-free `throw`/`try`/`catch`) already landed via
#1104/#1473/#1536-Phase2/#2077. This PR closes the architect's **gap #1** and
records decisions #3/#4:

- **gap #1 `error.stack` — IMPLEMENTED HERE.** Added the 4th `$Error_struct`
  field `stack` (mutable externref, fieldIdx 3, after message(1)/name(2) so
  those indices stay stable — `registry/error-types.ts`),
  `emitWasiErrorConstructor` now initializes it to `ref.null.extern`, and the
  `(wasi||standalone)` property-access fast path reads `message`/`name`/`stack`
  via `struct.get` (fieldIdx 3 for stack — `property-access.ts:1582`,1610).
  `error.stack` standalone now lowers to the native struct read (NOT the host
  `__extern_get` import) and reads back as `undefined`/falsy without trapping.
  Tests: `tests/issue-1536.test.ts` Gap-#1 block (3 cases) + the 4 Phase-2
  cases stay green; #1104/#2077 suites (37 tests) non-regressing; `tsc` clean.
- **decision #3** — single `__exn(externref)` tag + struct-`$tag`
  discrimination is the shipped design (per-class tags rejected, as planned).
- **decision #4** — legacy `try`/`catch`/`catch_all`/`rethrow` emission is the
  shipped path; `try_table`/`catch_ref` migration deferred (separate `#1536b`).

**Only the architect's gap #2 remains, and it is split out to #1536c.** A user
`class MyError extends Error {}` is marked externref-backed
(`class-bodies.ts:434`), so in **standalone** it leaks `env::__new_Error` +
`env::__tag_user_class` and the module fails to instantiate (verified). Making
it standalone-native requires (a) routing subclass instance-creation through the
native `__new_<Parent>` (`emitWasiErrorConstructor`) under `wasi||standalone`
instead of the host import, and (b) a standalone-native `instanceof` tag chain
replacing the host `__tag_user_class`/`__instanceof`. That is a
**high-blast-radius rework of the externref-backed-subclass core** — exactly the
escape hatch the architect named ("ship gap #1 + decisions #3/#4 here and split
user subclasses to #1536c"). Tracked as **#1536c** (feasibility:hard, sprint 63,
routed to senior-dev).
