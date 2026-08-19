---
id: 4202
title: "Top-level `this` is refused as a `.call`/`.apply` receiver, so the callee sees its unbound `this` instead of the global object"
status: done
created: 2026-08-07
completed: 2026-08-07
sprint: 78
priority: high
task_type: bug
area: codegen
goal: standalone-gap
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/W21
horizon: m
related: [4025, 3983, 3796, 3365, 4190, 4192, 4196, 4201, 4203, 4184]
---

# #4202 — a top-level `this` receiver is thrown away by the receiver-install gate

## Repro (both `--target standalone` AND the JS-host lane)

```js
function f() { "use strict"; return this; }
f.call(this);    // undefined  — want the global object
f.apply(this);   // undefined  — want the global object

function g() { "use strict"; return this; }
var o = {};
g.call(o) === o; // true — an ordinary object receiver already worked
```

That is `language/function-code/10.4.3-1-{70,75}{-s,gs}` verbatim.

## Root cause

`named-this-call.ts` (#3796/#4025 `.call`, #3983 `.apply`) already reserves an
exact-target trampoline that saves, installs and restores `__current_this`
around the call, and it works — `g.call(o) === o` is true today. The receiver
never reached it because of one line in the admission gate:

```ts
if (inner.kind === ts.SyntaxKind.ThisKeyword) return fctx.readsCurrentThis === true;
```

`readsCurrentThis` asks whether the **calling** function reads the ambient
receiver global. At Script top level the calling function is `__module_init`,
whose own `this` takes the #3365 arm and compiles **directly** to the global
object — it never touches `__current_this`, so the flag is false and a
perfectly good, provably non-null receiver was refused. The call then fell
into the legacy lowering, which evaluates `thisArg` and **drops** it: a silent
wrong answer, the same class #4025/#3983/#4192 removed for their shapes.

The `ThisKeyword` special case exists because `typeFactOf(this)` cannot be
consulted the way an ordinary receiver's can, so the gate had to name the one
context it knew produced a live receiver. Top-level was simply the context it
did not name.

## Fix

`src/codegen/helpers/sloppy-this-global.ts` grows one predicate,
`thisReceiverIsGlobalObject(ctx, fctx, receiver)`, which mirrors the
`ThisKeyword` lowering's own #3365/#4190 arm exactly — same three earlier
bindings ruled out (typed-this param, a `this` in `localMap`, static class
context), then `fctx.name === "__module_init" && !ctx.sourceIsModule &&
thisBelongsToTopLevelCode(receiver)`. It lives beside `emitUnboundThis` and
`thisBelongsToTopLevelCode` so the question "what does this `this` evaluate
to?" stays answered in one module; `named-this-call.ts` only consults it.

**Why it is stated as "compiles to the global object" and not "is non-null".**
Widening the gate to "any `this`" would be wrong, not merely broad. A `this`
that compiles through `emitUndefined` yields the `$__undefined` singleton,
which is a **non-null** externref — the trampoline would take its live arm and
install `$__undefined` as the receiver. For a strict callee that is
accidentally right; for a **sloppy** callee it is wrong, because §10.4.3 says
a sloppy callee handed `undefined` binds the global object, and an installed
non-null `$__undefined` defeats the body's `ref.is_null` fallback that
delivers exactly that. So the predicate proves the *value*, not the
nullability.

The trampoline's runtime `ref.is_null` split is unchanged, so nothing about
the null path moves.

## Measured

Instrument: `runTest262File(…, "standalone")` per-file, serial, full
**interpreter** runtime-eval tier (`TEST262_FULL_RUNTIME_EVAL=1`), provider
rebuilt from scratch after the `src/` edit.

Lever = every ES5-label file whose `es5id` clause is one of the `[[Call]]`
this-binding algorithms — **10.4.3** (201), **15.3.4.4** `call` (47),
**15.3.4.3** `apply` (38), **11.2.3** (21) = **307 files**, of which 198 pass
and 109 fail on `origin/main`.

| run | lever (109 baseline failures) | control (198 baseline passes, same clauses) |
| --- | ---: | ---: |
| base (`origin/main`) | **0 / 109** | **198 / 198** |
| + this fix | **4 / 109** | **198 / 198** |

**FIXED 4, BROKE 0** — `10.4.3-1-{70,75}{-s,gs}`, i.e. exactly the predicted
files and nothing else.

Broad control: every ES5-label standalone **pass** outside the lever whose
source mentions `this` — **293 files, the full population rather than a
sample** — plus the 10 non-lever ES5 **failures** that also match
`.call(this)` / `.apply(this)` textually, so the run can catch both a
regression and an unclaimed accidental fix. **303 rows, 303 agreeing with the
published baseline, FIXED 0 / BROKE 0.**

The 10 textual `.call(this)` failures NOT moving is itself a result: the
shape-level grep found 18 ES5 failures matching `.call(this)`/`.apply(this)`,
of which only the 4 in the table are this mechanism. The other 14 fail
upstream of the receiver question (`built-ins/Function/S15.3_A{2,3}_T*` are
`compile_error`), so anyone sizing the fix off the textual match would have
predicted 18 and been wrong by a factor of four.

The two-sided reading is what makes the number mean anything: the lever at
0/109 shows the local instrument reproduces the published standalone jsonl
file-by-file (0 disagreements across all 307), and the control at 198/198
shows the runner can actually see a pass.

## Deliberately out of scope — the verified decomposition of the other 105

Re-derived against current `main`, attributed **per file by mechanism** (each
row below was confirmed with a reduced probe, not inferred from the assertion
text). Three of these buckets contradict the decomposition recorded by earlier
lanes, in each case because bucketing followed the first assertion's error
string:

| n | mechanism | owner |
| ---: | --- | --- |
| ~40 | **Runtime-eval interop, not this-binding.** A value written through an *interpreted* body's global `this` reads back from compiled code as an opaque carrier: `Function('this.k="V";')(); typeof this.k` → `"object"`. The same interpreter writing to the same global object through `globalThis.k` or through a parameter (`Function("o",'o.k="V"')(g)`) round-trips **correctly**, and `Function("return this;").call(o) === o` is **true** — so the receiver *is* delivered; only the write sink is wrong. #4184 family | runtime-eval |
| 18 | IsCallable: calling a non-callable must throw TypeError (`11.2.3-3_{1..8}`, `S11.2.3_A{2,3,4}*`) | #4196 |
| 8 | `Function.prototype.bind` (`10.4.3-1-{77,79,80,98}{-s,gs}`) — W19 re-measured all 8 on its #4196 branch and they still fail there; folded into **#4203** | #4203 |
| 8 | **NOT a receiver bug.** `10.4.3-1-{56,57,60,61}{-s,gs}` read as "the setter's `this` is wrong". The setter fires and its `this` is correct; the tests write `x = this` where `x` is a top-level `var x = 2`, and a number-inferred `var` reassigned to an object silently becomes `NaN`. Reduces with no accessor present: `var a = 2; var o = {}; a = o;` → `a === o` false, `String(a)` `"NaN"`. With `var c = "s"` or a bare `var d;` the same probe answers **true**. Value-rep / inference | unowned |
| 6 | `illegal cast in __module_init()` (`10.4.3-1-{100,101,102}{-s,gs}`) — passing a function to `String.prototype.replace`; unrelated mechanism sitting in the clause | unowned |
| 4 | Strict callee + **explicit null** receiver (`10.4.3-1-{67,72}{-s,gs}`): `f.call(null)` must see `null`, sees `undefined`. Codegen cannot distinguish "no receiver installed" from "receiver installed as null" — both reach the body's `ref.is_null` guard. Needs a boundness signal (companion global, or a non-null null-sentinel); the sloppy answers coincide, so only strict code can observe it. Would also carry #4196's `f.bind(null)()` row | see #4196 |
| 4 | `(function () { … }).call(o)` — an **inline** function-expression callee. `calls.ts` rewrites it to a direct invocation and explicitly drops the thisArg ("standalone functions ignore `this`"). #4192 fixed the *variable-held* form; the literal form still needs the inlining path to bind `this` lexically, which is a different seam | unowned |
| 3 | Primitive thisArg not `ToObject`-boxed in sloppy code (`10.4.3-1-{1,2,4}-s`) — **3, not the ~10 previously recorded** | **unowned** |
| 3 | Accessor on `Object.prototype` reached through a primitive receiver (`10.4.3-1-{103,104,106}`) | **unowned** |
| ~7 | eval-goal / indirect-eval `this` (`10.4.3-1-{17,20,82}`, `A3_T10` pair) and long-tail singletons | runtime-eval |

### Two rows re-attributed OFF #4201 (2026-08-07)

Both primitive rows above were first recorded against #4201 / W20. W20's root
cause turned out to be a blanket arm at the tail of
`compileReceiverMethodCall` — `Object.prototype.valueOf` applied
unconditionally to an `any` receiver — i.e. a `.valueOf()` **call-site**
defect that never touches thisArg binding or member access. So:

- `10.4.3-1-{1,2,4}-s` is a different seam: `OrdinaryCallBindThis` must
  **create** a wrapper, whereas #4201's helper **reads** one.
- `10.4.3-1-{103,104,106}` contain no `.valueOf()` call site at all.

Both are **unowned**. They do share the `FLAG_INTERNAL WRAPPER_PRIMITIVE_KEY`
slot format with #4201, so the two compose: boxing a primitive thisArg into a
real `$Object` wrapper leaves `__dyn_valueOf` able to read it.

Independent corroboration for `{103,104,106}` — **not** derived from #4201, and
worth keeping separable so a later reader does not inherit a dependency that
is not there: `103` is sloppy and wants `(5).x` boxed so `== 5` holds, while
`104`/`106` are `onlyStrict` and want the raw `5` / `typeof "number"`. All
three currently answer an object, i.e. they fail in **opposite directions**.
That is what "the receiver is never derived from the primitive at all" looks
like; a boxing bug would fail one direction only.

### Re-measured at the true tip (2026-08-07) — no change, and that is the finding

W20 (#4201) reported a stale base turning a real `FIXED 12` into `FIXED 0`,
because its lever sat behind #4196's `[[Construct]]` slice. This census's base
was cut at the **same commit** it names, `origin/main@50127992c8`, before that
slice landed as `14cb0f08d1` — and four rows here are literally the
`[[Construct]]` assertion (`Function/prototype/{call,apply}/S15.3.4.{4,3}_A{7,8}_T{5,6}`,
"can't be used as `[[Construct]]` caller"). So the residue was a live candidate
for being overstated.

Re-ran the full 307-file lever on the true tip (`55828029bc`), provider deleted
and rebuilt: **identical file-for-file to the stale-base run — 0 differences
across all 307**, still `FIXED 4 / BROKE 0` against the published baseline.
#4196's construct slice moved none of the six `A{7,8}_T{5,6}` rows; `A8_T5` /
`A7_T5` still want a TypeError and `A8_T6` / `A7_T6` still die on a null
deref. The residue is **105** and the table above stands.

Recording the null result deliberately: "checked, unchanged" and "assumed
unchanged" are different claims, and only one of them survives someone else
re-cutting the base later. Note also that the two lanes' exposure ran in
opposite directions — a stale base made W20's real fix read as zero, whereas
here it could only have **inflated a residue**. A stale base distorts whichever
side you did not re-cut.

The largest inherited row — "~30 files: `.call`/`.apply`/`.bind` dropping the
thisArg when the callee is a function EXPRESSION" — does **not** survive
measurement at that size. After #4192 the variable-held form works
(`fe.call(o)` → verified true); what is left of that idiom inside this clause
set is the 4-file inline-literal row above, and across all of ES5 the shape
`(function(){…}).call/apply` accounts for 12 standalone failures, most of
which fail inside an interpreted body for the runtime-eval reason instead.

## Acceptance criteria

- [x] A strict function declaration called as `f.call(this)` / `f.apply(this)`
      at Script top level receives the global object.
- [x] A sloppy declaration does too.
- [x] An explicit object receiver, a bare call (strict and sloppy), and
      top-level `this` itself are unchanged (#3365 / #4190 not regressed).
- [x] Measured FIXED 4 / BROKE 0 on the 307-file lever, 198/198 control held.
- [x] `tests/issue-4202-toplevel-this-receiver.test.ts` — 6 RED-on-main cases
      plus 5 preconditions green on both branches, every case asserted on
      **both** the JS-host and standalone lanes.
