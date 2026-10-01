---
id: 6780
title: "codegen: `await` of a statically-resolved operand (`await null`, `await Promise.resolve()`) does not suspend — the async body runs synchronously past the await"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: async-await
goal: async-model
related: [1373, 2895, 1313, 3587]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C5"
---

# #6780 — an `await` whose operand is "statically resolved" is compiled away

## Problem

```ts
let shared = 0;
const af = async (): Promise<number> => { shared = 1; await null; shared = 2; return shared; };
const p = af();
log("after-call shared=" + shared);   // wasm: 2   JS: 1
await p;
```

Every `await` must yield to the microtask queue, whatever its operand. The
compiled body runs straight through `await null`, so code after the call
observes state that in JS is only reachable after the continuation ran.
Sibling ordering diverges the same way (`af1, af3, af2` vs JS `af1, af2, af3`
in the review's `g5` probe); `await Promise.resolve()` behaves identically.

Reproduced 2026-09-30 with the review harness (`compile()` + `buildImports`,
JS-host lane, default options) and compared against Node.

## Root cause

`src/codegen/async-activation.ts:225-227` declines the async lane when every
`await` in the body passes `awaitIsStaticallyResolved`
(`src/ir/async-static.ts`: literals, `null`, `undefined`, unary). The body
is then compiled as a plain function that returns a resolved promise.
`:228-239` documents that declined shapes "run the sync fallback acceptably" —
they do not: the sync fallback changes observable interleaving.

## Correction

- Remove the "statically resolved ⇒ no suspension" shortcut. A statically
  resolved operand may skip the *thenable check*, never the continuation
  deferral: lower `await <static>` to "enqueue continuation as a microtask;
  return to caller".
- Where the async lane cannot lower a body, **refuse** (compile error, as
  #3587 does for other async shapes) instead of emitting the sync fallback.
- Keep the optimisation that matters: an async function with **zero** awaits
  may still run synchronously and wrap its result, because that is what JS
  does.

## Acceptance

- The probe above logs `after-call shared=1` then `resolved v=2 shared=2`.
- Ordering probe: three async functions each with one `await null` interleave
  exactly as Node (`af1, af2, af3` first halves, then second halves).
- `tests/equivalence/` gets the two cases plus `await undefined`,
  `await 1`, `await Promise.resolve(1)`, `await (async () => 1)()`.
- No test262 `language/expressions/await` or `statements/async-function`
  regression; report the delta in the PR.
