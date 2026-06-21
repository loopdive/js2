---
id: 2151
title: "standalone: any-receiver method dispatch — o.method() on a closed object-literal struct doesn't invoke"
status: in-progress
sprint: 65
created: 2026-06-14
updated: 2026-06-17
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

## Slice 4 RESULT (2026-06-19, sen-1) — DYNAMIC-spread `o.m(...xs)` — IMPLEMENTED & GREEN

Dynamic-spread `o.m(...xs)` (arity unknown at compile time) returned 0 standalone
because `flattenCallArgs` returns null for a dynamic source → the fixed-arity
`__call_m_<name>_<arity>` dispatcher (Slices 1–3) cannot apply, and the generic
`__extern_method_call` fallback only handles the OPEN `$Object` receiver.

**Mechanism — a VARARG dispatcher, reusing the existing fill machinery.** New
`reserveClosedMethodDispatchVararg` + a vararg pass in `fillClosedMethodDispatch`
(`src/codegen/closed-method-dispatch.ts`) emit
`__call_m_<name>_vararg(recv: externref, args: externref) -> externref`. It
type-switches over the SAME closed structs as the fixed-arity dispatcher, but
sources each declared param from `__extern_get_idx(args, i)` (0..K-1, K = that
method's declared param count) instead of fixed dispatcher params — out-of-range
reads yield `undefined`. The per-struct arg-coerce + `this`-thread + result-box
logic is now factored into a shared `buildEntryArm(ci, anyLocal, entry, pushArg)`
helper (and struct collection into `collectMethodEntries`), so fixed-arity and
vararg are single-sourced. Bottom arm forwards the SAME `args` externref to
`__extern_method_call(recv, name, args)` for the open-`$Object` case. The call
site (`calls.ts`) routes a SINGLE pure dynamic spread `o.m(...xs)` to it,
compiling the spread source array directly as the `args` externref (the native
`__extern_get_idx` indexes both wasm vecs and `$ObjVec`).

**Verified standalone, ZERO host imports** (`tests/issue-2151-dynamic-spread.test.ts`,
6 cases): `o.m(...xs)`=5, `this`-thread `o.plus(...xs)`=13, 3-elem=321, 0-len
`o.n(...[])`=42, function-returned-array spread `o.g(...mk())`=20, plus the
Slice 1–3 regression guards (`next()`=7, static `o.m(...[2,3])`=5). No regression:
`issue-2151{,-nary,-spread-literal}` + `issue-2025` + `issue-2009` + generator
(expressions/methods/nested/return-method/yield-delegation) + for-of-generator
suites all pass. `tsc --noEmit` clean. (The one `object-literal-getters-setters >
setter stores value` FAIL is PRE-EXISTING on base — verified by stashing the src
change and re-running.)

**Scoped OUT (kept on the existing fall-through — same value as before, NO
regression):**
- **Mixed `o.m(a, ...xs)`** (fixed leading args + dynamic spread): needs a
  runtime arg-vec append-loop (push fixed args, then loop-append the spread
  source). Returns 0 today as before; carve as a follow-up slice.
- **`--target wasi`**: the `__extern_get_idx` array-like / wasm-vec indexing arms
  are emitted only under `ctx.standalone` (`objArrayLikeArms = ctx.standalone`,
  object-runtime.ts). So the vararg dispatcher is gated to `ctx.standalone` ONLY;
  wasi keeps the existing fall-through (the same pre-existing wasi arg-vec gap the
  issue's Root-cause section already notes). Widening the array-like arms to wasi
  is a separate, broader change.
- **ref/string-typed params** (`o.g("hi")`, `o.g(...["hi"])`): VERIFIED
  pre-existing across ALL slices — the fixed-arity `o.g("hi")` and static-spread
  `o.g(...["hi"])` both already fail on main (`Cannot convert object to primitive
  value`). A separate any-receiver ref-arg-coercion gap, not introduced or in
  scope here; the vararg path inherits it identically.

#2151 stays in-progress for the mixed-spread + wasi + ref-arg residuals above.

## Slice 5 RESULT (2026-06-21, sendev-funcidx) — MIXED-spread `o.m(a, ...xs)` — IMPLEMENTED & GREEN

Mixed `o.m(a, ...xs)` (fixed leading args + a single trailing DYNAMIC spread)
returned 0 standalone: the fixed-arity `__call_m_<name>_<arity>` dispatcher
can't apply (`flattenCallArgs` returns null for a dynamic source) and the Slice 4
pure-dynamic-spread vararg routing only fires for a single spread arg with NO
fixed leading args.

**Mechanism — build the combined arg vec at runtime, reuse the Slice 4 vararg
dispatcher.** New routing in `src/codegen/expressions/calls.ts` (after the Slice 4
`isSingleDynamicSpread` block): for `ctx.standalone`, a non-builtin-class
receiver, `>= 2` args, exactly ONE spread which is the LAST arg
(`isMixedTrailingSpread`), it
1. reserves `__call_m_<name>_vararg` (the Slice 4 dispatcher) + pulls in
   `__objvec_new`/`__objvec_push` + `__extern_length`/`__extern_get_idx`, then
   `flushLateImportShifts` and **re-resolves every funcIdx by name** (the
   `ensureLateImport`s shift defined-func indices incl. the just-reserved
   dispatcher — #2043 late-import index-shift class);
2. stashes the receiver in a local, builds `combined = __objvec_new()`, pushes
   each fixed leading arg (boxed to externref), then loop-appends the spread
   source's elements (`__extern_length` + `__extern_get_idx(src, i)` →
   `__objvec_push`);
3. calls `__call_m_<name>_vararg(recv, combined)` — the dispatcher reads each
   declared param from the vec via `__extern_get_idx` (`$ObjVec` is exactly what
   it indexes), threads the struct as `this`, coerces per declared param type,
   and box-coerces the result.

**Verified standalone, ZERO host imports** (`tests/issue-2151-mixed-spread.test.ts`,
6 cases): `o.m(1, ...xs)`=123, two-fixed + `this`-thread `o.f(1,2,...xs)`=16,
empty spread `o.m(5, ...[])`=50 (trailing numeric param reads 0 = missing-arg
semantics, consistent with the typed-param model across all slices),
function-returned-array spread `o.m(1, ...mk())`=132, zero-host-imports assertion,
plus the Slice 1–4 regression guards (`next()`=7, static `o.m(...[2,3])`=23, pure
dynamic `o.m(...xs)`=45). No regression: `issue-2151{,-nary,-spread-literal,
-dynamic-spread}` + `issue-2025` (34/34), `object-methods` + `object-literals` +
`issue-2009` (61/61). `pnpm run typecheck` + `format:check` + `lint` clean.

**Still carried forward (issue stays in-progress):**
- **`--target wasi`** (same gate as Slice 4 — array-like `__extern_get_idx` arms
  are standalone-only; mixed-spread is gated `ctx.standalone`).
- **ref/string-typed params** (`o.g("hi")`) — pre-existing any-receiver
  ref-arg-coercion gap inherited identically.
- Multiple spreads / leading-or-middle spread (`o.m(...xs, a)`, `o.m(...a, ...b)`)
  — uncommon shapes, keep the existing fall-through (no regression).
