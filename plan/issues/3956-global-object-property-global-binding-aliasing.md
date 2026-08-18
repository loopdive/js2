---
id: 3956
title: "fix(codegen): top-level global-object writes are silently dropped — `this.x = v` / `x = v` never reach `__module_init`, so the global binding does not exist"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
goal: core-semantics
assignee: ttraenkler/s78-sendev
created: 2026-08-01
completed: 2026-08-01
related: [3623, 1387, 3615, 3592, 3468, 3366, 2992, 2671, 1268, 2726, 3493]
# +4 lines on declarations.ts and +1 on index.ts, after the DECISION logic was
# moved OUT of the god-file into the subsystem module #3623 created for exactly
# this concern (`src/codegen/module-init-collection.ts`, +57 there). The first
# draft was +94/+4; moving `createsGlobalObjectBinding` and its rationale out
# left only the call site. What remains in declarations.ts is 3 comment lines
# and one hoisted `const` for the existing named-global test — the arm cannot be
# added at all for fewer lines, since the allow-list decision has to be taken
# where the statement is collected. index.ts is +1: the new pre-scan call, with
# its comment already compressed to two lines.
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/index.ts
# Same +4 lines, counted again at function granularity: they are all inside
# `collectDeclarations`, because that IS the allow-list this issue fixes — the
# decision has to be taken where the statement is collected. The predicate and
# its whole rationale already live in module-init-collection.ts; what is left
# here is 3 comment lines and one hoisted `const`.
func-budget-allow:
  - "src/codegen/declarations.ts::collectDeclarations"
---

# #3956 — global-object property ⟷ global-binding aliasing

## Summary

Two ways of creating a property on the realm's global object at **script top
level** compile to **no code at all**:

```js
this.p1 = 1;   // §9.4.2 — top-level `this` IS the global object
p1 = 1;        // §6.2.5.6 PutValue on an unresolvable reference (sloppy)
```

Both are silently dropped from `__module_init`. A later bare `p1` therefore
either throws `ReferenceError: p1 is not defined` or reads codegen's
auto-allocated-local fallback value (`0`/`undefined`).

A third, separate gap: even when the write *does* land, a name created via
`this.p1 = 1` was never registered as resolvable by a **bare identifier**, so
the read fell through to the same auto-local fallback.

This is **cross-lane** — it reproduces identically in the JS-host and standalone
lanes — and it is a **substrate defect**, not a `with`-statement defect (see
"Why this is not #1387" below).

## Reproduction — three probes, no `with` statement anywhere

Run through the real runner (`runTest262File`, `--target standalone`); all three
are `noStrict` script-goal test262 files.

```js
// (1) ReferenceError: p1 is not defined
p1 = 1;
if (p1 !== 1) { throw new Test262Error('bare implicit global: p1 ===' + p1); }
```

```js
// (2) this.p1 === NaN  — the value round-trips through the SAME expression form
this.p1 = 1;
if (this.p1 !== 1) { throw new Test262Error('globalThis roundtrip: this.p1 ===' + this.p1); }
```

```js
// (3) this.p1 === undefined — bare-assign carrier vs globalThis carrier
p1 = 1;
if (this.p1 !== 1) { throw new Test262Error('readback via global object: this.p1 ===' + this.p1); }
```

Probe (3) initially reads as "two different carrier objects". It is not — it is
the same object; the WRITE was dropped. Proof: `globalThis.p1 = 1; p1 = p1;`
then reading `p1` **works**, because the redundant `p1 = p1` is a bare
assignment that puts `p1` into the `sloppyImplicitGlobals` pre-scan set, and the
`__hasOwnProperty` guard then finds the property the `globalThis` write really
did store. One global object; a missing write.

The identical assignments **inside a function body** have always worked — only
the top-level collection dropped them.

## Root cause

`collectDeclarations` (`src/codegen/declarations.ts`) decides which top-level
`ExpressionStatement`s survive into `__module_init` with an **allow-list**. Its
terminal arm was:

```ts
const targetName = getAssignmentRootIdentifier(expr.left);
if (targetName && (targetName === "globalThis" || ctx.moduleGlobals.has(targetName))) {
  ctx.moduleInitStatements.push(stmt);
}
```

Anything it does not name falls off the end and emits nothing.

1. **`this.p1 = 1`** — `getAssignmentRootIdentifier` unwraps the member chain
   down to a `ThisKeyword`, which is not an `Identifier`, so it returns
   `undefined`. At script top level `this` *is* the global object, so this is the
   same observable realm write the `globalThis` arm (#3493) already keeps — just
   spelled with the other name for it.

2. **`p1 = 1`** — a bare undeclared identifier is not a module global, so the
   check rejects it. The **read** side was already correct: the pre-scan
   (`recordSloppyImplicitGlobalNames`, `src/codegen/index.ts`) put `p1` in
   `ctx.sloppyImplicitGlobals`, so the read emitted the `__hasOwnProperty` guard
   in `emitImplicitGlobalRead` (`src/codegen/global-environment.ts:57`). It was
   guarding a global object the dropped write never populated. That asymmetry is
   the entire `ReferenceError: p1 is not defined` cluster.

3. **Read side** — a name created only by `this.p1 = 1` / `globalThis.p1 = 1` was
   in no pre-scan set at all, so a bare `p1` read missed locals, captures, module
   globals, functions and `sloppyImplicitGlobals`, and landed on codegen's
   auto-allocated-local fallback: it read `0` instead of throwing or returning
   the value.

## Fix

- `src/codegen/declarations.ts` — two new arms in the top-level allow-list:
  `assignmentRootIsThis(expr.left)` (a new helper mirroring
  `getAssignmentRootIdentifier`'s unwrapping, differing only in the terminal
  test), and a bare-identifier arm gated on `ctx.sloppyImplicitGlobals`.
  Both keep the statement unconditionally, matching the #2992 / #3592 / #3615
  arms rather than trying to predict observability.
- `src/codegen/source-scan-predicates.ts` — `collectGlobalObjectPropertyNames`,
  a deliberately narrow pre-scan of top-level `this.<name> = …` /
  `globalThis.<name> = …` writes. Top-level statements only; root must be `this`
  or a non-shadowed `globalThis`; exactly one member step (a deeper chain like
  `this.o.k` writes into `o`, not the global object); static property names only.
  A false positive here converts a silent wrong answer into a thrown
  `ReferenceError`, so the gate is tight.
- `src/codegen/index.ts` — feed those names into the same set the read path
  already consults, so both creation forms resolve identically.

No strict-mode gate on the `this`/`globalThis` arms: a write **through** the
global object is legal in strict code and creates the property there too. The
bare-identifier arm needs no gate either — `collectSloppyImplicitGlobalNames`
is already `isStrictContext`-filtered, so strict code (where the assignment must
throw a `ReferenceError` instead of creating a global) never enters the set.

## Why this is NOT #1387 (`with`)

`language/statements/with` had the worst fail-rate of any ≤ES5 area, and 15 of
its baseline records cite #1387. That attribution is wrong.

The directory is dominated by the Sputnik `S12.10_*` family, which opens with
`this.p1 = 1; this.p2 = 2;` at script top level and reads bare `p1` **after** the
`with` block. Those tests die on this dropped write, before `with` semantics are
reached. They are `fail`, not `compile_error` — #1387's Tier-1 static routing
compiles their object-literal targets fine.

**#1387 should stay `done` for its actual scope.** Reopening it would bury a
cross-lane substrate defect inside a niche legacy feature and mis-size the work.

### Cross-lane measurement (why "standalone gap" is also the wrong label)

`language/statements/with`, whole directory, denominator **181** in both lanes,
from the `20260801-010858` baselines:

| lane                | pass | fail | CE |
| ------------------- | ---: | ---: | -: |
| default (JS host)   |   38 |  131 | 12 |
| standalone          |   37 |  126 | 18 |

Top failure signature is the same in both — `p1 is not defined`, 60 records
default / 57 standalone.

### Strict-mode split (measured, so nobody re-litigates it)

`with` is a strict-mode early error, so part of the directory wants a
**SyntaxError refusal** rather than an implementation. That part is small:
**2 of 126** standalone failures (`12.10.1-10-s.js`, `12.10.1-12-s.js`); 4
records default / 2 standalone inside the directory. The 185-record default-lane
`Expected a SyntaxError to be thrown but no exception was thrown at all` cluster
lives mostly **outside** `language/statements/with`. So the directory is ~98 %
scope/global-binding and ~2 % early-error.

## Relationship to #3623 — this is the eighth and ninth arm

#3623 ("the `collectDeclarations` allow-list is a vacuity generator") documents
this exact mechanism and lists seven prior instances (#1268, #2671, #2992,
#3366, #3468, #3592 RC1, #3615). Its own comment in `declarations.ts` says
"a seventh arm does not stop the eighth". **This issue is the eighth and
ninth.** The durable fix is #3623 phase 1's fail-loud terminal arm; the two arms
added here are a point fix under it.

**Two gaps in #3623 found while cross-checking, which its phases do not
currently cover:**

1. **Phase 2's enumeration excludes assignments by construction.** Its table
   lists `BinaryExpression(Comma)` / `(In)` / `(instanceof)` / `other <op>` —
   every binary operator except the assignment operators — because the scan
   models the allow-list, and the model classifies assignments as `keep`
   (`src/codegen/module-init-collection.ts:156`). So the ~10,000-statement /
   ~500-file phase-2 population is **disjoint** from this issue's shapes;
   phase 2 as scoped would have missed this case.

2. **Phase 1's fail-loud detector is blind to the same class.**
   `declarations.ts` records into `droppedModuleInitShapes` only when the
   disposition is `unhandled`; a dropped assignment classifies `keep` and is
   recorded nowhere. The "nothing reaches a silent drop" contract does not hold
   for the one shape family that is *conditionally* kept — the classifier's own
   doc comment states this in prose ("assignments, whose collection depends on
   the assignment TARGET, not just the operator") and returns `keep` anyway.

   Suggested follow-up for #3623: make the assignment disposition conditional
   (`keep-if-target-matches`) and have `collectDeclarations` record the
   target-check rejects, so a rejected assignment announces itself. The reject
   population is currently unmeasured.

## Measurement

Same box, same run, A/B by **file copy** (never `git stash` in a worktree — the
stash stack is shared across worktrees). Rows floored in both arms. Local
instrument reads BASE slightly differently from CI (35/130/16 vs the published
37/126/18 on this directory), which is exactly why every comparison here is
BASE-vs-NEW on one box and never against the committed baseline.

### `language/statements/with` — complete directory, denominator 181

| arm  | pass | fail |  CE |
| ---- | ---: | ---: | --: |
| BASE |   35 |  130 |  16 |
| NEW  |   55 |  110 |  16 |

**+20 gained, −0 lost.** The one apparent loss (`12.10-0-12.js` →
`compilation timeout 31.2 s`) is parallel-run contention: re-run alone in the
NEW arm it passes.

**+20, not 57.** The `p1 is not defined` cluster was 57 records, but those
Sputnik files assert up to 19 separate things each, so most of them fail again
on a later assertion once the global binding works. The cluster count is a
**gate**, not a flip count — do not re-size off 57.

### Complete affected population, ≤ES5 standalone scope

The change is inert for any file whose top-level statements contain none of the
three trigger shapes, so the affected population is statically enumerable rather
than sampled. See `## Test Results` below.

## Acceptance criteria

- [x] `this.p1 = 1` at script top level creates a global-object property
- [x] `p1 = 1` (sloppy) at script top level creates a global-object property
- [x] A property created either way is readable as a bare identifier
- [x] A bare read of a name that was never created still throws `ReferenceError`
- [x] Measured A/B over the complete affected population, both directions
- [x] #1387 left `done`; #3623 cited as the structural issue
