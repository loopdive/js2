---
id: 5377
title: "`i.constructor === C` is false for a compiled-class instance read through an any-typed receiver — the synthetic `__set_subclass_proto` ctor never maps back to the class value (blocks every linked-Temporal BigInt read: `JSBI.BigInt(i)` cannot short-circuit)"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 — the identity has to be established where the two values MEET,
# and the three places they meet are the class constructor (`class-bodies.ts`),
# the member-read imports (`runtime.ts`) and the instance→prototype cascade
# (`class-instance-proto.ts`). No new module can sit between a host import and
# the built-in read it must precede — that split is exactly what let the
# defect survive #5204's and #5373's partial fixes.
#
# `src/runtime.ts` (+255 net over `origin/main` at 798b8a06e0, MEASURED
# 2026-09-07 by the LOC gate on the merged tree — the earlier +222 figure was
# taken before the second main merge and before the ownership gate): #5373's
# +95 (its three coercion sites and the `_isTaggedUserClassInstance` /
# `_classChainMethod` / `_classChainToString` helpers, RESTATED here because
# this PR carries that commit) plus this issue's ~160 — the two
# instance→class-object registries, `_classObjectForInstance`,
# `_classObjectOwnedBy` (the cross-instantiation ownership gate, +33 with its
# rationale), `_classChainRead`, three call sites, the
# `__set_subclass_proto` fourth argument, and their rationale comments.
#
# `src/codegen/class-bodies.ts` (+65, measured the same way): the
# `__set_subclass_proto` fourth argument (carried to the call site in a LOCAL
# emitted into the LIVE body — a detached array spliced and dropped is reached
# by no shift repair, and the #4618 global-index hazard then minted a SECOND
# class object) and the constructor-entry class-object materialization, plus
# the comments recording the measurements that forced both shapes.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/class-bodies.ts
# Same change, same reason. `resolveImport` physically contains the member-read
# imports and `__set_subclass_proto`; `<anonymous>#95` is the
# `__extern_method_call` closure inside it (both inherited from #5373, restated
# because the grant must live in a file THIS PR modifies).
# `compileClassBodiesInner` is the function that builds every class
# constructor's `FunctionContext`, so the one-line constructor-entry
# materialization and its rationale comment land inside it.
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#95
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #5377 — constructor identity of a compiled-class instance through an any-typed receiver

## Problem

Measured by dev-5373 (PR #5685, `.tmp/` probes, single-module lane, no
Temporal):

```js
class P {}
function mkP() { return new P(); }
function f(i) { return i.constructor === P; }
mkP().constructor === P   // 1   (typed receiver)
f(mkP())                  // 0   (any-typed receiver)   node: true
```

Same for `class B extends Array` (externref-backed, a real host Array tagged
`"B"` in `_userClassTags`). Root cause as diagnosed there: the instance's
`[[Prototype]]` is a **synthetic** `class Sub extends Parent {}` minted by the
`__set_subclass_proto` host import (`src/runtime.ts` ~L17553; registry
`_subclassCtors` / `instanceState.subclassCtors`, keyed by class NAME, #1455 /
#1933), so `i.constructor` through the host answers `Sub`, while the compiled
`P` value is the class object (or its `_wrapForHost` mirror, #5354). Nothing
maps `Sub` back to the class object, and the #1977 "identity unification" that
makes `instance.constructor === SubPromise` hold was done ONLY for the Promise
subclass path (`__promise_subclass_ctor`, `src/codegen/class-bodies.ts`
~L4015–4035 documents it).

### Why it matters — it is the real blocker behind #5373

`jsbi`'s `JSBI.BigInt(i)` (and `__toPrimitive` dispatch generally) opens with
`if (i.constructor === JSBI) return i;` in node; here that is false, so every
`Instant.epochNanoseconds` / `ZonedDateTime.year` read goes on into
`__toPrimitive` on a digit array and dies as `Cannot convert 23396352,513294428,1
to a BigInt` / `infinity is out of range`. PR #5685 fixed the three
coercion-dispatch sites and measured **0 rows moving** on the 123-row and
481-row Temporal samples because of this. It also measured that fixing the
fourth site — the member-READ path `const f = x.toString` (`__extern_get`, its
`intent`-table twin `case "extern_get"`, `_safeGet`) — is correct per node but
**regresses 9 `built-ins/Temporal/Instant/**` rows** when landed alone,
because `i.valueOf` then resolves to jsbi's deliberately-throwing `valueOf`
that node never reaches thanks to the identity short-circuit. So the two must
land together, in this issue.

## Implementation Plan (Fable, 2026-09-06)

**Step 1 — split the reduction by backing.** Two rows, both through
`f(i){ return i.constructor === P }` and `g(i){ return i.constructor }` (return
the value, compare on the host too):
- struct-backed `class P {}` — the `constructor` read arms in `src/runtime.ts`
  ~L18105–18170 (`_fnctorInstanceCtor`, sidecar / `__sget_` paths); the value
  is the class-object mirror. State whether the value is the right object and
  only the compiled `===` (externref mirror vs. struct class object) fails, or
  whether the read itself answers something else.
- host-backed `class B extends Array {}` — the value is the synthetic `Sub`.

Log both with `Object.is`, `.name`, and `_unwrapForHost` identity. This decides
whether Step 2 needs one fix or two.

**Step 2 — unify the identities, per the #1977 precedent.** For host-backed
classes: make the synthetic `Sub` BE the class value's host mirror. Concretely,
give `__set_subclass_proto` the class object (extend `emitSetSubclassProto`,
`src/codegen/class-bodies.ts` ~L598/L2697, with a 4th arg, or register at class
declaration through the existing `__register_class_parent` (#4618) channel),
and on first mint record `classObject → Sub` so `_wrapForHost(classObject)`
(#5354 `_hostConstructorForInstance` / the `_wrapForHost` mirror cache) returns
`Sub` rather than minting a second mirror; and `Sub.prototype.constructor` is
then already right. Key by class-object identity within the module's
`instanceState`, never by name across modules (#5280 hazard). For
struct-backed classes, if Step 1 says only the `===` fails, the fix is in the
strict-equality path: a class-object mirror must compare equal to its class
object (`_unwrapForHost` on the externref side before the reference compare),
or the `constructor` read must hand back the unwrapped class object when the
consumer is compiled code.

**Step 3 — land the member-READ ordering with it.** Port PR #5685's
`_classChainMethod` guard to `__extern_get` / `case "extern_get"` / `_safeGet`
(same gate: `_isTaggedUserClassInstance`, never "looks like an array").
Re-measure the 9 rows PR #5685 listed as regressing when this was landed alone
(`built-ins/Temporal/Instant/from/argument-string-date-with-utc-offset`,
`from/instant-string-multiple-offsets`, `from/instant-string-sub-minute-offset`,
`prototype/add/blank-duration`, `prototype/equals/argument-object-tostring`,
`prototype/equals/argument-string-date-with-utc-offset`,
`prototype/equals/instant-string-multiple-offsets`,
`prototype/equals/instant-string-sub-minute-offset`,
`prototype/subtract/blank-duration`) — they must not regress once the identity
short-circuit works.

**Step 4 — tests.** `tests/issue-5377-class-constructor-identity.test.ts`:
struct-backed and host-backed classes, `i.constructor === C`,
`Object.getPrototypeOf(i) === C.prototype`, `i instanceof C`, through typed and
any-typed receivers, on compiled and host sides; the member-read cells from
#5373's table (`const f = x.toString; f.call(x)` etc.); a two-class same-name
control (two classes named `P` in one module, e.g. block-scoped) to prove the
mapping is by identity, not name. Both lanes (single-module + linked provider).

**Step 5 — measure.** Direct probes: `Temporal.Instant.from("2024-01-01T00:00:00Z").epochNanoseconds`
is a `bigint`; `Temporal.ZonedDateTime.from({year:2024,month:1,day:1,hour:12,minute:34,timeZone:"UTC"}).year === 2024`.
Then the 123-row list and the same 481-row `Instant/**` + `ZonedDateTime/prototype/{…}` sample PR #5685 used
(artifacts in `/home/user/js2/.claude/worktrees/agent-a6c6cab1b4f9c5633/.tmp/`:
`base-123.tsv`, `base-instzdt.tsv` are valid bases if the compiler revision is
the same — otherwise re-run base), fresh `JS2WASM_TEMPORAL_CACHE` per revision,
per-row diff, 0 pass→fail. Never the full 838/6,600-row bucket.

**Order-preservation constraints.** The Promise-subclass path (#1977, #2637
B2.3) already holds the unification and must stay byte-identical — its test
suites (`grep -l "__promise_subclass_ctor\|SubPromise" tests/*.test.ts`) are
the guard. The `__instanceof` walk over `subclassCtors` (#1455) keeps its
name-keyed bucket; this issue adds an identity map beside it, it does not
replace it.

## Acceptance criteria

1. Step 1 answered per backing with the logged identities.
2. `i.constructor === C` true through any-typed receivers for both backings;
   same-name control passes; Promise-subclass suites unchanged.
3. The 9 rows of Step 3 do not regress; `Instant.epochNanoseconds` is a
   `bigint` and ISO `ZonedDateTime.year` reads; 123-row + 481-row samples
   measured, 0 pass→fail, counts with artifacts.

## Notes

- Filed from PR #5685's "reported, not fixed" #1 and #2; supersedes the
  `infinity is out of range` residual bound of #5373.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-06 — highest in-flight issue file
  is #5376 (PR #5682).

## Implementation notes (dev-5377, 2026-09-06 → 2026-09-07)

All figures below were measured in this lane, on this branch, with the base
side re-run from `origin/main`'s `src/` at the merge base (`a4d14695ff`) and a
FRESH `JS2WASM_TEMPORAL_CACHE` per side. The salvaged bases from the killed
lane were NOT reused: main had moved, and the base failure reasons differ.

### Step 1 — answered, and it is two defects, not one

`.tmp/base-step1.log` vs `.tmp/fix2-step1.log`, single-module lane:

| backing | `i.constructor` answers (base) | `=== C` base → fix |
| --- | --- | --- |
| struct-backed `class P {}` | `%Object%` — a function named `Object`, so the READ itself is wrong, not just the compare | 0 → 1 |
| host-backed `class B extends Array {}` | the synthetic `Sub` — `Object.is(Object.getPrototypeOf(i).constructor, i.constructor)` is `true` on base, and `Object.is(i.constructor, B)` is `false` | 0 → 1 |

The typed-receiver read was already right on base (`sTypedEq`/`hTypedEq` = 1),
so the defect is specific to the any-typed path, exactly as filed.

### The salvage commit: codegen half kept, runtime half reverted

`ad7925c7ca` (uncommitted-then-salvaged work from the killed lane) changed two
things. Kept: routing the class object to `__set_subclass_proto` through a
LOCAL emitted into the live body — with it the Temporal polyfill mints exactly
ONE class object per class per instantiation (`.tmp/dbgM5.log`). Reverted: the
`constructor` arm returning the RAW class-object struct instead of the
`_wrapForHost` mirror. Its rationale ("#5222 makes the mirror unequal inside a
linked provider") was drawn from a run made BEFORE the codegen half, when the
module still had two JSBI class objects — so `===` was false for that reason.
With one class object the mirror compares EQUAL (`.tmp/dbgM2.log`,
`ca=object#1 cb=object#1 same=true`), the raw struct changes no Temporal
outcome, and it costs two node-matching cells (`typeof i.constructor` answers
`"object"` where node says `"function"`).

### The ownership gate — why both arms stand down across instantiations

Landing the two arms UNGATED regressed 5 rows of the 481-row sample
(`.tmp/diff-instzdt.txt`), 4 of them from the 9 the plan names. Root cause is
NOT the identity work: one process runs many instantiations (test262 runs a
sloppy pass and a strict rerun per file, hundreds of files per worker), and a
value built by instantiation N reaches a host mirror still dispatching through
instantiation N-1's export map (`.tmp/dbgM5.log`: `inst=object#226`,
`classObj=object#125`, arriving with `exports=object#3` whose own `JSBI` is
`object#1`). In that state no answer can compare equal, so `_classObjectOwnedBy`
detects it and both arms return `_MISS`, preserving the caller's pre-#5377
behaviour byte-for-byte.

### Measurements

| sample | base | fix | fail→pass | pass→fail |
| --- | --- | --- | --- | --- |
| 481-row `Instant/**` + `ZonedDateTime/prototype/**` | 254 pass / 227 fail | **261 pass** / 220 fail | 7 | **0** |
| 123-row Temporal family | 13 pass / 110 fail | 13 pass / 110 fail | 0 | 0 |
| the 9 rows named in Step 3 | 9 pass | 9 pass | — | 0 |

Artifacts: `.tmp/base-instzdt.tsv`, `.tmp/fix2-instzdt.tsv`,
`.tmp/diff2-instzdt.txt`, `.tmp/base-123.tsv`, `.tmp/fix2-123.tsv`,
`.tmp/diff2-123.txt`.

### Reported, not fixed

1. **Cross-instantiation dispatch through a stale export map.** The direct
   probe `Temporal.Instant.from("2024-01-01T00:00:00Z").epochNanoseconds` now
   PASSES outright in a fresh process — it is a `bigint` and equals
   `1704067200000000000n`, the first time that read has ever worked (base on
   the same tree: `SyntaxError: Cannot convert 23396352,513294428,1 to a
   BigInt`; `.tmp/nbase-temporal.json` vs `.tmp/nfix-temporal-fresh.json`).
   But the result is ORDER-DEPENDENT: in a process that has already run other
   Temporal files, the strict rerun's values are dispatched through the
   previous instantiation's export map and the probe fails again
   (`.tmp/fix2-temporal.json`). That is a pre-existing
   host-mirror/export-binding defect, orthogonal to constructor identity, and
   it bounds every remaining linked-Temporal BigInt read — including, since a
   sharded test262 worker runs hundreds of files per process, how much of the
   +7 generalises across a full run.
2. **ISO `ZonedDateTime.year`** still fails with `infinity is out of range`,
   unchanged from base — a separate arithmetic path, not an identity one.
3. **`Object.getPrototypeOf(hostBackedInstance) === B.prototype`** stays 0
   (pinned in the test at the measured value). Unifying the two prototype
   objects would have to re-point the instance at the compiled carrier, which
   breaks the `instanceof Parent` walk `__set_subclass_proto` exists to
   preserve.
4. **`typeof i.constructor`** is `"object"` in the single-module lane
   (`"function"` across the linked seam, where the constructible mirror is
   minted); node says `"function"` for both. Unchanged by this issue.

### Pre-existing red suites, verified identically red on base

`tests/issue-1567.test.ts` (1 test), `tests/issue-2637-b2-ctor-closure-registration.test.ts`
(1 test) and `tests/issue-1933.test.ts` (OOMs the vitest worker) fail the same
way with this branch's `src/` replaced by `origin/main`'s.
