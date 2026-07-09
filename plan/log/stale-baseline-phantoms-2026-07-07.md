# Stale-baseline phantoms — 2026-07-07

**TL;DR.** The Test262 harvest cache
(`.test262-cache/test262-current.jsonl`, fetched from
`loopdive/js2wasm-baselines`) **lags `main`**. A cache that was ~2 days old
(Jul-5 22:46) listed **~65 tests as "failing" that already pass on current
`main`** — landed by fixes merged Jul-5→Jul-6. Harvesting off a stale cache
makes agents (and the next Fable window) **re-chase already-fixed work** — the
exact trap dev-A hit on #3026 (49/55 of that baseline's entries were already
passing). **Refresh the cache AND verify-live before filing/claiming.**

## Why the cache lags

`.test262-cache/test262-current.jsonl` is the promoted baseline from the
`test262-sharded.yml` `promote-baseline` job. It reflects a **full sharded run**
of some earlier `main`, so it trails `HEAD` by the run+promote duration (hours),
and — if you never re-fetch — by however long your local copy has sat (days).
The committed summary `benchmarks/results/test262-current.json` shows the drift:

| baseline generated                  | pass / 43106 |
| ----------------------------------- | ------------ |
| 2026-07-05 ~22:46 (the stale cache) | ~32472       |
| 2026-07-06 22:53 (latest committed) | 32537        |

Net **+65** over ~24h — every one of those is a **phantom** for anyone still
harvesting the Jul-5 copy.

## Confirmed PHANTOM clusters (verified live on current `main` HEAD)

Classification method: direct compile+execute probes via `compileToWasm`
(host mode — the baseline's mode) against current-`main` `src/`. Each behaviour
below now matches spec, so the baseline "fail"/`compile_error` entries are
already resolved. **Do not open issues or claim tasks for these.**

| cluster                                                                                  | fixing PR(s)                                            | live-probe result                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Number.prototype.toExponential` / `toPrecision` (`undefined` arg + range check)         | #3078, #3081                                            | `(123.456).toExponential(undefined)` → `"1.23456e+2"`; `toPrecision(undefined)` → `"123.456"`                                                                        |
| `String.prototype.isWellFormed` / `toWellFormed`                                         | #3068                                                   | `"abc".isWellFormed()` → `true`; `"abc".toWellFormed()` → `"abc"`                                                                                                    |
| global `escape()` / `unescape()` (basic host cases)                                      | #3063, #3064                                            | `escape("a b")` → `"a%20b"`; `unescape("%20")` → `" "`                                                                                                               |
| `Math.<inherited-method>()` codegen crash (`Math.toString`/`valueOf`/`hasOwnProperty`/…) | #3044                                                   | `Math.toString()` → `"[object Math]"` (no `op.endsWith` codegen abort)                                                                                               |
| `Symbol.prototype.toString` / `String(symbol)` (host mode)                               | #3085 (PR #2787, **in merge queue** at time of writing) | `Symbol('66').toString()` → `"Symbol(66)"`; `String(Symbol('66'))` → `"Symbol(66)"` — clears ~6 `Symbol/prototype/toString/*` + `String(symbol)` entries once landed |

Other landed-since-Jul-5 fixes in adjacent lanes that similarly cleared baseline
entries (not re-verified here, but merged before the current baseline):
#3069 (Annex-B HTML string-wrapper methods, standalone), #3027 (standalone
computed string property/method dispatch), #3051 (RegExp `@@replace`/`@@split`
coercion, ~48 fails — dev-A2's lane), #2933 (standalone `JSON.stringify` static
value read).

## Confirmed STILL-REAL in the same space (NOT phantom — genuinely fail on `main`)

Do **not** mistake these for phantoms — they still fail, and several are
substrate-deep / Fable-reserved:

- **`Math.sumPrecise/*`** (~7 files) — genuinely **not implemented**
  (`Math.sumPrecise` → "is not a function"). Needs iterator-protocol dispatch +
  bit-exact extended-precision summation (M/L, not a quick win).
- **object→primitive coercion where `toString`/`valueOf` is a Wasm closure** —
  `escape`/`unescape` `to-primitive-observe` / `to-string-observe` (6 entries),
  `parseInt(obj)` / `isNaN([1])` → "Cannot convert object to primitive value"
  (`calls.ts` parseInt path). The #1090 / any-receiver ToPrimitive substrate.
- **"Cannot convert a Symbol value to a number"** (~20 entries across
  `Symbol/keyFor`, `WeakMap`/`WeakSet` symbol keys, `yield-star`) — symbol
  value-rep in dynamic/`any` contexts. Substrate.
- Two `symbol-basic.test.ts` failures (well-known symbol → `Number()` coercion)
  reproduce on clean `main` — separate real bug, not a harvest phantom.

## Guidance for future harvests (do this before filing an issue or claiming)

1. **Refresh the cache first:** `node scripts/fetch-baseline-jsonl.mjs --force`
   (retry on the slow network; the fetch is idempotent). This alone clears the
   bulk of the phantoms — the fresh baseline already reflects fixes merged up to
   its generation time.
2. **Verify-live anyway:** even a freshly-fetched baseline trails `HEAD` by the
   run+promote window (hours). Before you file/claim, **compile+run the specific
   case on current `main`** (a `compileToWasm` probe or the live runner). This
   session repeatedly overturned baseline "fail" rows that already pass.
3. **Cross-check `git log`:** `git log --since=<baseline date> --oneline` grepped
   for the cluster's symbol (`Symbol`, `Number`, `toExponential`, `escape`, …)
   surfaces the fixing PR fast.

Related: this note operationalises the "verify-first" rule already in memory
(`feedback_verify_fix_in_git_not_narrative`,
`feedback_reground_spec_against_current_main`) specifically for the harvest cache.
