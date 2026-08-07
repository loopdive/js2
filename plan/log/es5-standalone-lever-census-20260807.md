# ES5 standalone lever census — 2026-08-07 (W23)

> ## ⚠ CORRECTION, 2026-08-07 — lever #1 and the whole masking analysis (§4) are WRONG
>
> W25 implemented #4205 and measured it. Two load-bearing claims below do not
> survive contact:
>
> **1. Lever #1 is not 133 files. It is 7.** The root cause this census
> attributed to it **does not reproduce**: `this.p1 = 1; if (!(p1 === 1)) throw`
> compiles and runs clean in `--target standalone` on unmodified main, 0
> imports. The `!ctx.standalone` conjunct in `isScriptGlobalThisReceiver` is
> **gOPD-local** and is not on that path. **"Standalone has no realm global
> object" has been false since #2996** (`emitNativeGlobalThisObject` — a real,
> identity-stable `$Object` singleton); #3956 + #3365 + #2996 already compose
> into a working script-goal global object. Result: **FIXED 7 · BROKE 0**
> (PR #4192).
>
> **2. §4's masking claim is false, and it was the most consequential thing in
> this document.** Predicted: ~96 `with` files reclassify once #4205 lands.
> Measured across 388 files, per file: **ZERO changed error signature.**
> Delta-debugging `with/S12.10_A1.1_T1.js` isolates a **pure `with` defect** —
> drop one `valueOf` member from the with-object and the same file fails on
> `p1='x1'` instead of `p1=null`, i.e. the with-scoped assignment wrote through
> to the global.
>
> **Consequences for anyone steering from this document:**
> - **Estimate #4206 from its own mechanism, UNDISCOUNTED.** The "+68 masked"
>   adjustment and the "sequence #4205 before #4206" instruction in §4, §7 and
>   §8 are void. There is no sequencing dependency.
> - Do not inherit any count in the table without re-deriving it. §0 already
>   says **no local compile was run**; lever #1 is what that limitation looks
>   like in practice — a shape predicate matched 133 files, and 126 of them were
>   failing for other reasons entirely.
> - The method failure is specific and worth naming: **co-occurrence was read as
>   causation.** "128 of the 133 also match another mechanism, and the
>   global-`this` assertion appears on an earlier line" is evidence of textual
>   ordering, not of one failure blocking another. The line-number argument in
>   §4 felt like a measurement and was not one.
>
> Everything below is left as originally written, for provenance.

Ranked, mechanism-bucketed census of the **ES5-label `--target standalone`**
failing residue, produced to steer the "90 % ES5 standalone" goal. Bucketing is
by **mechanism** (established by reading the failing source and locating the
responsible codegen site), **not** by first-assertion error text — see
`[[reference_error_signature_is_not_a_bucket_boundary]]`.

## 0. Instrument and provenance — read this before quoting any number

| | |
| --- | --- |
| Population | `parseFrontmatter` + `classifyEdition` from `scripts/generate-editions.ts`, `classifyEdition() === 5`, cumulative ES5-and-earlier labels |
| Standalone data | `ensureStandaloneBaselineJsonl({force:true})` → `.test262-cache/test262-standalone-current.jsonl`, 48,619 rows, `oracle_version: 13`, timestamps `7.8.2026` |
| Host data (comparison only) | `.test262-cache/test262-current.jsonl`, force-fetched same day, 48,619 rows, oracle v13; verified the only import namespace is `env` |
| Base | `origin/main` @ `cc5f6281fc` |
| Local compiles run | **none** |

**No local compile was run for this census.** Every count comes from the
published CI standalone baseline, so the three instrument traps in
`[[reference_standalone_eval_instrument_reports_unmeasured_failures]]`
(missing `js2wasm:runtime-eval` namespace, provider cache downgrading to the
refusal tier, non-full-interpreter tier) **cannot** have manufactured these
failures. Anyone re-measuring a bucket **locally** must delete the provider
cache before rebuilding — and note that comparing the emitted binary's byte
size is **not** a sufficient control: measured 2026-08-07, cache key
`854c120ce015d507` stayed identical across builds emitting 3,971,954 and
3,995,550 bytes. The key tracks neither input nor output.

Two-sided sanity: my classifier reproduces the population exactly (8,931 ES5
files, matching the brief) and reproduces the pass count to within the
baseline's own movement.

### The headline numbers

| | files | pct |
| --- | --- | --- |
| ES5 standalone total | 8,931 | |
| pass | 7,566 | **84.72 %** |
| fail (`status: fail`) | 1,216 | |
| compile error / timeout | 149 | |
| **failing residue** | **1,365** | |
| 90 % target | 8,038 | |
| **gap** | **+472** | |

**#4201 landed after this baseline was cut** (PR #4190, `<wrapper>.valueOf()`
returns `[[PrimitiveValue]]`). Its 12 files — `Function/prototype/bind/15.3.4.5.2-4-{3..14}`
— are still counted as failures here. Adjusted: **7,578 pass (84.85 %), 1,353
failing, gap +460.**

No vacuous host-leak passes: 0 ES5 rows have `status: "pass"` together with a
`host_import_leak_class` or a non-empty `imports`, so the #2914 host-free pass
rule is a no-op on this data.

## 1. The finding that should change the plan: this is not a standalone gap

| ES5, both lanes, same day | files |
| --- | --- |
| host pass · standalone pass | 6,587 |
| **host pass · standalone FAIL** | **493** |
| **host FAIL · standalone pass** | **979** |
| **host FAIL · standalone FAIL** | **872** |

**ES5 standalone (84.72 %) is 5.4 points AHEAD of ES5 host (79.27 %).** Only
493 of the 1,365 standalone failures are standalone-specific; **872 — 64 % —
fail in both lanes.** They are ordinary ECMAScript-semantics gaps that happen to
be measured in the standalone column.

Consequences for steering:

- Framing the goal as "close the standalone gap" mis-targets two thirds of the
  work. The dominant levers are **shared semantics**, and fixing them pays into
  the host lane too.
- A lever's `host-pass` column below is a good proxy for cost: high host-pass
  means "the host lane already does this, port the lowering"; low host-pass
  means "nobody implements this, design it".
- This also supersedes #4163's ceiling arithmetic. That issue (2026-08-01,
  66.3 %) computed a 92.4 % ceiling excluding `eval` and `with` and concluded
  the goal needed 91 % of every reachable failure. At 84.72 % the picture is
  much easier: the reachable pool after excluding the 164-file interpreter lane
  is 1,201, and +472 is **39 %** of it, not 91 %.

## 2. Ranked lever table

Files = **primary (exclusive)** attribution, first matching mechanism wins in
the order shown. `host+` = how many of those files pass in the host lane.
`multi` = how many also match another mechanism (overlap / masking risk).
Confidence and what I verified by hand is in §3.

| # | mechanism | files | host+ | multi | owner / issue |
| --- | --- | --- | --- | --- | --- |
| 1 | **Script-goal global object** — top-level `this.x = v` creates no readable global binding | **133** | 14 | 128 | **NEW #4205** (unowned) |
| 2 | **Descriptor defaulting / ValidateAndApplyPropertyDescriptor** | **99** | 48 | 25 | #2668 `ready`, **UNASSIGNED** |
| 3 | `eval` — interpreter lane | 78 | 25 | 8 | #2928 / #4137 / #1066 |
| 4 | Primitive-wrapper identity / `constructor` (loose bucket, see §3) | 77 | 55 | 0 | #4200 / #4201 owned |
| 5 | `new Function` — interpreter lane | 67 | 8 | 49 | #2928 / #2924 |
| 6 | **Array exotic `[[DefineOwnProperty]]`** — index/length attributes | 64 | 8 | 64 | **#3251 in-progress** (L2-fable-array-exotic) |
| 7 | **Transferred builtin proto method** — no brand check, no receiver coercion | **59** | 16 | 27 | **NEW #4207** (unowned) |
| 8 | **Descriptor / `Properties` bag via generic `[[Get]]`/`[[OwnKeys]]`** | 58 | 36 | 58 | #2992 `in-progress`-flagged but **UNASSIGNED** |
| 9 | **Operator abstract-ops lowered from the STATIC type** | **55** | 14 | 29 | **NEW #4208** (unowned) |
| 10 | annexB B.3.3 function-in-block hoisting | 50 | 4 | 0 | #2200 / #2552 in-progress |
| 11 | Builtin method unimplemented in standalone (self-named refusal) | 45 | 26 | 32 | #2875 in-progress (lead-es5) |
| 12 | §10.4.3 `this`-binding | 40 | 2 | 15 | OWNED — W21/W22, #4190/#4192/#4202/#4203 |
| 13 | `Function.prototype` call/apply/bind + fn own props | 37 | 17 | 15 | #4196 (W19), #4168 |
| 14 | RegExp standalone engine | 34 | 21 | 1 | #2723 |
| 15 | host-import leak (no wasm-native carrier) | 32 | 17 | 14 | split across carrier issues |
| 16 | Array `length` write / ArraySetLength | 32 | 5 | 8 | #3251-adjacent |
| 17 | own-key enumeration (keys / gOPN / for-in) | 22 | 14 | 5 | #2746 / #2747 |
| 18 | builtins-as-values `__get_builtin` | 22 | 14 | 3 | #2963 |
| 19 | `arguments` exotic object | 20 | 4 | 1 | #1726 UNASSIGNED |
| 20 | **`with` statement** (after removing #4205 masking) | 19 | 3 | 1 | **NEW #4206** (#671 is a stub) |
| 21 | String exotic own index/length props | 17 | 14 | 9 | unfiled, < 30 |
| 22 | strict-mode assignment must throw TypeError | 14 | 3 | 0 | unfiled, < 30 |
| 23 | gOPD over builtin function properties | 9 | 4 | 0 | #4199/#4200-adjacent |
| 24 | annexB HTML-like comments (parser) | 7 | 0 | 0 | unfiled, < 30 |
| — | **unattributed long tail** | **275** | 121 | — | see §5 |
| | **TOTAL** | **1,365** | 493 | | |

Cumulative: top 5 = 33 %, top 10 = 54 %, all attributed = **1,090 / 1,365 = 80 %**.

### Two family roll-ups (overlapping, do not add to the table)

- **Property / descriptor MOP** (levers 2, 6, 8, 16, 17, 19, 23 as a union of
  any-label matches): **347 files** — still the single largest theme, at 25 % of
  the residue. #2668 is its umbrella and is **unassigned**.
- **Interpreter lane** (`eval` ∪ `new Function`): **164 files**, 18 % host-pass.
  This is #2928's pool. It is the cleanest "one substrate, one number" bet on
  the board.

## 3. Per-lever confidence, and what I did NOT verify

| lever | confidence | basis |
| --- | --- | --- |
| 1 script-goal global object | **high** | read `S12.10_A1.1_T1.js` end-to-end and traced the first failing assertion to `this.p1 = 1`; located the gate at `src/codegen/expressions/call-builtin-static.ts:2315` (`!ctx.standalone` in `isScriptGlobalThisReceiver`); two-sided control — 178 same-shape ES5 files PASS |
| 20 `with` | **high** | 39 files carry the compiler's own gate text; read `proveObjectLiteralWithTarget` / `reportWithStatementDiagnostic` in `src/codegen/with-scope.ts` |
| 7 transferred proto method | **high** | read `RegExp/prototype/exec/S15.10.6.2_A2_T6.js` (brand) and `String/prototype/toLowerCase/S15.5.4.16_A1_T7.js` (coercion); read #3992 to confirm it fixed the argument-slot bug, not the `this` handling |
| 9 operator abstract-ops | **high** | read `postfix-decrement/S11.3.2_A3_T3.js` and `strict-equals/S11.9.4_A8_T2.js`; `1 === true` is observably `true` |
| 6 Array exotic dP | **high** | read `defineProperty/15.2.3.6-4-183.js` and `defineProperties/15.2.3.7-6-a-151.js`; segmented 61 array-receiver files into 16 `length` / 45 index / 12 boundary-valued |
| 8 props-bag MOP | **high** | read `defineProperties/15.2.3.7-2-4.js`; located the refusal at `object-runtime-descriptors.ts:1182` (`SITE-PROPS-BAG-NOT-AUTHORITATIVE`) |
| 2 descriptor defaulting | **medium** | read `Object/create/15.2.3.5-4-204.js` and `defineProperty/15.2.3.6-3-136.js`; this is the *remainder* of the descriptor family after 6/8/16/17 and is certainly ≥ 2 sub-mechanisms |
| 3/5 interpreter lane | **medium** | classified syntactically (`eval(` / `new Function(`); did **not** read members |
| 4 primitive-wrapper | **LOW — do not act on this row** | predicate is `new (Number\|Boolean\|String\|Object)(` anywhere in the file, which is a *shape*, not a mechanism. Treat 77 as an upper bound on a family that certainly splits ≥ 3 ways |
| 10 annexB, 11 method-missing, 13–24 | **medium/low** | sized syntactically or by the compiler's own refusal text; **not** hand-verified |

**Not verified by hand:** levers 3, 4, 5, 10, 11, 13–24, and the 275-file
unattributed tail. Lever 4 in particular should be re-derived before anyone
files against it.

## 4. Masking — the most consequential structural fact

> **⚠ THIS ENTIRE SECTION IS RETRACTED — see the correction at the top.**
> Measured per file across 388 files: **0 reclassified**, not 96. `with` is an
> independent mechanism; there is no #4205 → #4206 sequencing dependency. The
> reasoning below mistook co-occurrence and line ordering for causation.

**128 of the 133 script-goal-global-object files also match another
mechanism**, and 96 of them are `with` tests. In every one inspected, the
global-`this` assertion fires *first*:
`language/statements/with/S12.10_A1.1_T1.js` dies on line 61
(`p1 === 1. Actual: null`, set by `this.p1 = 1` on line 13) while its `with`
block is on line 42.

That is why the `with` row in the table reads **19** and not **118**. The honest
decomposition of the 118 `with`-using failures is:

| | files |
| --- | --- |
| hard-refused by the closed-shape gate (unambiguously `with`) | 39 |
| runtime `with` misresolution, no `this.x=` contamination | 11 |
| **blocked behind #4205 — first failure is global-`this`, not `with`** | **68** |

Per `[[reference_error_signature_is_not_a_bucket_boundary]]`, those 68 belong to
**neither** issue's yield until both land — and when #4205 lands first they will
surface as *fresh* `with` failures, which reads as a regression to anyone who
did not write it down. **Sequence #4205 before #4206.**

Other masking to expect:

- Levers 6 and 8 have `multi` == `files`: every array-exotic and props-bag file
  also matches the descriptor-defaulting predicate. They are sub-mechanisms of
  one substrate, not independent bets.
- **~16 files in lever 9 currently sit in the crash cluster** (#3442/#3443) by
  error text (`illegal cast [in __str_to_number()]`, `null deref in
  __module_init`). They are not an independent crash mechanism — the crash is
  the coercion defect's failure mode when a mis-typed value hits a cast.
  Hardening the cast alone converts a crash into a wrong answer.
- Lever 11's 45 files include 28 that are *also* transferred-proto-method
  (lever 7); the missing method fires first, so they belong to #2875.

## 5. What is left unattributed

**275 files (20 % of the residue, 121 of them host-passing).** This is a genuine
long tail, not a bucket I gave up on: the largest directory in it is
`language/statements/function` at 31, and the largest single normalised error
signature is 15. Top directories:

| files | directory |
| --- | --- |
| 31 | `language/statements/function` (`S13.2.2_A*` — function-declaration-as-object; several `__fnctor___func_new` null-derefs) |
| 16 | `built-ins/Array/prototype` |
| 14 | `built-ins/Object/defineProperty` |
| 13 | `language/expressions/call` |
| 12 | `built-ins/String/prototype` |
| 10 | `language/types/object` (`S8.6_A*` object property semantics) |
| 8 | `language/expressions/array`, 8 `language/expressions/new` |
| 7 | `annexB/built-ins/Date` |
| ≤5 | 40+ further directories |

Across the whole residue there are **569 distinct normalised error strings** and
**373 distinct 3-segment directories**. That is the quantitative statement of
why an error-text census would have sent lanes at phantoms.

## 6. Vacuous-pass risk

Two forms, both measured:

1. **Passes that would flip.** Lever 4's low confidence is the concrete risk: it
   contains files that pass an assertion for the wrong reason (a wrapper that
   stringifies correctly while being the wrong type). #4201 just fixed the
   `[[PrimitiveValue]]` half of this; expect some currently-passing wrapper
   tests to become visible failures of the *type* defect as identity gets
   tightened.
2. **Host-leak passes: none.** 0 ES5 rows pass while carrying a
   `host_import_leak_class` or non-empty `imports`.
3. **Passes that depend on masking.** 178 ES5 files use script top-level
   `this.x=` and currently pass — they are the control set for #4205 and must be
   re-run as a guard, not assumed inert.

## 7. Recommended sequencing

> **⚠ Item 1 is spent and item 5's `+68 after #4205` is void — see the
> correction at the top.** #4205 measured **7 files**, not 133, and unmasked
> **nothing**. Revised head of the queue: **#4206 `with`** (sized from its own
> mechanism, undiscounted), then #2928, #2668, #4208, #4207.

1. ~~**#4205 script-goal global object** (133) — first, because it unmasks 96
   `with` files and 41 others. Unowned.~~ **DONE, PR #4192 — 7 files, unmasked
   nothing.**
2. **#2928 interpreter lane** (164 union) — one substrate, one number, and the
   only lever whose payoff is not entangled with any other. Currently
   `released`, not claimed.
3. **#2668 descriptor umbrella** (347 family / 99 as an exclusive row) — the
   largest theme. **Unassigned and its headline count (~788) is 3× stale.**
   Re-size it to 347 before dispatching. #3251 (Array exotic, 64) is already
   in flight underneath it; #2992 (props bag, 58) is the next slice and is
   unassigned.
4. **#4208 operator abstract-ops** (55) — high value beyond ES5: it is the
   root of ~16 files currently mis-filed as crashes, and 45 of its 55 fail in
   host too.
5. **#4207 transferred proto method** (59) and **#4206 `with`** (39 + 11; the
   "+68 after #4205" adjustment is **void** — measured 0 reclassified).

## 8. New issues filed by this census

| id | lever | files | why it was not already filed |
| --- | --- | --- | --- |
| #4205 | script-goal global object | ~~133~~ → **7 measured** | #2727 covers only `typeof this === "object"`; the binding-creation half was never sized. **The 133 was wrong — see the correction at the top.** |
| #4206 | `with` statement residue | 39 + 11 (~~+68 masked~~ — **void**, 0 measured) | #671 is a 2026-03 backlog stub with no sizing; #1387/#3025 are done |
| #4207 | transferred builtin proto method | 70 (59 primary) | #3992 fixed the argument slot, #4076 fixed the `.call` form; the transfer form's `this` handling is uncovered |
| #4208 | operator abstract-ops from static type | 55–59 | #3055/#4183 cover only `===` on boxed values |

Ids reserved via `claim-issue.mjs --allocate --by ttraenkler/W23 --allow-unscanned`.
The open-PR arm of the scan could not run (`gh` absent, tokens are proxy
placeholders), but the coordinator ran it out-of-band: the only open PRs against
`loopdive/js2` are #4190 and #4175, neither of which adds an issue file. The
reservations are therefore **verified clean**, not merely unscanned.

Deliberately **not** filed:

- The 6-file `ToObject`-boxing seam (`10.4.3-1-{1,2,4}-s`,
  `10.4.3-1-{103,104,106}`) — W22 is deciding whether receiver-boundness
  subsumes it.
- Anything already covered at the right granularity by #2668, #2992, #3251,
  #2875, #2928, #2200/#2552, #2723, #2963, #1726. Filing parallel issues for
  those would reproduce the 2026-07-17 duplication (overlap by idiom, not by id).

## 9. Reproducing this census

Scripts live in `.tmp/` (gitignored) and are ~40–120 lines each:

1. `scripts/provision-worktree-deps.sh` with `JS2_WORKTREE_SOURCE=<main checkout>`
   — a fresh worktree has neither `node_modules` nor a populated `test262/`, and
   the script resolves its source root from `/workspace`, which does not exist
   in every checkout.
2. `node scripts/fetch-baseline-jsonl.mjs --standalone --force` (and the bare
   form for the host comparison). **`--print-path` alone does not download** —
   it prints the path and exits.
3. Classify every row with `parseFrontmatter` + `classifyEdition` from
   `scripts/generate-editions.ts`; keep `=== 5`.
4. Bucket by mechanism predicates over the **test source** plus the compiler's
   own self-naming error text, in a fixed priority order; report the primary
   (exclusive) label, the any-label overlap, and the unattributed remainder.
5. Join against the host baseline for the `host+` column.
