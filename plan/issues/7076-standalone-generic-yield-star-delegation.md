---
id: 7076
title: "standalone: `yield*` over a generic iterable (`[1,2,3].values()`, custom `[Symbol.iterator]`) throws 'Invalid iterator protocol' — #2173 slice-2b regressed (9 tests)"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: standalone-gap
related: [7014, 2173, 6984, 2038]
requested_by: ttraenkler/wave15-grep-other-sentinels
---

# #7076 — standalone generic `yield*` delegation throws

`tests/issue-2173-yieldstar-generic-iterable.test.ts` is 9/9 red on
upstream/main e8699e30ee (found by the #7014 follow-up, wave 15). Reduced:

```ts
function* g(): Generator<number> { yield* [1,2,3].values(); yield 4; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }
```

`--target standalone` → uncaught `TypeError: Invalid iterator protocol` (node:
`10`). The message comes from `src/codegen/generators-delegation-runtime.ts`
(`fillProtocol` → `requireCallable` / `requireObject`): generic delegation now
runs the full §27.5.3.7 protocol (`__gen_delegate_start` reads `@@iterator`,
calls it through `__apply_closure`, reads `next`) instead of #2173's
`__iterator` / `__iterator_next` native runtime. For a native array iterator
(`.values()`) — and for a closed-struct `{ [Symbol.iterator]() {…} }` — one of
the `__gen_delegate_get_*` readers answers a non-callable / non-object, so the
protocol check throws. Candidate commits: 79af73aabf / 42a48116b2 (2026-09-12,
factory protocol + host iterator-result keys), 145df02b4c (#6984).

## Plan

1. Bisect on the reduced source above (standalone, `deferTopLevelInit` makes the
   throw renderable).
2. Give `buildNativeGeneratorProtocolGet` (or the `iterator`/`next` readers)
   arms for the native vec/array-iterator carrier and for closed-struct
   iterables, or route those subjects back to the `__iterator` runtime.
3. Acceptance: the 9 tests green, host-free (they assert zero imports).
