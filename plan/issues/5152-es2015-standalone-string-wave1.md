---
id: 5152
title: "ES2015 standalone: string conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-29
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/string-search-value.ts
  - src/codegen/string-ops.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/object-runtime.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/iterator-native.ts
  - src/codegen/case-convert-native.ts
  - src/codegen/case-tables.ts
  - src/codegen/string-raw.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/symbol-native.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/string-isregexp-guard.ts
  - src/codegen/string-proto-tostring.ts
coercion-sites-allow:
  # (#5152) §7.2.8 IsRegExp step 3 is literally `ToBoolean(matcher)`, and this
  # site performs it by CALLING the shared native `__is_truthy` helper — the
  # same one `new Boolean(x)` and the object-ops truthiness path use. No
  # ToString/ToNumber/ToPrimitive matrix is hand-rolled here; the ToString half
  # of the same lane deliberately delegates to `emitStringProtoToStringFlat`.
  - src/codegen/string-isregexp-guard.ts
func-budget-allow:
  - src/codegen/case-convert-native.ts::emitNativeCaseConversion
  - src/codegen/case-convert-native.ts::makeStr
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
---

# ES2015 standalone: string conformance wave 1

LOC-growth allowance rationale (2026-08-28): the clusters below add a runtime
@@protocol dispatch lane, a reflective `String.prototype[Symbol.iterator]`
member, normalize validation + normalization tables, astral case-mapping
tables, and Symbol-rejection arms to the runtime coercion walkers — all in the
files listed in `loc-budget-allow`. Measured growth is expected and granted
for this change-set. `src/codegen/case-tables.ts` is GENERATED
(`scripts/gen-case-tables.mjs`) and grows by the new astral run tables.

## Problem

53 ES2015-bucket test262 tests under `built-ins/String/**` fail on the
standalone target (re-verified 2026-08-28 on head, branch
`claude/es2015-test262-standalone-9vij99`: all 53 from the day-old baseline
still fail — 52 FAIL + 1 COMPILE_ERROR, 0 already fixed). Eleven root causes
cover all 53; the top six cover 79%, the top seven 85%. The dominant gap — the
§21.1.3 @@match/@@search/@@split/@@replace runtime protocol (15 tests) — is
also what stands between the standalone string methods and any user code that
passes non-RegExp search values, so it feeds the broader 100%-ES2015
standalone goal beyond this file list.

**Target list**: `.tmp/es2015/wp-string-current-fails.txt` (53 paths,
regenerated 2026-08-28). Per-cluster lists:
`.tmp/es2015/str-cl-{A-search-value-protocol,B-normalize,C-symbol-iterator,D-indexof-toprimitive,E-astral-case,F-string-raw,G-isregexp-guard,H-codepointat,K-pad-symbol-fill,I-fromcodepoint-symbol,J-realm-deferred}.txt`
(verified: their union is exactly the 53-path target list).
Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`.
Minimal repros from this analysis: `.tmp/probes5152/*.js` — run one via
`npx tsx .tmp/probe-one.mts /home/user/js2/.tmp/probes5152/<name>.js`.

## Current failure clusters

| # | cluster | count | root cause (file:function) | sample tests |
|---|---------|-------|----------------------------|--------------|
| A | @@match/@@search/@@split/@@replace runtime dispatch + split coercion order | 15 | `src/codegen/string-search-value.ts:isPlainToStringSearchValue` (L117) decides statically via `ctx.oracle.wellKnownSymbolMemberOf`; when the value MAY carry the protocol symbol there is no runtime `GetMethod` lane — `match`/`search` fall into the dynamic-RegExp lane (runtime `TypeError: Unsupported dynamic regular expression pattern`) or the #1474 refusal in `src/codegen/string-ops.ts` L3652-3674 (the `replace/cstm-replace-get-err.js` COMPILE_ERROR). Also `string-ops.ts` split arm (~L3400-3456) coerces separator before limit — spec wants `ToUint32(limit)` before `ToString(separator)` | `match/cstm-matcher-invocation.js`, `split/cstm-split-invocation.js`, `split/limit-touint32-error.js` |
| B | normalize: identity stub, no validation, no normalization | 10 | `src/codegen/string-ops.ts` L3563-3598: `normalize` is identity; form validated only when a static string literal; no runtime `ToString(form)` (Symbol must TypeError), no runtime RangeError, no reflective RequireObjectCoercible arm in `src/codegen/array-object-proto.ts`, and no actual NFC/NFD/NFKC/NFKD | `normalize/form-is-not-valid-throws.js`, `normalize/this-is-undefined-throws.js`, `normalize/return-normalized-string.js` |
| C | `String.prototype[Symbol.iterator]` missing | 5 | `src/codegen/array-object-proto.ts:STRING_PROTO_METHODS` (L237) has no `"@@1"` symbol member (Array's glue has `"@@1"` at L111; RegExp's has `@@7`-`@@10`, `regexp-standalone.ts` L5149). Reflective read returns `undefined`; probe `q5-iter-indirect.js` shows the element-access read even emits invalid Wasm ("expected i32, got externref" in `__module_init`) | `Symbol.iterator/prop-desc.js`, `Symbol.iterator/name.js`, `Symbol.iterator/not-a-constructor.js` |
| D | indexOf arg ToPrimitive sub-steps | 5 | Two defects: (1) an object LITERAL with computed `[Symbol.toPrimitive]` key is compiled as a closed struct the runtime walkers never probe — assignment-installed `obj[Symbol.toPrimitive]=…` works (probe p3 passes), literal form fails (probe q1: `-1`); `src/codegen/literals.ts` literal lowering vs the #5102 `Symbol.toPrimitive` probe in `src/codegen/object-runtime.ts` L4793-5012. (2) unboxing `Object(Symbol())` yields a `$Symbol` carrier that the ToNumber/ToString walkers accept silently instead of throwing TypeError (probe q4) | `indexOf/searchstring-tostring-wrapped-values.js`, `indexOf/position-tointeger-errors.js` |
| E | astral (supplementary-plane) case mapping | 4 | `scripts/gen-case-tables.mjs:simplePairs` scans only `cp <= 0xffff`; `src/codegen/case-convert-native.ts` maps per i16 code UNIT, so surrogate pairs pass through unmapped (Deseret U+10400↔U+10428 etc.) | `toLowerCase/supplementary_plane.js`, `toUpperCase/supplementary_plane.js` |
| F | String.raw descriptor loss + Symbol segment | 3 | Template object reaches `__str_raw` through `materializeStructAsDynamicObject` (`src/codegen/expressions/call-builtin-static.ts` L805-825), which snapshots values — accessors installed via `Object.defineProperty` on the (nested) template are not consulted (probes q6/r2 fail while the DIRECT read r1 passes, isolating the materialization). Symbol-valued segment needs the same walker TypeError arm as D | `raw/template-length-throws.js`, `raw/returns-abrupt-from-next-key.js`, `raw/nextkey-is-symbol-throws.js` |
| G | IsRegExp runtime check in includes/startsWith/endsWith | 3 | `src/codegen/string-ops.ts` L3037-3080 arms do only the STATIC #2598 check (`L421`); §7.2.8 `Get(arg, @@match)` never runs, so a poisoned `Symbol.match` getter cannot throw | all three `*/return-abrupt-from-searchstring-regexp-test.js` |
| H | codePointAt OOB → NaN not undefined | 2 | `src/codegen/string-ops.ts` L3462-3560 returns plain f64 with NaN sentinel for out-of-range; the js-host fix was #2004, standalone still unpatched (probe q7: `NaN`) | both `codePointAt/returns-undefined-on-position-*.js` |
| K | padStart/padEnd Symbol fill → invalid Wasm | 2 | `src/codegen/string-ops.ts` L3215-3217 / L3250-3252 compile the fill arg with bare `compileExpression + emitFlatten()`; a `Symbol()` arg is a bare i32 id, producing `call[0] expected (ref null 6), found global.get of type i32`. The existing `emitArgAsNativeString` (L463) already carries the §7.1.17 Symbol TypeError guard and is simply not used here | both `pad{Start,End}/exception-fill-string-symbol.js` |
| I | fromCodePoint(Symbol) no TypeError | 1 | `compileFromCharCodeFamily` via `src/codegen/expressions/call-builtin-static.ts` L750-777 coerces the arg to number without the Symbol rejection (probe q8) | `fromCodePoint/argument-is-Symbol.js` |
| J | cross-realm (deferred — #4274) | 3 | `$262.createRealm` pseudo-realm lacks per-realm `String`/`TypeError` identity; owned by #4274 (status ready) + #4634 — do NOT implement here | `proto-from-ctor-realm.js`, `valueOf/non-generic-realm.js`, `toString/non-generic-realm.js` |

## Implementation Plan

Order is by count descending; each step is independently landable, so partial
completion maximizes yield. All work is standalone-lane (`noJsHost(ctx)` /
`ctx.standalone` gates); js-host mode is untouched. Constraints throughout:
**no new host imports** (a host import is acceptable only as a js-host-mode
fast path with a Wasm-native standalone fallback — none is needed here); all
type queries through `ctx.oracle` (`src/checker/oracle.ts`), never
`ctx.checker.getTypeAtLocation` (oracle-ratchet gate; `wellKnownSymbolMemberOf`
already exists on the oracle); **never** edit `tests/test262-runner.ts`, any
skip list, or `scripts/*baseline*.json`.

### Step A — runtime @@protocol dispatch for match/search/split/replace (15 tests)

1. In `src/codegen/string-search-value.ts`, add an `emitSearchValueProtocolDispatch`
   builder that emits, for a search value held in an externref temp `sv`:

   ```
   if (!nullish(sv)) {                                  // §21.1.3.x step 2/3
     m = __extern_get(sv, __box_symbol(<id>))           // getter RUNS; abrupt propagates
     if (!nullish(m)) {                                 // GetMethod: null/undefined ⇒ skip
       if (!IsCallable(m)) throw TypeError              // GetMethod step 3
       result = __call_fn_method_1(sv, m, S)            // match/search: Call(m, sv, «O»)
       // split/replace: __call_fn_method_2(sv, m, S, limit/replaceValue)
       return result (externref)
     }
   }
   // fall through to the existing ToString / RegExpCreate lanes
   ```

   Follow the exact GetMethod-read shape of
   `compileNativeDisposableStackUse` in `src/codegen/disposable-runtime.ts`
   (~L1160-1245): `ensureObjectRuntime` + `ensureLateImport("__box_symbol",…)`
   + `flushLateImportShifts` + the regime-independent `nullishOf` combinator.
   Well-known ids: match=7, replace=8, search=9, split=10
   (`src/codegen/literals.ts` L2508). Callable test: the same
   `__typeof_function`-style probe `ordinary-to-primitive-probe.ts` uses.
2. Wire it into the lanes that currently lose these tests:
   - `tryCompileStandaloneStringMatch` / `...Search` (regexp-standalone.ts)
     and `tryCompileCoercedStringMatch`/`...Search`
     (string-search-value.ts L244/L277): before falling into
     `RegExpCreate(ToString(v))`, emit the dispatch. This turns the runtime
     `REGEX_UNSUPPORTED_DYNAMIC_PATTERN` TypeError into a correct `Call`.
   - the `split` arm (`string-ops.ts` ~L3400) and
     `tryCompileStandaloneSplitSeparator` (string-search-value.ts L318):
     dispatch BEFORE `ToString(this)` — `split/this-value-tostring-error.js`
     observes that the receiver is NOT coerced when the separator has @@split.
   - `replace`: same, before the ToString lane; this also deletes the
     `replace/cstm-replace-get-err.js` refusal path (the L3652-3674 refusal in
     string-ops.ts no longer fires for symbol-protocol arg forms once the
     dispatch lane exists — narrow the `symbolProtocolArgForm` refusal
     accordingly rather than deleting the whole diagnostic).
3. Evaluation/coercion order fix in the split string lane (same functions):
   evaluate both argument EXPRESSIONS in source order into temps, then coerce
   `lim = ToUint32(limit)` BEFORE `R = ToString(separator)`
   (`split/limit-touint32-error.js`). `compileStringIntegerArg`
   (string-ops.ts L2356) is the ToInteger engine to reuse for the temp.
4. `invoke-builtin-match/search*`: these read
   `RegExp.prototype[Symbol.match/search]` reflectively — today that read
   returns `undefined` even though the RegExp glue declares `@@7`-`@@10`
   (`regexp-standalone.ts` L5149). Fix the `<Builtin>.prototype[Symbol.X]`
   element-access READ path (`src/codegen/property-access-dispatch.ts`, the
   `Symbol.*` key arm) to resolve through the registered native-proto member
   closures — the same fix Step C needs, do it once there. With the runtime
   dispatch of A.1 in place, `''.match(/./)` after
   `RegExp.prototype[Symbol.match] = fn` must call `fn`; keep the static
   fast path for modules that never install such a member by reusing the
   module-scan gate pattern of `moduleInstallsCallableHasInstance`
   (`src/codegen/native-ordinary-instanceof.ts` L156).
5. Edge cases: `cstm-*-is-null.js` fall through to
   `RegExpCreate(ToString(obj))` = pattern `"[object Object]"` — verify
   `__regex_compile_dynamic_simple` accepts a `[...]` character class; if it
   refuses, the two `is-null` tests keep failing — check first, and if so
   handle that pattern class in `ensureDynamicStandaloneRegExpCompiler`
   (regexp-standalone.ts). The dispatch must evaluate `sv` EXACTLY ONCE
   (`cstm-matcher-invocation.js` counts calls).

### Step B — normalize (10 tests; 7 without Unicode tables)

1. Rewrite the `normalize` arm in `src/codegen/string-ops.ts` L3563-3598:
   receiver first (keep the #1823 ordering), then if a form arg is present and
   not a statically-valid literal: coerce via `emitArgAsNativeString`
   (string-ops.ts L463 — its Symbol guard covers
   `return-abrupt-from-form-as-symbol.js`, its walker propagates the abrupt
   `toString` of `return-abrupt-from-form.js`), then a runtime 4-way string
   compare (NFC/NFD/NFKC/NFKD) → `RangeError` via the same
   `buildThrowJsErrorInstrs` used elsewhere (`form-is-not-valid-throws.js`;
   note `['NFC']` coerces to `"NFC"` and is VALID —
   `return-normalized-string-from-coerced-form.js`).
2. Reflective arm: add a `normalize` member body in
   `src/codegen/array-object-proto.ts` (the String glue dispatcher, ~L1000-1100)
   that runs `emitStringRequireObjectCoercible` (L937) + `ToString(this)`
   (Symbol receiver → TypeError — `return-abrupt-from-this-as-symbol.js`) +
   the same form validation. Mimic `emitStringSearchNumericMemberBody`
   (L1270+) for the closure ABI. Covers the four `this-*`/`return-abrupt-from-this*` tests.
3. Actual normalization (3 `return-normalized-string*` tests) — the largest
   sub-step, land LAST and defer to a wave 2 if it does not fit: a new
   `scripts/gen-normalize-tables.mjs` (pattern: `scripts/gen-case-tables.mjs`,
   which already uses Node's ICU as the offline oracle) emitting canonical +
   compat decomposition tables, a ccc-order table (derivable offline by
   probing `normalize('NFD')` stability of combining-mark pairs), and the NFC
   pairwise composition table; plus a `__str_normalize` helper in a new
   `src/codegen/normalize-native.ts` (module-global tables via
   `array.new_fixed`, same #3900 pattern as case-convert-native.ts).

### Step C — `String.prototype[Symbol.iterator]` (5 tests, unblocks A.4)

1. Add `"@@1"` to the String glue member CSV in
   `src/codegen/array-object-proto.ts` (Array's glue already carries `"@@1"`
   at L111 as a `values` alias — same sentinel format; RegExp's `@@7`-`@@10`
   at regexp-standalone.ts L5149 show the multi-symbol form). Member kind:
   method, `length` 0, name `"[Symbol.iterator]"`, non-constructor (the
   native-proto closure factory's default — `not-a-constructor.js`),
   prop-desc writable+configurable, non-enumerable.
2. Member body: `RequireObjectCoercible` + `ToString(this)` (abrupt for a
   poisoned-toString receiver — `this-val-to-str-err.js`), then return the
   string iterator. Reuse the #3146 string-subject normalization
   (`ensureStrToCharVecHelper` + the per-code-point iteration
   `src/codegen/iterator-native.ts` L1392 already uses for dynamic
   GetIterator over strings) so `[Symbol.iterator]().next()` agrees with
   for-of.
3. Fix the reflective read: probe `q5-iter-indirect.js` currently produces
   INVALID WASM ("expected i32, got externref" in `__module_init`) when
   `String.prototype[Symbol.iterator]` is stored to a variable — the
   `<Builtin>.prototype[Symbol.X]` element-access read in
   `src/codegen/property-access-dispatch.ts` must route through the glue's
   member-closure factory (i32 well-known-symbol id vs externref key
   confusion). This same fix makes `RegExp.prototype[Symbol.search]` readable
   (Step A.4). Regression-check `Array.prototype[Symbol.iterator]` reads.

### Step D — ToPrimitive sub-steps in string-method arg coercion (5 tests)

1. Literal `[Symbol.toPrimitive]`: make an object literal carrying a computed
   well-known-symbol key compile to the OPEN `$Object` representation (or
   teach the closed-struct coercion path to probe the `@@toPrimitive` field)
   so the #5102 probe in `src/codegen/object-runtime.ts` (L4793-5012, keyed
   `__box_symbol(3)`) finds it. Literal lowering: `src/codegen/literals.ts`.
   Verify with probes `q1-wrapped-literal-toprim.js` (ToString hint) — the
   number-hint twin is the first assertion of
   `indexOf/position-tointeger-toprimitive.js`.
2. Symbol rejection in the runtime walkers: add a `$Symbol`-carrier arm that
   throws TypeError to (a) the ToNumber walk used by
   `coerceType(…, f64, "number")` for externref operands, and (b) a
   throw-on-Symbol variant of `__extern_toString` for METHOD-ARG coercion
   (`ensureObjectRuntime`, object-runtime.ts; carrier type from
   `ensureSymbolCarrier`, `src/codegen/symbol-native.ts` L66). Do NOT change
   `String(sym)` — §22.1.1.1 allows it; only the implicit §7.1.17 ToString and
   §7.1.3 ToNumber paths throw. This also covers the `Object(Symbol())`
   wrapper unbox (the `WRAPPER_PRIMITIVE_KEY` read in `__to_primitive`
   returns the carrier; the walker must then reject it — probe
   `q4-boxed-symbol-throws.js`) and feeds Steps F and I.

### Step E — astral case mapping (4 tests)

1. `scripts/gen-case-tables.mjs`: extend `simplePairs` to scan
   `0x10000..0x10FFFF` into separate `ASTRAL_UPPER_CASE_RUNS`/
   `ASTRAL_LOWER_CASE_RUNS` (all astral mappings are simple 1:1 and stay
   astral, so UTF-16 length never changes — assert that in the generator).
   Regenerate `src/codegen/case-tables.ts` and commit.
2. `src/codegen/case-convert-native.ts`: in the full (non-ASCII) path, on a
   high surrogate followed by a low surrogate, decode the code point, look up
   the astral runs via the existing `__case_simple` binary search, re-encode
   the mapped pair. Pass-1 length counting is unaffected (pairs contribute 2
   before and after). `toLocale{Lower,Upper}Case` route to the same helpers
   (string-ops.ts L3273) so all 4 tests move together.

### Step F — String.raw fidelity (3 tests)

1. Descriptor loss: the template arg in
   `src/codegen/expressions/call-builtin-static.ts` L805-825 goes through
   `materializeStructAsDynamicObject`, which snapshots values — accessors
   later installed by `Object.defineProperty` on the (nested) `raw` object are
   invisible to the helper's `__extern_get` even though a DIRECT property
   read runs them (probes r1 pass / r2+q6 fail isolate this). Fix by keeping
   identity: when the template's value flows from a variable (not a fresh
   literal), pass the live representation the direct-read path consults
   instead of a copy (or materialize the literal ONCE at creation). Verify
   `__extern_length`'s array-like arm then propagates the throwing `length`
   getter (string-raw.ts header notes it is designed to).
2. `nextkey-is-symbol-throws.js` (Symbol-valued segment → TypeError) falls out
   of Step D.2's throwing `__extern_toString` variant — `__str_raw` already
   coerces segments through `__extern_toString` (string-raw.ts L26).

### Step G — runtime IsRegExp in includes/startsWith/endsWith (3 tests)

In the three arms (`src/codegen/string-ops.ts` L3037-3080), for a search arg
not statically proven string-like, emit before ToString: if the arg is an
object → `__extern_get(arg, __box_symbol(7))` (getter runs, abrupt
propagates); if the result is not undefined → ToBoolean → TypeError (reuse the
existing #2598 message); if undefined → `ref.test $NativeRegExp` → TypeError.
Same GetMethod-read shape as Step A.1.

### Step H — codePointAt undefined (2 tests)

`src/codegen/string-ops.ts` L3462-3560: replace the plain-NaN OOB result with
the dedicated undefined f64 sentinel (`undefSentinel: true` ValType +
`emitIsUndefF64`, the same machinery `compileStringIntegerArg` reads at
L2404/L2423-2431) so `=== undefined` / `??` observe undefined; js-host got
this in #2004 — mirror its result-kind decision for the standalone lowering.

### Step K — padStart/padEnd Symbol fill (2 tests)

`src/codegen/string-ops.ts` L3215-3217 and L3250-3252: replace the bare
`compileExpression + emitFlatten()` of the fill arg with
`emitArgAsNativeString` (L463) + flatten — its `tryThrowOnSymbolStringCoercion`
guard turns today's INVALID WASM (i32 symbol id pushed where
`(ref null $AnyString)` is expected) into the spec TypeError.

### Step I — fromCodePoint(Symbol) (1 test)

`compileFromCharCodeFamily` callers in
`src/codegen/expressions/call-builtin-static.ts` L750-777: reject
Symbol-typed args statically (the `tryThrowOnBigIntOrSymbolArg` pattern,
string-ops.ts L2330) and let Step D.2's runtime ToNumber Symbol arm cover the
dynamic case.

### Deferred — cluster J (3 tests)

`proto-from-ctor-realm.js`, `valueOf/non-generic-realm.js`,
`toString/non-generic-realm.js` need per-realm builtin identity; that is
#4274 (ready) + #4634. Do not attempt here; do not count them against this
issue's acceptance.

### What NOT to do

- No new host imports; every mechanism above is pure-Wasm
  (`__extern_get`/`__box_symbol`/`__call_fn_method_N` are in-module defined
  functions in standalone).
- Never edit `tests/test262-runner.ts`, HANGING_TESTS/skip lists, or
  `scripts/*-baseline.json` / `scripts/ir-fallback-baseline.json`.
- Do not "fix" `String(sym)` to throw (only implicit ToString throws).
- Do not delete the #1474 refusal diagnostic wholesale — narrow it to the
  forms Step A still cannot dispatch.
- Do not enqueue/re-enqueue PRs; run the ratchet gates before every commit
  (chained, unpiped — see CLAUDE.md "Hooks and ratchet gates").

## Acceptance criteria

- All 50 non-deferred tests in `.tmp/es2015/wp-string-current-fails.txt` pass
  via `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-string-current-fails.txt`
  (the 3 cluster-J paths in `.tmp/es2015/str-cl-J-realm-deferred.txt` are
  accepted as still-failing; everything else must pass). Full success = only
  those 3 remain.
- Every test in `.tmp/es2015/wp-string-passing-spotcheck.txt` (40 paths)
  still passes via the same probe.
- Source-ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## References

- #1369 — js-host @@split/@@replace/@@match protocol (done; standalone lane was out of scope there)
- #1474 / #1539 / #4016 / #2161 — the standalone search-value/RegExp lane this wave extends (`string-search-value.ts`, `regexp-standalone.ts`)
- #4439 — reflective match/search closure bodies (`string-proto-match-search.ts`), sibling pattern for Step A
- #2175 — standalone builtin-prototype readers / native-proto glue (Steps A.4, B.2, C)
- #1445 — js-host String.raw + arg coercion (done); #3147 — standalone String.raw (done; Step F fixes its materialization residue)
- #2004 — codePointAt NaN→undefined in js-host (done; Step H is its standalone twin)
- #5102 — Symbol.toPrimitive probe in object-runtime (Step D builds on it)
- #4484 — GetMethod(@@hasInstance) module-scan gate pattern (Step A.4)
- #3231 — GetMethod(@@dispose) runtime read shape (`disposable-runtime.ts`, the template for Steps A/G)
- #40 / #3900 — case-convert-native + generated tables (Step E)
- #4274 / #4634 — realm identity (cluster J owner)
- #2860 — standalone vs js-host test262 gap umbrella

## Results (wave 1 implementation, 2026-08-29)

Target list `.tmp/es2015/wp-string-current-fails.txt` re-verified on the branch
base before any edit: **53 failing** (52 FAIL + 1 COMPILE_ERROR) — the plan's
count reproduced exactly, nothing already fixed.

After this change-set: **29 failing, 24 fixed.** The 40-path
`wp-string-passing-spotcheck.txt` regression guard stayed 40/40 PASS throughout.

| cluster | planned | fixed | note |
|---|---|---|---|
| K padStart/padEnd Symbol fill | 2 | **2** | `emitArgAsNativeString` for the fill arg — the §7.1.17 guard turns invalid Wasm into the spec TypeError |
| I fromCodePoint(Symbol) | 1 | **1** | static Symbol/BigInt rejection in `compileFromCharCodeFamily`'s per-arg ToNumber |
| H codePointAt OOB | 2 | **2** | `UNDEF_F64_BITS` sentinel + `undefSentinel: true` result type (standalone only) |
| E astral case mapping | 4 | **4** | new `ASTRAL_{UPPER,LOWER}_CASE_RUNS` tables + surrogate-pair decode/re-encode in pass 2 |
| B normalize | 10 | **7** | validation + preamble; the 3 `return-normalized-string*` tests need real NFC/NFD tables (wave 2) |
| C `String.prototype[Symbol.iterator]` | 5 | **5** | `@@1` glue member with ROC + ToString + the code-point vec |
| G runtime IsRegExp | 3 | **3** | new `src/codegen/string-isregexp-guard.ts` — `Get(arg, @@match)` runs, abrupt propagates |
| A @@protocol dispatch | 15 | 0 | **not attempted** — see below |
| D indexOf ToPrimitive | 5 | 0 | **blocked** — see below |
| F String.raw fidelity | 3 | 0 | **not attempted** — see below |
| J cross-realm | 3 | 0 | deferred by the plan (#4274/#4634) |

### Deliberately left for wave 2

- **Cluster A (15)** — the runtime `@@match/@@search/@@split/@@replace` GetMethod
  lane. Calling an arbitrary user method needs the `__call_fn_method_N` arity
  dispatcher, which is filled at FINALIZE time and carries its own declared-arity
  ladder (`objlit-to-primitive.ts`); wiring it into six string-method arms plus
  the `<Builtin>.prototype[Symbol.X]` reflective READ fix is a change of its own
  size and risk. `split/limit-touint32-error.js` is in this cluster but is purely
  a coercion-ORDER fix; it still needs holding an un-coerced separator across the
  limit coercion, which `stageCoercedOperands` cannot express today.
- **Cluster D (5)** — MEASURED root cause, narrower than the plan's: the runtime
  ToPrimitive walker does find `@@toPrimitive` installed by ASSIGNMENT and does
  unbox `Object(Symbol())`/`Object("foo")` correctly (verified through the
  reflective `String.prototype.indexOf.call` lane, which already routes through
  `emitStringProtoToStringFlat`). What it cannot see is a `@@toPrimitive` written
  as a COMPUTED KEY IN AN OBJECT LITERAL — that literal compiles to a closed
  struct. Every one of the five files contains at least one such literal, so
  none of them flips until the literal lowering is fixed; routing indexOf's arg
  through the reflective ToString lane alone buys zero tests.
- **Cluster F (3)** — `materializeStructAsDynamicObject` snapshots the template,
  losing accessors installed later on the nested `raw` object.

Equivalence gate (`npm run -s test:equivalence:gate`): 1718 passing, 24 failing,
all 24 in the committed baseline — no new regressions. Source-ratchet gates all
green with the allowances granted in this file's frontmatter.

### Files touched

`src/codegen/string-ops.ts`, `src/codegen/case-convert-native.ts`,
`src/codegen/case-tables.ts` (generated), `scripts/gen-case-tables.mjs`,
`src/codegen/array-object-proto.ts`, `src/codegen/string-proto-tostring.ts`,
`src/codegen/expressions/calls.ts`, and the new
`src/codegen/string-isregexp-guard.ts`.

`scripts/gen-case-tables.mjs` grew an `astralPairs` scan; the astral tables were
SPLICED into `src/codegen/case-tables.ts` rather than regenerating the whole
file, because this container runs Node v22 while the committed BMP tables were
generated on Node v24 — a blind re-run would have silently downgraded the BMP
Unicode data (one Latin-Extended run differs).
