---
id: 6625
title: "standalone: `Object.getPrototypeOf(<provider-owned CLASS OBJECT>)` answers `null` instead of `Function.prototype` across the wasm<->wasm link boundary — 8 of the 9 `builtin.js` files S37 moved past `isExtensible`"
status: done
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/sendev-s38
func-budget-allow:
  # 2026-09-17 (S38) — `addUnionImportsAsNativeFuncs` grows 7 lines: one new
  # `registerNative("__is_class_object", ...)` placeholder call, matching the
  # existing `__is_callable` registration immediately above it line-for-line.
  # Not a new mechanism in this function — it is the SAME one-line-per-native
  # registration pattern the function already contains dozens of; splitting
  # it is out of scope for a one-native addition to an already-over-budget
  # barrel (#3399/#3400 apply repo-wide, not introduced here).
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
---

# #6625 — `Object.getPrototypeOf(<class object>)` across the standalone wasm<->wasm link boundary

## Problem

`Object.getPrototypeOf(Temporal.PlainDate)` — a CLASS VALUE reached through a
linked standalone provider's namespace — answers **`null`** under
`--target standalone`, where §15.7.14 step 4 (an ordinary class with no
heritage clause is an ordinary function object) says `%Function.prototype%`.
This is the residual [#6609](6609-standalone-dynamic-callable-getprototypeof.md)
(S22) named and explicitly declined, and the one
[#6624](6624-standalone-link-boundary-is-extensible.md) (S37) confirmed as the
blocker for 8 of the 9 `builtin.js` files it moved past the `isExtensible`
assertion.

Measured on this branch's base (S37's tip, `.tmp/s38/link1.mts`, real
synthetic linked provider, fresh cache):

```
Object.getPrototypeOf(NS.PD) === Function.prototype        false   (should be true)
Object.getPrototypeOf(NS.PD.compare) === Function.prototype true   (#6609/S22, already correct)
Object.getPrototypeOf(new NS.PD()) === NS.PD.prototype      true   (#6617/S30, already correct)
```

Corpus-wide (`test262/test/built-ins/Temporal/**/builtin.js`, real
`@js-temporal/polyfill`, 129 files, fresh cache): **120/129 pass on base** —
matches S37's own reported number exactly, reproducing S37's tip cleanly on
this tree. All 9 non-passing files stop on the third assertion,
`Object.getPrototypeOf(Temporal.X) === Function.prototype`, for 8 of them
(the 9th, `Now/builtin.js`, stops on a different, unrelated mechanism —
`Object.prototype.toString.call(Temporal.Now)`, since `Now` is a namespace
object, not a class — already documented as a separate residual in S37 §4).

## Root cause

`Object.getPrototypeOf(v)` on an `any`-typed `v` that the checker cannot prove
callable falls to `tryEmitDynamicCallableGetPrototypeOf`
(`object-get-prototype-of.ts`, #6609), gated on the runtime predicate
`__is_callable`. That predicate DELIBERATELY excludes class objects (a class
has [[Construct]] but no [[Call]] — see the function's own docstring), so a
class value fell through to the generic `__getPrototypeOf`. That native's
`$proto` walk only decodes `$Object` receivers; a compiled class-object
struct is not one, and — across a link — the consumer's own class-instance
dispatcher (`STANDALONE_CLASS_INSTANCE_PROTO`, #6617) EXPLICITLY declines a
class-object identity match (by design: it answers only for INSTANCES,
`standalone-class-instance-proto.ts` lines 203–224). So the walk answered
`null` all the way through.

## The fix

A new runtime predicate, `__is_class_object` — an IDENTITY ladder (`ref.eq`
against every one of the module's own class-object singletons), never a
`ref.test`: a class object and its own instances share ONE struct type AND
`__tag` (#3976), so identity is the only thing that tells them apart. It
reuses `typeof-natives-finalize.ts`'s existing `classObjectIdentityArms`
builder verbatim (now parameterised over an optional global-idx list) so the
two predicates (`typeof`'s class-object arm and this one) can never disagree
about which values are class objects.

`tryEmitDynamicCallableGetPrototypeOf` (#6609's function; folded into rather
than duplicated — see "Attempt log" below) now ORs `__is_class_object` into
its existing runtime dispatch alongside `__is_callable`: either predicate
true routes to the SAME answer, `Function.prototype`, compiled on the
CALLER's own side (S22's identity rule — the value this arm answers must
never be a peer's own singleton, or `===` fails by identity even though both
sides are "correct" in isolation).

Across a linked provider, `__is_class_object` asks the owner for a BOOLEAN
only — a new `__js2wasm_link_is_class_object` terminal in
`standalone-link-boundary.ts`, the same "ask the owner" shape #6617/#6624
established, but unlike THEIR terminals (which hand back a VALUE) this one
hands back nothing but the fact. The provider's own class-object identity
ladder (built from ITS `classObjectGlobals`) answers the boolean; the
CONSUMER decides what to do with it.

**Scope: base classes only (no `extends`).** A derived class's [[Prototype]]
is its PARENT's class-object value (§15.7.14 step 6), not
`%Function.prototype%` — answering the constant for a subclass would be a
NEW wrong answer, not merely an unreduced one (verified: on base,
`Object.getPrototypeOf(<subclass>) === Function.prototype` is `false`, which
a naive class-object-only predicate flips to a WRONG `true`). Both the
local (`typeof-natives-finalize.ts`) and boundary (`standalone-link-boundary.ts`)
identity ladders are filtered to classes absent from `ctx.classParentMap`, so
a subclass keeps today's answer. The parent-aware correct answer (walk
`classParentMap` and answer the parent's class-object value, forwarded
across the link the way #6617's `getPrototypeOf` terminal already forwards a
value) is a **documented, unreduced residual** — none of the real
`@js-temporal/polyfill`'s top-level classes use `extends`, so it does not
block this slice's corpus target, but a future provider that does would hit
it.

## Result

Corpus-wide, all 129 `built-ins/Temporal/**/builtin.js` files, fresh cache
per label: **base 120/129 pass** (reproduces S37 exactly) → **branch
128/129 pass, 0 pass→fail, 8 fail→pass** — exactly the 8 files S37 §4 named
(`Duration`, `Instant`, `PlainDate`, `PlainDateTime`, `PlainMonthDay`,
`PlainTime`, `PlainYearMonth`, `ZonedDateTime` top-level `builtin.js`). The
9th (`Now/builtin.js`) is unchanged, as expected — its blocker is the
separate namespace-`toString` mechanism this slice does not touch.

Four-family acceptance sample (`PlainDate`, `Duration`,
`ZonedDateTime/prototype`, `PlainDateTime`, first 120 files each,
`--target standalone`, linked, fresh `JS2WASM_TEMPORAL_CACHE` per label,
`.tmp/s38/famrun3.mts` — each family run in 40-file thirds as three separate
foreground jobs to fit the container's restart window) — **S38 finished this
to the brief's full 480/480 spec** (S37's own partial sample above was the
honestly-reported gap this completes):

| Family | base (S37 tip, file-copy revert) | fix (this branch) | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| `PlainDate` | 111/120 | 112/120 | 0 | 1 (`PlainDate/builtin.js`) |
| `Duration` | 104/120 | 105/120 | 0 | 1 (`Duration/builtin.js`) |
| `ZonedDateTime/prototype` | 103/120 | 103/120 | 0 | 0 |
| `PlainDateTime` | 112/120 | 113/120 | 0 | 1 (`PlainDateTime/builtin.js`) |
| **Total** | **430/480** | **433/480** | **0** | **3** |

Base reproduces S37's own cited 111/104/112/103 = 430 exactly (all four
families independently re-measured, not merely cross-referenced). The three
`fail→pass` rows are exactly the three families' own top-level `builtin.js`
files — `builtin.js` sorts alphabetically before every subdirectory name at
each family root, so it lands inside each family's first 120 files (contrary
to S37 §5's own assumption that "none of these four families' first 120
files is a `builtin.js` file" — that assumption does not hold for `PlainDate`,
`Duration`, `PlainDateTime`, only for `ZonedDateTime/prototype`, whose walk
root is the `prototype/` subdirectory and genuinely contains no `builtin.js`).
No other row in any family flipped either direction — exact per-file diff
against each family's own base tsv, not just a count comparison.

Provider artifact bytes: **3,311,710 B → 3,312,720 B (+1,010 B)** — matches
the fresh-prewarm byte counts measured for both labels in this run
(`prewarm-temporal-provider.mjs --target standalone`, `cacheHit=false` on
both).

Equivalence gate: **22 failing / 1,720 passing / 22 known-failures in
baseline — 0 new regressions, exactly the S37 baseline**, run to completion
(`npm run -s test:equivalence:gate`, ~161s).

Must-not-move samples (groups A/B/C per the dispatch brief,
`.tmp/s38/mnm3.mts`, group A/B/C chunked into 200–250-file jobs — same
file-copy-revert base/fix labels as the four-family sample above):

| Group | Scope | base pass | fix pass | total | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- | --- |
| A | `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 1125 | 1125 | 1250 | 0 | 0 |
| B | `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 179 | 179 | 205 | 0 | 0 |
| C | `Object/getPrototypeOf` + `Reflect/getPrototypeOf` + `Function/prototype` (first 100) + `class/subclass` (first 100) + `expressions/class` (first 100) | 272 | 273 | 349 | 0 | 1 |
| **Total** | | **1576** | **1577** | **1804** | **0** | **1** |

**0 pass→fail across all three groups — the acceptance criterion.** Groups A
and B are exactly flat, 0 flips either direction (per-file diff, not count
comparison). Group C has one `fail→pass`:
`language/statements/class/subclass/class-definition-null-proto.js`
(`class Foo extends null {}`, asserting `Object.getPrototypeOf(Foo.prototype.constructor)
=== Function.prototype`) — a legitimate, expected side effect: per §15.7.14
step 6.e, a null-extending class's constructor parent IS `%FunctionPrototype%`,
identical to a no-heritage class, and `extends null` classes have no entry in
`ctx.classParentMap` (there is no real parent), so the fix's class-object
identity ladder correctly includes them as "base" classes. Not a MOP
violation; a correct additional case the fix's own scope note did not call
out by name.

### What did not get measured, and why

**S38's original session left the four-family sample and must-not-move
groups incomplete; a follow-up measurement pass (same branch tip, same fix,
new worktree) completed both to the brief's full spec** — see the
four-family table above and the must-not-move table above, both run on
both labels (base = S37 tip via file-copy revert of the same 5 files,
fix = this branch), fresh `JS2WASM_TEMPORAL_CACHE` per label,
`cacheHit=false` on prewarm. 0 pass→fail across every group measured. The
corpus-wide 129-file `builtin.js` measurement and the vitest witness suite
(both already complete, see above) remain independently corroborating
evidence, not a substitute for this follow-up pass.

Corpus byte A/B (42 modules × {gc, standalone}) is reported in the "Corpus
byte A/B" subsection below.

**Witness**: `tests/issue-6625-standalone-link-boundary-class-object-prototype.test.ts`
— 1 fix-witness `it` (linked class object → `Function.prototype`) measured
failing on the file-copy-reverted base (`false`, expected `true`) and passing
on branch; 6 controls (linked function value, linked instance, linked
subclass, `isExtensible` on the same class object, a local plain object, a
local class through an `any` indirection) unchanged on both trees. Full
suite alongside the other 26 `tests/issue-66*.test.ts` files (27 files / 129
tests total, incl. this slice's own 7): **all pass together** — this run
also caught and fixed TWO now-stale assertions in
`tests/issue-6617-class-instance-prototype.test.ts` that pinned the PRE-#6625
"declines, answers null" behavior for a class-object query (both local and
linked); updated to the new correct `%Function.prototype%` answer with the
underlying "this specific dispatcher still declines" invariant preserved as
a second assertion in the local case.

## Attempt log — a folded-back design (not a wasted attempt, a measured one)

The first cut of this fix was a SEPARATE function,
`tryEmitClassObjectGetPrototypeOf`, called AFTER `tryEmitDynamicCallableGetPrototypeOf`
in `emitBuiltinGetPrototypeOfFallback` (`call-builtin-static.ts`) — mirroring
how #6624 added an independent `isExtensible` boundary terminal alongside
#6617's `getPrototypeOf` one. It typechecked and compiled, but a probe
(`.tmp/s38/dump.mts` → `wasm-dis`) showed `__is_class_object` was minted with
a real body and NEVER CALLED.

Root cause of the miss: `tryEmitDynamicCallableGetPrototypeOf`'s contract is
"return `true` whenever the runtime dispatch was successfully EMITTED", not
"return `true` only when the value turned out to be callable" — its `if/else`
decides the ANSWER at runtime, but the function itself always returns `true`
once its late imports resolve. So the caller's `if (tryEmit…()) return …`
early-returns on the FIRST arm's `true` regardless of which side of its
internal `if/else` actually fired, and a second, independent, sequential
all-or-nothing arm placed after it can never run. This is NOT a mistake
`isExtensible`'s two-terminal design repeats: `Object.isExtensible` has ONE
compile-time call site with no equivalent "already fully handled, unconditional
true" early-return arm ahead of it, so #6624's second terminal was reachable.
`Object.getPrototypeOf`'s dynamic dispatch is a different shape and the
lesson does not transfer without checking each call site's return contract.

Fixed by folding `__is_class_object` into `tryEmitDynamicCallableGetPrototypeOf`
itself — ONE function, ONE call site, the two predicates ORed in the SAME
runtime `if`, both routing to the same `Function.prototype` answer. Kept as a
worked example in this file because the "return true regardless of which
branch fired" contract is easy to miss reading the function's signature alone
and cost a full measure-then-revert cycle to find; a future dynamic-getPrototypeOf
extension should check for it before adding a second sequential arm.
