---
id: 6621
title: "standalone: `new construct(...constructArgs)` on a linked/foreign class value answered null (or a field-less placeholder) whenever the spread's length was only known at runtime — R-construct from #6620"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-16
assignee: ttraenkler/senior-dev-s34
loc-budget-allow:
  # 2026-09-16 (S34) — `native-construct.ts` and `expressions/new-super.ts`
  # both already carry a #5383/#6607-rooted allowance in this stack for
  # exactly this subsystem (the dynamic-construct drivers). This grant
  # restates it for #6621 specifically so the allowance survives independent
  # of which sibling issue file a later rebase happens to touch: a new
  # arity-GENERIC construct driver (`__native_construct_argv`,
  # `reserveNativeConstructDriverArgv` + `fillArgvConstructDriver`) plus its
  # matching runtime-argv argument-marshal helper at the call site
  # (`buildRuntimeConstructArgvVec` + `compileNativeConstructRuntimeArgv`,
  # `new-super.ts`) — see "S34 findings" in #5383 for the full mechanism.
  - src/codegen/native-construct.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-09-16 (S34) — same change, same reasoning: two new functions in each
  # file (reserve + fill in `native-construct.ts`; the argv-marshal builder +
  # the runtime-argv construct-compile twin in `new-super.ts`), each a
  # deliberate, arity-generic TWIN of an existing per-arity function, not an
  # incidental function-size regression.
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/expressions/new-super.ts::tryCompileNativeConstructFromValue
---

# #6621 — a runtime-length spread into a foreign/linked dynamic construct answered null

## Problem

Under `--target standalone` (and WASI), `new construct(...constructArgs)`
answered `null` — or, worse, a field-less `Object.create(proto)` placeholder
with none of the constructor's own fields — whenever:

1. `construct` is a dynamically-typed value (a class reached through a
   PARAMETER or a property access, not a statically-resolvable class
   declaration), AND
2. the construct's arguments include a `SpreadElement` whose length cannot
   be determined at COMPILE TIME (`constructArgs` itself a parameter — not a
   literal array, not a local the compiler can trace back to one).

This is exactly the shape test262's `temporalHelpers.js` uses in
`checkSubclassConstructorNotObject`:

```js
checkSubclassConstructorNotObject(construct, constructArgs, method, methodArgs, resultAssertions) {
  function check(value, description) {
    const instance = new construct(...constructArgs);   // <-- here
    instance.constructor = value;
    const result = instance[method](...methodArgs);
    assert.sameValue(Object.getPrototypeOf(result), construct.prototype, description);
    resultAssertions(result);
  }
  ...
}
```

`construct` and `constructArgs` both arrive as PARAMETERS, forwarded through
TWO layers of `...args` rest/spread (`checkSubclassingIgnored(...args) {
this.checkSubclassConstructorNotObject(...args); }`). All **45**
`built-ins/Temporal/**/subclassing-ignored.js` test262 files hit this on
their first assertion — pinned in #5383's S30 findings (`p2` probe: `c=function
cProto=undef … instT=null resT=null`) and named as the "R-construct" residual
in #6620.

## Root cause

Two separate arms both had to decline for this shape to have NO lowering at
all:

1. **`tryCompileNativeConstructFromValue`** (`src/codegen/expressions/new-super.ts`)
   admits a spread call site via `flattenCallArgs`/`resolveStaticSpreadArgs`,
   but those only resolve a STATICALLY-KNOWN arity (an inline array literal,
   or — since #6460 — a named local traced back to one). For a genuinely
   runtime-length spread (a parameter), both always decline, and the function
   unconditionally gave up right there:

   ```ts
   if (args.some((a) => ts.isSpreadElement(a))) return undefined;
   ```

   This declined for EVERY admission reason the function supports — including
   the member-access dynamic-ctor arm (`dynamicMemberCtorValue`,
   `resolvesToDynamicAnyCtorValue`) that ALREADY works correctly for a fixed
   arity (#6607/#6611/#6616's own fixes).

2. **`emitDynamicNewFallback`**, the only OTHER standalone dynamic-`new`
   fallback, also declines whenever the callee is not a LOCAL class
   (`candidates` are built purely from `ctx.classObjectGlobals` — module-local
   compiled structs — never a linked-provider class), and it is not even
   REACHED for a MEMBER-ACCESS callee in standalone at all (`dynMemberCallee`
   in `compileNewExpression` requires `!noJsHost(ctx)`, i.e. JS-host only).

So a construct through a foreign/linked class value, fed a runtime-length
spread, fell all the way through to the pre-existing `__new_${ctorName}`
unknown-ctor import fallback — registered only for genuine host builtins like
`Test262Error` — which has no entry for the class's name, and the site
compiled to a bare `ref.null.extern`. For the shapes that instead reached a
`self = Object.create(proto)`-only tail (a class the module already knew how
to identity-dispatch on some OTHER path), the result was an object with none
of the constructor's own field data.

## Fix

`native-construct.ts`'s existing `__class_construct_dispatch` and
`__js2wasm_link_construct` terminals were ALREADY arity-generic — they accept
`(callee, argsVec, argc)`, and the fixed-arity drivers' own `buildArgsVec()`
already builds that `argsVec` (an externref `$ObjVec`,
`__extern_length`/`__extern_get_idx`-readable) from N FIXED locals. The
missing piece was purely at the CALL SITE: a way to build that same `argsVec`
from a call whose length is only known at runtime.

- **`reserveNativeConstructDriverArgv` / `fillArgvConstructDriver`**
  (`native-construct.ts`) — ONE new driver per module (not per-arity),
  `(callee, proto, argsVec, argc) -> externref`. Its body is a deliberately
  NARROWER twin of the fixed-arity body: the class-construct and
  boundary-construct arms pass `argsVec`/`argc` straight through (no rebuild
  needed — they are already in the right shape), the §13.3.5.1 IsConstructor
  guard is reused unchanged, and the ordinary tail unconditionally calls
  `__apply_closure` (no `__call_fn_method_<N>` fast path — arity is unknown
  at compile time; this is the SAME choice the existing >8-arity
  `highArityApplyTail` already makes). The Proxy-identity arms are
  deliberately OMITTED — a runtime-length spread into a Proxy constructor is
  out of this slice's scope; declining there just keeps the pre-existing
  answer for that one shape, not a regression.
- **`buildRuntimeConstructArgvVec` / `compileNativeConstructRuntimeArgv`**
  (`expressions/new-super.ts`) — builds the runtime `argsVec` at the call
  site: a positional argument pushes directly via `__objvec_push`; a
  `SpreadElement`'s source is copied element-by-element via the generic
  `__extern_length`/`__extern_get_idx` reader pair (the same protocol
  `Object.groupBy`'s native helper already uses for an arbitrary array-like
  source), so an untyped JS array PARAMETER works — not only a
  compile-time-typed vec. Reuses the exact same prelude the fixed-arity path
  already runs (late-import registration, `markClassValueConstructSite`,
  `armConstructIsConstructorGuard`, the ref/f64 lenient-marshal arming).
- The decline in `tryCompileNativeConstructFromValue` is now conditional:
  `noJsHost(ctx)` (standalone/WASI) routes through the new argv driver
  instead of giving up; the JS-host lane is UNCHANGED (`!noJsHost(ctx)`
  still declines here — it already constructs a genuinely-dynamic spread
  correctly through `__construct_closure`, which accepts an ordinary JS
  array built from any spread).

## Measured (2026-09-16)

### Synthetic reduction (no Temporal, a small linked pair; `tests/issue-6621-dynamic-new-runtime-argv-spread.test.ts`)

By file-copy revert of `native-construct.ts` + `expressions/new-super.ts`:

| probe | base | branch |
| --- | --- | --- |
| `new construct(...constructArgs)`, both PARAMETERS (the exact `checkSubclassConstructorNotObject` shape) | `null/-/-` | `object/7/PD7` |
| same, a rest-param spread (`function dynNew(C, ...a) { return new C(...a); }`) | `null/-/-` | `object/8/PD8` |
| control: fixed (non-spread) argument, same callee | `object/9/PD9` | unchanged |
| control: direct member-access, no spread | `object/10/PD10` | unchanged |
| control: a STATICALLY-flattenable literal-array spread (`new NS.PD(...[11])`) | `object/11/PD11` | unchanged |

Witness: `tests/issue-6621-dynamic-new-runtime-argv-spread.test.ts`, 5 `it`s —
2 fix-witnesses measured FAILING on the file-copy-reverted base
(`expect(out).toBe(...)` against `object/N/PDN` observed `null/-/-`), 3
controls pass on both trees unchanged. Run against the full `tests/issue-66*.test.ts`
set (23 files, 104 tests): all pass together, ~136 s wall, no OOM.

### Four-family sample — 120 rows each, `--target standalone`, real polyfill linked, sequential, fresh cache, solo

| family | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 110 | 111 | +1 | 0 | 1 |
| `Duration/**` | 102 | 104 | +2 | 0 | 2 |
| `PlainDateTime/**` | 112 | 112 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **427** | **430** | **+3** | **0** | **3** |

The three fail→pass rows: `PlainDate/argument-convert.js`,
`Duration/infinity-throws-rangeerror.js`,
`Duration/negative-infinity-throws-rangeerror.js`. No `compile_error`, no
`timeout`, no `__temporal_*` host-import leak in any of the 480 rows (base or
branch).

### The 45-file target family — does NOT move, and the reason is verified directly, not assumed

**0 → 0 pass, corpus-wide, both labels.** This is expected, not a failure of
the fix — verified with a debug throw injected into a COPY of the real
`test262/harness/temporalHelpers.js`'s `checkSubclassConstructorNotObject`
(never the shared submodule checkout), immediately after
`new construct(...constructArgs)`:

| | base | branch |
| --- | --- | --- |
| `typeof instance` | `object` | `function` |
| `Object.getPrototypeOf(instance)` | `null` | `object` |
| `Object.getPrototypeOf(instance) === construct.prototype` | `false` | **`true`** |
| `instance instanceof construct` | `false` | `false` |
| `instance.years` (a real constructor field) | `undefined` | **`0`** (real) |

`new construct(...constructArgs)` now genuinely constructs — real field
data, correct prototype link — where base produced a bogus, field-less
placeholder. The family's headline stays at 0 because the NEXT assertion
(`Object.getPrototypeOf(instance[method](...methodArgs))`) is blocked by a
SEPARATE, PRE-EXISTING mechanism: a dynamically-constructed class value's
`typeof` misreports `"function"` and `instanceof` still answers `false` —
present identically on the UNFIXED base tree for the ALREADY-WORKING
no-spread/member-direct construct paths too (verified: `param-callee-no-spread`
and `member-direct` in the synthetic census below both already answer
`typeof` `"function"` on base). This matches S20 §4's already-documented
residual ("a per-name ladder with no runtime class test … pre-existing and
untouched by S20 … the next slice, and the first one where the fix is in the
hottest dispatch path in the compiler") — not a new defect this slice
introduces or is scoped to fix.

### Census (per the S34 brief) — which spellings answer null vs an instance

No link, one module, a LOCAL class (`.tmp/s34/nolink.mjs`):

| spelling | base | branch |
| --- | --- | --- |
| `function dynNew(C, ...a) { return new C(...a); }` | `object/L5` | unchanged |
| `new C(1)` (no spread) | `object/L1` | unchanged |
| `const K = C; new K(1)` | `object/L1` | unchanged |
| `new (o.C)(1)` | `object/L1` | unchanged |
| `function dynNew(C, a) { return new C(...a); }` with a literal array | `object/L5` | unchanged |

**Every LOCAL-class spelling already worked, with or without this fix** —
`emitDynamicNewFallback`'s own runtime-argv path (a SEPARATE mechanism, built
on `$ObjVecArr`, not this fix's `$ObjVec`) already served the local-class
case; `candidates.length > 0` there, so it never reached the decline this
issue fixes. This bounds the fix precisely: it is reached ONLY when the
callee is NOT a local class.

Across a synthetic link (`.tmp/s34/link-repro.mjs`, provider `PD`):

| spelling | base | branch |
| --- | --- | --- |
| param callee + rest-param spread | `null/-` | `function/2000` |
| param callee + fixed args (no spread) | `function/2000` | unchanged |
| `const C = Temporal.PlainDate; new C(...)` (no spread) | `object/-` | unchanged (#6611's pinned, DIFFERENT, arity-independent mechanism — out of scope) |
| `new Temporal.PlainDate(...)` direct (no spread) | `function/2000` | unchanged |
| member-access callee + rest-param spread | `null/-` | `function/2000` |
| param callee + array-param spread (the exact harness shape) | `null/-` | `function/2000` |

(`typeof` reading `"function"` for a successfully-constructed linked value —
present on BOTH trees for the already-working no-spread cases — is the same
pre-existing residual named above, not something this fix changes.)

### Controls

**Must-not-move — 1,684 rows, four groups, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 1,250 | 1,125 | 1,125 | 0 |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 205 | 179 | 179 | 0 |
| `language/expressions/new` (150) + `Reflect/construct` + `statements/class/subclass` (100) | 169 | 120 | 120 | 0 |
| `built-ins/TypedArrayConstructors/ctors` (60) | 60 | 34 | 34 | 0 |

**Targeted byte A/B** (`.tmp/s34/targeted-bytes.mts`, one linked-free
module, three cases): the ARMED case (a spread through a param callee into a
LOCAL class) is the only one that moves — standalone `140670 B → 140620 B`;
an unarmed no-spread control and an unarmed no-class control are
byte-identical on both labels. Every `gc`-lane artifact, all three cases, is
identical.

**Corpus byte A/B**: 42 `website/playground/examples` + `tests/fixtures`
modules × {gc, standalone} = 84 artifacts, **0 moved** — a null control (no
module in that corpus constructs dynamically with a runtime-length spread
into a foreign ctor); the targeted byte check above is what shows the change
does anything.

**Temporal provider artifact**: `3,311,544 B` on BOTH labels —
byte-identical, `cacheHit=false` on both fresh prewarms. Correctly so: the
fix is reached only by a CONSUMER's dynamic construct through a
non-statically-resolvable spread, and `@js-temporal/polyfill`'s own compiled
body has no such site.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly, on the branch tree (`npm run -s test:equivalence:gate`).

## Residuals — named, not chased this slice

- **The `typeof`/`instanceof` misclassification of a dynamically-constructed
  class value** is what actually blocks the 45-file family now (see
  "Measured" above). Matches S20 §4's already-documented "per-name ladder,
  no runtime class test" residual. Sizeable and in the hottest dispatch
  path in the compiler — not attempted this slice.
- **R-other-bare-ref-test** (#6620) is unrelated and untouched by this slice.
- `const C = <linked class>; new C(...)` (a bound identifier, NOT a member
  access, NOT a parameter) remains #6611's pinned, arity-independent,
  DIFFERENT mechanism — confirmed unaffected by this fix (see census table
  above).

## Traps, carried forward and added to

Everything in S26–S33 still holds. One addition:

- **Two arms both had to decline for a shape to have NO lowering — check
  the WHOLE fallback chain, not just the first decline.** `emitDynamicNewFallback`
  is a real, working fallback for a runtime-length spread, but only for a
  LOCAL class; `tryCompileNativeConstructFromValue`'s decline for the SAME
  shape, for a FOREIGN class, fell through to nothing (a member-access
  callee never even reaches `emitDynamicNewFallback` in standalone at all).
  Reducing the census by LOCAL-class spellings alone would have reported
  "already works" and missed the actual corpus blocker entirely.
- **A corpus-wide "0 → 0" result needs its OWN direct verification, not an
  inference from the unchanged pass count.** The 45-file family's headline
  staying flat could mean "the fix did not work" or "the fix worked and a
  DIFFERENT blocker is now first" — indistinguishable from the pass/fail
  column alone. Injecting a debug throw into a disposable COPY of the real
  harness (never the shared `test262/` submodule checkout) is what told
  them apart here.
