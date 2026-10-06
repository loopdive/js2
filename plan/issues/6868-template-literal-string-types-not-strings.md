---
id: 6868
title: "Template-literal and string-mapping types are not classified as strings: `.length` on a `\\`${string}-${string}\\``-typed value is NaN on the native regime and standalone"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: checker, codegen
language_feature: strings
goal: architecture
parent: 6749
related: [5385, 6749, 1503]
---

# #6868 — template-literal string types lower as non-strings

## Problem

`crypto.randomUUID()` is typed `` `${string}-${string}-${string}-${string}-${string}` ``
in lib.dom. Found while wiring uuid onto the native regime (#6749 part A): the
UUID arrives as a proper native string (`typeof` → `"string"`, the value prints
correctly), but `crypto.randomUUID().length` is `NaN`. The same program under
`--target standalone`, with no host involved:

```ts
function f(): `${string}-${string}` { return "ab-cd" as any; }
export function lenTL(): number { return f().length; }        // NaN
export function lenStr(): number { return (f() as string).length; } // 5
```

Measured 2026-10-06 (`tests/probe-6749-tl.test.ts`, scratch): standalone and
the regime both return `NaN` for `lenTL`, `5` for `lenStr`. The default `gc`
lane is unaffected only because `.length` on an externref goes to the host.

## Root cause

Every string classifier tests `ts.TypeFlags.String | ts.TypeFlags.StringLiteral`
and nothing else:

- `src/checker/oracle.ts` `factOfType` (≈ L492)
- `src/checker/type-mapper.ts` ≈ L77, L412 and `isStringLiteralUnion` ≈ L443

`ts.TypeFlags.TemplateLiteral` and `ts.TypeFlags.StringMapping` (the
`Uppercase<…>` family) are `StringLike` in the checker but fall through to
"not a string" here, so the property access takes a non-string arm.

## Fix

Add `ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping` to each of the
four tests (equivalently `ts.TypeFlags.StringLike`). Focused test with the
program above under standalone and under the regime: `lenTL === 5`. This is
NOT byte-identical for default `gc` on programs that carry such types (a value
that was `externref` becomes a native string there too), so it ships separately
from the #6749 part-A PR, which is.

## Acceptance

- [ ] `lenTL` is 5 under `--target standalone`, the native regime, and default `gc`.
- [ ] `check:oracle-ratchet`, `check:coercion-sites` green; equivalence gate green.
- [ ] uuid's `validate(uuid) + version(uuid)` sample op measures on the regime
      lane with the host lane's checksum (re-check in #6749 after this lands).
