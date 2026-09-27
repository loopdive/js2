---
id: 6614
title: "standalone: an object literal with a `get`/`set` accessor is NULL-DROPPED when it crosses a function's RETURN slot — the existing widening reaches only a source-file-level `function` declaration, so every other spelling (method, arrow, function expression, class method, nested function) traps"
status: done
completed: 2026-09-15
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s27-lane
created: 2026-09-15
loc-budget-allow:
  # 2026-09-15 (#6614): INHERITED red, restated here — not growth this change
  # made. This PR touches only `src/codegen/**` (+ this issue file, one test and
  # one boundary-inventory entry); `src/runtime.ts` measures 19,822 against a
  # 19,601 ceiling under `LOC_GATE_BASE=origin/main` because main's post-merge
  # baseline refresh has not caught up with an earlier slice's landed growth.
  # The grant lives in an issue file this PR does not modify, so CI's
  # merge-preview base would report it as a STRANDED grant and fail `quality`
  # (the #6612/#6613 precedent). Restated verbatim rather than fixed:
  # re-splitting `runtime.ts` is not this slice's work, and lowering the number
  # by editing the baseline is forbidden (main is its sole writer, #3131).
  - src/runtime.ts
func-budget-allow:
  # 2026-09-15 (#6614): same inherited red, same rationale — `buildImports` is
  # 308 against a 300 ceiling under `LOC_GATE_BASE=origin/main`. Untouched by
  # this PR.
  - src/runtime.ts::buildImports
oracle-ratchet-allow:
  # 2026-09-15 (#6614): ONE `checker.getTypeAtLocation(call)` in the new module
  # `src/codegen/accessor-literal-return-carrier.ts`. The question is raw
  # `ts.Type` IDENTITY: `ctx.objectHashConsumerTypes` is a `Set<ts.Type>` keyed
  # by object identity, and `resolveWasmType` consults it to pick a ValType.
  # That is a wasm-LOWERING question, deliberately ABOVE what the oracle's
  # registry-free `TypeFact`s can express (they carry no identity token that
  # `resolveWasmType` could key on). It is also load-bearing rather than
  # cosmetic: the declaration's return type and a CLASS-METHOD call site's
  # resolved type are two different `ts.Type` objects that both print
  # `{ readonly g: any; }`, so registering only the declaration's left
  # `new C().mk()` on the closed-struct slot while `C_mk` already returned
  # externref — measured, and the reason case 6 of the reduction stayed broken
  # until this consult was added. Mirrors the identical consult in
  # `declarations/object-shape-widening.ts::collectDynamicObjectReturnCarrierTypes`.
  - src/codegen/accessor-literal-return-carrier.ts
---

## Problem

Under `--target standalone` (and WASI), an object literal carrying a `get`/`set`
accessor is **silently replaced by null** when it crosses a function's RETURN
slot. Three lines, one module, no Temporal, no provider, no link:

```js
const M = { mk(pv) { return { get g() { return pv; } }; } };
const r = M.mk(5);
r.g;   // TypeError: Cannot access property on null or undefined
       // spec, and the JS-host/WasmGC lane: 5
```

`compileObjectLiteralWithAccessors` builds such a literal as a HOST object —
`__new_plain_object` + `__defineProperty_accessor`, an externref — never as a
WasmGC struct. The checker types the enclosing function's return as the
anonymous shape the accessor's return type implies (`{ readonly g: number }`),
so the RECEIVING binding is laid out as `(ref null $__anon_N)`. The store guard
(`ref.test $__anon_N` against a host object) always fails, `ref.null` is
written, and the first read is a `struct.get` on null.

Disassembled (`wasm-dis`, this tree, base), the receiving global and its read:

```wat
(global $global$10 (mut (ref null $27)) (ref.null none))   ;; r — a CLOSED struct
…
(struct.get $27 0 (local.get $0))                          ;; r.g — on the null
```

against the same source with the one working spelling, where the global is
`externref` and the read goes through the dynamic MOP.

## Why the existing widening did not catch it

The tree already owns exactly this rule.
`declarations.ts::functionReturnsHostObjectLiteralCarrier` detects a function
whose returned value is an object literal the literal compiler must represent as
a host object, and puts its return type into `ctx.objectHashConsumerTypes` —
which `resolveWasmType` answers `externref` for.

It is reached from two call sites, **both of which take a
`ts.FunctionDeclaration`**, and both of which walk only source-file-level
statements. So the rule fired for exactly one spelling of the function:

| spelling | before | after |
| --- | --- | --- |
| top-level `function mk() { … }` | **correct** | correct |
| `const mk = function () { … }` | trap | correct |
| `const mk = () => ({ … })` | trap | correct |
| `{ mk() { … } }` object-literal method | trap | correct |
| `class C { mk() { … } }` | trap | correct |
| `function` NESTED in another function | trap | correct |
| IIFE | trap | correct |

The one spelling that worked is the one a hand-written reduction reaches for
first, which is why this survived: a probe written as a top-level
`function mk()` passes on both trees and asserts nothing.

`TemporalHelpers.toPrimitiveObserver` is the object-literal-METHOD row. Its
observer therefore arrived at the polyfill as `null`, which is why #5383's
`infinity-throws-rangeerror.js` and `overflow-wrong-type.js` families reported
the observer's `calls` array EMPTY with the getter never invoked.

## Fix

`src/codegen/accessor-literal-return-carrier.ts` — a new pre-pass,
standalone/WASI-gated, driven from `src/codegen/index.ts` at the same
deterministic point as `collectDynamicObjectReturnCarrierTypes` (before
`collectDeclarations`, so before any binding is typed or any body compiles), in
both the single-source and the multi-source path.

It mirrors `functionReturnsHostObjectLiteralCarrier`'s body scan — direct
return, return of a local bound to such a literal, either arm of a conditional,
and a concise arrow body — for every function-LIKE node, and registers the
signature's return type. It then registers the **call-site** type for calls
resolving to one of those declarations; see the `oracle-ratchet-allow` rationale
above for why that second step is not redundant.

Two scope decisions, both deliberate:

- **Accessor literals only**, the same narrowing #5376 made for the struct-FIELD
  twin of this defect. The other `objectLiteralForcesHostPath` reasons (runtime
  computed key, `[Symbol.dispose]`, empty-string key, spread in a non-specific
  context) share the null-drop mechanism and are a separate, separately-measured
  change. The existing FunctionDeclaration arm keeps its broader predicate; this
  pre-pass is purely additive.
- **Standalone / WASI only.** The JS-host lane represents every object as an
  externref already, so all seven spellings above answer correctly there —
  measured, on the same probe file — and its bytes must not move.

## Residuals — found by this slice's reduction, NOT fixed here

**1. `o.valueOf()` as a DIRECT call answers the receiver, not the getter's
function.** Lane-INDEPENDENT — the JS-host/WasmGC lane gives the same wrong
answer, so it is out of a standalone-only slice and its fix would move gc bytes.

```js
const o = { get valueOf() { return function () { return 11; }; } };
o.valueOf();                              // "[object Object]"   spec: 11
(function () { var f = o.valueOf; return f(); })();   // 11      — correct
```

Name-specific: `o.toString()`, `o.zz()` and `o.f()` all answer correctly with
the identical shape, and a DATA-property or METHOD `valueOf` answers correctly
too. So a `valueOf` call fast path is consulting the receiver's builtin without
first asking whether the own property is an accessor. No row in the current
#5383 buckets depends on it.

**2. The reverse peer GET does not dispatch an ACCESSOR.** A provider reading
`o.g` off a consumer-built object receives `undefined` where the consumer
installed a getter; the DATA-property twin reads back correctly. Measured on
BOTH trees with a TOP-LEVEL accessor literal — a spelling that already worked
locally before this change — which is what pins the residual to the reverse
channel rather than to the return slot this issue fixes. Pinned as an
expectation in `tests/issue-6614-accessor-literal-return-carrier.test.ts` so it
cannot rot silently.

**3. `ZonedDateTime/prototype/add/overflow-wrong-type.js`** clears this defect
and lands on a BigInt one: `assert.sameValue(result.epochNanoseconds,
1_000_086_400_987_654_321n)` renders the expected value as `[object Object]n`
and the actual as `865167537,931403041`. Unrelated to accessors.

## Acceptance

Criterion 4 of #5383 — see the "S27 findings" section of
`plan/issues/5383-standalone-temporal-provider.md` for the four-family sample,
the must-not-move controls, the byte A/B and the equivalence-gate number.
