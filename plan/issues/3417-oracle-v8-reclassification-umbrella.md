---
id: 3417
title: "UMBRELLA: oracle-v8 (original-harness) reclassification triage — the honest v7→v8 gap"
status: ready
created: 2026-07-18
priority: high
task_type: umbrella
area: test262-conformance
goal: test262-conformance
model: fable
sprint: current
horizon: s
related: [3370, 3393, 2860, 3178, 3188, 3287, 3418, 3419, 3420, 3421, 3422, 3423]
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
