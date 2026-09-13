---
id: 6446
title: "`tests/issue-4618-async-nested-fn-decl.test.ts` is red on current main — a nested function declaration inside an async export fails to compile again"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: correctness
---

## Problem

`tests/issue-4618-async-nested-fn-decl.test.ts` fails on unmodified
`upstream/main` at `e8a778638f` (2026-09-13). The compile itself is refused:

```
FAIL tests/issue-4618-async-nested-fn-decl.test.ts >
     #4618 nested function declaration in an async export >
     compiles and the nested function captures the enclosing const
AssertionError: expected false to be true
  ❯ run tests/issue-4618-async-nested-fn-decl.test.ts:21
      expect(result.success).toBe(true);
```

The source is the minimal shape the original
[#4618](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4618-async-nested-fn-decl)
fix landed for:

```ts
export async function t(): Promise<string> {
  const marker = "captured-ok";
  function inner(): string {
    return marker;
  }
  return inner();
}
```

So this is a **regression of a closed issue**, not a never-worked shape. The
test still exists and still guards it; it is simply failing.

## Anti-vacuity control

Measured twice at one head while validating
[#6412](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6412-hono-jwt-async-resume-extern-convert-any):
once with that PR's three touched `src/` files reverted to their `upstream/main`
content, once with the fix. **Identical failure on both arms** — so it is main's,
not #6412's. Seven sibling async test files run in the same invocation
(`async-await`, `async-frame-host-throw-rejects`, `issue-5371`, `issue-3587`,
`issue-2906-async-multiawait`, `issue-2895-async-frame`) and all pass on both
arms; the only other red file in that set is the collection-cycle already filed
as [#6437](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6437-async-census-collection-kind-module-init-cycle).

## Reproduce

```bash
node node_modules/vitest/vitest.mjs run tests/issue-4618-async-nested-fn-decl.test.ts
```

## Next step

Bisect between #4618's landing and `e8a778638f` to name the commit, then decide
whether the original fix (deferred planning for placeholder slots, so the
Phase-3 patch lands in place) was undone or merely bypassed by a newer
registration path. Worth checking against the async declaration-time signature
work in #6412, which touches the same registration pre-pass — though the control
above rules that PR out as the *cause*, an adjacent change on main may be the
one to look at.

## Acceptance criteria

1. `tests/issue-4618-async-nested-fn-decl.test.ts` passes on main.
2. The commit that broke it is named in this issue (bisect result), so the
   guard-that-did-not-guard is explained rather than just re-fixed.
3. No movement in the 17 dogfood upstream suites.
