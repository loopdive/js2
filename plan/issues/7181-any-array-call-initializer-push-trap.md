---
id: 7181
title: "any[] binding initialised from reverse()/slice() traps after a push of a different element kind"
status: done
sprint: Backlog
created: 2026-10-27
updated: 2026-10-27
completed: 2026-10-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
related: [7154]
---

# #7181 — `any[]` binding from `reverse()` / `slice()` traps after a push

Found in the review of PR #6937 (#7154). It traps on main and on that PR's head,
on gc native-first, standalone and wasi:

```ts
const a: any[] = [1];
const b = a.reverse();   // or a.slice()
b.push("x");
return a.join() + "|" + b.join();   // node: "1,x|1,x" (reverse) / "1|1,x" (slice)
// all lanes: RuntimeError: dereferencing a null pointer
```

`b` has a call initializer, so `inferArrayVecType`
(`src/codegen/statements/array-vec-inference.ts`) treats it as a fresh array
and pins its vec element kind from the `push` arguments alone (here a string
vec). The call result's elements are not known: the number `1` converts to a
null string element, and `join` dereferences it. `reverse()` also returns its
receiver, so a pinned layout that differs from `a`'s copies the array and
breaks the alias as well. `a.slice(); b.push(2)` (same kind) is correct.

## Likely fix

For a binding whose declared element type is `any` / `unknown`, treat a call
or `new` initializer like any other non-fresh initializer (the #7154
vec-sharing rule): keep the dynamic carrier. State the byte delta; typed
`T[]` bindings must stay unchanged.

## Acceptance

- The two programs above match node on gc native-first, standalone and wasi.
- An equivalence test under `tests/equivalence/` covers `reverse()`, `slice()`,
  `concat()` and a user function returning an array, each followed by a push
  of a different element kind.

## Resolution (2026-10-27)

Fixed in the #7154 PR (review round 6). A call or `new` initializer is no
longer treated as a fresh array: it is a member of the binding's share group
classified by its static result type. `a.reverse()` / `a.slice()` /
`a.concat()` / a user function on an `any[]` return `any[]`, so the binding
takes the dynamic carrier and the different-kind push no longer traps; a
call returning a typed `T[]` keeps the typed layout. Typed `T[]` bindings are
unchanged (bytes identical). Tests:
`tests/equivalence/issue-7154-any-array-push-migration.test.ts` (rows
"#7181 reverse()", "#7181 slice()", "#7181 concat()", "#7181 user function
returning any[]"), gc native-first, standalone and wasi vs node.
