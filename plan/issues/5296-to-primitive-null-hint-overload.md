---
id: 5296
title: "`__to_primitive`'s null-hint convention is overloaded — \"default\" and \"number\" are indistinguishable"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: s
feasibility: medium
goal: standalone-mode
reasoning_effort: medium
---

## Problem

The standalone `__to_primitive` runtime helper encodes the ES2015 §7.1.1
`hint` as an externref, and uses `ref.null.extern` to mean "no explicit
hint". But two different callers pass that same null for two DIFFERENT
spec hints:

- the `ToLength` / numeric-coercion path (`src/codegen/object-runtime.ts`
  ~L11799) means **`"number"`**;
- string concatenation (`"" + v`) means **`"default"`**.

So the helper cannot tell them apart, and a user `[Symbol.toPrimitive]`
handler — which receives the hint as its only argument and is entitled to
branch on it — is handed the wrong string.

## Observed

Standalone, node as oracle:

```js
var w = { [Symbol.toPrimitive](h) { return "P<" + h + ">"; }, x: 41 };
var v = w;
"" + v        // node: P<default>   main (pre-#5269): [object Object]   after #5269: P<null>
```

`String(v)` is correct (`P<string>`) on both — only the hintless
`default` path is affected.

## Why it surfaced now

Before #5269's round-3 fix the value never reached the handler at all on
this path, so the wrong hint was invisible behind a wrong result. That
fix (`src/codegen/to-primitive-open-object.ts`, carrying "open object" on
the TYPE rather than on the syntactic position) makes the handler run,
which is why the row moved from `[object Object]` to `P<null>`. Both are
wrong against node; the fixed one is the only version that actually
invokes the user's handler, and the wrong part is now the hint STRING
rather than the value.

This was recorded as the single "differently-wrong" row in that lane's
round-3 report and deliberately left alone: it cannot be fixed at the
`@@toPrimitive` call site without picking one of the two meanings and
silently breaking the other caller.

## Root cause

One sentinel, two meanings. The fix is to stop overloading it — either
pass the hint explicitly at every call site (three known: string, number,
default), or split the null into two distinct sentinels so the numeric
path and the default path are separable.

## Acceptance criteria

- `"" + v` answers `P<default>`, `String(v)` answers `P<string>`, and
  `+v` / `v * 1` answer with hint `"number"`, all matching node, on
  `--target standalone`.
- The `ToLength` numeric path is unchanged — pin it, since it is the
  caller that would silently break if the sentinel is reassigned rather
  than split.
- Host lane binaries byte-identical (this is a standalone-only helper).
- No new `env::` import in a standalone module.
- The passing `Symbol.toPrimitive` rows in the ES2015 standalone baseline
  stay green: re-run `built-ins/Symbol/toPrimitive/**` and the
  `@@toPrimitive` rows under `built-ins/Date/prototype/@@toPrimitive/**`
  before and after, not just the rows this issue claims.

## Related

- #5269 — the round-3 fix that made this observable; its report names this
  as the one row behind an otherwise unqualified "never worse than base".
- #5102 — the earlier `@@toPrimitive` work whose gate #5269 R2-5 widened
  and then reverted.
