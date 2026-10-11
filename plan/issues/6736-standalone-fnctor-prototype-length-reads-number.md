---
id: 6736
title: "standalone: `.length` of a function's `prototype` object reads a number, so lodash's `isArrayLike(LazyWrapper.prototype)` is true and module init throws"
status: done
completed: 2026-10-05
sprint: current
created: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6713, 6711, 2580, 6751, 6861]
---

# #6736 — `F.prototype.length` answers a number in standalone

## Problem

lodash 4.18.1 npm-compat **standalone-dynamic** lane, after
[#6713](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6713-standalone-dynamic-regexp-carrier-call-construct)
(`RegExp` / Error carriers callable through a variable):

```
runtime-error (phase: module-init): TypeError: called value is not a function
```

Located with in-source step markers (a lodash copy with
`globalThis.__probeStep = N` markers, compiled standalone, no provider): module
init now runs to `lodash.js:17127`,
`baseForOwn(LazyWrapper.prototype, function(func, methodName) { … })`, and
throws inside `keys(LazyWrapper.prototype)` before the first iteratee call —
`isArrayLike(LazyWrapper.prototype)` answers **true**, so `keys` takes
`arrayLikeKeys` (never `baseKeys`), which calls a non-callable.

`isArrayLike` is `value != null && isLength(value.length) && !isFunction(value)`,
so the root is `.length` on a function's `prototype` object.

## Reduction (standalone, `runtimeEvalProvider: false`, 0 imports)

```js
var out = 0;
function ric(context) {
  var Object = context.Object;
  var objectCreate = Object.create;
  function isObject(v) { var t = typeof v; return v != null && (t == 'object' || t == 'function'); }
  var baseCreate = (function () {
    function object() {}
    return function (proto) {
      if (!isObject(proto)) return {};
      if (objectCreate) return objectCreate(proto);
      object.prototype = proto; var r = new object; object.prototype = undefined; return r;
    };
  }());
  function baseLodash() {}
  function lodash(value) { return value; }
  lodash.prototype = baseLodash.prototype;
  lodash.prototype.constructor = lodash;
  function LazyWrapper(value) { this.__wrapped__ = value; }
  LazyWrapper.prototype = baseCreate(baseLodash.prototype);
  LazyWrapper.prototype.constructor = LazyWrapper;
  var len = LazyWrapper.prototype.length;
  if (len === undefined) out += 1;
  if (typeof len === 'number') out += 2;
  if (typeof baseLodash.prototype.length === 'undefined') out += 4;
}
ric(globalThis);
export function run() { return out; }
```

Node answers **5**; standalone answers **2** (measured 2026-09-28 on
`2e23e49fb1` + #6713). A top-level variant is also internally inconsistent:
`function two(a, b) {}; var q = two.prototype;` reads `q.length === undefined`
as true (static fold) while `typeof q.length` is `"number"` (0).

## Direction

Find where a fnctor's `prototype` object answers `length` — likely the
prototype read resolving to (or inheriting from) the function carrier, whose
`length` is its arity. `F.prototype` is an ordinary object (§10.2.5
MakeConstructor), so `length` must be absent unless written. Re-run the lodash
standalone-dynamic lane for the next link.

## Implementation Plan

Executed as written.

1. **Measure where the number comes from.** Probes (`.tmp/p6736/*.js`) showed
   the bug is not specific to function prototypes. In standalone, every
   `recv.length` read on an `any` receiver goes through
   `emitStandaloneAnyLength` in `property-access-dispatch.ts`, which
   always returns `f64`. Its non-string, non-closure fallback is
   `__extern_length`, the array-like ToLength reader, so an absent `length`
   comes back as `0`. Four cases all read `0`: `id({}).length`,
   `Object.create(p).length`, `F.prototype.length`, and lodash's
   `LazyWrapper.prototype.length`. The dynamic-key spelling (`o[k]` with
   `k = "length"`) was already correct. JS-host fixed the same bug in #2580 M2
   through `emitDynGet`.
2. **Lowering.** Replace the function with `emitStandaloneAnyLengthGet` in a
   new classified module, `src/codegen/standalone-any-length.ts`. It
   returns `externref` and tries these arms in order:
   1. `$AnyString` → box(len).
   2. `__builtinfn_get_meta` hit → the metadata value.
   3. Closure → own `length` from the closure bag, else 0.
   4. `null`/`undefined` → box(`__extern_length`), same as before.
   5. `$__vec_base` → box(field 0).
   6. Anything else → `__extern_get(recv, "length")`, a real Get that walks
      the prototype chain and returns `undefined` when `length` is absent.

   Arms 1–5 return the same values as before. Every boxed-number template is
   cloned per use: the late-import shift rewrites `call` operands in place,
   so a shared `Instr` would get shifted twice.
3. **Scope.** Only the two standalone/WASI callers change (the `any`-receiver
   `.length` arm and the tuple-length externref fallback). The JS-host path is
   untouched.
4. **Acceptance.** The regression test `tests/issue-6736-any-length-absent.test.ts`
   has three cases: the issue's reduction, lodash `isArrayLike`, and a
   present/absent length matrix. It must fail on the parent and pass with the
   fix. Scoped standalone test262 (`built-ins/Function/prototype`,
   `language/statements/function` plus array-like `.length` consumers) must
   show no losses, and the lodash standalone-dynamic lane is compared before
   and after.

## Resolution

**Root cause.** The bug was broader than function prototypes. In standalone,
every `.length` read on an `any` receiver was lowered as a number, so
`{}.length`, `Object.create(p).length`, `F.prototype.length` and `(5).length`
all read as `0` instead of `undefined`. The fix is
`src/codegen/standalone-any-length.ts`, which follows the plan above.

**Regression test.** `tests/issue-6736-any-length-absent.test.ts`: 3/3 pass
with the fix. On the parent all three fail, reading `2`, `108` and `127`
(expected `5`, `127` and `511`).

**Updated test.** `tests/issue-2576.test.ts` used to pin the old lowering's
`0` for `(5).length`. It now expects `NaN`, which is `undefined` returned
through a `number` export.

**Unit tests near the change.** 15 files. The 9 failures in
`issue-1472`, `issue-2861` and `string-derived-length-fast-path` fail
identically on the parent.

**Scoped standalone test262.** 1401 rows, run in-process against the same base
(`0aeb5733bb`), parent vs fix:

| Rows | Parent | Fix |
|---|---|---|
| All 1401 | 1216 pass · 137 fail · 48 CE | 1216 pass · 137 fail · 48 CE |
| `built-ins/Function/prototype` + `language/statements/function` (760) | 711 pass | 711 pass |

The other rows cover `built-ins/Array/from`, `Array/prototype/{slice,indexOf}`,
`Object/keys` and `language/arguments-object`. Zero rows flipped in either
direction.

**JS-host.** Byte-identical binaries on the probe set; both call sites are
gated on standalone/WASI.

**lodash standalone-dynamic lane.** The lane status is `optimization-error`
both before and after:
`wasm-opt -O4 failed: unexpected expr type … Flatten.cpp:231`. That is the
#4586/#6732 retry class, and it does not change here.

The unoptimized binary (`--inspect-binary`) moves forward:

- **Before:** module init throws `TypeError: called value is not a function`
  (measured on the #6713 PR head).
- **After:** module init completes. The checksum call throws
  `TypeError: called value is not a function`, which is filed as #6751.

**Residual.** Numeric var-slot inference can still type a local that is
initialized from `v.length` as f64 when that parameter's call sites mix arrays
and plain objects. Example: `function chk(v, want){ var got = v.length; … }`,
called first with an array and then with `{}`. The value is then read as `NaN`
instead of `undefined`. Such a local was already numeric before this change.

## Reverted — 2026-09-29

The fix above (PR #6299, `4d3901d60`) is reverted. Its merge-group run
(36530835987) failed the required `merge shard reports` check on two standalone
gates, and the commit still reached `main`. Every source PR queued after it
fails the same two gates with the same numbers (for example #6303, run
36534014751, whose per-edition table is identical).

- **ES5, a completed edition, loses `harness/compare-array-arguments.js`.**
  Reproduced on `main` with `scripts/run-test262-paths.mts --standalone
  --isolate`; with only this change's two source files reverted, the row
  passes again.
- **The standalone host-free pass count falls to 41398, below the floor of
  41402** (high-water 41452 at `6d0d5c94`). The merge group for #6300, whose
  merge commit `6a7997c7c` is this change's parent, passed the floor.

### Why the ES5 row fails

The test calls `f(...fixture)` and compares `arguments` with `fixture` through
the harness `compareArray` (`b.length !== a.length`, then
`assert._isSameValue(b[i], a[i])`). Probing the real harness in standalone:

| inside `compareArray` | before this change | with this change |
| --- | --- | --- |
| `a.length`, `b.length` | 3 and 3 | 3 and 3 |
| `typeof b[0]` (fixture) | not `"number"` | `"number"` |
| `typeof a[0]` (`arguments`) | not `"number"` | not `"number"` |
| `a[0] === b[0]` | true | true |
| `_isSameValue(b[0], a[0])` | true | **false** |

Before the change both element reads produced the same wrong value, so
`SameValue(0, 0)` matched by coincidence: `1 / x === 1 / y` compared two equally
wrong quotients. The change made `fixture[0]` read correctly as the number 0 and
left `arguments[0]` wrong, so the quotients now differ. A re-land has to make
`arguments[i]` read as a number too; the `.length` change itself is not what the
row trips on.

### Still unknown

The other ~53 host-free rows are not named yet. The per-edition ratchet step
failed first, so the `#1897` standalone regression guard, the step that lists
regressed rows, was skipped. A separate CI change defers the ratchet's failure
like the high-water floor's (#6461), so the next run names them. A re-land should
be measured with a dispatched `test262-sharded` run on its branch before it is
queued.

The pin `tests/issue-6736-any-length-absent.test.ts` left with the code; it is
in `51c62b057` for the re-land.

## Re-land — 2026-10-05

The `.length` change from `51c62b057` is re-applied with the same behaviour.
It now lives at `src/codegen/expressions/standalone-any-length.ts`, to respect
the flat-directory budget. Its three helpers that sit inside the codegen import
cycle (`coercionInstrs`, `addStringConstantGlobal` and
`stringConstantExternrefInstrs`) are passed in by `property-access-dispatch.ts`,
so the module stays outside the cycle (`check:import-cycles`). The revert's re-land condition is now met: the ES5 row
`harness/compare-array-arguments.js` is fixed at its cause, not by the old
coincidence.

**Why `arguments[0]` read wrong.** A spread call into an `arguments`-reading
callee builds `__extras_argv` in `emitSetExtrasArgv`. In an untyped program
`[0, 'a', undefined]` is a vec of `$AnyValue` tagged unions, and each element
went into the externref extras array through a bare `extern.convert_any`. So
`arguments` held the union structs themselves:

- `arguments[0] === 0` was false;
- `typeof arguments[0]` was `"object"`;
- `String(arguments[0])` was still `"0"`.

That was true for every spread call, not just inside the harness. Probe
`f(1, ...[0, 'a']); g(...[0, 'a'])` gave 248 on the parent; Node gives 447.

The new module `expressions/spread-elem-extern.ts` (`spreadElemToExternInstrs`) projects an
`$AnyValue` element through the coercion engine, which unboxes it. It is gated
on standalone. `emitSetExtrasArgv` now carries the element `ValType` instead of
its kind, so `nested-declarations.ts` shrinks by 13 lines.

**Pin.** `tests/issue-6736-any-length-absent.test.ts` gains a fourth case for
spread into `arguments`, including test262's `compareArray` both ways. Its
direct calls serve as the anti-vacuity control. On the parent the four cases
read 248, 2, 108 and 127; with this change they read 1983, 5, 127 and 511,
which are Node's answers. `tests/issue-2576.test.ts` keeps its re-land edit,
`(5).length` reading `NaN`.

**ES5 row.** `harness/compare-array-arguments.js` passes in standalone with
`--isolate`. Re-applying only the `.length` change reproduced the revert's
failure (`Actual [0, a, undefined] and expected [0, a, undefined] should have
the same contents`).

**Scoped standalone test262**, 2503 rows, run in-process on the same base
(`b6324ee6d1`), parent against this branch:

| | pass | fail | CE |
|---|---|---|---|
| parent | 2146 | 292 | 65 |
| this branch | 2146 | 292 | 65 |

Zero rows flipped. The rows cover `language/statements/function`,
`language/expressions/{new,call,instanceof,object/method-definition}`,
`language/arguments-object`, `language/statements/for-in`, `harness`,
`built-ins/Function/prototype`, `built-ins/Object/{create,keys,getPrototypeOf,prototype/isPrototypeOf}`,
`built-ins/Array/from` and `built-ins/Array/prototype/{slice,indexOf}`.

**lodash.** Today's module-init failure is no longer this issue. It is
[#6861](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6861-standalone-fnctor-ctor-calls-own-prototype-method),
which throws at `lodash.js:6830`, long before `isArrayLike` at 17127. With
#6861 alone, init still throws `called value is not a function`. I did not
trace that throw to a line; this issue's `isArrayLike` site is the expected
one. With both, init
completes, and the next link is the checksum
([#6751](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6751-standalone-lodash-checksum-called-value-not-function)).

**JS-host.** All three changes are gated on standalone. Binaries are
byte-identical, before and after, on the 9-file probe set and on lodash's gc
lane (sha256 `1d5ceb787c914081…`, 1,288,275 bytes).

## Merge-group park — 2026-10-07

PR #6506 was parked by the merge-group standalone guard (run
`37388187410`): improvements 0, wasm-change regressions 79, host-free pass
41973 against the 42055 high-water mark.

**Attribution.** All 79 regressed rows were checked against main's standalone
results at `abb3471c46` (has #6502, lacks #6506; baselines commit
`b2e4f92e89`). All 79 **pass** there, so every one belongs to this PR. None is
inherited from #6502.

**Cause.** The re-land sent every receiver that was not a string, closure or
nullish to `__extern_get(recv, "length")`. It also read a `$__vec_base`
subtype's field 0 directly. `__extern_length` owns the `length` of several
carriers that `__extern_get` does not know:

| rows | receiver | re-land read | correct |
|---|---|---|---|
| 75 | TypedArray view over a resizable buffer (length-tracking) | -1 (the field-0 sentinel) | live length |
| (in the 75) | detached TypedArray view | stale length | 0 |
| 3 | String wrapper (`Array.prototype.{forEach,filter,reduce,reduceRight}.call(new String(…))`) | `undefined` | 3 |
| 1 | rest-args array from an IIFE (`language/rest-parameters/arrow-function.js`) | `undefined` | 0 / 3 |

**Fix.** Only an ordinary `$Object` takes the real Get. So do number and
boolean primitives, so that `(5).length` stays `undefined`. Every other carrier
keeps the old `__extern_length` answer. The read also asks for
`__extern_get`'s #6651 C5 String-wrapper `length` arm. That arm is passed in
through `AnyLengthDeps`, so the module stays out of the import cycle.

**Pin.** `tests/issue-6736-any-length-absent.test.ts`, case "non-object
carriers keep their own length". The parent (`c9e15c4e23`) reads 484. The fix
reads 1023, which matches Node. Bits 32, 128 and 256 are the anti-vacuity
control: they pass on both sides.

**The 79 rows.** Re-run in standalone with the fix: 79 of 79 pass. The three
detach rows need the QuickJS eval provider built.

**lodash.** The standalone-dynamic lane still finishes module init. It fails
at the `checksum` phase
([#6751](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6751-standalone-lodash-checksum-called-value-not-function)),
as before. The narrowing gives none of the lodash progress back.

**Scoped standalone test262.** I ran 2512 rows in-process on the merged
branch (`a2fbd6121b`, upstream `7ebc362ecc`) and compared them with main's
standalone baseline (`js2wasm-baselines` `f6fcebfe50`). The rows cover
`built-ins/Array/prototype/{forEach,filter,reduce,reduceRight,map,every,some}`,
`built-ins/TypedArray/prototype/{length,set,fill,copyWithin}`,
`language/arguments-object`, `language/rest-parameters`, `harness`,
`built-ins/Object/keys`, `built-ins/Function/prototype/apply`,
`built-ins/String/prototype/split` and `built-ins/Array/from`.

| | pass |
|---|---|
| main baseline | 2087 |
| this branch | 2087 |

No row went pass to non-pass, and none went the other way. Seven rows were
left out because main's baseline records them as `compile_timeout`.
Two of them (`Array/prototype/{some,every}/…-7-c-ii-2.js`, which walk a
million-element sparse array) hang in the in-process runner.

**JS-host.** The new code runs only for standalone and WASI. JS-host binaries
match the merge parent `7ebc362ecc` byte for byte (sha256) for lodash, redux,
marked, moment and the probe fixtures.
