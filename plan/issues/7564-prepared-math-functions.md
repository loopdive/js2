---
id: 7564
title: "Prepared IR path: Math.* calls (inline ops, ToNumber of arguments); self-hosted transcendentals stay refused"
status: in-progress
created: 2026-11-27
updated: 2026-11-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
sprint: current
horizon: m
es_edition: ES5
related: [7354, 7350, 7562]
---

# #7564 — `Math.*` on the Prepared whole-program IR path

## Problem

The Prepared path (`wholeProgram: prepared-program-required`, wasmgc standalone) refused every `Math.*` call. On the
merge-queue ES5 IR run (main 781ef2e4ee: pass 1979 / fail 762 / compile_error 6276 / other 12 of 9029) `Math.pow` is
the first stop of 8 of 47 sampled propertyHelper rows (`var nonIndexNumericPropertyName = Math.pow(2, 32) - 1;`), and
`built-ins/Math/**` holds ~300 ES5 tests.

## Measurements on main (9bee2d81a2), before any change

(a) What the Prepared path accepts. One program per row (`.tmp/probe.mts`, refuse policy):

| Source | Result on main |
| --- | --- |
| `Math.abs/floor/ceil/sqrt(x)`, `Math.max/min(x, 2)` | refused: `runtime-demand: host provider or async demand is outside this numeric presentation contract` (+ `widening-demand`) |
| `Math.pow(2, 10)`, `a ** 10`, `Math.exp/sin/round/atan2(…)` | refused: `body-shape-rejected: … physical setup cannot be materialized: intrinsic math.<m> needs callable provider materialization` |
| `Math.random()`, `Math.max(1,2,3)`, `Math.max()`, `Math.max(3)` | refused: `method-call-unsupported: Math.<m> not in IR whitelist` |
| `Math.PI` (every constant), `var m = Math`, `typeof Math`, `Math.pow.length` | refused: `identifier "Math" is not in scope` |
| `Math.pow("2", 3)`, `Math.abs(null)` | refused: `Math.<m> arg must be f64, got string` / `bare 'null' in non-reference context (f64)` |
| `function f(a, b) { return Math.pow(a, b); }` | refused: `Math.pow arg must be f64, got dynamic` |

(b) How the ordinary pipeline implements them. `IR_MATH_METHOD_TABLE` (src/ir/select.ts) maps each member to a
semantic intrinsic; the runtime manifest (`PROVIDERS_BY_FEATURE`, src/ir/runtime/manifest.ts) selects:
- `backend-op` (abs, ceil, floor, sqrt, trunc), `backend-sequence` (fround), `backend-composite` (max, min, clz32,
  imul): emitted in place by the IR backend, no support function;
- `self-hosted` (acos … tanh, exp, log, pow, round, sign, …): ordinary TypeScript bodies in `src/stdlib/math.ts`,
  compiled through the IR by `src/codegen/stdlib-selfhost.ts` and registered by `emitInlineMathFunctions`
  (`src/codegen/math-helpers.ts`); `Math.random` is a hand body there.

(c) How the number formatter's runtime-support batch reaches the Prepared path: `prepareNumberFormatRuntimeSupport`
(src/frontend/builtins/prepare-number-format.ts) builds the IR of one stdlib body at preparation and stores it in
`program.runtimeSupport` (schema `ir-runtime-support-v1`, exactly one batch of kind `number-format-radix-v1` with a
pinned source sha). The batch is threaded through ~20 modules: ABI entries (program-abi-contracts.ts), validation,
codec, allocations, the physical plan (`nativeNumberFormat`), the consumer (`fillFormatterSupport` lowers the body),
and the presentation census (prepared-formatter-census.ts). Every one of those steps is formatter-specific.

(d) Precision of the self-hosted bodies against node. `.tmp/prec.mts` evaluates the `src/stdlib/math.ts` sources as JS
(their f64 `+ - * /`, `sqrt`, `floor`, `ceil`, `trunc`, `abs` are IEEE-identical to the Wasm ops) on 24 unary inputs and
320 `(base, exponent)` pairs:

| Member | Agrees bit-for-bit | First differing inputs (self-hosted vs node) |
| --- | --- | --- |
| pow | 284/320 | `pow(2, 0.5)`-class: `pow(2, 1/3)` = 1.2599210496881552 vs 1.2599210498948732; `pow(2, -1074)` = 0 vs 5e-324; `pow(2, 2.5)` |
| exp | 9/24 | `exp(1)` = 2.71828182442294 vs 2.718281828459045 |
| log | 14/24 | `log(0.5)` = -0.6931471702560121 vs -0.6931471805599453 |
| sin / cos / tan | 10 / 9 / 8 of 24 | `sin(2)` = 0.9092974515196739 vs 0.9092974268256817 |
| atan / asin / acos / atan2 | 13 / 21 / 20 of 24, 225/320 | `atan(0.5)` = 0.4636476094151571 vs 0.4636476090008061 |
| log2 / log10 / log1p / expm1 | 14 / 17 / 14 / 9 of 24 | `log2(0.5)` = -0.9999999851345667 vs -1 |
| sinh / cosh / tanh / asinh / acosh / atanh / cbrt | 7–19 of 24 | `acosh(1e300)` = Infinity vs 691.4686750787736; `cbrt(0.5)` last bit |
| round, sign | 24/24 | — |

Every transcendental, `pow` included, gives a WRONG VALUE against node for ordinary inputs. Under this lane's rule a
member whose result differs from node stays refused, so reusing `Math_pow` through a runtime-support batch is not
admissible, and `**` (the same `math.pow` intrinsic) stays refused with it. (The ordinary pipeline ships these bodies
today; that precision gap is its own issue, not this slice's.) round and sign agree, but they alone do not justify a
second runtime-support batch kind; they stay refused until the batch is generalised.

## Implementation Plan

Target structure:
1. **Inline Math members** — `src/compiler/prepared-provider-census.ts`, `runtimeCensus`. The census required every
   non-remainder provider to be a runtime callable of the native setup, so a canonical `backend-op` / `-sequence` /
   `-composite` provider (which the physical plan already accepts: `missingIntrinsicMaterialization`) made the census
   undefined and the presentation refused. Such a provider joins no support row; the census admits it when it is
   exactly a canonical catalogue row (`canonicalProvider(RUNTIME_PROVIDERS, …)`, the check every native provider
   already gets). Reuses the census's own canonical check; adds no table.
2. **ToNumber of arguments** — `src/ir/realm-static-call.ts` + the existing Math arm of `src/ir/from-ast.ts`. On the
   realm's lane (`createsFunctionObjects`) each argument is lowered as a carrier, then (after all are evaluated, the
   spec's order) converted with the conversion `Number(v)` already uses: `realmToNumber`, extracted from
   `lowerRealmConversionCall` so both share one body. The flow rule's exemption (`realmBuiltinOperand`) admits an
   argument of a pristine `Math` method call (`pristineMathCall`), as it does for `Object` statics. The ordinary
   lane keeps its f64-only arm unchanged.
3. Out of this slice (stay refused; named in the result): self-hosted members (precision, above), `Math.random`,
   arities other than the table's (`Math.max()`, `Math.max(a, b, c)`), constants (`Math.PI`: legacy's table lives in
   `src/codegen/builtin-value-read.ts`, which the IR may not import; the realm catalog has no `Math`), and `Math` as a
   value.

Acceptance:
- Correctness: every admitted member agrees with node (`Object.is`, -0 and NaN included) on ≥14 edge inputs, each
  agreement with a wrong twin that throws; non-number arguments (null, undefined, strings, Booleans, objects with
  `valueOf`/`toString`), argument evaluation before conversion, and a throwing `valueOf` agree with node; members
  above stay refused, never a wrong value, trap, invalid module or compile throw.
- Cost: a program not using Math compiles byte-identical on the Prepared path; a program using an inline member pays
  only that op; ordinary pipeline byte-identical on ~30 programs.
- Code quality: no new table, no new IR→codegen/runtime edge, `src/ir/from-ast.ts` does not grow, one ToNumber body
  shared by `Number(v)` and the Math arm.
