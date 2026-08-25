---
id: 4616
title: "typed callback call sites throw for shorter-arity callbacks compiled in later modules — jest diff-sequences cluster"
status: in-progress
sprint: current
created: 2026-08-22
updated: 2026-08-22
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures, functions
goal: npm-library-support
related: [4614, 2873, 1131]
files:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/expressions/identifiers.ts
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/context/types.ts
  - src/codegen/closures/callback-classification.ts
  - src/codegen/registry/imports.ts
  - src/import-resolver.ts
  - src/codegen/closures.ts
  - src/codegen/function-declaration-observation.ts
  # cookie-suite root causes (slices 5-8 below): Date-ctor dynamic dispatch,
  # ref-elem HOF host-lane widening, deferred-init non-callable fold,
  # field-name CSV comma escaping.
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/calls-guards.ts
  - src/codegen/struct-field-exports.ts
  - src/runtime.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#92
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/extern-declarations.ts::registerNodeBuiltinImports
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/closures/callback-classification.ts::isHostCallbackArgument
  - src/codegen/registry/imports.ts::addUnionImports
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/literals.ts::compileObjectLiteral
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/calls-guards.ts::isEvolvingAnyBinding
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/literals.ts::objectLiteralSpreadTakesHostPath
  - src/codegen/expressions/calls.ts::calleeMayBeHostCallable
  - src/runtime.ts::_structFieldNamesRaw
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
coercion-sites-allow:
  # The cookie Date-constructor bridge must unbox the host-provided numeric
  # timestamp before entering the existing date parser ABI.
  - src/codegen/expressions/new-builtin-globals.ts
---

# shorter-arity callbacks from later modules miss the funcref dispatch

## Problem

jest's diff-sequences declares `foundSubsequence(nCommon, aCommon, bCommon)`
(3 params) while every upstream test passes a 1-param arrow
(`(nCommon) => { n += nCommon; }`) — legal JS (surplus arguments ignored).
The typed-signature call-site lane builds its funcref dispatch cascade from
(a) the declared signature's wrapper type plus return variants and (b) a scan
of `ctx.closureInfoByTypeIdx` retaining SHORTER-arity closures — but (b) only
sees closures **already compiled**. A callback defined in a LATER module
(diff-sequences' index.ts compiles before the test module that defines the
arrows) is invisible, its funcref type never becomes a dispatch arm, and the
cascade's terminal throws TypeError ("Cannot access property on null or
undefined"). Reduction: `tests/issue-4616-shorter-arity-callback.test.ts`.

## Fix (landed)

Eagerly create the shorter-arity PREFIX wrapper types
(`sigParamWasmTypes.slice(0, k)` for k < sigParamCount × {declared, externref,
void} returns) as dispatch candidates. `getOrCreateFuncRefWrapperTypes` is
get-or-create/canonical, so the later-compiled closure reuses the identical
funcref type and the existing per-candidate arm (which marshals only the
candidate's formal prefix and packs surplus into `__extras_argv`) matches.

## Remaining (this issue stays open)

The full generated diff-sequences test module STILL fails its callback tests
(15/48) with order-sensitive behavior:

- Unmodified module: `dereferencing a null pointer` inside `diffSequence` —
  a guarded wrapper-root cast nulls for a callback value (the #2873 family:
  wrapper hierarchy/order); inserting an unrelated export that calls
  `countCommonStrictEquality` directly makes the trap vanish.
- With the trap gone, `countCommonStrictEquality([0], [-0])` answers 0
  (want 1): the 2-param `isCommon` callback either never runs or its boxed
  `0 === -0` comparison misanswers **in this module only** — the standalone
  reduction (`Array<unknown>` element compare) answers `true` correctly.

Both need the wrapper-family/order investigation (why a cast to the wrapper
ROOT can null for a same-program closure), not more candidate seeding.

WAT finding (2026-08-22, dstest2 probe): in the FULL generated module, a
`diff(a.length, b.length, arrow1, arrow2)` call site compiles to TWO
`__make_callback(id, closure)` registrations and NO call at all — the arrows
were classified as HOST callback arguments (`isHostCallbackArgument`:
`funcMap.get("diff")` misses — the alias registration maps the local default-
import name only in some module layouts — and the #1300 checker
`getCallSignatures` fallback apparently also missed here), and the callee
itself resolved to nothing, so the whole call was dropped. `isCommon` call
count measured 0. The SAME import + call shape in a small two-module
reduction compiles to a direct `diffSequence` call and passes. So the
residual is: (a) why `diff` resolves in small modules but not inside the
63-test generated module (suspect: compile order of the alias registration
vs the __diag/test bodies, or prelude interference), and (b) the
order-sensitive wrapper-root null in the layout where the call DOES go
through (`__call_fn_method_1` dynamic chain).

## 2026-08-22 third slice — ROOT CAUSE of the diff-sequences trap: closureMap bare-name leakage

The "wrapper-family/order investigation" above was a red herring (a binary
type-section parse bug produced a phantom "four parentless roots" claim — a
corrected parser that exactly consumes the section shows exactly ONE root, so
the #2873 single-root invariant HOLDS). The real defect, pinned by decoding
the trap pc (0xcecf → `call_ref` on a null funcref, matched func type =
`(ref null $root) -> void`, 0 user params):

`ctx.closureMap` is keyed by BARE NAME across the whole linked module graph.
The upstream tests declare local noops `const foundSubsequence = () => {}`;
`compileLiftedClosureBody`/`registerClosureBindingInfo` registered that
0-arity ClosureInfo under the bare name. The UNRELATED 3-arity function
PARAMETER `foundSubsequence` in `diffSequence` then hit that entry by name
(`localBindingShadowsCapturingFunction` only guards against `funcMap`
collisions), compiled both its calls as single-candidate 0-arg `call_ref`
(all 3 args packed as extras), and the guarded funcref cast nulled for every
real callback. `emitNullCheckThrow`'s guarded-cast backup arm deliberately
does NOT throw when the pre-cast value is non-nullish ("wrong struct type —
don't throw"), so execution fell through to `call_ref` with a NULL funcref →
un-catchable "dereferencing a null pointer". The same leak hit the inner
wrapper arrow's call through the DESTRUCTURED `const {foundSubsequence} =
callbacks[...]` binding (a `BindingElement`).

Fix (call-identifier.ts): a callee whose `oracle.valueDeclarationOf` is a
`Parameter` or `BindingElement` never takes the by-name `closureMap` entry —
those binding kinds never register there, so any hit is another binding's
info. They fall through to the typed callable-param dispatch, which builds
candidates (incl. the slice-1 arity prefixes) from the DECLARED signature.

Measured: diff-sequences module 15 → 43/48 (all null-deref traps gone;
residual: 1 expected-throw, 2 boolean-array toEqual, 2 need a snapshot
adapter — harness gap). jest suite 163 → 191/232. acorn 3518/3518, cookie
63670/63740, clsx 31/32 all hold. The "dropped call/__make_callback" WAT
finding above was an artifact of a broken relative import in the probe copy —
the original module resolves `diff` fine.

## 2026-08-22 fourth slice — the `test.each` call-of-call idiom (isError cluster)

The 20 `%p` failures in jest-util/expect-utils `isError.test.ts` are the
harness shim idiom `test.each(cases)(name, body)`, which hit three defects:

1. **Host-callback misclassification on call-of-call** — for an arrow argument
   whose callee is a CallExpression (`each(cases)(name, arrow)`),
   `isHostCallbackArgument` had no carve-out and returned true; the arrow was
   wrapped in `__make_callback`, the receiving closure's guarded root cast
   nulled, `call_ref` trapped. Fix: when `ctx.oracle.signatureOf(directCallee)`
   shows the invoked value is callable, it is a compiled closure — closure path
   (mirrors the #1300 identifier carve-out).
2. **Declared-rest callback param compiled as one positional VEC slot** —
   `body: (...args: unknown[]) => void` made `body(row)` coerce its single arg
   INTO a vec and match only a `(vec)->void` wrapper no fixed-arity arrow can
   satisfy. Fix (call-identifier lane): expand the rest slot to one externref
   per call-site arg **+2** (a table callback can declare more formals than one
   site passes — extras read `undefined`), so the declared/prefix candidates
   match fixed-arity callbacks. A true rest-compiled closure still gets surplus
   args via `__argc`/`__extras_argv`.
3. **Duplicate `env::__box_number` adapter import** — `ensureLateImport`
   registered the helper individually, then a vec→vec coercion's
   `addUnionImports` blindly re-added the whole family; the module linked but
   the adapter-manifest validator refused it ("duplicate adapter import ...
   appears 2 times"). Fix: `addUnionImport` wrapper skips names already bound
   to an import (their pre-`importsBefore` indices sit below the shift range,
   so delta bookkeeping is unchanged).

**The isError cluster's ACTUAL blocker was simpler**: `import {isNativeError}
from 'node:util/types'` — `util/types` was missing from `NODE_BUILTIN_MODULES`
(import-resolver.ts), so jest-util's `isError` (which delegates to it —
`Error.isError` is absent on Node 22) bound to nothing and every call threw
"null is not a function". One set entry fixes 0/20 → 20/20 (the runtime
adapter `require()`s the specifier verbatim, same as stream/web,
fs/promises). The three call-of-call fixes above are real and guarded by
`issue-4616-test-each-idiom.test.ts`, but were not what isError needed.

Still open in this family: reading `.each` off the function object
(`(test as any).each([..])(..)`) dispatches through the host bridge's
`__call_fn_method_N`, whose per-entry arm HARD-casts an externref arg to a
concrete vec param (`externToClosureParamRef`) — a wasm vec marshalled to a JS
array on the way out fails that cast ("illegal cast", un-catchable). Repro:
`.tmp/probe-each12.mts` case 4/5. Needs a guarded cast + vec materializer in
closure-exports.ts, or arg-identity preservation in the dynamic bridge.

## Acceptance criteria

- [x] Cross-module shorter-arity callback reduction round-trips.
- [x] jest diff-sequences upstream file ≥ 40/48 (43/48).

## 2026-08-22 second slice — node-builtin NAMED imports are member reads

jest-docblock's 18 failures were `import { EOL } from 'os'` binding the local
name to the `__node_os` MODULE thunk (`registerNodeBuiltinImports` registers
`localName` = first named binding), so `${EOL}` concatenated
"[object Object]". Named bindings now register per-member (`declaredGlobals`
gained `member?`), and the identifier read emits
`__extern_get(__node_<mod>(), member)` — general for any named node-builtin
value import, platform-correct (reads the real `os.EOL`). jest-docblock
21 → 39/39; jest suite 145 → 162/232. Guards green: #1044, #1792, #1794,
#2699 (class bindings keep extern-class stubs, fn bindings their
`__nodefn__` wrappers; member registration skips names already bound).

## 2026-08-22 fifth-eighth slices — cookie 63671 → 63740/63740 (100%)

Cookie's last 69 upstream failures dissected into FOUR independent compiler
bugs, each general (nothing cookie-specific), each with a committed reduction
in `tests/issue-4616-cookie-suite-fixes.test.ts` (4 tests) plus
`tests/issue-4616-date-carrier-toprimitive.test.ts` (2 tests):

5. **`new Date(x)` with a dynamic single arg ToNumbered strings to NaN**
   (§21.4.2.1 wants ToPrimitive-then-branch). parseSetCookie's untyped
   `new Date(val)` produced an invalid date, `Number.isFinite(date.valueOf())`
   gated `expires` out of every parsed Set-Cookie. Fix: host-lane runtime
   dispatch in new-builtin-globals.ts — `__typeof_string(arg)` ? call
   `__date_parse_host` : `__unbox_number` (both registered up front:
   import-collector now also sets `dateParseHostNeeded` for
   any/unknown/union-with-string single args; `isDynamicMaybeStringArg` uses
   `ctx.oracle.typeFactOf`). Standalone/wasi keep prior behavior.
   Also landed (earlier, same family): the `$Date` carrier now answers the
   generic ToPrimitive protocols — `_wasmDateToPrimitive` wired into BOTH
   `_toPrimitive` and `_hostToPrimitive` (the `__to_primitive` env import
   funnel), and the dynamic `constructor` read answers host `Date`
   (jest-get-type 'date'; `+d1 === +d2` on carriers).
6. **Array HOFs on typed ref-element receivers silently no-opped in the gc
   HOST lane** — `hofElemKindOk` declined (`ctx.standalone || ctx.wasi` gate)
   and the generic fallback compiled `__extern_get(recv, "forEach")` + drops.
   `Object.entries(top).forEach(([domain, values]) => …)` registered ZERO
   corpus tests (52 admitted tests never ran; runner marks index-misaligned
   tails failed with null errors — that's what "failed, wasmError: None"
   means). Fix: widen the gate to the host lane, guarded by
   `hofRefElemClosureLaneSafe` — closure lane only when the callback body
   resolves every identifier to a user-source declaration or a
   native-codegen builtin (`CLOSURE_SAFE_AMBIENT_GLOBALS`), preserving the
   #2838 Temporal host-global hazard (212-test regression) as host-callback.
7. **`let x = null; … x = function(){…}; x()` compiled to an unconditional
   TypeError** — the #4221 non-callable fold's `isEvolvingAnyBinding`
   treated a nullish INITIALIZER as a type commitment even on a mutable
   binding; the harness's `__upstreamSnapshotMatcher(actual)` threw
   "is not a function" on every snapshot assertion. Fix: a nullish
   initializer on a non-`const` unannotated binding is the deferred-init
   idiom — no fold.
8. **Struct field names CONTAINING commas corrupted the `__struct_field_names`
   CSV** — the snapshot table's cookie-string keys ("Expires=Sun, 26 Jul …")
   made the host's `split(",")` re-derive phantom names: dynamic AND
   literal-key reads answered undefined. Fix: codegen escapes "," inside a
   name as U+0001 (`escapeStructFieldNameForCsv`, applied to the legacy and
   shape-id CSVs); `_structFieldNamesRaw` unescapes after the split. The
   `__sget_/__shas_/__sset_` export names keep the raw name.

Validation: cookie upstream 63740/63740 (from 63671); jest 215/232 (deep-MOP
deepCyclicCopy 11 + index 3 + convertDescriptorToString 1 + errorWithStack 1
remain, all pre-diagnosed clusters); acorn 3518/3518 and clsx 32/32 hold.
Guard batteries green: HOF (issue-3126 + array-prototype-methods +
array-callback-three-params + array-of-structs + object-keys +
reverse-struct-map — the 2 issue-3126 string[].find/findLast standalone
misses fail identically on HEAD without these changes, pre-existing), Date
(issue-2164/1343/1344/2678 — the one performance.now standalone failure is
likewise pre-existing), equivalence date/to-primitive files (57 tests).

## 2026-08-22 ninth slice — nullish/partial spread sources (jest deepCyclicCopy)

jest's `deepCyclicCopy` (`options = { ...defaults, ...options }`, `options` an
OPTIONAL param) exposed three defects in one line, all general:

1. `objectLiteralSpreadTakesHostPath` read the contextual type `Opts |
   undefined` as "non-specific" (a union's `getProperties()` is empty) and
   routed the literal to the host path — whose externref result then
   null-casted back into the struct-typed slot, so every later member read
   threw. Nullish constituents are now stripped before the check.
2. On the struct path, the spread-source `struct.get` had no null guard —
   a runtime-undefined source trapped un-catchably ("dereferencing a null
   pointer", the 5-test deepCyclicCopy trap cluster). §13.2.5.5
   CopyDataProperties skips a nullish source; both the override arm and the
   no-named-writer chain now guard on `ref.is_null` (multi-spread chains
   fall through last→first→default).
3. The spread-source TYPE resolution dropped `Opts | undefined` sources
   entirely (resolveStructName fails on unions) — the spread contributed
   NOTHING. Same nullish-strip applied; and a PARTIAL source's absent slots
   (externref undefined-singleton / f64 #866 sNaN sentinels) no longer
   clobber earlier writers (`spreadFieldReadWithAbsentFallback`). Known
   residual: an absent optional i32 boolean is indistinguishable from
   `false` (no sentinel in that rep).

Regression tests: `tests/issue-4616-nullish-spread-source.test.ts` (2).
Validation: jest 266 → 268/313 on the new wider suite (deepCyclicCopy 11→9);
cookie 63740/63740 holds; spread battery green (#2009 ×1 "named-source
spreads" and #2127 ×1 "data-property spread" fail identically WITHOUT these
changes — pre-existing, A/B'd via stash).

## 2026-08-22 tenth slice — class-method callable params can be host functions (jest Replaceable)

`Replaceable.forEach(cb)`'s `cb(...)` trapped un-catchably: a callable PARAM
of a class method receives a HOST function whenever the method is invoked
through an any-receiver dynamic dispatch (the arrow argument crosses the host
bridge) or a harness passes a jest.fn() spy. The typed callable-param
dispatch's guarded wrapper cast nulls for such a value and `call_ref` traps —
exactly the foreign-callable class #1712/#2928 already solved, but the #1941
gate (`calleeMayBeHostCallable`) excluded ALL parameters on the assumption
they are "always wrapped into the closure struct". Method params now pass the
gate in the gc host lane only; plain function params keep #1941's exclusion
(pure local-closure programs stay host-import-free, dual-mode preserved —
optimize-differential and #1712 guards green; the 6 illegal-cast-closures-585
failures are pre-existing, stash-A/B identical).

Regression test: `tests/issue-4616-method-param-host-callable.test.ts` (1).
Also root-caused this slice, no code change: the docblock `index.test.ts`
cluster (19) fails WORSE on pure origin/main src (17/39 vs this branch's
20/39) — main-side fallout of the new upstream-suite "package resolution
seams", not this branch's regression.

## 2026-08-22 eleventh slice — null-proto host objects vs the __sget probe (jest-docblock 20 → 39/39)

The docblock cluster was NOT main-side seams fallout after all (that theory
died when the in-place instrumentation ran — earlier "parse returns null"
findings were an artifact of copying the generated spec to a directory where
its RELATIVE import silently resolved to nothing). Real root:
`__extern_get` classified a genuine `Object.create(null)` HOST object as
struct-ish from its null prototype alone — the direct read was skipped and
the `__sget_<key>` struct-getter probe answered its miss-DEFAULT. The jest
harness's `{ length: count }` mock-call literals emit `__sget_length`, so
`pragmas.length` answered 0 (a number) and `__upstreamSame` took its array
arm on every docblock toEqual. Both `__extern_get` variants (resolveImport
and the pooled `extern_get` case — the pooled one was ALSO missing the
`_isWasmStruct` gate on the probe block the primary already had) now gate on
`_isWasmStruct`, whose extensibility+opaqueness probe classifies null-proto
host objects correctly.

Measured: jest-docblock spec 20 → 39/39; jest suite 269/313 → 292/318
(docblock now fully admitted); cookie 63740/63740 holds. Guards: ts7 clean,
object-keys / hasownproperty / object-create / unknown-field-fallback /
arguments-object / #3116 green (issue-2130 ×3 pre-existing, stash-A/B
identical). Regression test:
`tests/issue-4616-null-proto-host-object-get.test.ts` (1).

## 2026-08-22 twelfth slice — computed-key literal local typing lockstep (jest Replaceable + queueRunner)

`{ a: 1, b: 2, [symbolKey]: 3 }` routes its VALUE to the host plain-object
path (#2126 runtime computed key), but the un-annotated LOCAL's slot stayed
struct-typed — the store null-cast, so in the lifted-closure it-lanes the
whole literal read back as NULL (`new Replaceable(object)` → getType(null) →
"Type null is not support"). The variable-declaration local typing (and the
generator/async spill twin) now consult the SAME predicate as the literal
routing — `objectLiteralForcesHostPath`, extracted from compileObjectLiteral's
accessor/disposal/computed-key/empty-key gate (#2804 lockstep discipline).

Measured: jest 292/318 → 314/331 (Replaceable 15→17/17 and ALL 6 queueRunner
tests flipped with it); cookie 63740/63740 and clsx 32/32 hold; ts7 clean;
computed-property/object-literal-accessor/symbol guard battery green (33).
Regression test: `tests/issue-4616-computed-symbol-key-local.test.ts` (1).

## 2026-08-22 thirteenth slice — §10.2.9 name stamps at closure/class materialization (partial)

`convertDescriptorToString(fn).name` read undefined for compiled function
values crossing modules — the #3429 stamp only fired at specific
host-delegated CALL sites. Now stamped ONCE at materialization (host lane):
a NAMED function expression's closure stamps `.name` into its sidecar in
compileArrowAsClosure, and the class-object singleton stamps the declared
class name in emitLazyClassObjectGet (synthetic `__…` names excluded).
jest convertDescriptorToString 9 → 10/11; the residual is the INLINE
`class Named {}` VALUE (array-literal element — materializes via a different
lane than the class-object singleton) and bare function-declaration `.name`
reads (localName probe) — both still undefined, parked here. #3429 guards
fail 4/4 identically on base (pre-existing).


## 2026-08-22 residual inventory after slices 5-13 (jest 113 → 315/331)

Curated scoreboard: acorn 3518/3518 · cookie 63740/63740 · clsx 32/32 ·
jest 315/331 (95.2%). The 16 jest residuals, each pre-diagnosed:

- deepCyclicCopy (7): jest.fn()-in-accessor getter copy (null-deref via the
  spy lane), and the keepPrototype family (`Object.create(getPrototypeOf(o))`
  / `new (getPrototypeOf(arr).constructor)(n)` — prototype-chain MOP; 2 of
  them stack-overflow through __call_fn_method recursion).
- diff-sequences index (3): 1 expected-throw + 2 boolean-array toEqual
  (the #2873-family order-sensitive residual documented in slice 3).
- pTimeout (3): setTimeout/clearTimeout identity counting + async timers.
- convertDescriptorToString (1): INLINE `class Named {}` VALUE (array-literal
  element) — materializes via a lane the slice-13 class-object stamp does
  not cover.
- errorWithStack (1): Error.captureStackTrace invalid-argument family.
- globals (1): `Object.prototype.toString.call(process)` → "[object Null]"
  (host `process` toStringTag through the sandbox).

uuid (10/75) is #4383, CLAIMED by ttraenkler/codex since 2026-08-12 (claim
ref verified; parallel implementation is a pre-dispatch BLOCKER). react-dom
infra is the same lane's.

## 2026-08-22 fourteenth slice — `process` host-global + named class-expression `.name`

1. Bare `process` fell to the graceful-null default (`[object Null]`,
   null-deref on `.pid`). It now rides the #3087 host-global materialization
   lane (identifiers.ts) like `Buffer`. jest globals check-process passes.
2. The slice-13 residual — INLINE `class Named {}` VALUES — is closed:
   `stampClassExprName` (new-super.ts) stamps the declared name in BOTH arms
   of `compileClassExpression` (synthetic-name arm from `expr.name`, the
   named-collection arm from the collected className).
   convertDescriptorToString 10 → 11/11.

Measured: jest 315 → 317/331. Regression test:
`tests/issue-4616-process-and-class-expr-name.test.ts` (2).

## 2026-08-22 fifteenth slice — runtime internals survive a patched `Array.isArray`

jest.spyOn(Array, 'isArray').mockImplementation(compiledClosure) turned BOTH
deepCyclicCopy "does not keep the prototype by default" tests into
"Maximum call stack size exceeded": the runtime's own conversion/trampoline
helpers read the LIVE `Array.isArray`, so invoking the patch recursed
spy → `__fn_tramp_spy` → arg conversion → patched isArray → spy. runtime.ts
now snapshots `_nativeIsArray` at module load and every INTERNAL decision
(37 sites) uses it; only the user-visible `__extern_is_array` lane still
reads the live global, so the spy remains observable exactly where user code
calls `Array.isArray`.

Measured: jest 317 → 319/331 (deepCyclicCopy 7 → 5); cookie 63740/63740,
clsx 32/32 hold; ts7 clean. Regression test:
`tests/issue-4616-patched-isarray-recursion.test.ts` (1).

## 2026-08-22 sixteenth slice — `Object.getPrototypeOf` on fnctor instances

`Object.getPrototypeOf(new F())` (F a function expression) answered null:
the `__getPrototypeOf` resolver only did the native read, blind to the
fnctor instance→ctor `.prototype` link that [[Get]]/for-in already consult
via `_structUserProto`. It now resolves the explicit `_wasmStructProto`
record first, then vivifies the ctor prototype (`_getOrVivifyFnPrototype`),
so getPrototypeOf(new F()) === F.prototype (§20.2.4.3) and
`Object.create(getPrototypeOf(x))` round-trips.

Suite score UNCHANGED (319/331) — the remaining deepCyclicCopy
keepPrototype failures are a DIFFERENT defect, pinned by in-place suite
instrumentation: `deepCyclicCopyArray(array: Array<T>)` has a vec-typed
param ABI; with `Array.isArray` spied to lie, a fnctor-instance STRUCT is
routed into it, the guarded vec cast nulls, and the module's inner
`Object.getPrototypeOf(null)` throws "Cannot convert null to object". A
fix needs param-ABI widening when a call site's argument is not provably
an array (value-rep territory), not a runtime patch. Guards: acorn
3518/3518 holds; #1712/#2739/#3123 battery and the
#1462/#1472/#1516/#2026 getPrototypeOf battery fail identically on base
(pre-existing, A/B'd via file-copy). Regression test:
`tests/issue-4616-fnctor-getprototypeof.test.ts` (2).

## 2026-08-22 residual inventory after slices 5-15 (jest 113 → 319/331, react measured)

Curated scoreboard: acorn 3518/3518 · cookie 63740/63740 · clsx 32/32 ·
jest 319/331 (96.4%) · react 81/146 scored (126 harness-incompatible).
The 12 jest residuals:

- deepCyclicCopy (5): spy-in-accessor getter copy (null-deref via the spy
  lane); prototype-identity MOP (`Object.getPrototypeOf(copy)` equal/unequal
  assertions — 2 "unexpected equal value"); keepPrototype=true
  `Object.create(Object.getPrototypeOf(o))` → "Cannot convert null to
  object" (getPrototypeOf answers null for the compiled copy) ×2.
- diff-sequences index (3): 1 expected-throw + 2 boolean-array toEqual
  (the #2873-family order-sensitive residual, slice 3).
- pTimeout (3): setTimeout/clearTimeout identity counting + async timers.
- errorWithStack (1): Error.captureStackTrace invalid-argument family.

react 63 fail buckets (single 13 MB module, 44 batches, validates):
ReactChildren 18 · ReactES6Class 13 · ReactStrictMode 12 · ReactJSXRuntime 6 ·
ReactCreateElement 5 · ReactElementClone 5 · JSXTransformIntegration 2 ·
PureComponent 2. Top error shapes: "expected not null" (13), inner
function-declaration `.name` reads undefined (probe: passing an inner
function decl as a VALUE yields `function:undefined` — the slice-13 parked
localName gap), "X is not defined" ReferenceErrors for test-body inner
components (7), mock-arg/count mismatches (12), proxy ownKeys
non-extensible trap (6), null setState (2).

uuid (10/75) is #4383, CLAIMED by ttraenkler/codex since 2026-08-12 (claim
ref re-verified 2026-08-22; parallel implementation is a pre-dispatch
BLOCKER). react-dom infra is the same lane's.

## 2026-08-22 cross-lane regression note — main's 09d00a3c broke 6 tests this branch had fixed

After merging origin/main (through f2802c33) into the #4728 branch, jest
reads 315/349: the denominator widened 331 → 349 (main's runner admitted
prompt/expectationResultFactory/queueRunner files; 16 of the new tests
fail), and SIX tests this branch had fixed regressed to "dereferencing a
null pointer" traps: Replaceable object/array/map forEach +
nonenumerable (the slice-12/28 wins) and deepCyclicCopy keepPrototype ×2
(the slice-15 wins). Verified: all six fail IDENTICALLY on PURE main src
(git checkout f2802c33 -- src → 225/349), so they are main-side breakage
from 09d00a3c ("fix(jest): bridge wasm callbacks in upstream prompt
tests", codex lane) — its rest-param candidate machinery
(`__restFuncTypeIdxs` pre-scan in calls.ts + rest-packing dispatch arms)
composes with the callback dispatch these tests exercise. NOT a
merge_group risk for #4728 (the regression gate diffs against main,
where they already fail; this branch is +90 vs main's 225). Disabling
the candidate-scan rest admission alone does NOT recover them (A/B'd:
same 315/349) — the breakage is in the calls.ts dynamic-call-emitter
rest arms or the closures.ts wrapper-sig change. Winning them back needs
a joint look at 09d00a3c's rest lanes vs this branch's slice-17
call-site rest expansion — flagged for the jest-arc owner; the two lanes
are now actively colliding on the same seam (lane-partition escalation).

## 2026-08-23 slice — deepCyclicCopy triple: inline member-access `new`, rest dynamic dispatch, method-local hoist

Three independent defects sat under the deepCyclicCopy bucket (7 tests, all
"dereferencing a null pointer"); each is fixed and regression-tested in
`tests/issue-4616-rest-dispatch-inline-new.test.ts`:

1. **Inline member-access ctor `new`** — `new (Object.getPrototypeOf(arr)
   .constructor)(n)` (jest-util deepCyclicCopyArray's keepPrototype lane) kept
   the ctor inside the callee, so the bare-identifier dynamic-new arm never
   fired and the legacy `__new___unknown` import constructed garbage
   (len=undefined, isArray false). `resolvesToDynamicAnyCtorValue`
   (new-super.ts) now admits property/element-access callees whose type fact
   is any/unknown/`Function`; the ~4656 call-site gate admits them on the JS
   host lane, and `emitDynamicNewFallback`'s zero-candidate refusal is lifted
   when the `__construct_closure` base applies (class-free modules land
   directly on the bridge, tag stays -1).

2. **Rest-param closures in dynamic dispatch** — `function spy(...args)` lifts
   to the same `(self, vec) → res` funcref as a genuine one-vec-param fn, so
   `tryEmitInlineDynamicCall`'s positional arm cast call arg 0 to the vec type
   (`illegal cast` for every `f(1,2)` through an any binding — vi.fn's spy).
   Rest candidates (`ClosureInfo.hasRestParam`, #4394) now keep their own
   arms guarded by their CONCRETE struct type, emitted outermost, packing
   `args[fixed..]` into a fresh vec (calls.ts); same-signature positional arms
   stay in the chain. Capture-free singletons had NO rest-flagged ClosureInfo
   at all — `ensureFuncClosureSingleton` (method-trampolines.ts) now allocates
   a rest-marker SUBTYPE (base fields + immutable f64 — f64 so it cannot
   canonicalize with the constructible i32-marker subtype) registered with
   `hasRestParam`, riding the existing #4437 alloc/metaInit mechanism.

3. **Object-literal method local hoist order** — literals.ts hoisted nested
   functions BEFORE pre-allocating var/let/const method locals, so a nested
   fn's capture of a method local (`vi.fn`'s `callList`) hit
   `localIdx === undefined` in the capture scan and was silently dropped —
   the compiled spy read `callList` as ref.null (`null.push`). The method
   lane now runs `hoistVarDeclarations` + `hoistLetConstWithTdz` first,
   mirroring function-body.ts.

**Also fixed on this seam (CI red on #4728 after the earlier slice-17 push):**
the `__call_fn_N` host-callable terminal made every host-lane module import
`__call_function_<N>`, which (a) broke manual-instantiation equivalence tests
(optimize-differential: "function import requires a callable") — the
`tests/equivalence/helpers.ts` compact runtime now provides the host-call ABI
via the production resolver, mirroring its #3529 Error-ctor overlay — and
(b) tripped the native-first host-import-policy probe — the terminal now
skips `semanticProviders === "native-first"` (that lane keeps the null
terminal; its classified boundary is `__boundary_callback_call_N`). The
compatibility-lane debt ratchet moved 19 → 23 (`__call_function_1..4`),
recorded in `plan/audit/host-import-policy-baseline.json`.

**Measured after this slice:** the deepCyclicCopy bucket still reads 7 in the
suite: the remaining trap is INSIDE the shim's `vi.fn` (illegal cast building
`mockClear`'s closure struct). Root cause pinned but unfixed: in untyped JS
(`allowJs`), `const callList = []` + `callList.push(args)` infers `any[][]`,
and the SAME binding gets a vec-of-vec type ($10) in the fn-decl capture lane
(spy, type from the hoisted local) but a plain extern-vec type ($3) in the
fn-expr capture lane (mockClear) — `struct.new` then casts the $10 local to
the $3 field (wasm-dis renders it `ref.cast nullref`). One binding must get
ONE canonical capture type; minimal repro: `.tmp/probe-spyon12.mts` with
`.tmp/probe-spyon10-src.js` (worker-lane options: allowJs + experimentalIR +
deferTopLevelInit + platform node). Note the cross-lane context above:
main's 09d00a3c (codex) owns a parallel rest lane; coordinate before touching
the capture-type seam.

## 2026-08-23 slice 2 — evolving empty-array hoist/statement slot-type split (jest 322 → 328/358)

The "pinned but unfixed" residual from the previous slice is FIXED, and it was
simpler than the two-lane framing suggested: not two capture lanes
disagreeing, but the let/const HOIST and the STATEMENT disagreeing about one
slot. For untyped `const callList = []` + `callList.push(args)` the checker
EVOLVES the binding to `any[][]`; `walkStmtForLetConst` resolved that evolved
type (vec-of-vec slot), while `compileVariableStatement` computed the
usage-inferred vec (`inferArrayVecType`) and RETYPED the reused slot in place
(the #962-guarded fallback arm). A nested FunctionDeclaration hoisted between
the two (jest's `spy`) had already baked the stale slot type into its lifted
signature + closure struct, so materializing it emitted an impossible cast
(wasm-dis: `ref.cast nullref`) — the `illegal cast` inside `__anon_N_fn` that
every jest.fn/spyOn test tripped.

Fix: `walkStmtForLetConst` now applies the SAME `inferArrayVecType` inference
under the same gate (empty-array initializer or `Array<any>`) as
`compileVariableStatement` and the `var` hoister — one authoritative slot
type, retype becomes a no-op. Regression test (fails on base):
`tests/issue-4616-evolving-array-hoist-type.test.ts`.

Measured: jest 322 → **328/358** (prompt bucket 4→0 — its illegal casts were
all this; deepCyclicCopy 7→5, pTimeout 3 remain but the traps are gone —
residuals are now assertion-level: prototype-identity `toBe` comparisons and
spy-count reads through the vec-copy-at-boundary shim caveat). Guards: react
109 zero-flips, acorn 3518/3518, cookie 63740, clsx 32/32,
optimize-differential + all #4616/#4618 regression tests green, equivalence
sample (array/closure/let-const) green.

## 2026-08-23 residual notes (post slice 2, jest 328/358)

- **expectationResultFactory 6** — all trap null-deref inside the per-test
  closures; a hand-rolled expectationResultFactory (destructured options,
  messageFormatter/stackFormatter, `new Error().stack`) PASSES standalone
  (`.tmp/probe-erf.mts`), so the trap lives in the compiled
  `pretty-format` import (the suite injects `__upstreamPrettyFormat` for
  exactly this file) or the snapshot matcher lane. Needs a batch-module probe.
- **queueRunner 6** — async test bodies awaiting `queueRunner(options)`
  (PCancelable + promise queue); failures carry NO error text (assertion
  with empty message or silent timeout). Needs an in-situ probe.
- **pTimeout 3 / Replaceable 4 / deepCyclicCopy 5 / errorWithStack 1 /
  diff-sequences 3** — traps are gone after slice 2; residuals are
  assertion-level (prototype identity `toBe`, spy-count reads through the
  vec-copy-at-boundary caveat, `Error.captureStackTrace` args,
  diff-sequences numeric mismatches).

## 2026-08-23 merge_group regression triage (post-#4728 merge) — two #4616 slices

Two of the three Temporal regression classes in merge_group run 32618016516
trace to #4616 slices (see #4618's triage section for the third):

1. **fedb4486 (fix 56, member-access dynamic `new`)** — the admission accepted
   `new Temporal.PlainDateTime(...)`: `Temporal` is UNDECLARED, so the member
   types error-`any` and passed the fact check; the `__construct_closure` lane
   then compiled the base identifier as an undeclared-identifier
   ReferenceError throw at module init ("Temporal is not defined", the
   156-file "other" bucket). Fixed: a member callee whose base identifier has
   NO value declaration keeps the legacy host-new lane (deferred failure —
   the assert.throws(TypeError) Temporal files pass exactly as before).
2. **03934689 (item 2, ref-elem HOF widening)** — `hofRefElemClosureLaneSafe`
   admitted `Object.entries(x).forEach(([unit, inc]) => …)` bodies capturing
   an OUTER error-`any` host value (`earlier.until(...)`); the native lane
   mis-threaded the tuple elements and the expected RangeError never fired
   (the pass→fail slice). Fixed: an outer-declared identifier whose typeFact
   is any/unknown vetoes the native lane (bindings declared inside the
   callback keep it — cookie's 63740/63740 depends on that and holds).

Validation on the follow-up branch: 30-file random Temporal sample has 0
status diffs vs pre-merge main; the named regression files pass; class/elements
25-file sample 25/25; full branch regression battery 19/19; cookie/webpack/
stylelint/clsx/jest suites re-measured green at the fixed counts.
