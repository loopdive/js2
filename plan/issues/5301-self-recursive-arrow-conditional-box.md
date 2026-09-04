---
id: 5301
title: "A self-recursive arrow boxes its own recursion inside a conditional arm, so the other arm reads null"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`arrow-phases.ts` already documents this hazard, at the eager-box site:

> A construction site in a conditional arm cannot own the canonical box for a
> captured parameter: compilation re-aims all later reads to that box even when
> the arm is skipped at runtime.

Its guard, `canBoxBindingInDominatingParent`, admits two safe sources — a
declared parameter of the owner function, and a local initialised before the
region. **The self-recursive arrow binding is neither.** Inside the lifted body
that name resolves to `__self`, lifted param 0; its NAME belongs to the outer
binding and appears in no `owner.parameters` entry, so the parameter test cannot
see it, and the local test rejects it for being a param.

So the box is created inside whichever conditional arm first constructs a nested
closure over the recursion, and every later recursive reference is re-aimed at
that box. On any path that skipped the arm the box is null:

```js
const visit = (s) => {
  if (Array.isArray(s)) { const r = []; s.forEach((v, i) => { r[i] = visit(v); }); return r; }
  const t = {}; for (const k in s) t[k] = visit(s[k]); return t;   // ← reads the null box
};
visit({ a: [{ b: 7 }] });   // RuntimeError: dereferencing a null pointer
```

The emitted body makes it plain — `local.get 9` is `$__boxed_visit`, assigned
only inside the `Array.isArray` arm:

```wat
(if  ;; Array.isArray(s)
  (then
  …
  local.get 0        ;; __self
  struct.new 16      ;; $__boxed_visit  ← created HERE, inside the arm
  local.tee 9
  struct.new 19      ;; the forEach callback's env
  …))
…
local.get 9          ;; the object arm's recursive call
struct.get 16 0      ;; ← traps: local 9 is null on this path
```

**Source order alone decided whether the function trapped.** Putting the object
arm first made the identical program work, because the direct recursive call was
then compiled before the box existed and resolved through `__self`.

Three ingredients are all required — a recursive call inside a nested closure, a
recursive call outside it, and a first call that takes the arm without the
closure. Any two of the three run correctly, which is why this survived.

## Fix

Admit the self-recursive binding as a third safe source in
`canBoxBindingInDominatingParent`. `__self` is lifted param 0: always live at
entry and never written, so it is eligible for the eager dominating box the
file's own rule already prescribes. The predicate matching the binding is the
same one `collectArrowCaptures` uses to route the recursive call (#2118).

**`localIdx === 0` alone is not proof, and assuming it was cost a regression.**
In a body that was NOT lifted, slot 0 is the arrow's own first PARAMETER, so a
first cut boxed the parameter instead of the recursion and jest's
`packages/jest-jasmine2/src/__tests__/concurrent.test.ts` went 3/3 → 0/3. The
guard therefore requires the synthetic self param by name
(`fctx.params[0]?.name === "__self"`). The regression was invisible in the
first sweep because that suite crashed on an unrelated harness
fixture-resolution error and was never scored — a missing number read as
"unchanged" until it was re-run alone.

## Measured

- `tests/self-recursive-arrow-conditional-capture.test.ts`: **4 of 6 cases fail
  on the parent commit; all 6 pass with the fix.** The two that already passed
  are the guards — the object-arm-first ordering, and a recursion with no nested
  closure at all.
- **axios 190/231 → 191/231**, and the `dereferencing a null pointer` bucket
  goes from **12 failures to 1**. The eleven `AxiosError.test.js` redaction
  tests stop trapping; they still fail, now on ordinary assertion mismatches, so
  a second defect sits behind this one.
- axios' `redactConfig` and `toJSONObject` are exactly this shape: an array arm
  using `forEach` plus an object arm walking entries.
- **A/B over 17 upstream npm suites at one HEAD**: axios is the only package
  that moves (108/231 → 109/231). webpack, three, clsx, cookie, lodash, redux,
  stylelint, tailwindcss, jsdom, styled-components, uuid, marked, moment,
  prettier, jest and hono are byte-identical per test file — jest and prettier
  each re-run alone after being killed/crashed under load rather than being
  reported as unchanged.
