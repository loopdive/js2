---
id: 5142
title: "ES2015 standalone: regexp conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  # Wave-1 growth, rationale dated 2026-08-28 (see ## Results): the generic
  # §22.2.6.4 `flags` getter, the Annex B `compile` body + its call arm, the
  # well-known-symbol proto value-read arm, and the @@replace function-replacer
  # route are all measured emission growth in these files.
  - src/runtime.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/native-proto.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/native-regex.ts
  - src/codegen/regex-replace-fn.ts
  - src/codegen/regex/parse.ts
  - src/codegen/native-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/regexp-dynamic-pattern.ts
coercion-sites-allow:
  # The §22.2.6.4 `flags` getter's eight `ToBoolean(Get(R, <flag>))` steps. This
  # does NOT hand-roll a ToBoolean matrix: it CALLS the one shared native
  # `__is_truthy` helper (the standalone ToBoolean engine), which is the
  # sanctioned routing — the gate counts the new reference to it (2026-08-28).
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  # +6 lines: the `re.compile(…)` dispatch arm, added next to the existing
  # exec/test/toString RegExp arms in the same dispatcher (2026-08-28).
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #5142 — ES2015 standalone: regexp conformance wave 1

## Problem

182 of the 185 "regexp" work-package ES2015 tests still fail on the standalone
target — re-verified 2026-08-28 on head `86739f05` (3 of the day-old baseline
now pass: `Symbol.split/species-ctor-ctor-undef.js`,
`Symbol.split/species-ctor-species-undef.js`,
`call_with_regexp_not_same_constructor.js`). The standalone native RegExp
engine (#682/#1539) compiles `@@match`/`@@replace`/`@@search`/`@@split` to
closed-loop static cores that bypass the ES2015 **observable RegExpExec
protocol** entirely, and `RegExp.prototype[Symbol.*]` does not reify to a
usable function value. Closing these is required for the 100% ES2015
standalone goal (#4444 umbrella; #2161 is the standing RegExp residual
umbrella).

The `loc-budget-allow` grant above is deliberate (rationale dated 2026-08-28,
this issue): a runtime RegExpExec-protocol helper, observable lastIndex
Get/Set plumbing, real symbol-method closure bodies, a mutable-field
`$NativeRegExp` for `compile`, u-aware AdvanceStringIndex, and u-mode parser
strictness are measured growth in the listed files.

**Target list**: `.tmp/es2015/wp-regexp-current-fails.txt` (182 paths, written
2026-08-28 from a full re-run on head `86739f05`).
**Probe**: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(or individual test262-relative paths as args). Split lists >150 lines; each
Bash call timeout 600000; some tests take up to 20 s.
**Realm caveat**: 8 of the 182 (`*cross-realm*`, `proto-from-ctor-realm.js`,
`splitter-proto-from-ctor-realm.js`) need the QuickJS eval provider locally:
`bash scripts/quickjs-artifact/build.sh` (~3 min) first, else the probe
reports "quickjs provider is not built" instead of the real failure.

## Current failure clusters

Counts from a filename/error classifier over the 2026-08-28 re-run
(`.tmp/es2015/re-out-aa.txt` / `re-out-ab.txt`); rows sum to 182.

| Cluster | Count | Root cause (file:function) | Sample tests (`built-ins/RegExp/` unless noted) |
| --- | --- | --- | --- |
| 1. @@-method RegExpExec protocol bypass | 103 | `emitStandaloneRegExpReplaceCore` (src/codegen/regexp-standalone.ts:4315), `emitStandaloneRegExpMatchCore` (:3966), `emitStandaloneRegExpSearchCore` (:3812), `emitStandaloneRegExpSplitCore` (:4463) run closed loops (`__regex_replace` etc., src/codegen/native-regex.ts:2183) from position 0 on the static struct — no Get/Set of `lastIndex` on the receiver, no `Get(rx,"exec")` dispatch, no flag/arg/result-object coercion, code-unit-only empty-match advance (native-regex.ts:3161, :3408) | `prototype/Symbol.replace/y-init-lastindex.js`, `prototype/Symbol.match/exec-invocation.js`, `prototype/Symbol.replace/result-coerce-capture.js` |
| 2. @@-method reification broken | 27 | `RegExp.prototype[Symbol.x]` value-read yields `undefined` at runtime despite glue registration — `ensureRegExpNativeProtoGlue` (regexp-standalone.ts:5179) registers `@@7/@@8/@@9/@@10` but bodies are `ref.null.extern` placeholders (:5320–5327), `@@9` is mis-wired to `.test`'s i32 flag (:5277), and the companion seeder silently skips `@@` members when `__box_symbol` is absent (src/codegen/native-proto.ts:636–641) | `prototype/Symbol.replace/length.js`, `prototype/Symbol.split/species-ctor.js`, `prototype/Symbol.match/not-a-constructor.js` |
| 3. `RegExp.prototype.compile` missing | 16 | `compile` is a placeholder member (no-op, returns null-extern); `$NativeRegExp` fields `flags/prog/classTable/source` are `mutable:false` (`ensureStandaloneRegExpStruct`, regexp-standalone.ts:978) so in-place recompile is impossible; no flag/pattern re-validation → no SyntaxError | `annexB/built-ins/RegExp/prototype/compile/flags-string-invalid.js`, `.../pattern-string.js`, `.../pattern-regexp-flags-defined.js` |
| 4. `RegExp(regexpLike)` ctor semantics | 8 | §21.2.3.1 steps for non-RegExp objects not implemented: no `IsRegExp` via observable `Get(pattern, @@match)`, no `Get(pattern,'constructor')` short-circuit, no abrupt `Get source/flags` (RegExp ctor lowering around regexp-standalone.ts:2709/2798) | `from-regexp-like.js`, `from-regexp-like-get-flags-err.js`, `call_with_non_regexp_same_constructor.js` |
| 5. `@@replace` function-replacer refusal | 8 CE | `tryRefuseHostFreeRegExpReplacer` fires for `re[Symbol.replace](str, fn)` (regexp-standalone.ts:4626, :4330) although #4224's call-site walk `tryCompileStandaloneRegExpFunctionReplace` (src/codegen/regex-replace-fn.ts:322) already implements fn replacers for the `String.prototype.replace` form | `prototype/Symbol.replace/fn-invoke-args.js`, `fn-coerce-replacement.js`, `fn-err.js` |
| 6. ENV: cross-realm needs QuickJS | 8 | Not a compiler bug in this env — eval provider unbuilt; underlying failures expected to share clusters 1/2 roots | `prototype/global/cross-realm.js`, `proto-from-ctor-realm.js` |
| 7. `flags` getter brand-checks generic receivers | 5 | getter arm of `emitRegExpProtoMemberBody` runs `recoverRegExpStructFromExternref` (regexp-standalone.ts:5243) and throws, but §21.2.5.3 `flags` must work on ANY object via `Get(R,'global')`… in spec order | `prototype/flags/coercion-multiline.js`, `prototype/flags/coercion.js` |
| 8. u-mode pattern-syntax strictness | 4 | Annex B identity-escape fallbacks not disabled under `u` (src/codegen/regex/parse.ts:880–905 decimal/identity, :1064 `\c`, :1077–1092 lone `\u`); plus one annexB control-escape test trapping `unreachable in __gen_resume_invalidControls` (generator interplay — diagnose separately) | `unicode_restricted_identity_escape.js`, `unicode_restricted_identity_escape_alpha.js`, `annexB/built-ins/RegExp/RegExp-invalid-control-escape-character-class.js` |
| 9. dynamic-flags compile refusal | 3 CE | `staticRegExpFlags` null → `reportStandaloneRegExpUnsupported` (regexp-standalone.ts:818) even though a runtime compiler (`ensureDynamicStandaloneRegExpCompiler`, used at :2474) and a runtime-flag-aware match body (#4439, `RE_FIELD_FLAGS` read at runtime) both exist | `prototype/Symbol.match/coerce-global.js`, `builtin-infer-unicode.js`, `g-match-no-set-lastindex.js` |

Cluster-1 sub-shape (same classifier): 35 lastIndex/sticky/global semantics ·
31 misc protocol (≈10 `@@split` SpeciesConstructor observability, 6
`y-fail-return`, 8 subject/arg ToString coercion, 7 global-loop result
handling) · 14 flag-Get coercion · 12 `@@replace` result-object coercion · 9
dynamic `exec` dispatch · 2 u-advance-after-empty.

**Measured ground truth (probes in `.tmp/re-probe/`, 2026-08-28, head
`86739f05`)**:
- p4: `/./y` with `lastIndex=1` — `.exec` honors it (matched `b@1`, correct),
  `[Symbol.replace]` ignores it (returned `"xbc"`, spec `"axc"`). The exec
  lane's g/y lastIndex machinery (#1913, `emitRegexExecArrayCall` with
  `gyLastIndex:"runtime"`, regexp-standalone.ts:5298; deferred-raw slots
  `RE_FIELD_LASTINDEX{,_RAW,_RAW_PRESENT}` :906–912) exists and works — the
  four @@-method cores just never use it.
- p6: `re.exec = fn; re.exec('aaa')` — override IGNORED (`called=0`, builtin
  ran). No call site implements RegExpExec's Get-exec-then-call dance.
- p5: `Object.defineProperty(/a/,'global',{get}) `and expando
  `re.constructor = f` on a native regexp WORK in standalone (observable
  getter fired). The #2515 open-object companion substrate is already there —
  the @@-cores bypass it, they are not blocked by it.
- p2/p3: `typeof RegExp.prototype[Symbol.split]` folds to `"function"`, but
  the actual value-read (`var m = …; m.call(re,'abcde')`) is `undefined` at
  runtime — reification is a compile-time typeof fold only.

## Implementation Plan

Ordered by cluster count descending — partial completion maximizes yield.
General rules: standalone = zero new host imports (host imports only as
js-host-mode fast path); all new codegen type queries via `ctx.oracle`
(src/checker/oracle.ts), never the raw TS checker (oracle-ratchet gate).

**Step 0 — env prep**: `bash scripts/quickjs-artifact/build.sh` (~3 min) so
the 8 cross-realm tests report real failures. Re-run the full target list
once to establish your own base (`npx tsx .tmp/run-standalone.mts --list
.tmp/es2015/wp-regexp-current-fails.txt`, split in two).

**Step 1 — RegExpExec protocol core (cluster 1, ~103 tests).**
1. Add a runtime `RegExpExec(rx, S)` helper (new emit in
   src/codegen/regexp-standalone.ts, helpers in native-regex.ts) implementing
   §21.2.5.2.1 observably:
   - `Get(rx,"exec")` through the open-object dyn-read chokepoint (the same
     path that made probe p5 observable — see src/codegen/dyn-read.ts usage by
     the companion substrate). If callable and not the builtin singleton:
     call it, then require Object|null result else TypeError
     (`exec-return-type-invalid/valid`, `exec-err`, `get-exec-err`).
   - Else the builtin path: reuse `emitRegexExecArrayCall` with
     `gyLastIndex:"runtime"` + `regexpOverride` exactly as the reified `exec`
     member does (regexp-standalone.ts:5287–5312) — do NOT write a second
     matcher.
2. lastIndex observability: reads are `ToLength(Get(rx,'lastIndex'))` honoring
   the deferred-raw contract (`RE_FIELD_LASTINDEX_RAW*`, :906–912; abrupt
   `valueOf` must surface — `coerce-lastindex-err`, `g-init-lastindex-err`);
   writes go through the observable Set path so a `writable:false` lastIndex
   (via companion `defineProperty`) throws TypeError
   (`*-set-lastindex-err`, `y-fail-lastindex-no-write`). Sticky/global
   no-match ⇒ Set 0 (`y-fail-lastindex`, `y-fail-return`).
3. Rebuild the four @@-cores as the spec loops over RegExpExec:
   - `@@replace` (§21.2.5.8): non-global = single RegExpExec (sticky honors
     entry lastIndex — fixes `y-init-lastindex`); global = Set lastIndex 0,
     loop, u-aware advance on empty match. Per-result coercion via generic
     Gets when the result is not the builtin's trusted array:
     `ToLength(Get(result,'length'))`, `ToString(Get(result,'0'))`, position
     = clamped `ToInteger(Get(result,'index'))`, captures `ToString` unless
     undefined (`result-coerce-*`, `result-get-*-err`).
   - `@@search` (§21.2.5.9): previousLastIndex = Get; Set 0 semantics per
     ES2015; RegExpExec; restore lastIndex; return `Get(result,'index')` or
     -1 (`set-lastindex-restore`, `success-get-index-err`).
   - `@@match` (§21.2.5.6): non-global = RegExpExec result as-is; global =
     Set 0, loop collecting `ToString(Get(result,'0'))` into a plain array
     (NO `index`/`input` props — `g-success-return-val`), u-aware advance.
   - `@@split` (§21.2.5.11): `ToString` subject first (`coerce-string*`),
     SpeciesConstructor(rx, %RegExp%) via observable
     `Get(rx,'constructor')` → `Get(C,@@species)` (TypeError when C
     non-object / S non-constructor — `species-ctor-*`); construct splitter
     with flags+`y`; `ToUint32(limit)` BEFORE the flags read order the tests
     pin (`coerce-limit-err`); q-walk with splitter Set/Get lastIndex and
     u-aware advance (`str-*`, `last-index-exceeds-str-size`,
     `u-lastindex-adv-thru-failure`).
4. u-aware AdvanceStringIndex: the `pos = mend + (empty ? 1 : 0)` sites
   (native-regex.ts:3161, :3408; regex-replace-fn.ts:472; the new loops) must
   advance by 2 under the `u` flag when `pos` sits on a lead surrogate with a
   trail following (`u-advance-after-empty` ×2, `coerce-unicode`).
5. Perf guard: keep the existing closed-loop lanes for the
   `String.prototype.replace/match/split(re, …)` subject-form calls
   (receiver is a string — the RegExp-receiver protocol does not apply the
   same way and the equivalence suite covers those lanes); the @@-protocol
   form and any RegExp-receiver method call take the new loops. If profiling
   shows regression on playground examples, gate the slow loop on a runtime
   "companion overrides present" check but ALWAYS keep the g/y lastIndex
   struct writes.

**Step 2 — @@-method reification (cluster 2, 27 tests).**
- Fix the value-read: trace why `RegExp.prototype[@@N]` materializes as
  undefined despite `ensureRegExpNativeProtoGlue`. Known suspects: the
  companion seeder's silent `continue` when `__box_symbol` is missing
  (native-proto.ts:639), the demand gate in `nativeProtoSeederRegistry`, and
  the computed-symbol-key read path off `RegExp.prototype` (typeof folds at
  compile time — probe p1 vs p3 — so the read site recognizes the member but
  stages no closure).
- Replace the placeholder bodies (regexp-standalone.ts:5320–5327) with real
  ones that delegate to the Step-1 cores from locals (pattern to mimic: the
  `exec` member :5287–5312). Fix `@@9` (currently returns `.test`'s i32 flag,
  :5277) to full `@@search` semantics with a boxed f64 result.
- Brand policy: per spec the @@-methods require only `Type(rx) is Object` —
  TypeError for primitives (`this-val-non-regexp`), but a plain object
  receiver with its own `exec`/`constructor` must WORK via the protocol
  helper (`limit-0-bail`, `species-ctor-*` call `RegExp.prototype[Symbol.split].call(obj,…)`).
  Do not hard brand-check these four bodies.
- `name`/`length`: `REGEXP_METHOD_LENGTH` needs `@@8`/`@@10` = 2, `@@7`/`@@9`
  = 1; extend the `@@3 → "[Symbol.toPrimitive]"` display-name mapping
  (native-proto.ts:935–948) with `@@7`–`@@10` → `"[Symbol.match]"` etc.

**Step 3 — `RegExp.prototype.compile` (cluster 3, 16 tests).**
- Flip `flags/nGroups/prog/classTable/source/nScratch` to `mutable: true` in
  `ensureStandaloneRegExpStruct` (regexp-standalone.ts:978) — grep for
  `struct.get` consumers; no `struct.set` exists for them today so the change
  is additive.
- Body: ToString(pattern) / ToString(flags) in spec order with abrupt
  completions (`pattern-to-string-err`, `flags-to-string-err`); pattern-is-
  RegExp + flags defined ⇒ TypeError (ES2015 §B.2.5.1,
  `pattern-regexp-flags-defined`); validate flags (duplicates ⇒ SyntaxError,
  `flags-string-invalid`) and pattern (reuse
  `ensureDynamicStandaloneRegExpCompiler`, which already lowers real
  SyntaxErrors to runtime throws — regexp-standalone.ts:2523 comment); copy
  the freshly compiled struct's fields into the receiver in place, reset
  lastIndex to 0 (`pattern-regexp-immutable-lastindex` wants the observable
  Set TypeError from Step 1.2), return the receiver (`pattern-regexp-same`).

**Step 4 — `@@replace` function replacer (cluster 5, 8 CE).**
In `tryCompileStandaloneRegExpSymbolCall` (regexp-standalone.ts:4642–4654)
route `re[Symbol.replace](str, fn)` into
`tryCompileStandaloneRegExpFunctionReplace` (regex-replace-fn.ts:322) with
operands swapped (regex = receiver, subject = arg[0]) instead of the refusal
at :4626. The walk already handles under-arity replacers via
`__extras_argv`/`__argc` and ToString of the result — verify `fn-invoke-args`
argument order (matched, …captures, position, string) and strict/sloppy
`this` (`fn-invoke-this-strict/no-strict`: undefined vs global).

**Step 5 — `RegExp(regexpLike)` ctor (cluster 4, 8 tests).**
In the RegExp call/construct lowering (regexp-standalone.ts:2709/2798 region):
implement §21.2.3.1 for object patterns — `IsRegExp` = observable
`Get(pattern, @@match)` (`from-regexp-like-flag-override`: a defined-but-falsy
@@match makes it NOT a regexp); called-as-function short-circuit when
`Get(pattern,'constructor') === newTarget` returns pattern unchanged
(`call_with_non_regexp_same_constructor`, `from-regexp-like-short-circuit`);
abrupt `Get(pattern,'source'/'flags')` propagates (`from-regexp-like-get-*-err`).
`from-regexp-like.js` also needs `Object.prototype.toString` — if that lands
via another lane first (#2515/#2916 space), just re-verify.

**Step 6 — generic `flags` getter (cluster 7, 5 tests).**
In the getter arm of `emitRegExpProtoMemberBody` (regexp-standalone.ts:5211+):
for member `flags` only, replace the brand-check-first shape with: proto
identity → `""` (keep #2876), branded receiver → struct fast path, any other
OBJECT → build the string from `ToBoolean(Get(R,'global'))` …
`Get(R,'sticky')` in ES2015 spec order g-i-m-u-y, primitive → TypeError. The
individual flag getters (`global`, `sticky`, …) keep their brand checks —
§21.2.5.4+ requires them.

**Step 7 — u-mode parser strictness (cluster 8, 4 tests).**
src/codegen/regex/parse.ts: under `u`/`v` flags reject IdentityEscape outside
SyntaxCharacter ∪ `/` (:880–905 already notes "u/v mode has no legacy
octal/identity fallback" — close the remaining `\A`-style and `\<space>`
holes), `\c` without ControlLetter (:1064), lone `\u` (:1077–1092). These
must surface as construction-time SyntaxError, not pattern acceptance.
Separately diagnose the `__gen_resume_invalidControls` unreachable trap on
`annexB/.../RegExp-invalid-control-escape-character-class.js` — that is a
generator-resume interaction, possibly its own one-line bug.

**Step 8 — dynamic-flags demotion (cluster 9, 3 CE).**
Where `staticRegExpFlags` returns null on the match paths
(regexp-standalone.ts:818 refusal), fall through to a runtime-flag core: the
#4439 reflective `String.prototype.match` body already resolves `g` and
resets lastIndex from `RE_FIELD_FLAGS` at runtime — reuse that shape instead
of refusing.

**What NOT to do**
- No new host imports without a standalone fallback (dual-mode rule; the
  point of this issue is host-free purity — the test262 runner FAILS any
  standalone module that emits host imports).
- Never edit `tests/test262-runner.ts`, any skip list, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- Do not hand-shape a second matcher loop — every match must run through the
  existing `__regex_search`/`emitRegexExecArrayCall` machinery; semantic
  drift between lanes is how #3567 happened.
- Do not regress the static string-receiver lanes
  (`"s".replace(/re/,'x')` etc.) — they are equivalence-tested and
  perf-relevant; the protocol loops apply to RegExp-receiver forms.
- Run the ratchet gates BEFORE committing, chained and bare (never piped):
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs &&
  node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet &&
  npm run -s check:dead-exports`.

## Acceptance criteria

- All 182 tests in `.tmp/es2015/wp-regexp-current-fails.txt` pass via the
  probe (`npx tsx .tmp/run-standalone.mts --list …`, standalone target). The
  8 cross-realm tests require the QuickJS provider built locally; if any
  remain blocked by genuinely-missing realm infrastructure after Step 0,
  document them explicitly rather than silently dropping them.
- Every test in `.tmp/es2015/wp-regexp-passing-spotcheck.txt` (40 paths)
  still passes — no regressions on the currently-green regexp surface.
- Source-ratchet gates pass (loc-budget with this issue's grant, func-budget,
  coercion-sites, oracle-ratchet, dead-exports).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## Results

Wave 1, measured 2026-08-28 with `npx tsx .tmp/run-standalone.mts --list
.tmp/es2015/wp-regexp-current-fails.txt` (182 paths, standalone target) on this
branch.

| | before | after |
| --- | --- | --- |
| pass | 0 | **29** |
| not passing | 182 | 153 (149 fail + 4 compile error) |

The "before" row is the target list's definition — every one of the 182 paths
was failing on head `86739f05`, which is what the list was written from. The
"after" row is a full re-run of all 182 on this branch.

Regression guard: all 40 paths in `.tmp/es2015/wp-regexp-passing-spotcheck.txt`
still PASS. Source-ratchet gates (loc / func / coercion-sites / oracle-ratchet /
dead-exports) all green with this file's grants.

### Clusters closed or advanced

- **Cluster 2 — @@-method reification (12 of 27).** The root cause was a missing
  arm, not the glue: `<Builtin>.prototype[Symbol.<wellKnown>]` had no
  value-read path except Map/Set's `@@iterator` alias (#4731), so the computed
  read fell through to `__extern_get`, which has no standalone symbol-key arm,
  and `RegExp.prototype[Symbol.match]` READ as `undefined` while its `typeof`
  folded to `"function"`. Generalized that arm to every well-known symbol
  (builtin-value-read.ts), gave `@@N` members their §10.2.9 display name
  `"[Symbol.x]"` derived from the one well-known-symbol table (native-proto.ts,
  literals.ts), and gave `@@7`–`@@10` their real arities. `length` / `name` /
  `not-a-constructor` now pass for all four symbol methods.
- **Cluster 3 — `RegExp.prototype.compile` (11 of 15).** `$NativeRegExp`'s
  pattern fields are now mutable, `compile` has a real Annex B §B.2.4.1 body
  (RegExp-pattern borrow + step 3.a TypeError, ToString with `undefined ⇒ ""`,
  runtime re-compile, in-place field copy, lastIndex reset, receiver returned),
  and `re.compile(…)` has a dispatch arm — it previously had none and silently
  no-op'd. An out-of-subset pattern now throws SyntaxError instead of copying
  the #4439 poison struct into the receiver.
- **Cluster 5 — @@replace function replacer (6 of 7).** `re[Symbol.replace](s,
  fn)` routes into the existing #4224 call-site walk with operands swapped,
  instead of refusing. This was purely a missing route: the machinery was
  already wired for `String.prototype.replace(re, fn)`.
- **Cluster 7 — generic `flags` getter (0 of 5, but the getter is fixed).**
  §22.2.6.4 is now emitted generically: branded receiver → struct bitfield,
  any other object → `ToBoolean(Get(R, <flag>))` in spec order folded into the
  same bitfield, primitive → TypeError. The five `coercion-*` tests still fail
  for an unrelated reason (below).

### Deliberately not attempted / blocked

- **Cluster 1 — RegExpExec protocol (103 tests): NOT attempted.** It is a
  rewrite of all four @@-cores around an observable `RegExpExec` loop, and it
  is the single largest item in the plan; splitting it out keeps this wave
  landable. Everything it needs is still true as the plan describes it.
- **Cluster 7's five `coercion-*` tests are blocked on an unrelated
  open-object defect, not on the getter.** Measured: on a standalone plain
  object, only the FIRST assignment to a property takes effect —
  `r.global = undefined; r.global = "string"` reads back `undefined`. The tests
  reassign the same property nine times with different types, so they can never
  observe more than the first value. Direct probe with a single assignment
  (`{global: "string"}`) returns `"g"` correctly through the new getter. Needs
  its own issue against the open-object property-write path.
- **Cluster 8 — u-mode pattern strictness (3 tests): blocked as scoped.** The
  plan targets `src/codegen/regex/parse.ts`, but these tests build patterns at
  RUN time (`RegExp("\\" + s, "u")` over a `String.fromCharCode` loop), so the
  rejection has to come from the hand-emitted Wasm runtime compiler
  (`ensureDynamicStandaloneRegExpCompiler`), not the TypeScript-side parser.
  Fixing `parse.ts` alone would not move them.
- **Cluster 9 — dynamic-flags demotion (3 CE): not attempted.** Unchanged.
- **Cluster 6 — cross-realm (8): unchanged**; one now reports a compilation
  timeout rather than the missing QuickJS provider.
- Remaining cluster-3 residue: `flags-to-string` (a `.test()` on a
  statically-known literal still selects g/y semantics from the LITERAL's
  flags, which `compile` can now invalidate — static flag analysis is unsound
  once a regexp is mutable, and should be demoted to the runtime bitfield on
  any module that calls `compile`), `pattern-regexp-immutable-lastindex`
  (needs the observable lastIndex Set from cluster 1 step 2),
  `pattern-regexp-props` (an `Object.defineProperties` descriptor-shape
  limitation, #1906), `pattern-string-u` (the runtime compiler has no `u`
  support).

## References

- #2161 — standalone RegExp residual umbrella (blocked on #2175); this issue
  is its @@-protocol + reflection slice made concrete against head
  `86739f05`. Do not duplicate its inventory; update its reconcile note on
  completion.
- #2175 — standalone builtin-prototype reader/native-method-closure substrate
  (in-progress): Step 2 builds on its glue (`ensureRegExpNativeProtoGlue`).
- #2515 / #2916 — open-object companion runtime; probes p5/p6 show the
  observability substrate this plan routes through.
- #4444 — ES2015 standalone closeout umbrella (parent context), #2860 —
  standalone-vs-host gap umbrella, #2671 — ES2015 builtin residual tracking.
- Done phase history: #682, #1539, #1909–#1914 (engine + lastIndex + result
  shape), #4224/#3567 (function replacer walk), #4694 (dynamic named
  replace), #4439 (runtime-flag match body).
- Host-mode twins of these exact semantics (all done, useful as behavioral
  reference): #1328–#1331, #3051, #3084.
- #485 (Backlog, pre-standalone-era well-known-symbols-for-regexp) — this
  issue supersedes its standalone-relevant scope.
- #2723 — linear-matching perf path (ready): keep Step 1 loop structure
  compatible; no shared files expected beyond native-regex.ts.
