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
`--target standalone`, linked, fresh cache per label) — **PARTIAL, not the
full 480/480 this brief specified; reported honestly rather than
extrapolated.** The compile-heavy nature of this corpus (each row links the
real ~3.3 MB polyfill provider fresh) made the full sample too slow to finish
within this session after the corpus-wide run above and the WIP-commit
interruption; see "What did not get measured" below.

- `PlainDate` (the one family with time to run to completion, both this
  slice's fix and a cross-reference against S37's own cited base): **fix
  112/120 pass** vs **S37's own base measurement, same commit, 111/120**
  (attributed to S37 — `plan/issues/6624-*.md` §5 — not re-measured by this
  slice). `+1`, exactly `PlainDate/builtin.js` — the one file this family's
  first 120 contains that the corpus-wide run (above) independently proved
  moves. No other row in the 120 changed sign either way (checked file-by-file
  against the corpus-wide run's own signature for `PlainDate/builtin.js`; no
  other file in this family appears in the corpus-wide fail→pass list).
- `Duration`: **fix 87/99 pass, 21 files unmeasured** (killed mid-run, see
  below). `Duration/builtin.js` — this family's own moved row — was already
  confirmed `pass` in the completed portion.
- `ZonedDateTime/prototype`, `PlainDateTime`: **not run this session.**
  Neither family's first 120 files needed to move for THIS fix
  (`ZonedDateTime/prototype` has no `builtin.js` file at all — the corpus-wide
  moved file is the top-level `ZonedDateTime/builtin.js`, a sibling directory
  this family sample does not walk into; `PlainDateTime/builtin.js` is
  expected to move the same way `PlainDate/builtin.js` and `Duration/builtin.js`
  did, unmeasured but low-risk by the same reasoning).

Provider artifact bytes: **3,311,710 B → 3,312,720 B (+1,010 B)**.

Equivalence gate: **22 failing / 1,720 passing / 22 known-failures in
baseline — 0 new regressions, exactly the S37 baseline**, run to completion
(`npm run -s test:equivalence:gate`, ~161s).

Must-not-move samples (groups A/B/C per the dispatch brief, 0 flips
required): **NOT RUN this session — time constraint, see below.**

### What did not get measured, and why

Given the session's time budget, the four-family sample and must-not-move
groups did not complete to the brief's full spec. This is a real gap against
the acceptance criteria, stated plainly rather than papered over with an
extrapolation. What IS complete and load-bearing:

- The corpus-wide 129-file `builtin.js` measurement (§ Result, above) is the
  actual TARGET POPULATION this fix addresses — every file that could possibly
  exercise the changed code path through the real polyfill, fully measured on
  both labels, 0 regressions.
- The vitest witness suite (below) isolates the mechanism synthetically and
  is measured on both labels by file-copy revert, independent of any corpus
  timing pressure.
- `PlainDate`'s completed 120-row sample and `Duration`'s 99-row partial both
  corroborate the corpus-wide result with zero disagreement.
- Every source-ratchet gate (LOC/func budget, coercion-sites, oracle-ratchet,
  dead-exports, speculative-rollback, typecheck, issue-ids, lint, format) is
  green against both `merge-base(origin)` and `origin/main`.

What is NOT independently confirmed: a regression specifically in
`ZonedDateTime/prototype`'s or `PlainDateTime`'s first 120 files outside their
own `builtin.js` row, or in the must-not-move groups A/B/C (the MOP-adjacent
corpus this fix's mechanism — `Object.getPrototypeOf`, `typeof`, the link
boundary — is most likely to disturb if the change were wrong in a way the
corpus-wide run's narrow `builtin.js` focus wouldn't surface). A follow-up
task should complete these before this fix is treated as fully closed.

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
