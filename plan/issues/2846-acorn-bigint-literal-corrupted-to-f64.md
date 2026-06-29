---
id: 2846
title: "compiled-acorn corrupts BigInt literals — parsed/marshalled as float64, losing value AND the `bigint` string"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
created: 2026-06-29
task_type: bugfix
area: codegen, runtime
language_feature: bigint
goal: acorn-dogfood
related: [1712]
umbrella: 1712
---

# #2846 — compiled-acorn corrupts BigInt literals (parsed as float64)

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). A `BigInt` literal is parsed
without throwing, but the resulting `Literal` node holds a **float64** value
instead of a BigInt, and even the raw-digit `bigint` STRING field is corrupted —
both lose precision at the float64 boundary.

## Divergence (compiled-acorn vs node-acorn, same pinned acorn@8.16.0)

`literals.js` (`const big = 9007199254740993n;`):

```
bigint-mismatch     $...init.value    expected 9007199254740993n   actual 9007199254740992   (number, not bigint)
primitive-mismatch  $...init.bigint   expected "9007199254740993"  actual "9007199254740992"  (rounded string)
```

`9007199254740993` is `2^53 + 1` — the smallest integer that float64 cannot
represent — so the rounding to `...992` is the tell-tale: the digits passed
through a float64 somewhere during parse/marshalling. node-acorn keeps
`value` as a real `BigInt` and `bigint` as the exact source digit string.

## Minimal repro

```js
const big = 9007199254740993n;
```

node-acorn: `{ type:"Literal", value: 9007199254740993n, bigint:"9007199254740993", raw:"9007199254740993n" }`

compiled-acorn: `value: 9007199254740992` (number), `bigint:"9007199254740992"`.

## Suspected root cause / scope note

Two layers, both suspect: (1) compiled-acorn's numeric-literal read path stores
the literal in an f64 rather than preserving the digit string for the `bigint`
field; (2) host marshalling has no BigInt representation. This intersects the
**i64-brand decision** that gates BigInt support project-wide (see memory
`project_bigint_i64_brand_gate`) — full `value: BigInt` may be blocked on that.
A cheaper partial win, even pre-i64-brand, is preserving the exact `bigint`
digit **string** field (no arithmetic needed), which is the field acorn callers
actually pattern-match on. Scope this issue to at least fixing the `bigint`
string corruption; the `value` BigInt object may defer to the i64-brand work.

## Acceptance

- `tests/dogfood/acorn-corpus.mjs` shows `corpus/literals.js` with the `bigint`
  string field exact (no `primitive-mismatch @ .bigint`).
- `value` either a real BigInt or documented-deferred to the i64-brand gate.
- No test262 regression.
