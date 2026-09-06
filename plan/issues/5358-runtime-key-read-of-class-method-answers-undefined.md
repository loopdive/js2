---
id: 5358
title: "A runtime-key read of a class instance's prototype method answers `undefined` — bare `__extern_get`, nothing to delegate to (marked Hooks cluster B, 10 tests)"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
---

## Problem

Split out of #5345 after its agent **refuted the filed diagnosis** with
measurement. The filed version blamed default parameters; it is not that.

`marked`'s `use()` installs hooks with

```js
for (const o in n.hooks) { const a = r[o]; r[o] = c => a.call(r, c); }
```

where `r` is a `Hooks` class instance. With a **runtime key**, `r[o]` answers
`undefined` for **every** prototype method — `preprocess(markdown)` (no default
parameter) exactly as much as `provideLexer(e = this.block)`. The read is a
bare `__extern_get` (there is no `propName`, so no closed dispatcher and no
`classMethodCandidatesForProp` enumeration is involved at all), and the host
side has nothing to fall back to: with a genuine runtime key
`Hooks.prototype[k]` and `Object.getPrototypeOf(h)[k]` are **also**
`undefined`. A class's methods live on the prototype in JS; here they live
nowhere the host can enumerate.

Control that isolates it: the same runtime-key read against a **plain object
literal** returns the function, because a literal's methods are struct
fields.

This is #5195 Step 4.3 (runtime-key member read on a class instance) plus a
JS-host-lane twin of `__class_proto_lookup`, which exists for the standalone
lane only.

## Evidence

- marked `test/unit/Hooks.test.js` is 9/30 on clean main. PR #5653 (#5345
  cluster A) removed the 11 `async option` errors and marked stayed **9/30**:
  the same 10 tests fail one step later on `Cannot read properties of
  undefined (reading 'trim')` — the wrapper `c => a.call(r, c)` closed over
  `a === undefined`. **Clusters A and B are serial**; nothing on marked moves
  until this lands.
- Two pins for this shape are already in
  `tests/issue-5345-absent-property-i32-narrowing.test.ts`, documented as
  failing on both sides.

## Acceptance criteria

1. `h[k]` for a runtime `k` naming a prototype method of a compiled class
   returns a callable that, when called with `.call(h, …)` or directly with
   `h` as receiver, runs the method with `this === h`. Both spellings —
   `h[k]` and `Object.getPrototypeOf(h)[k]` — and `k in h` must agree with
   JS.
2. `Hooks.test.js` ≥ 19/30 (the 10 cluster-B tests pass; the remaining
   `illegal cast` bucket is a separate residual, see #5345).
3. Regression test under `tests/`, **untyped `.js` two-file fixtures**:
   runtime-key read of a method with and without a default parameter; a
   plain-object-literal control (already works — anti-vacuity); an inherited
   method through a subclass instance; and the `for…in` + `.call` marked
   shape returning the transformed value. Fails on the parent, passes with
   the fix — exact counts both ways. Flip the two cluster-B pins in the
   #5345 test file in the same PR.
4. **A/B at one HEAD** over all 17 suites, per test file. Anchors on clean
   main: webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740/63740 ·
   lodash 53/62 · redux 63–64/82 · axios 200/231 · stylelint 108/108 ·
   tailwindcss 13/13 · jsdom 6/6 · styled-components 9/9 · uuid 75/75 ·
   marked 9/30 · moment 10/10 · prettier 101/151 · jest 335/356 · hono
   244/324. A runtime-key read of class methods is common in library code —
   watch every package, not just marked.
5. Gates green including `pnpm run check:dogfood-validation`; standalone
   lane byte-identical unless the change is deliberately shared.

## Implementation Plan

1. **Read the two existing mechanisms first**, because this is a bridge
   between them, not a new one:
   - `src/codegen/member-get-dispatch.ts` — `classMethodCandidatesForProp`
     builds per-name `__get_member_<name>` dispatchers with method arms for
     an `any`-typed receiver. It is keyed on a **static** name; a runtime key
     never reaches it.
   - `__class_proto_lookup` (grep `src/codegen` and `src/runtime.ts`) — the
     standalone lane's runtime-key resolver over a class's prototype chain.
     Find why it has no JS-host twin and what it would need from the host
     (`_wasmStructProps` sidecar? the `__member_kind_<key>` /
     `__member_arity_<key>` sidecars from closed-method-dispatch?).
2. **Choose the surface.** Two candidates; measure before committing:
   - (a) **Make the prototype carrier real for the host.** The compiler
     already mints a per-class prototype object for `C.prototype` reads
     (`src/codegen/class-proto-object.ts`, and #5347 is adding a
     struct→prototype reverse map for `getPrototypeOf`). If that carrier
     exposes each method as a callable property (the `__class_call_<m>_<n>`
     bridges from `emitMethodDispatch` already exist per method), then a
     runtime-key read on the instance can fall through to it exactly the way
     JS does — `__extern_get(instance, k)` misses the own sidecar, walks to
     the prototype carrier, hits. This makes `Object.getPrototypeOf(h)[k]`
     correct for free and composes with #5347. **Preferred if #5347's map
     lands first — coordinate; do not build a second reverse map.**
   - (b) A runtime-key arm in `__extern_get` on the host side that asks the
     module a `__runtime_member_get(struct, key)` closed dispatcher generated
     per class (the #2963 pattern with a string-compare ladder). Works
     without a prototype carrier but duplicates dispatch tables per class.
3. Reduce with a negative control (standalone `.mjs`,
   `compileAndRunUpstreamModule`, harness sanity-checked); dump WAT for
   `h[k]` and confirm it is the bare `__extern_get`.
4. Implement (a) unless measurement says otherwise. Bound `this`: the
   returned callable must behave like an unbound prototype method (marked
   does `a.call(r, c)`), not a pre-bound closure.
5. Regression tests; A/B; one PR. Record the standalone-lane status
   explicitly.

## Dispatch

Model: **fable** (`feasibility: hard`, `reasoning_effort: max`). This sits
where three mechanisms meet (closed method dispatch, the prototype carrier,
`__extern_get`), the filed diagnosis has already been wrong once, and the
right answer depends on #5347's design — the same reasoning tier that
resolved #5334's ambiguity.
