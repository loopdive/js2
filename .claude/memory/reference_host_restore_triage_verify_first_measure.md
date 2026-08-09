---
name: reference_host_restore_triage_verify_first_measure
description: "Host-fail triage cluster LABELS over-count addressable wins; verify-first-MEASURE before build. 4 mirages debunked 2026-07-20; landing-page % is pass/total so fail→skip is %-neutral."
metadata:
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Host-restore program (sprint 73, 2026-07-20). dev-3420's host-fail triage
(`plan/log/host-fail-triage-2026-07-20.md`) buckets ~19,147 js-host non-pass by
ERROR SIGNATURE. **Signature ≠ root cause** — each cluster mixes throw-class bugs,
ToPrimitive/value-rep tangles, skip-features (eval/Temporal), and scattered
singletons. **Always verify-first-MEASURE (run the real files, count actual flips)
before dispatching or building.** dev-3422 debunked 4 tag-high clusters as
~0-real-flip mirages before any wasted PR:
- **#14 bigint/symbol coercion** — NOT throw-class; real bug is value-rep/ToPrimitive
  wrapper-unwrap (`Object(2n)*2n` should be 4n) → filed as hard hand-off **#3481**.
- **#11 early-errors (~150)** — ~118 are eval-code (skip feature) → ~32 real scattered.
- **runner-bundle (#13 assert-not-defined 183 / #16 sig-decl 122 / #17 FIXTURE)** —
  fail→SKIP not fail→PASS (eval/SAB/dynamic-import skip-entangled).
- **#728 null-receiver TypeError** — bare-string throw is real but measured 0/40
  flips; the 486 baseline fails are unexpected-null CODEGEN bugs
  (destructuring/arguments/super-spread, #1350-adjacent), not error-class.

**Landing-page % accounting:** `scripts/sync-conformance-numbers.mjs` = `pass/total`
with skips IN the denominator (`summary` also carries fail/skip). So **fail→skip is
%-NEUTRAL** (Temporal ~4190, runner-bundle) — there is NO cheap runner-only
landing-% win; only real codegen **fail→PASS** moves the number.

**What DID land (concentrated wins).** The dominant clean cluster post oracle-v8
(#3359, authentic harness) is **"bare-string / non-Error throw → route through
`buildThrowJsErrorInstrs`"** — the harness's `e instanceof TypeError/RangeError`
guard now fails on a bare string: #3422 delete-non-config (313 flips, MERGED),
#3477 RangeError ctors, #3429 assert.throws-ctor-identity. Plus #3441 worker
sandbox-parity TypedArray/Atomics (~2069, RUNNER fix), #3479-SliceA static-method
`hasOwn` trap-parity (~312). Remaining host-restore = XL features (Iterator #3484)
+ hard epics (value-rep #3481); bounded quick-wins largely exhausted, climb slows.

See [[reference_error_analysis]], [[project_test262_lane_parity_program]].
