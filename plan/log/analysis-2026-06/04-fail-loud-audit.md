# Fail-Loud Audit — Silent-Fallback Inventory & Ratchet Plan (2026-06-11)

> Scope: `src/codegen/` (101k LoC incl. `src/codegen-linear/`), driven by the
> June-2026 sweep corpus (issues #1950–#2084, ~135 issues). Goal: inventory
> every silent-fallback pattern class, classify the required loudness, and
> extend the existing #1376/#1530 ratchet machinery to cover them.

## Executive summary

Roughly **30 of the ~135 June-sweep wrong-answer bugs trace directly to seven
silent-fallback pattern classes** in codegen. The compiler already owns two
proven fail-loud mechanisms — the IR fallback budget (#1376/#1530:
`scripts/check-ir-fallbacks.ts` + `ir-fallback-baseline.json` +
`STRICT_IR_REASONS`) and the strict host-import allowlist (#1524/#1888:
`host-import-allowlist.ts` + `registry/imports.ts:34-46` + budget test). The
plan below clones that exact shape for codegen-internal fallbacks: a
`reportSilentFallback()` telemetry helper, a per-class baseline file, CI
growth gate, `--update-on-decrease` ratchet, and promotion to hard compile
error at zero.

Raw counts (src/codegen unless noted):

| Class | Marker | Hits |
|---|---|---|
| (a) `ref.null` value fallback | `ref.null` pushes / "fallback" comments | 827 raw / 446 fallback comments / ~30 curated unresolvable-value sites |
| (b) lookup-miss silent skip | `findIndex`/`indexOf` / `=== -1` skip guards | 92 lookups / 37 `-1` guards / 7 `fieldIdx === -1) continue` |
| (c) NaN / 0 / false "unresolvable" constants | "gracefully emit NaN" + instanceof-false + zero defaults | 11 NaN sites + 4 instanceof + 5 zero-default sites |
| (d) arity-bounded arg loops | `Math.min(expr.arguments.length, …)` | 18 (all in `expressions/calls.ts`) |
| (e) behavior-gating allowlist Sets | `new Set([...])` gating dispatch | ~40, ≥10 high-risk (incl. 2 duplicated pairs) |
| (f) hardcoded caps without diagnostics | `1_000_000` guards | 4 wrong-answer caps (2 loop guards, REGEX_STEP_CAP ×2 files) |
| (g) catch-and-continue in the compiler | bare `} catch {` | 83 in `src/codegen` + 28 in `src/codegen-linear` |
| (h) mode leaks (host import under standalone) | bypasses of the `addImport` strict gate | structural; 2 confirmed escapes (#2073/#2075) |

---

## 1. Existing fail-loud machinery (the patterns to EXTEND, not reinvent)

### 1.1 IR fallback budget — #1376 / #1530 (the ratchet template)
- `scripts/check-ir-fallbacks.ts` — compiles a fixed corpus
  (`website/playground/examples/**/*.ts`) with `trackFallbacks: true`,
  aggregates rejection reasons into `unintended` vs `deferred` buckets,
  fails CI on growth vs `scripts/ir-fallback-baseline.json`. Supports
  `--update`, `--update-on-decrease` (stages the lowered baseline; PR author
  commits), `--json`, `--verbose`.
- `src/codegen/index.ts:899` `STRICT_IR_REASONS` and `:907`
  `STRICT_IR_BUILD_ERRORS` — promotion points: once a bucket hits zero, the
  reason is added and any recurrence becomes a **hard compile error** instead
  of a silent legacy fallback (`formatIrPathFallbackDiagnostic`, index.ts:936).
- Current baseline: body-shape-rejected 31, call-graph-closure 7,
  class-method 6, param-type-not-resolvable 1, async-function 4 (deferred).

### 1.2 Strict host-import allowlist — #1524 / #1888 (the refuse-loudly template)
- `src/codegen/host-import-allowlist.ts` — every tolerated `env` import names
  its tracking issue; list growth requires `[allowlist-grow]` sign-off; a
  budget test (`tests/host-import-allowlist-budget.test.ts`) caps the size.
- `src/codegen/registry/imports.ts:34-46` — `addImport()` under
  `ctx.strictNoHostImports` pushes a **structured compile error** and refuses
  registration. This is the canonical refuse-loudly choke point.
- #2043 (late-import index-shift retirement) hardens the same seam.

### 1.3 A precedent conversion already shipped
- `src/codegen/expressions/identifiers.ts:782-806` — truly undeclared
  identifiers used to compile to a raw `throw ref.null.extern` ("null barks",
  #1380); now build a real `ReferenceError`. Proof that converting a silent
  null into a loud runtime error is tractable site-by-site.

---

## 2. Inventory by pattern class

Issue-coverage column: ✔ = a June issue covers this exact site; (class) = the
bug class is covered but this specific site is not.

### (a) `ref.null` pushed as an unresolvable-value fallback — "null barks"

827 `ref.null` pushes total; the overwhelming majority are **legitimate**
(JS `undefined`/`null` lowering, padded optional params, struct field inits,
two-phase placeholder protocols like `registry/error-types.ts:107/143` and
`async-scheduler.ts:1079` that are provably overwritten). The dangerous
subset is "couldn't resolve X → silently produce null and keep compiling":

| Site | Trigger | Symptom | Issue |
|---|---|---|---|
| `expressions/identifiers.ts:812-828` | identifier has a lib.d.ts symbol but no implementation ("known but unimplemented global") | type-appropriate default `0`/`0n`/`null` flows into program | (class — #2082 family) |
| `expressions/new-super.ts:1534` | `new C()` where class was never collected | null "instance"; later member reads null-deref or bark | (class) |
| `expressions/new-super.ts:2942` | constructor host import not registered | null instance | (class) |
| `property-access.ts:1664,1689,1958,1971,1996` | host import couldn't be registered / closure construction failed | property read yields null | (class — #2074/#2077 consumers) |
| `property-access.ts:1900` | static method referenced as a value | "non-callable placeholder" null — call site traps later | #2025/#2026 adjacent |
| `expressions/calls.ts:2060,2243,3327,4207,4418,8676,10698` | unknown function / unavailable host import — "compile args for side effects, push null" | call returns null instead of failing | (class — #2068, #2070) |
| `expressions/calls-closures.ts:749` | closure fallback `ref.null.extern; drop` | dropped call result | (class) |
| `literals.ts:470` | object-literal property value compiled to void | property silently becomes `undefined` | #2010 (file also hosts the literals.ts:242 computed-key `continue`) |
| `type-coercion.ts:1466,1480,1506,2793` | no coercion path f64/i32/i64→externref or non-castable ref | value replaced by null | (class — #2006 adjacent) |
| `stack-balance.ts:812` | stack-repair pass meets an unknown type | "safe default" null **inside the self-repair pass** — masks the producing bug twice | none — **gap** |
| `destructuring-params.ts:207` | un-coercible default | drop + null | (class) |
| `statements/nested-declarations.ts:407,624,1092` | unresolved nested-function reference | documented "graceful fallback" null | (class — #2068) |
| `index.ts:2137` | generic `fallback: Instr[] = [ref.null.extern]` | depends on caller | none — **gap** |
| `object-ops.ts:3064` | accessor arg can't be passed | drop arg, null | #2011 adjacent |

The implicit-derived-ctor case (#2082, `class-bodies.ts`) is the verified
shipped-bug instance of this class.

### (b) Lookup results used with silent-skip on miss

92 `findIndex`/`indexOf` calls; 37 `=== -1` guards that `continue`/`return`
without diagnostics. The lethal subset — destructuring/binding loops where a
miss means **the binding is simply never written** (local stays 0/null):

| Site | Trigger | Issue |
|---|---|---|
| `destructuring-params.ts:735` (`if (fieldIdx === -1) continue;`) | param destructuring key not in struct shape | #2032 (verified; the :760 sibling was routed to a slow path — :586 comment documents the hazard — but :735 still skips) |
| `closures.ts:532,576` | captured-field index miss | none — **gap** |
| `statements/loops.ts:1675` | for-of destructuring binding miss | none — **gap** |
| `expressions/assignment.ts:873,1878,1907` | destructuring-assignment binding miss (incl. computed keys; :871 also skips unresolvable property names) | (class — #2032) |

Related shipped bugs from wrong-index/collision variants: #2009 (same-shape
field collision), #1983 (funcMap name collision), #2020 (inherited statics
unreachable).

### (c) `i32.const 0` / `f64.const NaN` / `f64.const 0` as "unresolvable" results

Distinguished from legitimate undefined-lowering (e.g. the boxed-undefined
sNaN sentinel in `type-coercion.ts:2684` / `function-body.ts:829`, which is a
deliberate encoding, and `null instanceof X → false` at
`typeof-delete.ts:589/617`, which is spec-correct):

| Site | Trigger | Symptom | Issue |
|---|---|---|---|
| `expressions/unary-updates.ts:109,196,203,306,346,488,1209,1403` | unresolvable receiver/struct/field in `++`/`--` | "gracefully emit NaN" **and drop the write** — state mutation lost | #2019 (verified) |
| `expressions/assignment.ts:3445,3582,5212` | unknown field/type in compound assignment | NaN result, write dropped | (class — #2019) |
| `typeof-delete.ts:503,533,611` | instanceof RHS resolves to nothing / no tags found | hardcoded `false` | #1992 (verified) |
| `expressions/identifiers.ts:818-825` | unimplemented global in f64/i32/i64 context | `0` / `0n` | (class) |
| `expressions.ts:428-429` | generic fallbackType zeros | `0` | none — **gap** |

Sweep bugs in this class: #2019, #1992, #2023 (`new.target` constant 1),
#2027, #2030, #2033, #2053, #2078 (standalone derived-ctor base field zero).

### (d) Argument loops bounded by import/function arity

18 `Math.min(expr.arguments.length, paramCount)` loops, all in
`expressions/calls.ts` (lines 1690, 1965, 2706, 2784, 5871, 6451, 6532, 6594,
6678/6694, 6736/6753, 7754, 8488, 9038, 9095, 9727, 9783). Two sub-cases:

1. **JS-correct**: extra args to a fixed-arity *user* function are evaluated
   and dropped (e.g. :1965 evaluates excess for side effects) — matches JS
   semantics, legitimately silent *if* the arity is right.
2. **Wrong-arity import**: the host-import signature was registered with a
   fixed N for a **variadic or optional-arg builtin** — excess args are
   silently truncated. Verified shipped bugs: #1955 (`fromCharCode` drops
   extras), #2002 (`startsWith`/`endsWith`/`includes` drop the position arg),
   plus #1957, #1958 (split limit), #1969, #2069 (`call`/`apply` thisArg),
   #2076 (`Object.assign` drops sources).

The pattern itself can stay; the **registration of a fixed arity for a
variadic builtin** is what must become loud.

### (e) Allowlist Sets gating behavior (silent no-op on missing member)

~40 `new Set([...])` literals gate dispatch. High-risk (a missing member
silently routes to a no-op or the unknown-call null fallback):

| Set | Site | Verified failure |
|---|---|---|
| `MUTATING` (push/pop/shift/…) | `array-methods.ts:2539` | missing `unshift` → write-back skipped, mutation lost — #1966 (verified) |
| `ARRAY_LIKE_METHOD_SET` / `ARRAY_METHODS` | `array-methods.ts:434,2384` | absent method → graceful unknown-call null |
| `NATIVE_STR_METHODS` | `declarations.ts:1044` **and** `index.ts:6397` — **duplicated, can drift** | missed method → host path or null |
| `mathConstants` | `typeof-delete.ts:793` **and** `:974` — duplicated in one file | typeof/delete misreport |
| `MATH_CONSTANT_PROPS`/`NUMBER_CONSTANT_PROPS` | `property-access.ts:152-153` | property read null |
| `KNOWN_CONSTRUCTORS`, `FUNCTIONAL_ARRAY_METHODS`, `MATH_HOST_METHODS_*` | `index.ts:7137,7641,6921,6942` | misroute to fallback |
| `CONSOLE_METHODS_SET` | `declarations.ts:143` | dropped console call |
| trim-whitespace char table | native-strings area | #1963 (incomplete set shipped) |

The sets are fine as dispatch tables; the problem is the **else branch** is a
silent fallback rather than `reportSilentFallback`.

### (f) Hardcoded caps / limits without diagnostics

| Cap | Site | On overflow | Issue |
|---|---|---|---|
| 1M iteration guard | `statements/loops.ts:3721` (for-of iterator-protocol) and `:4109` (for-of host-iterator) | `br_if` silently **breaks the loop** — truncated results | #2067 (verified) |
| `REGEX_STEP_CAP = 1_000_000` | `regex/vm.ts:24` (+ vm.ts:107 `return null`) and `native-regex.ts:68` | regex reports **no match** | none directly — **gap** (#1959/#1960 adjacent) |
| 6-fraction-digit rounding | `number-format-native.ts:867` | imprecise toString | known approximation |
| Unroll trip-count ≤1M / literal bound ≤1e9 | `literals.ts:2155,2486` | returns 0 = "don't apply optimization" → general path | **legitimate** (optimization-gate, semantics preserved) |

### (g) Catch-and-continue inside the compiler

83 bare `} catch {` sites in `src/codegen`, 28 in `src/codegen-linear`.
Dominant shape: a `ctx.checker.*` call may throw → catch → return
`undefined` → caller takes the "type not resolvable" route → lands in class
(a)/(c) fallback. **Compounding**: an internal exception degrades into a
wrong answer two layers later. Representative: `declarations.ts:514,539,2288,2719`,
`closures.ts:1115,1160,1227,1513,2553`, `index.ts:1889,3819,4000,4099,7086,7112`,
`expressions/calls.ts:361,532,7223`, `literals.ts:782`,
`statements/nested-declarations.ts:974,985`. Legitimate members exist
(`context/source-pos.ts:16`, `context/errors.ts:19` — diagnostics formatting
guards; `expressions/eval-inline.ts:124` — tiering probe where failure is the
signal). The rest should at minimum count.

### (h) Mode leaks — host imports under standalone

The good gate exists (`registry/imports.ts:34-46` refuses non-allowlisted
`env` imports with a structured error). Leaks occur when a path **bypasses
`addImport`** or consumes a stale `funcMap` index after a refusal (the
comment at imports.ts:40-44 documents this residual hazard). Verified
escapes: #2073 (standalone loose-eq), #2075 (array-join any_make callback);
#2072/#2080/#2081 are adjacent standalone-semantics fallout. #2043 retires
the late-import index-shift class that enables the stale-index variant.

---

## 3. Classification

| Class | Required loudness | Justification |
|---|---|---|
| (a) unresolvable → `ref.null` | **must-be-compile-error** (strict mode), diagnostic-warning meanwhile | The compiler *knows statically* it couldn't resolve the entity. Spec-correct dynamic cases (undefined lowering, placeholder protocols) are excluded and stay silent. |
| (b) lookup-miss skip in binding loops | **must-be-compile-error** | A destructuring key that misses the shape is a front-end type/shape bug; the user program is type-checked, so the miss is *our* inconsistency. |
| (c) NaN/0/false "unresolvable" constants | **must-be-compile-error** for receiver-unresolvable writes (the write is dropped!); **must-be-runtime-TypeError** where JS semantics demand it | #2019's dropped write can never be spec-correct. instanceof on an unresolvable RHS must be runtime TypeError ("Right-hand side is not callable"), not `false`. |
| (d) arity truncation | **must-be-compile-error** at *import-registration* time (variadic builtin registered with fixed arity); excess-arg drop for known fixed-arity user fns is **legitimately-silent** (JS semantics) | |
| (e) allowlist-miss else-branches | **must-be-diagnostic-warning**, counted per set | Misses are expected for genuinely unsupported methods; the bug is *unknowable* drift, so count + ratchet. Duplicated sets must be unified (compile-time invariant test). |
| (f) caps | **must-be-runtime-error** (trap or `RangeError: js2wasm iteration/step cap exceeded`) | Truncated loop results and false regex no-match are wrong answers; an explicit trap is debuggable, silence is not. Optimization-gate caps (literals.ts:2155/2486) stay silent — they only choose codegen strategy. |
| (g) compiler catch-and-continue | **must-be-diagnostic-warning** (counted), promote hot sites to rethrow under CI | Checker flakiness is real; but every swallow must be visible in telemetry. |
| (h) mode leaks | **must-be-compile-error** — already is at the gate; close the bypasses (#2043) and assert at emit time that no `env` import survives in a standalone binary | The #1888 invariant, generalized: a post-link scan of the import section is cheap and absolute. |

---

## 4. Quantification — corpus bugs bred per class (the leverage argument)

June-sweep issues (#1950–#2084) directly attributable:

| Class | Issues | Count |
|---|---|---|
| (a) null fallback | #2082, #1968, #1996, #2010, #2041, #2051, #2074, #2077 | 8 |
| (b) lookup-miss skip | #2032, #2009, #1983, #2020 | 4 |
| (c) NaN/0/false constants | #2019, #1992, #2023, #2027, #2030, #2033, #2053, #2078 | 8 |
| (d) arity truncation | #1955, #1957, #1958, #1969, #2002, #2069, #2076 | 7 |
| (e) allowlist miss | #1966, #1963, #1967 | 3 |
| (f) caps | #2067 (+#1959/#1960 adjacent) | 1–3 |
| (h) mode leaks | #2073, #2075 (+#2072/#2080/#2081 fallout) | 2–5 |
| **Total** | | **~33 of ~135 (≈25%)** |

Broader corpus: 311 issue files mention "silent", 320 mention
"silently/graceful" — the pattern is the single largest recurring root-cause
family in the backlog. Every class above also has **uncovered live sites**
(marked "gap" in §2) that will breed the next sweep's bugs unless ratcheted.

---

## 5. Ratchet plan — extend #1376/#1530, do not fork it

### Mechanism (mirrors check-ir-fallbacks exactly)

1. **Telemetry choke point** — new `src/codegen/fallback-telemetry.ts`:
   ```ts
   export type SilentFallbackClass =
     | "null-fallback"        // (a)
     | "lookup-miss-skip"     // (b)
     | "const-fallback"       // (c)
     | "arity-truncation"     // (d)
     | "allowlist-miss"       // (e)
     | "cap-exceeded-path"    // (f) — registration of a silent-cap code path
     | "compiler-catch";      // (g)
   export function reportSilentFallback(
     ctx: CodegenContext, cls: SilentFallbackClass,
     site: string,            // "unary-updates:incdec-unresolvable-receiver"
     node?: ts.Node, detail?: string,
   ): void;
   ```
   Behavior: increments `ctx.fallbackCounts.get(cls)!.get(site)`; when
   `ctx.options.trackSilentFallbacks` pushes a structured *warning*
   diagnostic (same channel as `formatIrPathFallbackDiagnostic`); when the
   class is in `STRICT_FALLBACK_CLASSES` (or `JS2WASM_STRICT_FALLBACKS=1`,
   auto-on under `CI`/`VITEST` like `irVerifierHardFailureEnabled`,
   index.ts:925) pushes a **hard error**. One function, three escalation
   levels — identical lifecycle to `STRICT_IR_REASONS`.
2. **Gate script** — `scripts/check-codegen-fallbacks.ts`, a sibling of
   `check-ir-fallbacks.ts`: same corpus (`website/playground/examples/`),
   plus the `tests/equivalence` inputs for breadth; aggregates
   `ctx.fallbackCounts` per class/site into
   `scripts/codegen-fallback-baseline.json`; **fails on growth**; supports
   `--update`, `--update-on-decrease` (staged-on-disk, PR author commits),
   `--json`, `--verbose` — flag-compatible so CI wiring is copy-paste.
3. **CI** — add `pnpm run check:codegen-fallbacks` next to
   `check:ir-fallbacks` in the `quality` job; the post-merge job runs
   `--update-on-decrease` to bank improvements automatically.
4. **Promotion at zero** — `STRICT_FALLBACK_CLASSES` set beside
   `STRICT_IR_REASONS` (index.ts:899). When a class's baseline hits zero
   across the corpus, add it; recurrence = compile error. Per-class
   ownership/target dates go in `plan/log/ir-adoption.md` (same doc, new
   section) so there is one ratchet dashboard.

### Adoption phases

- **Phase 0 — first PR (small, ~1 day)**: telemetry module + gate script +
  baseline + CI wiring, instrumenting only the **~16 highest-leverage
  verified sites**: the 8 `unary-updates.ts` NaN sites (one shared helper),
  the 7 `fieldIdx === -1) continue` sites, and `identifiers.ts:812` catch-all.
  No behavior change — counts only. Baseline captures current reality.
- **Phase 1 — class (a)+(c) sweep**: route the ~30 curated null/const
  fallback sites (§2a, §2c tables) through `reportSilentFallback`. Convert
  `stack-balance.ts:812` to hard error immediately (a self-repair pass
  inventing values has no legitimate trigger).
- **Phase 2 — arity + allowlists**: refactor the 18 `Math.min` arg loops
  through one `compileBoundedCallArgs()` helper that reports when
  `arguments.length > arity` **and the callee is a registered host builtin**;
  unify the duplicated Sets (`NATIVE_STR_METHODS`, `mathConstants`) into
  single registry modules with budget tests modeled on
  `tests/host-import-allowlist-budget.test.ts`; instrument allowlist
  else-branches.
- **Phase 3 — runtime-loudness conversions**: loop caps (loops.ts:3721/4109)
  and `REGEX_STEP_CAP` overflow emit a `RangeError` throw (standalone: exn
  tag, host: `__throw_range_error`) instead of silent break/no-match —
  closes #2067's class permanently. instanceof-unresolvable becomes runtime
  TypeError (#1992).
- **Phase 4 — promotion + catch audit**: flip `lookup-miss-skip` and
  `null-fallback` into `STRICT_FALLBACK_CLASSES` as their buckets zero out;
  sweep the 83+28 catch sites, annotate each as `legit` (allowlisted in the
  baseline with a reason string, like `host-import-allowlist.ts` entries) or
  route through `reportSilentFallback("compiler-catch", …)`; add the
  emit-time standalone import-section assert (class h).

### Why this ordering
Phase 0 is deliberately tiny and pure-telemetry so it can't regress anything
and lands the *mechanism*; Phases 1–2 cover the classes that bred 27 of the
33 attributed bugs; Phase 3 is the only one changing emitted code; Phase 4
is the long-tail ratchet that the machinery then grinds down automatically,
exactly as #1530 is doing for IR fallbacks.
