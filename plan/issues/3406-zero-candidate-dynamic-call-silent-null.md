---
id: 3406
title: "Dynamic any-callee with zero closure candidates silently returns null instead of invoking or throwing"
status: ready
created: 2026-07-18
updated: 2026-08-26
priority: critical
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: dynamic-call
goal: correctness
sprint: current
related: [2939, 2940, 3335, 1858]
origin: "2026-07-18 codebase engineering audit (plan/log/2026-07-18-codebase-engineering-audit.md, F1)"
---

# #3406 — zero-candidate dynamic calls silently return `null`

## Problem

A real JS function passed through an `any` parameter is silently not called when
the current module has no registered closure-wrapper candidates:

```ts
export function test(f: any): any {
  return f(2);
}
```

Verified on `origin/main` at `852c40a9`: compilation succeeds and the Wasm
validates, but invoking `test((x) => x + 1)` returns `null` instead of `3`.

This is a silent miscompile, not a diagnostic-quality issue. Argument side
effects still execute, while callee side effects and the return value disappear.
A non-callable value likewise takes the synthesized-`null` path instead of throwing a
catchable `TypeError`.

## Root cause

`tryEmitInlineDynamicCall` derives closure arms from
`ctx.closureInfoByTypeIdx`. At
`src/codegen/expressions/calls.ts:3618`, it returns `null` when there are zero
closure candidates and no standalone special carrier. That happens before the
host `__call_function` default arm added by #3335 can be built.

The identifier-call caller interprets `null` as "unsupported unknown function"
and deliberately lowers the call to:

1. evaluate each argument;
2. drop each argument value;
3. push `ref.null.extern` as the result.

See `src/codegen/expressions/call-identifier.ts:1651-1666`.

#3335 repaired the default arm of a dispatch chain that has candidates. It did
not cover the zero-candidate early return, so the old silent fallback remains
reachable in the simplest exported-parameter shape.

## Scope

- Repair bare identifier calls whose callee is dynamically typed and whose
  closure candidate set is empty.
- Host lane: invoke a non-null raw host callable through the existing
  `__call_function` bridge.
- Standalone/WASI: dispatch any supported native callable carrier; otherwise
  refuse at compile time or throw a catchable runtime `TypeError`.
- Preserve exactly-once evaluation of the callee and every argument.
- Do not broaden unrelated property/method-call dispatch in the same slice.

## Implementation steps

1. Add `tests/issue-3406.test.ts` with the minimal exported-parameter regression
   before changing code. Assert compile success, Wasm validation, exactly one
   callback invocation, argument `2`, and result `3`.
2. Add a non-callable probe under `try/catch` and assert a catchable `TypeError`,
   not `null`/`undefined` and not an uncatchable Wasm trap.
3. Restructure the zero-candidate guard in `tryEmitInlineDynamicCall` so host
   mode can build the existing raw-callee `__call_function` arm even when the
   closure-arm list is empty. Reuse the existing argument array and host-call
   marshalling; do not add a second bridge.
4. Keep standalone special carriers (`Proxy`, bound functions, TypedArray
   constructors) ahead of the refusal arm. Add a loud terminal arm for an
   unsupported/non-callable dynamic value.
5. Audit late-import registration order. All host helper imports must be
   ensured and `flushLateImportShifts` completed before any helper/function
   index is captured into detached dispatch buffers.
6. Remove or narrow the outer `ref.null.extern` call fallback so no reachable
   dynamic call reports success while deleting the invocation.

## Acceptance criteria

- [ ] The verified `test(f:any) { return f(2) }` probe calls a host function
      once and returns `3` in the default lane with zero closure candidates.
- [ ] A dynamically supplied non-callable throws a catchable JS `TypeError`.
- [ ] Callee and argument expressions are evaluated once, in JS order, on both
      success and throw paths.
- [ ] Host, standalone, and WASI behavior is explicit; none silently synthesizes
      a synthesized nullish value for an unsupported call.
- [ ] Existing one-candidate and multi-candidate closure dispatch tests remain
      valid and stack-balanced.
- [ ] Generated modules pass `WebAssembly.validate`; no new stack-balance,
      function-index, host-import, or codegen-fallback debt is introduced.

## Validation plan

- Targeted `tests/issue-3406.test.ts` regression suite covering zero/one/many candidates,
  void/value-returning callbacks, non-callables, thrown callback errors, and
  side-effectful arguments.
- Existing dynamic dispatch suites: #2939, #2940, #3031, #3140, #3177, and
  #3335 tests.
- `pnpm run typecheck`
- `pnpm run check:stack-balance`
- `pnpm run check:codegen-fallbacks`
- `pnpm run check:loc-budget`
- Default-lane test262 comparison, with special attention to callback-vacuity,
  Promise, TypedArray harness, and `TypeError` buckets.

## Dependencies

- Reuse the host-call bridge landed by #3335.
- Coordinate with any in-flight work touching
  `tryEmitInlineDynamicCall`/`call-identifier.ts`; this is a high-conflict,
  stack-sensitive area.

## Risks

- Ensuring host imports inside detached buffers can shift function indices and
  reproduce the #1858/#2611 class of invalid Wasm unless the shift is flushed
  before indices are captured.
- Every `if` arm must leave the exact declared block result type. Void and value
  call sites need separate coverage.
- A broad fallback change can turn existing vacuous results into real execution,
  exposing honest test262 failures. Treat such flips as behavior corrections,
  not grounds to restore the silent no-op.

## Implementation Plan

### 0. Re-verification against current main (0e65e238, 2026-08-26)

The **headline repro is FIXED**; the issue is **still actionable** on a smaller,
precisely-located surface. Probes under `.tmp/probe-3406*.mts` (gitignored),
host lane = `compile(src)` + `buildImports`, standalone = `{ target:
"standalone", nativeStrings: true }` + `WebAssembly.instantiate(bin, {})`.

| # | Shape | Lane | Result on `0e65e238` | Verdict |
|---|---|---|---|---|
| A | `export function test(f:any){ return f(2) }`, `f=(x)=>x+1` | host | **`3`, callee invoked once** | **FIXED** |
| B | same, `f=42` | host | **throws `TypeError: value is not a function`** | **FIXED** |
| C1 | `f(1..11)` — 11 args, zero candidates | host | **`null`, callee never invoked, args dropped** | **OPEN** |
| C2 | `f(1..10)` — 10 args, zero candidates | host | `10`, invoked | ok |
| F1 | `f(bump(1),2..11)` — 11 args, **one** candidate in module | host | `11`, invoked | ok (candidate ⇒ #3335 arm) |
| T1 | opaque `f = n>0?42:7; f(2)`, zero candidates | standalone | **`null`, no throw** | **OPEN** |
| T2 | same, one **arity-1** candidate present | standalone | **`null`, no throw** | **OPEN** |
| T2b | same, one **arity-3** candidate present | standalone | **`null`, no throw** | **OPEN** (different terminal, see §2) |
| N1/N3/N4 | opaque callee `null` / `{a:1}` / `"s"` | standalone | **`null`, no throw** | **OPEN** |
| T4/T5/N2 | the above under `try/catch` | standalone | catch never runs | **OPEN** |
| N5/N6 | arity 9 / 10 dynamic call on a real closure | standalone | `42` / `43` | ok |

**What fixed A/B:** #4527 (`40554219`, 2026-08-21) added the
reference-preserving `__call_dyn_<n>` host bridge at
`src/codegen/expressions/call-identifier.ts:2683-2762`, placed *after* the
`tryEmitInlineDynamicCall` call at `:2675-2677`. It is the exact zero-candidate
host path this issue described, and its host-side handler
(`src/runtime.ts:16379-16390`) throws a real `TypeError` for a non-callable.
The issue's §Root-cause analysis is therefore correct but **incidentally
resolved for the host lane at arity ≤ 10**; the `tryEmitInlineDynamicCall`
early return itself (now `src/codegen/expressions/calls.ts:4118`) is unchanged
and still returns `null` for a zero-candidate host call.

**What is still open**, i.e. the residual scope of #3406:

1. **Host lane, arity > 10** (C1/A12) — the #4527 bridge is gated
   `expr.arguments.length <= 10` and no-spread; above it, control reaches the
   graceful `ref.null.extern` at `call-identifier.ts:2787-2796`. Silent null,
   arguments evaluated then dropped. Acceptance criterion 1 fails here.
2. **Standalone / WASI, every non-callable** (T1/T2/T2b/N1/N3/N4) — no
   `TypeError` is ever thrown for a dynamic call on a non-callable; the value
   is silently `undefined`. Acceptance criteria 2 and 4 are fully open for
   these lanes. This is not an oversight but a **documented deferral**: see the
   `S1 SCOPE — NO THROWS` header at `src/codegen/object-runtime.ts:6790-6802`,
   which names the spec-correct `TypeError` as "the S2 fast-follow". #3406 is
   that fast-follow.

The blocker that header cites (pulling `__new_TypeError` + the exn tag + a
string constant in at finalize shifts func indices — the #1839/#117/#1886
class) **no longer applies**, on two independent grounds, both measured:

- A module that reserves `__apply_closure` **already contains**
  `__new_TypeError` and the `__exn` tag. Measured: minimal standalone module →
  neither present; any module with a dynamic call → both present plus
  `__apply_closure`. So the fill needs **zero** new registrations, only
  `funcMap` reads.
- The repo already has the pattern that makes it unconditionally safe:
  `reserveNullishReceiverThrow` (`src/codegen/closed-method-dispatch.ts:161-166`)
  does `emitWasiErrorConstructor(ctx,"TypeError",1)` + `ensureExnTag(ctx)` +
  `addStringConstantGlobal(...)` at **reserve** time so the finalize fill stays
  read-only, and `reserveBindDynHelper` (`object-runtime.ts:7404-7407`) does the
  same for its message string. Under `nativeStrings`
  (`addStringConstantGlobal`, `registry/imports.ts:130-140`) a string constant
  is import-free anyway — sentinel `-1`, materialized inline — and standalone
  is always native-strings.

End-to-end proof the target behaviour is reachable in standalone today:
`throw new TypeError(...)` caught with `e instanceof TypeError` returns `1`,
and the **existing** nullish-receiver guard (`o.m()` on an opaque `undefined`
`o`) already throws a catchable, `instanceof`-correct `TypeError` in standalone.

### 1. S1 — standalone/WASI: make the `__apply_closure` terminals throw

`src/codegen/object-runtime.ts`.

`buildDynamicApplyFallback` (`calls.ts:3932-3956`) is the innermost default arm
of every standalone dynamic call (`calls.ts:4410-4412`, armed by
`wantApplyFallback = ctx.standalone || ctx.wasi` at `calls.ts:4116`); it calls
`__apply_closure(fn, undefined, argsVec)`. So `__apply_closure` is the single
choke point for the standalone half.

**Change sites:**

- **`reserveApplyClosure` (`:6716-6738`)** — add, guarded on
  `ctx.standalone || ctx.wasi`, immediately before `mintDefinedFunc`:
  ```ts
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureExnTag(ctx);
  addStringConstantGlobal(ctx, NOT_A_FUNCTION_MESSAGE);
  ```
  Byte-inert for every module that already carries the ctor + tag (measured:
  all of them). Keeps the fill `funcMap`-read-only, per the
  `reserveNullishReceiverThrow` precedent.
- **New leaf module `src/codegen/dynamic-callable-throw.ts`** (see §5 — the
  god-files are all at their LOC cap) exporting:
  ```ts
  export const NOT_A_FUNCTION_MESSAGE = "value is not a function";
  /** Empty when the machinery is absent (host lane / never reserved). */
  export function notCallableThrowInstrs(ctx: CodegenContext): Instr[];
  ```
  Body is byte-for-byte the `then:` of `nullishReceiverGuardInstrs`
  (`closed-method-dispatch.ts:174-199`) minus its predicate:
  `...stringConstantExternrefInstrs(ctx, NOT_A_FUNCTION_MESSAGE)`,
  `{op:"call",funcIdx:ctx.funcMap.get("__new_TypeError")}`,
  `{op:"throw",tagIdx:ctx.exnTagIdx}`. Returns `[]` when
  `__new_TypeError` is missing or `ctx.exnTagIdx < 0`.
- **`fillApplyClosure` `undefinedSentinel` (`:6822`)** — leave as-is; it is
  also the *legitimate* undefined result of the proxy-revoker arm (`:7098`).
  Instead introduce a sibling
  `const notDispatched = (): Instr[] => [...notCallableThrowInstrs(ctx), ...undefinedSentinel()]`
  and use it at exactly two places:
  - **`armUnsupported` (`:6827`)** — the `n > APPLY_CLOSURE_MAX_ARITY` (>8) arm.
  - **`buildArm(n)`'s no-dispatcher branch (`:6939-6947`)** — the T2b path
    (verified: a module whose only closure has arity 3 emits no
    `__call_fn_method_1`, so an arity-1 dynamic call lands here).

  Keeping the trailing `ref.null.extern` after the throw is deliberate: the
  arm still statically produces `externref`, so the emitted `if` needs no
  stack-balance fixup (`pnpm run check:stack-balance` ratchets fixup COUNTS,
  `scripts/check-stack-balance.ts:1-36` — a new fixup fails CI).
- **Update the `S1 SCOPE — NO THROWS` header (`:6790-6802`)** to record that S2
  landed, why the index-shift blocker dissolved (reserve-time registration),
  and that the arity-overflow arm now throws rather than vanishing.

### 2. S2 — standalone/WASI: the `__call_fn_method_N` / `__call_fn_N` terminal

`src/codegen/closure-exports.ts:680` and `:1228`:
```ts
let funcrefDispatch: Instr[] = methodHostCallableFallback(ctx, arity) ?? [{ op: "ref.null.extern" }];
```
`hostCallableFallbackTerminal` (`:1001-1025`) returns `undefined` for
`ctx.standalone || ctx.wasi || native-first || arity > 4`, so those lanes keep
the bare null terminal. **This is where T2 lands** — verified: the T2 module
*does* emit `__call_fn_method_1`, so `__apply_closure`'s arity dispatch reaches
it and the non-callable falls off this terminal. S1 alone does **not** fix T2.

**Do not turn this terminal into an unconditional throw.** It is shared with
the accessor drivers (`fillAccessorDrivers`), the proto-iterator driver and the
disposable-stack driver, whose callee may be a legitimately callable carrier
that simply matched no closure arm (a `$__bound_fn`, a `$Proxy`, a
`$__ta_ctor`, a runtime-eval carrier). An unconditional throw converts today's
silent-undefined into a *wrong* `TypeError` for those.

**Gate it on the shared classifier instead.** Emit, only when
`ctx.standalone || ctx.wasi`:
```
local.get <fn>
call __typeof_function          ;; i32
i32.eqz
if (empty)
  <ref.test $Proxy → skip>      ;; ctx.objectRuntimeTypes?.proxyTypeIdx, when present
  ...notCallableThrowInstrs(ctx)
end
<existing ref.null.extern terminal>
```
`__typeof_function` is the ONE callability predicate
(`src/codegen/closure-classifier.ts:40-107`, spliced at finalize by
`fillStandaloneTypeofClosureArms`, `src/codegen/typeof-natives-finalize.ts:152-171`);
its root set already includes `ctx.boundFnTypeIdx` and
`ctx.runtimeEvalAotCallableCarrier`, and `buildBuiltinCallableTestArm` covers
the branded builtin carriers. The call is by `funcIdx`, so the finalize-order
relationship between this emit and the `__typeof_function` fill is irrelevant.
`$Proxy` is **not** in that root set (a callable proxy would be misjudged), so
it needs the explicit exclusion above — cheap, and byte-inert in proxy-free
modules.

Land S2 behind the same `notCallableThrowInstrs` helper, in the same PR as S1
but as a separate commit, so a bisect can isolate it.

### 3. S3 — host lane: close the arity > 10 hole

`src/codegen/expressions/call-identifier.ts:2691-2700`. The gate is
```ts
!noJsHost(ctx) && !ctx.standalone && !ctx.wasi && isKnownVariable &&
expr.arguments.length <= 10 && !expr.arguments.some((a) => ts.isSpreadElement(a))
```
The `<= 10` bound is arbitrary — the host handler is a regex
(`/^__call_dyn_\d+$/`, `src/runtime.ts:16379`), so any arity resolves. The bound
exists only to cap fixed-arity import proliferation. **Do not raise it to
another magic number**; make the excess arity terminate on the
arity-independent bridge instead:

- Keep `__call_dyn_<n>` for `n <= 10` (unchanged bytes for every module today).
- For `n > 10`: spill the callee and each already-`toExtern`-converted argument
  into externref locals (`allocLocal`), then emit
  `buildHostCallFallbackArm(ctx, fctx, planHostCallFallback(arity), calleeLocal, argLocals, undefinedThisInstrs)`
  from `src/codegen/expressions/host-call-fallback.ts:44-88`. With
  `arity > 4`, `planHostCallFallback` (`:19-29`) selects the array ABI
  (`__js_array_new` / `__js_array_push` / `__call_function`) — **one** import
  set for every arity. Its host implementation
  (`src/runtime/host-call-abi.ts:19-27`) throws
  `TypeError: <v> is not a function` for a non-callable, satisfying criterion 2
  on this path too.
- Order is preserved either way: callee is compiled first, then each argument
  left-to-right, each exactly once — matching §13.3.6.1 (callee reference,
  then ArgumentListEvaluation, then `Call()`), which is also why throwing
  *after* argument evaluation is correct here and NOT a violation of criterion 3.
- `noJsHost(ctx)` modules keep the existing degradation; note it explicitly in
  the comment rather than leaving it implied.

### 4. S4 — instrument what remains silent

Neither `calls.ts` nor `call-identifier.ts` calls `reportSilentFallback` today
(verified: zero hits in both files), so the graceful `ref.null.extern` at
`call-identifier.ts:2787-2796` is invisible to
`pnpm run check:codegen-fallbacks`. Add one call before it:
```ts
reportSilentFallback(ctx, "null-fallback", "call-identifier:dynamic-callee-graceful-null");
```
(class list: `src/codegen/fallback-telemetry.ts:31-49`). This does not change
codegen; it makes every future reachable silent-null a ratcheted number and is
the mechanism by which the *remaining* shapes (spread, `noJsHost`,
`!isKnownVariable`) stop being invisible. Refresh with
`pnpm run check:codegen-fallbacks -- --update` and commit
`scripts/codegen-fallback-baseline.json`.

**Do not** delete the graceful fallback outright (issue step 6). It is the
terminal for shapes this slice does not cover; removing it converts them from
silent-wrong to compile-crash. Narrow it by adding the covered paths above it,
and let the telemetry number drive the rest to zero.

### 5. Mechanical constraints

- **Every touch file is at its LOC-budget cap**
  (`scripts/loc-budget-baseline.json`): `calls.ts` 9985, `call-identifier.ts`
  3428, `object-runtime.ts` 11671, `closure-exports.ts` 2093. Put all new logic
  in the new leaf `src/codegen/dynamic-callable-throw.ts` (imports only types +
  `registry/error-types.js`, `registry/imports.js`, `native-strings.js` — no
  cycle), keep each god-file edit to a handful of lines, and add to this
  issue's frontmatter in the implementation PR:
  ```yaml
  loc-budget-allow:
    - src/codegen/object-runtime.ts
    - src/codegen/closure-exports.ts
    - src/codegen/expressions/call-identifier.ts
  ```
  Note: `pnpm run check:loc-budget` **already fails on current main**
  (`src/codegen/array-methods.ts: 9829 > 9805`) — that is pre-existing, not
  yours.
- **Late-import order (issue step 5, #1858/#2611)**: S1/S2 add no imports
  (defined funcs + a native-string constant only). S3's `>10` path calls
  `ensureHostCallFallbackImports` then must `flushLateImportShifts(ctx, fctx)`
  **before** `ctx.funcMap.get(plan.importName)`, exactly as the #4527 code does
  at `:2745-2752` and as `hostCallableFallbackTerminal` does at
  `closure-exports.ts:1023`.
- **Issue status**: this is a self-merge path — the implementation PR sets
  `status: done` directly, not `in-review`.

### 6. Edge cases and failure modes

| Case | Required behaviour | Risk if mishandled |
|---|---|---|
| Callable `$__bound_fn` / `$Proxy` / `$__ta_ctor` / runtime-eval carrier reaching the S2 terminal | must NOT throw | false `TypeError`; regresses `#3031`, `#3140`, `#3177` suites — this is why S2 is gated on `__typeof_function` + a `$Proxy` exclusion, not unconditional |
| Native-proto method closures (`buildTransferredNativeProtoCallInstrs`) | must NOT throw | they are dispatched INSIDE `__call_fn_method_N`, after the arms; the S2 guard must sit at the terminal, never as a front gate on `__apply_closure` |
| Proxy-revoker arm (`object-runtime.ts:7098`) | keeps returning `undefined` | its `undefinedSentinel()` is a real result, not a fallback — must not be swept into `notDispatched()` |
| **Nullish** callee (`f = null; f(2)`) | TypeError, but the callee-resolution guards (#4221/#4640/#4656) fire *before* argument evaluation where they can prove it statically | S1's throw is after arg evaluation; correct for a *non-nullish* non-callable per §13.3.6.1, and the static guards keep priority. Do not relax `tryEmitNullishIdentifierCalleeTypeError` |
| Arity > 8 on a genuinely callable value, standalone | loud, not vacuous | S1's `armUnsupported` throw makes it explicit; N5/N6 confirm arity 9/10 already work via the inline candidate arm, so this is a narrow path |
| Void / statement-position dynamic call | arms must still leave the declared block result | S1/S2 keep the trailing `ref.null.extern`; verify with `check:stack-balance` |
| `--target wasi` | identical to standalone | every gate here is `ctx.standalone || ctx.wasi`; `hostCallableFallbackTerminal:1015` already treats them alike |
| Host lane, `noJsHost` policy | unchanged degradation | out of scope; covered by S4 telemetry |

### 7. Adjacent finding — spread args are silently DROPPED (file separately)

Not #3406 (it returns a value, it does not null out), but the same
silent-miscompile family and found while verifying:

```
host: export function test(f:any){ const a:any=[1,2]; return f(...a); }   → callee invoked with 0 args
host: export function test(f:any){ const a:any=[2,3]; return f(1,...a); } → callee invoked with 1 arg
```
Both with and without closure candidates. Cause: the #4527 bridge declines on
spread (`call-identifier.ts:2699`) and the inline dispatch marshals only
positional `argLocals`. Fixing it needs a variadic host bridge / vec-building
path, which is a different shape of change. **File as a new issue via
`node scripts/claim-issue.mjs --allocate --by ttraenkler/<agent>`; do not fold
it into this slice** (issue Scope: "Do not broaden unrelated … dispatch in the
same slice").

### 8. Test plan

**Existing coverage to keep green** (these are the regression surface):
`tests/issue-4527-call-dyn-bridge.test.ts`, `tests/issue-4527.test.ts`,
`tests/issue-2939.test.ts`, `tests/issue-2940.test.ts`,
`tests/issue-3031-proxy-apply.test.ts`, `tests/issue-3140.test.ts`,
`tests/issue-3140-stored-bound-carrier.test.ts`, `tests/issue-3177.test.ts`,
`tests/issue-2174-async-closure-dynamic-call.test.ts`,
`tests/equivalence.test.ts`.

**New: `tests/issue-3406.test.ts`.** Two harnesses in one file, mirroring
`tests/issue-2939.test.ts` (standalone: assert `env` imports are `[]`) and
`tests/call-arg-type-coercion.test.ts` (host: `buildImports`). Every case
asserts `WebAssembly.validate(binary)`.

Host lane:
1. zero candidates, `f(2)` → `3`, spy called exactly once with `[2]` (guards
   the #4527 fix against regression — this is the issue's own repro).
2. zero candidates, **11** and **12** args → callee invoked once with all args,
   result correct. *Currently returns `null` with the spy never called.*
3. 11 args, non-callable → catchable `TypeError`, arguments still evaluated.
4. side-effectful argument at 11 args (`f(bump(1),2,…,11)`) → `bump` runs
   exactly once, before the throw/call.
5. statement-position `f(7); return 9` at arity 11 → spy called, result `9`.

Standalone (and one WASI repeat of case 6):
6. opaque non-callable, **zero** candidates, `try/catch` → `e instanceof
   TypeError`. *Currently the catch never runs.*
7. opaque non-callable, **one arity-matching** candidate → same (exercises the
   S2 terminal at `closure-exports.ts:1228`).
8. opaque non-callable, **one arity-MISMATCHED** candidate (closure arity 3,
   call arity 1) → same (exercises `buildArm`'s no-dispatcher terminal at
   `object-runtime.ts:6946`). Cases 7 and 8 are different code paths — verified
   by `__call_fn_method_1` being present in 7 and absent in 8; both must be in
   the suite or one regresses invisibly.
9. opaque `null` / `{}` / `"s"` callee → catchable `TypeError` each.
10. opaque **callable** (`n>0 ? g : 42` with `g` taken) at arities 1, 3, 9, 10
    → invoked, correct result, no throw. This is the false-positive guard for
    S2 — it must fail loudly if `__typeof_function` under-reports.
11. `Function.prototype.bind` carrier and a callable `Proxy` invoked
    dynamically → invoked, **no** throw (the S2 exclusion set).
12. argument evaluation order on the throw path: `c` incremented by a
    side-effectful arg, then TypeError caught, `c === 1`.

**Gates:** `pnpm run typecheck`, `pnpm run check:stack-balance`,
`pnpm run check:codegen-fallbacks` (expect the new `null-fallback` site;
`--update` and commit the baseline), `pnpm run check:loc-budget` (expect the
pre-existing `array-methods.ts` failure only, plus the `loc-budget-allow:`
grant above), `pnpm run check:ir-fallbacks`.

**Conformance:** CI's `merge_group` shard matrix is the real signal (PR-level
`check for test262 regressions` is a designed no-op). Expect movement in the
`TypeError`, callback-vacuity, `Function.prototype.call/apply`, Promise and
TypedArray-harness buckets. Per the issue's own Risks: a vacuous pass that
becomes an honest failure is a **behaviour correction** — record it in the PR,
do not restore the silent no-op. If the merge group parks the PR
(`auto-park-bot:merge-group-failure`), diagnose the cited run and pull the
regressed-test delta before doing anything with the `hold` label.
