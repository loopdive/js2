---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
assignee: ttraenkler/cs-2160
sprint: 65
created: 2026-06-15
updated: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: string-number
goal: standalone-mode
parent: 1470
depends_on: [1917, 2104]
---

# Standalone String/Number method & coercion conformance residual

## Problem

Wasm-native string methods and standalone number formatting landed in #1470,
#1335, #1105 (all `done`, sprints 58–61). The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **635 tests pass in host mode but
fail standalone**, attributed to String/Number method and coercion residuals.

## Evidence

- Gap categories: `built-ins/String` (643), `built-ins/Number` (159),
  plus String/Number coercion in `language/expressions`.
- Partly overlaps the coercion engine (#1917) and value-rep boxing
  (#2072/#2104) work — `__new_String`/`__new_Number` wrapper boxing leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/String` + `built-ins/Number` rises
  toward host parity.
- No `__new_String`/`__new_Number` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1470. Sequenced after the coercion engine (#1917) and
value-rep P1 (#2104). Part of sprint-62 standalone catch-up (rank 4 by gap
impact).

---

## Progress (2026-06-16, dev3) — `Number.parseInt`/`Number.parseFloat` slice

**Status stays `ready`** — this is one independent slice of the 635-test
bucket, landable now (not gated on #1917/#2104).

Re-measured against `origin/main` @ `5634b13ec`: the common String/Number
methods + coercion already pass standalone (padStart/padEnd/repeat/trim/
includes/startsWith/endsWith/at/codePointAt/replaceAll; toFixed/toPrecision/
toExponential/toString(radix); Number.isInteger/isNaN/isFinite/isSafeInteger;
bare parseInt/parseFloat; `+str`/`str*num`/`str+num` coercion; template
literals; String(num); `-0`/NaN/1e21 formatting). Many were closed by the
value-rep P0/P1 work that just landed.

**One concrete independent bug fixed (this PR):** `Number.parseInt` /
`Number.parseFloat` (the §21.1.2.12-13 namespaced aliases — same functions as
the globals) failed to compile in standalone with a `__get_builtin` codegen
error, while the bare `parseInt`/`parseFloat` worked. Root cause: the parse
import-collector (`src/codegen/declarations.ts`) only recognized the _bare
identifier_ call form, so the `Number.`-prefixed property-access form never
registered the native WasmGC scanner; the call-site routing
(`calls.ts`, which reads `funcMap.get("parseInt"/"parseFloat")`) then fell
through to the dynamic-shape `__get_builtin` refusal. Fix: detect the
`Number.parseInt`/`Number.parseFloat` call shape in the collector and add the
same helper to `parseNeeded`. Regression test:
`tests/issue-2160-number-parse.test.ts` (8 cases × host/standalone).

**Still open (the bulk of the 635):** the remaining residuals are the
**wrapper objects** `new String(...)` / `new Number(...)` (standalone null-deref
/ wrong `valueOf` — gated on value-rep boxing #2072/#2104, and noted in the
acceptance criteria's `__new_String`/`__new_Number` leak) plus the harder
String/Number coercion edges that overlap the coercion engine (#1917). Those
remain the value-rep / #1917 territory called out in the original notes.

---

## Sub-slice (dev-strnum) — `substr` lowering for standalone (PR #1627)

`String.prototype.substr` (Annex B §B.2.2.1) was not lowered for native-strings
(standalone / WASI). `compileNativeStringMethodCall` (`src/codegen/string-ops.ts`)
handled `substring`/`slice` but had no `substr` branch, so the call fell through
and trapped with a null-pointer dereference. Fix: new `__str_substr(s, start,
length)` WasmGC helper (`src/codegen/native-strings.ts`) — `substr`'s 2nd arg is
a CHAR COUNT, negative `start` counts from end — delegating to `__str_substring`,
plus a `substr` dispatch branch. Verified standalone/WASI/gc.
Test: `tests/issue-2160-substr-standalone.test.ts`.

## Sub-slice (dev-strnum) — `String()` array→primitive coercion (PR #1640, String-only)

`String([1,2,3])` null-dereffed in standalone. **Root cause:** the `String()`
builtin handler (`src/codegen/expressions/calls.ts`, the `funcName === "String"`
block) routes a ref/array argument through the generic `coerceType` ref→string
path, which has no array case — arrays aren't classes with `valueOf`/`@@toPrimitive`
funcMap entries, so it null-derefs. `[1,2,3].toString()` already lowers natively
via `compileArrayJoinNative`. **Fix (additive, no shared-coercion-engine change):**
a `tryEmitArrayToStringNative` helper synthesizes `arg.toString()` and dispatches
through `compileArrayMethodCall` BEFORE the coerceType fall-through. Covers
numeric/string arrays + empty typed arrays; **boolean-element arrays are
intentionally skipped** (the join path packs them i8 and synthetic-dispatch
element-type resolution diverges — they fall through with no regression).
Verified standalone/WASI; gc/host mode untouched (guard is `nativeStrings`-only).
Test: `tests/issue-2160-array-coercion-standalone.test.ts`.

**`Number(array)` deferred to senior-dev/engine:** the `Number(arr)` half
(ToNumber(ToString(arr)) per §7.1.4 → §7.1.1.1) must route string→number through
the **#1917 single coercion engine**, not a hand-rolled `__str_to_number` call
site — the Coercion-site drift gate (#2108) rejects a new ad-hoc site (18→19).
Tracked separately as a senior-dev task.

---

## Senior-dev slice (2026-06-18, sdev-proxy3) — `Number(array)` coercion

**Landed.** The `Number(arr)` half deferred by PR #1640 (the String-only array
coercion). `Number(arr)` is §7.1.4 ToNumber → §7.1.1.1 ToPrimitive(no hint) on an
Array → `arr.toString()` → §7.1.4.1 StringToNumber. Standalone has no host
`__unbox_number` and the generic struct-ToPrimitive path has no array case, so
`Number([5])` / `Number([42])*2` / `Number(["7"])` all silently yielded NaN.

**Fix (no new coercion site — respects the #2108 drift gate):** in the
`Number()` handler (`expressions/calls.ts`), reuse the two EXISTING sanctioned
lowerings — `tryEmitArrayToStringNative` (PR #1640's array→native-string) to get
the string ref, then the **existing** `__str_to_number` engine helper. The
string-ref `Number(str)` arm and the new array arm now share a single
`emitStrRefToNumber` closure holding the ONE `__str_to_number` call, so the
coercion-sites gate count for calls.ts is unchanged (18→18). Standalone /
nativeStrings only; host mode keeps `__unbox_number`.

**Scope guard (pre-existing, NOT regressed):** a bare `Number([])` literal infers
`never[]`, which the native array-join mishandles exactly like the pre-existing
`String([])` / `[].toString()` bare-literal crash. The new path is gated on a
concrete (non-`never`) element type, so `Number([])` falls through to main's NaN
behaviour (no crash). A _typed_ empty array (`const a: number[] = []`) lowers
correctly → `""` → 0.

**Validation.** `tests/issue-2160-number-array-coercion.test.ts` (14/14):
single/multi/string-element/fractional/negative/zero arrays, arithmetic chains,
typed-empty → 0, multi-element → NaN, the bare-`[]` no-crash guard, and
non-array `Number()` no-regression. 35/35 across all four #2160 suites. tsc +
prettier + coercion-sites (#2108) + any-box gates clean. No host-import leak
(pure standalone). This closes the `Number(arr)` engine-routing residual; the
remaining #2160 bulk (wrapper objects `new String`/`new Number`) stays gated on
value-rep #2072/#2104.

---

## Slice (2026-06-18, cs-2160) — wrapper `.valueOf()` / `.toString()` primitive recovery

**Status stays `ready`** — one more independent slice of the 635-bucket. Now
that value-rep #2072/#2104 + the #1910 S2 native wrapper constructor/ToPrimitive
have landed, the foundation exists; this wires two broken consumers.

**Two root causes fixed:**

1. **`resolveWasmType` resolved a `String`-WRAPPER binding to `$AnyString`.**
   `isStringType` deliberately also matches the wrapper `String` (Object) type
   (for primitive-string method dispatch), and the `nativeStrings` string
   fast-path in `resolveWasmType` (`src/codegen/index.ts`) fired FIRST — so
   `const s = new String("x")` typed `s` as `$AnyString` (ref 6), the wrapper
   `$Object` externref was `ref.cast`-to-`$AnyString` on bind, failed, and `s`
   became **null**. Every downstream read then null-deref'd. Fix: gate that
   fast-path with `&& !isStringWrapperType(tsType)` so the wrapper falls through
   to the externref wrapper branch. `nativeStrings`-only; gc-mode untouched.

2. **`new String(x).valueOf()` leaked `env::__unbox_string`; `.toString()`
   trapped.** The wrapper accessor handler (`src/codegen/expressions/calls.ts`)
   recompiled the wrapper as a primitive ValType / called the host-only
   `__unbox_string`. Fix: in `ctx.standalone`, route String/Number wrapper
   `.valueOf()`/`.toString()` (0-arg) through the EXISTING native `__to_primitive`
   engine helper (#1910 S2 reads the FLAG_INTERNAL `[[PrimitiveValue]]` slot
   first, §7.1.1.1), then unbox the Number result to f64. No new coercion matrix
   — reuses the single engine (coercion-sites baseline bumped 18→20 for the two
   sanctioned `__to_primitive`/`__unbox_number` references in calls.ts).

**Scope guards / still open (NOT regressed):** `Number.prototype.toString(radix)`
falls through to the radix-aware lowering (slot is a boxed number, not a string).
Boolean wrappers excluded (slot is `$__box_boolean_struct`, different extraction).
`.length`/full String-method dispatch on a wrapper receiver, and WASI wrapper
parity (native object-runtime is standalone-only), remain separate residuals.

**Validation.** `tests/issue-2160-wrapper-valueof-standalone.test.ts` (3/3):
String wrapper valueOf/toString (content via rolling hash, empty string,
chained method), Number wrapper valueOf (value/arith/compare), each asserting
NO `__unbox_string`/`__new_String`/`__new_Number` host-import leak under
`target: standalone`; plus a gc-mode no-regression guard. Regression suites
green: native-strings (128), issue-1910/1910-s2, issue-1397/1111 wrapper
equality, and all four prior #2160 suites (47). tsc + prettier + biome lint +
coercion-sites + any-box gates clean. (Pre-existing unrelated failures on main:
issue-929 accessor descriptor, imported-string-constants e2e, bigint-string —
all fail identically on pristine `origin/main`.)

---

## Slice (2026-06-21, sdev-tails) — String.prototype METHOD dispatch on a wrapper receiver

**Status stays `ready`** — closes the "full String-method dispatch on a wrapper
receiver" residual the cs-2160 slice above explicitly left open. Re-probed
against current main (post-keystone #2187/#2576/#2579): nearly the entire common
String/Number method + coercion surface now passes standalone (charAt/slice/
toUpperCase/padStart/trim/split/at/codePointAt/normalize/localeCompare/matchAll/
toFixed/toPrecision/toString(radix)/Number.\* on PRIMITIVE strings; wrapper
`.length`/`[i]`/`.valueOf()`/`.toString()`). The genuinely-open in-lane residual
was **every String.prototype METHOD on a `new String(x)` WRAPPER receiver**.

**Root cause** (`src/codegen/expressions/calls.ts`, the native-string method
dispatch at the `isStringType(receiverType)` arm): `isStringType` deliberately
also matches the String _wrapper_ Object type (so primitive-string methods can
dispatch). A wrapper reaching `compileNativeStringMethodCall` had its receiver
emitted by `compileExpression(propAccess.expression)` → the wrapper's `$Object`
externref → `__str_flatten`'s `ref.cast $NativeString` → **runtime trap**
("illegal cast" / "null pointer dereference") for `charAt`/`slice`/`indexOf`/
`toUpperCase`/`includes`/… — the whole wrapper-method surface was unusable
standalone (it worked in host/gc via the dynamic object path).

**Fix (no new hand-rolled coercion — reuses the §7.1.1.1 engine helper):**

1. In the native-string dispatch (calls.ts), for a `ctx.standalone` String-
   wrapper receiver (excluding `toString`/`valueOf`, which keep their existing
   arms), pass `compileNativeStringMethodCall` a **`receiverOverride`** that
   recovers the wrapped primitive via the EXISTING `__to_primitive(hint
"string")` helper (reads the wrapper's FLAG_INTERNAL `[[PrimitiveValue]]`
   slot first — same helper the cs-2160 valueOf slice uses), then
   `any.convert_extern` + `ref.cast $AnyString` back to a native string ref.
2. The five two-string-arg arms (`indexOf`/`lastIndexOf`/`includes`/
   `startsWith`/`endsWith`) stored the receiver via
   `compileStringValueToLocal(propAccess.expression, …)`, which **bypassed**
   `emitReceiver()`/the override. Added a `compileReceiverToLocal` helper
   (`src/codegen/string-ops.ts`) routing the receiver through `emitReceiver()`
   so the override applies there too.

The coercion-sites baseline (#2108) for calls.ts is bumped 21→23 for the two
sanctioned `__to_primitive` references — the SAME engine helper, no new matrix.

**Still open (NOT regressed):** `Number.prototype` method dispatch on a `new
Number(x)` wrapper receiver (slot is a boxed number; orthogonal extraction),
WASI wrapper parity (native object-runtime is standalone-only). String
`.replace(fn)` is the standalone RegExp engine's residual (#2161 lane). The
inline `Array.from(new Set(...))`-expression → 0 and `[...m.entries()]` Map-
entries-spread residuals are #2162 `$Vec`-dispatch territory (architect #24
lane), documented below in the report — not folded here.

**Validation.** `tests/issue-2160-wrapper-strmethod-standalone.test.ts` (2/2,
22 wrapper-method cases × standalone + gc): charAt/charCodeAt/at/toUpperCase/
toLowerCase/slice/substring/indexOf(hit+miss)/lastIndexOf/includes/startsWith/
endsWith/repeat/padStart/trim/concat/split/chained, inline and via a wrapper
local, each asserting NO `__unbox_string`/`__new_String`/`__extern_*`/
`wasm:js-string` host-import leak under `target: standalone`; plus a gc-mode
no-regression guard. Regression suites green: native-strings (110),
issue-1910-string-wrapper-index/1910-s2/1397 (23), issue-2192b caught-error
string methods, all prior #2160 suites (37/38 — the 1 pre-existing
`Number(arr)` failure fails identically on pristine `origin/main`). tsc +
prettier + biome lint + coercion-sites + any-box + stack-balance gates clean.

## Slice (2026-06-21, sdev-vrep) — Number.prototype METHOD dispatch on a wrapper receiver (PR sibling)

Direct mirror of the String-wrapper slice above, for `new Number(x)`.

**Symptom (standalone).** `new Number(3.14159).toFixed(2)` returned a null
string (and `.length`/`.charCodeAt` on the result TRAPPED "dereferencing a null
pointer"); `new Number(255).toString(16)` returned the wrong value.
`.toString()` (no radix), `.toLocaleString()` and `.valueOf()` already worked
(no-radix toString went through the broadly-registered `number_toString`; valueOf
via the cs-2160 slice).

**Root cause (two parts).**

1. The numeric method arms in `calls.ts` (`toFixed` / `toString` / `toPrecision`
   / `toExponential` / `toLocaleString`) gate on `isNumberType(receiverType)`,
   which matches only the primitive (`TypeFlags.Number`) — NOT the wrapper
   (`TypeFlags.Object`, symbol "Number"). So a wrapper receiver never entered the
   numeric lowering; it fell through to a generic path.
2. The which-natives pre-pass (`declarations.ts`, drives `emitNativeNumberFormat`
   in standalone) keyed the same way, so `number_toFixed`/`toPrecision`/
   `toExponential` were never EMITTED for a program that only calls them on a
   wrapper → the call-site `funcMap.get` returned undefined → null result.

**Fix (no new coercion matrix).**

- `calls.ts`: new `isNumberMethodReceiver` (primitive OR standalone wrapper) gates
  the five numeric arms; new `emitNumberMethodReceiverF64` emits the receiver as
  f64 — primitive directly, or for a standalone wrapper via the existing §7.1.1.1
  `__to_primitive(hint "number")` engine helper → `__unbox_number` (the SAME
  recovery the cs-2160 `.valueOf()` slice uses). Each arm now calls the helper
  instead of inlining `compileExpression + i32→f64`.
- `declarations.ts` + `index.ts` which-natives scans: recognize a standalone
  Number-wrapper receiver so the native `number_*` helper is actually emitted.

Standalone-gated (`ctx.standalone`) — gc/host keep the live-mirror Proxy path,
WASI keeps the host object machinery (a bare `new Number(x)` already needs
`__new_Number` there; that wrapper-CONSTRUCTION-under-WASI residual is separate
and reproduces on pristine `origin/main`).

**Validation.** `tests/issue-2160-wrapper-nummethod-standalone.test.ts` (3/3, 16
wrapper-method cases × standalone + gc + a primitive-regression case):
toFixed(round/noarg/int/neg)/toString(radix 16/2/10/default)/toPrecision/
toExponential/toLocaleString/valueOf, inline and via a wrapper local, plus
RangeError-still-throws — each asserting ZERO `number_*`/`__new_Number`/
`__extern_*`/`wasm:js-string` host-import leak under `target: standalone`. #1878
String-wrapper suite + number-format / parse / toLocaleString suites green; tsc
clean.

**Still open (NOT regressed):** `new Number(x)` wrapper CONSTRUCTION under
`--target wasi` (requests `__new_Number`; standalone-only native object-runtime)
— a separate substrate residual reproducing on pristine `origin/main`.

---

## Re-measure + residual slicing (2026-06-22, architect) — sprint 65

Re-probed the **host-pass / standalone-fail** gap for `built-ins/String` +
`built-ins/Number` against current main `0451ee920` (every file run twice:
host-mode `runTest262File` vs `target: "standalone"`; the host-pass /
standalone-fail set is the umbrella's definition). Result: **148 gap rows, all in
`built-ins/String`** — `built-ins/Number` has **no** remaining host/standalone gap
(the wrapper + native-format slices above closed it). The original "635 / 643 / 159"
numbers were the 2026-06-15 baseline; the value-rep keystones (#2187/#2576/#2579)
+ the wrapper slices have since closed the bulk.

### Verified root-cause buckets of the 148

| bucket | rows | disposition |
|---|---:|---|
| **search-method arg ToString + IsRegExp** (`indexOf/lastIndexOf/includes/startsWith/endsWith/localeCompare`, TYPED receiver, non-string arg → `__str_flatten` null-deref) | ~20–28 | **#2598** (dev) |
| **concat arg ToString** (variadic + non-string-primitive, TYPED receiver → `__str_concat` null-deref / `undefined`) | ~6–10 | **#2599** (dev) |
| **index/position ToIntegerOrInfinity** (`at/charAt/charCodeAt/codePointAt/indexOf` position, fractional-string/object arg → wrong index) | ~6–12 | **#2600** (dev) |
| **fromCodePoint RangeError** (non-integral / out-of-[0,0x10FFFF] → must throw) | ~2–3 | **#2601** (dev) |
| `match`/`matchAll`/`search` (RegExp-routed) | 15 | → **#2161** standalone RegExp engine |
| **RequireObjectCoercible `this`** via `.call(null/undef/symbol)` + **boxed/dynamic `this`** (`new Boolean; o.indexOf=…`, `_A1_T2`/`_A4_T*`) | ~25 | → **#2580 M2** (any-typed receiver) |
| builtin-method-**as-value** (`String.prototype.X.length`, `new X`, `.name`, callback) — `built-in static property value read … not supported` / `__get_builtin` CE | ~8 | → builtin-closure substrate (not method correctness) |
| object→primitive (`Cannot convert object to primitive value`) for `String()`/concat with a dynamic-object arg/receiver | ~18 | → **#1917** coercion engine (already the engine path) |

### The M2-deferred note (per #2580)

Everything where the **receiver is `any`/dynamic/boxed** is **#2580 M2 territory**
(any-typed string/number method dispatch + coercion-on-any), NOT a #2160 slice.
That is: `String.prototype.X.call(null/undefined, …)` (RequireObjectCoercible on a
dynamic receiver), `new Boolean/Number/String; o.method = String.prototype.X; o.X(…)`
(boxed-primitive receiver), and any `obj.method()` where `obj: any`. #2580's M1
canary already proved a bare-externref runtime test cannot disambiguate these
receivers — they need M2's tag-aware dynamic reader. The four #2598–#2601 slices are
deliberately gated on a **statically-typed string receiver**, so they are
substrate-INDEPENDENT and land independently of #2580.

### Slices created (sprint 65)

- **#2598** — search-method arg ToString + IsRegExp guard (largest bucket)
- **#2599** — concat arg ToString (variadic + non-string)
- **#2600** — index/position ToIntegerOrInfinity
- **#2601** — fromCodePoint RangeError

Each: ONE verified root cause, typed receiver (substrate-independent), reuses the
existing `coerceType` / `__str_to_number` engine (no new #2108 coercion site),
~1 day, full `## Implementation Plan` in its own file. #2598 + #2599 share the
"ToString an arbitrary arg before a native string helper" shape — whichever lands
first factors a small `emitArgAsNativeString` helper the other reuses (independently
landable either order).

**This umbrella stays `ready`** as the tracker; the actionable substrate-independent
String work is now the four child slices. The remaining residual is #2161 (RegExp),
#2580 M2 (dynamic receiver), #1917 (object→primitive), and the builtin-method-as-value
closure substrate — all tracked elsewhere.
