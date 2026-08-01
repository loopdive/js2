---
id: 3971
title: "Standalone: a class-expression binding-element default in a generator param pattern compiles host-free and then dereferences a null pointer"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, destructuring, default-parameters, classes
es_edition: multi
goal: standalone-mode
umbrella: 3178
related: [3952, 3386, 3178, 3948, 3164]
origin: "2026-08-01: the bounded follow-up #3952 left on the table. Refiled under a fresh id — see Provenance."
---

# Class-expression element default → null pointer dereference

## Problem

A generator whose parameter pattern carries a **class-expression** element
default keeps the host-import bail, because admitting it produces a module that
instantiates **host-free** and then **traps at runtime**.

```ts
const o = {
  *m({ K = class { v(): number { return 41; } } }: { K?: new () => { v(): number } } = {}) {
    yield 0;
    yield new K().v() + 1;
  },
};
```

## Measured, not inherited

Re-measured against `main` at `c2f5788ee7a710` on 2026-08-01 by removing the
class-expression disjunct from the bail predicate and asserting the **value**:

| lane                      | bail in place (main) | bail removed                             |
| ------------------------- | -------------------- | ---------------------------------------- |
| object-literal method     | 6 imports, host path | **0 imports**, `dereferencing a null pointer` |
| class method              | 6 imports, host path | **0 imports**, `dereferencing a null pointer` |

Both lanes. With and without a suspension in the shape, per #3952 — so this is
not a spill/resume artifact.

**This is exactly why the acceptance bar here is a value assertion, not
import-freedom.** With the bail removed the module is host-free — an
`importCount === 0` assertion *passes* — and the construct still cannot produce
a value. An import-set assertion alone would sign off on a broken module.

This reproduces #3952's recorded matrix independently:

- #3952 line 92 — `objlit / class · class-expression default | host-free, "dereferencing a null pointer"`
- #3952 line 120 — the 32 class-lane generator rows, and why they stay bailed

## Where

`src/codegen/generators-native.ts`, the binding-element walk in the native
generator **plan builder** (~line 1425). The predicate returns `null` — i.e.
bails the whole native plan — when an element default is a generator function
expression, a class expression, or the enclosing decl is a function expression:

```js
const closureDefault =
  el.initializer !== undefined &&
  (ts.isFunctionExpression(el.initializer) ||
    ts.isArrowFunction(el.initializer) ||
    ts.isClassExpression(el.initializer));
if (
  closureDefault &&
  ((ts.isFunctionExpression(el.initializer!) && el.initializer!.asteriskToken !== undefined) ||
    ts.isClassExpression(el.initializer!) ||
    ts.isFunctionExpression(decl))
) {
  return null;
}
```

Because the bail lives in the plan builder rather than at an emit site, it is
family-independent.

## Denominator — NOT yet established

The lost predecessor reportedly carried a "40 rows in the family, 24 host-pass"
figure. **That number is deliberately not repeated here.** It reached me only
through a report whose backing file was never on `main` (see Provenance), and
report-vs-record has already disagreed once in this chain. Whoever picks this up
must **derive the denominator from a cohort sweep and quote the host-pass count,
not the family size** — the lowest known-achievable ratio is the honest bar.

## The pinning test must be deleted in the same commit as the fix

`tests/issue-3952.test.ts` contains:

```
it("CLASS-expression default keeps the host path (null deref in BOTH lanes)", …)
  expect(await importCount(src)).toBeGreaterThan(0);
```

That test asserts the **bail**. It cannot fail once the bail becomes
unnecessary, so it actively defends the defect. Delete it in the same commit
and replace it with a **value** assertion (`runStandalone(src) === 42`), not an
import-count assertion.

## Do NOT fold in the 32 class-lane generator rows

#3952 left the generator-function-expression arm bailed **uniformly** even
though the class lane passes it today, because the objlit lane traps on the same
shape. Admitting a shape on **lane identity alone** is how a loud host-import
leak becomes a silent wrong value. Re-measure those rows once this defect is
understood — they may share a root cause — but do not admit them on lane
identity, and do not start them as separate work before this one is understood.

## Acceptance

- The construct produces the **correct value** (`42`) in both the
  object-literal and class lanes, across a suspension — not merely
  `importCount === 0`.
- The `tests/issue-3952.test.ts` pinning test is deleted in the same commit,
  replaced by a value assertion.
- The denominator is re-derived and the **host-pass** count quoted.

## Provenance — why this has a fresh id

The predecessor file was **lost by the merge queue**, not by an agent. Its PR
was already enqueued when two further commits (the two follow-up issue files)
were pushed to it. The queue merged the SHA it had enqueued; the later commits
were never part of that merge. The PR object still reports MERGED, with a files
list computed from its **current head** rather than from what actually merged —
so the files appear `added` on a merged PR while having **0 commits on main**.
The substantive fix landed; only the follow-up issue files were dropped.

Its original id is now legitimately held on `main` by another lane's issue,
which landed despite our reservation being ~94 seconds earlier — the
reservation ref is **advisory, not a lock**. Hence a fresh id via
`claim-issue.mjs --allocate`.

Lesson worth keeping: **never push to a PR that is already in the merge queue.**
