---
name: reference_standalone_floor_inflated_by_exception_swallow
description: "Standalone test262 pass count is INFLATED — assert failures pass vacuously because standalone function objects can't carry own properties (so assert.* methods are never invoked). NOT an exception-swallow."
metadata: 
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Confirmed 2026-07-19 (host↔standalone parity investigation → agent `fix-standalone-swallow`, empirically nailed + advisor-concurred; issue **#3468**). The standalone lane scores many test262 tests as **vacuous passes** — a failing `assert.sameValue`/`assert.throws` never actually throws, so the harness runs to completion and the test is scored pass regardless of correctness. This **INFLATES** the standalone floor / #2860 gap metric (host_free_pass ~24,883 / 57.7% as of 2026-07-19 is partly inflated).

**⚠️ ROOT CAUSE CORRECTED — the first diagnosis was WRONG.** The original hypothesis was an "exception-swallow: add `catch_all`+rethrow to the `__current_this` wrapper in `src/codegen/closure-exports.ts`." **That is a NO-OP — do not dispatch it.** There is ZERO try/catch in the standalone WAT; nothing is being caught.

**Real cause:** **function objects (closures) cannot carry own properties under `--target standalone`.** `assert.sameValue`/`assert.throws`/`_isSameValue` are properties on the `assert` function object; assigning `f.m=fn` is dropped, `f.m` reads back `undefined`, so `f.m()` **never invokes** anything → the assertion `throw` never runs. Dispatch (`__extern_method_call`/`__extern_get`/`__extern_set`) gates on `ref.test $Object`, which fails on a closure → returns undefined. Evidence: method returning `777` reads `0` at call site; `f.x=5; f.x`→NaN.

**It's a FEATURE, not a wiring fix (architect-spec).** No general "callable carries own properties" rep exists (`.prototype`=dedicated slot; class statics=compile-time module globals). Approaches in #3468: A compile-time function-object property tracking (medium; covers assert harness; recommended start); B callable-`$Object` rep (large/general/broad-impact); C closure-keyed side property table.

**Floor impact is MIXED, not pure lowering:** mostly should-fail flip pass→fail (WILL trip the standalone-floor gate on merge_group → needs justified re-baseline), some should-pass stay, some fail→pass. **Flip count NOT computable until the feature exists.** Separable smaller bug: top-level `throw` statement silently dropped in standalone (low test262 value). See [[project_test262_lane_parity_program]], [[project_standalone_floor_only_on_merge_group]].
