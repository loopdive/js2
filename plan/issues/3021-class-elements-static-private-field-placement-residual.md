---
id: 3021
title: "spec gap: class elements — static/private field & method placement residual (~1,522 default-lane fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-05
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, private-fields, class-elements
es_edition: 2022
goal: spec-completeness
test262_category: language/statements/class, language/expressions/class
test262_fail: 1522
related: [1047, 1144, 1226, 1348, 1364, 1365, 1591, 1643, 2669]
---

# #3021 — class elements: static/private field & method placement residual

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`, gitHash
`51622ba2`). Sub-bucketed from the `class/elements` (649) and `class/dstr`
(416) `error_category` buckets plus adjacent class-expression assertion
failures elsewhere in `language/{statements,expressions}/class` (~457 more),
total **1,522** official fails.

## Problem

A long line of class-element issues has landed (#1047 instance-fields-leak,
#1144 static-class-elements-this-priv, #1226 static-async-private, #1348/#1643
static-init-and-private-fields, #1364 method/field descriptor fidelity, #1591
same-line multi-definition) but a residual of the same _symptom family_
persists at a much larger scale than any single one of those fixes covered.
Dominant assertion signatures:

- `!Object.prototype.hasOwnProperty.call(C.prototype, 'x')` — **137** — a
  field or private/static element is still materializing as an own property
  of the constructor's `.prototype` object instead of the instance (or is
  visible on the wrong object entirely). This is the same symptom #1047
  fixed for one code shape; the residual suggests other shapes (nested
  static blocks, computed private names, multi-element same-line
  definitions) still leak.
- `c.foo === "X"` value mismatches — **73** — field initializer runs but
  produces the wrong instance value (ordering vs. superclass construction,
  or resolving against the wrong `this`).
- `c.m === C.prototype.m` identity checks — **63** — method reference
  identity broken, likely a re-materialization of the trampoline/closure
  per access instead of a stable function object.
- Remainder: destructuring inside class-element initializers and method
  params (`class/dstr`, 416) — generator/async-generator method params with
  destructuring defaults, closures over `this`/private names inside a
  destructured default expression.

## Sample failing files

- `language/statements/class/elements/multiple-stacked-definitions-static-private-methods.js`
- `language/expressions/class/dstr/gen-meth-ary-ptrn-elem-id-init-skipped.js`
- `language/statements/class/elements/after-same-line-static-gen-computed-symbol-names.js`

## Suggested approach

1. Re-run the `#1047` repro shape family (computed keys, static blocks,
   private names, same-line multi-definition) against current main and
   confirm which combinations still fail `hasOwnProperty` — the fix was
   scoped to `_wrapForHost` struct-field enumeration and may not cover every
   element-placement code path in the direct codegen (non-wrapForHost) class
   lowering.
2. For the `c.m === C.prototype.m` identity class, check whether method
   values are re-synthesized per property read instead of cached once on
   the prototype/instance struct.
3. `class/dstr` (416) likely shares root cause with the #2669 destructuring
   residual umbrella (which already tracks `for-of/dstr` 247, function-param
   dstr 63, object-method dstr 55) — cross-check before duplicating work;
   this issue owns the class-element-_specific_ dstr shapes if #2669's
   scope doesn't already cover class method/constructor params.

## Acceptance criteria

- `hasOwnProperty(C.prototype, fieldName)` is false for every instance
  field/private-field shape test262 exercises.
- Method identity (`c.m === C.prototype.m`) holds across all class-element
  placement combinations.
- test262 fail count in `language/{statements,expressions}/class/{elements,dstr}`
  drops materially from the 1,522 baseline recorded above.

## Implementation Plan

_Architect spec, 2026-07-04, verified against `upstream/main` @ `f01867968`
(no class-relevant src changes since the baseline hash `51622ba2` — cluster
re-verified live). All findings below were reproduced with minimal probes
through the REAL runner path (`runTest262File` / `wrapTest` + `setExports`
wiring); earlier ad-hoc probes without `setExports` produce false negatives
on every dynamic-reflection path — do not diagnose without it (see memory
`project_wrapforhost_setexports_harness`)._

### Classification headline

The 1,522-test cluster is NOT a class-placement/codegen-ordering problem.
Fields are placed correctly; constructors run correctly; `c.m()` calls work.
The cluster decomposes into **two dominant, narrow root causes in the
host-reflection layer** (RC1, RC2 below — together the first-failing-assert
for ~450+ tests and a blocking station for hundreds more), plus a statics
gap (RC5), a known null/undefined substrate dependency (RC4 → #2106), and
routable residue (eval, async-gen protocol, dstr → #2669/#2106).

**Overlap with #3000: none.** #3000 (B/C/E) is IR-path adoption measured on
playground fallback buckets; every failure here reproduces on the legacy
pipeline the default lane actually runs. No routing to #3000.

### The harness mechanics that select the failing paths (read first)

Three `wrapTest` behaviors (tests/test262-runner.ts) decide which compiler
path a test exercises — this explains the maddening "same shape passes on
one line, fails on three lines" noise:

1. The test body is moved inside `export function test()` → every class in
   this corpus is a **function-local** class (`compileNestedClassDeclaration`,
   src/codegen/statements/nested-declarations.ts:83 — same collect/compile
   machinery as top-level, so this alone is benign).
2. `Object.prototype.hasOwnProperty.call(X, k)` is rewritten to
   **`(X).hasOwnProperty(k)`** — a _parenthesized_ receiver. → RC1.
3. `var c = ...` is hoisted to module-level **`let c: any;`** whenever the
   var name matches `\b<name>\b` anywhere in a _multi-line_ class body
   (tests/test262-runner.ts:2435-2470; the one-line class regex at :2440
   doesn't match single-line bodies). A field literally named `c` (`'c' =
39`) triggers the hoist of `var c` → the receiver becomes **`any`** and
   every subsequent read goes through the dynamic host path. → RC2/RC4/RC5.
   This is _more_ spec-faithful (real test262 is untyped JS), so do NOT
   "fix" the harness to dodge; the compiler's `any` lane must be correct.

### RC1 — paren-blind `isPrototypeReceiver` in compilePropertyIntrospection [S]

**Root cause.** `src/codegen/object-ops.ts:4391-4392`:

```ts
const isPrototypeReceiver =
  ts.isPropertyAccessExpression(propAccess.expression) && propAccess.expression.name.text === "prototype";
```

`(C.prototype).hasOwnProperty("b")` has a `ParenthesizedExpression` receiver
→ `isPrototypeReceiver` false → the constant fold answers with **instance**
semantics. Verified inverted output on current main:

```
C.prototype.hasOwnProperty("b")  → false ✓   (C.prototype).hasOwnProperty("b") → true ✗
C.prototype.hasOwnProperty("m")  → true  ✓   (C.prototype).hasOwnProperty("m") → false ✗
```

Since the harness _always_ produces the paren form from
`Object.prototype.hasOwnProperty.call(...)`, every template-battery station
`assert(!hasOwnProperty.call(C.prototype, field))` fails. Direct first-fail
attribution: **E1 (137) + E2 (73 — the "c.foo" signature is an
assert-locator misattribution; instrumented assert-by-assert on
`multiple-definitions-private-method-usage.js`, the failing asserts are the
`(C.prototype).hasOwnProperty("foo"/"bar")` stations, `c.foo` itself is
correct) + shares of E7/E8** ≈ 250-300 tests.

**Fix.** In `compilePropertyIntrospection` (object-ops.ts:4224), compute
`const recvExpr = ts.skipParentheses(propAccess.expression);` once and use
it for BOTH the `isPrototypeReceiver` AST check and the
`recvVarName`-identifier check at ~:4515 (the #1334/#2726 needsRuntime
gate — currently also paren-blind). The type-based `isConstructorReceiver`
(getConstructSignatures) is paren-safe; leave it.

**Hardening audit (same PR, mechanical).** `grep -n 'name.text === "prototype"'`
lists ~20 sites keying receiver classification on an un-skipped
PropertyAccessExpression (property-access.ts:4438/6865, calls.ts:472/1261/…,
assignment.ts:3442/3805, set-runtime.ts:254, index.ts:422/450). Only
object-ops.ts:4392 is load-bearing for this cluster (the harness only
parenthesizes the hasOwnProperty rewrite), but sweep them with a shared
`skipParens` local where trivially safe. Do not restructure.

**Edge case.** The constant fold cannot see a preceding
`delete C.prototype.m` (verifyProperty's configurable round-trip). Not a
regression — verifyProperty's own internal checks run on `any` params
through the runtime path — but keep the existing needsRuntime demotion
logic intact.

### RC2 — `any`-receiver method-VALUE read returns `undefined` [M/L]

**Root cause.** With a hoisted `let c: any`, `c.m` compiles to the dynamic
read import `__extern_get` (src/runtime.ts:8282). Its resolution chain is:
host `in`-check → `_safeGet` (sidecar/descs) → fn-`prototype` vivify →
`__sget_<key>` struct-field getter. **There is no arm for "key names an
instance method of the receiver's class"** → returns `undefined`. Verified:

```
c.foo → "foobar" ✓   typeof c.m → undefined ✗   c.m === C.prototype.m → false ✗   c.m() → 42 ✓ (call path is separate)
```

The typed path (`C.prototype.m` / typed `c.m`) emits the #1394 cached
singleton closure (`emitCachedMethodClosureAccess`,
src/codegen/closures.ts:4227; one lazily-initialized externref cache global
`__method_closure_${Class}_${method}` per method, `ctx.methodClosureGlobals`,
closures.ts:4447-4457). The dynamic read must return **that exact struct**
or `===` identity can never hold.

**Fix — a Wasm dispatcher export, host calls back into the module** (keeps
one source of truth for identity; no new host-import, standalone-clean):

1. **Extract** the lazy-init emission from `emitCachedMethodClosureAccess`
   (the trampoline mint at closures.ts:4247-4310 + cache-global alloc +
   `global.get / ref.is_null / if(init) / global.get` sequence at
   :4444-4480) into a reusable `emitCachedMethodClosureInit(ctx, targetBody,
fullName, methodFuncIdx, structTypeIdx)` so the same cache global +
   canonical trampoline (`__obj_meth_tramp_${fullName}_cached`) back both
   the typed access sites and the new export. Preserve the
   `pendingMethodTrampolines` re-resolution mechanics (#1669/#2015) —
   trampolines are located by body identity, so the extraction must keep
   pushing the SAME body array reference.
2. **Emit `__class_member_value(externref, externref) -> externref`** at
   finalize time, modeled line-for-line on `emitStructFieldNamesExport`
   (src/codegen/index.ts:3233 — same host-only gate: `if (ctx.nativeStrings)
return;`, same placement AFTER all class bodies are compiled so no
   funcidx shifts can invalidate it — see memories
   `reference_1461/2191/2193` for why late-emitted bodies must not capture
   pre-shift indices). Body shape:
   - `any.convert_extern` the receiver; per class `C` with instance methods:
     `ref.test $C` arm (order arms **subclass-before-superclass** — a parent
     `ref.test` matches subclass instances; same hazard #2009 solved for
     `__struct_field_names` via `$shape`, but method dispatch wants the
     subclass override anyway, so most-derived-first ordering is the fix);
   - inside the arm, chain `key == "m"` string compares (reuse the string-eq
     helper the runner's other name-dispatch exports use — same pattern as
     the per-name dispatch in the `__sget_*`/descriptor exports) → on match,
     inline the shared lazy-init sequence → return the cache global;
   - no match / no arm → `ref.null.extern`.
   - Cover only methods present in `ctx.classMethodNames` (the same CSV
     source `__register_prototype` uses, extern.ts:172-181) minus statics;
     accessors keep their existing getter path — do NOT route accessors
     through this export.
   - The class's **fake proto struct is itself a `$C` instance**
     (emitLazyProtoGet builds a default-valued `struct.new $C`,
     extern.ts:184-218), so the same arm makes dynamic
     `(C.prototype).m`-style any-reads return the identical cached closure.
     That is correct and required — do not exclude it.
3. **Host wiring** (src/runtime.ts): in the `__extern_get` closure
   (runtime.ts:8282), after the `__sget_${key}` miss and before the final
   `return undefined`, add: if `_isWasmStruct(obj) && typeof key ===
"string"` → `const mv = exports?.__class_member_value?.(obj, key); if
(mv != null) return mv;`. Add the SAME arm to `_resolveHostField`
   (runtime.ts:5234) so proxy `get`/descriptor reads agree, and to
   `_wasmStructHasOwn` (runtime.ts:3435) ONLY as a presence probe for
   receivers with **no** `_prototypeMethodNames` registration (an instance
   must NOT report `m` as own — spec places it on the prototype — so do NOT
   add it to instance hasOwn; it is needed only so `typeof c.m` /
   `c.m === C.prototype.m` work. Concretely: wire get-paths only, leave
   hasOwn/ownKeys untouched).
4. **`getOwnPropertyDescriptor` consistency**: the #1364a bridge cache
   (`_prototypeMethodBridges`, runtime.ts:4900) currently synthesizes a JS
   placeholder Function for descriptor `value`. Once the dispatcher exists,
   `_getProtoMethodBridge` should first try
   `exports.__class_member_value(proto, name)` and only fall back to the
   placeholder — otherwise `verifyProperty(C.prototype, "m", ...)`'s
   `value` won't `===` a compiled-side `C.prototype.m` read.

**Attribution**: E3 (63) first-fail + the `c.m === C.prototype.m` /
`typeof` stations of every template test whose receiver got any-hoisted;
also expected to help the `class/dstr` "`it.next` is not a function"
sub-family (~60 — generator objects read `.next` through the same dynamic
path; verify after landing, do not assume).

### RC5 — statics invisible through an `any` class-object receiver [M]

**Verified**: with `let C: any = D`, `C.b` (static field = 42) →
`undefined`; `typeof C.sm` → `undefined`; `C.sm === D.sm` → false (typed
static value reads use `emitFuncRefAsClosure` — **fresh struct per read, no
cache**, property-access.ts:4392-4405 — so even typed `D.sm === D.sm` needs
auditing); `C.sm()` call works. Templates hit this whenever the class body
references the class name (`static x() { return C.#x(…); }` → `\bC\b`
matches → `var C` hoists to any).

**Fix** (after RC2's dispatcher exists):

- Add a **class-object arm** to `__class_member_value`: `ref.test` the
  class-object singleton's struct type (built by `emitLazyClassObjectGet`,
  src/codegen/expressions/extern.ts:247 — confirm its struct typeIdx;
  register it in a `ctx` map at emission if not already distinguishable);
  static METHOD names → a cached singleton closure (introduce a static
  analog of the #1394 cache: `__method_closure_${Class}_${staticName}` via
  the same extracted init helper — and switch the TYPED static value read
  at property-access.ts:4392 from `emitFuncRefAsClosure` to it so typed and
  dynamic reads share identity); static FIELD names → `global.get` the
  `ctx.staticProps` global, coerced to externref.
- Host side: covered by the RC2 wiring (same `__class_member_value` call).
- hasOwn for statics: `_staticMethodNames` (#1395) already answers method
  presence; static _fields_ need their names added to the
  `__register_class_object` CSV (index.ts:1642-1654 registration; extern.ts
  emits the call) so `(C).hasOwnProperty("b")` (dynamic) and
  `Object.getOwnPropertyNames(C)` include initialized static fields.

**Attribution**: `static-*` template families (~40-90 first-fail;
e.g. `after-same-line-static-gen-rs-static-privatename-identifier-by-classname`
fails `C.$(1)` stations today).

### RC4 — null/undefined conflation stations [routed → #2106, do NOT fix here]

Uninitialized fields read `null` (typeof `object`) instead of `undefined`
(`c.a` → null; `verifyProperty(c, "a", { value: undefined })` fails), and
`class/dstr` `*-init-skipped` tests fail because a `null` bound value
wrongly triggers the default initializer (defaults must fire on
`undefined` ONLY, §8.6.2 IteratorBindingInitialization). Both are the
ref.null.extern sentinel conflation the #2106 `$undefined` tag-1 singleton
substrate exists to fix. These are LATER stations of the same template
tests — after RC1/RC2 land, a tranche of tests will progress to and stop
at these. Add a cross-link in #2106; do not attempt a local workaround
(a per-field "was-written" bit is strictly worse than the singleton).

### Routing of the remainder (no work in this issue)

| Sub-bucket                                                          | Count              | Route                                                                              |
| ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `elements` eval-based `assert.throws(SyntaxError)` (`*-eval-err-*`) | 37                 | deferred — eval is a skip-tier feature; 37/37 sampled files are `(0, eval)` probes |
| `elements` async-gen `yield-star-*` log-protocol                    | ~24-40             | async-generator protocol family (#1226 lineage) — separate issue                   |
| `elements` negative_test_fail (early-error grammar)                 | 10                 | small separate slice (early-error detection)                                       |
| `class/dstr` init-skipped / "Cannot destructure null"               | large share of 392 | #2106 (null-vs-undefined default trigger) + #2669 umbrella                         |
| `class/dstr` "it.next is not a function"                            | ~60                | re-measure after RC2; open sub-issue only for the residual                         |
| flat `cpn-*` (computed keys from await/async-arrow exprs)           | ~50                | separate issue — computed-name evaluation contexts, unrelated root                 |
| `subclass/derived-class-return-override-*` (null deref)             | ~10                | separate issue — [[Construct]] return-override protocol                            |
| private-_ `_-multiple-evaluations-of-class-{realm,eval}`            | ~15                | realm/eval infra — deferred tier                                                   |

### Sequenced slices (all Opus-executable; Fable NOT required)

1. **S1 [S] RC1**: `skipParentheses` in compilePropertyIntrospection +
   mechanical audit sweep. Zero architectural risk. Expected direct flips:
   ≥200 (E1+E2 plus later-station unblocks). Validate on:
   `elements/wrapped-in-sc-literal-names.js`,
   `elements/multiple-definitions-private-method-usage.js`,
   `elements/multiple-stacked-definitions-rs-privatename-identifier-initializer.js`.
2. **S2 [M/L] RC2**: extract shared cache-init helper + emit
   `__class_member_value` + host wiring in `__extern_get` /
   `_resolveHostField` / `_getProtoMethodBridge`. The only genuinely
   delicate slice — the hazards are all KNOWN patterns with existing
   in-repo templates (`emitStructFieldNamesExport` for the export shape,
   #1394 for the cache, #1669/#2015 for trampoline re-resolution,
   most-derived-first ref.test ordering). Follow this spec exactly; when
   in doubt, diff against how `__struct_field_names` handles the same
   lifecycle point. Validate: `typeof c.m === "function"`,
   `c.m === C.prototype.m` (hoisted-any shape), zero byte-diff on modules
   with no classes, `new-no-sc-line-method-string-literal-names.js`,
   `after-same-line-gen-literal-names.js`.
3. **S3 [M] RC5**: class-object arm + static cached closures + typed
   static-read unification + static-field CSV registration. Validate:
   `multiple-stacked-definitions-static-private-methods.js`,
   `after-same-line-static-gen-rs-static-privatename-identifier-by-classname.js`,
   `C.sm === C.sm` in both typed and any lanes.
4. **S4 [S] wrap-up**: equivalence tests for all three lanes (typed,
   any-hoisted, paren-receiver), re-run the elements corpus locally
   (`TEST262_PATH_FILTER=language/statements/class/elements` style scoped
   run), update the routing sub-issues with measured residuals, and record
   the post-fix bucket counts here.

Slices are independent enough for separate PRs; S2 before S3 (S3 extends
S2's export). S1 can land first and alone.

### S1 landed — 2026-07-05 (ttraenkler/opus-3021s1)

**RC1 fix shipped.** `compilePropertyIntrospection`
(`src/codegen/object-ops.ts`) now computes
`const recvExpr = ts.skipParentheses(propAccess.expression)` once and uses it
for both the `isPrototypeReceiver` AST check and the #1334/#2726
`recvVarName` needsRuntime gate. `isConstructorReceiver` was already
paren-safe (checker-based) and is unchanged.

Measured (real runner path, gc + standalone):

- Reproduction probe `(C.prototype).hasOwnProperty("b"/"m")`: `1001` (inverted)
  → `101` (correct) after fix.
- Named spec files: `multiple-definitions-private-method-usage.js` and
  `multiple-stacked-definitions-rs-privatename-identifier-initializer.js`
  flip FAIL→PASS on **both** lanes; `wrapped-in-sc-literal-names.js` flips
  standalone FAIL→PASS (gc residual is a later RC2/RC4 station, out of S1
  scope).
- Blast-radius: `built-ins/Object/prototype/{hasOwnProperty,propertyIsEnumerable}`
  = 66/79 pass, **identical** fail set pre/post-fix (13 unrelated symbol-key
  fails) — zero regression on the introspection hot path.
- Byte-inert: sha256 of compiled binaries for programs with no
  parenthesized-receiver introspection is **identical** pre/post-fix
  (`skipParentheses` is identity on non-paren nodes).
- New regression test: `tests/issue-3021.test.ts` (5 cases, equivalence vs
  Node).

**Remaining:** S2 (RC2 `__class_member_value` dispatcher), S3 (RC5 statics),
S4 (wrap-up). Issue stays `in-progress` until those land.

### Success measure

RC1+RC2+RC5 together should flip **≥300** of the 634 `elements` fails and
unblock later stations elsewhere; anything under +200 net means a station
was mis-attributed — stop and re-instrument (assert-by-assert logging via
the wrapped-source instrumentation used in this analysis) rather than
piling on further stations.
