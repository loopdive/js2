---
id: 2158
title: "Standalone class/prototype/private-name/descriptor conformance residual (~1,388 tests)"
status: in-progress
assignee: ttraenkler/cs-2158
sprint: 64
created: 2026-06-15
updated: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: classes
goal: standalone-mode
parent: 1591
depends_on: [2101, 1965]
---

# Standalone class/prototype/descriptor conformance residual

## Problem

Class elements, private fields, brand checks, and descriptor fidelity landed
in #1591, #1365, #1364 (all `done`, sprints 51–61). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **1,388 tests pass in host
mode but fail standalone**, attributed to the class/prototype/private-name/
descriptor object model — the second-largest catch-up bucket.

## Evidence

- Concentrated in `built-ins/Object` (compile-error heavy) and class
  language tests; `dynamic_object_property` leaks plus `(none)`-leak compile
  errors in the object model.
- Implementation should consume the #2101 class object-model architecture
  spec and the #1965 base-constructor execution fix.

## Acceptance criteria

- Standalone pass count for `built-ins/Object` + class language tests rises
  toward host parity.
- Descriptor/private-name/brand-check semantics match host mode standalone.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1591. Implements against spec #2101; depends on #1965.
Part of sprint-62 standalone catch-up (rank 2 by gap impact).

## Implementation notes — slice 1 (2026-06-16, sd1)

This 1,388-test gap is a multi-PR epic (spec #2101 phases P0–P4). This slice
lands the two highest-leverage, host-free defects, both diagnosed by WAT-tracing
`--target standalone` repros. The remaining standalone reflection readers
(`Object.getOwnPropertyNames`/`getOwnPropertyDescriptor`/`Object.keys` on class
objects — still hard-errors `#1472 Phase B` in standalone) and `new.target`
(#2023, P2) / dynamic `new K()` (#2026, P3) stay open for follow-up slices.

### Defect 1 — `.constructor` identity returns false in standalone (spec #2101 P1)

`new A().constructor` lowered to `ref.func ${A}_constructor` + `extern.convert_any`
(`property-access.ts` instance `.constructor` arm) — a funcref-as-externref.
But the class identifier `A` resolves to the `__class_<Name>` singleton struct
(`emitLazyClassObjectGet`, via identifiers.ts). So `new A().constructor === A`
compared two different externrefs → always false. **Fix:** route instance
`.constructor` through the SAME `emitLazyClassObjectGet(typeName)` singleton, so
both sides of the `===` are reference-identical. Host-free, so it fixes the
identity in standalone AND host mode. Falls back to the constructor funcref only
when no class-object global exists (externref-backed builtin subclasses).

### Defect 2 — empty-subclass `===` / `typeof` crash with `illegal cast` (#2009)

WAT-traced root cause: an EMPTY class root struct is exactly
`(struct (field $__tag i32))`. The native-string supertype `$AnyString` is also
a single-i32-field OPEN struct (`(struct (field $len i32))`). When the empty
class is a hierarchy ROOT (it has subclasses → left non-final/open), WasmGC
**iso-recursive canonicalization** (#2009's disease) merges the open class root
with `$AnyString`; its `final` subclasses then become subtypes of `$AnyString`,
so `ref.test $AnyString` on a subclass instance / class-object returns TRUE.
That false positive drove the standalone `===` and `typeof === "string"` arms
into `ref.cast $AnyString` + `__str_flatten` on a non-string struct →
`RuntimeError: illegal cast`. This broke EVERY strict-equality and string-typeof
over a subclass value in standalone (`B === B`, `new B() === x`,
`B.prototype === p`, `typeof new B()`), a large slice of the gap. Lone empty
classes escape it because `markLeafStructsFinal` makes them `final` (a final
struct is not subtype-compatible with the non-final `$AnyString`).

**Fix:** append a hidden immutable sentinel field (`__shape_brand` i32) to a
class root struct whose only field would be `$__tag`, making it
`(struct (field i32) (field i32))` — structurally distinct from the single-field
`$AnyString`, breaking the canonical merge. Appended LAST so existing positional
`fieldIdx` for real instance fields is unaffected; constructors and the lazy
proto/class-object inits iterate the field list and default it automatically.
Cost: +4 bytes only on empty-class instances (rare). Classes with ≥1 instance
field are already structurally distinct and get no sentinel. This is the
#2009-family canonicalization-collision fix applied to the class-vs-string
boundary (distinct from #2009's anon-object-literal `$shape` work).

Files: `src/codegen/property-access.ts` (instance `.constructor` → class-object
singleton), `src/codegen/class-bodies.ts` (empty-root sentinel field). Test:
`tests/issue-2158-class-identity-standalone.test.ts` (15 cases — constructor
identity, empty-subclass identity/typeof, plus regression coverage for method
dispatch, super()-inherited fields, getPrototypeOf, instanceof, string equality).
tsc clean; standalone suite green.

---

## Implementation Plan (architect, 2026-06-17)

### Scope correction — what the 7163 bucket actually is

This issue's `## Problem` (above) describes the ~1,388 host-vs-standalone
**diff**. The `class-prototype-private-descriptor` root-cause bucket in
`benchmarks/results/test262-standalone-report.json` is a different,
**larger 7163-test catch-all** (sha `…175848`, 2026-06-16). I replicated the
classifier (`scripts/build-test262-report.mjs` matcher order) over
`benchmarks/results/test262-standalone-results.jsonl` and reproduced the count
**exactly (7163)**. The bucket matcher is broad — it scoops any record whose
path contains `…/class/`, `private`, `computed-property-names`, or whose
**error text contains `prototype`** — so it is dominated by failures that are
*not* class-element semantics at all. Verified breakdown of the 7163:

| Family | Count | Status |
|--------|------:|--------|
| **A. `<Builtin>.prototype.<member>` value read CE** (S6-b refusal) | **2846** | compile_error |
| **B. `Symbol.<wellKnown>` value read CE** (species/hasInstance/…) | **273** | compile_error |
| C. `<Ctor>.<staticProp>` value read CE (Object.getPrototypeOf, Promise.resolve…) | 14 | compile_error |
| D. other `not (yet) supported in --target standalone` CE | 573 | compile_error |
| E. `Object.prototype.toString.call(...)` CE | 70 | compile_error |
| F. invalid-Wasm-binary CE (validator type-mismatch) | 384 | compile_error |
| G. CE residual (uncategorized) | 80 | compile_error |
| H. genuinely-class FAILs (private 232, computed-name 96, class-lang 287) | ~615 | fail |
| I. ToPrimitive ("Cannot convert object to primitive") | 326 | fail+CE |
| J. `__str_flatten` null-deref | 105 | fail |
| K. illegal-cast at runtime | 84 | fail |
| L. misc fail residual | ~1700 | fail |

**The single dominating root cause (A, 2846) is the builtin-prototype-method-
as-value gap, not class semantics.** Reading `Array.prototype.push`,
`String.prototype.charAt`, `Object.prototype.toString`, `Date.prototype.getTime`,
etc. as a *value* in `--target standalone` hits the refusal at
`property-access.ts:2234` (`reportUnsupportedStandaloneBuiltinValueRead`).

### Root cause (Family A/B/C)

The `#2175` native-proto infrastructure already exists and already routes
`<Builtin>.prototype.<member>` value reads **away** from the refusal — but
**only for builtins that have registered glue**, and today **only RegExp is
registered** (`ensureRegExpNativeProtoGlue`, `regexp-standalone.ts:1757`). The
brand table (`native-proto.ts:55`) literally reserves the next stages in a
comment: `// S3 (reserved, not yet wired): "%TypedArray%", Int8Array, …`.

The extension point is a **pure registration**: a builtin that calls
`registerNativeProtoBuiltin(ctx, glue)` with a `NativeProtoBuiltinGlue`
(`native-proto.ts:142`) automatically gets, host-free:
- `<Builtin>.prototype` as a value → `emitLazyNativeProtoGet`
  (`property-access.ts:2222`),
- `<Builtin>.prototype.<member>` value read → `tryCompileStandaloneBuiltinProtoMemberRead`
  (`property-access.ts:515`, called at `:1738`) → `ensureStandaloneNativeMethodClosure`
  (`native-proto.ts:318`) → a `__fn_wrap` closure struct that the existing
  `call_ref` closure-call path invokes (the `emitMemberBody` brand-recovery
  prologue binds the externref `this`),
- `<Builtin>.prototype.<member>.length` / `.name` folded at compile time
  (`tryCompileStandaloneBuiltinProtoMemberMeta`, `:477`).

So Family A is decomposed by **builtin family**, each slice = "register glue +
write `emitMemberBody` bodies for that family's prototype members."

### The glue contract (template — copy RegExp)

Reference: `ensureRegExpNativeProtoGlue` + `emitRegExpProtoMemberBody`
(`regexp-standalone.ts:1757`–`1830`). For each new builtin a dev:

1. Adds a stable brand to `BUILTIN_BRAND_TABLE` (`native-proto.ts:55`) — pick
   the next `BUILTIN_BRAND_BASE + N`; keep offsets stable (baked into emitted
   code). Brands are a negative band disjoint from class tags (asserted).
2. Writes `ensure<Builtin>NativeProtoGlue(ctx)` returning the brand, building a
   `NativeProtoBuiltinGlue`:
   - `memberCsv` — the proto's own string-named members (+ `@@<id>` sentinels
     for well-known-symbol members, id from `WELL_KNOWN_SYMBOLS`,
     `property-access.ts:124`),
   - `memberKind(m)` → `"getter"` for accessors (§ spec), else `"method"`,
   - `memberLength(m)` → static `fn.length` per spec,
   - `emitMemberBody(ctx, fctx, member, kind)` — closure body: param idx 0 =
     `__fn_wrap` self, idx 1 = externref `this`, idx 2.. = externref args. Run a
     brand-recovery prologue (recover the backing WasmGC struct from `this`, or
     `emitBrandCheckTypeError` on a wrong receiver — `native-proto.ts:382`),
     then the member body, leaving the result on the stack. **Box ref results to
     externref** via `extern.convert_any` before returning (the `call_ref` ABI
     is uniform on externref/i32/f64).
3. Wires `tryEnsureNativeProtoBrand` (`property-access.ts:449`) to call the new
   `ensure<Builtin>NativeProtoGlue` for that builtin name (mirrors the RegExp
   arm). This is the ONE edit that activates routing for the builtin.

**Reuse existing native bodies.** Each builtin family already has native
method lowerings used by the *direct-call* path (e.g. `array-methods.ts`,
`src/codegen/*`). `emitMemberBody` should delegate to those existing emitters
operating on the recovered struct/value, NOT re-implement them. The new code is
the brand-recovery wrapper + result boxing, not new method semantics.

### Slices (ordered by impact-per-effort)

**Slice 1 — Array / TypedArray / ArrayBuffer / DataView prototype methods
(Family A, ≈1253 CE).**
Brands + glue for `Array`, the 11 concrete TypedArray views + `%TypedArray%`,
`ArrayBuffer`, `SharedArrayBuffer`, `DataView`. `emitMemberBody` delegates to the
existing array/typedarray method emitters in `array-methods.ts` on the recovered
vec/byte-carrier value. The TypedArray views share one glue parameterized by
element type. This is the single biggest CE win.
- Files: `native-proto.ts` (brand table), new
  `src/codegen/array-native-proto.ts` (glue + `emitMemberBody`),
  `property-access.ts:449` (`tryEnsureNativeProtoBrand` arms), `array-methods.ts`
  (factor shared method bodies so the closure can call them on a struct local).
- Pattern: `__fn_wrap` closure + brand-recovery prologue → existing array method
  emitter; box ref results with `extern.convert_any`.
- CE reduction: **≈1253**.
- Acceptance: `Int8Array.prototype` / `Array.prototype` `built-in static
  property value read` CEs clear; `built-ins/Array/prototype` (2047 in bucket)
  and `built-ins/TypedArray/prototype` (523) compile. Sample sigs
  `…Array.prototype built-in static property value read…` and
  `…Int8Array.prototype…` gone.

**Slice 2 — Object / Function prototype methods (Family A, ≈425 CE) + the
`Object.prototype.toString.call` slice (Family E, 70 CE).**
Glue for `Object` and `Function`. `emitMemberBody` for `Object.prototype`:
`toString` (the §19.1.3.6 [[Class]] tag dispatch — already partially handled,
extend the standalone slice), `hasOwnProperty`, `isPrototypeOf`,
`propertyIsEnumerable`, `valueOf`, `toLocaleString`. For `Function.prototype`:
`call`, `apply`, `bind`, `toString`. The `Object.prototype.toString.call(x)`
form (70 CEs) is the same glue once `Object.prototype.toString` is a real
closure value.
- Files: `native-proto.ts`, new `src/codegen/object-native-proto.ts`,
  `property-access.ts:449`, reuse `object-ops.ts` / existing toString-tag logic.
- CE reduction: **≈495**.
- Acceptance: `Object.prototype` / `Function.prototype` `…static property value
  read…` CEs clear; `Object.prototype.toString.call(...) is not yet supported`
  CE gone; `built-ins/Object/prototype` (147) + `built-ins/Function/prototype`
  (201) compile.

**Slice 3 — Well-known Symbol value reads (Family B, ≈273 CE).**
`Symbol.species`, `Symbol.hasInstance`, `Symbol.isConcatSpreadable`,
`Symbol.toPrimitive`, `Symbol.toStringTag`, `Symbol.match/replace/search/split/
matchAll`, etc. These already have a downstream `i32.const <symId>` emitter
(`property-access.ts:3107`, `getWellKnownSymbolId`) but it is **pre-empted by the
refusal** because `hasNativeBuiltinConstantHandler` (`:223`) only defers
Math/Number. **Fix:** widen the standalone deferral so `Symbol.<wellKnown>`
reaches the `i32.const` emitter — add a `Symbol` arm to
`hasNativeBuiltinConstantHandler` returning `getWellKnownSymbolId(propName) !==
undefined`. **Edge case (already noted at `:214`):** the i32 symbol-id does not
compose with an externref `undefined` comparison (`Symbol.iterator !==
undefined` → invalid Wasm). Audit the consumers: gate the deferral so it only
fires where the i32 result is consumed by a symbol-keyed computed access
(`obj[Symbol.x]`, the common test262 shape), and keep refusing-loud for the
raw `!== undefined` comparison until a symbol-as-externref boxing exists (or box
the well-known symbol to a stable externref sentinel so both compose — preferred
if cheap). Decide via the failing sample signatures.
- Files: `property-access.ts` (`hasNativeBuiltinConstantHandler` + the deferral
  gate at `:2214`/`:2238`).
- CE reduction: **≈273** (minus the `!== undefined` subset, ~30).
- Acceptance: `Symbol.species` / `Symbol.hasInstance` / `Symbol.isConcatSpreadable`
  `…static property value read…` CEs clear; `c[Symbol.x]` computed-access class
  tests in the bucket compile.

**Slice 4 — String / Number / Boolean / BigInt + Error/Date/collection
prototype methods (Family A, ≈960 CE).**
The long tail of Family A: `String.prototype.*` (317), `Date.prototype.*` (283),
`Number.prototype.*` (166), collections `Set/Map/Weak*/Promise.prototype.*`
(208), `Error.prototype.*` + the error subclasses (~90), `Boolean/BigInt`
(~70). Same glue pattern, delegating to the existing native method emitters per
family. Lower priority than 1–2 only because it spans more builtins (more glue
files) for a comparable total; split into 4a (String/Number/Boolean/BigInt) and
4b (Date/Error/collections) if a single PR is too large.
- Files: `native-proto.ts`, per-family `*-native-proto.ts` glue,
  `property-access.ts:449`, reuse existing string/number/date/collection
  emitters.
- CE reduction: **≈960**.
- Acceptance: the remaining `<Builtin>.prototype built-in static property value
  read` CEs across String/Number/Boolean/BigInt/Date/Error/Set/Map/Weak*/Promise
  clear. After slices 1–4 the entire Family-A+B+E (~3700) CE class is gone.

**Slice 5 — invalid-Wasm-binary + ToPrimitive residual (Family F+I, ≈710).**
Now that the CE refusals are gone, the next-largest shapes surface. (a) Family F
(384) — `invalid Wasm binary … expected type i32/externref, found …` validator
failures: type-mismatch at the closure/`call_ref` boundary (an externref result
fed where i32/f64 is expected, or vice-versa). Root-cause from the WAT of the
top sample signatures; likely a coercion gap in the new closure result boxing
(tighten Slice 1–4 result types) or in `__extern_get` fallback unboxing. (b)
Family I (326) — `Cannot convert object to primitive value` on class instances:
the standalone ToPrimitive/`@@toPrimitive` dispatch over class structs
(`index.ts:1586`/`:5288` already has the class-`[Symbol.toPrimitive]` dispatch
scaffold). Re-validate against repros before sizing — some F entries may be
collateral that slices 1–4 already fix.
- Files: `type-coercion.ts`, `property-access.ts`, `index.ts` (ToPrimitive
  dispatch), per WAT diagnosis.
- Reduction: **≈710** (re-measure after slices 1–4 land).
- Acceptance: top F/I sample signatures clear; no new invalid-Wasm regressions.

**Slice 6 — genuinely-class FAILs: private fields/methods + computed property
names (Family H, ≈615).**
The *actual* class-element semantics residual: private fields/methods/brand
checks (232 — `built-ins`/`language/.../private`), computed-property-name class
fields/accessors from `await`/function expressions (96 — the `cpn-class-*`
sample files), and general class-lang fails (287). These are the only slices
that touch class codegen proper (`class-bodies.ts`, `index.ts`
`compileClassDeclaration`). Spec each sub-cluster from its sample files +
fetched ES spec section (§15.7 class definitions, §15.7.10 private names) before
implementing — these are not a single mechanism. Lowest impact-per-effort of the
six; schedule after the CE families are cleared so the FAIL signal is clean.
- Files: `src/codegen/class-bodies.ts`, `src/codegen/index.ts`,
  `src/codegen/literals.ts` (computed key resolution).
- Reduction: **≈615** (subdivide per cluster; re-measure after slice 5).
- Acceptance: `cpn-class-expr-*-computed-property-name-from-await/function-
  expression` sample files pass; private-field/brand-check class tests pass.

### Sequencing & risk

- **Slices 1→4 are independent per builtin family** and can run in parallel
  across devs — the only shared file is `BUILTIN_BRAND_TABLE` (`native-proto.ts`)
  and the `tryEnsureNativeProtoBrand` switch (`property-access.ts:449`). To avoid
  conflicts: **reserve all brand ids up front** in one tiny prep PR (add the full
  `BUILTIN_BRAND_TABLE` entries with comments, no glue), then each slice fills in
  its glue. The `tryEnsureNativeProtoBrand` arms are append-only one-liners —
  low conflict, but coordinate via the dependency graph.
- **Brand-band invariant:** brands must stay `<= BUILTIN_BRAND_BASE`
  (`-0x4000_0000`) and disjoint from class tags — the assert in `getBuiltinBrand`
  (`native-proto.ts:74`) enforces it; do not reuse a class-tag range.
- **`addUnionImports` index shift:** `emitMemberBody` bodies that
  `ensureLateImport` must `flushLateImportShifts(ctx, fctx)` before emitting the
  `call` (see RegExp glue + CLAUDE.md addUnionImports notes) — a stale captured
  funcIdx is the `late-import index-shift` CE class.
- **Result-type uniformity:** every `emitMemberBody` ref result MUST be boxed to
  externref (`extern.convert_any`) — skipping this is the Family-F invalid-Wasm
  trap, so slice 5 partly depends on slices 1–4 doing this correctly.
- **Slices 5–6 should be re-measured** against a fresh standalone report after
  1–4 merge; their counts are downstream of the CE fixes and will shift.

### Test files to verify (per slice)
- S1: `test/built-ins/Array/prototype/*`, `test/built-ins/TypedArray/prototype/*`,
  `test/built-ins/DataView/prototype/*`, `test/built-ins/ArrayBuffer/prototype/*`
- S2: `test/built-ins/Object/prototype/*`, `test/built-ins/Function/prototype/*`,
  `test/language/expressions/object/method-definition/name-prototype.js`
- S3: `test/built-ins/Symbol/species/*`, computed-key class tests reading
  `c[Symbol.x]`
- S4: `test/built-ins/{String,Number,Date,Set,Map,Promise,Error}/prototype/*`
- S6: `test/language/expressions/class/cpn-class-expr-*-computed-property-name-
  from-{await,function}-expression.js`, `test/language/.../class/.../private*`

Add standalone equivalence regressions under
`tests/issue-2158-*-standalone.test.ts` per slice (mirror
`tests/issue-2158-class-identity-standalone.test.ts`).

---

## Implementation notes — Slice F-1 (2026-06-18, cs-2158): dstr-param default funcIdx-shift invalid-Wasm

### What
Fixes a concrete Family-F (invalid-Wasm-binary) defect that hit a large slice
of the class `dstr/` failures (e.g.
`class/dstr/meth-dflt-obj-ptrn-prop-ary`, `private-meth-dflt-obj-ptrn-prop-ary`,
`gen-meth-dflt-obj-ptrn-prop-ary`, … — and the equivalent top-level functions).
A function/method parameter whose binding pattern carries a **default value**
(`= …`) AND binds a **nested sub-pattern** (an object property bound to an array
sub-pattern, `{ x: [y] } = { x: [42] }`, or a nested array `[[y]] = …`) compiled
to invalid Wasm: `if[0] expected type i32, found call of type externref`.

This was diagnosed by WAT-tracing the standalone repro — the param-default
missing-arg guard `(if (call $__extern_is_undefined …))` had its condition call
pointing at `$__object_seal` (an externref producer) instead of
`$__extern_is_undefined` (an i32 producer).

### Root cause — a funcIdx index-shift orphan (addUnionImports/#1109 family)
`destructureParamObject`'s externref **struct-fast-path**
(`destructuring-params.ts`, the `ref.test structTypeIdx ? then : else` arm)
detaches the OUTER function body to a then/else branch buffer with a **plain
JS-local swap** (`const savedBody = fctx.body; fctx.body = then/elseInstrs; …;
fctx.body = savedBody`). The then/else buffers are correctly tracked in
`ctx.liveBodies` (#779d), but the **outer body itself is orphaned** — it is not
on `fctx.savedBodies`, not in `ctx.liveBodies`, and not `fctx.body` during the
recursive descent. When the nested array sub-pattern's recursive
`destructureParamArray` adds a late import (`__array_from_iter_n` /
`__extern_get_idx` / `__extern_length`, added at low import indices →
`importsBefore=0`, shifting EVERY defined-function index up), the
`shiftLateImportIndices` walk visited `fctx.body` + `savedBodies` + `liveBodies`
but never the orphaned outer body. So the already-emitted
`call __extern_is_undefined` (the param-default `if` condition, emitted into the
outer body BEFORE the destructuring loop runs) kept its stale-low funcIdx and
the `if` consumed an externref where an i32 was required → invalid Wasm.

Confirmed via instrumentation: condition captured at idx 114; module-finalize
moved `__extern_is_undefined` to 116 but the emitted call stayed at 114 (= now
`__object_seal`); the two flushes that did the shift reported the call
unreachable from the fctx body chain.

### Fix
`src/codegen/destructuring-params.ts` — in the struct-fast-path branch, track the
orphaned outer `savedBody` in `ctx.liveBodies` for the recursion window
(add before the then/else compile, delete after the `if` is assembled),
mirroring the existing then/else #779d tracking. Guarded with
`outerAlreadyLive` so a re-entrant call that already tracked the body does not
double-delete (keeps the #2182 liveBodies-balance invariant intact). +16 lines,
no behavior change to the non-orphan paths.

### Verification
- `tests/issue-2158-dstr-param-default-nested-pattern.test.ts` (8 cases):
  standalone now VALIDATES (`WebAssembly.compile` succeeds — the direct
  regression guard for the orphan) for object-prop→array, class-method,
  2-element, nested-array-with-its-own-default+outer-default, and explicit-arg
  shapes; plus host-mode runtime correctness (default fires → 42, explicit → 7,
  nested+outer → 24).
- The pre-existing `issue-1025-param-default-null.test.ts:78` assertion failure
  reproduces identically on clean `origin/main` (verified) — NOT a regression of
  this change.
- The `array-rest-destructuring` / `destructuring-member-targets` /
  `for-of-array-destructuring` suites fail to load on `origin/main` too
  (they import a non-existent `./helpers.js`) — pre-existing, unrelated.

### Remaining (still open under this umbrella)
- **Host-import leak in standalone**: these shapes now compile to *valid* Wasm
  but still emit `env::__array_from_iter_n` (+ `env::__get_undefined` via
  `emitBoundsCheckedArrayGetUndef` bypassing `ensureGetUndefined`), which
  standalone cannot satisfy at instantiation. Needs a Wasm-native array-from-iter
  fallback (or to route the known-vec fast path so the import is never added).
  Separate, larger slice.
- **A deeper funcIdx orphan in larger modules**: the static-method variant
  (`meth-static-dflt-obj-ptrn-prop-ary`, harness-sized module) surfaces a second
  shift orphan (`call[0] expected (ref null N), found externref`) AFTER this fix
  clears its `if[0]` error — i.e. this fix is strict progress that unmasks it.
  Same family; another body-swap site to audit. Documented for a follow-up slice.
