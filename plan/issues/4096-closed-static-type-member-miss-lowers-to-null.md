---
id: 4096
title: "A direct call on an assignment-STORED function member lowers to `ref.null extern` — the callee never runs, on ordinary JavaScript"
status: done
completed: 2026-08-02
assignee: ttraenkler/senior-4096-elision
sprint: 78
created: 2026-08-02
updated: 2026-08-18
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

## RESOLUTION (2026-08-02) — what was actually wrong, and why the scoping above was half right

**The site is pinned, and the framing changed.** Both are results of
instrumentation, not reading; the scoping section above is preserved verbatim as
the record of what was believed going in.

### 1. The emit site — pinned by instrumentation

`src/codegen/expressions/call-tail-dispatch.ts`, the **graceful fallback** at the
tail of `compileTailDispatch`: compile the callee for side effects → `drop`,
compile each argument → `drop`, push `ref.null.extern`.

Method (the marker sweep the scoping section asked for, generalised so no
spelling can hide): wrap `Array.prototype.push` as a chokepoint, record a stack
trace for every pushed instruction with `op === "ref.null.extern"`, compile the
FAILING repro and the PASSING one, and diff the site sets. Exactly **one** site
is in the failing set and not the passing one, on the first run. This catches
array-literal instruction lists, builder helpers and spread pushes — the
spellings a per-source-line marker sweep cannot see.

**The earlier 463-site sweep's negative result was an INSTRUMENT FAILURE, not
evidence about the code — and the conclusion drawn from it misdirected this
issue.** That sweep marked "all 463 single-statement
`fctx.body.push({ op: "ref.null.extern" })` sites across 60 files" and reported
the marker absent from both repros. The site above **is** a plain
single-statement push of exactly that form, i.e. inside the class the sweep
claimed to have covered. From the absence it concluded "the null does not come
from any single-statement push — start by widening the marker sweep to array
literals / builder helpers / coerceType / post-codegen passes", which sent the
follow-up brief looking in four places the bug was never in.

This is not a criticism of that sweep — reporting a refuted attribution
honestly is what made the second attempt possible at all. It is the epistemic
correction, and it generalises: **a negative sweep with no fired positive
control rules out nothing.** "Marker absent everywhere" and "marker never
applied" produce byte-identical output. Any future marker/bisect sweep in this
area should first mark a site it KNOWS is on the path and confirm that marker
appears; without that, a clean negative is not a result. The push-chokepoint
instrument used here has the property built in — it records every site it sees,
so an empty capture set is visibly an instrument failure rather than a finding.

### 2. The framing: NOT "a member absent from a closed type"

Measured on the standalone lane, top-level object literal:

| probe | result | what it proves |
| --- | --- | --- |
| `var g = o.f; g()` | correct | the member read is right |
| `typeof o.f === "function"` | true | the value is a function |
| `o.f = A; o.f = B; var g = o.f` | sees **B** | it is a REAL runtime store, not a static fold |
| `o.f()` | **null** | only the direct call form is broken |

The member is **present and correct**. And the trigger is not `String.prototype`
transfer: `var o = {a:1}; o.f = function(){return 7}; o.f()` returns `undefined`
on its own. The defect is a **direct call on any assignment-stored function
member**, which is far more ordinary JavaScript than the original framing.

**This SUPERSEDES the scoping section's "there are two decision points, not
one".** There is **one**: in `call-receiver-method.ts` the any-receiver
closed-method dispatcher is gated on `isAnyOrExternref`, and an in-function
object literal gets an **externref** local carrier while a top-level one keeps
its concrete struct-ref carrier. Arrays and regexps keep a concrete carrier in
both placements — hence their rows being wrong in both columns. #3117 had
already fixed exactly this shape for the `any` twin by adding
field-stored-closure arms to that dispatcher; the concrete carrier is simply
what keeps a receiver out of it. The placement axis and the receiver-kind axis
are not resolved in different places — they are the same question ("is the
carrier externref?") asked once.

### 3. The fix

One arm immediately before the graceful fallback (both now in
`src/codegen/expressions/stored-member-closure-call.ts`, which also took over
the fallback itself so the silence and its narrowings sit together):

```
T = <receiver as externref>
F = <o.M   as externref>          ; the member read that already works
__apply_closure(F, T, [args…])    ; the #1888/#3117 this-threaded bridge
```

This is option **(i)** — route through the read-then-`.call` lowering already
proven on this lane — reusing the *same* bridge #3117 uses, so no new dispatch
vocabulary. Admission: standalone/wasi only · identifier receiver (read twice,
so it must be side-effect free) · non-builtin-class receiver · no spread · arity
≤ 8 · and `sourceHasMethodReassignment` sees a `.<name> =` assignment.

That last one is the real gate, and it is the #1397 scan the `#942` note
already relies on. It is the right predicate because **the assignment is what
creates the shape**. The `#942` perf objection ("Option B, always dynamic, was
rejected") does not bite here: the arm runs only after every static arm has
declined, so `arr.push(x)` / `re.test(s)` never reach it — and nobody writes
`x.push = …`, so even the scan's deliberate over-approximation cannot pull an
intrinsic onto the dynamic path. **The `#942` gate was not touched.**

**What the gate costs when it is ON.** `sourceHasMethodReassignment` is a
per-**module**, per-method-**name** source scan (cached per
`(SourceFile, name)`), not a per-call-site or per-receiver-type test: one
`x.push = …` anywhere in a file turns it on for every `.push` in that file. That
sounds like the #942 hazard, and is not, for a reason that does not depend on
the gate at all: **the arm runs only at the TAIL of `compileTailDispatch`**,
after every static arm has declined. `arr.push` / `re.test` / a declared
object-literal method / a class method / the wrapper methods are all claimed
earlier and never reach it, whatever the scan answers. So the gate does not
route "all direct member calls" anywhere — it can only narrow the set of calls
that were *already* falling to `ref.null.extern`, i.e. already returning
`undefined` without running. The marginal cost is one dynamic dispatch on a call
that previously did nothing; the perf blast radius on hot intrinsic calls is
zero by construction.

Asserted-and-then-measured, not just argued: the
`gate cost — the scan being ON must not pull an intrinsic off its fast path`
tests compile a module that reassigns `push` (resp. `test`) AND makes the hot
`a.push(3)` / `re.test(s)` call, which is the exact shape that would expose the
regression if the gate were load-bearing for dispatch. Both keep their native
paths and the reassigned member also runs.

**Three-sided rule.** *Readers* of the fallback: it is the terminal arm of
`compileTailDispatch`, reached only after IIFE / super / element-access /
call-of-call / conditional-callee have all declined, so nothing reads a value it
produces except the call's own consumer. *Mutators*: none — it is emit-only.
*What consumers tolerate*: they tolerate `undefined`, which is exactly what
`__apply_closure` answers for a non-callable or an unsupported arity (its S1
no-throw carve-out). So a mis-admitted shape lands on the identical value the
fallback produced. The arm can only ever convert an `undefined` into a real
call; it cannot displace a working path. The #4086/#4010 "a null for an absent
member may be load-bearing for closed-struct patterns" concern therefore does
not apply — no closed-struct member READ changed.

### 4. Measured

Kill-switch attribution (revert the arm only): exactly the 7 fix cases in
`tests/issue-4096-stored-member-closure-call.test.ts` fail, all 5 controls stay
green.

14-cell-equivalent trigger table, standalone, before → after:

| shape | before | after |
| --- | --- | --- |
| top-level obj literal, expando user fn | null | **7** |
| …with `this.a` | null | **5** |
| …with 2 args | null | **34** |
| top-level obj literal, `String.prototype` transfer | null | **"ab"** |
| …2-arg `substring` | null | **"AB"** |
| **throwing `toString` — does the callee RUN?** | never ran | **throws** |
| `new Array(…)`, expando user fn | null | **7** |
| `new Array(…)`, `String.prototype.substring` | null | correct |
| array literal, expando user fn | null | **7** |
| in-function obj literal (control, was OK) | ok | ok |
| wrapper `new String` transfer (control) | ok | ok |
| `new Number().valueOf()` (control) | ok | ok |
| `arr.push` / `re.test` (controls) | ok | ok |

The throwing-`toString` row is the acceptance criterion that matters: it does
not check a value, it checks that anything happened at all.

## Residuals — measured, NOT fixed here

1. **`o.hasOwnProperty("M")` on an assignment-stored member is still `false`**
   (and so are `"M" in o`, `for-in`, and the computed read `o["M"]`), while a
   DECLARED field answers all four correctly. This is a **different subsystem**:
   `object-ops.ts` answers a closed-struct `hasOwnProperty` from
   `resolveWasmType(receiverType)`'s struct fields plus the checker's property
   list, and the assignment-added member is in neither — `propertyFactOf`
   answers `unresolvable` for it on both a `.ts` and a `.js` compile. Curing it
   means changing which struct/shape the own-property reflection resolves, which
   moves `hasOwnProperty` / `in` / `for-in` / `Object.keys` together — the
   #4086 / #4010 territory this issue's own scoping flagged. Folding it in here
   would have replaced a narrow, provably-non-displacing arm with a change to
   the shape registry. Filed as **#4116** rather than done badly.
2. **RegExp receiver, expando function member** is still wrong — but for a
   reason this fix structurally cannot reach: on a RegExp the **READ** is
   already broken (`var g = r.f; g()` is wrong on the same lane), so there is no
   correct value for the call arm to invoke. Object-literal and Array receivers
   both read correctly, which is why they flipped.
3. The runtime-`null`/absent-member case answers `undefined` where §7.3.14 step
   2 wants a `TypeError`. That is `__apply_closure`'s pre-existing S1 no-throw
   carve-out (documented on `fillApplyClosure`, kept for the late-registration
   index-shift reason); this arm inherits it and does not widen it.

## Population — DO NOT RE-SIZE FROM THE OLD BASIS

The "34 shape-matched files is the residue, not a flip prediction" sentence
above stays true **and is now also the wrong denominator.** Both the 630/130/76
table and the 34-file residue were sized over
`built-ins/String/prototype`, ≤ES5, for the shape
`obj.M = String.prototype.M`. That is one *instance* of the defect, not its
extent: the mechanism is a direct call on **any** assignment-stored function
member, on any receiver whose Wasm carrier is a concrete struct ref, with a
plain `o.f = function(){…}` affected identically. Anything sized from
`String.prototype` transfers is a lower bound on an unknown quantity.

Corrected basis for any future sizing: files containing a `<expr>.<name> = …`
assignment whose `<name>` is later CALLED directly on a concretely-carried
receiver — corpus-wide, not one directory, and not restricted to builtin
prototype sources.

What was actually measured here (scoped standalone, per-file solo,
`runTest262File` status — **not** the CI path):

| population | n | fail→pass | pass→fail |
| --- | --- | --- | --- |
| `built-ins/String/prototype`, shape-matched | 144 | **+21** | **0** |
| `built-ins/Array/prototype`, shape-matched (control) | 153 | 0 | **0** |

The Array control is all-fail on both sides — it constrains regressions, and
says nothing about gains. The corpus-wide population stays unmeasured; the
`merge_group` run is the measurement.

## Provenance

- Diagnosis record for the parent investigation: #4056 / PR #4032.
- Nearest relatives, all distinct mechanisms: #4064 (a parameter does not
  shadow a module-level function — silent infinite recursion), #4088 (array
  literal with differing object-literal member counts null-derefs).
- Related lane-gap umbrella: #4040.
