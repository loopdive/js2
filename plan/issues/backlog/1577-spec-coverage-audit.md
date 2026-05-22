---
id: 1577
title: "ECMAScript spec vs test262 coverage audit"
created: 2026-05-21
type: research
status: research
---

# ECMAScript Spec vs Test262 Coverage Audit

## Summary

The js2wasm test262 baseline (2026-05-21) covers **48,142 tests** across 89
top-level categories (`tests/test262-runner.ts: TEST_CATEGORIES`), with
**29,587 pass (61.5%)**, 16,992 fail, 1,367 compile errors, 100 compile
timeouts and 96 skips. There are **no blanket skip filters** — every
ECMA-262 test262 directory walks through the compile/run pipeline, and the
only skips are file-level: `_FIXTURE.js` helpers, the `import-defer`
proposal subtree (no test harness) and a hand-curated `HANGING_TESTS` set
(currently empty after recent fixes). Proposals (Temporal, import-defer,
source-phase-imports) are surfaced as `scope:"proposal"` but **not
excluded** unless `TEST262_INCLUDE_PROPOSALS!=1`.

The biggest absolute gaps are concentrated in five clusters:
**(1)** spec §27 *Control Abstraction* / Temporal (≈22% pass, ~3,300 fails
— proposal, intentionally not implemented), **(2)** spec §10 *Object
defineProperty/defineProperties/create* (~43-48% pass, ~1,100 fails —
property-descriptor semantics), **(3)** spec §15 *Classes* (~70% pass but
**~2,300 fails** simply due to the size of `language/{expressions,statements}/class`),
**(4)** spec §28 *Reflection* / Proxy (21.5% pass — entire `ownKeys`,
`get`, `setPrototypeOf` subtrees at 0%), and **(5)** spec §23 *Array.prototype*
(46.5% pass on 2,810 tests — biggest single non-Temporal cluster).
Conversely, lexical grammar (§12), arithmetic/relational expressions (§13
sub-ops), Math (§21.3), Number (§21.1), Map/Set (§24) and TypedArray
(§23.2) all run at **>80%** with little headroom.

The **unit test suite** (`tests/*.test.ts`) has 784 files but its coverage
is highly skewed toward issue-driven regression tests (≥230 `issue-*.test.ts`
files) and codegen plumbing (i32 fast mode, ref-cast peephole, struct
layout). Whole spec sections have **zero dedicated unit tests**: §17 Error
hierarchy, §21.4 Date (only a single `date-native.test.ts`), §22.2 RegExp
beyond compile (only one `regexp.test.ts`), §25 JSON (one `json-*` test),
§24 Map/Set (one `map-set*` test), §26 WeakRef/FinalizationRegistry (one
test), §28 Reflect (no test), and §27 AsyncIterator / Iterator helpers
(no test). Most spec-driven correctness is currently validated *only*
through test262, so any regression in those areas is invisible until the
nightly conformance run.

The five **highest-leverage unit-test gaps** for diagnostic confidence
are: Object property descriptors (§10), Proxy traps (§28.2),
Iterator helpers (§27.1.2), the Error subclass hierarchy + cause chain
(§17/§20.5), and Array.prototype mutators (§23.1.3) — each currently has
hundreds of test262 fails with no isolated local repro.

---

## Test runner configuration (tests/test262-runner.ts)

### TEST_CATEGORIES (the 89 directories walked)

**Language (28 dirs)**: `arguments-object`, `asi`, `block-scope`, `comments`,
`computed-property-names`, `destructuring`, `directive-prologue`,
`eval-code`, `export`, `expressions`, `function-code`,
`future-reserved-words`, `global-code`, `identifier-resolution`,
`identifiers`, `import`, `keywords`, `line-terminators`, `literals`,
`module-code`, `punctuators`, `reserved-words`, `rest-parameters`,
`source-text`, `statementList`, `statements`, `types`, `white-space`.

**Built-ins (59 dirs)**: `AbstractModuleSource`, `AggregateError`, `Array`,
`ArrayBuffer`, `ArrayIteratorPrototype`, `AsyncDisposableStack`,
`AsyncFromSyncIteratorPrototype`, `AsyncFunction`, `AsyncGeneratorFunction`,
`AsyncGeneratorPrototype`, `AsyncIteratorPrototype`, `Atomics`, `BigInt`,
`Boolean`, `DataView`, `Date`, `DisposableStack`, `Error`,
`FinalizationRegistry`, `Function`, `GeneratorFunction`,
`GeneratorPrototype`, `Infinity`, `Iterator`, `JSON`, `Map`,
`MapIteratorPrototype`, `Math`, `NaN`, `NativeErrors`, `Number`, `Object`,
`Promise`, `Proxy`, `Reflect`, `RegExp`, `RegExpStringIteratorPrototype`,
`Set`, `SetIteratorPrototype`, `ShadowRealm`, `SharedArrayBuffer`,
`String`, `StringIteratorPrototype`, `SuppressedError`, `Symbol`,
`Temporal`, `ThrowTypeError`, `TypedArray`, `TypedArrayConstructors`,
`Uint8Array`, `WeakMap`, `WeakRef`, `WeakSet`, `decodeURI`,
`decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `eval`, `global`,
`isFinite`, `isNaN`, `parseFloat`, `parseInt`, `undefined`.

**Annex B (2 dirs)**: `annexB/built-ins`, `annexB/language`.

### Skip filters

Per `shouldSkip()` in `tests/test262-runner.ts:306-360`:

| Filter | Rationale | Permanent? |
|---|---|---|
| `*_FIXTURE.js` files | helper modules without standalone `test()` export | permanent (defense-in-depth) |
| `language/import/import-defer/` subtree | proposal feature with no test harness — was 31 false `compile_error: no test export` | permanent (proposal) |
| `HANGING_TESTS` set (currently **empty**) | per-test compile-time infinite loops | per-bug, removed once fixed |
| `scope === "proposal"` (unless `TEST262_INCLUDE_PROPOSALS=1`) | Temporal, import-defer, source-phase-imports | scope-gated, default off in CI |

**All historic blanket skip filters (eval/with/Proxy/Symbol/etc.) were
removed in #494.** Tests that we don't implement surface as
`compile_error` / `fail` in the conformance dashboard rather than being
hidden as skips. This is the source of the high `compile_error` counts in
`language/statements/with` (157 CEs — strict mode rejects `with`) and
`language/expressions/dynamic-import` (200 CEs).

### Path filter (#1521)

`TEST262_PATH_FILTER` env var (pipe-separated substrings) narrows the
test set per PR based on the changed `src/` paths (Test262 Differential
workflow). Applied **before** wrap+compile+cache lookup, so it bypasses
cache hits too — that's where the wall-clock savings come from.

### Status taxonomy

Each JSONL entry has `status ∈ {pass, fail, compile_error, compile_timeout,
skip}` and `error_category ∈ {assertion_fail (9,194), other (4,684),
runtime_error (1,607), wasm_compile (1,162), type_error (599), null_deref
(571), illegal_cast (241), negative_test_fail (157), range_error (51),
promise_error (40), oob (36), unreachable (17), none (100)}`.

Scope distribution (48,142 total):

| Scope | pass | fail | CE | timeout | skip |
|---|---|---|---|---|---|
| standard | 27,654 | 13,164 | 1,170 | 86 | 0 |
| annex_b | 571 | 490 | 20 | 5 | 0 |
| proposal | 1,362 | 3,338 | 177 | 9 | 96 |

---

## Coverage by spec section

ECMA-262 chapters mapped to test262 paths and live pass-rates. **CE** =
compile_error. Pct = pass / total. Sections sorted in spec order.

### §6 ECMAScript Data Types & Values

Tested via abstract operations across many directories — no single test262
prefix. The relevant runtime semantics are covered by:

| test262 dir | pass / total | Notes |
|---|---|---|
| `language/types` | 87 / 113 (77%) | type conversion / `typeof` |
| `built-ins/Number` | 310 / 338 (91.7%) | §6.1.6.1 Number type |
| `built-ins/BigInt` | 30 / 77 (39.0%) | §6.1.6.2 BigInt (low — see below) |
| `built-ins/String` | 795 / 1,223 (65.0%) | §6.1.4 String type |
| `built-ins/Symbol` | 52 / 98 (53.1%) | §6.1.5 Symbol |
| `built-ins/Boolean` | 36 / 51 (70.6%) | §6.1.3 Boolean |
| `built-ins/NaN`, `Infinity`, `undefined` | 19 / 20 (95.0%) | §6.1.6.1.x globals |

### §7 Abstract Operations

Diffuse — exercised across all expression / built-in tests. The §7.1
type-conversion ops are tested intensively via:

| test262 dir | pass / total | Notes |
|---|---|---|
| `built-ins/parseInt` | 52 / 55 (94.5%) | §7.1.4.1.1 |
| `built-ins/parseFloat` | 50 / 54 (92.6%) | §7.1.4.2.1 |
| `built-ins/isFinite`, `isNaN` | 15 / 30 (50.0%) | §7.2.7, §7.2.3 |
| `language/types` | 87 / 113 (77.0%) | ToNumber/ToString edge cases |

### §10 Ordinary and Exotic Objects Behaviors

The **biggest absolute gap cluster** outside Temporal. Property-descriptor
operations dominate:

| test262 path | pass / total | fail | CE | Notes |
|---|---|---|---|---|
| `built-ins/Object/defineProperty` | 497 / 1,131 (43.9%) | 623 | 5 | property descriptor semantics |
| `built-ins/Object/defineProperties` | 301 / 632 (47.6%) | 328 | 1 | bulk define |
| `built-ins/Object/create` | 169 / 320 (52.8%) | 146 | 5 | prototype + descriptor map |
| `built-ins/Object` (overall) | 1,913 / 3,411 (56.1%) | 1,469 | 16 | §19.1 + §10 |
| `built-ins/Proxy` | 67 / 311 (21.5%) | 232 | 11 | §10.5 Proxy exotic — see §28 |

### §11 ECMAScript Language: Source Code

| test262 path | pass / total | Notes |
|---|---|---|
| `language/source-text` | 1 / 1 (100%) | trivial — one test |
| `language/global-code` | 19 / 42 (45.2%) | global decl ordering |
| `language/directive-prologue` | 35 / 62 (56.5%) | "use strict" placement |

### §12 ECMAScript Language: Lexical Grammar

Strong coverage across the board:

| test262 path | pass / total | Notes |
|---|---|---|
| `language/literals` | 525 / 534 (98.3%) | numeric/string/regex literals |
| `language/identifiers` | 252 / 268 (94.0%) | 16 CEs (Unicode names) |
| `language/keywords` | 25 / 25 (100%) | |
| `language/reserved-words` | 24 / 27 (88.9%) | |
| `language/future-reserved-words` | 54 / 55 (98.2%) | |
| `language/punctuators` | 11 / 11 (100%) | |
| `language/line-terminators` | 33 / 41 (80.5%) | 8 CEs (line-cont edge cases) |
| `language/white-space` | 67 / 67 (100%) | |
| `language/comments` | 43 / 52 (82.7%) | 6 CEs (`<!--` HTML-like) |
| `language/asi` | 99 / 102 (97.1%) | automatic semicolon insertion |

### §13 ECMAScript Language: Expressions

Total: **language/expressions = 7,532 / 11,036 (68.2%)**, 477 CEs.

Top fail clusters:

| Sub-path | pass / total | Notes |
|---|---|---|
| `expressions/class` | 2,926 / 4,059 (72.1%) — 1,077 fail | §15 actually, biggest dir |
| `expressions/object` | 765 / 1,170 (65.4%) — 371 fail | object literals incl. accessors |
| `expressions/dynamic-import` | 563 / 939 (60.0%) — 176 fail, **200 CE** | §13.3.10 — unsupported parse paths |
| `expressions/async-generator` | 464 / 623 (74.5%) | §15.6 |
| `expressions/assignment` | 280 / 485 (57.7%) — 197 fail | destructuring assignment, accessors |
| `expressions/arrow-function` | 238 / 343 (69.4%) | |
| `expressions/compound-assignment` | 308 / 454 (67.8%) — 55 CE | |
| `expressions/super` | 5 / 94 (5.3%) — **71 fail, 18 CE** | §13.3.7 — almost entirely failing |
| `expressions/array` | 5 / 52 (9.6%) — 46 fail | §13.2.4 array literals incl. spread |
| `expressions/call` | 31 / 92 (33.7%) | §13.3.8 call expr edge cases |
| `expressions/tagged-template` | 2 / 27 (7.4%) | §13.3.11 |
| `expressions/yield` | 18 / 63 (28.6%) | §15.5.5 |
| `expressions/new` | 16 / 59 (27.1%) — 23 CE | §13.3.5 |

Arithmetic / relational / bitwise sub-expressions all 75-95%. The chronic
gaps are in **structured expressions** (super, super property access,
tagged templates, dynamic-import) not in arithmetic.

### §14 ECMAScript Language: Statements and Declarations

Total: **language/statements = 6,156 / 9,337 (65.9%)**, 325 CEs.

| Sub-path | pass / total | Notes |
|---|---|---|
| `statements/class` | 3,072 / 4,367 (70.3%) — 1,214 fail | §15 — biggest sub |
| `statements/for-await-of` | 831 / 1,234 (67.3%) | §14.7.5.5 async iteration |
| `statements/for-of` | 366 / 751 (48.7%) — **380 fail** | §14.7.5 iterator protocol |
| `statements/function` | 281 / 451 (62.3%) — 23 CE | §15.2 |
| `statements/for` | 231 / 385 (60.0%) | §14.7.4 |
| `statements/generators` | 175 / 266 (65.8%) | §15.5 |
| `statements/with` | 16 / 181 (8.8%) — **157 CE** | strict-mode `with` rejected at parse — known wont-fix |
| `statements/try` | 108 / 201 (53.7%) | §14.15 catch/finally |
| `statements/let`, `const`, `variable` | 292 / 459 (63.6%) | §14.3 declarations |
| `statements/await-using` | 50 / 94 (53.2%) | §14.3.x using declarations (Explicit Resource Mgmt) |
| `statements/break`, `continue`, `throw`, `if`, `block`, `switch`, `while`, `do-while` | 397 / 459 (86.5%) | mostly clean |

### §15 ECMAScript Language: Functions and Classes

Class tests dominate. Sum across `language/{expressions,statements}/class`
= **5,998 / 8,426 (71.2%) — 2,291 fail, 137 CE**.

| Sub-path | pass / total | Notes |
|---|---|---|
| `language/function-code` | 150 / 217 (69.1%) | hoisting, arguments |
| `language/arguments-object` | 79 / 263 (30.0%) — **183 fail** | unmapped vs mapped, strict-mode behaviour |
| `language/rest-parameters` | 3 / 11 (27.3%) — 4 CE | tiny dir, mostly broken |
| `built-ins/Function` | 211 / 509 (41.5%) — 288 fail | §20.2 Function prototype |
| `language/expressions/function` | 174 / 264 (65.9%) | function expressions |
| `language/expressions/generators` | 182 / 290 (62.8%) | |

### §16 ECMAScript Language: Scripts and Modules

| test262 path | pass / total | Notes |
|---|---|---|
| `language/module-code` | 360 / 646 (55.7%) — 61 CE | import/export wiring |
| `language/import` | 2 / 117 (1.7%) — **96 skip** | import-defer subtree skipped entirely |
| `language/export` | 3 / 3 (100%) | tiny dir |
| `language/eval-code` | 242 / 347 (69.7%) | direct + indirect eval (re-enabled #1073) |
| `built-ins/eval` | 7 / 10 (70.0%) | |

### §17 Error Handling

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Error` | 36 / 58 (62.1%) | §20.5.1 Error |
| `built-ins/NativeErrors` | 74 / 94 (78.7%) | TypeError, RangeError, etc. |
| `built-ins/AggregateError` | 4 / 25 (16.0%) | §20.5.7 — mostly missing |
| `built-ins/SuppressedError` | 6 / 22 (27.3%) | §20.5.8 Explicit Resource Mgmt |
| `built-ins/ThrowTypeError` | 4 / 14 (28.6%) | §10.2.4 |
| `language/statements/throw` | 14 / 14 (100%) | |

### §19 The Global Object

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/global` | 19 / 29 (65.5%) | §19 globalThis & friends |
| `built-ins/parseInt`, `parseFloat`, `isFinite`, `isNaN` | 124 / 154 (80.5%) | |
| `built-ins/decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent` | 122 / 173 (70.5%) | |
| `built-ins/undefined` | 7 / 8 (87.5%) | |

### §20 Fundamental Objects

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Object` | 1,913 / 3,411 (56.1%) — 1,469 fail | §20.1 — see §10 above |
| `built-ins/Function` | 211 / 509 (41.5%) — 288 fail | §20.2 — `bind`, `call`, `apply`, length/name |
| `built-ins/Boolean` | 36 / 51 (70.6%) | §20.3 |
| `built-ins/Symbol` | 52 / 98 (53.1%) | §20.4 |
| `built-ins/Error` etc. | (see §17) | §20.5 |

### §21 Numbers and Dates

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Number` | 310 / 338 (91.7%) | §21.1 — strong |
| `built-ins/Math` | 313 / 327 (95.7%) | §21.3 — strong |
| `built-ins/BigInt` | 30 / 77 (39.0%) | §21.2 — gap |
| `built-ins/Date` | 412 / 594 (69.4%) — 181 fail | §21.4 |
| `built-ins/Date/prototype` (sub) | 362 / 485 (74.6%) | parser & locale-sensitive members weakest |

### §22 Text Processing

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/String` | 795 / 1,223 (65.0%) — 399 fail | §22.1 — gap mostly in `String/prototype` (700/1,073, 65.2%) |
| `built-ins/RegExp` | 1,549 / 1,879 (82.4%) | §22.2 — strong overall; `prototype` 251/487 (51.5%) is the soft spot |
| `built-ins/RegExpStringIteratorPrototype/next` | 0 / 15 (0%) | §22.2.7.x — entirely missing |
| `built-ins/StringIteratorPrototype` | 5 / 7 (71.4%) | §22.1.5 |

### §23 Indexed Collections

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Array` | 1,430 / 3,081 (46.4%) — 1,443 fail, 190 CE | §23.1 |
| `built-ins/Array/prototype` (sub) | 1,308 / 2,810 (46.5%) — 1,299 fail, 185 CE | mutators + iteration methods |
| `built-ins/ArrayIteratorPrototype` | 17 / 27 (63.0%) | §23.1.5 |
| `built-ins/TypedArray` | 1,229 / 1,438 (85.5%) | §23.2 — strong |
| `built-ins/TypedArrayConstructors` | 598 / 736 (81.2%) | |
| `built-ins/Uint8Array` | 32 / 68 (47.1%) | §23.2.x — newer Uint8Array methods |

### §24 Keyed Collections

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Map` | 166 / 204 (81.4%) | §24.1 |
| `built-ins/Set` | 286 / 383 (74.7%) | §24.2 |
| `built-ins/WeakMap` | 109 / 141 (77.3%) | §24.3 |
| `built-ins/WeakSet` | 76 / 85 (89.4%) | §24.4 |
| `built-ins/MapIteratorPrototype`, `SetIteratorPrototype` | 22 / 22 (100%) | |

### §25 Structured Data

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/JSON` | 87 / 165 (52.7%) | §25.5 |
| `built-ins/ArrayBuffer` | 91 / 196 (46.4%) | §25.1 |
| `built-ins/DataView` | 409 / 561 (72.9%) | §25.3 |
| `built-ins/SharedArrayBuffer` | 34 / 104 (32.7%) — 41 CE | §25.2 — partially wont-fix |
| `built-ins/Atomics` | 123 / 382 (32.2%) — 236 fail, 23 CE | §25.4 / §29 |

### §26 Managing Memory

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/WeakRef` | 18 / 29 (62.1%) | §26.1 |
| `built-ins/FinalizationRegistry` | 18 / 47 (38.3%) — 14 CE | §26.2 — gap |

### §27 Control Abstraction Objects

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Iterator` | 221 / 510 (43.3%) | §27.1 Iterator helpers (`map`, `filter`, etc.) |
| `built-ins/Iterator/prototype` (sub) | 194 / 373 (52.0%) — 178 fail | §27.1.4 helper methods |
| `built-ins/AsyncIteratorPrototype` | 1 / 13 (7.7%) | §27.1.5 — almost entirely missing |
| `built-ins/AsyncFromSyncIteratorPrototype` | 24 / 38 (63.2%) | |
| `built-ins/Promise` | 468 / 652 (71.8%) — 29 CE | §27.2 |
| `built-ins/GeneratorFunction` | 6 / 23 (26.1%) | §27.3 |
| `built-ins/GeneratorPrototype` | 9 / 61 (14.8%) — 52 fail | §27.5 |
| `built-ins/AsyncFunction` | 6 / 18 (33.3%) | §27.7 |
| `built-ins/AsyncGeneratorFunction` | 6 / 23 (26.1%) | §27.6 |
| `built-ins/AsyncGeneratorPrototype` | 29 / 48 (60.4%) | |
| `built-ins/DisposableStack` | 47 / 91 (51.6%) | Explicit Resource Mgmt |
| `built-ins/AsyncDisposableStack` | 22 / 52 (42.3%) | |
| `built-ins/Temporal` | 1,221 / 4,524 (27.0%) — **3,269 fail** | proposal — intentionally unimpl. |

### §28 Reflection

| test262 path | pass / total | Notes |
|---|---|---|
| `built-ins/Reflect` | 70 / 153 (45.8%) | §28.1 |
| `built-ins/Proxy` | 67 / 311 (21.5%) — 232 fail, 11 CE | §28.2 |
| `built-ins/Proxy/ownKeys` | 0 / 27 (0%) | trap entirely missing |
| `built-ins/Proxy/get` | 0 / 19 (0%) | trap entirely missing |
| `built-ins/Proxy/setPrototypeOf` | 0 / 17 (0%) | trap entirely missing |
| `built-ins/ShadowRealm` | 3 / 64 (4.7%) | §28.3 — unimpl. |
| `built-ins/AbstractModuleSource` | 0 / 8 (0%) | source-phase-imports proposal |

### §29 Memory Model

Folded into `built-ins/Atomics` and `built-ins/SharedArrayBuffer` — see §25.

### AnnexB (legacy browser behaviors)

| test262 path | pass / total | Notes |
|---|---|---|
| `annexB/built-ins` | 158 / 241 (65.6%) | B.2 additional built-ins |
| `annexB/language` | 413 / 845 (48.9%) — 410 fail | B.1 + B.3 sloppy-mode features |
| `annexB/language/eval-code` (sub) | 284 / 469 (60.6%) — 183 fail | direct-eval harness wiring (#1073) |

---

## Completely skipped areas (skip filters)

| Path / scope | Reason | Permanent? | Status |
|---|---|---|---|
| `*_FIXTURE.js` (file-level) | helper modules without `test()` export | yes | bookkeeping |
| `language/import/import-defer/*` (96 tests) | proposal feature, no test harness | yes (unless proposal lands in ECMA-262) | skipped |
| `scope: proposal` tests (4,701 entries — mostly Temporal) | default-off via `TEST262_INCLUDE_PROPOSALS` | until each proposal is in-scope | shown as fail/CE when included |
| `HANGING_TESTS` | per-test compile-time loops | no — clears as compiler bugs are fixed | currently empty |

There are **no blanket directory skips**. Every spec area runs through
the compile/run pipeline; tests we cannot compile or evaluate appear as
`compile_error` or `fail` rather than `skip` (#494). This is the right
default for a coverage dashboard but means CE/fail counts include both
"we know we don't implement this" and "we should fix this".

---

## Spec areas with 0% pass rate

(Categories with ≥5 tests, sorted by total)

| Path | total | fail | CE | Spec | Why |
|---|---|---|---|---|---|
| `language/import/import-defer` | 96 | 0 | 0 | §16 proposal | all skipped |
| `built-ins/Proxy/ownKeys` | 27 | 27 | 0 | §28.2 | trap unimpl. |
| `built-ins/Proxy/get` | 19 | 19 | 0 | §28.2 | trap unimpl. |
| `language/module-code/ambiguous-export-bindings` | 18 | 14 | 4 | §16 | module export resolution |
| `built-ins/Proxy/setPrototypeOf` | 17 | 17 | 0 | §28.2 | trap unimpl. |
| `built-ins/RegExpStringIteratorPrototype/next` | 15 | 15 | 0 | §22.2.7 | iterator unimpl. |
| `language/computed-property-names/object` | 12 | 12 | 0 | §13.2.5 | computed-key edge cases |
| `annexB/language/comments` | 8 | 0 | 8 | AnnexB | HTML-like comment markers (CEs) |
| `built-ins/ShadowRealm/WrappedFunction` | 5 | 5 | 0 | §28.3 | ShadowRealm unimpl. |
| `language/import/import-bytes` | 5 | 5 | 0 | §16 proposal | bytes-import proposal |
| `language/arguments-object/unmapped` | 5 | 4 | 1 | §10.4.4 | unmapped arguments (strict mode) |

---

## Unit test coverage (tests/*.test.ts)

**Total**: 784 `.test.ts` files (excluding fixtures/equivalence subdirs).
~30% are `issue-*.test.ts` regression tests pinned to specific bugs; the
remainder are organized by feature area. The catalog of distinct themes
(379 after stripping issue numbers) is in `/tmp/unit-test-themes.txt`.

### Strong unit test coverage

The following spec areas have **≥3 dedicated test files** with topical
coverage:

| Spec area | Representative test files |
|---|---|
| Arrays / array methods | `array-methods.test.ts`, `array-prototype-methods.test.ts`, `fast-arrays.test.ts`, `native-arrays.test.ts`, `sparse-array-spread.test.ts`, `new-array.test.ts`, `flatmap-closure.test.ts`, ~12 more |
| Classes (§15) | `classes.test.ts`, `class-methods.test.ts`, `class-expressions.test.ts`, `class-static-private-this.test.ts`, `abstract-classes.test.ts`, `inheritance.test.ts`, `class-method-calls.test.ts`, ~6 more |
| Destructuring | `basic-destructuring.test.ts`, `array-rest-destructuring.test.ts`, `class-dstr-rest-in-rest.test.ts`, `destructuring-member-targets.test.ts`, `null-destructuring.test.ts`, `for-of-array-destructuring.test.ts` |
| Async / generators | `async-await.test.ts`, `async-function.test.ts`, `for-await-of.test.ts`, `generators.test.ts`, `generator-*.test.ts` (~10 files) |
| Property descriptors / accessors | `object-define-property.test.ts`, `object-define-property-accessors.test.ts`, `define-property-patterns.test.ts`, `object-literal-getters-setters.test.ts`, `accessor-side-effects.test.ts`, `getters-setters.test.ts` |
| BigInt | `bigint.test.ts`, `bigint-ops.test.ts`, `bigint-cross-type.test.ts`, `bigint-externref.test.ts`, `bigint-string-coercion.test.ts` |
| String | `strings.test.ts`, `string-methods.test.ts`, `string-split.test.ts`, `string-arithmetic-coercion.test.ts`, `string-coercion.test.ts`, `string-relational-operators.test.ts` |
| Try/catch/finally | `try-catch.test.ts`, `try-catch-throw.test.ts`, `finally-block.test.ts`, `finally-duplicate.test.ts`, `error-reporting-catchpaths.test.ts` |
| Optional chaining | `optional-chaining-call.test.ts`, `optional-direct-closure-call.test.ts` |
| Template literals / tagged templates | `template-literal-type-coercion.test.ts`, `iife-tagged-templates.test.ts` |
| Spread / rest | `spread-rest.test.ts`, `spread-in-new-expressions.test.ts`, `rest-params-call.test.ts`, `fn-param-dstr-rest-in-rest.test.ts` |
| Closures / scope | `tdz-reference-error.test.ts`, `scope-and-error-handling.test.ts`, `closed-imports.test.ts`, `var-hoisting.test.ts`, `var-hoisting-scope.test.ts` |
| Numeric / arithmetic | `binary.test.ts`, `bitwise.test.ts`, `math-pow-coercion.test.ts`, `math-inline.test.ts`, `math-minmax.test.ts`, `modulus-special-values.test.ts`, `negative-zero-modulus.test.ts`, `comparison-coercion.test.ts` |

### Weak / missing unit test coverage

These spec areas have **0 or 1** dedicated unit test files, despite
substantial test262 fail counts:

| Spec section | test262 fails | Unit tests | Comment |
|---|---|---|---|
| §10 Property descriptors (`Object.defineProperty/Properties`) | 951 | 4 files — covers basic patterns only, missing accessor-with-error / `[[Configurable]]` / `[[Enumerable]]` flag combinations | high-leverage gap |
| §28.2 Proxy traps | 232 fail (Proxy total) | **1 file** (`proxy-passthrough.test.ts`) | trap-by-trap testing missing |
| §28.1 Reflect | 81 fail | **0 dedicated files** | only indirect coverage |
| §27.1 Iterator helpers (`Iterator.prototype.map/filter/take/drop/...`) | 178 fail | **0 dedicated files** | new ES2025 surface |
| §27.1.5 AsyncIterator | 12 fail | **0 dedicated files** | new ES2025 surface |
| §22.2 RegExp prototype | 230+ fail | **1 file** (`regexp.test.ts`) | sticky/Unicode/named-groups largely test262-only |
| §17 Error subclasses + cause chain | 22 fail (NativeErrors) | **0 dedicated files** | only error_reporting infra tests |
| §21.4 Date parser & setters | 181 fail | **2 files** (`date-native`, `issue-1343-date-setters`) | parser locales largely test262-only |
| §25.5 JSON | 73 fail | **2 files** (`json.test.ts`, `json-parser-test.test.ts`) | numbers + escapes |
| §26.2 FinalizationRegistry | 15 fail + 14 CE | **1 file** (`weakmap-weakset-weakref.test.ts`) | finalizer-callback timing untested |
| §24 Map/Set advanced (iteration mutation, key normalization) | 120+ fail | **2 files** (`map-set.test.ts`, `map-set-basic.test.ts`) | tested mostly via test262 |
| §22.1 String/Symbol.iterator | 60+ fail across String/StringIteratorPrototype | **0 dedicated files** | indirect |
| §23.2.x Uint8Array `.toBase64`, `.fromHex` etc. (ES2025) | 36 fail | **0 dedicated files** | new surface |
| §15.6 super in class methods (§13 `expressions/super`) | 71 fail / 5.3% pass | **2 files** (`super-element-access`, `super-property-access`) | very low pass rate, weak local coverage |
| §13.3.11 Tagged templates | 24 fail / 7.4% pass | **1 file** (`iife-tagged-templates.test.ts`) | minimal |
| §13.2.4 Array literals + spread | 46 fail / 9.6% pass | **2 files** (`spread-rest`, `sparse-array-spread`) | edge cases largely test262-only |
| §10.4.4 Mapped/unmapped Arguments | 183 fail / 30% pass | **3 files** (`arguments-object.test.ts`, `arguments-nested-and-loops.test.ts`, `issue-1053-arguments-global-staleness.test.ts`) | sloppy-vs-strict edge cases under-tested |

### Mapping table (test file → spec section)

A complete mapping is beyond the scope of this audit, but the key
issue-driven files cluster as follows:

| Theme | Issue files |
|---|---|
| Class/method/private/static descriptors | `issue-1364a-class-method-descriptors`, `class-elements-619`, `issue-private-access-brand`, `class-method-struct-new`, etc. |
| Yield/generator quirks | `issue-1017-yield-star`, `test262-runner-static-gen-yield`, `issue-862-func-decl-iter` |
| For-in / for-of | `issue-forin`, `for-of-*.test.ts` (5 files) |
| Hoisting / TDZ | `issue-1128-dstr-tdz`, `tdz-reference-error`, `var-hoisting*.test.ts` |
| TypedArray / BigInt cross-type | `issue-1056`, `issue-1064`, `issue-1283`, `issue-1325`, `issue-1455` |
| Number formatting / -0 | `issue-49-number-format-nonfinite`, `issue-1132-neg-zero` |

---

## Recommendations

### Top 5 spec sections for added unit-test coverage

Ranked by (test262 fail count) × (current local-test coverage gap) ×
(blast radius if we regress).

1. **Object property descriptors (§10 / §19.1)** — 951 test262 fails
   concentrated in `defineProperty`, `defineProperties`, `create`.
   Current unit tests cover basic cases but miss accessor-with-throwing-setter,
   non-configurable redefinition, and descriptor coercion (`toBoolean(d.enumerable)`).
   Add `object-define-property-edge.test.ts` with one assertion per
   spec table row in §10.1.6.3 (ValidateAndApplyPropertyDescriptor).

2. **Proxy traps (§28.2)** — 232 fails; ownKeys/get/setPrototypeOf entirely
   at 0%. We have only `proxy-passthrough.test.ts`. Add one test file per
   trap (`proxy-trap-get.test.ts`, `-set`, `-has`, `-ownKeys`,
   `-getOwnPropertyDescriptor`, `-defineProperty`, `-getPrototypeOf`,
   `-setPrototypeOf`, `-deleteProperty`, `-construct`, `-apply`) with the
   invariant table from §10.5.x as the test plan.

3. **Iterator helpers (§27.1.4)** — 178 fails on `Iterator.prototype`.
   No local coverage at all for `.map / .filter / .take / .drop / .flatMap /
   .reduce / .toArray / .forEach / .some / .every / .find`. Add
   `iterator-helpers.test.ts` — one section per helper × (sync, lazy,
   exhausted, throws-in-callback, return-from-iterator) matrix.

4. **Error hierarchy + cause chain (§17, §20.5)** — 22 NativeErrors fails,
   21 AggregateError fails, 16 SuppressedError fails. We have no
   dedicated Error-subclass test. Add `error-hierarchy.test.ts` covering
   constructor argument coercion, `cause` chaining, `AggregateError.errors`
   property, subclass `instanceof` after rethrow, and stack-trace shape
   for our wasm exception tag (the area where we recently regressed —
   exception-tag fix in MEMORY).

5. **Array.prototype mutators (§23.1.3)** — 1,299 test262 fails in
   `built-ins/Array/prototype` — the single largest non-Temporal cluster.
   Existing tests cover hot methods but miss `.splice` edge cases (sparse
   arrays, length-coerce throws), `.sort` (comparator throws, TypedArray
   stability), `.copyWithin`/`.fill` with proxies, and ES2023
   `.findLast`/`.findLastIndex`/`.toSorted`/`.toReversed`/`.toSpliced`/`.with`.
   Add `array-mutators-edge.test.ts` and `array-immutables-es2023.test.ts`.

### Secondary recommendations

- **Resolve `expressions/super` 5.3% pass rate** — 94-test cluster
  almost entirely failing. Likely a single root cause (HomeObject /
  `[[HomeObject]]` resolution). Worth a dedicated spike before more
  unit tests are written there.
- **Quantify the Temporal cost** — Temporal accounts for ~3,300 fails
  (~22% of all fails) and is intentionally unimpl. Consider gating the
  conformance % calc to exclude proposal scope by default so the headline
  number reflects standard-track conformance.
- **Watch `expressions/dynamic-import` 200 CE** — these are real
  compile-time failures, not "won't fix"; many would be unblocked by a
  parse-only path that defers actual import resolution.
- **The `built-ins/Array` 190 CE cluster** is suspicious — Array is core.
  An error-category breakdown of those specific CEs would identify whether
  they share a common signature (likely yes: looks like
  `wasm_compile` from a recent codegen path).
- **`with` statement 157 CE is correct behavior** (strict-mode rejection)
  but inflates `language/statements` CE count. Worth a per-category
  `expected_ce` annotation in the dashboard so it's not flagged as a gap.

### What this audit does **not** answer

- Per-test-file historical churn (which dirs flipped recently?)
- Which CEs would be unblocked by a single codegen fix (clustering by
  error message pattern, à la dev-self-merge regression-gate)
- Equivalence-test (`tests/equivalence.test.ts`) coverage — JS-vs-wasm
  parity, a different axis than spec coverage
- Differential / playground example coverage (`tests/differential/`)

These would each be their own audit, and `tests/equivalence.test.ts` in
particular probably deserves its own pass given how often we cite "the
170 equivalence tests" as the local regression net.
