---
id: 7416
title: "Make the silent missing-helper fallbacks loud: 18 sites that emitted nothing (or null/0) when a helper was absent now fail the compile"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: refactor
area: codegen
goal: core-semantics
related: [7413, 7414, 7401, 7300, 7465]
---

# #7416: make the silent missing-helper fallbacks loud

## Problem

The missing-helper audit
(`plan/log/missing-helper-silent-emit-audit-2026-11-19.md`) found 19 sites
that look up a helper with `ctx.funcMap.get` and, when it is absent, emit
nothing, or a `drop` plus null/0 stand-in, and carry on.

No program reaches the absent branch today: every path that gets there has
registered the helper first. That is luck, not a checked property. If a
future change reorders registration, the result is a silent wrong answer
on standalone/wasi: a dropped number, a skipped TypeError, or an f64 left
where an externref is expected.

## Change

One shared `requireHelper(ctx, name)` in
`src/codegen/helpers/required-helper.ts` returns the helper's function
index, and throws an internal compiler error when the helper is absent. The
18 sites call it in place of their silent fallback.

| file | sites | helper |
| --- | ---: | --- |
| `expressions/operator-assignment.ts` | 3 | `number_toString` |
| `regex-replace-fn.ts` | 2 | `__box_number` (replace callback `offset`) |
| `statements/nested-declarations.ts` | 2 | `__box_number` (`arguments` extras) |
| `statements/destructuring.ts` | 2 | `__box_number` (nested default on externref) |
| `index.ts` | 3 | `__box_number` (bridge `i32` result; `__call_@@toPrimitive` f64/i32) |
| `native-construct.ts` | 1 | `__typeof_object` (`new F()` returning an object) |
| `object-runtime-proxy.ts` | 2 | `__typeof_object` / `__typeof_function`, `__extern_is_undefined` (Proxy invariants) |
| `object-runtime.ts` | 1 | `__new_TypeError` (revoked proxy) |
| `object-proto-tostring.ts` | 1 | `__typeof_undefined` |
| `object-ops.ts` | 1 | `__is_truthy` (defineProperty trap rejection) |

Net −24 lines in `src/` (108 added, 132 removed, including the new helper file). No file or function grows.

Four modules had their own private copy of the same lookup-or-throw
(`generators-delegation-runtime.ts`, `generators-native-protocol.ts`,
`generator-yield-linearize.ts`, `array/array-search-proto-value.ts`). They
now call `requireHelper` too (review RV7347b).

## Not changed, and why

- **`index.ts:8090`** (`appendResultBoxing`, `void` result → `ref.null.extern`).
  The correct fallback is the native `undefined` (as #7413 does for the
  argument pad), which is a value change rather than a loud failure. Its own
  follow-up.
- **`array-methods.ts:6470`** (array HOF callback `arguments` extras,
  `__box_number`). **This one is reached**: the equivalence gate found it on
  gc (`issue-7165-string-vec-sort-undefined`, `a.map(show)`). The null
  stand-in is harmless there only because the callback never reads
  `arguments`. A hard error would break valid programs; the right fix is to
  register the helper (`ensureLateImport` plus a flush) before the detached
  instruction list is built. Filed as #7465, which measures the wrong answers
  (a callback declared after its call site reads `arguments[1]` as null).
- **`object-runtime.ts:11574`** (`primitiveNumberRead`). The helper reads
  are built eagerly for every length-field kind, including kinds that never
  use them, so requiring them there could fail a compile that does not need
  them. It needs a lazy rewrite first.

## Acceptance

- **Bytes unchanged.** Compile outputs on gc and standalone are identical to
  main on the 1,200-file sample: 2,400 outputs, 0 differences. The 26
  compile throws are the same on both sides, so none of them comes from
  `requireHelper`.
- **The equivalence gate passes** (4 shards, no regressions). Its first run
  caught `array-methods.ts:6470` being reached, and that site was reverted
  (see above).
- **All gates pass bare.**
