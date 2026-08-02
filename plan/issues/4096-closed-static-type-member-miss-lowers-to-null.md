---
id: 4096
title: "A member call on a CLOSED static type lowers to `ref.null extern` — an assigned `String.prototype` method silently returns null on ordinary JavaScript"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: ES5
language_feature: method-dispatch
goal: standalone-mode
related: [4056, 2742, 3254, 4064, 4088, 4040]
---

# #4096 — a member miss on a closed static type lowers to `ref.null extern`

**This is a silent wrong answer on ordinary JavaScript**, not a refusal and not
a conformance nicety. It was found while diagnosing #4056 (see #4032 for that
diagnosis record) and it turned out to be the mechanism behind the single
largest unexplained bucket there.

## One-line repro

```js
var __obj = { toString: function () { return "AB"; } };
__obj.toLowerCase = String.prototype.toLowerCase;
__obj.toLowerCase();   // standalone: null      expected: "ab"
```

```js
var a = new Array(1, 2, 3, 4, 5);
a.m = String.prototype.substring;
a.m(0, 200);           // standalone: null      expected: "1,2,3,4,5"
```

Both are correct on the **host** lane. Neither throws, warns, or emits a
compile diagnostic.

## The emitted code — this is the evidence, not an inference

`$test` bodies, standalone, same probe, differing only as noted:

| variant | `ref.null extern` in `$test` | real `call`s | result |
| --- | --- | --- | --- |
| object + assignment INSIDE a function | no | 7 | **correct** |
| object at MODULE TOP LEVEL | **YES** | 4 | wrong (null) |
| `new Array(…)`, even function-local | **YES** | 5 | wrong (null) |

The failing forms compile to `f64.const 0 / drop / f64.const 200 / drop /
ref.null extern`: the arguments are evaluated and discarded and a null is
pushed. A `__proto_method_*` wrapper IS emitted into the module — it is simply
never called.

**Worst consequence:** with a throwing `toString` the receiver's `toString` is
**never invoked at all**, so a `try/catch` that the spec requires to fire does
not fire. The test does not observe a wrong string; it observes that nothing
happened.

## Trigger surface (measured)

`o.toLowerCase = String.prototype.toLowerCase; o.toLowerCase()`. Host is `ok`
in all 14 cells; the table is the standalone lane.

| receiver | declared at module top level | declared inside the function |
| --- | --- | --- |
| object literal | **WRONG** | ok |
| `new Object(42)` | ok | ok |
| `new Number(1234)` | ok | ok |
| `new Boolean(false)` | ok | ok |
| `new String("AB")` | ok | ok |
| `new Array(1,2,3)` | **WRONG** | **WRONG** |
| `new RegExp("AB")` | **WRONG** | **WRONG** |

**The rule:** when the receiver's static type is one the checker treats as
**closed** — an array, a regexp, or a top-level object literal's inferred shape
— and the assigned member is **absent** from that type, the member call is
lowered to a null constant instead of dispatching dynamically or refusing
loudly. Wrapper types (`Number`/`Boolean`/`String`/`Object`) take the dynamic
path and are correct: that is the #2742 / #3254 borrowed-receiver work
functioning as intended.

Note the receiver KIND is not itself the axis — it only decides whether the
checker considers the type closed. An object literal is correct inside a
function and wrong at top level with no other change.

## Why the dynamic path is not simply widened

`src/codegen/expressions/call-receiver-method.ts:942` deliberately limits the
dynamic-dispatch escape to String/Number/Boolean **wrapper** receivers, with an
in-source note that always-dynamic was evaluated and rejected
("Option B") on perf grounds, and that the reassignment scan is deliberately
conservative. So the fix is **not** "delete the gate" — that is the general
point where the blast radius lives (see the −684 result on #4055 v1).

Two directions worth costing, neither yet measured:

1. **Extend the `sourceHasMethodReassignment` escape to any receiver whose
   member is missing from a closed type.** The scan already exists and is
   conservative; the question is whether keying it on "member miss" rather than
   "wrapper receiver" keeps the perf argument intact.
2. **Refuse loudly instead of nulling.** Strictly better than the status quo
   even without dynamic dispatch: it converts a silent wrong answer into a
   diagnosable one, which is the direction this project always takes. Cheap,
   and it makes the true population visible in one baseline run.

## Population

Sized from the fresh standalone baseline (2026-08-02 14:01) + fresh host
baseline, ≤ES5 `built-ins/String/prototype`:

| | n |
| --- | --- |
| run | 630 |
| fail | 130 |
| standalone-only (host passes) — the flippable set | 76 |
| …P2-transferred (`obj.M = String.prototype.M`) | 52 |
| …Object/literal receiver | 36 |
| …of those, no other explanation → **this bug** | **23** |
| …Array receiver | 5 |
| …RegExp receiver | 6 |

⚠️ **34 shape-matched files is the residue, not a flip prediction** (23
Object/literal + 5 Array + 6 RegExp). **23 is the shape-matched unexplained
residue, not a predicted flip count.**
No fix has been measured. The remaining 13 Object/literal files fail for
independently-identified reasons (standalone RegExp-engine limits, the
`not yet implemented in --target standalone` per-member refusal, and one
`env::Cache_match` host-import leak).

This population is only the `String/prototype` directory. The mechanism is
about **member dispatch on closed types**, so it is not confined to
`String.prototype` — corpus-wide scope is unmeasured.

## Acceptance criteria

- The one-line repros return the correct values on both lanes.
- The 14-cell trigger table above is `ok` in every standalone cell, with the
  wrapper rows unmoved (they already pass — a change that breaks them is wrong).
- A throwing `toString` on a top-level object literal receiver actually throws.
- Kill-switch seen to fail: revert the change and confirm the nulls return.
- Report pass→fail and fail→pass from a scoped standalone A/B with rows
  floored; re-run any apparent regression solo.
- If the loud-refusal direction is taken instead, that is an acceptable
  intermediate outcome — but it must be stated as such, and the silent null
  must be gone.

## Fix scoping

### 1. Where the decision is made — what is PROVEN, and what is not

**Proven by probe (standalone lane, receiver `var o = {toString(){return "AB"}}`
at module top level, `o.toLowerCase = String.prototype.toLowerCase`):**

| expression | result |
| --- | --- |
| `typeof o.toLowerCase === "function"` | **correct** |
| `o.toLowerCase === String.prototype.toLowerCase` | **correct** |
| `var f = o.toLowerCase; f.call(o)` | **correct** |
| `o.toLowerCase()` | **null** |
| `o["toLowerCase"]()` | **null** |
| `o.hasOwnProperty("toLowerCase")` | **false** (should be true) |

So the **member read is correct and the value is the right function object**.
Only the *direct method-call* forms are broken, and reading the member into a
temp and invoking it via `.call` **already works today on the same lane**. That
is a working in-tree reference for whatever the call path should do.

**NOT proven — the exact emitting line.** Attribution by reading failed twice
here (once naming `call-receiver-method.ts:3523`, the "imports unavailable"
fallback, which looked like an exact match for the emitted
`drop / drop / ref.null extern` sequence). Both times a **marker bisect**
refuted it:

- Marking `call-receiver-method.ts:3523` specifically → marker **absent** from
  the emitted WAT.
- Marking **all 463** single-statement `fctx.body.push({ op: "ref.null.extern" });`
  sites across **60 files** under `src/codegen/` → marker **absent** from both
  failing repros.

So the null does **not** come from any single-statement `ref.null.extern` push
in `src/codegen/`. It is emitted through some other spelling — an array-literal
instruction list, a helper that builds the instruction, a `coerceType` path, or
a post-codegen pass. **The next person should start by widening the marker
sweep to those spellings, not by reading.** Do not trust a plausible-looking
site in this area without marking it; this file's own #2742 notes record three
prior wrong attributions-by-reading, and this investigation added two more.

The top-level/in-function asymmetry did **not** fall out of any code site
examined. Per the tech lead's own criterion, that is evidence there are **two
decision points, not one** — the placement axis and the receiver-kind axis may
be resolved in different places.

### 2. Three-sided rule — who else reaches this lowering

Not completed, and it is a **prerequisite**, not a formality: the site is not
yet identified, so its readers/mutators cannot be enumerated honestly. What is
already known and constrains any fix:

- **Wrapper receivers (`String`/`Number`/`Boolean`) already take a dynamic exit
  and are correct.** `call-receiver-method.ts:942` gates that exit to wrapper
  receivers with `sourceHasMethodReassignment`, and carries an in-source note
  that always-dynamic ("Option B") was evaluated and **rejected** on perf
  grounds, the reassignment scan being deliberately conservative.
- Therefore the question is **not** "why can't closed types take the same
  exit" in general — it is whether that exit can be widened *only* for the
  member-was-assigned case without paying Option B's cost on every ordinary
  `arr.push(x)` / `re.test(s)` call, which is the hot path the gate protects.
- Adjacent territory to check before touching anything: #4086 / #4010
  (closed-struct member access). A null for an absent member may be
  **load-bearing** for legitimate closed-struct patterns; that must be
  established before it is changed anywhere central.

### 3. Fix options, ranked by narrowness

**(i) Route the assigned-member call through the read-then-`.call` path that
already works.** Lower `o.M(args)` as `(tmp = o.M).call(o, args)` **only** when
`M` is absent from the receiver's static type *and* `sourceHasMethodReassignment`
sees an assignment of `M`. Narrowest: it reuses a lowering proven correct on
this lane rather than inventing one, and the reassignment scan already exists.
*Failure mode:* the scan is source-wide and conservative, so it will also fire
on unrelated same-named assignments, pushing some currently-static calls onto
the slower dynamic path — the exact cost the #942 note is protecting. Needs a
perf check on `arr.push`-shaped hot code, not just a conformance run.

**(ii) Refuse loudly instead of nulling.** Emit a catchable TypeError where the
null is produced today. *Failure mode:* it fixes nothing on the conformance
count and could turn currently-"passing-by-luck" files into failures — so it
must be measured, not assumed to be free. But it converts a silent wrong answer
into a diagnosable one, which is the direction this project takes, and it makes
the true population visible in a single baseline run. **Cheapest way to learn
the real size of this bug.** Strictly better than the status quo even alone.

**(iii) Widen shape tracking so a top-level object literal is not treated as
closed.** *Failure mode:* the most general of the three, hence the largest blast
radius — it changes the static type of every top-level object literal in every
lane, and would reach far beyond method calls. Only worth costing if (i) proves
impossible. Does **not** address the Array/RegExp rows, which fail
function-locally too.

**Recommended order: (ii) to size it, then (i) to fix it.** (iii) last.

## Not in scope here — the sibling sub-defect

The other half of the #4056 diagnosis: seven `String.prototype` members
(`slice`, `trim`, `concat`, `split`, `substr`, `localeCompare`, `search`) have
no arm in `emitStringProtoMemberBody` and hit `emitProtoMemberBodyRefusal`,
which throws `String.prototype.<M> is not yet implemented in --target
standalone`. That is a **loud** refusal, so it is strictly less harmful than
this bug. It is tracked separately as #4095.

## Provenance

- Diagnosis record for the parent investigation: #4056 / PR #4032.
- Nearest relatives, all distinct mechanisms: #4064 (a parameter does not
  shadow a module-level function — silent infinite recursion), #4088 (array
  literal with differing object-literal member counts null-derefs).
- Related lane-gap umbrella: #4040.
