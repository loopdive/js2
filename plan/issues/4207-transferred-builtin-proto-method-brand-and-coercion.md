---
id: 4207
title: "A builtin prototype method reached by property TRANSFER (not `.call`) skips both the [[Class]] brand check and the primitive-receiver coercion — 70 ES5 standalone files"
status: ready
assignee: ttraenkler/W28
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: native-prototypes, this-coercion
goal: es5
related: [3992, 4076, 3254, 2742, 2875, 4176, 4193]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue. #3992 fixed the transferred-method ARGUMENT-SLOT bug and #4076 fixed brand checks on the `.call` form; neither covers the `this`-handling of the transfer form."
---

# #4207 — transferred builtin prototype methods: no brand check, no receiver coercion

## The lever

**98 failing ES5 standalone files** contain the transfer idiom
`<X>.<m> = <Builtin>.prototype.<m>` followed by an invocation through `<X>`.
28 of them fail earlier because the method is simply unimplemented in
standalone (`String.prototype.split`, `concat`, `search`, `replace`, `match` —
those belong to **#2875**, not here). The remaining **70** are this issue:

| sub-mechanism | files | shape |
| --- | --- | --- |
| **A — no [[Class]] brand check** | 20 | `var i = new Number(1); i.exec = RegExp.prototype.exec; i.exec("s")` must throw TypeError; standalone returns a value |
| **B — no primitive-receiver coercion** | 50 | `Number.prototype.toLowerCase = String.prototype.toLowerCase; NaN.toLowerCase()` must be `"nan"`; standalone answers wrong / null |
| total | **70** | |

16 of the 70 pass in the host lane, so most of this is a shared-semantics gap
rather than a standalone-lowering gap.

## Why the existing fixes do not cover it

- **#3992 (done)** fixed the transferred-method **argument-slot shift** —
  `__call_fn_method_N`'s generic dispatch filled every closure param from the
  argument vector, so `thisValue` received `arg0`. That is orthogonal to *what
  the method does with a receiver once it gets one*.
- **#4076 (done)** made a borrowed method throw on an invalid `this`, but only
  through the **syntactic `.call` form**. The transfer form never reaches that
  check.
- **#3254 / #2742 (ready)** cover `RequireObjectCoercible` + `ToString` for the
  **`.call`** receiver of `String.prototype` members.

The distinguishing fact: `String.prototype.toLowerCase.call(NaN)` and
`Number.prototype.toLowerCase = String.prototype.toLowerCase; NaN.toLowerCase()`
must behave identically, and today they do not. The syntactic form is the one
with the plumbing.

## Two distinct receiver kinds inside B

1. **Assignment onto another builtin prototype** —
   `Number.prototype.toLowerCase = String.prototype.toLowerCase`, then invoked
   through a *primitive* number. Needs the named-expando write on a builtin
   prototype (#4176 / #4193 territory) **and** ToString(this) at entry.
   Members observed failing: `toLowerCase`, `toUpperCase`,
   `toLocaleLowerCase`, `toLocaleUpperCase`, `substring`, `slice`, `match`.
   `charAt` and `substring` had per-member clones from the #3992 era and behave
   differently — treat any per-member special case as a smell, not a template.
2. **Assignment onto an ordinary object / wrapper instance** —
   `var i = new Object(42); i.charAt = String.prototype.charAt; i.charAt(0)`.

## Representative files

Brand check (A):
`built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T{6,7,8,9}.js`,
`built-ins/RegExp/prototype/test/S15.10.6.3_A2_T{4,6,7,8,9}.js`,
`built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T{01,03,04,05}.js`,
`built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T{1,3,5}.js`,
`built-ins/Number/prototype/toString/S15.7.4.2_A4_T{01,03}.js`.

Coercion (B):
`built-ins/String/prototype/toLowerCase/S15.5.4.16_A1_T{6,7,8,14}.js`,
`built-ins/String/prototype/toLocaleUpperCase/S15.5.4.19_A1_T{6,7,8,14}.js`,
`built-ins/String/prototype/substring/S15.5.4.15_A1_T15.js`,
`built-ins/String/prototype/slice/S15.5.4.13_A{1_T5,1_T15,3_T3,3_T4}.js`,
`built-ins/String/prototype/charAt/S15.5.4.4_A1_T{1,2}.js`,
`built-ins/Array/prototype/concat/S15.4.4.4_A{1_T1,2_T1,2_T2,3_T1}.js`.

## Codegen sites

- `src/codegen/closures/transferred-native-proto.ts` — the transfer-time
  receiver plumbing (`collectTransferredSubstringReceivers` is the per-member
  clone to generalise away).
- `src/codegen/char-at-transfer.ts` — `buildTransferredCharAtApplyArm`, the
  other per-member clone.
- `src/codegen/closure-exports.ts` — `__call_fn_method_N` generic dispatch,
  where the receiver arrives.
- `src/codegen/array-prototype-borrow.ts` / `builtin-prototype-brand.ts` — where
  the `.call` form's brand check lives and which the transfer form bypasses.

## Acceptance criteria

- [ ] `<Builtin>.prototype.<m>` invoked through a transferred property performs
      the same `this` handling as the `.call` form: brand check where the spec
      requires one (RegExp `exec`/`test`, `Number.prototype.valueOf`/`toString`,
      `Boolean.prototype.toString`), `RequireObjectCoercible` + `ToString`
      otherwise.
- [ ] No new per-member special case is added; the two existing ones
      (`charAt`, `substring`) are folded into the general path or explicitly
      justified.
- [ ] A/B over the 70-file set with a control drawn from currently-passing
      transfer-idiom files; report both.
- [ ] The 28 method-missing files are excluded from this issue's yield and
      re-attributed to #2875.

## Measurement provenance

`classifyEdition() === 5` over the standalone baseline (48,619 rows, oracle v13,
2026-08-07): 8,931 files, 7,566 pass, 1,365 fail. Host-lane comparison from the
same-day host baseline.

---

# Implementation notes (W28, 2026-08-07) — the filed root cause is WRONG

> Everything above is left as filed, for provenance. Read this section before
> quoting any number or codegen site from it.

## 1. What actually reproduces, and what does not

The two *symptoms* the issue names both reproduce on `origin/main@18fc0ffc22`.
The *mechanism* it names does not.

The issue says the transfer form "skips the [[Class]] brand check and the
primitive-receiver coercion". Direct probes say otherwise — the brand check
exists, works for some receivers, and is **inverted** for others:

| probe (`--target standalone`, CI-equivalent driver) | measured | correct? |
| --- | --- | --- |
| `re.mytest = RegExp.prototype.test; re.mytest("xsx")` | `true` | yes |
| `n = new Number(1); n.mytest = RegExp.prototype.test; n.mytest(…)` | TypeError | yes |
| `s = new String(); s.myValueOf = Number.prototype.valueOf; s.myValueOf()` | **`undefined`** | NO — want TypeError |
| `s.valueOf = Number.prototype.valueOf; s.valueOf()` | TypeError from the **refusal** body | NO — passes for the wrong reason |
| `b = new Boolean(true); b.myts = Boolean.prototype.toString; b.myts()` | TypeError | NO — want `"true"` |

So "there is no brand check" is not the defect; "the closure is never reached"
is. And the reason it is never reached has nothing to do with transferred
methods at all:

```js
Number.prototype.zz = function () { return 42; };
var n = 5;
n.zz();          // measured on main: null.  A PLAIN user function.
typeof n.zz;     // "object"
```

**A primitive receiver never resolves a property installed on its wrapper
prototype.** `RegExp.prototype.exec` and `String.prototype.toLowerCase` fail
identically and for that reason: the closure is never invoked, so its brand
check / `ToString(this)` never runs. Fix the chain and both "buckets" of this
issue fix themselves — the existing brand check fires, the existing
`ToString(this)` fires.

## 2. Two corrections to the issue text

1. **`built-ins/Array/prototype/concat/S15.4.4.4_A*` is NOT this issue.** The
   issue lists four `concat` files as representative of bucket B. They
   **compile-error**: `standalone target emitted host imports:
   env::__array_concat_any, env::__js_array_new, env::__js_array_push (#2961)`.
   That is upstream of any `this` handling; they belong to **#2875 / #2961**.
   Anyone sizing bucket B from the issue inherits this error.
2. **The 98 / 70 / 59 split is right in outline but the sub-buckets are not.**
   Re-derived below.

## 3. Re-derived population

`classifyEdition() === 5` over the standalone baseline (48,619 rows,
force-fetched 2026-08-07 16:15Z, oracle v13): **8,931 ES5 files, 1,330
failing** (the issue's 1,365 predates #4201/#4203/#4204/#4205 landing).

Transfer idiom `<X>.<n> = <Builtin>.prototype.<m>` over the raw body:

| | files |
| --- | --- |
| transfer idiom, failing | **98** (reproduces the census exactly) |
| — fails on `is not yet implemented in --target standalone` | 28 → **#2875** |
| — fails on `standalone target emitted host imports` | 10 → **#2961 / #2875** |
| — **candidates for this issue** | **60** |
| transfer idiom, currently PASSING (the control) | **72** |

## 4. Instrument

`assembleOriginalHarness` → `CompilerPool(n, "unified")` →
`scripts/test262-worker.mjs`, `target: standalone`, primary + strict rerun.
Per ARM: both `scripts/compiler-bundle.mjs` and `scripts/runtime-bundle.mjs`
rebuilt, `.test262-cache/runtime-eval-*.wasm` **deleted** and the provider
rebuilt, `TEST262_FULL_RUNTIME_EVAL=1`. Base re-cut on `origin/main@18fc0ffc22`.

**Validated two-sided before any delta was read from it:** the base arm
reproduces the published standalone baseline **file-for-file across all 170
rows, zero disagreements** — lever 0/60, method-missing 0/38, control 72/72.

## 5. The fix (three sites, one mechanism)

The #4176 proto-property store already holds a named write onto a builtin
prototype and already exposes a receiver-aware consult (`__protoidx_get_r`).
Three sites were never wired to it:

1. `src/codegen/proto-index-store.ts` — `__protoidx_brand_off` classified only a
   `$Object` **wrapper** carrying `[[PrimitiveValue]]`. A **bare** boxed
   number/boolean/native string answered `Object`, so `Number.prototype`'s
   companion was never consulted first.
2. `src/codegen/closure-props.ts` — `__extern_method_call`'s terminal miss
   (receiver is neither `$Object`, vec, nor closure carrier, i.e. a bare
   primitive) returned the undefined sentinel unconditionally. It now consults
   the store and hands the result to `__apply_closure` with the ORIGINAL
   receiver as `this`, which is what lets the #3992 native-proto arm inside
   `__call_fn_method_N` thread it into the closure's `this` param.
3. `src/codegen/expressions/stored-member-closure-call.ts` — the #4096 dispatch
   tail reads the member statically; for a primitive that read folds to
   `ref.null.extern`. When it is nullish, dispatch through
   `__extern_method_call` instead. A sibling arm claims the NON-identifier
   receiver shape (`(Number.NEGATIVE_INFINITY).m()`), which #4096 declines
   because it would have to read the receiver twice.

Every one of the three sits at a point that answers `undefined` today, so each
is a strict narrowing of an existing silence.

**No per-member special case was added, and none was removed either.** AC#2
asked for `charAt`/`substring` to be folded into the general path; they are not
touched, because they turned out not to be on the failing path — the two
`charAt` files in the residue fail on `ToString` of a wrapper receiver, not on
dispatch. Folding them is a separate, unmeasured refactor and is deliberately
left out rather than done blind.

## 6. Result

Two A/Bs, both full populations, no sampling.

**(a) The 170-file issue population** (60 lever + 38 method-missing + 72
transfer-idiom control): **FIXED 19 / BROKE 0 / signature-changed 5**, control
72/72 held.

**(b) The 1,344-file EXPOSURE population** — every file whose effective source
contains a builtin-prototype write (1,223; see section 9) ∪ the 170 above:

| | files | base pass | head pass |
| --- | --- | --- | --- |
| all rows | 1,344 | 559 | **578** |
| lever | 60 | 0 | **19** |
| method-missing (#2875) | 38 | 0 | 0 |
| transfer-idiom control | 72 | 72 | **72** |
| **proto-write control (currently passing)** | **492** | **492** | **492** |
| proto-write, currently failing | 731 | 1 | 20 |

**FIXED 19 / BROKE 0 / signature-changed 6.** Every one of the 19 is inside the
proto-write trigger set, which is the reachability claim discharged by
enumeration rather than by argument. The head arm was run twice (170-file and
1,344-file lists, independent processes) and agreed on all 170 overlapping rows.

The 6 signature changes:

- 5 are wrong-answer/null-deref becoming the honest
  `"<X>.prototype.<m> is not yet implemented in --target standalone"` refusal:
  they now fail *at* the unimplemented member instead of silently answering
  the wrong value, and move to #2875's ledger;
- 1 (`Array/prototype/toLocaleString/S15.4.4.3_A3_T1`) is a **pre-existing**
  invalid-Wasm compile error, unchanged in kind — same function
  (`__module_init`), same type error (`fallthru[0] expected (ref null 6), got
  (ref 76)`); only the reported byte offset moved (`@+110249` → `@+110307`)
  because the module grew. Recorded, not claimed either way.

**Byte-identity, by enumeration rather than assertion.** sha256 of the emitted
module across both arms:

| target | shape | base == head? |
| --- | --- | --- |
| gc (host) | builtin-proto write | **identical** (`54f31c0c…`, 2,401 B) |
| gc (host) | transferred `RegExp.prototype.exec` | **identical** (`8ca7a60a…`, 2,309 B) |
| gc (host) | no proto write | **identical** (`d1739701…`, 7,239 B) |
| gc (host) | plain | **identical** (`08dcfdec…`, 3,745 B) |
| standalone | no proto write | **identical** (`67581666…`, 95,719 B) |
| standalone | plain | **identical** (`ea42a455…`, 54,929 B) |
| standalone | builtin-proto write | differs (97,218 → 97,299 B) |
| standalone | transferred `exec` | differs (100,239 → 100,322 B) |

So the **host lane is provably untouched**, and standalone output moves only
where a builtin-prototype write exists — exactly the trigger the exposure set
was built from.

## 7. Measured residue — 41 of 60, why this issue stays `ready`

| sub-mechanism | files | note |
| --- | --- | --- |
| **A. wrapper receiver + NON-canonical property name** — `s = new String(); s.myValueOf = Number.prototype.valueOf; s.myValueOf()` gives `undefined` | ~15 | `isStringType` deliberately also matches the String WRAPPER type, so the call enters the native-string block, `compileNativeStringMethodCall` has no arm for `myValueOf`, and its `null` return is erased by `rollbackSpeculative` → `pushDefaultValue`. **See the rejected variant in section 8 — this is not a one-liner.** |
| **B. `Object.prototype.toString` transferred** giving `[object Array]` / `[object Function]` / `[object RegExp]` | 5 | `Object.prototype.toString` has no standalone body |
| **C. `ToString(this)` of a RegExp / Function instance** — `__reg.toUpperCase()` answers `"[OBJECT OBJECT]"`, want `"/ABC/"` | 5 | the transfer now works; the ToString of the receiver is the defect |
| **D. member unimplemented in standalone** (`split`, `match`, `Object.prototype.toString`) | 5 | **#2875** |
| **E. string PRIMITIVE receiver** — `Object.prototype.zz = f; ".".zz()` gives `undefined` | 2 | same site as A |
| **F. misc** — `concat` 128-arg, `slice` on a function object, `charAt` on `new Boolean`, 2x `illegal cast [in __call_toString() <- … <- __proto_method_*_indexOf]` | 9 | |

## 8. Rejected variant — recorded so it is not re-attempted blind

Sub-mechanisms A + E share one site, and the obvious fix is to stop
`compileNativeStringMethodCall`'s `null` from being swallowed: snapshot
`fctx.body`, and on `null` roll back and return `undefined` so the call falls
through to the dispatch tail, gated on the #1397/#4096
`sourceHasMethodReassignment` scan.

**Measured, on the same 170-file instrument: FIXED 19 (unchanged), BROKE 0,
and 7 files turned into `compile_error: Unknown string method: <m>`.** The arm
raises a **sticky** diagnostic before returning `null`, which the body
truncation does not undo, so the rollback converts a silent wrong answer into a
hard compile failure without converting a single test. Reverted.

The lead is useful even so: it proves those 7 files *reach* that site and would
take the dynamic route if the diagnostic were suppressed along with the body.
Whoever picks up A/E must roll back the diagnostic channel too, not just
`fctx.body`.

## 9. Exposure — and a load-bearing finding about the pre-scan gate

Every site above is gated on the #4176 store, i.e. on the pre-scan flag
`protoIndexDirty || protoNamedDirty`. **That gate is worth almost nothing as a
blast-radius argument in this corpus**, and anyone reasoning from it should
know why: the js2wasm host-globals shim that `assembleOriginalHarness` prepends
to *every* harness assembly contains `return eval(sourceText);`, and
`isDynamicCodeUse` sets `dynamicCodeDirty` implies `protoNamedDirty`. Measured
over the effective source of all 48,619 rows:

| | files |
| --- | --- |
| gate CLEAR (provably byte-identical emission) | **32** |
| gate SET | **48,587** |

So exposure was sized by the real trigger instead — a **builtin-prototype
WRITE** in the effective source, without which the store's companions are empty
and no consult can answer differently: **1,223 files (492 currently passing,
731 non-pass)**.

## 10. Spun out — the vacuous-pass class this uncovered

`s.valueOf = Number.prototype.valueOf; s.valueOf()` passes today because the
standalone **refusal** body throws a TypeError that is indistinguishable from
the spec's. That is a general hazard, not a #4207 detail: **implementing a
standalone builtin member correctly converts such a file from pass to fail**,
and the conversion surfaces in the `merge_group` re-validation as an auto-park,
not at PR level.

Static UPPER BOUND (currently-`pass` files that assert a TypeError **and** read
a builtin proto member as a value): **825 files**. That is loose — it counts
members that *are* implemented.

The decisive experiment is one extra A/B arm and does not need this issue:
make the refusal body throw a **RangeError** instead of a TypeError, re-run,
and every currently-passing file that flips was passing *because* the feature
is missing. **Filed as #4209** — the 825 above is the candidate pool it should
start from, and it is an upper bound, not a count.
