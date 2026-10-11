---
id: 6882
title: "S3-l: finish the regime's provider–consumer link — the remaining `boundary ?? peer` sites and the 20 Temporal/PlainTime rows left by #6748"
status: done
assignee: ttraenkler/opus-6882
created: 2026-10-06
updated: 2026-10-07
completed: 2026-10-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: linked-providers
goal: architecture
sprint: current
parent: 5385
related: [6748, 5383, 6750, 6880, 6894]
---

# #6882 — the half of #6748 the measured rows did not need

#6748 (PR #6542) made the regime's Temporal provider link: `new`, property
reads, method calls and `getPrototypeOf` now ask the wasm peer first and the
JS boundary second (`constructBoundaryPairs` in `standalone-link-boundary.ts`;
`object-runtime.ts`, `object-runtime-prototype.ts`, `native-construct.ts`,
`runtime/wasmgc/values/object-get-bodies.ts`). Four sites still pick one side
with `boundary ?? peer`, and 20 `PlainTime/` rows still fail on the regime
while standalone passes them.

## Sites

| site | symptom today |
| --- | --- |
| `__extern_has` (object-runtime.ts, the `hasBoundaryOrReverseIdx` arm) | `in` / `hasOwnProperty` on a provider-minted struct answers the boundary only |
| keys / for-in (`__object_keys`, `__object_keys_forin`, `__boundary_object_for_in_keys`) | enumeration of a provider struct from the consumer |
| `__apply_closure` (closures.ts / function-proto-invokers.ts) | `called value is not a function` for a provider closure — also the cause of ES5 group 2 in #6880 (`harness/deepEqual-*.js`) |
| the `typeof` callable-kind check (`__boundary_object_callable_kind` vs the peer's) | one PlainTime row answers `"object"` for a function |

## The 20 PlainTime rows (from #6748's report)

- a `TypeError` for a Symbol-valued `options` argument (the symbol crosses
  the link as a boundary box; needs the peer's symbol identity);
- `Symbol.toStringTag` read across the link (keys/get of a well-known symbol
  on a provider prototype);
- one `typeof` answering `"object"` (the callable-kind site above).

## Plan

Same recipe as #6748: for each site, build the matching boundary/peer pair
and ask the peer first; focused test in `tests/issue-6882-*.test.ts` using a
two-module regime project (consumer + provider) for `in`, `for…in`,
`Object.keys`, calling a provider function value, `typeof` on it; then the
scoped lane `TEST262_PATH_FILTER="built-ins/Temporal/PlainTime/"` before/after
(473/493 → 493). Delete `.test262-cache/temporal` between codegen changes
(the key omits the compiler version — fix that too while here:
`temporalProviderCacheKey` should include the compiler-bundle hash).

## Acceptance

- [~] PlainTime 493/493 on the regime lane; `Temporal/Now/` unchanged. —
      **485/493, = standalone**; the 8 left fail identically on standalone
      (not link defects, see below). `Now/` 64/66, unchanged (= #6748, = standalone).
- [ ] ES5 group 2 rows of #6880 pass (`harness/deepEqual-*.js`). — **not a
      link defect**: single-module rows, fail identically before and after;
      root cause measured and split to #6894.
- [x] Default gc / standalone / wasi byte-identical.

## Implementation notes — 2026-10-07 (opus-6882)

### What was wrong, per site

| site | finding | change |
| --- | --- | --- |
| `typeof` callable kind (`typeof-natives-finalize.ts`) | `boundary ?? peer` asked the JS boundary only; a provider class answered `"object"` (`PlainTime/prop-desc.js`) | ask every callable-kind terminal, peer first, and OR the bits (`callableKindBitsInstrs`) |
| `Object.keys` / `for…in` keys (`object-runtime-enumeration.ts`) | `boundary ?? peer ?? reverse` — boundary only on the regime; a regime PROVIDER also lost its reverse hop | one non-null-answer arm per terminal, peer → boundary → reverse (`nonNullAnswerArms`, `definedIdxs`) |
| `__extern_has` | there was **no forward peer `has` terminal at all**, on either lane: `"a" in <provider value>` was false under plain standalone too. Because the `for…in` loop re-checks each key with `__extern_has` (#2066), enumeration of a provider value dropped every key even where `Object.keys` worked | new provider export `__js2wasm_link_has` (wraps `__extern_has`, answers the `__boundary_object_has` tri-state); consumer asks peer → boundary → reverse (`hasTriStateArmsInstrs`) |
| `__apply_closure` | no defect on the link: since #6420 the peer callable-kind + apply arm is unshifted ahead of the boundary arm, so a provider function value is already asked peer-first (calls, `.call`, `.apply` all answer on base) | none |
| **Symbol-valued options (10 rows)** | not a link defect. `__typeof_object`'s finalize appended its `$Symbol` exclusion AFTER the callable-kind arm, which **returns unconditionally** — so in every module with a JS boundary or a linked peer callable-kind terminal the Symbol arm was dead code and `typeof sym === "object"` held. The polyfill's IsObject (`"object"==typeof e`) then accepted a Symbol `options`. Reproduces in a single regime module (`f(1)` on an unknown `f` registers the boundary terminal) | splice the exclusion ahead of the terminal (`callableI32Arms(..., beforeTerminal)`, `symbolExclusionArm`) |

`hasOwnProperty` across the link is left as is (own-only needs its own
terminal; the measured rows did not need it).

### Byte identity

sha256 of 10 sources (2 dynamic-receiver probes + 8 playground examples) ×
{gc, standalone, wasi}: identical base vs after. The regime (native-first)
single-module hash changes only for modules that have both a `$Symbol` carrier
and a callable-kind terminal — the intended `typeof` fix; with that one change
reverted all four lanes are identical. Linked standalone pairs change by
design (the new `has` terminal on both sides).

### Measurements (local, `JS2WASM_EVAL_ENGINE=interpreter
TEST262_SEMANTIC_PROVIDERS=native-first`, box load 200–450, compile timeout
raised locally to 400 s for the measurement only — not committed)

| folder | regime before | regime after | standalone (baseline 2026-10-07) |
| --- | ---: | ---: | ---: |
| `built-ins/Temporal/PlainTime/` | 473 / 493 | **485 / 493** | 485 / 493 |
| `built-ins/Temporal/Now/` | 64 / 66 | 64 / 66 | 64 / 66 |

Both columns measured on this branch's base (`20297ba9ae`) and head, full
folders. The 12 rows fixed: 10 `options-{wrong-type,invalid}` (Symbol typeof),
`prop-desc.js` (typeof of a provider class), `constructor.js`.

Before-state measured on THIS base for the 72-row subset (every standalone-
passing PlainTime row that mentions `Symbol`/`typeof`/`toStringTag`, plus the
eight ES5/harness rows): 53/72 → 64/72 after (all 11 PlainTime failures fixed;
the eight harness rows fail identically). The 8 PlainTime rows still failing
also fail on standalone: `basic.js`, `from/argument-object-leap-second.js`,
`from/argument-string-invalid.js`, `prototype/{add,subtract}/*-large-subseconds.js`,
`prototype/{since,until}/options-read-before-algorithmic-validation.js`,
`prototype/toLocaleString/return-string.js` (Intl refusal).

### Cache key

`temporalProviderCacheKey` / `buildTemporalProvider` read an optional
`compileOptions.compilerFingerprint` (never forwarded to the compile); the
pre-warm and the test262 worker set it to the compiler-bundle hash through one
shared helper (`withTemporalCompilerFingerprint` in `scripts/test262-temporal.mjs`,
the same `test262CompilerBundleHash` rule as the #6723 harness cache), and the
provider directory gets a `compiler-<hash>` sub-directory so the package
linker's own source-keyed cache cannot serve a stale provider either. Callers
that pass nothing keep their key (the two-part key test in #5383 is unchanged).

### Follow-up

- #6894 — the eight `called value is not a function` harness/ES5 rows.
- `hasOwnProperty` on a provider value (needs an own-only peer terminal).
- Seen while reducing, both lanes, not filed: a closure capturing a `for…of`
  binding over `[null, Symbol()]` that calls a provider method throws
  `illegal cast` (standalone too); no PlainTime row hits it.
