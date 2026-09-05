---
id: 4599
title: "STANDALONE: `String(Math)` / `Object.prototype.toString.call(Math)` answer `[object Object]`, want `[object Math]` — a working identity-tag fix exists but is gated on unifying __to_primitive's hardcoded constant with the real classifier"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: 5
language_feature: builtin-namespaces
goal: es5
related: [4492, 4596, 4119]
origin: "2026-08-21 wave-2 protos lane. Implemented, measured at zero lane rows, and REVERTED per the zero-row rule — recorded here so the working approach is not lost."
---

# #4599 — namespace objects stringify as `[object Object]`

## The defect

`Object.prototype.toString.call(Math)`, `String(Math)`, and a borrowed
`Math.getClass()` all answer `[object Object]`; ES5 [[Class]] (and ES2015+
`@@toStringTag`, same string) wants `[object Math]`. `JSON` (and `Reflect`)
identically.

## A working fix exists and was deliberately reverted

The wave-2 protos lane implemented tagging **by identity against the
`__builtin_<Name>` singleton global** inside the §20.1.3.6 classifier —
deliberately NOT an own internal slot, which would then need hiding from
`Object.keys` / `for-in` / `getOwnPropertyNames` / gOPD. It works for the
value-erased borrowed form.

It moved **zero** lane rows and was reverted per the standing rule. The reason
it moves zero is itself the real finding:

> The one row that wants it (`String/prototype/split/instance-is-math`) reaches
> `[object Object]` through **`__to_primitive`'s hardcoded constant** at
> `src/codegen/object-runtime.ts:4504` — a DIFFERENT stringifier from the
> classifier. Same constant-fold-vs-runtime split as #4492 Finding 2 and #4596.

## What landing it needs

`__to_primitive`'s residual arm must call the real classifier instead of the
baked constant. There is no reusable named native for the classifier today (one
call site), so this is a small refactor with the funcidx-ordering hazards
`object-runtime.ts` warns about — mint the classifier as a named native first,
then both call sites share it, then the identity tag lands and the row follows.

A patch of the classifier half existed at
`/Users/thomas/.claude/jobs/f2c14fbe/tmp/namespace-tag.patch` (session scratch,
NOT durable) — re-derivable from the description above: identity test against
the `__builtin_Math`/`__builtin_JSON` singletons in the §20.1.3.6 chain, ahead
of the plain-`$Object` arm.
