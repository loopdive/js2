---
id: 4581
title: "BOTH LANES — silent wrong answer: `A.prototype.isPrototypeOf(a)` returns `false` for `a = new A()`, while `Object.getPrototypeOf(a) === A.prototype` is `true`"
status: wont-fix
sprint: current
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: prototypes
goal: es5
related: [2994, 2916, 4556, 4580, 4163]
origin: "2026-08-20, ES5 standalone push follow-up, while investigating the Object.prototype.isPrototypeOf refusal recorded in #4580."
---

# #4581 — `A.prototype.isPrototypeOf(a)` answers `false`

> **RETIRED as a duplicate of #4480 R4 (2026-08-20).** This shape is already
> documented there, with the same instrumented measurement
> (`struct=108 resolve=undefined` vs `struct=17 resolve=F`), and the `ref.test`
> arm for it was written, **measured unreachable, and removed rather than
> shipped as dead code**. The blocker is the #2660 escape gate, not the walk.
>
> Filing this at all was my miss — the mechanism is documented *in the source*,
> in a 15-line comment at the exact call site (`native-is-prototype-of.ts`,
> "(#4480 S2, NOT taken)"), which I should have read before opening an issue.
>
> **One finding here is NOT covered by R4 and has been carried across to #4480:**
> this reproduces on the **js-host lane** too, and R4 is framed as a standalone
> substrate/escape-gate problem. See the note appended to #4480.

---


## Silent wrong answer, in BOTH lanes

```js
function A() {}
var a = new A();
A.prototype.isPrototypeOf(a);   // false  — must be true
```

No throw, no refusal, no compile error. Just the wrong boolean.

Verified on `main`, `--target standalone` **and** `--js-host` — both answer
`false`. Node answers `true`.

## What makes it clearly a method bug rather than a linkage bug

Every neighbouring question about the same two objects is answered **correctly**:

```js
Object.getPrototypeOf(a) === A.prototype   // true   — correct
a instanceof A                             // true   — correct
Object.prototype.isPrototypeOf(a)          // true   — correct
```

So the prototype linkage is right and `getPrototypeOf` can see it; only
`isPrototypeOf` **with a user prototype as receiver** gets it wrong. §20.1.3.4 is
a walk of `O`'s prototype chain looking for `V` — the same chain `instanceof`
already walks correctly here.

## Context-dependence — the reason this is easy to miss

The answer is not stable across surrounding code. A probe that first evaluates

```js
Object.getPrototypeOf(a) === A.prototype
```

then gets `A.prototype.isPrototypeOf(a) === true` in the same module. The bare
form gets `false`. Warming with `a instanceof A` alone does **not** fix it.

That is why a casual check can conclude the method works: whether you see the bug
depends on what else the module does with the prototype first. Any repro for this
must be a **bare** module.

## Reproductions

```bash
# bare — FAILS on both lanes
printf 'function A(){}\nvar a=new A();\nif(A.prototype.isPrototypeOf(a)!==true){throw new Error("got false");}\n' > /tmp/i1.js
node --experimental-wasm-exnref --import tsx .tmp/t262.mts            /tmp/i1.js
node --experimental-wasm-exnref --import tsx .tmp/t262.mts --js-host  /tmp/i1.js
```

## Where to look — CORRECTED 2026-08-20, the first suspect was wrong

The first version of this file named `tryStaticIsPrototypeOf` (#2994) as the
prime suspect, "proving `false` for a user-prototype receiver instead of
declining". **That is wrong, and wrong in a misleading direction** — the fold
declines for user prototypes (it only handles `Object`/`Function` bases), and it
is the one thing that currently produces a CORRECT answer.

Measured instead:

```js
function A() {}
var a = new A();
var op = Object.prototype, ap = A.prototype;

Object.prototype.isPrototypeOf.call(op, a)    // false   <-- !!
Object.prototype.isPrototypeOf.call(ap, a)    // false
Object.prototype.isPrototypeOf.call(ap, {})   // false
```

**The native chain walk answers `false` for everything**, including the
`Object.prototype` receiver that answers `true` when written directly. The direct
form is right only because `tryStaticIsPrototypeOf` **folds it to `true`** before
the walk ever runs (`base === "Object"` + a provably-object argument → `true`).

So the fold is a mask, not the bug: it hides a broken walk on exactly the one
shape it covers, and every shape it declines — every user prototype, and any
`.call`-spelled receiver — falls through to the walk and gets `false`.

That also explains the context-dependence in the section above: what changes
between probes is whether the fold can prove its precondition, not what the walk
computes.

### NARROWED 2026-08-20 — the walk is fine; the RECEIVER SPELLING is the trigger

Further measurement, and this supersedes "the walk answers false for everything":

```js
var proto = {};
var o = Object.create(proto);
proto.isPrototypeOf(o);                        // TRUE   — correct
Object.getPrototypeOf(o) === proto;            // true

function A() {}
var a = new A();
Object.getPrototypeOf(a).isPrototypeOf(a);     // TRUE   — correct
A.prototype.isPrototypeOf(a);                  // FALSE  — wrong
Object.getPrototypeOf(a) === A.prototype;      // true
```

So the chain walk is **correct** whenever the receiver is a genuine `$Object` —
a plain object, or the very same prototype reached via `getPrototypeOf`. It is
wrong **only when the receiver is spelled `<UserFn>.prototype`**.

That is a sharp, self-contradictory pair worth stating plainly:

- `Object.getPrototypeOf(a) === A.prototype` → **true**
- `Object.getPrototypeOf(a).isPrototypeOf(a)` → **true**
- `A.prototype.isPrototypeOf(a)` → **false**

Three readings of the same object, two right and one wrong, so the defect is in
how `<UserFn>.prototype` is lowered **in method-receiver position** — not in the
walk, and not in the prototype linkage.

The earlier `.call`-spelled readings (`isPrototypeOf.call(op, a)` → false) belong
to the separate value-read gap in #4580, not to this: extracting the method as a
value yields the refusal/`false` stub, so those probes were measuring that, not
the walk.

### The likely mechanism

`native-user-instanceof.ts` gets this right and says why:

> `emitFnctorProtoGet` lazily materializes the per-fnctor prototype `$Object` —
> **the same global the #2660 S3a `new F()` reconstruct seeds `$proto` from, so
> object identity holds.**

`instanceof` therefore feeds `__isPrototypeOf` the canonical `$Object`. A plain
`A.prototype` property read in receiver position evidently does **not** — it
yields something that compares `===`-equal but is not the object the instance's
`$proto` actually points at, so the `ref.eq` at each level never matches.

**Shortest route to a fix:** route `<UserFn>.prototype.<method>(…)` in receiver
position through `emitFnctorProtoGet`, exactly as the `instanceof` lowering does.

### The mechanism to check first

`__isPrototypeOf` (`src/codegen/object-runtime-prototype.ts` ~L313) documents its
own bail-out:

> `1 iff obj appears in candidate's prototype chain. Walk candidate.$proto and
> ref.eq each level against obj. **Non-`$Object` obj/candidate → 0.**`

It `ref.test`s both operands against `$Object` and returns `0` when either fails.
If a user function's `.prototype` — or a compiled instance — is carried as
something other than a `$Object` struct, the walk returns `0` unconditionally,
which matches every reading above.

Note `src/codegen/native-user-instanceof.ts` calls the **same** `__isPrototypeOf`
for `instanceof`, and `a instanceof A` is **correct**. So either that path
prepares its operands differently before the call, or it does not reach this
helper on this shape — resolving that difference is the shortest route to the
fix.

## Acceptance criteria

- The bare repro passes on **both** lanes.
- Regression test covering: user prototype, builtin prototype,
  `Object.prototype`, a non-ancestor prototype (must stay `false`), a primitive
  argument (must be `false`, not a throw), and the **bare-module** form — the
  context-dependence above means a warmed test can pass while the bug is live.
- 551-row standalone ES5 guard stays clean; GC-lane unit suites measured relative
  to the merge base, since the fix is lane-shared.

## Related

Found while investigating the `Object.prototype.isPrototypeOf is not yet
implemented in --target standalone` refusal recorded in #4580 — that refusal is
the *value-read* path and is a separate, narrower gap. This one is the far more
serious of the two: a refusal is loud, a wrong boolean is not.
