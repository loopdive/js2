---
id: 7566
title: "Correct math library: self-hosted Math.* bodies that agree with node bit for bit"
status: ready
created: 2026-11-27
updated: 2026-11-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: implementation
area: stdlib, ir, compiler
goal: ir-full-coverage
sprint: current
horizon: xl
es_edition: ES5
related: [7564, 7354]
---

# #7566 — a correct math library for the self-hosted `Math.*` functions

## Problem

`src/stdlib/math.ts` holds the bodies behind `Math.exp`, `log`, `pow`, the trig, inverse-trig and hyperbolic
functions, `cbrt`, `expm1`, `log1p`, `log2`, `log10`. They are short series approximations, and they return wrong
values. Measured twice on 2026-11-27 (ordinary pipeline, standalone target, compiled and executed):

| Call | ours | node |
| --- | --- | --- |
| `Math.exp(1)` | 2.71828182442294 | 2.718281828459045 |
| `Math.pow(2, 1/3)` | 1.2599210496881552 | 1.2599210498948732 |
| `Math.pow(2, -1074)` | 0 | 5e-324 |
| `Math.sin(1e22)` | -9.408544980940057e+58 (range reduction loses every bit) | -0.8522008497671888 |
| `Math.cbrt(1.7976931348623157e308)` | 2.61575890113192e+152 | 5.643803094122362e+102 |
| `Math.acosh(1e300)` | Infinity | 691.4686750787736 |

Consequences:

- Every program compiled today gets these values, on every target (the JavaScript environment uses the same bodies:
  Finding 1).
- The Prepared whole-program IR path (#7354, the route to ES5 test262 on the IR) must keep `pow`, `**`, `exp`, `log`
  and the trig functions refused, because its rule is "never a wrong value versus node" (#7564).

## Findings

All measurements: this worktree at main `b78ea8d439`, node v22.23.4 (V8 12.4.254.21), x86-64, glibc 2.39. Scratch
scripts lived in `.tmp/mathprobe/` and are not committed; each finding says how it was produced so it can be redone.

### 1. Inventory: who implements each member today

| Member | Ordinary pipeline, WasmGC (`standalone`, `wasi`, and the JS environment `gc`) | IR intrinsic and provider | Linear (`--target linear`) |
| --- | --- | --- | --- |
| `abs` `sqrt` `floor` `ceil` `trunc` | one Wasm op | `math.*`, `backend-op` | op (`Math.sqrt` compiles and agrees 910/910) |
| `fround` | `f32.demote_f64` + `f64.promote_f32` | `backend-sequence` | not measured |
| `clz32` `imul` `max` `min` (2 args) | inline composite | `backend-composite` | not measured |
| `max` `min` (0, 1, 3+ args, spread) | inline, legacy only (`compileMathCall`, `src/codegen/expressions/builtins.ts`) | not in `IR_MATH_METHOD_TABLE` (arity 2 only) | — |
| `round` (10 lines), `sign` (5) | self-hosted body, `src/stdlib/math.ts`; legacy also has an inline copy in `compileMathCall` | `self-hosted` | — |
| `exp` (21), `log` (16), `pow` (51), `sin` (8), `cos` (7), `tan` (5), `asin` (7), `acos` (7), `atan` (24), `atan2` (25) — ES5 | self-hosted body, `src/stdlib/math.ts` (`Math_<name>`) | `self-hosted`, symbol `Math_<name>` | **compile error** (`Unsupported method call: .sin()`) |
| `cbrt` (14), `expm1` (8), `log1p` (7), `log2` (16), `log10` (9), `sinh` (6), `cosh` (5), `tanh` (8), `asinh` (6), `acosh` (6), `atanh` (6) — ES2015 | self-hosted body, same file | `self-hosted` | compile error |
| `__math_reduce_trig` (4) | self-hosted helper of `sin`/`cos` | `math.reduce-trig` | — |
| `hypot` | inline legacy code only (`compileMathCall`): scaled sum of squares | none | — |
| `random` | hand-written Wasm in `src/codegen/math-helpers.ts`: xorshift64 in a module global (standalone) or `random_get` (WASI) | none | — |
| `**`, `**=` | the `pow` body (`import-collector.ts` adds `pow` to the needed set) | `math.pow` | — |
| `%` | `__fmod`, one context-free Wasm body (`src/wasm/physical/number-remainder.ts`); the linear backend has its own copy (`src/codegen-linear/runtime.ts`) | `js.number.remainder`, `runtime-callable` | own copy |
| constants (`Math.PI`, …) | legacy table (`src/codegen/builtin-value-read.ts`) | none | — |

- **No host import is involved in any target.** `Math.exp(x)` compiled for the default JS target has zero imports and
  the same wrong values as standalone (475/910 in both). So the fix changes JS-environment output too, for programs
  that call these members. That is the allowed case: the same body serves both.
- The linear lane has no transcendental `Math` at all. The IR Linear backend selects with
  `supportsSymbolicMathHelpers: false` (`src/ir/backend/linear-integration.ts`).
- How it was measured: read of the modules named above, plus ten compiles (`compile(src, { target })`, imports read
  with `WebAssembly.Module.imports`).

### 2. Accuracy today

Input set, fixed seed (xorshift32, seed `0x7566abcd`): 910 unary inputs (special values, thresholds such as 709.78,
-745.13, 2^-28, neighbours one ulp either side of 20 specials, powers of two from 2^-1074 to 2^1023, powers of ten,
integers and half-way cases, 200 random bit patterns, 400 random values in ordinary ranges) and 1,928 pairs (a 29 × 32
grid of special bases and exponents, 300 random real pairs, 200 small-integer pairs, 200 pairs with a base of 2^r, 100
with a base near 1, 200 random bit patterns).

The bodies were executed as JavaScript (their arithmetic is plain f64 `+ - * /` and `sqrt`/`floor`/`ceil`/`trunc`/
`abs`, which are IEEE-identical to the Wasm ops). Cross-check: `exp`, `log`, `sin`, `tan` were also compiled for
standalone and run on the same 910 inputs; the agreement counts are identical (475, 569, 285, 241).

"Wrong kind" counts results that are not comparable in ulp: zero against non-zero, finite against infinite or NaN, or
the wrong sign.

| Member | Agrees with node | Worst error (ulp) | Wrong kind | Worst input (ours vs node) |
| --- | --- | --- | --- | --- |
| exp | 475/910 | 3.9e7 | 3 | `exp(709.782712893384)` = Infinity vs 1.7976931348622732e+308 |
| log | 569/910 | 9.3e7 | 0 | `log(0.5000000000000001)` = -0.6931471702560118 vs -0.6931471805599451 |
| pow | 1178/1928 (random real pairs: 2/300) | 1.9e8 | 3 | `pow(0.5, -2.5)` = 5.656854082299962 vs 5.65685424949238; `pow(2, -1074)` = 0 |
| sin | 285/910 | wrong magnitude | 140 | `sin(1.7976931348623157e308)` = -Infinity vs 0.004961954789184062 |
| cos | 304/910 | wrong magnitude | 139 | `cos(9.92e35)` = 5.7e222 vs 0.6968292950431353 |
| tan | 241/910 | wrong magnitude | 136 | `tan(1.7976931348623157e308)` = NaN vs -0.004962015874444895 |
| asin | 782/910 | 2.4e8 | 0 | `asin(0.3795886692168704)` = 0.389351635114431 vs 0.38935164864695215 |
| acos | 779/910 | 9.2e7 | 0 | `acos(0.932532770713727)` |
| atan | 551/910 | 2.3e8 | 0 | `atan(0.40886287202784866)` = 0.3881233447769745 vs 0.3881233575389948 |
| atan2 | 1226/1928 | 2.8e8 | 0 | `atan2(7.667289864379248, 18.506608996201834)` |
| cbrt | 385/910 | wrong magnitude | 0 | `cbrt(1.7976931348623157e308)` = 2.6e152 vs 5.6e102 (8 Newton steps do not converge) |
| expm1 | 470/910 | 8.1e7 | 1 | `expm1(0.3795886692168704)` |
| log1p | 594/910 | 9.3e7 | 0 | `log1p(-0.5)` = -0.6931471702560121 vs -0.6931471805599453 |
| log2 | 635/910 | 1.3e8 | 0 | `log2(0.5000000000000001)` = -0.9999999851345662 vs -0.9999999999999997 |
| log10 | 546/910 | 8.1e7 | 5 | `log10(0.9999999999999999)` = 0 vs -4.8216373327664354e-17 |
| sinh | 257/910 | wrong magnitude | 151 | `sinh(5e-324)` = 0 vs 5e-324 |
| cosh | 472/910 | 3.9e7 | 3 | `cosh(-4.5)` = 45.01412042578373 vs 45.014120148530026 |
| tanh | 379/910 | wrong magnitude | 146 | `tanh(5e-324)` = 0 vs 5e-324 |
| asinh | 265/910 | wrong magnitude | 231 | `asinh(5e-324)` = 0 vs 5e-324 |
| acosh | 694/910 | 2.5e7 | 44 | `acosh(1.7976931348623157e308)` = Infinity vs 710.4758600739439 |
| atanh | 575/910 | wrong magnitude | 146 | `atanh(5e-324)` = 0 vs 5e-324 |
| hypot, 2 args (legacy inline) | 1928/1928 | 0 | 0 | — |
| hypot, 3 args (legacy inline) | 581/600 | 2 | 0 | `hypot(1.0000000000000002, 31, 1e-8)` |
| round | 910/910 | 0 | 0 | — |
| sign | 910/910 | 0 | 0 | — |

An error of 1e7 to 1e8 ulp means the result is good to about 8 decimal digits out of 16.

### 3. What "correct" means, and which reference reproduces node

The oracle is node. V8 does not call the platform's math library for these members: it carries its own port of
fdlibm in `src/base/ieee754.cc`. I compiled that file from the node v22 source tree unchanged (gcc, `-O2
-ffp-contract=off`, four small stub headers) and ran it on the input set:

| Member | V8 `ieee754.cc` vs node 22 | glibc 2.39 `libm` vs node 22 |
| --- | --- | --- |
| exp, log, sin, cos, tan, asin, acos, atan, cbrt, expm1, log1p, log2, log10, sinh, cosh, tanh, asinh, acosh, atanh | **910/910 each** | 465 (cbrt) to 910 (expm1, log1p); 1 to 2 ulp off elsewhere |
| atan2 | **1928/1928** | 1740/1928 |
| pow | **1928/1928** | 1829/1928 |
| `**` vs `Math.pow` in node | 1928/1928 identical | — |
| hypot (V8's `MathHypot`: Kahan-compensated scaled sum, transcribed by me from memory of `math.tq`) | 1928/1928 (2 args), 600/600 (3 args) | — |

So the reference for every member except `hypot` is **V8's `src/base/ieee754.cc`**, not stock fdlibm: V8 carries its
own changes (for example `exp(1)` returns the constant `E`, and `log2`/`log10`/`cbrt` come from FreeBSD's versions).
Per member the fdlibm ancestry is: `e_exp.c`, `e_log.c`, `e_pow.c`, `s_sin.c`/`s_cos.c`/`s_tan.c` with
`k_sin.c`/`k_cos.c`/`k_tan.c`/`e_rem_pio2.c`/`k_rem_pio2.c`, `s_atan.c`, `e_atan2.c`, `e_asin.c`, `e_acos.c`,
`s_cbrt.c`, `s_expm1.c`, `s_log1p.c`, `e_log2.c`, `e_log10.c`, `e_sinh.c`, `e_cosh.c`, `s_tanh.c`, `s_asinh.c`,
`e_acosh.c`, `e_atanh.c`. `e_hypot.c` is not what V8 uses. The implementer ports from the V8 file, and the test is
agreement with node, not fidelity to a source file.

Where I am not sure, and what I did establish:

- **`pow` on node 24 and later is not fdlibm. This is the main uncertainty of the whole plan.** CI runs node 24 and
  25. In those trees `Math.pow` goes through `v8::internal::math::pow` (`deps/v8/src/numbers/ieee754.cc`), which calls
  the platform's `std::pow` when the flag `use_std_math_pow` is on, and the flag's default is `true`
  (`flag-definitions.h` in the v24.x tree). `y == 2` and `y == 0.5` are special-cased first. The fdlibm port is still
  there as `legacy::pow`. I read this in the source; **I could not run node 24 on this machine** (running a
  downloaded binary was refused), so the numbers below use glibc's `pow` wrapped the way that function wraps it:
  - glibc and fdlibm `pow` differ on 99 of 1,928 pairs, always by 1 ulp: 28 of 300 random real pairs, 13 of 200
    small-integer pairs.
  - On an 855-pair grid (bases 2..20, exponents -22..22): they differ on 67. `Math.pow(5, -5)` is
    0.00031999999999999997 with fdlibm (node 22) and 0.00032 with glibc. Against the exactly rounded result (BigInt):
    glibc 852/855, **today's body 818/855**, fdlibm 791/855.
  - So a faithful fdlibm `pow` matches node 22 everywhere and node 24+ on about 92 to 95 % of non-trivial inputs, and
    for small integer exponents it is *further* from node 24+ than today's square-and-multiply loop.
  - On node 24+ `pow` also depends on the platform (glibc on Linux, Apple's and Microsoft's libraries elsewhere) and
    possibly on the CPU (glibc picks an FMA variant at run time; not measured whether the two variants ever differ).
  See slice 2 and open question 1.
- **`sin`/`cos`**: V8 has a build switch (`V8_USE_LIBM_TRIG_FUNCTIONS`) that replaces them with glibc's code. Chrome
  sets it. node's build files (`tools/v8_gypfiles/*.gypi`, `v8.gyp`, v22.x and v24.x) do not mention it, and node 22
  agrees with the fdlibm port 910/910. Not verified by execution on node 24/25.
- Every other member: `src/base/ieee754.cc` is identical between the v22.x, v24.x and v25.x trees except for a
  comment and the `legacy` namespace around `pow`.
- `hypot`: agreement measured, but the algorithm was written from memory, not read from `math.tq`.

Licence. `ieee754.cc` carries two notices: Sun's fdlibm notice ("Copyright (C) 1993 by Sun Microsystems, Inc. …
Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is
preserved") and "modified significantly by Google Inc. Copyright 2016 the V8 project authors" (V8's BSD-3-Clause
licence). The repository has no record of third-party notices today: no `NOTICE` file, `package.json` `files` ships
only `LICENSE`, and the existing Ryu port under `src/runtime/wasmgc/values/number-ryu-*.ts` carries only the Loopdive
header. The plan: both notices in the header of every ported source file, a new root `THIRD_PARTY_NOTICES.md` holding
both texts, and that file added to `package.json` `files` (bundling strips source comments). Open question 3 asks
whether a notice must also travel with compiled user programs, which embed the ported code.

### 4. How the bodies are written and shared

- **Authoring.** Each body is ordinary TypeScript source in a template string, in the subset the IR front end accepts
  (`: number` parameters and locals, `if`, `while`, ternaries, `Math.abs/sqrt/floor/ceil/trunc`, calls to sibling
  helpers by name). `src/codegen/stdlib-selfhost.ts` compiles it through the compiler's own pipeline (AST to IR, IR
  passes, IR to Wasm). The IR is context-free and memoized per process; only the last step needs the live module.
- **Ordinary pipeline.** `collectMathImports` puts the member into `ctx.pendingMathMethods`;
  `emitInlineMathFunctions` (`src/codegen/math-helpers.ts`) emits bodies in a hand-kept order with hand-kept
  dependency flags (`needExp`, `needLog`, `needAtan`, `needSinCos`). Same route for `standalone`, `wasi` and `gc`.
- **Linear.** No route. The bodies are pure f64 functions (f64 ops and calls, no GC types), so the same IR can be
  lowered by the IR Linear backend once it has a materializer and `supportsSymbolicMathHelpers` is true.
- **Prepared path.** Two existing mechanisms could carry a leaf function there:
  - The number formatter's runtime-support batch (`src/frontend/builtins/prepare-number-format.ts`,
    `program.runtimeSupport`). It is built for one body with a scratch buffer, kernels and string literals; 37 files
    mention it, and the batch carries a source hash. Generalising it is the expensive route, and the wrong shape: a
    math body needs no scratch type, no literals and no allocation.
  - The remainder helper `__fmod`: a `runtime-callable` provider with a canonical declaration
    (`src/ir/runtime/number-remainder-callables.ts`), one physical resource (`planNumberRemainders` in
    `src/ir/program-physical-plan.ts`), reserve and fill in `src/ir/program-consumer.ts`
    (`buildNumberRemainderBody`), and one join in `src/compiler/prepared-provider-census.ts`. 11 files mention it. It
    is exactly a pure `(f64, f64) -> f64` leaf with no carrier. **This is the mechanism to generalise**: a "pure f64
    leaf callable" resource whose body is either the hand-built remainder body or a lowered math IR body.
- The refusal #7564 saw (`intrinsic math.<m> needs callable provider materialization`) is
  `missingIntrinsicMaterialization` in `src/ir/program-physical-plan.ts`: a `self-hosted` provider has no reserved
  physical owner on that path.

### 5. Primitives

fdlibm reads and writes the high and low 32-bit words of a double. What the dialect offers today, measured:

- **No word access.** The IR has the unary ops `i64.reinterpret_f64` / `f64.reinterpret_i64`, but the source dialect
  cannot spell them.
- **Bitwise operators work but are costly.** A probe body using `& << >> ^ >>> |` on `number` locals compiled and
  agreed with JavaScript on 20/20 inputs, at 1,163 extra bytes for six operators: each one converts through
  `ToInt32`.
- **Many word tests need no words.** `hx >= 0x40862E42` is `Math.abs(x) >= c` for an exact f64 constant `c`.
  Proof of approach: I wrote V8's `exp` in today's dialect with f64 comparisons and the existing exact
  square-and-multiply loop for 2^k, put it in place of `EXP_SOURCE`, and compiled through the real self-host
  pipeline (the file was restored afterwards):

  | `Math.exp(x)`, standalone | old body | V8's algorithm in the dialect |
  | --- | --- | --- |
  | agreement with node on 910 inputs | 475 | **910** (also 910 on `wasi`) |
  | binary size (a program without Math: 11,409 B) | 11,819 B | 12,178 B (+359 B) |
  | 2,000,000 calls | 63 ms | 72 ms |

- **What is missing to write the rest efficiently**:
  1. Word access: `log`, `pow`, `atan`, `cbrt`, `log1p`, `expm1` and argument reduction build or split doubles by
     words (`SET_LOW_WORD(t, 0)`, exponent extraction, `scalbn`). Three leaf helpers with an f64 ABI cover it:
     `__f64_hi(x)` (high word as a number), `__f64_lo(x)`, `__f64_from_words(hi, lo)`. Each is five to eight Wasm
     instructions (`i64.reinterpret_f64`, shift, wrap, convert), written once as a context-free body next to
     `src/wasm/physical/number-remainder.ts`. This is the pattern the number formatter already uses for its
     `__nfd_*` helpers. Integer logic on the words stays in f64 comparisons wherever possible, because of the
     bitwise-operator cost above.
  2. Small constant tables: `atanhi`/`atanlo` (4 entries), `bp`/`dp_h`/`dp_l` (2) become ternaries; the 66-entry
     2/π table of large-argument reduction becomes a function with a comparison ladder (estimate 0.7 to 1 KB).
  3. **Scratch storage and several results**: `__ieee754_rem_pio2` returns a quadrant and two doubles, and
     `__kernel_rem_pio2` (arguments above about 1.6e6) works on four arrays of up to 20 entries. The dialect has
     neither arrays nor multiple results in pure f64 functions. This is the one real gap. Slice 3 decides it.
- Size estimate for the whole library (not measured beyond `exp`): about 1,450 lines of dialect source across ten
  files; per member a program pays roughly 0.8 KB (`exp`, `log`), 2.5 to 3.5 KB (`pow`), 3 to 4 KB (`sin`/`cos`/`tan`
  with full reduction), against 0.25 to 1.7 KB today (measured today: exp +410 B, log +428, sin +248, tan +477, pow
  +1,705, atan2 +923 over the 11,409 B program).

## Implementation Plan

One issue per PR. #7566 is slice 1. **Eleven more ids are needed** (slices 2 to 12); reserve them with
`claim-issue.mjs --allocate` when each is filed.

### Target structure (all slices)

- **One implementation per function**, as dialect source, lowered from one memoized IR for WasmGC (standalone, WASI,
  JS environment), the IR Linear backend and the Prepared path.
- **Module layout** — `src/stdlib/math/`, one concern per file, no file over 300 lines:

  | File | Holds |
  | --- | --- |
  | `index.ts` | the registry (member → body descriptor with its callees) and the dependency closure |
  | `words.ts` | declarations of the word-access helpers (bodies in `src/wasm/physical/f64-words.ts`) |
  | `exp-log.ts` | `exp`, `log` |
  | `pow.ts` | `pow` |
  | `rem-pio2.ts` | argument reduction and the 2/π table function |
  | `trig-kernels.ts` | `__kernel_sin`, `__kernel_cos`, `__kernel_tan` |
  | `trig.ts` | `sin`, `cos`, `tan` |
  | `inverse-trig.ts` | `atan`, `atan2`, `asin`, `acos` |
  | `exp-log-es2015.ts` | `expm1`, `log1p`, `log2`, `log10`, `cbrt` |
  | `hyperbolic.ts` | `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh` |
  | `rounding.ts` | `round`, `sign` (moved unchanged) |
  | `hypot.ts` | `hypot` |

- **Emission order comes from the registry.** `emitInlineMathFunctions` walks each body's `callees` instead of the
  `needExp`/`needLog`/`needAtan`/`needSinCos` flags and the two-phase ordering, which are deleted.
- **Deleted as their slice lands**: every transcendental source in `src/stdlib/math.ts` (`EXP`, `LOG`, `LOG2`,
  `LOG10`, `POW`, `REDUCE_TRIG`, `SIN`, `COS`, `TAN`, `ATAN`, `ASIN`, `ACOS`, `ATAN2`, `CBRT`, `EXPM1`, `LOG1P`,
  `SINH`, `COSH`, `TANH`, `ASINH`, `ACOSH`, `ATANH`), the `math.reduce-trig` intrinsic and its provider, the inline
  `hypot`, `round` and `sign` copies in `compileMathCall`, and finally `src/stdlib/math.ts` itself.
- **One accuracy test, parameterised by member**: `tests/math-library.test.ts` generates the input set of Finding 2
  from its fixed seed, compiles one program per member for standalone, and requires `Object.is` agreement with the
  running node's `Math.<member>` on every input. A member joins the test's list in the slice that ports it. The
  expectation is computed live; nothing is stored.
- **Criteria every library slice shares**:
  - Correctness: `Object.is` agreement with node on the whole input set for each member of the slice, on standalone,
    and on one WASI and one `gc` program.
  - No regression: `built-ins/Math/**` and `language/expressions/exponentiation/**` on the ordinary standalone lane
    stay at 308/327 and 41/44 (baseline of 2026-11-27, `test262-standalone-current.jsonl`; all 22 non-passing rows
    are unrelated to accuracy: 10 `sumPrecise`, 8 constant `prop-desc`, 1 `f16round` compile error, 3 BigInt).
  - Cost, reported in the PR: binary size and time for 2,000,000 calls of a one-member program, before and after.
  - Byte identity: at least 20 programs that use no ported member compile byte-identical before and after on
    `standalone`, `wasi`, `gc` and `linear` (file-copy A/B).
  - Code quality: no body or helper exists twice; each helper (`__kernel_sin`, word access, reduction) is written
    once and called; no file over 300 lines; no `func-budget-allow` or `loc-budget-allow` grant; the old body is
    deleted in the same PR that replaces it.

### Slice 1 — #7566: library skeleton, word helpers, `exp`, `log` (M)

- Files: `src/stdlib/math/{index,words,exp-log,rounding}.ts` (new), `src/wasm/physical/f64-words.ts` (new),
  `src/codegen/math-helpers.ts` (registry-driven emission), `src/codegen/stdlib-selfhost.ts` (resolve the three word
  helpers as callees), `src/stdlib/math.ts` (shrinks), `tests/math-library.test.ts` (new),
  `THIRD_PARTY_NOTICES.md` (new) and `package.json` `files`, `scripts/compiler-boundaries.json` (inventory rows for
  the new files).
- Size: about 350 lines added, 60 removed. `exp` is the measured body of Finding 5 (37 lines); `log` about 60.
- Extra criterion: the members still on old formulas that call `Math_exp`/`Math_log` (`sinh`, `cosh`, `tanh`,
  `expm1`, `asinh`, `acosh`, `atanh`, `log1p`, `log10`, `pow`) change value because their core changed. Report their
  agreement counts before and after; none may get worse in "wrong kind".

### Slice 2 — `pow` and `**` (L, new id)

- Step 0, before any code: run the pair set of Finding 2 on the node versions CI uses and record how
  `Math.pow` there relates to V8's `legacy::pow` and to glibc's `pow`. The owner then picks the reference (open
  question 1). Plan of record if no answer: port V8's `legacy::pow` into `src/stdlib/math/pow.ts` (about 170
  lines), because it is the only reference that is the same on every platform, and keep `pow`/`**` refused on the
  Prepared path until the owner rules.
- If the owner picks node 24+ behaviour on Linux: the reference is the `pow` of Arm Optimized Routines (the code
  glibc and musl ship; MIT or Apache-2.0 with LLVM exception). It needs two tables (about 6 KB of data) and an
  exact fused multiply-add, neither of which the dialect has; that is a larger slice and gets re-planned.
- Criteria: the shared ones; plus the exactly representable integer powers of the 855-pair grid all exact; plus the
  agreement count against node 22 and against node 24/25 both stated in the PR.

### Slice 3 — `sin`, `cos`, `tan` (L, new id)

- Step 0, design gate for large arguments, decided by a spike measured against the compiled C reference on at
  least 1,000,000 arguments above 1.6e6:
  - (B, plan of record) a module scratch of f64 slots behind two f64-ABI helpers `__math_scratch_get(i)` /
    `__math_scratch_set(i, v)` (the `__nfd_*` pattern): a faithful port of `__kernel_rem_pio2`, and
    `__ieee754_rem_pio2` leaves its two result doubles in slots 0 and 1. Cost: one global and one array type on
    WasmGC, a static region on linear, and a matching resource on the Prepared path (slice 12).
  - (A) an array-free reformulation that recomputes the digits on demand, keeping every function a pure f64 leaf.
    No new resource anywhere, but it is a rewrite of the reference and harder to audit. Take it only if it stays
    under about 250 lines and agrees on the full spike set.
- Files: `src/stdlib/math/{rem-pio2,trig-kernels,trig}.ts`; the scratch helpers if (B).
- Size: about 430 lines of source.
- Criteria: the shared ones; `sin(1e22)`, `sin(1.7976931348623157e308)`, `cos(2^1023)` and the 200 random bit
  patterns agree (these are the inputs that are wrong by magnitude today).

### Slice 4 — `atan`, `atan2`, `asin`, `acos` (M, new id)

`src/stdlib/math/inverse-trig.ts`, about 230 lines. Shared criteria. This completes the ES5 members.

### Slice 5 — `expm1`, `log1p`, `log2`, `log10`, `cbrt` (M, new id)

`src/stdlib/math/exp-log-es2015.ts`, about 290 lines. Shared criteria.

### Slice 6 — `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh` (M, new id)

`src/stdlib/math/hyperbolic.ts`, about 190 lines; depends on slice 5 (`expm1`, `log1p`). Shared criteria. After this
slice `src/stdlib/math.ts` is empty and is deleted.

### Slice 7 — `hypot` (S, new id)

- Read `MathHypot` in V8's `math.tq` first (Finding 3 used a transcription from memory). One self-hosted body for
  two and three arguments in `src/stdlib/math/hypot.ts`, an entry in `IR_MATH_METHOD_TABLE`, and the inline code in
  `compileMathCall` removed. More than three arguments: state in the PR what serves them.
- Criteria: shared; 3-argument agreement goes from 581/600 to 600/600.

### Slice 8 — Prepared path: pure f64 leaf callables; admit the library (M, new id)

- Depends on slice 1 only. Later library slices then become available on the Prepared path without further work
  there, except the members that need the scratch (slice 12).
- Change: generalise the remainder resource into one "pure f64 leaf callable" resource. Modules:
  `src/ir/runtime/number-remainder-callables.ts` (declarations become one list: remainder plus the library
  registry), `src/ir/program-physical-plan.ts` (`planNumberRemainders` becomes the one planner),
  `src/ir/program-consumer.ts` (one reserve and one fill; the body is the remainder body or the lowered IR of a
  registry entry), `src/compiler/prepared-provider-census.ts` (one join), `src/ir/math-runtime-providers.ts`.
- Admission is structural: a `Math` member is admitted when its body comes from `src/stdlib/math/` (the registry).
  Members still in `src/stdlib/math.ts` stay refused by name. No per-member flag, no source hash.
- Criteria:
  - `round`, `sign`, `exp`, `log` (and every member ported by then) agree with node on the input set through the
    Prepared path, each with a wrong twin that fails.
  - Unported members, and `pow`/`**` until slice 2's ruling, are refused by name: never a wrong value, trap, invalid
    module or compile throw.
  - A Prepared program without Math, and one using only `%`, compile byte-identical before and after.
  - test262 on the Prepared path: `built-ins/Math/{exp,log,round}` rows before and after, measured in the PR (not
    measured for this plan: the Prepared ES5 run was out of reach on this machine).
  - Code quality (CLAUDE.md "IR path: code quality comes first"): remainder and Math share one declaration list,
    one planner, one fill and one join; no `Math`-specific twin of a remainder function; `src/ir/from-ast.ts` does
    not grow; adversarial review recorded in the PR.

### Slices 9 to 11 — the rest of the `Math` surface on the Prepared path (S each, three new ids)

- 9: variadic `Math.max`/`Math.min` (0, 1, 3+ arguments) in `IR_MATH_METHOD_TABLE` and the existing Math arm.
- 10: the eight constants and `Math` as a value (`typeof Math`, `Math.pow.length`, `prop-desc`). This is what the
  8 `prop-desc` rows and most `length`/`name` rows need.
- 11: `Math.random`. Its state is a module global, so it needs a global resource on the Prepared path.
- Criteria for each: agreement with node on at least 14 inputs or shapes with a wrong twin; refused shapes named;
  byte identity for programs that do not use the feature; the test262 rows of the affected directories before and
  after.

### Slice 12 — linear lane, and the scratch resource (M, new id)

- Lower the same registry bodies in the IR Linear backend and set `supportsSymbolicMathHelpers` to true there.
  `Math.sin(x)` on `--target linear` goes from a compile error to node's value.
- If slice 3 chose (B): the scratch as a static region on linear and as a resource on the Prepared path, after
  which `sin`/`cos`/`tan` are admitted there.
- Criteria: the accuracy test runs every ported member on `linear`; no second copy of any body.

### Order and value for ES5 test262

1 → 8 gives the Prepared path `exp`, `log`, `round`. 4 gives the inverse trig. 2 gives `pow`, which is the member
ES5 harness code uses (`Math.pow(2, 32) - 1` in `propertyHelper.js`; 105 test files call `Math.pow`); it waits on
open question 1. 3 and 12 give the trig. ES5 test files in the member directories: pow 28, atan2 11, round 11,
exp 9, log 9, cos 9, tan 9, asin 9, sin 8, acos 8, atan 7. ES2015: hypot 12, acosh 7, 5 each for the other ten.
On the ordinary standalone lane these rows already pass (the tests allow a tolerance), so the gain there is
correct values for programs, not rows.

## Risks

- **Baseline churn: none expected, and measured rather than assumed.** Ordinary standalone lane: 308/327 Math rows
  and 41/44 exponentiation rows pass, and no failing row is about accuracy. Rows that pass today pass by a
  tolerance, which a more accurate body also meets.
- **Equivalence tests.** `grep -rln "Math\.\(pow\|exp\|log\|sin\|cos\)" tests/equivalence` gives 7 files (6 tests and
  `helpers.ts`); the same count holds for all 21 transcendental members plus `**`. They compare against the
  running node (`assertEquivalent`: `toBe`, or `toBeCloseTo(…, 3)` with `approx: true`, used 20 times in one file).
  No test or script holds an old wrong value (searched for four of them). Exposure: a `toBe` on a non-exact `pow`
  result would depend on the node version once `pow` is fdlibm (Finding 3); the sampled ones use exact powers
  (`Math.pow(2, 10)`, `Math.pow(2, 53)`).
- **`pow` reference** (Finding 3): the chosen reference decides whether `5 ** -5` prints `0.00032` or
  `0.00031999999999999997`, and whether the Prepared path may admit `pow` at all.
- **Code size**: plus 0.4 KB (`exp`, measured) to an estimated 3 to 4 KB (trig with full reduction) per member used.
  Programs that use no member are unaffected (dependency-driven emission).
- **Speed**: `exp` measured 63 → 72 ms per 2,000,000 calls. The word helpers add calls unless the engine inlines
  them; measure per slice.
- **Dialect growth**: the scratch (slice 3, option B) is the first module-level state in a math body. It is confined
  to large-argument reduction.
- **Baselines under `scripts/`**: nothing pins Math behaviour. `scripts/ir-kind-neutrality-baseline.json` mentions
  the `math.*` intrinsic ids in prose only; `scripts/compiler-boundaries.json` is an inventory that needs a row per
  new source file (it is not a `*-baseline.json`). No baseline file is edited.
- **Licence**: see Finding 3 and open question 3.
- **Duplicate noticed, not in scope**: the linear backend carries its own copy of `__fmod`
  (`src/codegen-linear/runtime.ts`) beside `src/wasm/physical/number-remainder.ts`. File it separately.

## Open questions for the owner

1. **Which node defines `Math.pow`?** node 22 and earlier: V8's fdlibm port, the same on every platform. node 24 and
   25 (what CI runs): the platform's `pow`; on Linux that is glibc's, about 8 % different from fdlibm on small
   integer pairs and closer to exact rounding. Options: (a) V8's `legacy::pow`, platform-independent, and the
   Prepared path's rule for `pow` reads "agrees with V8's own algorithm"; (b) glibc's algorithm, matching CI but not
   node 22, macOS or Windows; (c) ship (a) on the ordinary lanes and keep `pow`/`**` refused on the Prepared path.
   The plan of record is (c) until answered. This needs one run on node 24/25 first, which I could not do.
2. **Large-argument trig storage** (slice 3): scratch helpers (B) or the array-free form (A)?
3. **Notices in compiled output.** The ported code is embedded in every user program that calls these members. Is
   a root `THIRD_PARTY_NOTICES.md` in the package enough, or must the compiler's output carry the Sun and V8
   notices (for example in a custom section)? The project's own licence has the LLVM exception for exactly this
   case; fdlibm's and V8's do not.
4. **Reference vectors.** If the answer to 1 is (a) while CI stays on node 24+, the `pow` test cannot take its
   expectation from the running node. Is a committed table of inputs and expected results from the compiled V8
   reference acceptable under #7380, or should the test run node with `--no-use-std-math-pow`?
5. **Linear lane priority** (slice 12): it has no transcendental `Math` today. Is that wanted now, or after the
   Prepared path reaches its ES5 milestone?
