---
id: 1312
title: "Async recursive function (next() compose pattern) — Unhandled rejection"
status: done
completed: 2026-05-27
created: 2026-05-07
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, async, closures
language_feature: async, closures, recursion
goal: npm-library-support
sprint: 50
related: [1309, 1306]
---
# #1312 — Async recursive closure pattern fails with Unhandled rejection

## Background

Surfaced during #1309 Slice A investigation. The Hono compose pipeline
uses an inner `async function next()` that recursively invokes
itself through middleware that takes `next` as a parameter. The
pattern fails with an "Unhandled rejection" runtime error. Sequential
non-recursive async calls work; the recursion is the trigger.

## Reproducer

```ts
type Next = () => Promise<string>;
type Mw = (c: Context, next: Next) => Promise<string>;

class Context {
  path: string;
  constructor(path: string) { this.path = path; }
}

function compose(mws: Mw[]): (c: Context) => Promise<string> {
  return async (c: Context) => {
    let i = 0;
    async function next(): Promise<string> {
      const idx = i;
      i = i + 1;
      if (idx >= mws.length) return "end";
      const mw = mws[idx];
      return await mw(c, next);   // mw closes over next; eventually calls next() again
    }
    return await next();
  };
}

export async function test(): Promise<string> {
  const mws: Mw[] = [
    async (c: Context, n: Next) => "[A]" + await n(),
    async (c: Context, n: Next) => "[B]" + await n(),
  ];
  const handler = compose(mws);
  return await handler(new Context("/x"));
}
// expected: "[A][B]end"
// actual: Unhandled rejection
```

Verified working (no recursion):

```ts
type Mw = (s: string) => Promise<string>;
const mws: Mw[] = [
  async (s) => "[A]" + s,
  async (s) => "[B]" + s,
];
export async function test(): Promise<string> {
  const a = await mws[0]("end");
  const b = await mws[1](a);
  return b;
}
// works → "[B][A]end"
```

## Hypothesis

`next` is captured as a closure variable inside the outer arrow.
Inside the inner `async function next()`, the `i` variable is
captured by ref-cell for mutation. When `mw(c, next)` is called, `mw`
itself captures `next` and re-invokes it.

Possible causes:
- The `next` funcref captured by `mw` may be stale / null at
  invocation time — the closure struct for `next` may not be fully
  initialized when stored as a capture.
- Async + recursion may interact badly with the ref-cell capture
  for `i`. The mutation `i = i + 1` runs before the recursive call
  returns; if the ref-cell isn't writable, subsequent calls see
  stale `i`.
- The Promise wrap on `next()` return might be double-applied or the
  recursion may hit the wasm call stack limit if `next()` is
  inadvertently spinning.

## Investigation steps

1. Add minimal recursive async without middleware indirection:
   ```ts
   async function f(n: number): Promise<number> {
     if (n <= 0) return 0;
     return n + await f(n - 1);
   }
   ```
   If this fails, the issue is async recursion itself.
2. Add recursion-via-parameter: pass a function as parameter and
   call it recursively. If this works but compose doesn't, the issue
   is in capturing `next` by closure-closure-over.
3. Inspect the closure struct for `next` — verify `next.func` is
   non-null when `mw(c, next)` is invoked.
4. Bisect on `let i = 0` mutation — replace with `const i =
   computeOnce()` to remove the ref-cell.

## Acceptance

- The compose reproducer above returns `"[A][B]end"`.
- `tests/issue-1312.test.ts` covering: simple async recursion, async
  recursion via parameter, and the full Hono compose shape.
- Empty + short-circuit cases continue to pass (already verified
  working in `tests/stress/hono-tier6.test.ts`).

## Why this is separate from #1309 Slice A

This bug is in the closure-capture / async-recursion interaction.
The architect's `isAsyncCallExpression` fix doesn't touch closure
struct creation or ref-cell handling. Separate root cause.

## Resolution (2026-05-27, investigate task #123)

**Already fixed** by commit `f4600d904` ("fix(#1312): pre-register nested fn
so self-reference resolves to its own closure"), on `origin/main`.

Root cause was NOT a missing async-model rewrite — it was nested function
declarations being registered in `funcMap` *after* their body finished
compiling. A self-reference inside the nested fn's own body (e.g. `next`
inside `next()`, or `next` passed to middleware that re-invokes it) missed
the `funcMap` lookup and fell through to the `ref.null.extern` fallback, so
the compiled wasm did `call(ref.null extern)` and null-derefed. The reported
"Unhandled rejection" was the async wrapper surfacing that null-deref. The
fix pre-registers the `funcMap` + `nestedFuncCaptures` entries before
compiling the body, and sources self-reference captures from the lifted fn's
own leading params (`src/codegen/statements/nested-declarations.ts` +
`src/codegen/closures.ts`).

Confirmed on current main (no source change needed in this task):

- All four staged repros from the investigation steps PASS — simple async
  recursion (`f(3) → 6`), async recursion via parameter (`→ 6`), inner async
  self-recursion with mutable ref-cell capture (`→ "[0][1]end"`), and the
  **headline compose reproducer** returns `"[A][B]end"` (verified in both
  default and `fastMode`).
- `tests/issue-1312.test.ts` (already on main, 5 tests) covers every
  acceptance-criteria case and is **green** (5/5).

All acceptance criteria are satisfied. No further code change required.
