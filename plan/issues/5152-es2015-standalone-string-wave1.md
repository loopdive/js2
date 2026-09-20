---
id: 5152
title: "ES2015 standalone: string conformance wave 1"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-09-20
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
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-ops.ts
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
  # (#5152) The standalone array-like reader turns its f64 index into the
  # canonical property key with the existing native `number_toString` helper
  # before delegating to ordinary `__extern_get` / `__extern_has`. This is not
  # a new coercion matrix: it shares the runtime's established numeric-string
  # implementation so bag descriptors at keys such as `"0"` retain ordinary
  # Get/Has behavior.
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/case-convert-native.ts::emitNativeCaseConversion
  - src/codegen/case-convert-native.ts::makeStr
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
---

# ES2015 standalone: string conformance wave 1

LOC-growth allowance rationale (2026-08-28): the clusters below add a runtime
@@protocol dispatch lane, a reflective `String.prototype[Symbol.iterator]`
member, normalize validation + normalization tables, astral case-mapping
tables, and Symbol-rejection arms to the runtime coercion walkers — all in the
files listed in `loc-budget-allow`. Measured growth is expected and granted
for this change-set. `src/codegen/case-tables.ts` is GENERATED
(`scripts/gen-case-tables.mjs`) and grows by the new astral run tables.

Additional allowance rationale (2026-09-20): the bounded standalone
`String.raw` repair adds ordinary closed-struct reader arms in
`object-runtime.ts`, extracts their common `ToLength` tail into
`object-runtime-enumeration.ts`, and mirrors a successfully installed anonymous
accessor into the already-existing identity bag in `object-ops.ts`. The three
files are already over the source-size threshold; the allowance is limited to
these measured, reviewed additions.

Function-growth allowance rationale (2026-09-20): the function gate measured
only the three owning functions beyond their current thresholds:
`compileObjectDefineProperty` (1581/1475),
`fillExternArrayLikeStructArms` (530/425), and
`fillClosedStructExternGetArms` (534/470). Their added code is respectively
the one-evaluation successful-accessor bag mirror, the standalone ordinary
array-like-reader routing, and the descriptor-first closed-struct reader plus
Symbol boxing. The allowance is restricted to those three measured functions;
it does not update the shared function baseline or grant unrelated growth.

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

Current-main revalidation (2026-09-19): the pinned oracle-14 ES2015 selection
contains exactly **14 normalize rows: 11 pass / 3 fail**. The three failures
remain `return-normalized-string.js`,
`return-normalized-string-from-coerced-form.js`, and
`return-normalized-string-using-default-parameter.js`. At `4a6cbdf1ee80`,
`string-ops.ts` explicitly still returns the receiver unchanged after form
validation; no native normalization helper or generator exists in the checked
source. Thus Step B.3 remains real unimplemented normalization, not the
String.raw descriptor issue. Related #1541's proposed opt-in ICU provider is
historical design, not implemented support or sufficient acceptance for the
default standalone goal. No normalization implementation claim or test run
has been started in this continuation.

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

### 2026-09-19 Step F read-only revalidation plan

The pinned oracle-14 standalone baseline at baselines commit
`6c51eb29ef12208ac8f53ae99eea900b53f51a76` still fails all three Step F
originals: `template-length-throws`, `returns-abrupt-from-next-key`, and
`nextkey-is-symbol-throws`. Current source is upstream
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`.

Before implementation, audit the current template handoff to `__str_raw` and
identify the narrowest identity-preserving representation already supported
by ordinary reads. Do not repeat the historical diagnosis as current proof.
Read exact originals and trace descriptor lookup, segment coercion, and their
error order. Produce a bounded source-level correction plan with required
before/after controls, or identify an exact shared-owner dependency.

The parent issue is reserved without a live owner. Open #5748 changes Boolean
result annotations in `call-builtin-static.ts`; #5736 removes its old generator
prototype special case. Their inspected hunks do not change `String.raw`,
but both must be preserved. Generic literals, closure/class representation,
and runtime lifetime/layout owners remain reserved by the IR task. This
assignment is read-only: no production edits, test execution, claim takeover,
or publication until source ownership and the implementation plan are agreed.

### 2026-09-19 Step F audit outcome and corrected implementation boundary

Read-only Terra audit at `4a6cbdf1ee80` revises the historical diagnosis below:
the outer template materialization preserves the original nested `raw` struct
reference. Do not patch that materializer or introduce a raw-copy workaround.
`string-raw.ts` already performs raw/length/index reads in the right order and
contains a Symbol TypeError guard. The shared dynamic readers lose the values
before that guard can act.

`Object.defineProperty` stores anonymous closed-struct descriptors in an
identity-keyed carrier bag (`user-declared-structs.ts`, `carrier-bag-define.ts`).
In `object-runtime.ts`, `fillExternArrayLikeStructArms` instead reads physical
length/numeric fields: missing physical length returns zero without consulting
the bag; accessor-only numeric entries are missed. Both its index boxer and
`fillClosedStructExternGetArms` number-box non-boolean i32 fields, including
symbol-branded fields. The named reader also puts physical field arms before
the bag arm, so switching callers to it alone leaves descriptor precedence
wrong. These are source-level findings, not a new compiler run; confirm the
original Symbol field's emitted brand in permitted IR evidence before repair.

Revised implementation plan, pending shared-owner agreement:

1. In `fillClosedStructExternGetArms`, make present carrier-bag descriptors
   override physical closed fields and box symbol-branded i32 through the
   existing `__box_symbol` path. Preserve boolean/number distinctions.
2. In `fillExternArrayLikeStructArms`, route closed-struct length and index
   reads through ordinary property semantics before ToLength/coercion,
   preserving getter exceptions and Symbol identity. Reuse the existing
   Get/ToLength construction in `object-runtime-enumeration.ts` as appropriate;
   coordinate that file if edits prove necessary. Audit `__extern_has_idx`
   consistency rather than accidentally making descriptor visibility differ.
3. Prove the three exact originals plus the existing `tests/issue-3147.test.ts`
   and `issue-4397-native-semantic-js-host.test.ts` controls in both lanes.
   Add a getter redefining an existing physical `length`/`"0"` field so a
   bag-only fix cannot hide incorrect precedence. Retain abrupt ordering,
   deletion/reassignment/redefinition, nullish/empty-length, substitution, and
   zero-host-import controls.

No production edits, compiler runs, claims, or commits were made by the audit.
The coordinator has requested the exact reader/enumeration ownership from the
IR task before dispatch. The historical Step F materialization remedy below
is superseded for these three originals by this audit, not silently adopted.

Dispatch release: the IR owner explicitly cleared the two reader functions
and `object-runtime-enumeration.ts`, including checks against retained and
unpublished IR trees. Preserve adjacent #5753 tuple-reader import/splice and
unpublished wrapper-allocation ownership. Complete open-PR hunk locations also
show #5784 changes wrapper/enumeration-sort/vector/hole/for-in functions and
#5397 changes Reflect.set/set-vector functions, not these two reader owners.
The atomic upstream claim `5152:closed-struct-raw-readers` is verified for
`ttraenkler/codex-5152-raw-readers`, branch
`codex/5152-string-raw-audit-20260919`. The Terra auditor now implements in its
own existing worktree. Compiler/test execution waits for the RegExp lane's
lease handoff; preserve an untouched-base red run before candidate green.
Independent peer review and full scoped gates remain required before a PR.

The fixed acceptance manifest is
`plan/agent-context/5152-string-raw-es2015-paths-20260919.txt`: exactly 30
unique ES2015 String.raw paths in the pinned oracle-14 baseline, all verified
present in corpus `b363f29d3c43c626dc852744ad64a0b48a003693`. Baseline statuses
are **27 pass / 3 fail**. SHA-256:
`d7d2c223fb766dcc9ed460d3c2ddad520195dfc007db6d3c4f575575ba3e3827`.
Use this unchanged in fresh isolated standalone and host acceptance runs after
the focused controls; original successes must not regress. Corpus preparation
does not constitute a test execution or candidate pass claim.

### 2026-09-19 closed-struct raw-reader implementation evidence and remaining owner seam

The reader slice now makes the ordinary-read boundary explicit, but it is not
yet a complete fix for every statically lowered `Object.defineProperty`
accessor. The implemented reader-side changes are deliberately bounded to the
cleared ownership:

1. `fillClosedStructExternGetArms` checks a user-instance carrier bag by
   *presence* before any physical field arm, then uses
   `__reflect_get_receiver(bag, key, originalReceiver)`. This preserves
   descriptor precedence, makes a present `undefined` distinguishable from a
   miss, and gives a getter its original raw object as `this`.
2. `fillExternArrayLikeStructArms` sends user-declared closed structs through
   ordinary `__extern_get` / `number_toString` / `__extern_has` for length,
   indexed Get, and indexed Has. Its common `ToLength` tail lives in
   `object-runtime-enumeration.ts`, so the old `$Object` arm and the new closed
   receiver arm share coercion and clamping exactly.
3. Closed i32 values branded as Symbol are boxed through `__box_symbol`, not
   `__box_number`, before `String.raw` performs its existing ToString guard.

The focused fixture `tests/issue-5152-raw-readers.test.ts` adds exact-sentinel
controls for getter abrupt completion and order, physical-field overrides,
receiver identity, present-`undefined`, and static-metadata safety:
pre-definition, untaken/taken branch, and two same-shape instances. On the
safe bag-backed candidate the latter six temporal/per-instance controls pass;
the complete standalone result is `130022 / 131071`, with exactly bits
`1 + 8 + 16 + 1024` still absent. This is useful negative evidence: the reader
correctly handles descriptors that reach the bag, but does not fabricate a
descriptor from static metadata.

The exact remaining source dependency is the static accessor branch in
`src/codegen/object-ops.ts` (current lines 1760-2096). It executes
`ctx.classAccessorSet.add(accessorKey)` at lines 1777-1778, where `accessorKey`
is the compile-time `${structName}_${propName}` name,
synthesizes a bare `${structName}_get/set_${propName}` function, and returns
the receiver without an identity-keyed descriptor/bag write. `classAccessorSet`
is a compile-time `Set` created in `src/codegen/context/create-context.ts`, and
the optional S5C globals are keyed only by `(structName, propName)`; neither is
runtime proof that this object was defined, that a branch was taken, or that a
same-shape peer object owns the descriptor. `$shape` is immutable layout
identity, not a definition epoch. A reader fallback based on any of those
metadata carriers is therefore unsound and was intentionally removed.

The required shared-owner repair is narrow: on a *successful runtime*
definition through that static accessor branch, populate the existing
per-receiver descriptor/bag substrate observed by `__carrier_bag_has` /
`__carrier_bag_of`; do not copy the raw object or turn struct/key metadata into
descriptor truth. The existing runtime accessor applier path in
`emitExternDefinePropertyNoValue` (`object-ops.ts` from line 3019) and
`carrier-bag-define.ts` is the relevant established mechanism. Its owner must
preserve one-time receiver/key/descriptor evaluation, descriptor transition
validation, and direct static-access behavior while making the successful
definition observable to dynamic reads. This plan slice does not edit
`object-ops.ts`, runtime sidecars, or storage machinery.

### 2026-09-20 authorized static-accessor mirror plan

The reader-only boundary above is now extended by a single coordinated source
slice in `src/codegen/object-ops.ts`, limited to the standalone `__anon_*`
static-inline accessor branch (the branch that currently starts near line
1760). Before emitting the receiver body, call `ensureObjectRuntime`, reserve
the existing `__defineProperty_accessor` target, and flush late-import shifts.
Retain the already evaluated `objLocal`; materialize the literal key and each
getter/setter closure exactly once into externref locals. Call the existing
accessor applier with that saved receiver, key, closures, and the established
accessor flag encoding (including Get/Set-present bits 8/9); on its successful
result, drop the applier result and then publish those *same* closure locals to
the legacy per-struct globals.

This preserves receiver/key/closure single evaluation and lets the existing
carrier-bag define arm establish per-instance runtime presence. It must not
call `emitExternDefinePropertyNoValue`, because that helper recompiles those
operands. It does not add a carrier, sidecar, closure ABI, `String.raw`, or
reader fallback. The mirror's runtime branch is explicitly standalone-only;
the measured JS-host descriptor snapshot remains 66528, but no byte-for-byte
host-output comparison is claimed. Direct typed
property reads still rely on pre-existing compile-time
`classAccessorSet`/per-shape globals and are explicitly out of this slice's
lifecycle guarantee; only dynamic reads such as `String.raw` are claimed.

Fresh Node 24, standalone, isolated original-row evidence on the safe reader
candidate (all artifacts have an empty Wasm import list):

- `built-ins/String/raw/nextkey-is-symbol-throws.js` — **pass**.
- `built-ins/String/raw/template-length-throws.js` — **fail**: expected the
  Test262Error accessor throw, but no exception occurred.
- `built-ins/String/raw/returns-abrupt-from-next-key.js` — **fail** on the
  strict rerun: `TypeError: Cannot assign to read only property`.

The isolated runner output is retained at
`/private/tmp/js2-5152-raw-three-standalone-candidate-20260919.log`; the
primary/strict compiler import audit is retained at
`/private/tmp/js2-5152-raw-three-imports-20260919.log` and reports `imports: []`
for all four emitted variants. This is a real Symbol original-row gain only,
not a three-row or 30-path pass-rate claim. The known compiled-host baseline
remains 28 pass / 2 non-pass across the 30-path manifest; it was not rewritten
or represented as parity by this reader slice.

Same-base safeguard: a fresh Node 24 one-row `runTest262File` execution using
the untouched `4a6cbdf1` coordinator compiler source returns **fail** for
`nextkey-is-symbol-throws.js` (the expected TypeError is not thrown), with
`success: true`, `imports: []`, and one diagnostic. The coordinator worktree
has no populated corpus checkout, so the temporary audit launcher remapped only
its `test262/` *readFileSync* corpus reads to the pinned shared corpus; compiler
and test-runner modules themselves remained the untouched coordinator source.
This is a fresh authoritative one-row runner invocation, not a claim that a
literal maintained `--isolate` command was run from that unpopulated checkout.
The exact diagnostic is a **warning**:
`IR path failed for $DONOTEVALUATE: function typeIdx parity mismatch: IR=132,
legacy=50 — keeping legacy body [IR-FALLBACK]`. The current candidate's exact
Symbol assembly likewise reports `success: true`, `imports: []`, and the same
single warning. Therefore the evidence establishes a same-base Symbol verdict
delta but makes no diagnostics-clean claim. Durable logs are
`/private/tmp/js2-5152-raw-symbol-baseline-4a6-20260920.log` and
`/private/tmp/js2-5152-raw-symbol-candidate-errors-20260920.log`.

### 2026-09-20 frozen reader/mirror checkpoint, validation boundary, and residual

The source candidate is now deliberately frozen outside gate-fixes. It has four
cooperating, standalone-only pieces:

1. `fillClosedStructExternGetArms` consults a live carrier-bag descriptor by
   presence before a physical field, calls `__reflect_get_receiver` with the
   original receiver, and boxes a symbol-branded i32 with `__box_symbol`.
2. `fillExternArrayLikeStructArms` routes admitted user shapes' length/index/
   has-index operations through ordinary `__extern_get`, `number_toString`, and
   `__extern_has`; `buildArrayLikeToLengthFromExternref` is the common ToLength
   tail shared with the `$Object` arm.
3. The static inline accessor path mirrors only a successful standalone
   `__anon_*` definition into the existing identity bag. It evaluates receiver,
   key, and closures once; rejects an unliftable supplied getter/setter rather
   than storing null; applies `__defineProperty_accessor`; and only then
   publishes the legacy globals. No raw-object copy, static metadata fallback,
   carrier allocation, or JS-host change is involved.
4. The ordinary array-like routing is gated by `ctx.standalone`. This restores
   native-first's pre-existing physical-reader boundary: an initial ungated
   candidate returned `""` for the native-first `String.raw({raw:{length:2,
   0:"a",1:"b"}}, "X")` control; the corrected route returns `"aXb"`.

Measured candidate evidence (Node 24, fresh isolated standalone runs) is:

- exact three originals: **2 pass / 1 fail** — `template-length-throws` and
  `nextkey-is-symbol-throws` pass; only the delete/reassignment half of
  `returns-abrupt-from-next-key` fails;
  `/private/tmp/js2-5152-raw-three-final-20260920.log`.
- immutable 30-path manifest: **29 pass / 1 fail / 0 skip**, with that same
  one original remaining;
  `/private/tmp/js2-5152-string-raw-30-final-20260920.log`.
- the standalone fixture's complete ordinary-reader mask is **131071**, and
  all generated artifacts in this lane have `imports: []`.
- the direct Node oracle also returns **131071**. The untouched-`4a6` A/B
  launcher records the historical standalone mask **129478**, direct Node
  **131071**, host full-source strict-setter throw, host delete-excluded mask
  **66528**, and native-first `"aXb"` at
  `/private/tmp/js2-5152-reader-fixture-base-20260920.log`.

The fixture's JS-host case is intentionally a **baseline snapshot**, not a
positive compatibility or parity claim. For the source with the known
delete/reassignment sequence excluded, untouched `4a6` produces **66528**;
the asserted missing descriptor bits are
`1/2/8/16/1024/2048/4096/8192/16384/32768`. The full host source still throws
the pre-existing strict setter error. The focused run after the native-first
gate was 4/5 solely because this case still expected the standalone mask;
`tests/issue-5152-raw-readers.test.ts` now asserts the documented 66528
baseline. Its final direct run is **5/5** at
`/private/tmp/js2-5152-raw-readers-vitest-after-coercion-local-20260920.log`.
It must never be reported as full host parity.

The final direct TS7 invocation against the shared installed dependencies
passed: `/private/tmp/js2-5152-typecheck-ts7-final-20260920.log`.
The package script itself cannot resolve this isolated worktree's absent local
`node_modules`; that is a worktree provisioning limitation, not a TS result.

#### Remaining original: anonymous bag deletion, not a reader regression

The last standalone original is a shared delete/set residual. A targeted
diagnostic gives compiled standalone **43** versus direct Node **51**:
the first accessor throw and `delete` result are observed, but the subsequent
assignment is refused. The durable helper map is
`/private/tmp/js2-5152-delete-lifecycle-helper-map-v2-20260920.log`.

Source/WAT attribution is exact:

- `typeof-delete.ts` sends `delete obj.raw["0"]` to `__delete_property`.
- `__carrier_bag_delete` is reached, but its finalizer currently has closure,
  generator, vec, and Error lookup arms only. It has no anonymous-instance
  arm, returns `-1`, and `__delete_property` takes its historical non-object
  `return 1` fallback without removing the bag accessor.
- The later strict assignment follows `assignment.ts` →
  `__extern_set_strict` → `__reflect_set` → `__extern_set`; the still-live
  getter-only bag entry produces the shared refusal result and the observed
  TypeError. `object-runtime-strict-set.ts` is only the correct consumer of
  that refusal and is not an edit target.

No deletion code is included in this reader/mirror checkpoint. A separately
owned true-expando follow-up may need `carrier-bag-delete.ts` **and an
explicitly coordinated provenance-registry/API seam**; neither file set nor
implementation is authorized by this checkpoint. Its source-reviewed plan is:

1. Publish this frozen reader/mirror repair first. Then authenticate actual
   anonymous-*literal* provenance; neither the `__anon_` naming convention nor
   a structural type/shape match is proof that a receiver is eligible. The
   existing `object-literal-carrier.ts` AST-to-carrier private `WeakMap`,
   strict-method allocation recorder, and insertion-order map are not a
   complete enumerable finalizer registry (the latter two omit property-only
   or empty literals). They must not be silently substituted for that proof or
   widened without coordinated ownership.
2. Only after an authenticated registry design exists, enumerate its concrete
   allocated candidates at FINALIZE and match both Wasm type and logical
   collision stamp through `buildShapeGuardedArm`; type-only matching is
   insufficient for canonicalized shapes. The existing pipeline stamps shapes
   before `fillCarrierBagDelete`, but a candidate list alone remains
   insufficient admission evidence.
3. Look up, never ensure, the receiver's existing closure bag. Retain the
   current `-1/0/1` not-handled/refused/deleted protocol and delegate a
   successful admission to existing `__delete_property`, rather than copying
   configurable/count logic or widening `IS_INSTANCE_EXPANDO_CARRIER`.
4. Before delegation, compare the normalized stored own-entry key after
   `__obj_find` against the receiver's exposed physical fields using
   `exposedClosedStructFieldName`; do not re-coerce a user-observable key or
   use value-undefined as absence. `isInternalStructFieldName` metadata must
   preserve legal `$`/`__` user keys. A physical collision deliberately remains
   unhandled: deleting its overlay could resurrect stale physical data.
5. Preserve #5753's class arm, arm order, retained-marker authentication/count
   repair, builtin function metadata precedence, and generator/vec/Error
   routes. That arm replaces `fn.locals` with its own bag plus locals 3/4/5,
   so any anonymous scratch locals must be appended after that actual
   replacement. Do not mint late helpers/types/imports or share instruction
   trees across arms; prove the no-class/no-closure/no-vec/no-Error demand case
   still reserves the helper when an authenticated anonymous candidate exists.
6. Required follow-up controls include the exact configurable-accessor
   delete/reassign original; accessor and data true expandos; non-configurable
   sloppy false and strict TypeError; repeat delete; missing bag; independent
   same-shaped objects; physical-override non-resurrection; class retained
   marker; function name/length and generator routes; accessor non-invocation;
   and Symbol-versus-string keys. Compare against untouched base with the same
   runner, then rerun all 30 String.raw originals.

The verified IR task confirms no active anonymous-expando writer or pending
fix to await. This is a handoff specification, not runtime proof or deletion
implementation approval; `object-runtime.ts`, `typeof-delete.ts`,
`object-runtime-strict-set.ts`, class tombstones, and the generic instance
classifier remain out of the follow-up until an authenticated registry design
is independently owned and reviewed.

#### 2026-09-20 provenance-marker proposal — held by IR; do not implement

**Status (2026-09-20).** IR explicitly put the marker/layout direction on hold.
The proposal below is retained as historical investigation, not an approved
implementation plan: do not add a registry, marker field, ABI receipt, finalizer,
or allocation patch walk from it. In particular, a FINALIZE-time candidate cannot
be used to reserve `__carrier_bag_delete` after `__delete_property` has already
baked its optional call. The existing side-bag route is audited separately below.

The existing `object-literal-carrier.ts` map is useful evidence but cannot be
the deletion admission itself: it is a private, non-enumerable
`WeakMap<ObjectLiteralExpression, typeIdx>`, populated by
`compileObjectLiteralForStruct`. It has no finalizer snapshot, and
`compileWidenedEmptyObject` emits its own closed `struct.new` without using it.
Even an iterable copy of that map would prove only that *some* literal used a
canonical type. It would not distinguish a later copied/manual/nonliteral
allocation of the same Wasm type. The existing strict-method recorder shows the
same constraint explicitly: its IR token is construction-site provenance, but
it deliberately ignores property-only literals and thus cannot be repurposed
as this registry.

Historical fail-closed seam (rejected for this follow-up; retained for the
provenance constraint it established):

1. `object-literal-carrier.ts` owns a per-`CodegenContext` allocation registry,
   held in module-private `WeakMap`s rather than a new shared context field.
   `recordClosedObjectLiteralAllocation(ctx, structNew, literal, typeIdx)` puts
   a primitive `objectLiteralAllocationToken` on the actual `struct.new` and
   records its exact literal/type pair. The companion
   `requestClosedObjectLiteralDeleteProvenance(ctx, typeIdx)` is demand-only;
   it records a type requested by the already-existing standalone anonymous
   accessor-mirror path, not a claim that every instance of that type is a
   literal.
2. `literals.ts` is the only producer integration: call that recorder from
   `pushStrictMethodLiteralAllocation` for every
   `compileObjectLiteralForStruct` allocation, and from
   `compileWidenedEmptyObject` immediately before its direct `struct.new`.
   The latter is required for empty/property-only widened literals. Open
   `$Object` literals, host/accessor literals, and any construction path that
   does not carry this exact token stay unadmitted.
3. `object-ops.ts` adds only one demand registration, inside the existing
   successful standalone anonymous accessor-mirror branch, after its resolved
   `structTypeIdx` is available. It must not broaden that branch, use an
   `__anon_` name as runtime proof, or change receiver/closure evaluation.
   At finalization the request is intersected with actual recorded literal
   allocations; a requested type with no such allocation produces no marker,
   no delete arm, and no new behavior.
4. `object-literal-carrier.ts` also owns
   `finalizeClosedObjectLiteralDeleteProvenance(ctx)` and its immutable
   `closedObjectLiteralDeleteCandidates(ctx)` snapshot. For each demanded type
   with an exact recorded allocation, finalization appends a compiler-private
   immutable i32 marker field and patches every `struct.new` of that augmented
   type: only an instruction whose token resolves to the same literal *and*
   type receives its nonzero marker; all other allocations receive zero. The
   marker field index is held in a private side table, never rediscovered by a
   `$`/`__` name, because those are legal user keys. The patch walk must cover
   functions, globals, nested instruction arrays, and retained inline bodies;
   shallow IR clones preserve the primitive token exactly as the existing
   strict-method mechanism requires.
5. `index.ts` owns only the two pipeline placements. Invoke this finalizer
   after `resolveAndRecordShapeStamping` (so its candidate snapshot can carry
   the final logical shape guard) and before the first
   `fillObjVecReflectionHelpers`/`fillCarrierBagDelete` consumer in both the
   single-source and multi-source finalization pipelines. It must not mint late
   helpers, imports, or types. The marker is appended after any existing shape
   stamp; the snapshot records the authoritative marker field index plus the
   existing shape id/index.
6. `carrier-bag-delete.ts` is a consumer only. It receives the immutable
   candidate snapshot and adds a lookup-only arm guarded by exact Wasm type,
   final logical shape (`buildShapeGuardedArm`), and nonzero provenance marker
   before calling the existing `__closure_bag_lookup`. It retains the current
   `-1/0/1` protocol and delegates deletion to `__delete_property`. Before
   delegation, it obtains the existing entry via `__obj_find` and compares that
   stored normalized key against the candidate's exposed physical fields via
   `exposedClosedStructFieldName`/`isInternalStructFieldName` and the existing
   flattened native-string equality path. A physical collision remains
   **not handled**; no key is re-coerced and no `undefined` value is used as an
   absence test. Any missing provenance, marker, bag, entry, or shape metadata
   also remains `-1`.

This historical design correctly identified that type-only provenance is not an
allocation proof, but it does **not** authorize a type-name or type-only fallback.
It is superseded for this slice by the receiver-identity-bag audit below. No
source or test execution has been performed for the held design.

#### 2026-09-20 existing identity-bag audit — marker-free anonymous delete arm

The current runtime already has a per-receiver authentication fact that the
marker proposal did not use. In standalone/WASI, `ensureObjectRuntime` first
reserves `__closure_bag_lookup` / `__closure_bag_ensure`, then carrier visibility,
class tombstones, and instance props; only later does it construct
`__delete_property`, whose `reserveCarrierBagDelete` call bakes the optional
carrier-delete call. Thus the needed lookup and delete slots are already stable
before the caller body exists; no late demand, import, helper, or ABI-layout
mutation is needed.

`__closure_bag_ensure` records `{ key: eqref receiver identity, bag: $Object }`;
`__closure_bag_lookup` returns that same bag only after `ref.eq` with the original
receiver. The native `__defineProperty_accessor` and value twin already route a
user-instance receiver through `defineCarrierBagSubstitutionArm`, which tests the
existing instance substrate, creates or reuses this identity-keyed bag before the
ordinary `$Object` descriptor path validates and applies the definition.
`__obj_find` then proves a live *own* entry in that exact bag: it skips
`FLAG_TOMBSTONE`, so neither an absent entry nor a deleted entry is admitted, and
it never infers absence from the stored value (including `undefined`). The reader
checkpoint already consumes this same fact: `fillClosedStructExternGetArms` gives
a live bag descriptor precedence over a physical field and uses
`__reflect_get_receiver(bag, key, original)` to preserve accessor `this`.

IR confirmed that this is a consumer-only seam with no conflicting producer or
layout owner. That is ownership clearance, not blanket semantic acceptance; the
following source admission proof is the implementation boundary. The narrow
candidate is consumer-only in `carrier-bag-delete.ts`:

1. Build a private list of existing anonymous closed-shape entries carrying the
   already-established `typeIdx` plus `$shape` id/index when canonicalization
   requires it. This is a static dispatch list, **not** a new generic carrier
   predicate and not a claim about literal allocation provenance. The runtime
   admission remains the exact receiver's live bag entry.
2. Place its lookup-only arm after the existing closure, native-generator, vec,
   Error, and #5753 class arms. The class arm retains its own retained-marker
   repair and locals 3/4/5; any new scratch locals must be appended after that
   actual replacement. No change may widen `IS_INSTANCE_EXPANDO_CARRIER`,
   `IS_CLASS_INSTANCE_CARRIER`, or the closure/generator classifiers.
3. On a type-and-shape hit, call the existing `__closure_bag_lookup`; null or a
   non-`$Object` bag returns `-1`. Call the existing `__obj_find` and return
   `-1` for no live entry. This both prevents cross-instance effects and makes a
   failed/untaken definition inert.
4. Before delegation, read the **stored** key from that `$PropEntry`, rather
   than replaying the caller key after lookup. A string entry is flattened and
   compared through the existing native string equality helper against every
   exposed physical own-field name of the matched shape. A collision returns
   `-1`: deleting an overlay while leaving a physical field would resurrect
   stale storage. A physical `@@…` name is declined wholesale because it can
   mean a well-known Symbol slot which the string-only comparison cannot prove
   distinct. Field filtering must use `exposedClosedStructFieldName` plus
   `isInternalStructFieldName`, so legal user `$`/`__` keys are not silently
   erased as compiler internals.
5. Only then delegate to the existing `__delete_property(bag, storedKey)`, preserving
   its `-1/0/1` protocol, configurability refusal, tombstone/count bookkeeping,
   and strict-mode caller behavior. There is no copied delete algorithm.

This explains why a nonliteral receiver of an admitted anonymous type can be
safe without a marker: the bag is keyed to that concrete receiver, and a live
entry whose stored key is not any physical own field is a true expando regardless
of which allocation path produced the receiver. A receiver without a bag, without
a live entry, with a physical collision, or without an exact logical shape remains
unhandled and retains current behavior. This is deliberately narrower than a
claim that every `__anon_` allocation is a literal.

**Implemented source admission (revised controls await a fresh test lease).**
The selector is intentionally a static inventory gate, not a runtime `__anon_`
name test:

1. It runs only in standalone/WASI and declines every non-undefined
   `linkBrandRoleOf(ctx)` result, matching the branding finalizer's actual
   consumer/provider classification rather than duplicating its flags. A linked
   peer can contribute a canonical twin outside this module's inventory; this
   slice preserves the old `-1` route rather than relying on an implicit
   cross-module receipt.
2. Each candidate must be one exact `__anon_` registry entry: its
   `structMap`/reverse-map identity is one-to-one, `typeDef.name` agrees with
   the map key, and `typeDef.fields === ctx.structFields.get(name)`. Missing
   fields, aliases, a nominal parent/child edge, a `noBrandShapeTypes` entry,
   or any fnctor cold/layout registration declines the whole candidate.
3. The candidate must be a bare type after the `__vec_base` shape-brand anchor.
   This helper is filled after `resolveAndRecordShapeStamping` and before the
   final `brandCollidingShapeTypes` pass in both compile pipelines. A surviving
   candidate is therefore either unique or gets the existing trailing nominal
   brand before encoding; a static `$shape` guard is additionally required when
   a logical collision stamp exists. The finalizer's own no-brand/supertype/
   anchor exclusions match this selector, so an unknown canonical or subtype
   state stays unhandled rather than widening `ref.test`.
4. Physical inventory walks every recorded field, using `!== undefined`, not
   truthiness: `""` is physical, and recorded `$…`/`__…` keys remain physical
   while compiler bookkeeping stays hidden. A recorded `$constructor` carries
   both its raw spelling and the dynamic reader's exposed `constructor`
   spelling. A physical `@@…` name declines the entire candidate, because the
   compiler may use that spelling for a well-known Symbol field. Every admitted
   comparison literal is preflighted from an already-materialized global/helper;
   FINALIZE never mints a literal global or oversized helper. The stored
   `$PropEntry.key` is flattened only after `__obj_find`, then becomes the
   delegated delete key so this new arm does not add a caller-key coercion
   replay. This is not a blanket claim that the existing lookup performs only
   one coercion for every possible external key.
5. The arm calls lookup only; it never ensures a bag. It records a candidate
   ordinal only after a non-null identity lookup, retains `-1/0/1`, and invokes
   the existing `__delete_property` only after a live entry and no physical-key
   collision. A collision returns `-1`, so it cannot delete an overlay and
   resurrect a stale slot.

`ensureObjectRuntime` reserves closure-bag helpers unconditionally in the
standalone/WASI path before it emits `__delete_property`; that emission calls
`reserveCarrierBagDelete` before its own call site is baked. Thus an
anonymous-only module already has a reserved helper. The fill gate names the
anonymous arm independently so a closure/vec/Error arm cannot conceal a
no-demand failure.

The implementation adds only the private candidate collector, lookup arm, and
stored-key collision screen in `carrier-bag-delete.ts`; it does not add a
context field, generic classifier, sidecar, marker, ABI receipt, producer, or
layout mutation. Its scratch locals are appended from the actual local count.
The published branch does not yet contain #5753's class retained-marker hunk.
An actual `cddba56b` composition worktree is still required: its class arm and
retained-marker path must remain ahead of this arm and retain locals 3/4/5;
only then may this slice append its locals from the resulting list.

The first focused lease attempt was intentionally treated as fixture
preflight, not a behavior verdict. Its direct `const first = { ... }` /
`const second = { ... }` receivers were deliberately promoted by the
growable-literal pass to open `$Object` carriers after their dynamic
define/delete operations. The emitted WAT showed both receiver locals as
`externref`, rather than an `__anon_*` type, so the three observed fixture
failures could not establish an anonymous-arm defect. That preliminary run
settled 7/10 tests; it has no durable green/red claim or retained acceptance
log. The replacement sources bind the nested `raw` value of an outer template,
matching the original `indexOnly` allocation shape instead of a direct mutable
receiver literal.

The revised fixture adds an intended WAT admission assertion for the original
`RAW_READER_SOURCE` index-only receiver: numeric structural producer/store
(`struct.new` or outer-template `struct.get`, including plain temporary
transfers) and `ref.test` operands must be mapped back through the explicit
type table, then tied to the matching `__carrier_bag_delete` arm. This is meant
to provide a reviewable all-or-nothing physical-literal-materialization proof
for the target receiver; the source uses pure `selectNativeStringLiteral`
lookup and declines missing globals/helpers rather than finalizing a new
literal helper.

The first revised-fixture run was a **diagnostic preflight, not acceptance**:
Node 24 direct Vitest at
`/private/tmp/js2-5152-anon-delete-revised12-20260920.log` settled **6 pass /
6 fail**. The ordinary-reader runtime mask itself still passes, but the
structural probe found no WAT local named `indexOnly`; compiler locals are
generated names and its type operands are numeric. A second probe saw WAT
formatter label `type66`, which is likewise not evidence that the receiver is
not anonymous. Those assertions need a persisted WAT artifact and a structural
producer-to-slot-to-helper identity trace, not source-local-name or formatted
type-name matching.

The same run also exposed a TypeScript-only `PropertyKey` rejection in the
coercion fixture; its source now casts **only the key** (`firstKey as any` /
`secondKey as any`) and retains concrete receiver inference, so it has not
silently selected the open-object path. The strict-delete invalid-Wasm,
physical-field exception, and Symbol snapshot results are unclassified until
each is paired against the exact untouched `35e040c` base. No result from that
preflight is attributed to the anonymous delete helper.

At the next explicit compiler/test lease, run first the exact original
`built-ins/String/raw/returns-abrupt-from-next-key.js` once on this candidate
and once on an untouched `35e040c` compiler/harness. Then pair the three
unclassified fixture cases against that same base before changing their
expectations. For the structural probe, set `JS2WASM_5152_WAT_DIR` to a
dedicated temporary directory: the fixture writes each successful `emitWat`
artifact there before it evaluates its assertions. Preserve that artifact and
derive the producer-to-slot-to-helper trace from it; a passing
`RAW_READER_SOURCE` runtime mask alone does not establish closed-carrier
admission.

Required lease-time controls are: the exact delete/reassign String.raw original;
the exact `indexOnly` numeric-WAT type/ref-test admission proof; an
anonymous-only, concretely inferred data-expando module with no user closure/vec
demand plus receiver-local WAT construction/ref-test evidence; accessor/data
true expandos; non-configurable sloppy/strict behavior; repeat/missing delete;
independent same-shaped objects plus a nonliteral allocation; public operator
and Reflect object-key coercion counts; noBrand/super/alias/layout and
linked-decline structural probes; and unchanged class retained-marker, fnctor,
generator, closure, vec, and Error lanes. Physical `length`, `""`, `$…`,
`__…`, raw `$constructor`, exposed `constructor`, and Symbol.iterator/`@@iterator`
controls are deliberately labeled **nonconforming baseline snapshots**. Their
stage and payload must be observed separately before any preservation assertion
is accepted; they are not a claim that physical descriptor deletion is now
ordinary-delete complete. The revised 12-test fixture keeps
`Reflect.deleteProperty` refusal and strict operator throwing as separate
assertions; its corrected rerun waits for the next compiler/test lease.

#### 2026-09-20 paired residual receipt and fixture-boundary correction

The exact original row has now been run against the same compiler base rather
than inferred from the earlier fixture:

- candidate, this anonymous-delete worktree:
  `/private/tmp/js2-5152-return-abrupt-candidate-delete-35e-20260920.log` —
  **1 pass**;
- detached untouched `35e040c08ed10f793faf26bb0f0eac55be662627`:
  `/private/tmp/js2-5152-return-abrupt-base-35e-20260920.log` — **1 fail**,
  `strict rerun: TypeError: TypeError: Cannot assign to read only property`.

That is one localized original-row gain. It is not a frozen-30 result, a
whole-issue completion claim, or artifact/import proof: the isolated Test262
runner reports the row verdict but not the emitted module imports. A later
candidate rerun will set `JS2WASM_DUMP_WAT_FN=test,__carrier_bag_delete` and
`JS2WASM_DUMP_TYPES=<durable temporary prefix>` so the exact original's WAT
can be retained before any producer-to-slot-to-helper assertion is accepted.

The same source fixtures were paired against the candidate and detached 35e
base through `/private/tmp/js2-5152-delete-fixture-pair-20260920.mts`:

1. Strict non-configurable operator delete reaches the same standalone Wasm
   validation `CompileError` in both trees (including the reported offset).
   Direct strict Node returns `1`, so this is an unchanged compiler limitation,
   not a passing standalone assertion.
2. The physical-field fixture had equal compilation receipts and empty reported
   imports, but the original pair driver caught module construction,
   instantiation, and export invocation in one block. Its
   `instantiated:false` record is therefore **not** evidence of an
   instantiation failure and must not be cited as physical-delete behavior.
3. The Symbol/`@@iterator` fixture invokes and returns `1` in both trees. That
   is a baseline snapshot, not Symbol-delete conformance.

The focused TypeScript fixture now has an explicit `observeStandalone` helper
that records `compile`, `module`, `instance`, `invoke`, and `invoke-throw`
separately, including imports at the point a module is valid. The external
pair driver has the same staging repair. Positive true-expando tests are kept
separate from these named baseline limitations; no known limitation is folded
into an aggregate passing mask. The obsolete WAT checks that guessed a source
local name or interpreted formatter `typeNN` labels as anonymous-shape proof
were removed. Opt-in `JS2WASM_5152_WAT_DIR` capture writes WAT before any
review assertion, and the next run must inspect the artifact structurally
rather than recreate that label assumption.

The remaining lease-time order is intentionally bounded: capture the exact
original artifact and verdict; run the repaired focused fixture to classify
its limitation stages; then run the frozen 30-path standalone String.raw
manifest unchanged. The #5753 retained-class composition receipt remains a
separate prerequisite for deletion publication and is not implied by these
anonymous-only results.

#### 2026-09-20 terminal standalone receipts; publication boundary remains open

The ordered lease-time runs above are terminal on this candidate:

- exact `returns-abrupt-from-next-key.js` with artifact dump: **1 pass**, 0
  non-pass —
  `/private/tmp/js2-5152-return-abrupt-candidate-artifact-run-20260920.log`;
- repaired focused `issue-5152-raw-readers.test.ts`: **12/12 pass** —
  `/private/tmp/js2-5152-anon-delete-repaired-fixture-20260920.log`;
- frozen 30-path standalone String.raw manifest: **30 pass**, 0 non-pass,
  exit 0 —
  `/private/tmp/js2-5152-string-raw-frozen30-delete-candidate-20260920.log`.

The manifest is exactly the 30 unique corpus paths in
`plan/agent-context/5152-string-raw-es2015-paths-20260919.txt`, SHA-256
`d7d2c223fb766dcc9ed460d3c2ddad520195dfc007db6d3c4f575575ba3e3827`.
The raw30 receipt is a retention gain; it does not close #5152 or the
physical-delete residual.

The original artifact files are
`/private/tmp/js2-5152-return-abrupt-candidate-artifact-20260920` (physical
type listing) and the matching `.wat`. This WAT is an explicitly **filtered
one-function diagnostic**: it contains only `__carrier_bag_delete`, whose body
has `anonCandidate` / `anonEntry` and a `ref.test (ref 82)` arm; the type receipt
identifies `82` as `__anon_1` with its physical `length` field. That is useful
helper-admission evidence only. It cannot prove original binary imports or the
exact producer-to-slot-to-anonymous-helper path, because it does not contain a
named original `test`, `__module_init`, or callback/allocation body. A fresh
run must retain `WebAssembly.Module.imports` from the actual original binary as
a separate receipt and capture the relevant module-init/callback bodies before
that structural claim is accepted. Use `rg -a` when inspecting the saved WAT:
it contains NUL data. This trace remains a publication gate, not a
formatter-label substitution.

`/private/tmp/js2-5152-original-artifact-receipt-20260920.mts` is prepared
for that fresh run. It assembles the original Test262 harness source with the
same standalone compile options used by `runOriginalHarnessVariant`, writes the
exact primary/strict source hashes and full WAT, and records both compiler-
reported and `WebAssembly.Module.imports` manifests.

**Terminal full-artifact receipt.** The diagnostic subsequently ran on the
candidate and saved
`/private/tmp/js2-5152-return-abrupt-full-artifact-candidate-run-20260920.log`.
Both original-harness variants compiled successfully with the same one
`IR-FALLBACK` warning for `$DONOTEVALUATE`; each records
`reportedImports: []` and actual `WebAssembly.Module.imports: []`, plus these
source/binary SHA-256 pairs:

- primary source `82fb5616d323f3403890c1ca8e9371ef786528435cfee40c7049261f5dbfbe42`,
  binary `822fce6acbb7aca3fb3bdcafde9fb420370cdbdc27b6dc670b74e30f05a39f20`;
- strict source `f3b572e0884d42b7686acded4302f6daa5cc235cc274f488556536e1d7ab33ad`,
  binary `0d75c4370653fce936088df345c0fc4937a292bcba209afaff8fdb91782e9b29`.

The full strict WAT and exact assembled strict source are retained as
`/private/tmp/js2-5152-return-abrupt-full-artifact-candidate-20260920-strict.wat`
and `.source.js`. They establish the static lowering chain without relying on
a formatter local name:

1. The exact strict source constructs the only `obj.raw` nested literal at
   source lines 337–341 and executes `delete obj.raw['0']` at line 354.
2. The full WAT names type 82 `__anon_1` with its physical `length` field
   (line 60), and type 83 `__anon_2` with a `raw: (ref null 82)` field
   (line 61). `__module_init_chunk_0` constructs 82 then 83 and stores the
   outer value at lines 125193–125196.
3. That same chunk extracts `struct.get 83 0` to its delete receiver local at
   lines 125393–125397 and issues `call 170` at lines 125435–125437. Function
   170 is named `__delete_property`; its full body invokes function 169,
   `__carrier_bag_delete`, on the applicable non-vector carrier route. The
   helper includes the anonymous `ref.test (ref 82)` arm.

This is a static producer-to-slot-to-delete-helper receipt for the original
strict variant, not a runtime branch-trace claim. It removes the earlier
filtered-WAT ambiguity while retaining the independent row verdict and actual
import manifests.

The repaired focused file has eight positive checks and four deliberately
named baseline observations. The latter now record, without changing their
meaning, strict and coercion validation failures at `module`, the physical
case's guest `invoke-throw` with an opaque object payload, and the Symbol case's
`invoke` result `1`. The 12/12 count must never be summarized as 12
conformance successes. The physical payload is intentionally not claimed to
be an instantiation error or an ordinary-delete result.

A temporary candidate/base pair of a manually mirrored coercion program has
the same `module` validation error in both trees, but it is not an exact
extraction of the revised fixture source. It is diagnostic-only. The retained
pair driver now has an `exact-coercion` mode that extracts
`ANONYMOUS_EXPANDO_DELETE_COERCION_SOURCE` from this candidate test file and
passes that one source path to both compilers. That exact-source candidate/35e
pair is now terminal:

- candidate:
  `/private/tmp/js2-5152-delete-pair-candidate-exact-coercion-35e-20260920.log`;
- untouched 35e:
  `/private/tmp/js2-5152-delete-pair-base-exact-coercion-35e-20260920.log`.

Both compile successfully with `imports: []` and then fail at the same module
validation point, with the identical `function #50:"test"`, `fallthru[0]`,
`expected i32, got (ref null 46)`, and `@+55345` detail. The focused coercion
observation is therefore regression-cleared as an unchanged baseline
limitation, while still not counted as a compiled delete-semantics pass.

#### 2026-09-20 frozen #5753 class/anonymous composition receipt

The required composition was performed only in the disposable worktree
`codex-5152-anon-delete-5753-composition-20260920`, rooted at frozen
`cddba56b768f30eb5d9af29d2954dd69e2b534b5`. It preserves that checkpoint's
actual class retained-marker implementation: closure, generator, vec, Error,
class, then anonymous arm order; class locals 3/4/5; the retained-marker
branch before the common object lookup; and its existing `classArm` lookup
claim. The composition appends the anonymous scratch locals only after the
class replacement (6–9 when the class arm is present), and does not alter the
class helper or publish a copy of #5753-owned code.

The unchanged frozen class suite plus a disposable one-module joint control
passed **97/97** in 104.37 seconds:
`/private/tmp/js2-5152-5753-frozen-composition-20260920.log`. The joint module
contains both a class expando and two same-shaped nested `{ raw: { length: 1 } }`
receivers. It validates as a standalone module with no imports and returns the
direct-Node mask 63. To establish that this is not a vacuous alternate path,
the exact same compact fixture was run against an untouched detached `cddba56b`
compiler root. It intentionally failed its 63 assertion with actual **27**:
`/private/tmp/js2-5152-5753-composition-untouched-cdd-20260920.log`. The
36-point difference is exactly the two anonymous deletion observations (4 and
32); class deletion/physical-slot checks (1 and 2), raw `length` (8), and the
second receiver's pre-delete expando observation (16) remain in the untouched
result.

This is a frozen source-compatibility and attribution receipt only. Frozen
`cddba56b` predates the landed reader checkpoint and #5994, so it does not
substitute for latest-main integration, final frozen raw30 retention, or the
Array-HOF five-row retention run. The disposable source/test changes are not
part of this #5152 publication branch.

#### Required gates before publishing this reader/mirror checkpoint

When the compiler/test lease is next granted, run (and retain terminal logs
for) the following against this frozen source before any commit or PR:

1. `git diff --check`; the five-case focused fixture (including direct Node,
   standalone no-import, host baseline snapshot, and native-first control);
   then the exact isolated three rows and frozen 30-path standalone manifest.
2. Existing narrow reader regressions `tests/issue-3147.test.ts` and
   `tests/issue-4397-native-semantic-js-host.test.ts`, plus a fresh TS7
   invocation resolved from this worktree's canonical dependency source.
3. Normal quality gates: format check, lint, LOC/function budgets (adding only
   a gate-proven function allowance if required), coercion-site/oracle/dead-
   export ratchets, and the normal hooks. Do not bypass hooks or modify shared
   baseline files.
4. Independent peer review after the final diff and before publication. The PR
   describes **two original improvements and 29/30 standalone manifest rows**,
   not whole-#5152 completion; it remains draft if any required gate or
   mergeability condition is unresolved.

#### Terminal reader/mirror gate record (2026-09-20)

All commands below used the worktree's direct installed Node 24/tool binaries
where applicable; the normal commit/push hooks remain to be run without a
bypass after the temporary RegExp lease handback.

- Full Git-LFS-aware `git diff --check` passed. The focused fixture passed
  **5/5** both directly and through the normal changed-root runner (one changed
  root file). The final focused log is
  `/private/tmp/js2-5152-raw-readers-vitest-after-coercion-local-20260920.log`.
- The isolated three-original runner settled **2 pass / 1 fail** and the frozen
  manifest settled **29 pass / 1 fail / 0 skip**, both with only the documented
  delete/reassign residual. Logs are
  `/private/tmp/js2-5152-raw-three-final-20260920.log` and
  `/private/tmp/js2-5152-string-raw-30-final-20260920.log`.
- The narrow #3147 regression file passed. #4397's URI escape assertion fails
  identically on candidate and untouched `4a6`, so it is preserved as a
  baseline failure, not attributed to this change; logs are
  `/private/tmp/js2-5152-native-reader-regressions-20260920.log` and
  `/private/tmp/js2-5152-issue-4397-base-4a6-20260920.log`.
- TS7, Prettier, and Biome pass at
  `/private/tmp/js2-5152-typecheck-ts7-final-20260920.log` and
  `/private/tmp/js2-5152-format-lint-final-20260920.log`. LOC and function
  ratchets pass using only the measured allowances recorded in this issue;
  oracle and coercion ratchets pass, with `object-runtime.ts`'s one shared
  `number_toString` property-key call explicitly allowed.
- Dead-export preservation, codegen-fallback, stack-balance, host-import, and
  numeric-local checks pass. The dead-export tool retains its pre-existing
  strict modeled-closure unknowns for two nonliteral dynamic imports while its
  preservation contract passes; it is not claimed as retirement certification.

This is a **reader/mirror checkpoint**, not #5152 closure or full JS-host
parity. No deletion code, shared baseline update, skip-list change, or host
import is included.

#### 2026-09-20 landed reader receipt — immutable ES2015 baseline

The landed #5991 reader/mirror result was independently remeasured from
immutable baseline `950cf4b00bf4375742a5b6a6a84a5f39cf46eb7` using compiler
`d5e58586d1`. The generated JSONL has SHA-256
`d954ebc1c02232e8d99faa2cde1b2b8b6b30f4f9a4a44ebd34b595b1a3a976b1` and
contains 48,735 unique oracle-14 / honest / auto rows. Its ES2015 selection is
10,371 pass / 1,047 fail / 286 compile-error (11,704 total).

Compared with the prior `bb397` receipt, exactly two ES2015 status changes
exist: `template-length-throws` and `nextkey-is-symbol-throws`, each
fail-to-pass. No other ES2015 row changed. The raw receipt files are retained
at `/private/tmp/js2-es2015-baseline-20260920.uTtFjf/`. This records the landed
reader improvement only; anonymous-expando deletion and the remaining
`returns-abrupt-from-next-key` lifecycle residual remain pending.

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
