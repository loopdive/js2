---
id: 6619
title: "standalone: a dynamic construct/dispatch argument marshalled into an f64 formal silently unboxed a Symbol or BigInt to NaN instead of throwing TypeError (§7.1.4 ToNumber)"
status: done
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-16
assignee: ttraenkler/sendev-s32
---

# #6619 — the f64 twin of #6615: `__unbox_number` must throw for a Symbol/BigInt construct argument

## Problem

`new Temporal.Duration(Symbol())` / `new Temporal.Duration(0n)` answered
`NaN` (a Duration with all-zero fields) where §7.1.4 `ToNumber` requires a
`TypeError`:

```js
new Temporal.Duration(Symbol());          // should throw TypeError
new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, 0, 0, 0n);  // should throw TypeError
```

`built-ins/Temporal/Duration/invalid-type.js` (10 `assert.throws` × 2 operand
kinds, one file) exercises this directly against the real
`@js-temporal/polyfill` provider under `--target standalone`.

Under `--target standalone`, a dynamically-invoked callee's argument arrives
as `externref` and is marshalled into the callee's declared parameter type by
`extern-arg-marshal.ts`'s `externArgCoercionInstrs` — the SAME marshal
`#6615` fixed for `ref`-typed formals. Its `f64` arm calls `__unbox_number`
directly:

```ts
else if (unboxNumIdx !== undefined) out.push({ op: "call", funcIdx: unboxNumIdx });
```

`__unbox_number` (the standalone native, `registry/imports.ts`) is
**deliberately lenient** — it answers `NaN` for any operand it does not
recognise, Symbol and BigInt included. That leniency is load-bearing
elsewhere: the same native doubles as the numeric-key PROBE for
`__extern_set` on a vec receiver (`arr[sym] = v`), an ordinary property
write that must NOT throw. `tonumber-fast-paths.ts`'s `symbolThrowArm`
already documents this split for the GENERAL `ToNumber` path (`__to_primitive`
+ `__unbox_number`, reached from ordinary expression coercion): the Symbol
guard lives in the CALLER, never inside `__unbox_number` itself.

The dynamic construct/dispatch marshal is a DIFFERENT caller of
`__unbox_number` that had no such guard at all, so `new
Temporal.Duration(Symbol())` — which reaches `__unbox_number` through
`standalone-class-construct.ts`'s per-class trampoline, not through the
general `ToNumber` path — silently converted the Symbol to `NaN`.

## Fix

`extern-arg-marshal.ts` gains a Symbol/BigInt-checked wrapper
`__unbox_number_checked(externref) -> f64`, consulted ONLY by the f64 arm of
`externArgCoercionInstrs`:

```
__unbox_number_checked(v):
  if ref.test $Symbol(v):  throw TypeError("Cannot convert a Symbol value to a number")
  if ref.test $BigInt(v):  throw TypeError("Cannot convert a BigInt value to a number")
  return __unbox_number(v)
```

`__unbox_number` itself is untouched — it keeps answering `NaN` for every
caller that is not this marshal, preserving the vec numeric-key-probe
contract `symbolThrowArm`'s own comment names.

**Gate / byte-neutrality**, mirroring #6615's `armExternRefArgTypeGuard` /
`armExternRefArgTypeGuardForLinkedProvider` exactly (same reserve-then-fill
discipline, same two call sites — the module's own dynamic `new <value>`
expression, and post-bodies for a module compiled as a linked provider whose
consumer is wasm):

- `armExternF64ArgTypeGuard` / `armExternF64ArgTypeGuardForLinkedProvider`
  (new, `extern-arg-marshal.ts`) build the two TypeError throw templates
  once per module.
- `moduleHasF64TypedConstructFormal` (new, `standalone-class-construct.ts`,
  mirrors `moduleHasRefTypedConstructFormal` field for field — reads
  `structMap`, not the lazily-materialised `classObjectGlobals`) is the
  arming gate: a module with no `f64`-typed construct formal never mints
  `__unbox_number_checked` and pays nothing.
- A DEFAULTED `f64` formal composes with #5380's omitted-argument sentinel:
  `ensureUnboxNumberOrOmitted` now takes the checked funcIdx as its fallback
  (instead of the raw `unboxNumIdx`), so `new C(undefined)` still runs the
  default (an ABSENT argument, not a wrongly-typed one) while `new
  C(Symbol())` on the same defaulted formal still throws.

Like #6615's arms 1 and 3, this can only change the answer of a program that
was previously WRONG (a spec-mandated throw silently swallowed into `NaN`),
never one that worked.

## Result

Corpus-wide, the two files a Symbol/BigInt construct argument can reach:

| file | mechanism | base | branch |
| --- | --- | --- | --- |
| `built-ins/Temporal/Duration/invalid-type.js` | direct construct argument — **this fix** | fail | **pass** |
| `built-ins/Temporal/Duration/from/invalid-type.js` | `Temporal.Duration.from({years: Symbol()})` — a DIFFERENT mechanism (object-literal PROPERTY extraction inside the provider's own `.from()` body, not a dynamic construct-argument marshal) | fail | fail (unchanged — out of scope, see Residuals) |

Four-family sample (first 120 files, `--target standalone`, provider linked,
sequential, 60 s/row, fresh `JS2WASM_TEMPORAL_CACHE` per label — `cacheHit:
false` on both prewarms):

| family | base (S31 tip) | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 110 | 110 | 0 | 0 | 0 |
| `Duration/**` | 101 | 102 | +1 | 0 | 1 |
| `PlainDateTime/**` | 112 | 112 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **426** | **427** | **+1** | **0** | **1** |

"base" is S31's own branch tip (`issue-5383-standalone-temporal-s31`, tip
`4c91fc99c6`) — S32 branches directly from it, so S31's branch numbers ARE
this slice's base. Reproduced by per-file diff against S31's own
`fam-*-branch.tsv` artifacts (not re-measured from a file-copy revert for the
three families this slice's fix cannot reach): 0 unexpected flips outside
`Duration/invalid-type.js`.

No `compile_error`, no `timeout`, no `__temporal_*` leak in any row.

**Corpus-wide, the 45 `subclassing-ignored.js` files (per file, both labels,
via `.tmp/s32/sub.mts`): 0 → 0 pass, unchanged from S30/S31 — R1 still blocks
this family (see Residuals below); every failure message is the SAME
`SameValue(«null», «undefined»)` R1 already names, not a new failure mode.**

## Controls

**Must-not-move — 231 rows, four groups, per file, both labels** (`.tmp/s32/mnm.mts`):

| group | rows | base pass | branch pass | real flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys`(30) + `expressions/object`(30) + `Reflect/{get,has}`(21) | 81 | 77 | 77 | 0 |
| B: `Object/{entries,values}`(41) + `getOwnPropertyNames`(30) + `for-in`(30) | 101 | 69 | 69 | 0 |
| C1: `Object/{getPrototypeOf,setPrototypeOf}` + `Object/prototype/isPrototypeOf` | 47 | 44 | 44 | 0 |
| C2: `expressions/instanceof`(44) + `statements/class/subclass`(60) | 104 | 70 | 60 | 0 |

**A measurement caveat, not a regression: 22 raw diffs, all attributable to
this session's eval-engine choice, none to this fix.** Group B shows 12
`fail` cells and group C2 shows 10 that a naive per-file diff against S30/
S31's own `mnm*-branch.tsv` artifacts reads as pass→fail. Every one of those
22 rows' detail is the IDENTICAL string: `TypeError: dynamic code evaluation
is not supported in this standalone build (no js2wasm:runtime-eval
interpreter linked — tracking: #2928)`. This session ran under
`JS2WASM_EVAL_ENGINE=interpreter` with only the REFUSAL runtime-eval
provider built (no QuickJS artifact in this worktree) — a fast local
diagnostic the runner itself labels "NOT CI-comparable". S30/S31's own runs
used whatever eval engine was live in THEIR worktrees; an eval-dependent
`for-in`/`instanceof` test fails identically regardless of which tree's
COMPILER produced it, so these 22 are a property of the MEASUREMENT
environment, not of this change. Filtering them out: 0 real flips in 231
must-not-move rows.

**Byte A/B — targeted, both lanes** (`.tmp/s32/bytes.mts`):

| artifact | base | branch | |
| --- | --- | --- | --- |
| dynamic `new f(1)` into an `f64` construct formal (armed) | `4c46acf8` 208,815 B | `2e277215` 209,079 B | **moved** (+264 B) |
| the same class, NO dynamic `new` site at all | `161e4619` 137,707 B | identical | |
| dynamic `new f("x")` into a `string` (ref) formal only, no `f64` formal | `d61b74e7` 209,034 B | identical | the f64 gate |
| a module with no class at all | `66fbc4bc` 22,594 B | identical | |
| every `gc`-lane artifact above | | | **identical** |

Exactly the one armed artifact moves. The unarmed-ref-formal control
confirms `moduleHasF64TypedConstructFormal` gates independently of
`moduleHasRefTypedConstructFormal` — a module with only string formals pays
nothing for this fix, as #6615's own ref-only fix paid nothing for a
pure-`f64` module (S28 §4, the f64-formals-only row).

**Temporal provider**: standalone provider artifact 3,311,079 B →
3,311,522 B (**+443 B**), `cacheHit: false` on both prewarms — the provider
IS the module that needed the fix (its own `Duration`/`PlainDate`/etc.
constructors have `f64` formals and are reached dynamically through
`__js2wasm_link_construct` on the linked-provider path, exactly as #6615's
`armExternRefArgTypeGuardForLinkedProvider` needed a SEPARATE arming site
for the same reason).

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly, on both trees.

**Corpus byte A/B**: 42 `website/playground/examples` + `tests/fixtures`
modules × {gc, standalone} = 84 artifacts, 0 moved — a NULL control, stated
as such: no module in that corpus constructs dynamically from a runtime
value into an f64 formal.

**Witness**: `tests/issue-6619-f64-arg-symbol-bigint.test.ts` — every
fix-witness `it` shown failing on the file-copy-reverted base (4 `src/`
files reverted to S31's tip) before being counted as a fix.

## Residuals — reduced and sized here, NOT given their own ids

### R-from — `Temporal.Duration.from({years: Symbol()})` still answers `undefined` instead of throwing (1 file, `Duration/from/invalid-type.js`)

A DIFFERENT mechanism from this fix's target: `.from()` extracts each
property (`item.years`, `item.months`, …) via an ordinary dynamic property
GET inside the provider's OWN compiled body, then runs `ToIntegerIfIntegral`
on it — this never reaches `extern-arg-marshal.ts`'s construct-argument
marshal at all (there is no dynamic CONSTRUCT call here; `.from()` is a
static method, and its argument is a plain object literal, not a
class-value construct). Whether the GENERAL `ToNumber` path's
`symbolThrowArm` (`tonumber-fast-paths.ts`) reaches this specific internal
call, and whether an equivalent BigInt guard exists there at all, is
unmeasured — reduce in a single provider-compiled module before committing
to a fix shape.

### R1 (inherited from #6617) — NOT reduced further to a fix, but reduced substantially past the S30/S31 hand-off

`<provider class>.prototype` through a parameter still answers `undefined`
in the module the test262 harness's `checkSubclassConstructorNotObject`
compiles, blocking all 45 `subclassing-ignored.js` files (unchanged this
slice — this fix does not touch R1's mechanism). Per the dispatch brief's
own fallback clause, this slice spent its first probing budget on R1,
found a precise (but not fully pinned-down) trigger, and moved to this f64
fix rather than risk an under-verified patch to a subsystem
(`proto-index-store.ts`) the codebase's own comments describe as delicate.

**What the S30/S31 hand-off got right**: `c.prototype` on a
provider-linked externref parameter IS content-sensitive — it answers
`object` (correct) in isolation and `undefined` (wrong) depending on
unrelated module content, exactly as reported.

**What this slice adds — the precise trigger, not just its symptoms.**
Reduced past the S30 hand-off's six one-variable probes
(`.tmp/s30/t/p1.js`–`p10.js`, copied into `.tmp/s32/t/`) to a single
variable: **the presence of ANY dynamic `new <any-typed-value>(...)` call
ANYWHERE in the module** — not necessarily on the same class, not
necessarily in the same function — flips every dynamic `.prototype` read on
a provider-linked class from `object` to `undefined`, even with NO static
access and NO other read of any kind:

```js
// r1c.js — readProto(Temporal.Duration) ALONE in the module → "object" (correct)
function readProto(c) { return typeof c.prototype; }
readProto(Temporal.Duration);

// r1j.js — the SAME readOnly call, plus a dynamic new on an UNRELATED LOCAL
// class (not Temporal, not the same value) anywhere in the module → "undef"
class Local { constructor(y) { this.y = y; } }
function dynNew(k) { return new k(1); }
dynNew(Local);              // triggers the flag — no relation to Temporal.Duration
readOnly(Temporal.Duration); // now answers undef, was "object" without this line
```

This is NOT a per-class or per-scope "arming" (ruling out the #6457/#6617
"generic site raises demand" pattern the S30 hand-off suspected) — it is a
**whole-module, content-blind pre-scan false positive**:
`sourceHasDynamicTaConstruct` (`source-scan-predicates.ts` ~L501–566, #2872)
walks the ENTIRE source for `new <identifier>(...)` where the identifier is
a parameter/variable of `any`/`unknown` type, and — unable to tell
statically whether that identifier MIGHT be bound to a TypedArray
constructor at runtime — conservatively sets `ctx.moduleUsesDynTaView =
true` for the WHOLE module on ANY such call, Temporal-related or not. That
flag arms `proto-index-store.ts`'s companion/protoidx machinery module-wide
(`proto-index-store.ts:213`,
`!(ctx.protoIndexDirty || ctx.protoNamedDirty || ctx.protoMemberDirty ||
ctx.moduleUsesDynTaView)`), which roughly DOUBLES `__extern_get`'s compiled
body (measured: 1,656 → 3,473 WAT lines for the identical `.prototype`
read's ladder function) and pulls in a dozen additional helpers
(`__getPrototypeOf`, `__instance_prop_get`, `__protoidx_get_k`,
`__protoidx_companion`, `__protoidx_brand_off`,
`__object_terminal_allows_implicit_proto`, `__new_plain_object`,
`__to_property_key`, `__ta_dyn_get_elem`, `__closure_prop_get`,
`__error_prop_get`, `__is_instance_expando_carrier`,
`__is_vec_prop_carrier`).

**This maps exactly onto the ORIGINAL failing shape.** test262's
`checkSubclassConstructorNotObject` helper (the harness function every
`subclassing-ignored.js` file calls) does, in one function:
`const p = construct.prototype; … new construct(...constructArgs);` — the
SAME dynamically-`any`-typed `construct` parameter is both `.prototype`-read
AND dynamically `new`'d. The `new construct(...)` call is precisely
`sourceHasDynamicTaConstruct`'s trigger shape, and it arms
`moduleUsesDynTaView` for the WHOLE module BEFORE `construct.prototype` is
even read (compile-time, not execution-order — confirmed with `.tmp/s30/t/p7.js`,
which showed the read-before-arm ordering doesn't matter either).

**What the WAT trace ruled out, so the next slice does not re-walk it.**
Structurally, BOTH the "armed" (broken) and "unarmed" (working) compiled
`__extern_get` bodies reach the identical `ref.test $Object → (miss) → call
$__js2wasm_link_member_get → return if non-null` sequence for the SAME
receiver, and `.name` (a DIFFERENT property key on the SAME
dynamic-construct-armed module) reads correctly through that exact path —
only `.prototype` breaks. So the defect is **key-specific** (something
treats the literal string `"prototype"` differently) and is **NOT**: a
mis-registered peer/boundary import (present, funcIdx stable, in both), a
wrong `$Object` classification of the foreign receiver (ruled out by
`.name` working), or the S30-fixed `__std_class_instance_proto` /
`__fnctor_proto_start` machinery (absent from BOTH compiled modules — no
`fnctor`-named function exists in either, so `protoCacheEnabled` is `false`
in both and that mechanism is not involved here at all).

**Where to look next**: `proto-index-store.ts` (the module
`moduleUsesDynTaView` arms, ~900–1,900 lines, `__protoidx_get_k` /
`__protoidx_companion` / `PROTOIDX_GET_K`) is where a KEY-specific
prototype-chain special case most plausibly lives, given its whole purpose
is prototype-chain COMPANION lookups. Reduce with the ready-made probe pair
`.tmp/s32/t/w-works.js` (single `.prototype` read, unarmed) /
`.tmp/s32/t/w-broken.js` (same read + an unrelated dynamic `new`, armed) —
compile both via `.tmp/s32/wat.mts` (real Temporal provider linked,
`--target standalone`), `wasm-dis -all` the output, and diff
`__extern_get`'s compiled body between the two (`.tmp/s32/t/extern-get-works.wat`
/ `extern-get-broken.wat` in this worktree already have this done). A
narrower fix ALSO worth sizing: tighten `sourceHasDynamicTaConstruct`'s
false-positive rate itself (e.g. do not arm when the SAME dynamically-typed
identifier is also read via `.prototype` in the same module, since a
TypedArray value's `.prototype` is never read this way in practice) — but
that changes TypedArray-detection semantics for an unrelated feature and
needs its own measurement against genuine dynamic-TA-construct tests before
it can be trusted not to regress them.

## Traps, carried forward and added to

Everything in S26–S31 still holds. One addition:

- **A module-wide pre-scan flag set for reason A can silently change
  behaviour for reason B, with no textual overlap between the two.**
  `sourceHasDynamicTaConstruct` exists to detect POSSIBLE TypedArray
  construction from a dynamic value; it has nothing to do with prototype
  reads. But because it is a coarse, WHOLE-MODULE, content-blind boolean
  (`ctx.moduleUsesDynTaView`), and `proto-index-store.ts` reuses that SAME
  flag as one of four independent arming conditions for an entirely
  different subsystem, a Temporal test262 harness helper that merely
  constructs a value dynamically (for an UNRELATED reason — testing
  subclass construction, not TypedArrays) silently poisoned its own
  `.prototype` reads. Grep every consumer of a broad pre-scan flag before
  trusting that "my feature doesn't use TypedArrays" means "this flag never
  affects my feature."
