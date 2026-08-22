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
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/extern-declarations.ts::registerNodeBuiltinImports
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/closures/callback-classification.ts::isHostCallbackArgument
  - src/codegen/registry/imports.ts::addUnionImports
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/closures.ts::compileArrowAsCallback
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
