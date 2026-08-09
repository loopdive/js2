---
id: 3417
title: "UMBRELLA: oracle-v8 (original-harness) reclassification triage — the honest v7→v8 gap"
status: ready
created: 2026-07-18
updated: 2026-07-23
priority: high
task_type: umbrella
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
horizon: s
related: [3370, 3393, 2860, 3178, 3188, 3287, 3418, 3419, 3420, 3421, 3422, 3423, 3428, 3469]
---

# #3417 — oracle-v8 reclassification umbrella

The v8 flip (#3370) made the **literal upstream test262 harness** authoritative and
intentionally reclassified passes that depended on the synthetic `wrapTest()`
surrogate. #3393 re-seeded the standalone floor. This umbrella triages the measured
v7→v8 reclassification set, separates the **honest gap** (real compiler bugs the
correct harness exposed) from **assembly/policy artifacts**, and tracks the fix
children. **The v8 basis is accepted policy — not relitigated here.**

## Measured v7→v8 delta (official, from run 29634290540 merged report, oracle v8)

| Lane | v7 pass | v8 pass | net | reclassified | gained |
| --- | ---: | ---: | ---: | ---: | ---: |
| default (js-host) | 32,326 | 25,007 | **−7,319** | 7,992 | 673 |
| standalone (host-free) | 24,843 | 4,312 | **−20,531** | 20,542 | 11 |

**Floor is NOT anomalous.** Fresh v8 (run 29634290540) measures standalone
**4,312 official / 4,508 full corpus** — identical to #3393's re-seed from run
29614990626. No floor correction is warranted; #3393 stands.

## Bucket table

| # | Family | Lane | Count | Root cause | Child issue | Status |
| --- | --- | --- | ---: | --- | --- | --- |
| 1 | `host_import_leak` (shim-only) | standalone | 29,791 (18,763 were v7-pass) | runtime shim leaks 2 UNUSED host imports | **#3418** | filed (crown jewel) |
| 2 | `Duplicate identifier isPrimitive` | both | ~1,373 default + ~2,055 standalone rows | `isPrimitive` defined in both assert.js and propertyHelper.js include; legal JS concat rejected by compiler | **#3419** | filed |
| 3 | verifyProperty on frozen/non-writable Array elem traps `oob` | default | ~19 + propertyHelper corpus | write to non-writable element traps oob instead of throwing TypeError | **#3420** | filed |
| 4 | `async completion marker not observed` | default | 2,653 (+68 asyncTest-without-flag) | async literal-harness verdict: compiler async exec doesn't emit the `$DONE`/print completion marker | **#3421** | filed |
| 5 | strict-mode rerun failures | default | ~666 (419 read-only assign, 247 delete non-configurable) | v8 adds required strict reruns; sloppy-passing tests throw in strict | **#3422** | filed |
| 6 | module-global representation | default | ~600 (SameValue undefined reads, `null is not a constructor`, verifyProperty null) | top-level var/let/class fields now real module globals; read as undefined | **#3423** | filed |
| 7 | assert.throws constructor-identity / wrong error type | default | ~190 (wasmClosureDynamicBridge, TypeError↔RangeError, missing throw) | real assert.throws now checks constructor identity | #3287 (done) — residual tracked here | linked |
| 8 | `Reflect.construct not supported in standalone` | standalone | 350 | standalone feature gap (post-shim frontier) | #3178-adjacent | linked |
| 9 | trap reclassifications (unreachable +47, oob +4) | default | 47+4 | module-code instantiation (46/50 `language/module-code`) + verifyProperty oob (#3420); within #3370's declared ceiling | #3188 (module) / #3420 | verified v8-workload |

## Trap-ratchet note (resolved)
The scheduled Baseline Refresh (run 29634290540) failed at promote because the
#3335 trap-growth gate fired (unreachable 8→55, oob 45→49) — the scheduled path
does not consume #3370's `trap-growth-allow`. Both deltas were verified v8-workload
(module-code instantiation + verifyProperty oob), within #3370's declared 47 ceiling.
Resolved via a one-time forced promote (run 29635531163); the ratchet self-heals on
subsequent v8-vs-v8 diffs. #3420 tracks the underlying oob gap.

## v8 full-failure harvest (both lanes, official, run 29634290540)

Not just the v7→v8 delta — the full standing v8 failure surface, per the
harvest-errors protocol (lanes never mixed; `official:false`/Temporal excluded).

### Default (js-host) — total 43,106, fails 18,080
| error_category | count | coverage |
| --- | ---: | --- |
| fail::other | 12,395 | async-marker #3421 (2,653) · module-global #3423 (~600) · assert.throws #3287 · residual |
| compile_error::other | 2,426 | Duplicate identifier #3419 (~1,373) · for-of destructure · reserved-word |
| fail::runtime_error | 1,358 | strict-rerun #3422 (~666) · verifyProperty null #3423 |
| fail::type_error | 508 | wrong-error-type #3287-adjacent |
| fail::missing_builtin | 422 | builtin gaps (pre-existing) |
| compile_timeout | 252 | pre-existing |
| fail::negative_test_fail | 88 | **REAL conformance bugs — negative tests mis-passing; needs sub-bucket triage** |
| null_deref / illegal_cast | 163 / 80 | trap families (pre-existing) |

Top embedded citations (all <50, pre-existing trackers, no new trigger): #2043(19),
#1387(16), #1472(16), #2026(13).

### Standalone (host-free) — total 43,106, fails 38,775
| error_category | count | coverage |
| --- | ---: | --- |
| compile_error::host_import_leak | 34,409 | **#3418** (29,791 shim-only recoverable) |
| compile_error::other | 3,984 | Duplicate identifier #3419 (~2,055) · Reflect.construct-standalone (350, #3178-adj) · destructure |
| compile_error::wasm_compile | 293 | codegen invalid-binary (pre-existing) |

Top embedded citations (self-citing refusals): **#2961(34,412 = the leak → #3418)**,
#680(771), #1472(727), #1907(59), #1888(59). #680/#1472 are existing standalone
feature-refusal trackers (host-free string/feature gaps) — the post-#3418 frontier;
note linkage, no duplication.

## Highest-leverage lever
**#3418** (shim import-leak) — recovers ~18–30k standalone passes with a contained
import-DCE fix. This is the priority for the remaining Fable window.

## 2026-07-19 harvest refresh (post-#3369-recovery baselines)

Re-harvested the freshly published baselines (default `test262-current.jsonl`,
standalone `test262-standalone-current.jsonl`; oracle v8; Temporal/`official:false`
excluded). Confirms the buckets above still hold, plus:

- **Default lane** — pass 27,827 / 43,106 (64.6%). Largest single **untracked**
  bucket is the TypedArray-ctor `Cannot convert null to object [in __module_init()]`
  cluster (**2,069**: TypedArray 1,316 + TypedArrayConstructors 619 + Atomics 90).
  This is `null`-in-`__module_init`, distinct from #3423's `undefined`-in-
  `verifyProperty` — filed as **#3441**. Async `[object WebAssembly.Exception]`
  AsyncTestFailure (1,272, class-elements/async-gen/for-await-dstr) and
  `obj should have an own property m` (311, class private methods) remain within
  the async-marker #3421 / assert.throws #3287 families.
- **Standalone lane** — pass 24,171 / 43,106 (56.1%). Dominated by
  `wasm exception during module init` (**7,063**, diffuse across
  Object/String/Array/TypedArray/class/annexB/Proxy — the standing post-#3393
  standalone-floor runtime-trap surface, umbrella #1781, not a single root cause)
  and `async completion marker not observed` (3,257, #3428/#3421). Self-citing
  refusals rank #2961(4,822 → leak/#3418), #1472(807 Reflect.construct+dyn-shape),
  #680(513 generator lowering), #1907/#1888(61 builtin static value-reads),
  #2620(31 extends-Set/Map) — all existing deferred trackers.

## Host↔standalone gap (2026-07-19)

`host_pass ∧ ¬standalone_pass` (official) = **8,855** tests. (The oft-quoted
~3,656 is the *net* pass-count difference; standalone also uniquely passes ~5,199
tests host fails, so set-difference ≫ net.) Gap composition:

| bucket | count | cited # |
| --- | ---: | --- |
| wasm exception during module init | 2,348 | #1781 |
| async completion marker not observed | 2,027 | #3428 — **resolved by F2/#3469, measured below (2026-07-23)** |
| generator / async-gen lowering | 1,867 | #2961/#680 |
| null-deref (standalone codegen) | 789 | #3442 (new) / #2865 async subset |
| RegExp (host-refused) | 617 | #1474 |
| Reflect.construct standalone | 354 | #1472 |
| other host-import leak | 276 | #3418 |
| eval/dynamic-import | 102 | #1696 |
| illegal cast (standalone codegen) | 92 | #3443 (new) |
| invalid wasm (standalone codegen) | 59 | #2039 (in-progress) |
| OOB (standalone codegen) | 2 | #2039 (in-progress) |
| Promise host-routed / SharedArrayBuffer / instanceof / dyn-shape | 221 | #3418 / #1472-PhaseB (all host-refusal, not codegen bugs) |
| Proxy (host-refused) | 32 | #1472 |
| misc cited (#2620/#1907/#2029/#2717/#2046) + uncategorized | 60 | resp. trackers; ~8 uncategorized <50 (acorn internal-error ×5, timeout ×2, array-too-large ×1) |

**Coverage audit (2026-07-19):** every gap bucket >50 now has an issue —
`module-init trap` #1781/#3393, `async-marker` #3428, `generator/async-gen` #2961/#680,
`null-deref` **#3442**, `RegExp` #1474, `Reflect.construct` #1472, `host-import leak` #3418,
`eval/dynamic-import` #1696, `illegal-cast` **#3443**, `invalid-wasm` #2039, `Promise/SAB/instanceof/dyn-shape` #3418/#1472 (host-refusal). The Promise/SAB/instanceof/dyn-shape (221) are all `env::*` host-import leaks or #1472-Phase-B `__get_builtin` refusals — deferred features, not codegen bugs.

**Sub-50 long tail also now tracked (2026-07-19):** the `<50` residual signatures
are captured too — `negative_test_fail` early-error / mis-pass (89 default / 45
standalone) → **#3444**; compiler internal-crash `Cannot read properties of
undefined` + `Maximum call stack` (~28 both lanes) → **#3445**; and the catch-all
long-tail (array-too-large, float-unrepresentable, runtime max-call-stack,
timeouts) → **#3446**. Prior trackers for all of these (#3026/#721/#418/#2920 neg-test,
#438/#523/#1606/#2587/#1607 crash, #301/#1171 tail) were all `done` with no open
successor. Every distinct harvested signature across both lanes is now captured in
an issue — zero uncaptured.

Fundamentally: the gap is ~**55% host-import-refusal** (generators, RegExp,
Reflect.construct, Proxy, eval, Promise-host, SAB, instanceof, dyn-shape — features
the host lane routes through a JS import that standalone refuses/defers) plus the
**module-init-trap + async-marker layer** (~4,375, standalone modules that compile
but trap at init or never emit the async completion marker), and only a small
**genuine standalone-codegen-bug residual** (~940: null-deref/illegal-cast/invalid-
wasm/OOB with no host-import excuse). Uncategorized residual is ~8 tests.

## Flap evidence (content-current cluster)

During the 2026-07-18 v8 baseline stabilization, PR #3365 (a **CI-only** merge_group
shard-consolidation, zero compiler changes, running the OLD 114-shard workflow)
parked on a **~197-row pass→other cluster** — run `29644582810`, bucket
`778cbb8a8e80767e`, **72 non-CT files**, ratio 37.3%, stamped content-current
"LIKELY-REAL", **trap categories unchanged**. A CI-only PR cannot cause real
compiler regressions, so the 197 was a genuine **run-to-run flap**: the
contended-pool baseline (`dae79d5a` @ 12:48Z, measured during pre-reset churn)
disagreed with quiet-pool runs on ~197 timing-sensitive tests (async/`$DONE`
class). It **reconciled quiet-vs-quiet** after a quiet-pool forced refresh
promoted `03ca4729` — the cluster vanished. Tracked here as a real nondeterminism
signal for the harvest; the 72-file list is in run `29644582810`'s
"check for test262 regressions" job log.

## F2 landed & measured (2026-07-23, fable-3417) — standalone async completion channel (#3469)

F2 of the lane-parity program ("host-free async completion has no channel:
`console.log` is a no-op, no `__drain_microtasks()` → async tests never
scored") is **DONE — it landed as #3469 (PR #3416, merged 2026-07-19)**, which
built the compiler-side channel (native `$AnyString` stdout sink,
`__stdout_prepare`/`__stdout_char` readout exports) AND the runner-side drive
in both lanes (`scripts/test262-worker.mjs` ~1264, `tests/test262-runner.ts`
~4245, `tests/test262-shared.ts` ~812: drain microtasks, then read the sink
into `harnessOutput`). This section records the measured corpus outcome —
the honest newly-scored split, per the observability-unblocker rule: **a drop
or shift in apparent rate here is not a regression; it is the truth becoming
visible.** No new build work was needed — verified before coding (the fix was
already wired end-to-end and working at corpus scale).

**Cohort:** the **3,258** standalone official-scope tests stuck at
`async completion marker not observed` in the last pre-#3469 baseline
(baselines@`b43f4de2fd`, 2026-07-19T07:38Z, oracle v8). Tracked into the
FIRST post-#3469 promote (baselines@`47224a2681`, 2026-07-19T18:27Z, main
`f48e67e01`) for clean attribution, and re-checked on the current 2026-07-21
baseline (oracle v9):

| cohort status                     | first post-#3469 promote | current 2026-07-21 |
| --------------------------------- | -----------------------: | -----------------: |
| **pass (newly scored)**           |       **2,284 (70.1 %)** |              2,271 |
| honest FAIL (real signature)      |                      971 |                985 |
| compile_timeout / CE              |                        3 |                  2 |
| still `marker not observed`       |                        8 |                  8 |

Standalone official lane at the same promotes: **24,883 → 27,378** (+2,495;
the cohort contributed +2,284 of it — F2 was the dominant driver of that
promote) → **28,138/43,106 (65.3 %)** on 2026-07-21. The marker bucket
collapsed **3,258 → 8**; `asyncTest called without async flag` = **0**.

**Newly-passing families** (first post-promote): for-await-of 674, async class
members 451+451 (expr/stmt), async-generator 226+113, object-literal async
methods 128, Promise 85, async-function 40+32+21, eval-code/direct 40, TLA 15.

**Honest-FAIL signature routing** (971 — all to EXISTING trackers, no new issues):

| signature                                                        | n | tracker |
| ---------------------------------------------------------------- | ---: | --- |
| `TypeError: value is not iterable` (async-gen/for-await iter step) | 280 | #3178 family (#3387/#3388) |
| `null_deref: async continuation threw before completion`          | 159 | #3442 / #2865 |
| `TypeError: Cannot destructure/access/convert …`                  | 111 | async-dstr lane (#2602-adjacent) |
| `wasm exception during module init`                               |  88 | #1781 |
| `obj should have an own property …`                               |  69 | #3468 (F1) |
| `illegal_cast [in __then…]`                                       |  33 | #3443 |
| `promise_error` semantics                                         | ~27 | #2903 / #3390 lane |

**Residual 8 — channel NOT at fault (verified never-settle semantics):** 6×
`built-ins/Promise/{all,allSettled,race}/invoke-then(-get)-error-reject` (spec
requires the combinator to `Invoke(nextPromise, "then")` — an own-property
`then` override via `Object.defineProperty` on a native Promise instance must
be called and its abrupt completion must reject the result promise; the native
combinators call the internal then, so the result promise never settles →
marker legitimately absent), 1× `Promise/race/resolve-self` (monkeypatched
`Promise.resolve` + thenable self-resolution TypeError never delivered), 1×
`module-code/top-level-await/await-expr-new-expr-reject`. All are deep
Promise/combinator semantics belonging to the #3390/#2903 lane under #3178's
decomposition — do NOT chase them through the channel.

F2 was the prerequisite for #3178 sequencing (retiring the host-async
machinery): the standalone async corpus now scores honestly, host-free.
