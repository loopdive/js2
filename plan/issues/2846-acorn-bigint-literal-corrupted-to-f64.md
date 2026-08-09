---
id: 2846
title: "compiled Acorn corrupts arbitrary-width BigInt literal value and bigint fields beyond signed i64"
status: done
assignee: ttraenkler/codex-acorn
sprint: 69
priority: high
horizon: m
feasibility: hard
created: 2026-06-29
updated: 2026-07-26
reopened: 2026-07-26
completed: 2026-07-26
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/registry/imports.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/runtime.ts::<anonymous>#78
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

## Resolution (2026-06-30)

Fixed via the architect's narrow path (a): a 2-LOC change to the func-type
dedup chokepoint in `src/codegen/registry/types.ts`.

- `funcTypeKey` now emits a `:big` suffix for a bigint-branded i64 result/param,
  so a `(...)->i64:big` signature keys distinctly from a plain `(...)->i64`.
- `valTypeEq` gains an i64 `bigint`-brand equality check so structural-match
  callers (`funcTypeEq`) do not re-merge the two.

Root cause confirmed by probe: acorn's `stringToBigInt` has signature
`(externref) -> i64:big`; on unfixed main its brand-blind key `externref|i64`
collided (cacheHit) with a pre-existing plain `(externref) -> i64` def, so
`getWasmFuncReturnType` returned a plain i64 → boxed via `__box_number`
(`f64.convert_i64_s`) → precision loss past 2^53. Same class as #2795 (i32
boolean/symbol brand).

### Verify-first (acorn differential corpus, `corpus/literals.js` = `const big = 9007199254740993n;`)

- BEFORE (main): `REAL×2` — `bigint-mismatch @ .value` expected `9007199254740993n`
  actual `9007199254740992`; `primitive-mismatch @ .bigint` expected
  `"9007199254740993"` actual `"9007199254740992"`.
- AFTER (fix): `corpus/literals.js: EQUAL(±quirks)`, REAL=0 — `value` is a real
  BigInt and `bigint` is the exact source digit string.

Regression test: `tests/issue-2846.test.ts` (registry-level dedup-distinctness
assertion that fails on unfixed main + BigInt round-trip e2e guards).

## Reopened 2026-07-26 — arbitrary-width literals still wrap through i64

The original fix correctly preserves the BigInt brand and is exact for values
representable by the native signed-i64 carrier. The full pinned-Acorn/Test262
differential under #1712 widened the corpus beyond that range and shows both
ESTree fields wrapping modulo 2^64:

```text
expected value:  18446744073709551615n
actual value:    -1n
expected bigint: "18446744073709551615"
actual bigint:   "-1"
```

Larger powers similarly become `0n`, and very large decimal literals retain
only their signed low 64 bits. This is a residual of the same Acorn literal
fidelity contract, so the completed issue is reopened rather than filing a
duplicate. The completed four-shard baseline contains **97 affected files /
194 sloppy+strict variants**.

The new requirement is arbitrary-width preservation. At minimum, Acorn's
source-derived `bigint` string field must remain exact even when the runtime
cannot yet represent the `value` as a native mathematical BigInt. Prefer a
canonical boxed arbitrary-width representation that also makes `value` exactly
match node-acorn; do not silently preserve the current signed-i64 truncation.

### Reopened acceptance

- Literal values beyond `2^63 - 1`, `2^64 - 1`, and substantially beyond 64
  bits preserve the exact decimal digits in the ESTree `bigint` field.
- The ESTree `value` is an exact BigInt matching node-acorn, or its deferred
  representation is explicitly blocked on a separately accepted arbitrary-
  precision runtime design; signed-i64 truncation is not accepted.
- The full pinned-Acorn/Test262 differential reports zero BigInt AST
  mismatches for the recorded corpus.

### Final resolution (2026-07-26)

Nullable primitive return lowering now preserves the explicit-null union while
carrying a non-null BigInt result as `externref`. Acorn's
`stringToBigInt` path therefore keeps arbitrary-width host BigInts exact rather
than narrowing through signed i64. The focused regression covers a 128-bit
boundary value and the clean published-head Test262 differential reports zero
BigInt AST mismatches across **53,259 files / 102,312 variants**.
