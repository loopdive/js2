---
id: 6812
title: "host lane: `for await` over a sync iterable whose element is a rejected promise completes normally (result 0) instead of throwing at the loop head"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime
language_feature: async-iteration
goal: core-semantics
related: [6791, 6780]
requested_by: ttraenkler/claude-review
origin: "reported by the #6791 implementation (2026-10-02) while adding `__forawait_mark_handled` for sync-iterable drives; not re-measured by the filer"
---
# #6812 — a rejected element of a sync iterable must reject the `for await` loop

## Problem

```ts
export async function run(): Promise<string> {
  const items = [Promise.resolve(1), Promise.reject(new Error("boom")), Promise.resolve(3)];
  let sum = 0;
  try {
    for await (const x of items) sum += x;
  } catch (e) {
    return "caught:" + (e as Error).message + ":" + sum;
  }
  return "no-throw:" + sum;
}
```

JS: `"caught:boom:1"`. The host lane (per the #6791 report) completes the loop
and returns a numeric 0 / `"no-throw:…"`: the sync-iterable drive added in
#6791 marks each element's rejection as handled (so the unhandled-rejection
tracker stays quiet) but never awaits the element, so the rejection is
swallowed instead of becoming the loop's abrupt completion. §14.7.5.7 with
`iteratorKind` async over a sync iterator goes through
CreateAsyncFromSyncIterator, which **awaits** each `value` and rethrows.

The same shape over a struct-typed iterable (a class with `[Symbol.iterator]`)
was reported with the same outcome.

## Correction

In the `for await` lowering's sync-iterable arm (the drive that #6791 touched,
`src/codegen/` async/for-await lowering plus its host helper in
`src/runtime.ts`): after `next()`, `Await(value)` before binding the loop
variable; a rejection becomes the loop body's throw (goes through the existing
`try`/`catch` and `finally` plumbing of the loop). Keep the
`__forawait_mark_handled` call — it is still needed so the rejection is not
reported twice.

## Acceptance

- The probe returns `"caught:boom:1"` on the JS-host lane and on
  `target: "standalone"`.
- Rows added to `tests/issue-6791-promise-reject-unhandled.test.ts` (array
  element and struct-iterable element).
