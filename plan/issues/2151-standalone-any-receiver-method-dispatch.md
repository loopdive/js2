---
id: 2151
title: "standalone: any-receiver method dispatch — o.method() on a closed object-literal struct doesn't invoke"
status: in-progress
sprint: 63
created: 2026-06-14
updated: 2026-06-14
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: methods, object-literals, dynamic-dispatch
goal: standalone-mode
related: [2015, 2038, 1888, 1320]
origin: "2026-06-14 #2038 investigation — the standalone analog of #2015 (which fixed only the JS-host any-receiver path)."
---

# #2151 — standalone any-receiver method dispatch (closed object-literal structs)

> Tracking-task name in the board: "#25". Filed as plan issue #2151 for the file.

## Problem

`const o: any = { next() { return 7 }; }; o.next()` returns **0** (should 7)
under both `--target standalone` AND `--target wasi`. Affects EVERY standalone
method call on an `any`/externref object-literal receiver. It is the standalone
analog of #2015 (which fixed only the JS-host proxy/closure dispatch).

Confirmed on main @ 2fecb7f92 (all return 0; expect 7 / 21 / 3):
- `const o:any={next(){return 7}};o.next()`
- `const o:any={x:21,getx(){return this.x}};o.getx()`
- `function mk(){let i=0;return{step(){i=i+1;return i}}};const o:any=mk();o.step();o.step();o.step()`

This is what makes #2038's USER_ITER carrier inert: `userIter.next()` (via the
any-method path) returns null → `done` never truthy → `__iterator_next`
infinite-loops.

## Root cause (WAT-confirmed)

The any-receiver method fallback (`src/codegen/expressions/calls.ts` ~`:7966`,
`isAnyOrExternref` block) routes to the native `__extern_method_call`
(`src/codegen/object-runtime.ts` ~`:4227`). That body is:

```wasm
local.get recv ; any.convert_extern
ref.test (ref $Object)          ;; the OPEN open-hash-map $Object type
(if (result externref)
  (then __apply_closure(__extern_get(recv,name), recv, args))   ;; open-object arm
  (else ref.null.extern))                                       ;; <-- closed structs land here
```

A standalone object literal `{ next(){…} }` compiles to a **closed nominal
WasmGC struct** (a distinct type with named method fields, methods stored as
closures + a sibling `<__anon_N>_<method>(structRef, …args)` func), NOT the open
`$Object`. So `ref.test $Object` is FALSE → else arm → `ref.null.extern`. The
method is never invoked. `__extern_get` has the same `$Object`-only gate, so even
field reads on closed structs return null.

Under `--target wasi` there is an ADDITIONAL failure: the any-method arg-array
build (`calls.ts` `:8068`) only takes the native `$ObjVec` builder branch when
`ctx.standalone`; under `ctx.wasi` it requests `env.__js_array_new` /
`__js_array_push`, which strict-no-host refuses → `arrNewIdx` undefined → the
null fallback at `:8136`. So wasi can't even reach `__extern_method_call`.

## Existing infra that already handles closed structs (verified at runtime)

- `emitMethodDispatch` (index.ts `:2190`) emits **name-specialized type-switch**
  dispatchers over every closed struct that has `<Struct>_<method>`:
  currently only `__call_@@iterator` / `__call_next`. Each does
  `ref.test S / ref.cast S / call S_<method>` and box-coerces the result.
  Runtime-verified: `__call_@@iterator(obj)` + `__call_next(it)` dispatch closed
  structs correctly and thread `this` (the struct is the method's first param).
- `emitStructFieldGetters` (index.ts `:1737`) emits `__sget_<field>` —
  name-specialized type-switch field getters over closed structs (handles
  `value`/`done`).
- `__apply_closure` (object-runtime.ts) threads `this` + args to a closure value.

These are emitted at **FINALIZE** (after all object-literal structs are known),
so a call-site reference to them is a forward reference → reserve-then-fill
(`fillApplyClosure` / `fillProtoIteratorDriver`, #1719) is the established
pattern.

## Fix plan

**Slice 1 (this PR) — generalize closed-struct method dispatch + wasi arg-vec:**
1. Generalize `emitMethodDispatch` to emit `__call_<method>` for EVERY distinct
   method name that appears on any closed object-literal struct (not just
   `@@iterator`/`next`), with **N-ary** support: the dispatcher takes
   `(recv, arg0..argK)` as externref, and for each candidate struct casts recv,
   coerces each externref arg to the method's declared param type, calls
   `S_<method>`, and box-coerces the result back to externref. Track the
   (methodName → max arity) set seen during object-literal compilation in a new
   `ctx.objectLiteralMethodArity: Map<string, number>` so finalize knows what to
   emit.
2. Route the any-receiver call site (`calls.ts` `:7966`) for
   `ctx.standalone || ctx.wasi`: BEFORE `__extern_method_call`, reserve+call the
   `__call_<method>` dispatcher (reserve-then-fill so the finalize-emitted funcidx
   resolves). Keep `__extern_method_call` as the open-`$Object` fallback inside
   the dispatcher's bottom arm (so open objects still work).
3. Make the arg-vec builder branch fire for `ctx.standalone || ctx.wasi` (not
   just `ctx.standalone`) at `:8068` and `emitWrapperDynamicMethodCall` `:1147`,
   so wasi stops requesting refused `__js_array_new`.

**Edge cases / invariants:**
- `this`: the struct IS the method's first param → `this.x` works for free.
- Captured mutable state: lives in module globals today (works for single
  instance; multi-instance aliasing is a separate pre-existing limitation,
  #2012-adjacent — NOT in scope here).
- No closed struct matches AND not open `$Object` ⇒ keep current behavior
  (undefined / refuse), never trap.
- Vec/array/string brands unaffected (gated on the method-name dispatcher set).
- Regression surface: ALL standalone object-literal method calls — validate the
  object-literal + iterator + generator suites byte-compatible, and run a
  scoped standalone test262 slice.

## Acceptance criteria
- The three repros above return 7 / 21 / 3 in standalone AND wasi.
- `__call_<method>` dispatchers dispatch closed structs and thread `this`.
- No regression in JS-host mode (gate strictly on `ctx.standalone || ctx.wasi`).
- Unblocks #2038's USER carrier (`userIter.next()` fires).

## Test files
- `tests/issue-2025.test.ts`: the three repros + a 1-arg method (`add(n)`),
  host/standalone/wasi parity.

## Slice 1 RESULT (2026-06-14, sdev3) — IMPLEMENTED & GREEN

Branch `standalone-any-method-dispatch` (commit 87a87ef93). Files:
- `src/codegen/closed-method-dispatch.ts` (new): `reserveClosedMethodDispatch` +
  `fillClosedMethodDispatch` (reserve-then-fill, #1719). Deps registered at
  reserve time (call site, mid-compile) so fill is read-only → no finalize index
  churn. Dispatcher `__call_m_<name>(recv)->externref`: type-switch over closed
  structs with `<Struct>_<name>` (1-param = 0-arg-after-`this`), `ref.cast` +
  `call` (struct = `this` param), box-coerce result; bottom arm =
  `__extern_method_call(recv, "<name>", __objvec_new())` for open `$Object`.
- `src/codegen/expressions/calls.ts`: any-receiver fallback (~`:7966`) — for
  `ctx.standalone||ctx.wasi` + 0 args + non-builtin-class receiver, reserve+call
  the dispatcher and return. (Runs after generator/extern-class checks, before
  the generic `__extern_method_call` block.)
- `src/codegen/index.ts`: `fillClosedMethodDispatch(ctx)` at finalize right after
  `fillApplyClosure` (`:1528`).
- `src/codegen/context/types.ts`: `closedMethodDispatchNames?: Set<string>`.

Verified standalone AND wasi: `o.next()`→7, `getx()` `this`→21, captured
`step()`×3→3, custom-iterable manual drive via any `.next()`→12 (the #2038
building block), class-instance via any→5. `tests/issue-2025.test.ts` 11/11.
NO regressions: object-methods 13/13, object-literals 21/21, generators 9/9,
for-of-generator 9/9, hasownproperty-call 7/7; host mode byte-unaffected (gated
`standalone||wasi`); tsc clean. Every other failure found (class-methods harness,
wasi-generator, Map.keys-via-any, method-with-arg→NaN) reproduces identically on
clean main — all PRE-EXISTING, not caused by this change.

**Scope note:** Slice 1 = 0-arg methods only. `o.add(5)` (N-ary) still NaN
(pre-existing) — Slice 2 generalizes the dispatcher to args (coerce each
externref arg to the method's declared param type per candidate). This PATH B
fix does NOT by itself fix #2038's carrier, which calls `__extern_method_call`
from a hand-written Wasm body (that needs PATH A — rewrite the carrier to use
the closed-struct dispatchers). PATH B is independently valuable for ALL
standalone object-literal method calls.

Status: ready to PR; held pending tech-lead go (#25 was marked DEFERRED epic —
sdev3 found the 0-arg slice is contained + green and recommends landing it).

## Slice 2 RESULT (2026-06-15, sdev5) — N-ary methods IMPLEMENTED & GREEN

Branch `issue-2151-nary-method`. Generalizes the Slice 1 dispatcher to methods
**with arguments**:
- `closed-method-dispatch.ts`: the dispatcher is now arity-specialized
  `__call_m_<name>_<arity>(recv, arg0..arg{arity-1})` (all externref). The fill
  side matches each candidate struct's `<Struct>_<name>` by `1 + arity` params,
  coerces each externref arg to the method's declared param type inline
  (`__unbox_number` for f64, `__unbox_boolean`/`__unbox_number`+trunc for i32,
  `any.convert_extern`+`ref.cast` for refs), threads the struct as `this`, calls,
  and box-coerces the result. The open-`$Object` fallback arm builds an `$ObjVec`
  of the args (`__objvec_new`/`__objvec_push`) for `__extern_method_call`.
- `calls.ts`: the any-receiver routing no longer gates on `arguments.length===0`
  — it reserves `__call_m_<name>_<arity>`, compiles the receiver + each arg to
  externref, and calls. Spread args still fall through to the generic path.

Verified standalone AND wasi, ZERO host imports: 1-arg `f(n)→n+4`=9, 2-arg
`g(a,b)→a*b+2`=14, 3-arg `h(a,b,c)`=6, `this`+arg `plus(n)→this.base+n`=25, and
the Slice 1 0-arg path (`next()`=7) intact. Test: `tests/issue-2151-nary.test.ts`
(6 cases). No regression: `issue-2151` 11/11, `object-methods` 13/13,
`object-literals` 21/21. Host mode unchanged (gated `standalone||wasi`).

**Still deferred (pre-existing, NOT this slice):**
- **Built-in-method-name collision**: `o.add(5)` / `o.push(x)` on an object
  literal route to the built-in `Set_add` / array fast-path BEFORE the
  any-receiver fallback (verified identical on main). Needs the static
  builtin-method fast-path to defer to the closed-struct dispatcher for `any`
  receivers — a separate precedence fix.
- **Host mode** any-method on a closed object literal (`o.f(5)` → "f is not a
  function") — pre-existing host limitation (verified on main), out of scope
  (this fix is gated on standalone/wasi).
- Spread-arg method calls (`o.m(...xs)`).

## Slice 3 RESULT (2026-06-17, dev-3) — spread-of-array-literal — IMPLEMENTED & GREEN

The any-receiver dispatch site (`calls.ts` ~`:8276`) previously bailed to the
generic host-import path whenever ANY arg was a spread, so `o.m(...[2,3])`
returned 0 standalone. A spread of an **array literal** has a
statically-known argument list, so it can use the same arity-specialized
dispatcher: the gate now runs `flattenCallArgs(expr.arguments)` (the existing
helper that expands `...[a,b]` into `a, b`, returning null for a dynamic
spread). When it returns a flat list, the dispatch arity + per-arg compilation
use that list; a dynamic spread (`o.m(...xs)`) still returns null → falls
through to the generic path (would need runtime variable-arity dispatch).

Re-validation on main also confirmed Slices 1–2 are landed and the previously
"deferred" **built-in-method-name collision** cases (`o.add(5)`→25,
`o.push(3)`→6) now pass too — only spread args remained.

### Test Results

- `tests/issue-2151-spread-literal.test.ts` — 5/5, zero host imports:
  two-element / `this`-threading / mixed `m(1, ...[2,3])` / single-element /
  empty `...[]`.
- No regression: `issue-2151-nary` + `issue-2025` + `object-methods` +
  `object-literals` — 46/46. Host mode unaffected (gated `standalone||wasi`).
  `npm run typecheck` + Biome lint clean (no warnings on edited lines).

### Still carried forward (issue stays in-progress)

- Dynamic-spread method calls `o.m(...xs)` (runtime variable-arity dispatch).
- Host-mode any-method on a closed object literal (pre-existing host limitation).
