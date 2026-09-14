---
id: 6467
title: "#2747 multi-level `__proto__` for-in drops the grandparent's keys, and #2836's two vec round-trip cases are red — both on main, neither a boundary artifact"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
requested_by: ttraenkler/sendev-6438
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: correctness
---

## Problem

Found while fixing
[#6438](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6438-wrapexports-raw-exports-marshals-struct-to-empty).

Both files below read their compiled exports through the historical
`wrapExports(instance.exports)` overload, so until #6438 every failure in them
was easy to attribute to the `{}`-marshalling defect. With the authority wired
up (`__setInstance(instance)`), most of those failures disappear — and these
three do not. They are separate defects with nothing to do with the boundary.

Measured 2026-09-13 on `upstream/main` 4854e7d8c6, with the #6438 fix and the
one-line re-wiring applied to each file:

**`tests/issue-2747.test.ts` — 5 of 6 cases go green, this one stays red:**

```
#2747 (d) — `o.__proto__ = p` records the prototype link
  > walks a multi-level `__proto__` chain, own-shadows-proto
  expected 'a,shared,p,'  to be  'a,shared,p,g,'
```

The for-in walk reaches the parent but not the grandparent, so a three-level
`__proto__` chain enumerates one level short. (The sibling case
`walks a multi-level Reflect.setPrototypeOf chain` DOES go green, which narrows
this to the `__proto__`-assignment link recording, not the chain walk in
general.)

**`tests/issue-2836-typed-vec-dynamic-dispatch-arg.test.ts` — the re-wiring
changes nothing; both stay red:**

```
> scalar-element arrays still round-trip through dynamic dispatch (no regression)
> genuine empty vec still converts to an empty array (is-vec stays true)
```

## Why it is filed rather than fixed

The `quality` lane's "Changed root test files must pass (#3008)" step makes any
test file a PR touches a gate. #6438 therefore had to REVERT its one-line
re-wiring of these two files: re-wiring them is a strict improvement (it fixes 5
of 2747's 6 cases) but leaves the file red, which fails the gate. The re-wiring
belongs in the PR that fixes the underlying defect.

## Acceptance criteria

1. The three named cases pass.
2. Both files are re-wired to establish the data-struct authority
   (`__setInstance(instance)` beside the existing `__setExports`, or the
   Instance overload) — see #6438; without it they cannot decode a returned
   struct at all.
3. Whatever the #2747 root cause is, the `Reflect.setPrototypeOf` sibling
   (already green) keeps passing — it is the control that says the chain walk
   itself is fine.
