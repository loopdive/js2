---
id: 7285
title: "IR: template-literal substitutions (`expr-template-substitution-family`)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7277, 7251, 7106]
assignee: "ttraenkler/c-r7"
---

# IR: template-literal substitutions

## Problem

`expr-template-substitution-family` refuses an untagged template literal
whose substitution has no proven string/number/boolean family. Wrapped
stride-40 standalone ledger:

| substitution | main `8b349439` | with #7277 (`613751c2`) |
| --- | --- | --- |
| `expression` | 17 | 28 |
| `hex` | 14 | 14 |
| `s0` | — | 14 |
| `tag0` | 7 | 14 |
| `v` | — | 7 |
| `value` | 5 | 5 |
| `message` | 2 | 2 |
| **total** | **45** | **84** |

## Measurement (2026-11-06, the #7277 branch; nothing shipped)

Every refused substitution is a bare identifier. The census compiled
wrapped stride-40 files that contain a template or include a
template-heavy harness, standalone, `JS2WASM_IR_SHAPE_DIAG=1`. 79 refused
units:

| unit | where | substitution | kind of value |
| --- | --- | --- | --- |
| `testPropertyOfStrings`, `testPropertyEscapes` | regExpUtils.js | `expression` | a parameter; legacy slot is a non-null string after #7277, but the checker sees `any` |
| `printCodePoint` | regExpUtils.js | `hex` | a local, `codePoint.toString(16).toUpperCase().padStart(…)`: a dynamic method chain |
| `__js2wasm_lf_*` (6 units) | the runner's Intl locale-fallback shim | `s0`, `tag0`, `v`, `value` | parameters / locals: string or dynamic |
| `verifyFormatParts`, `checkSettledPromises` | testIntl.js, promiseHelper.js | `message` | a parameter, `string \| undefined` (dynamic) |

**Yield.** No file has a template refusal as its only legacy unit: 0 of
79. The files that contain one carry 5–39 legacy units each (42 files ×
7, 24 × 38, 6 × 39, 6 × 17, 1 × 5). Whole-file zero-legacy yield from this
family alone is **0**.

**Probe of the cheapest admission.** The draft was not shipped. When a
substitution is an unmutated parameter whose claim resolved `string` or
`f64` (the #7277 projection), `templateSubstitutionFamily` would answer
that family, through a `currentStringParamNames` sibling of
`currentNumericParamNames`. Effect in the census:
- 11 of the 14 `testPropertyEscapes` move on to their next refusal (the
  for-of local `symbol`);
- `__js2wasm_lf_kind` / `__js2wasm_lf_case` move on to
  `call-graph-closure`.

No unit became IR-emitted: 0 units, 0 files.

**Dynamic substitutions** (`hex`, `symbol`, `v`, `tag0`, `value`, `message`)
would need two things:
1. A move-only scan arm for `TemplateExpression`. Today a dynamic
   substitution falls into the conservative `subtreeTouchesDynamic` tail.
   The selector's template arm also refuses before that scan runs.
2. A ToString that matches legacy exactly. Legacy's template span calls
   `emitToString(…, "string")`, which on the native lanes checks for a boxed
   Boolean first (`__typeof_boolean` → "true"/"false") and only then calls
   the string-hint `__extern_toString` (`src/codegen/coercion-engine.ts`).
   The IR's `dyn.to_string` (`src/ir/integration.ts`, `emitToString`) calls
   `__extern_toString` directly, with no Boolean pre-check. The comment there
   says a linked provider can rebuild a Boolean into a caller-local box, so
   the two can differ for a dynamic Boolean. That must be reconciled
   (shared, or proved equal) before a dynamic substitution reuses it.

## Plan (when a later slice makes it pay)

1. `templateSubstitutionFamily` reads the claim's resolved parameter kinds
   (string / f64) for an unmutated parameter. This is the draft above:
   about 14 lines, no new import.
2. Give the dynamic ToString one engine. Either `dyn.to_string` lowers
   through legacy's `emitToString` arm, Boolean pre-check included, or a
   probe proves the pre-check redundant for every carrier the IR can hold.
3. Add a `TemplateExpression` arm to the move-only scan: each span is
   scanned as dynamic or concrete, and the result is a concrete string. The
   selector's template arm defers a dynamic-shaped substitution to that scan.
   from-ast's `templateSubstitutionToString` adds `dyn.to_string` for a
   dynamic carrier. No new sibling arm: it extends the existing
   string/number/boolean conversion.
4. Validation: typed corpus byte-identical; ledger A/B; standalone + gc
   test262 A/B incl. 50 `language/expressions/template-literal` files;
   adversarial probes per kind (`-0`, `NaN`, `1e21`, objects, a throwing
   `toString`, a boxed Boolean, left-to-right side effects).

The unlock is upstream: regExpUtils' `printCodePoint` / `testPropertyEscapes`
need the dynamic method chain and for-of over a string; the Intl shims need
their callees. Revisit when those land.
