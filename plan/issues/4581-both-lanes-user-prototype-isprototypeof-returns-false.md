---
id: 4581
title: "BOTH LANES — silent wrong answer: `A.prototype.isPrototypeOf(a)` returns `false` for `a = new A()`, while `Object.getPrototypeOf(a) === A.prototype` is `true`"
status: ready
sprint: current
created: 2026-08-20
updated: 2026-08-20
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

## Where to look

- `tryStaticIsPrototypeOf` (#2994) — the static fold. If it is proving `false`
  for a user-prototype receiver instead of declining, that alone explains both
  lanes answering identically and the context-dependence (a preceding
  `getPrototypeOf` may change what the fold can prove).
- `src/codegen/native-is-prototype-of.ts` (#2916) — the standalone typed-receiver
  path. Its own docs say the fold runs **first**, then the native chain walk, so
  a wrong fold short-circuits the correct walk.
- `src/codegen/native-user-instanceof.ts` already performs the correct walk via
  `__isPrototypeOf(F.prototype, value)` for `instanceof` — which is exactly the
  answer this shape needs, and evidence the underlying helper is sound.

Note #4556 deliberately routed `<Builtin>.prototype.isPrototypeOf(V)` into the
`instanceof` lowering while leaving `Object` on the chain walk as "strictly more
faithful". This issue is the **user**-constructor case, which neither covers.

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
