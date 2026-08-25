---
id: 4017
title: "Standalone error model — throw where the spec requires (Overlay A)"
status: done
completed: 2026-08-02
assignee: ttraenkler/M-errmodel
sprint: 78
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
goal: error-model
---

## Problem

The "engine did not throw where the spec requires" overlay from the ES5+untagged
tail census (`plan/log/analysis-2026-08-01-es5-untagged-tail-census.md`,
Overlay A). It is an **overlay, not a bucket** — it overlaps the mechanism
partition and must never be added to it.

## Measurement (re-cut, do not quote the census's numbers for this)

**Baseline provenance — quote this with every number below.** Standalone JSONL,
`oracle_version` 12, 48,619 rows / 0 bad JSON / 0 duplicate `file` keys, row
timestamps **1.8.2026 22:26:49 → 22:36:19**. Host lane joined from
`test262-current.jsonl` (48,362 rows).

| | census (19:0x) | this issue (22:3x) |
| --- | ---: | ---: |
| official | 43,106 / 25,755 (59.7 %) | 43,505 / 25,929 (59.6 %) |
| goal scope (`es5id` present OR none of `es5id`/`es6id`/`esid`) | 8,545 / 6,176 (72.3 %) | **8,545 / 6,242 (73.0 %)** |
| goal-scope non-pass | 2,369 | **2,303** |
| Overlay A | 155 (70 SA-only / 85 both) | **159 (76 SA-only / 83 both)** |

### The corpus was five months stale, and the miss counter is the only reason anyone knew

First measurement: **401 official rows whose corpus file could not be opened**
(the census reported 0 — correctly, since it could not see what it could not
open). Cause: `/workspace/test262` was pinned at `63829c6d` (2026-03-06) while
the baseline had been scored against a newer corpus. Goal scope was therefore
reported as a **floor**, `8,545 ≤ N ≤ 8,946`.

The corpus was synced mid-session. Re-measured on the complete corpus:
**0 unopenable, goal scope exactly 8,545 / 6,242**. All 401 were `esid`-only
(`esid` 31,569 → 31,970, every other id-key bucket unchanged), so the desync
never touched goal scope. The floor collapses to a point — but that was a
*result*, not something the first measurement was entitled to assume.

### Overlay A is eight mechanisms, not one

Detector: harness `assert.throws` "no exception was thrown at all" (132) + the
S-series `lead to throwing exception` idiom (27). Negative control: says **NO to
2,140** of 2,303 goal-scope non-pass.

| | files | SA-only | both |
| --- | ---: | ---: | ---: |
| M3 descriptor / `defineProperty` / `create` | 67 | 25 | 42 |
| M2 `this`-coercion (ToObject / brand check) | 22 | 17 | 5 |
| **M1 `new` on a non-constructor** | **21** | **13** | **8** |
| M5 restricted props (`caller`/`callee`) | 21 | 5 | 16 |
| M6 abrupt completion from user `toString`/`valueOf` swallowed | 14 | 10 | 4 |
| M4 strict assign to non-writable | 9 | 6 | 3 |
| M7 `with`/`eval`-gated | 4 | 0 | 4 |
| M8 misc | 1 | 0 | 1 |

**M3 is parked**, not split: it sits exactly where #4010 (M-substrate) is
rewriting the receiver side-tables, and 42 of its 67 fail host-lane too, so it is
neither purely a missing throw nor purely a standalone-substrate problem. Its
population will move once #4010 lands; re-measure then. File list:
`.tmp/mech-M3-descriptor.txt` in the authoring worktree.

### Two refutations

1. **`"Expected a TypeError but got a undefined"` (19 files) is NOT in this
   overlay.** Reading `test262/harness/assert.js`: that message is produced when
   a throw *did* happen but `thrown.constructor.name` was `undefined`. It is an
   error-**identity** defect, not a missing throw. Including it would have
   inflated the overlay by ~12 %.
2. **`negative:`-frontmatter tests contribute 0 additional files**, and a generic
   `/expected .{0,40}\bthrow/i` prose regex is a false-positive generator — its
   only match was `Expected SameValue(«null», «"prior to throw"»)`. Both dropped.

## Root cause (M1) — the proof existed, the vehicle did not

`src/codegen/expressions/new-super.ts`, the `new <id>` unknown-constructor path:

```ts
if (ts.isIdentifier(s1Callee) && !noJsHost(ctx) && resolvesToNonConstructableValue(ctx, s1Callee)) {
```

`resolvesToNonConstructableValue` **already proves** at compile time that the
callee has no `[[Construct]]`. The branch is gated on `!noJsHost(ctx)` because
its *vehicle* is the `__construct` host import. In standalone the gate discarded
the vehicle **and the proof**: control fell through to the terminal
`__new_<name>` lookup, found no import, and emitted a bare `ref.null.extern`.
`new (String.prototype.charAt)` therefore evaluated to `null` instead of
throwing.

Confirmed by compiling both lanes, not inferred — host emits
`env::__construct` + `env::__new_TypeError`; standalone emits **zero** imports
and never throws.

This is the fourth instance today of one defect class (#3983, #3984, #3991): **a
static path that knows the answer degrades to a silent wrong answer when its
implementation vehicle is unavailable.**

### Why a second, narrower predicate rather than reusing the existing one

`resolvesToNonConstructableValue` also claims `.bind()` / `.call()` / `.apply()`
initializers. That is sound only because the host vehicle re-checks
`IsConstructor` at runtime. Those shapes are **not** statically decidable:

- a bound function **is** a constructor when its target is (§10.4.1.2);
- `f.call(x)` / `f.apply(x)` **return** an arbitrary value, which may be a
  constructor (`var C = mk.call(null); new C()`).

Inheriting the over-claim would emit spurious `TypeError`s on legitimate
constructions — worse than the bug being fixed. `provablyNonConstructableStatically`
therefore covers only arrow-function initializers and
`<AmbientIntrinsic>.prototype.<method>`, the latter gated on
`resolvesToAmbientGlobal` because a **user** `Foo.prototype.bar = function(){}`
IS an ordinary function with `[[Construct]]`.

## At-risk enumeration (trigger-shape, complete over openable official files)

The change is inert unless the source contains one of three shapes, so a static
TypeScript-parser scan converts "what could move?" into a population rather than
a sample. Scanned **43,505 official rows, 0 unopenable, 0 parse failures**
(after the corpus sync — before it, 401 were not covered).

| trigger | lanes | population | currently PASSING (at risk) |
| --- | --- | ---: | ---: |
| T1 `new <arrow-var>` | standalone | **0** | 0 |
| T2 `new <proto-method-var>` | standalone | 25 | **6** |
| T3 `new <ident>.prototype` | both | 3 | 0 |

T1 has population 0 — that arm is inert on test262 and is carried for
correctness, not yield. The 6 T2 at-risk files are the rest of the `S15.5.4.*_A7`
family (`match`, `charCodeAt`, `split`, `concat`, `replace`, `localeCompare`).
They pass today and assert exactly the `TypeError` the fix now emits, so they
were *expected* to stay green — but that argument is not the evidence; running
them is.

## Result

Verification set = **12 targets + all 6 at-risk files**, run individually in the
standalone lane: **18 / 18 pass**.

| | |
| --- | ---: |
| population (Overlay A, M1 mechanism) | 21 |
| reachable by this change | 12 |
| **flipped fail → pass** | **12** |
| at-risk files enumerated | 6 |
| at-risk files regressed | **0** |

Attribution proven by **kill-switch removal**: with the pre-change file restored,
`Function/prototype/S15.3.4_A5` returns the exact
`Expected a TypeError to be thrown but no exception was thrown at all`
signature. The other two spot-checks timed out under concurrent agent load
rather than re-failing cleanly — that is instrument noise, not evidence, and the
baseline JSONL independently records all 12 as non-pass.

The 9 M1 files NOT reached are a different shape and are listed as remaining
work below: `new <this-as-global>` (3), calling a non-callable *instance*
(`var s = new String; s()`, 4), and two singletons. **21 population ≠ 21 flips**
was the correct expectation.

`tests/issue-4017.test.ts` — 7 cases, 3 of them negative controls (user
prototype method, `.bind()` result, `.call()` result must NOT throw). Those
three are the load-bearing half: they are what stops a future widening of the
predicate from rejecting legitimate constructions.

### No budget allowance was taken

Three ratchets fired and all three were resolved architecturally rather than
with a declaration:

- **oracle-ratchet** (`ctx.checker` +1). Fixed by collapsing the two predicates
  onto **one** `classifyNonConstructableValue` that reports a strength, so a
  single symbol lookup serves both callers. Net `ctx.checker +0`. This is also
  the better design — the old boolean is what let the over-claim happen.
- **LOC budget** (`new-super.ts` 4532 > 4438). Fixed by lifting the whole
  "does this callee have `[[Construct]]`?" analysis into
  `src/codegen/expressions/non-constructable.ts` (with `resolvesToAmbientGlobal`,
  which belongs with it), leaving a one-line re-export for the two existing
  importers. `new-super.ts` shrinks below baseline; no `loc-budget-allow` needed.
- **func-budget** (`compileNewExpression` 1425 > 1378). Fixed by giving the five
  copy-pasted `emitThrowTypeError("is not a constructor") + ref.null.extern +
  return` bodies a single emitter, `emitStaticNotAConstructorThrow`, and merging
  the two `.prototype` arms into one predicate. The function ends up **smaller
  than before this change** — no `func-budget-allow` needed. Each gate pushed the
  change toward the shape it should have had; none of them was noise.

Both gates FALSE-FAILED first against `origin/main`, which in this checkout is
the **fork's** diverged main (#4002). `LOC_GATE_BASE=$(git merge-base upstream/main HEAD)`
and `CHANGED_ROOT_TESTS_BASE=upstream/main` are required locally; the first
oracle-ratchet run blamed `getTypeAtLocation +2, ctxChecker +3` — changes made
upstream by other people, in files this branch never opened.

## Remaining work, with root causes named

- **M1 residual (9 files)** — `new <global-object>` via `var g = this` (3);
  calling a non-callable *instance*, `var s = new String; s()` (4, a **call**
  site, not `new`); `Promise.try` and `S13.2.2_A2`.
- **M2 (22, 17 SA-only)** — `this`-coercion on borrowed built-in methods.
  Root cause located: `src/codegen/expressions/calls.ts` ~7037 wires
  `Object.prototype.{hasOwnProperty,propertyIsEnumerable}.call(o, k)` straight
  into `compilePropertyIntrospection` with **no `RequireObjectCoercible` on the
  borrowed receiver**, so `.call(undefined)` answers `false` instead of throwing.
  The precedent for the fix is 15 lines above it: the String arm already routes
  through `emitBorrowedStringReceiverToString` for exactly this reason (#3254).
  `valueOf`/`toLocaleString` are additionally not wired at all.
- **M5 (21, 5 SA-only)** — `caller`/`arguments`/`callee` poison-pill accessors.
- **M6 (14, 10 SA-only)** — abrupt completion from a user-defined
  `toString`/`valueOf` is swallowed. Likely a **much larger lever than its
  overlay slice**, because the real statement is "the standalone string-coercion
  fast path never invokes user `toString`" — but that is an unmeasured claim
  here, and it is a separate root cause and a separate PR.
- **M3 (67)** — parked pending #4010, see above.
