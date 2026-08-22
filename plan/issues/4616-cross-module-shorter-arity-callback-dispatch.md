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
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/extern-declarations.ts::registerNodeBuiltinImports
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/closures/callback-classification.ts::isHostCallbackArgument
  - src/codegen/registry/imports.ts::addUnionImports
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/literals.ts::compileObjectLiteral
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/calls-guards.ts::isEvolvingAnyBinding
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/literals.ts::objectLiteralSpreadTakesHostPath
  - src/runtime.ts::_structFieldNamesRaw
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
