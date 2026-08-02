---
id: 4101
title: "new Error(null) renders \"Error\" where §20.5.1.1 requires \"Error: null\" — the null/undefined conflation in the Error-message guard"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: compiler
area: codegen
language_feature: errors
goal: core-semantics
related: [4100, 4035, 2969, 2106]
---

# Problem

`§20.5.1.1` step 3 exempts **only `undefined`**:

> If _message_ is not **undefined**, let _msg_ be `? ToString(message)` and
> perform `CreateNonEnumerableDataPropertyOrThrow(O, "message", msg)`.

`null` is therefore **not** exempt — it must `ToString` to `"null"`:

```ts
String(new Error(null as any));   // spec: "Error: null"   actual: "Error"
```

Measured on `--target standalone`, verified by message TEXT (not length).

# Pre-existing, not a regression — verified

Fails identically on **base sha `bd1fc6516`**, i.e. before #4100. The
Error-message guard at the construction site has always been a bare
`ref.is_null`, which **conflates null with undefined**.

**#4100 preserved that conflation DELIBERATELY.** Its fix widened the guard to
also catch a runtime-undefined message (a tag-1 `$AnyValue` box under the #2106
singleton regime, which is not null), but kept null flowing to the same
name-only branch rather than silently widening scope into a different spec
question. Splitting the two is this issue.

# What to flip

The pinning test is:

`tests/issue-4100.test.ts` → `"KNOWN RESIDUAL: new Error(null) renders 'Error',
not the spec's 'Error: null'"`

It asserts the **current** behaviour on purpose, so this gap stays visible. A fix
must flip that assertion deliberately (to `"Error: null"`), not discover it.

The guard itself is `emitNullOrUndefinedMessageTest` in
`src/codegen/expressions/new-builtin-globals.ts`. Its name is accurate today and
would need to narrow to undefined-only — note the ToString path below it must
then actually render `null` as `"null"`, which is a second thing to verify
rather than assume.

# Scope warning — size before assuming one line

The change looks like a one-liner (drop `ref.is_null` from the OR). **Do not
assume that.** This is precisely the null-vs-undefined boundary, which after
#2106 is where blast radius hides: `null` and `undefined` became genuinely
distinct values in the externref plane (the singleton is a tag-1 box; null is
`ref.null.extern`), and a good deal of codegen still treats `ref.is_null` as
"nullish". Narrowing this one guard may expose call sites that were relying on
the conflation.

Required before implementing:

- [ ] Size the affected population — how many places construct an Error with a
      possibly-null message, and what do the standalone test262 buckets say?
- [ ] Confirm the ToString path renders `null` as `"null"` rather than
      degrading (`"[object Object]"` / empty) — the #2969 arm handles numbers
      and strings; null is a third shape.
- [ ] Check the internal compiler-emitted `TypeError`/`RangeError` paths
      (destructuring, coercion) do not pass a null message expecting the
      current name-only rendering.

# Acceptance

- [ ] `String(new Error(null))` renders `"Error: null"`, verified by message text.
- [ ] `undefined` (literal AND runtime) still renders `"Error"` — #4100's cases
      must not regress; they are the negative controls here.
- [ ] The `tests/issue-4100.test.ts` residual assertion is flipped, not deleted.
- [ ] Binary-size delta measured (#4100's inlined predicate is +28 B; this must
      not reintroduce the +3 KB object-runtime dependency).
- [ ] No budget allowance requested.
