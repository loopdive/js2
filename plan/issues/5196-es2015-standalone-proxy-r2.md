---
id: 5196
title: "ES2015 standalone proxy — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-01
priority: medium
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
pr: 5389
related: [5140, 5268, 5267, 1355, 3031, 2046, 3371]
loc-budget-allow:
  # 2026-09-01 (#5389, one-line revoker fix): object-runtime.ts import expansion.
  - src/codegen/object-runtime.ts
  # 2026-09-01 r2 plan (see "## 2026-09-01 r2 residual plan"): every step adds
  # NEW emitted-code paths — §10.5 invariant validators, a receiver-threaded
  # [[Set]] dispatch + OrdinarySet-with-receiver primitive, proxy-link
  # prototype arms in the chain walkers, `$Proxy` front-guards on three more
  # natives, revoker metadata arms, Reflect-arm booleans/guards, and the
  # `Proxy`-as-value construct/revocable arms. Heavy pieces go in the NEW
  # modules object-runtime-proxy-invariants.ts / object-runtime-ordinary-set.ts
  # / object-runtime-proxy-chain.ts; the listed files grow by wiring only.
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-invariants.ts
  - src/codegen/object-runtime-ordinary-set.ts
  - src/codegen/object-runtime-proxy-chain.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/native-construct.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-static-globals.ts
  - src/codegen/reflect-construct-native.ts
  - src/codegen/typeof-natives-finalize.ts
  - src/codegen/analysis/proxy-binding-escape.ts
  - src/codegen/binary-ops-in.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-01 r2 plan: arm-ladder / dispatch-builder functions that gain one
  # more arm in the shape their existing arms already have (the step naming
  # each is in the plan). Add further entries with a dated line if the gate
  # names another function — never edit scripts/*-baseline.json.
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/object-runtime-proxy.ts::fillProxyDispatch
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
  - src/codegen/reflect-construct-native.ts::fillReflectIsConstructor
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/index.ts::generateModule
---

# #5196 — proxy r2: cluster and fix the residual proxy-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5140, part of PR #5173) plus the
strongest second pass of the batch (+66, PR #5213 — evolved §7.3.9
trap-callable guard, unified non-constructor meta-statics). This r2 lane starts
from the forced fresh `f841cddc0f0ea665b63700d9944a4372a34a8b57` baseline,
not from the older planning snapshot.

## Provenance and active-owner gate

- Authoritative standalone snapshot:
  `/private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl`,
  48,735 JSONL records, timestamped `1.9.2026, 02:03:18` onward and carrying
  `oracle_version: 13`, `oracle_lane: honest`. The forced artifact is from
  immutable `loopdive/js2wasm-baselines`
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe` and has SHA-256
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.
- Edition source: `website/public/benchmarks/results/test262-file-editions.json`.
  Its `editions[6]` is `ES2015`; the query strips the baseline's `test/`
  prefix before looking up `files[path] === 6`.
- Fresh exact cohort: 310 `test/built-ins/Proxy/**` ES2015 records — 182 pass,
  115 fail, and 13 compile errors. The exact non-pass path set is the 128
  rows selected by the reproducible path/status query below; it excludes all
  non-ES2015 rows and no `pass` row.
- Active-owner check on 2026-09-01: `origin/issue-assignments` contains only
  `81b48a9e830ed2b7350c32d3740dca699c7ef8b4` (`chore(assign): reserve #5196`)
  with `status: "reserved"`, blank assignee, and blank branch; the local
  `upstream/issue-assignments` ref has no #5196 record. This is an unassigned
  reservation rather than a live conflicting owner.

```sh
rg '\"file\":\"test/built-ins/Proxy/' \
  /private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl \
  | jq --slurpfile editions website/public/benchmarks/results/test262-file-editions.json \
      -r '(.file | ltrimstr("test/")) as $path
          | select($editions[0].files[$path] == 6 and .status != "pass")
          | [.file, .status, (.error // "")] | @tsv'
```

## Exact status/error inventory

The operation table is an exact partition of the 128 selected non-pass paths.
All omitted Proxy subtrees have zero selected rows.

| Proxy subtree | compile_error | fail |
| --- | ---: | ---: |
| apply | 1 | 5 |
| construct | 8 | 10 |
| defineProperty | 0 | 19 |
| deleteProperty | 0 | 5 |
| enumerate | 1 | 0 |
| function-prototype.js | 0 | 1 |
| get | 0 | 7 |
| get-fn-realm*.js | 2 | 0 |
| getOwnPropertyDescriptor | 1 | 13 |
| getPrototypeOf | 0 | 4 |
| has | 0 | 13 |
| isExtensible | 0 | 1 |
| ownKeys | 0 | 7 |
| preventExtensions | 0 | 4 |
| revocable | 0 | 7 |
| set | 0 | 13 |
| setPrototypeOf | 0 | 6 |
| **Total** | **13** | **115** |

The following is an exact first-stop-signature histogram, not a causal
classification. Shared error text only identifies where a row stopped; it does
not establish that those rows share a repair.

| status | observed first-stop signature | rows | representative exact paths |
| --- | --- | ---: | --- |
| fail | `Expected a TypeError ... no exception was thrown` | 50 | `construct/return-not-object-throws-undefined-realm.js`; `ownKeys/trap-is-not-callable-realm.js` |
| fail | `Expected true but got false` | 5 | `set/return-true-target-property-is-not-configurable.js`; `has/trap-is-undefined-target-is-proxy.js` |
| fail | `Thrown value was not an object!` | 4 | `defineProperty/targetdesc-not-compatible-descriptor-realm.js` |
| fail | handler receiver/context mismatch | 6 | `has/call-in-prototype.js`; `set/call-parameters-prototype.js` |
| fail | `Proxy.revocable is not yet implemented ...` | 3 | `apply/null-handler-realm.js`; `construct/null-handler-realm.js` |
| fail | `0 should be an own property` | 2 | `getOwnPropertyDescriptor/trap-is-undefined-target-is-proxy.js`; `.../trap-is-missing-target-is-proxy.js` |
| fail | object-versus-`undefined` SameValue mismatch | 2 | `deleteProperty/trap-is-undefined-not-strict.js`; `...-strict.js` |
| fail | `null` versus `undefined` SameValue mismatch | 2 | `revocable/revoke-returns-undefined.js`; `.../revoke-consecutive-call-returns-undefined.js` |
| fail | remaining paired signatures (each distinct) | 6 | false-result invariants, `TypeError` versus `ReferenceError`, and nullish property reads |
| fail | singleton first-stop signatures | 35 | descriptor, trap, target, realm, and carrier rows listed by the query above |
| compile_error | distinct-NewTarget `Reflect.construct` refusal (#3371) | 10 | `construct/call-parameters-new-target.js`; `get-fn-realm.js` |
| compile_error | dynamic-shape gOPD refusal (#1472) | 1 | `getOwnPropertyDescriptor/null-handler.js` |
| compile_error | non-array `values()` refusal (#1320) | 1 | `enumerate/removed-does-not-trigger.js` |
| compile_error | generated host imports (#2961) | 1 | `apply/trap-is-undefined-target-is-proxy.js` |

The 35 singleton count plus the grouped rows above totals 115 fails. The
signature table intentionally leaves the broad 50-row TypeError group
unclaimed; it is not evidence for one Proxy implementation change.

## Representative maintained-runner evidence

`node --import tsx scripts/run-test262-paths.mts
/private/tmp/issue-5196-proxy-representatives.txt --standalone --isolate`
ran the repository's `runTest262File` path in fresh child processes. It
reported `2 fail, 1 pass`:

- `built-ins/Proxy/revocable/revoke-returns-undefined.js` — fail at
  `assert.sameValue(r.revoke(), undefined)`, observed `null`.
- `built-ins/Proxy/revocable/revoke-consecutive-call-returns-undefined.js` —
  fail at its second `r.revoke()` assertion, observed `null`.
- `built-ins/Proxy/revocable/revoke.js` — pass; the same result record exposes
  a callable `revoke` field.

This validates both a current failing pair and a current passing control through
the maintained standalone runner, rather than inferring behavior from the
baseline alone.

## Narrow causal slice: revoker return value

The two selected rows are independently causal, not selected because their
error strings match. Both call the `__proxy_revoker` carrier through the one
Proxy-specific branch in `fillApplyClosure` in
`src/codegen/object-runtime.ts`. That branch successfully calls
`__proxy_revoke`, then returns its local `undefinedSentinel()`, which is a bare
`ref.null.extern`. In the default standalone undefined-singleton regime a bare
null is JavaScript `null`; the repository's
`canonicalUndefinedExternInstrs(ctx)` exists specifically to emit the exact
standalone `undefined` carrier without a host import. The Test262 sources
require `undefined` after both the first call (RevocableProxy step 7) and an
already-cleared second call (step 2).

No result-invariant, descriptor, target/handler, array, TypedArray, class,
RegExp, Promise, generator, or global skip behavior is part of this slice.

## Implementation Plan

1. In only the `$Proxy` revoker arm of `fillApplyClosure`, replace the bare
   null sentinel returned after `__proxy_revoke` with
   `canonicalUndefinedExternInstrs(ctx)`. Leave the generic not-callable and
   arity-overflow fallback unchanged; those represent different semantics.
2. Add a focused #5196 test that compiles a revocable Proxy in host and
   standalone lanes, observes `revoke() === undefined` on first and second
   calls, still observes revocation, and checks `null !== undefined`. The
   standalone control must instantiate with zero host imports. Add the two
   exact standalone Test262 rows through `runTest262File`, plus the existing
   passing standalone `revoke.js` control.
3. Re-run the maintained standalone path list after the change. A successful
   slice must convert exactly the two claimed fail rows to `pass`, not merely
   compile them into a different non-pass status. Run proportionate focused
   quality checks without changing skips or importing a host provider.

## Validation on the f841 worktree and b590 delivery head

- One-worker focused Vitest lane:
  `node node_modules/vitest/dist/cli.js run
  tests/issue-5196-es2015-proxy-r2.test.ts --pool=forks
  --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot` —
  **5 passed**. This includes host and standalone compiler controls, the two
  formerly failing exact standalone rows, and the maintained-runner
  `revocable/revoke.js` passing control.
- The standalone compiler control instantiated with `{}` and asserted an empty
  `WebAssembly.Module.imports` list. It checks first and repeated revoker calls
  return `undefined`, remain distinct from `null`, and still revoke the Proxy.
- Focused Prettier check and Biome error-level lint passed for the changed
  production and test files; `git diff --check` passed.
- Before publication, this dirty checkpoint was fast-forwarded without conflict
  to current upstream `b590669a7b0dd9537d9b9e703218d9cd6eec3106` (the only
  intervening source change is disjoint #3521 prepared-free-function routing).
  The same one-worker focused file passed **5/5** at that exact delivery base;
  TS5 and TS7 typechecks also passed. Focused Prettier and Biome checks,
  function budget, oracle ratchet, issue-spec coverage, and `git diff --check`
  passed on that head. The LOC gate passed with this issue's explicit
  `src/codegen/object-runtime.ts` allowance for the five-line import expansion.
- Upstream then released v0.71.0. PR #5389 had no merge-queue entry, so the
  branch was normally merged with release head
  `7fffec534b44e344f9c2b2b310b346084eaa66b6`; its version-only delta is
  disjoint. The focused one-worker matrix passed **5/5** again on the resulting
  merge head before the checkpoint push. PR #5389 remains the single non-draft
  upstream delivery for this completed two-row fix.
- No full 310-row re-census was run after the two exact rows passed: this lane
  preserves the required two-global-compiler-lane cap. Relative to the fresh
  snapshot, the unrerun residual is therefore 113 baseline `fail` rows plus 13
  baseline `compile_error` rows; the two claimed rows are directly verified as
  `pass` rather than inferred from compilation.

## Acceptance criteria

- The exact 128-row inventory and first-stop histogram above are present before
  production implementation.
- The two claimed revocable-return rows pass in the maintained standalone lane,
  while the passing control and focused host/standalone controls stay green.
- Standalone output remains host-import-free; no global skip changes.

## References

- #5140 (wave-1 plan), PRs #5173, #5213.

## 2026-09-01 r2 residual plan (post-#5389)

Written by the Fable planning lane (`claude.ai@loopdive.com/fable-es6`) for an
Opus implementer. Input: the 157-row standalone list
`.tmp/es2015/proxy-paths.txt` (baseline `loopdive/js2wasm-baselines`, compiler
sha `d39779cb`, 2026-09-01, an ancestor of HEAD; includes PR #5389) —
`built-ins/Proxy/**` 125 rows + `built-ins/Reflect/**` 32 rows, errors in
`.tmp/es2015/proxy-errors.tsv`.

Growth-allowance rationale (2026-09-01, this plan): every step below adds NEW
emitted-code paths — seven §10.5 post-trap invariant validators over the
descriptor model, a receiver-threaded `[[Set]]` dispatch plus an
OrdinarySet-with-receiver primitive, a proxy-link prototype representation
with per-hop arms in the chain walkers, `$Proxy` front-guards on three more
natives, first-class revoker metadata, and six Reflect-arm repairs — growth,
not refactor. The two heavy pieces are asked to live in NEW modules
(`src/codegen/object-runtime-proxy-invariants.ts`,
`src/codegen/object-runtime-ordinary-set.ts`) so the listed god-files grow
only by wiring; the `func-budget-allow` entries are arm-ladder functions that
gain one more arm in the shape their existing arms already have.

### Re-verification on HEAD `c68dea0d2` (2026-09-01)

`sed 's#^test/##' proxy-paths.txt > .tmp/es2015/proxy-head.txt`, then
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/proxy-head.txt --standalone`
(157 rows, one in-process run, QuickJS runtime-eval tier active, box load
10–16 on 4 cores). Raw verdicts: `.tmp/es2015/proxy-head-run1.txt` /
`.tsv`.

| | pass | fail | compile_error |
|---|---|---|---|
| baseline d39779cb | 0 | 134 | 23 |
| HEAD c68dea0d2 | **0** | 132 | 25 |

**Nothing dropped — all 157 still fail.** The two status changes are compile
TIMEOUTS under load (`setPrototypeOf/not-extensible-target-same-target-prototype.js`
16.2 s, `apply/null-handler-realm.js` 16.0 s, budget 15 s); re-run alone
(`.tmp/es2015/proxy-timeouts.txt` → `proxy-timeouts-run.txt`):
both are ordinary `fail` with the baseline signature (`target has the custom set prototype` / `Proxy.revocable is not yet implemented`) — load artifacts, not hangs; HEAD therefore equals the baseline exactly: 0 / 134 / 23. The 30 "signature changes" are formatting only (`L42:11`
prefix / `RuntimeError:` prefix added by the runner) — the baseline's error
text is current for every row, so the baseline histogram is still the right
input.

**Target = 127 in-scope rows + 30 owned elsewhere.** Every row of
`proxy-head.txt` lands in exactly one `.tmp/es2015/proxy-cl-<X>.txt` sub-list
(partition written by `.tmp/es2015/proxy-cluster.py`, verified 157/157, 0
duplicates, 0 unclustered; per-row map `.tmp/es2015/proxy-clusters.tsv`).

Minimal repros (`.tmp/es2015/probes5196/p*.js`, run one at a time with
`npx tsx .tmp/probe-one.mts <abs path>`; results `probes-run1.txt`):

| probe | shows | verdict on HEAD |
|---|---|---|
| p1 | §10.5.6 defineProperty invariant (trap true over a non-configurable non-writable `foo:1`, new value 2) | no TypeError — cluster A1 |
| p2 | §10.5.5 gOPD trap returning `undefined` for a non-configurable target prop | no TypeError — A2 |
| p3 | §10.5.7 has trap false over a non-configurable target prop | no TypeError — A3 |
| p4 | `Object.create(proxy)` heir: `"x" in heir`, `heir.y`, `heir.z = 1`, `getPrototypeOf(heir) === proxy` | **no trap fires at all, `getPrototypeOf(heir) !== proxy`** — B (the proxy is unwrapped to its target by `__proxy_get_target_if_absent`, or dropped to null when a `get` trap exists) |
| p5 | revoker shape | `typeof revoke === "function"` already; `gOPD(revoke, "length")` is `undefined` — D |
| p6 | `Reflect.setPrototypeOf(proxy)` with a false-returning trap; on a non-extensible ordinary target | both answer `true` — C2 |
| p7 | `Reflect.ownKeys` on `{p1, [sym], 2, 0}` | **null-deref in `__module_init`** (symbol key + integer keys on one `$Object`) — C6 |
| p8 | plain gOPD through a trap-less proxy over `{attr: 1}` | passes — the `gopd/trap-is-undefined.js` deref is inside `verifyProperty`'s write/restore, see G |
| p9 | §10.5.11 ownKeys trap returning `[]` over a non-configurable key | no TypeError — A7 |
| p10 | getPrototypeOf invariant over `Object.create(Array.prototype)` made non-extensible, trap returns `Array.prototype` | invariant THROWS although the protos agree — and `Object.getPrototypeOf(target) === Array.prototype` is already `false` without any proxy (proto-VIEW vs value identity) — A8 |
| p11 | `Reflect.get(1,…)`, `Reflect.has('',…)`, `Reflect.apply({},…)`, `Reflect.apply(fn, null)` | 0 of 4 TypeErrors — C4 |
| p12 | `Reflect.defineProperty(frozen, 'p1', {value: 43})` | THROWS "Cannot assign to read only property" instead of returning `false` — C7 |
| p13 | defineProperty routing: `new Proxy` binding with a variable descriptor / an inline value-less descriptor / `Proxy.revocable(...).proxy` | first two reach the trap; **`r.proxy` does not** (syntactic gate, `object-ops.ts:979`) — E |

Controls (`.tmp/es2015/proxy-controls.txt`, 18 baseline-passing ES2015
Proxy/Reflect rows, seeded sample across 12 subtrees): **18/18 pass on HEAD** (`proxy-controls-run1.txt`).

### Out of scope — owned elsewhere (30 rows; `proxy-cl-X{1,2,3,4}.txt`)

| id | rows | owner | why / per-row judgement |
|---|---|---|---|
| X1 | 14 | #3371 (`Reflect.construct` arm, `call-namespace-static.ts:1553-1700`) | 11 distinct-NewTarget rows (`Proxy/construct/{call-parameters-new-target, trap-is-{null,undefined}, trap-is-undefined-no-property, trap-is-{missing,null,undefined}-target-is-proxy, trap-is-undefined-proto-from-cross-realm-newtarget}`, `Proxy/get-fn-realm{,-recursive}`, `construct/trap-is-undefined-proto-from-newtarget-realm` (a `Reflect.construct(P, [], C)` with a distinct `C`), `Reflect/construct/return-with-newtarget-argument`) + `Reflect/construct/arguments-list-is-not-array-like` (the arm's array-literal-argsList refusal, L1567) + `Reflect/construct/target-is-not-constructor-throws` (not a NewTarget row, but the fix is a 5-line `ensureReflectIsConstructor` guard at the SAME arm's entry — leave it to the arm owner to avoid a conflicting edit; #3371 is `status: blocked`, `updated: 2026-09-01`). |
| X2 | 7 | #2046 (`Reflect.set` explicit receiver, `call-namespace-static.ts:895-920`) | all `Reflect/set/*` rows with a 4th argument. Step 4 below builds the OrdinarySet-with-receiver primitive #2046 needs — see the coordination note there; the arm itself is not touched. |
| X3 | 3 | runtime-eval / realm harness (#5156/#5157 acceptance criteria) | `revocable/tco-fn-realm` (`other.evalScript` + `other.global.TypeError` identity), `apply/arguments-realm` and `construct/arguments-realm` (`createRealm().global.eval('new Proxy(...)')` — the proxy is created INSIDE the QuickJS eval tier, then `.constructor === Array` is asserted across the boundary). Not realm-independent; leave. |
| X4 | 6 | see cell | `apply/trap-is-missing-target-is-proxy` — `Object.prototype.hasOwnProperty` read as a VALUE is a refusal-body closure (`builtin-value-read.ts:1664`, "not yet implemented"); needs a reflective body in the Object-builtins lane (#5268 area, unclaimed there — hand off). `ownKeys/call-parameters-object-getownpropertysymbols` — the `$Proxy` arm on `__getOwnPropertySymbols` is **#5268 Step 2.5** (do not twin it). `enumerate/removed-does-not-trigger` — `#1320 values()` CE, ES2015-only `enumerate` trap (removed in ES2016), leave. `preventExtensions/trap-is-undefined-target-is-proxy` — `import * as ns` module-namespace exotic, no owner, leave. `Reflect/deleteProperty/delete-properties` + `Reflect/setPrototypeOf/return-true-if-new-prototype-is-set` — the receiver is a CLOSED-struct literal (`{prop: 42}` / `{}`) that the natives cannot mutate; value-rep demotion (#2949/#2580), not a Reflect defect. |

Generator-carrier rows (#680/#2864): none in this list. The other 27 `*-realm*` rows are IN scope — cluster R below: they are realm-INDEPENDENT on this lane.

### Cluster table (in scope, 127 rows; HEAD-verified)

| # | cluster | count | root cause (file:function) | sample tests |
|---|---|---|---|---|
| R | `Proxy` as a first-class constructor VALUE (`new OProxy(t, h)`, `OProxy.revocable(t, h)`) | 27 | Every `*-realm*` row does `var OProxy = $262.createRealm().global.Proxy` and then `new OProxy(…)` / `OProxy.revocable(…)`. On this lane that read resolves to the CURRENT realm's seeded `Proxy` NAMESPACE carrier (`emitBuiltinNamespaceObject`, `builtin-static-globals.ts:469`; `["Proxy", []]` at `:40`; seeded onto the native global by `appendStandaloneGlobalNamespaceSeeds`, `standalone-global-object-carriers.ts:21`) — proven by the runtime text `Proxy.revocable is not yet implemented in --target standalone` (the refusal body `builtin-value-read.ts:1664` minted for the un-wired `revocable` member; `BUILTIN_STATIC_METHOD_ARITY.Proxy = { revocable: 2 }`, `builtin-fn-meta.ts:171`). `new <that carrier>(t, h)` takes the standalone construct driver (`native-construct.ts:248 fillNativeConstructDrivers`) whose only special arm is `ref.test $Proxy` (`:265`); a plain `$Object` callee falls to the ordinary tail (`proto = callee.prototype` → `__object_create` → `__apply_closure` sentinel) and silently yields an EMPTY object — so every later assertion sees no proxy and no TypeError ("no exception was thrown"). 21 rows are otherwise identical to a non-realm twin that PASSES on HEAD (11 `trap-is-not-callable-realm`, 6 `construct/return-not-object-throws-*-realm`, `ownKeys/return-not-list-object-throws-realm`, 3 `null-handler-realm`); 6 (`defineProperty/targetdesc-*-realm` ×5, `gopd/result-type-is-not-object-nor-undefined-realm`) additionally need Step 1. The direct `Proxy.revocable(...)` CALL is wired only for the literal identifier `Proxy` (`call-builtin-static.ts:3796-3830`). | `get/trap-is-not-callable-realm.js`, `construct/return-not-object-throws-undefined-realm.js`, `apply/null-handler-realm.js` |
| A1 | §10.5.6 `[[DefineOwnProperty]]` steps 15–17 not enforced | 6 | `src/codegen/object-runtime-proxy.ts:928 buildDefineDispatch` returns the trap result as-is (header comment: "Phase-F scope: NO result-invariants"). No IsCompatiblePropertyDescriptor / settingConfigFalse / non-configurable-writable check against `__getOwnPropertyDescriptor(target, key)`. p1. | `defineProperty/targetdesc-not-compatible-descriptor.js`, `targetdesc-undefined-target-is-not-extensible.js` |
| A2 | §10.5.5 `[[GetOwnProperty]]` steps 9–17 not enforced | 7 | `buildDispatch(TRAP_GOPD, …)` (`:264`) trap arm returns the raw trap value: no Object-or-undefined check, no undefined-vs-targetDesc rules, no ToPropertyDescriptor validation, no resultDesc/targetDesc compatibility. p2. | `getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined.js`, `resultdesc-is-not-configurable-targetdesc-is-configurable.js` |
| A3 | §10.5.7 `[[HasProperty]]` step 9 not enforced | 4 | `buildDispatch(TRAP_HAS, …)` trap arm; the two `-using-with` twins fail with ReferenceError because `with (p) { attr }` resolves through `__extern_has` (`object-runtime.ts:4864`, `$Proxy` front-guard at `object-runtime-proxy.ts:1845`) and the false answer is not the required TypeError. p3. | `has/return-false-targetdesc-not-configurable.js`, `has/return-false-target-not-extensible-using-with.js` |
| A4 | §10.5.8 `[[Get]]` step 10 not enforced | 2 | `buildDispatch(TRAP_GET, …)` trap arm (get had only the #4721 callable guard). | `get/not-same-value-configurable-false-writable-false-throws.js`, `get/accessor-get-is-undefined-throws.js` |
| A5 | §10.5.9 `[[Set]]` step 10 not enforced | 2 | `buildDispatch(TRAP_SET, …)` trap arm. | `set/target-property-is-not-configurable-not-writable-not-equal-to-v.js` |
| A6 | §10.5.10 `[[Delete]]` steps 11–13 not enforced | 2 | `buildDispatch(TRAP_DELETE, …)` trap arm (Slice A comment: "NO §10.5.10 result-invariant"). | `deleteProperty/targetdesc-is-not-configurable.js`, `targetdesc-is-configurable-target-is-not-extensible.js` |
| A7 | §10.5.11 `[[OwnPropertyKeys]]` steps 9–23 not enforced | 3 | `buildOwnKeysDispatch` (`:732`) validates only CreateListFromArrayLike + duplicates; no non-configurable-keys-present / non-extensible-exact-set check. p9. | `ownKeys/return-all-non-configurable-keys.js`, `ownKeys/not-extensible-new-keys-throws.js` |
| A8 | `[[GetPrototypeOf]]` invariant identity + `instanceof` bypasses the trap | 3 | (a) `buildProtoDispatch` (`:444`) compares the trap result against `__getPrototypeOf(target)` with `__extern_strict_eq`; the stored `$proto` is the callable's PROTO-VIEW (`object-runtime-prototype.ts:265 canonicalizeProtoArg` → `__proto_from_function`) while the trap returns the VALUE, so `Array.prototype` ≠ itself (p10 — even `Object.getPrototypeOf(Object.create(Array.prototype)) === Array.prototype` is false today); (b) `p instanceof Custom` lowers to `__isPrototypeOf(F.prototype, p)` (`native-user-instanceof.ts:132` → `object-runtime-prototype.ts:803`) whose seed is `cur = candidate is $Object ? cast : null` — a `$Proxy` candidate yields null before any hop, so the trap is never consulted. | `getPrototypeOf/not-extensible-same-proto.js`, `getPrototypeOf/instanceof-custom-return-accepted.js` |
| B | proxy as `[[Prototype]]` + receiver threading | 12 | `Object.create(proxy)` / `Object.setPrototypeOf(o, proxy)` store the proxy's TARGET (`__proxy_get_target_if_absent`, `object-runtime-prototype.ts:210`, reached from `canonicalizeProtoArg`) or null (when a `get` trap exists) because `$Object.proto` is `ref null $Object` and `$Proxy` is a sibling type (`object-runtime.ts:1229` note) — p4: no trap fires, `getPrototypeOf(heir) !== proxy`. Also `__proxy_set_dispatch` (`:264`, `trapArm` pushes param 0 as receiver) has no receiver parameter, and its trap-absent arm forwards `__extern_set(target,…)` — OrdinarySet's receiver-side `[[GetOwnProperty]]`/`[[DefineOwnProperty]]` (steps 2.c–2.e of §10.1.9.2) never runs, so `p.foo = 2` with gopd/defineProperty traps but no set trap fires nothing. | `has/call-in-prototype.js`, `set/call-parameters-prototype.js`, `get/trap-is-undefined-receiver.js`, `set/trap-is-missing-receiver-multiple-calls.js`, `get/trap-is-undefined-target-is-proxy.js` |
| C1 | `Reflect.set` bypasses the proxy | 2 | the 3-arg arm (`call-namespace-static.ts:920-940`) calls `__reflect_set` (`object-runtime.ts:4202`), which has NO `$Proxy` front-guard (only `__extern_set` got one, `object-runtime-proxy.ts:1760`) → a proxy target is "not an `$Object`" → false. | `set/return-true-target-property-is-not-configurable.js`, `set/trap-is-undefined-target-is-proxy.js` |
| C2 | `Reflect.setPrototypeOf` / `Object.setPrototypeOf(proxy)` ignore the boolean | 5 | Reflect arm `:1229-1290` drops the native result and pushes `i32 1` ("KNOWN LIMITATION"); `Object.setPrototypeOf` (`call-builtin-static.ts:1916-2016`) asks `__object_setPrototypeOf_status` (permissive `1` for `$Proxy`, `object-runtime-prototype.ts:708`) then ignores the writer's booleanish return. p6. | `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js`, `Proxy/setPrototypeOf/toboolean-trap-result-false.js`, `Proxy/setPrototypeOf/trap-is-missing-target-is-proxy.js` |
| C3 | `preventExtensions` boolean/throw over a proxy | 3 | Reflect arm `:1332-1385` drops the native result → `true`; `Object.preventExtensions` (`call-builtin-static.ts:1671-1800`) returns the object without reading the `$Proxy` guard's booleanish result (§20.1.2.19 step 2.b TypeError). | `Reflect/preventExtensions/return-boolean-from-proxy-object.js`, `Proxy/preventExtensions/return-false.js` |
| C4 | Reflect target/callable/list guards | 5 | get/has arms guard only the Symbol carrier (`mayCarryNativeReflectSymbol`, `:774`); the #5140 `apply` arm (`:1447`) tests only positive primitive brands (a plain `{}` target passes) and reads `__extern_length` of a missing/primitive list without the §7.3.19 Object check; `Reflect.apply(fn, o, …)` reaches a plain closure with `this === null` (the `__apply_closure` → `__call_fn_method_N(recv, fn, …)` route, `object-runtime.ts:7420+`). p11. | `Reflect/get/target-is-not-object-throws.js`, `Reflect/apply/arguments-list-is-not-array-like.js`, `Reflect/apply/call-target.js` |
| C5 | ToPropertyKey abrupt not observed; 2-arg `defineProperty` CE | 4 | get / gopd / set(3-arg) arms pass the raw key to the natives, whose lazy coercion never calls the object's `toString`; `Reflect.defineProperty({}, p)` (2 args) falls to the `#1472 Phase C` refusal (`:1700-1716`) because the arm requires `descArg !== undefined` (`:1148`). `__to_property_key` exists (`object-runtime.ts:1509`). | `Reflect/get/return-abrupt-from-property-key.js`, `Reflect/defineProperty/return-abrupt-from-property-key.js` |
| C6 | `Reflect.ownKeys` order + symbols | 3 | arm `:1022-1057` → `__getOwnPropertyNames` only (string keys; comment says "does not retain symbol-keyed properties yet" — stale since #2866); index ordering must be array-index (`< 2^32-1`) ascending, then strings by `seq`, then symbols (`__obj_ordered`, `object-runtime.ts:6065`, sorts by `__obj_index_of_key` which already caps at the #4434 bound). p7 null-derefs. | `Reflect/ownKeys/return-on-corresponding-order.js`, `-large-index.js`, `order-after-define-property.js` |
| C7 | `Reflect.defineProperty` throws instead of `false` | 1 | the #2042 S4 ValidateAndApply preflight in `__defineProperty_value` (`object-runtime-descriptors.ts:280-440`) / `__defineProperty_accessor` (`:781-1004`) THROWS; Reflect needs the boolean (§28.1.3 step 4). p12. | `Reflect/defineProperty/return-boolean.js` |
| C8 | namespace/prototype identity residue | 5 | `Reflect.hasOwnProperty('enumerate')` hits the Phase-C refusal (`:1700`); `Object.getPrototypeOf(Reflect)` / `(Proxy)` are `null` — `emitBuiltinNamespaceObject` (`builtin-static-globals.ts:469`) builds them with `__new_plain_object` (null proto); `Reflect.getPrototypeOf({})` is `null` where `Object.getPrototypeOf` answers `%Object.prototype%` through `tryCompileEs5GetPrototypeOfValue` (`object-get-prototype-of.ts:253`, keyed on the ARGUMENT shape, reusable); `defineProperty/desc-realm` reads `Object.getPrototypeOf(desc)` of the descriptor `$Object` handed to the trap DYNAMICALLY — `__getPrototypeOf` (`object-runtime-prototype.ts:376`) returns the raw null `$proto` of an ordinary `$Object` instead of the implicit `%Object.prototype%` (only `OBJ_FLAG_NULL_PROTO` objects are truly null-prototype). | `Reflect/enumerate/undefined.js`, `Reflect/object-prototype.js`, `Proxy/function-prototype.js`, `Reflect/getPrototypeOf/return-prototype.js`, `Proxy/defineProperty/desc-realm.js` |
| D | revoker is not a first-class function value | 4 | `__proxy_revoker` is a bare 1-field struct (`object-runtime-proxy.ts:1636-1710`); only `fillApplyClosure` (`object-runtime.ts:7665`) and `__typeof_function` (p5) know it. No `length`/`name` own props, `isConstructor` probe throws, `new revoke()` does not throw. | `revocable/revocation-function-length.js`, `revocation-function-not-a-constructor.js` |
| E | trap reads are eager; define fast path bypasses proxies | 4 | `__proxy_create` (`:1420-1560`) reads all 13 traps at construction, so an accessor `setPrototypeOf` on the handler throws at `new Proxy` (spec: GetMethod per operation); `Object.defineProperty(x, k, {…literal…})` takes the `__defineProperty_value` fast path unless `x` is SYNTACTICALLY a `new Proxy` binding (`object-ops.ts:979-1000` gate) — `r.proxy`, aliases, `heir` bypass the trap (p13); `Object.getOwnPropertyDescriptor(p.proxy)` with ONE argument falls to the `__get_builtin` CE (`call-builtin-static.ts:2696` requires `arguments.length >= 2`). | `setPrototypeOf/return-abrupt-from-get-trap.js`, `defineProperty/null-handler.js`, `defineProperty/call-parameters.js`, `getOwnPropertyDescriptor/null-handler.js` |
| F | exotic targets under the trap-absent forward | 18 | the forwards call the `$Object`-centric natives on array / String-wrapper / RegExp / function / bound-function targets (`__extern_get`/`has`/`set`, `__getOwnPropertyDescriptor`, `__delete_property`, `__obj_define_from_desc`, `__getOwnPropertyNames`, `__object_setPrototypeOf`, `__apply_closure`); each row's first failure is that carrier's MOP, not the proxy layer (`arrayProxy.length = 0` no-op; `stringProxy.length` deref; RegExp brand check on `lastIndex`; `sumBound` via `__apply_closure` deref; `Object.create(Array.prototype)` target answers `"length" in p` false — the #4160 companion terminal). Also the two `Object.create(<proxy over exotic>)` reads that additionally need B. | `set/trap-is-null-target-is-proxy.js`, `get/trap-is-null-target-is-proxy.js`, `has/trap-is-undefined.js`, `apply/trap-is-null-target-is-proxy.js` |
| G | closed-struct target / static-shape leakage | 5 | a literal bound to a variable and passed as `new Proxy(<id>, …)` TARGET keeps its closed typed-struct representation (`analysis/proxy-binding-escape.ts:284 proxyBindingIsTarget` only affects the PROXY binding), so `delete p.attr` forwards `__delete_property` onto a non-`$Object` (no-op, returns 1) and `gOPD(target,"attr")` still answers; `"attr" in p` folds statically true from p's TS type `{attr: number}` (`binary-ops-in.ts` fold, #5140 7a fixed only statement-position elision); `verifyProperty(p, "attr", …)`'s restore path derefs (p8's plain read passes). | `deleteProperty/trap-is-undefined-strict.js`, `has/return-false-target-prop-exists.js`, `getOwnPropertyDescriptor/trap-is-undefined.js`, `setPrototypeOf/not-extensible-target-same-target-prototype.js` |

### Implementation plan

Ordered by yield; each step is independently shippable. After each step re-run
its `.tmp/es2015/proxy-cl-<X>.txt` list(s) and the controls with
`npx tsx scripts/run-test262-paths.mts <list> --standalone` (in-process is
fine — no row in these lists mutates a shared intrinsic; use `--isolate` only
if a run dies mid-way). Type queries go through `ctx.oracle`
(`src/checker/oracle.ts`), never `ctx.checker` (oracle-ratchet gate). Every
`Instr[]` template is a FACTORY minted fresh per use (the "FRESH array"
discipline documented at `object-runtime-proxy.ts:96-104` — a shared array is
double-remapped by the FINALIZE funcIdx walk). Anything filled at finalize
follows reserve-then-fill (`fillProxyDispatch`, `:2323`). Throws inside the
proxy runtime use the existing shape `stringConstantExternrefInstrs(ctx, msg)`
+ `call __new_TypeError` + `throw <exnTag>` (`throwRevoked`, `:96`); at compile
sites use `buildThrowJsErrorInstrs(ctx, "TypeError", msg, { flush: fctx })`
(`js-errors.ts:71`). Standalone-only: gate every new arm on the proxy runtime
having been registered (`ctx.funcMap.has("__proxy_get_dispatch")`) so gc/host
bytes stay identical.

#### Step 0 — `Proxy` as a first-class constructor value (R, 27 rows) — `proxy-cl-R.txt`

Cheapest step, highest yield; do it first. Confirm the premise with a 3-line
probe (`var OProxy = $262.createRealm().global.Proxy; if (OProxy !== Proxy) throw 0;
OProxy.revocable({}, {})` → must print the refusal text on HEAD) before
editing — the alias mechanism lives in the harness shim (`tests/test262-runner.ts:2315-2333`;
#3371's note at `property-access-dispatch.ts:317` documents that
`createRealm().global` IS the current native global), and this issue does NOT
touch the shim.

1. **`new <Proxy carrier>(target, handler)`** — in `fillNativeConstructDrivers`
   (`native-construct.ts:248`), BEFORE the `ref.test $Proxy` arm, add: callee
   (param 0, `any.convert_extern`) `ref.eq` the `Proxy` namespace global
   (`ctx.builtinObjectGlobals.get("Proxy")` → `global.get`, `any.convert_extern`;
   the global is lazily initialised on first read, so also test
   `ref.is_null` of the global first) → `call __proxy_create(arg0, arg1)`
   (`object-runtime-proxy.ts:1573`; arity < 2 pads `ref.null.extern`, which
   `__proxy_create` rejects with the §28.2.1.1 TypeError) → `return`. Register
   the arm only when `ctx.funcMap.has("__proxy_create")`. Same arm for the
   `Reflect.construct(OProxy, [t, h])` route if the #3371 arm is reachable —
   not required by any R row.
2. **`OProxy.revocable(t, h)`** — `ensureStandaloneBuiltinStaticMethodClosure`
   (`builtin-value-read.ts:962`): add `case "Proxy.revocable"` beside the
   `Reflect.get/has/set` cases (`:1038-1050`): `paramTypes = [externref,
   externref]`, `returnType = externref`, body `call __proxy_revocable`
   (`object-runtime-proxy.ts:1658`; `ensureNativeProxyRuntime(ctx)` first, the
   way `call-builtin-static.ts:3803` does). The namespace seed then carries a
   working `revocable` value; `p.revoke()` already routes through
   `fillApplyClosure`'s revoker arm (#5389).
3. `Proxy.length === 2` / `Proxy.name` are not asserted by any R row; leave.

Expected: **+21** immediately (the rows whose non-realm twin passes), +6 more
with Step 1. Re-run `proxy-cl-R.txt` after Step 0 AND after Step 1.

#### Step 1 — §10.5 descriptor-model invariants (A1–A8, 29 rows) — `proxy-cl-A1.txt` … `proxy-cl-A8.txt`

New module `src/codegen/object-runtime-proxy-invariants.ts` exporting
`registerProxyInvariantHelpers(ctx, types, registerNative)` (called from
`ensureProxyRuntime` right after `addUnionImportsViaRegistry`, `:83`) and one
`Instr[]` factory per operation that `ensureProxyRuntime`'s dispatch builders
splice into their trap arms after the driver call. The Phase-1/#5140
"deferred to slice G — needs the descriptor-attribute model" note is stale:
the model exists (`$PropEntry.flags` bits `FLAG_WRITABLE|ENUMERABLE|CONFIGURABLE`,
`object-runtime.ts:254-256`; `OBJ_FLAG_NONEXTENSIBLE`, `:294`) and is already
reified into descriptor objects by `__getOwnPropertyDescriptor`
(`object-runtime-descriptors.ts:2909`, data → `{value, writable, enumerable,
configurable}`, accessor → `{get, set, enumerable, configurable}`, absent →
undefined singleton), so the validators work on DESCRIPTOR OBJECTS through
the existing readers.

**1-a. Shared primitives (register once, `(externref…) -> i32`):**

- `__proxy_desc_attr(desc, name) -> i32`: `__extern_get(desc, name)` (funcMap
  `__extern_get`, `object-runtime.ts:2611`) → `__is_truthy`. `name` is a
  `stringConstantExternrefInstrs` literal at each call site.
- `__proxy_desc_has(desc, name) -> i32`: `__desc_has_own ?? __hasOwnProperty`
  (the same fallback pair `object-runtime-descriptors.ts:1240` uses).
  IsDataDescriptor = has `value` ∨ has `writable`; IsAccessorDescriptor =
  has `get` ∨ has `set`.
- `__proxy_is_undefined(v) -> i32`: `ref.is_null` ∨ `__extern_is_undefined`
  (`object-runtime.ts:6382`) — under the undefined-singleton regime a trap
  returning `undefined` is a NON-null externref, and `ref.is_null` alone
  misclassifies it (this is the #2106 S1 lockstep rule; `__nullish_to_null`,
  `:2713`, is the canonicalizer when a null-keyed test is wanted).
- `__proxy_target_desc(target, key) -> externref`: `__getOwnPropertyDescriptor`
  (already `$Proxy`-front-guarded, `object-runtime-proxy.ts:1901`, so a
  proxy-of-proxy target recurses correctly) followed by `__nullish_to_null`.
- `__proxy_target_ext(target) -> i32`: `__object_isExtensible` (front-guarded,
  `:1979`).
- `__proxy_same_value(a, b) -> i32`: `__object_is`
  (`object-runtime-enumeration.ts:1567`, `(externref, externref) -> i32`,
  full SameValue incl. NaN/±0) — NOT `__extern_strict_eq`; the A4/A5 rows
  are specified with SameValue.
- `__proxy_desc_compatible(extensible: i32, desc, current) -> i32`:
  §10.1.6.3 ValidateAndApplyPropertyDescriptor with `O = undefined` (pure
  predicate, no writes). Steps, all through the readers above: current
  undefined → return `extensible`; desc has no fields → 1; current
  non-configurable: desc.configurable true → 0, desc has `enumerable` and it
  differs → 0; generic desc → 1; IsData(current) ≠ IsData(desc) → 0 when
  current non-configurable; both data, current non-configurable non-writable:
  desc.writable true → 0, desc has value and `!SameValue(value)` → 0; both
  accessor, current non-configurable: `get`/`set` present and not SameValue
  → 0; else 1. Descriptor arguments arrive as `$Object`s: the trap result in
  A2 comes from user code (may be a CLOSED literal struct — run it through
  the same reify the applier uses, `emitDescriptorStructReify` is compile-time
  only, so at runtime accept `$Object` and treat any other non-null carrier as
  "an Object with no readable fields" ⇒ CompletePropertyDescriptor defaults),
  and the target descriptor always comes from `__getOwnPropertyDescriptor`.
- `__proxy_to_property_descriptor(obj) -> externref`: §6.2.6.5 — obj must be
  an Object (`__typeof_object` ∨ `__typeof_function`, minus null/undefined,
  the exact shape `reflect-target-guard.ts:22` emits) else TypeError; `get`/
  `set` present and neither callable (`__typeof_function`) nor undefined →
  TypeError; data+accessor mix → TypeError (message:
  "Invalid property descriptor. Cannot both specify accessors and a value or
  writable attribute", the text `__obj_define_from_desc` already uses,
  `object-runtime-descriptors.ts:2360`). Returns `obj` (fields read lazily by
  the readers; CompletePropertyDescriptor defaults are applied inside the
  readers by treating an absent field as false/undefined).

**1-b. Per-operation validators** (each a factory returning `Instr[]` that
expects the trap result in local `RES` and the dispatch's `p` local; the
`dispatchLocals()` template at `:1001` already reserves `res` as local
`2 + arity`; add locals `tdesc`, `ext`, `booleanResult` to that template —
FRESH array per registration, per the `:993-1000` note):

| op | splice site | rule (spec step) |
|---|---|---|
| defineProperty (A1) | `buildDefineDispatch` `:928`, after `call callDefineIdx` | §10.5.6 10–17: `!ToBoolean(res)` → return `false` box (no throw); `tdesc = __proxy_target_desc(target, key)`; `ext = __proxy_target_ext(target)`; `settingConfigFalse = desc has configurable ∧ !configurable`; tdesc undefined: `!ext` → TypeError, `settingConfigFalse` → TypeError; else `!__proxy_desc_compatible(ext, desc, tdesc)` → TypeError, `settingConfigFalse ∧ tdesc.configurable` → TypeError, IsData(tdesc) ∧ `!tdesc.configurable` ∧ `tdesc.writable` ∧ desc has writable ∧ `!desc.writable` → TypeError. The `desc` here is the dispatch's param 2 (passed through unchanged). |
| getOwnPropertyDescriptor (A2) | `buildDispatch(TRAP_GOPD)` trap arm, after `call callGopdIdx` | §10.5.5 9–17: res not Object and not undefined → TypeError; `tdesc`, `ext`; res undefined: tdesc undefined → return undefined; `!tdesc.configurable` → TypeError; `!ext` → TypeError; return undefined. Else `resDesc = __proxy_to_property_descriptor(res)`; `!__proxy_desc_compatible(ext, resDesc, tdesc)` → TypeError; `resDesc has configurable ∧ !configurable`: tdesc undefined ∨ tdesc.configurable → TypeError; additionally `resDesc has writable ∧ !writable ∧ tdesc.writable` → TypeError. Return `res` unchanged (the caller reads the object). |
| has (A3) | `buildDispatch(TRAP_HAS)` trap arm | §10.5.7 9: `!ToBoolean(res)` ∧ tdesc defined: `!tdesc.configurable` → TypeError; `!ext` → TypeError. Return `res`. The `-using-with` twins follow automatically (`with` HasBinding is `__extern_has`). |
| get (A4) | `buildDispatch(TRAP_GET)` trap arm | §10.5.8 10: tdesc defined ∧ `!tdesc.configurable`: IsData ∧ `!writable` ∧ `!__proxy_same_value(res, tdesc.value)` → TypeError; IsAccessor ∧ `get` is undefined ∧ res not undefined → TypeError. |
| set (A5) | `buildDispatch(TRAP_SET)` trap arm | §10.5.9 10: `ToBoolean(res)` ∧ tdesc defined ∧ `!configurable`: IsData ∧ `!writable` ∧ `!SameValue(V, tdesc.value)` → TypeError; IsAccessor ∧ `set` undefined → TypeError. `V` is param 2. |
| deleteProperty (A6) | `buildDispatch(TRAP_DELETE)` trap arm | §10.5.10 11–13: `ToBoolean(res)` ∧ tdesc defined: `!configurable` → TypeError; `!ext` → TypeError. |
| ownKeys (A7) | `buildOwnKeysDispatch` `:732`, after the duplicate loop, before `local.get 3` | §10.5.11 9–23: `ext`; `targetKeys = __own_property_keys(target)` (Step 2-C6's helper — strings ∪ symbols; until it lands use `__getOwnPropertyNames` ∪ `__getOwnPropertySymbols`, both `$ObjVec`s); for each target key `k`: `tdesc = __proxy_target_desc(target, k)`; if `tdesc` defined ∧ `!configurable` → must be in the result list (scan with `__extern_strict_eq`; symbol identity is by `$Symbol.id`, which that helper compares) else TypeError; when `!ext` every target key (configurable ones too) must be present AND the result must contain no key outside `targetKeys` (count matched entries; `matched != resultLen` → TypeError). |
| getPrototypeOf (A8a) | `buildProtoDispatch` `:444`, the `!isSet` invariant block | replace `invStrictEqIdx(res, __getPrototypeOf(target))` by comparing CANONICAL views: `any.convert_extern(res)` → `call __proxy_get_target_if_absent` → `call __proto_from_function` (`PROTO_FROM_FUNCTION`, `proto-function-value.ts:108`; the pair `canonicalizeProtoArg` uses, `object-runtime-prototype.ts:265`) against the target `$Object`'s raw field-0 `$proto` (read directly when `ref.test $Object`, else `__getPrototypeOf(target)` without `devirtualizeProtoResult`), `ref.eq` on the `$Object` views, null-safe. Keep the existing SameValue fallback for non-`$Object` targets. Fixes p10's false positive; the same comparison is what makes `not-extensible-target-same-target-prototype`'s first assertion hold. |
| `instanceof` (A8b) | `__isPrototypeOf` seed, `object-runtime-prototype.ts:760-770` | if the candidate is a `$Proxy`: `cur = __getPrototypeOf(candidate)` (gpo dispatch, throws the §10.5.1 TypeError for `instanceof-target-not-extensible-not-same-proto-throws`) then continue the walk with that as `cur` (cast when `$Object`, else answer 0). **#5268 Step 2.7 replaces the per-hop `struct.get $proto` with `__getPrototypeOf(cur)`; land the seed here, take theirs for the hops (check `git log` for #5268 before editing the loop).** |

Edge cases: a REVOKED proxy is rejected before any trap read (unchanged);
the trap result is validated even when the target is itself a proxy
(`__proxy_target_desc` recurses through the front-guard — do NOT read
`ptarget`'s struct directly); a trap throwing propagates untouched (the
validators run after the driver returns); `ToBoolean` is `__is_truthy`
(spec), never `ref.is_null`; every TypeError message names the internal
method (`"'defineProperty' on proxy: trap returned truish for adding property
'x' which is incompatible with the existing property in the proxy target"`
style is fine — tests check the constructor only). Do not touch the
trap-ABSENT forward arms in this step.

Expected: +29 (A1 6, A2 7, A3 4, A4 2, A5 2, A6 2, A7 3, A8 3) + the 6
`*-realm` twins in R once Step 0 is in.

#### Step 2 — Reflect arms and call-site booleans (C1–C8, 28 rows) — `proxy-cl-C1.txt` … `proxy-cl-C8.txt`

All in `src/codegen/expressions/call-namespace-static.ts` unless noted; the
#2046 receiver refusal (`:895-920`) and every `reflectMethod === "construct"`
arm (`:1538-1700`, #3371) are NOT edited.

- **C1** `__reflect_set` (`object-runtime.ts:4202`): prepend the same
  `ref.test $Proxy` guard `__extern_set` got (`object-runtime-proxy.ts:1760`):
  `call __proxy_set_dispatch(p, key, value)` → `__is_truthy` → return. Add it
  in `ensureProxyRuntime` next to the `setBody` patch (same `findBody` idiom).
- **C2** `Reflect.setPrototypeOf` arm (`:1229-1290`): replace the `drop; i32.const 1`
  tail by: `status = __object_setPrototypeOf_status(obj, proto)`
  (`object-runtime-prototype.ts:708`, ensureLateImport it first — the
  `Object.setPrototypeOf` site `call-builtin-static.ts:1916-1935` shows the
  exact reservation order); `status == 0` → push 0 (no write); else
  `res = __object_setPrototypeOf(obj, proto)`; if `obj` is a `$Proxy`
  (`any.convert_extern` + `ref.test`) push `__is_truthy(res)` else push 1.
  `Object.setPrototypeOf` (`call-builtin-static.ts:2010`): after
  `call resolvedSpoIdx`, for a `$Proxy` receiver `__is_truthy` the result and
  throw the existing `throwRefused` on false (§20.1.2.21 step 4) —
  `trap-is-missing-target-is-proxy` (proxy over proxy over `{}`) needs the
  inner proxy's false to surface through the outer forward: the outer
  `buildProtoDispatch` forward arm (`:520`) drops the inner result and pushes
  the proxy as a truthy token — change it to push the inner
  `__object_setPrototypeOf` result when the target is a `$Proxy` (box
  `__is_truthy` of it), keep the token for ordinary targets.
- **C3** `Reflect.preventExtensions` arm (`:1362-1375`): `__is_truthy` the
  native's externref for a `$Proxy` target instead of `drop; 1`.
  `Object.preventExtensions` (`call-builtin-static.ts:1750-1795`, the
  `hostIdx` call): for a `$Proxy` receiver, `__is_truthy` the result and throw
  TypeError on false; return the proxy otherwise. Same forward-arm fix as C2
  in `buildExt1Dispatch` (`:606`, `forwardArm` for `TRAP_PREVEXT`) — push the
  inner result for a `$Proxy` target.
- **C4** get/has arms (`:824`, `:942`): after `emitReflectArgumentLocals`, add
  the POSITIVE-primitive rejection the `apply` arm uses (`:1400-1415`:
  `ref.is_null` ∨ `__typeof_number/string/boolean/bigint` ∨
  `__extern_is_undefined`) → TypeError "Reflect.get called on non-object".
  `apply` arm (`:1447+`): IsCallable = `__typeof_function` ∨ boundary
  callable kind (copy `callableTest` from the construct dispatch,
  `object-runtime-proxy.ts:1263`); reject a target that is a positive
  `$Object`/primitive non-callable; `argumentsList`: missing/null/undefined/
  primitive → TypeError BEFORE any `length` read (§7.3.19 step 2). `this`
  threading (`call-target.js`): trace `__apply_closure` → `__call_fn_method_N`
  (`index.ts emitClosureMethodCallExportN`) with a 1-line probe
  (`function fn(){ return this } ; Reflect.apply(fn, o, [])`) — if the plain
  function-declaration closure has no receiver slot, this row stays open;
  say so in Results rather than forcing it.
- **C5** ToPropertyKey: call `__to_property_key` (`object-runtime.ts:1509`)
  on the key local in the get (`:824`), gopd (`:1057`), set-3-arg (`:920`,
  the non-receiver path only) and defineProperty (`:1109`) arms before the
  native call. defineProperty with 2 args: pad `descArg` with the undefined
  singleton so `emitDefinePropertyDescRuntime` runs and
  `__obj_define_from_desc` raises its ToPropertyDescriptor TypeError AFTER
  ToPropertyKey's abrupt (the row throws from `toString`).
- **C6** new native `__own_property_keys(obj) -> externref($ObjVec)` =
  `__getOwnPropertyNames` (already index-ascending then `seq`-ordered, with
  the #4434 array-index bound in `__obj_index_of_key`, `object-runtime.ts:5721`)
  followed by `__getOwnPropertySymbols` (`:3385`), in ONE vec. Register it in
  `object-runtime-descriptors.ts` beside `__getOwnPropertySymbols`, and route
  the `Reflect.ownKeys` arm (`:1022`) to it. **#5268 Step 2.5 asks for the
  same helper under the same description** — mint it under this exact name
  and guard with `if (ctx.funcMap.has("__own_property_keys")) return` so
  whichever PR lands second is a no-op. First reproduce p7's null-deref
  (`Reflect.ownKeys` on an object with both a symbol key and integer keys —
  suspect the `__getOwnPropertyNames` walk casting a `$Symbol` key to
  `$AnyString`, `:3262+`; the #2866 readers "add a `ref.cast $AnyString`
  (always succeeds)" note is exactly the assumption that breaks).
  `order-after-define-property.js` also needs `Object.defineProperty(obj, symA,
  {configurable:false})` to keep `seq` (it updates in place — verify).
- **C7** `Reflect.defineProperty` boolean: add a mutable i32 global
  `__define_reflect_mode` (default 0); the Reflect arm (`:1109`) sets it to 1
  around `emitDefinePropertyDescRuntime` and resets in every exit path; the
  four throw sites of the #2042 S4 preflight in `__defineProperty_value`
  (`object-runtime-descriptors.ts:371/387/419/440`) and the accessor twin
  (`:938/954/966/985/1004`) become `if global → return ref.null.extern (the
  #3177 rejection sentinel the dyn-view arms already use, :2380) else throw`.
  `__obj_define_from_desc` already propagates the null sentinel (`:2378`) and
  the arm already `__is_truthy`s the result (`:1178`). Also flip the frozen
  `Object.freeze` write refusal the same way (p12's message comes from the
  `OBJ_FLAG_FROZEN` gate, `:3433/3535`).
- **C8** (0) `__getPrototypeOf` (`object-runtime-prototype.ts:376`): an ordinary
  `$Object` whose `$proto` is null and whose flags lack `OBJ_FLAG_NULL_PROTO`
  answers the `%Object.prototype%` value (the object the #4160 companion
  machinery already holds — `proto-index-store.ts`; if that value is a
  `$NativeProto` it is still a valid externref RETURN even though it cannot be
  STORED in `$Object.proto`) — `desc-realm.js`; verify the existing
  `Object/getPrototypeOf` controls first, the static ES5 path must stay
  byte-identical. (a) `Reflect.hasOwnProperty(name)` and any non-method member on the
  `Reflect` namespace: lower to `__hasOwnProperty(<Reflect carrier>, name)`
  (the carrier from `emitBuiltinNamespaceObject`) instead of the Phase-C
  refusal — `Reflect/enumerate/undefined.js` only checks `false`. (b)
  `Object.getPrototypeOf(Reflect)`: after `__new_plain_object` in
  `emitBuiltinNamespaceObject` (`builtin-static-globals.ts:505`), set
  `$Object.proto` to the `%Object.prototype%` value the ES5 path answers
  (`emitEs5IntrinsicPrototype(ctx, fctx, expr, "Object")`,
  `object-get-prototype-of.ts`) — only if that value is an `$Object`; for
  `Proxy` the answer is `%Function.prototype%`
  (`emitFunctionPrototypeObjectSingleton`, `call-builtin-static.ts:2172`).
  If either intrinsic is a `$NativeProto` (not storable in `$Object.proto`),
  leave the row and say so. (c) `Reflect.getPrototypeOf(x)`: after the
  non-object guard, call `tryCompileEs5GetPrototypeOfValue(ctx, fctx, expr)`
  (it inspects `expr.arguments[0]` only) before the raw `__getPrototypeOf`
  path so `Reflect.getPrototypeOf({})` answers what `Object.getPrototypeOf({})`
  answers.

Expected: +24 to +28 (C1 2, C2 5, C3 3, C4 4–5, C5 4, C6 3, C7 1, C8 2–5).

#### Step 3 — trap-read fidelity + define/gOPD routing (E, 4 rows) — `proxy-cl-E.txt`

- **E-1 runtime `$Proxy` guards on the descriptor fast paths.** In
  `ensureProxyRuntime`, prepend to `__defineProperty_value`
  (`object-runtime-descriptors.ts:716`, `(obj, key, value, f64 flags)`; flag
  word: bits 0/1/2 = w/e/c, 3/4/5 = "specified", 7 = has value —
  `object-ops.ts:777`) and `__defineProperty_accessor` (`:1187`) a
  `ref.test $Proxy` arm that REBUILDS the descriptor object from the flag
  word with only the SPECIFIED fields (`__new_plain_object` + `__extern_set`
  per present field — `call-parameters.js` counts exactly the stated keys)
  and tail-calls `__proxy_define_dispatch(p, key, desc)`. This makes the
  syntactic gate at `object-ops.ts:979` redundant (leave it; byte-identical
  for non-proxies). Fixes `null-handler` (revoked → TypeError) and
  `call-parameters`.
- **E-2 1-arg gOPD.** `call-builtin-static.ts:2696`: accept
  `arguments.length >= 1`, pad the key with the undefined singleton
  (`undefinedExternInstrs`, `any-helpers.ts:138`); the native's key coercion
  makes it `"undefined"`, and the revoked front-guard throws first.
- **E-3 lazy GetMethod (1 row, lowest priority in this step).** Replace the
  eager `readTrap(...)` block of `__proxy_create` (`:1500-1530`) by
  per-operation reads: each dispatch builder's "trap = p.ptraps.<field>"
  read becomes `__extern_get(p.phandler, "<name>")` + `__nullish_to_null`
  (the same two calls `readTrapRaw` makes), with `ptraps` kept only as the
  revoked sentinel (null after `__proxy_revoke`). `__proxy_get_target_if_absent`
  (`object-runtime-prototype.ts:210`) reads `ptraps.get` — switch it to the
  same handler read. This is a wide but mechanical change (13 read sites);
  do it LAST, verify with the full `proxy-cl-*.txt` set + controls, and
  keep the eager path if any control regresses (then leave the row open).

Expected: +3 to +4.

#### Step 4 — proxy as `[[Prototype]]` + receiver threading (B, 12 rows) — `proxy-cl-B.txt`

**4-a representation — proxy LINK objects.** `$Object.proto` stays
`ref null $Object` (widening it or subtyping `$Proxy` under `$Object` is the
#2009 canonicalization hazard, `object-runtime.ts:1129`). A proxy in
prototype position is stored as a fresh `$Object` "link": flag bit
`OBJ_FLAG_PROXY_LINK` (pick the next free bit in the `OBJ_FLAG_*` block
`object-runtime.ts:294-300`; 0x08/0x10/0x20 are taken by #3176/#4120 — read
the block, do not assume), zero own properties, and the `$Proxy` held in a
NEW mutable `anyref` field appended to `$Object` (`objectFields`, `:1118` —
append-only, so every `struct.new $Object` site pushes one more
`ref.null any`; grep `struct.new", typeIdx: objectTypeIdx` — there are few:
`__new_plain_object`, `__object_create`, `__objvec`-free literal sites) — OR,
if appending a field is judged too wide, store the proxy in the link's
`$PropMap` under the reserved internal key `"[[ProxyLink]]"` (precedent:
`[[PrimitiveValue]]`, hidden from `__getOwnPropertyNames` at `:3270`). Prefer
the field. Producers: `__object_create` (`object-runtime-prototype.ts:431`),
`__object_setPrototypeOf` (`:591`, step 5 write) and its `_status` twin,
`canonicalizeProtoArg` (`:265` — replace the `__proxy_get_target_if_absent`
unwrap with "wrap in a link" whenever the arg is a `$Proxy`, trap or no
trap; the unwrap stays only for the `#4721` `[[Get]]`-forwarding fast path if
a control needs it). Consumer: `__getPrototypeOf` (`:376`) returns the
wrapped proxy (`extern.convert_any` of the field) when the flag is set —
`p4`'s `getPrototypeOf(heir) === proxy`.

**4-b per-hop arms in the walkers** (new module
`src/codegen/object-runtime-proxy-chain.ts`, one `fill*` per walker following
`fillObjectAssignProxySourceArm`'s `definedFuncAt` + `body` splice idiom,
`object-runtime-enumeration.ts:1590`; called from the finalize site that
calls `fillProxyDispatch`): at the top of each loop iteration in
`__extern_get` (`object-runtime.ts` proto loop ~`:2500-2600`, the
`struct.get objectTypeIdx fieldIdx 0` hop), `__extern_has` (`:4820-4850`),
`__extern_set`'s chain consult (`__extern_set_decide`, the #4504 descriptor
walk — `inherited-set-gate.ts` header explains it is active only when
`inheritedSetAnyDirty(ctx)`; a module that stores a proxy as a prototype must
set `ctx.inheritedSetDescriptorDirty = true` from the `Object.create(<proxy>)`
/ `setPrototypeOf` compile sites, otherwise the runtime walk is not even
emitted), `__isPrototypeOf` (after #5268 2.7), `__object_setPrototypeOf`'s
cycle loop (`:560-575`; #5268 Step 1.3(b) stops the walk at a proxy —
consistent), the for-in enumerator (`object-runtime-enumeration.ts:395`):
`if (cur.flags & PROXY_LINK) { return <proxy op>(cur.proxy, key, RECEIVER) }`
where the receiver is the ORIGINAL receiver local (param 0 of the walker);
`get` → `__proxy_get_dispatch(proxy, key, receiver)` (already has a receiver
param), `has` → `__proxy_has_dispatch`, `set` → the new
`__proxy_set_dispatch_recv` (4-c), `for-in` → `__proxy_ownkeys_names_dispatch`
+ per-key gopd enumerability (the #5268 2.4 filter).

**4-c receiver-threaded `[[Set]]`.** Register
`__proxy_set_dispatch_recv(proxy, key, value, receiver) -> externref` with
`buildDispatch(TRAP_SET, …)` generalized to take the receiver from param 3
(trap arm: push param 3 instead of param 0); make the existing 3-param
`__proxy_set_dispatch` a thin wrapper that passes `receiver = proxy` (keeps
`__extern_set`'s guard and `noSetTrap()` at `:1760-1840` byte-identical).
Trap-absent arm when `receiver != proxy` OR the proxy has a
`getOwnPropertyDescriptor`/`defineProperty` trap: call
`__ordinary_set_receiver(target, key, value, receiver) -> i32` (new module
`src/codegen/object-runtime-ordinary-set.ts`, §10.1.9.2
OrdinarySetWithOwnDescriptor): `ownDesc = __getOwnPropertyDescriptor(target,
key)` (front-guarded → recurses into a proxy target's gopd trap); undefined →
`parent = __getPrototypeOf(target)`; non-null → `return parent.[[Set]]`
(`__proxy_set_dispatch_recv` if `$Proxy`, else recurse); else ownDesc =
`{undefined, w:true, e:true, c:true}`; data: `!writable` → 0; receiver not an
Object → 0; `existing = __getOwnPropertyDescriptor(receiver, key)` (this is
the receiver-side `[[GetOwnProperty]]` — for a proxy receiver it fires the
gopd trap, `trap-is-missing-receiver-multiple-calls`); existing accessor →
0; existing `!writable` → 0; existing defined → `__obj_define_from_desc(receiver,
key, {value})` (fires the defineProperty trap on a proxy receiver); else
CreateDataProperty → `__obj_define_from_desc(receiver, key, {value, w, e, c})`;
accessor: `setter = ownDesc.set`; undefined → 0; `__apply_closure(setter,
receiver, [value])` (`trap-is-null-receiver`'s `context === pParent`); return
1. Return `__box_boolean` of that from the dispatch. The plain
`receiver == proxy && no gopd/define traps` case keeps today's
`__extern_set(target, …)` forward untouched.

**Coordination with #2046 (X2):** `Reflect.set(target, key, V, receiver)` is
exactly `__ordinary_set_receiver` for an ordinary target and
`__proxy_set_dispatch_recv` for a proxy target. Do NOT edit the #2046 arm
here; append a pointer to `plan/issues/2046-standalone-reflect-spec-gaps.md`
("the receiver primitive landed in #5196 Step 4 — consume, don't twin"), and
run `npm run -s check:dead-exports` (the new module's exports must be
consumed by the proxy runtime, not left for #2046).

Edge cases: `Object.create(proxy)` heir → `heir.z = 1` where the proxy has
NO set trap: forward with receiver = heir must create `z` on the HEIR (not
the target) — that is the receiver-side CreateDataProperty above;
`Object.getPrototypeOf(heir)` must return the proxy, `Object.setPrototypeOf(heir,
x)` must replace the link; a revoked proxy in a chain throws on the hop
(dispatch does it); `__object_setPrototypeOf`'s cycle check must look
THROUGH links (compare the link's proxy identity, not the link object).
Verify `p4` first, then the list.

Expected: +9 to +12 (the 3 `*-target-is-proxy` rows in B also need F for
their later assertions).

#### Step 5 — first-class revoker (D, 4 rows) — `proxy-cl-D.txt`

Give `__proxy_revoker` (`:1636`) function metadata without changing its
carrier: (a) `__getOwnPropertyDescriptor` (`object-runtime-descriptors.ts:2909`):
a `ref.test __proxy_revoker` arm before the `$Object` cast answering
`"length"` → `{value: 0, writable: false, enumerable: false, configurable: true}`
(via `__create_descriptor(box 0, FLAG_CONFIGURABLE)`, `:2998`) and `"name"` →
`{value: "", …}` (the spec name of the revoker is the empty string —
`revocation-function-name.js` checks `""`), anything else → undefined; (b)
`__getOwnPropertyNames` (`:3262`): revoker → `["length", "name"]` in that
order (`property-order.js`); (c) `__hasOwnProperty`
(`object-runtime.ts:4565 emitHasOwn`): revoker → `length`/`name` only
(`"prototype"` → false); (d) `ensureReflectIsConstructor` /
`fillReflectIsConstructor` (`reflect-construct-native.ts:195/212`): revoker
→ 0 (`isConstructor` harness = `Reflect.construct(function(){}, [], f)` →
"newTarget is not a constructor" TypeError, already emitted at
`call-namespace-static.ts:1588`); (e) `new revoke()` → the dynamic-new path
must throw TypeError for a non-constructor carrier — check what `new f()`
on an `externref` callee does today (`native-construct.ts`) and add the
revoker to its "not a constructor" arm if it reaches `__proxy_apply_dispatch`
or `__apply_closure` instead. `__typeof_function` already answers 1 (p5).

Expected: +4.

#### Step 6 — exotic targets under the trap-absent forward (F, 18 rows) — `proxy-cl-F.txt`

Measure-first: after Steps 1–5 re-run `proxy-cl-F.txt` and bucket the
residue by carrier from the first failing assertion:

- **array** (`set/trap-is-null-target-is-proxy` `length = 0`,
  `defineProperty/trap-is-undefined-target-is-proxy` index define,
  `gopd/trap-is-{missing,undefined}-target-is-proxy` `"0"` own,
  `get/trap-is-undefined-target-is-proxy` `compareArray(arrayProxy, array)`,
  `setPrototypeOf/trap-is-undefined-target-is-proxy`) — the proxy layer's
  job is only that `__extern_set`/`__obj_define_from_desc`/`__getOwnPropertyDescriptor`/
  `__object_setPrototypeOf` receive the ARRAY carrier (they do, via
  `ptarget`); whether each native implements the array exotic `[[Set]]`/
  `[[DefineOwnProperty]]`/`[[GetOwnProperty]]` on a `$Vec` is the array
  lane's (#5268 N `array-set-length`, `vec-index-domain.ts`) — do not build
  a second array MOP inside the proxy runtime. Fix here only a proxy-layer
  defect (a `ref.cast $Object` on the target, a dropped result).
- **String wrapper** (`get/trap-is-null-target-is-proxy` `.length`/`[0]`
  deref, `deleteProperty/trap-is-null-target-is-proxy` `delete
  stringProxy[0]` strict TypeError, `defineProperty/trap-is-missing-target-is-proxy`
  `"4"` define + `"0"` redefine TypeError, `ownKeys/trap-is-missing-target-is-proxy`
  index keys + `length` + symbol) — #4491 wired gOPD/names; `__extern_get`'s
  String-exotic arm is what derefs (`get/trap-is-null-target-is-proxy`'s
  `RuntimeError` at `__module_init`): find the null `ref.as_non_null` with
  the probe `new Proxy(new Proxy(new String("str"), {}), {}).length`.
- **RegExp** (`set/trap-is-missing-target-is-proxy` `lastIndex` brand check,
  `get/trap-is-missing-target-is-proxy`, `has/trap-is-missing-target-is-proxy`
  `ignoreCase`/`Symbol.replace`, `deleteProperty/… lastIndex`): the natives
  reach the RegExp instance-method dispatch with the PROXY as `this`
  ("Method called on incompatible receiver") — the forward must pass
  `ptarget`, not the proxy, as the receiver of a carrier-branded read; audit
  the `$Proxy` guards' receiver argument (`local.get 0` in `getBody`/`hasBody`
  guards at `:1715/:1845` is the proxy — correct for the TRAP arm, but the
  trap-ABSENT arm inside `buildDispatch` forwards `__extern_get(target, key,
  receiver=proxy)`; a brand-checked builtin accessor must then be invoked
  with `this = target` per §10.5.8 step 7 only when receiver is the proxy —
  spec says receiver stays the proxy, so the RegExp accessor itself must
  unwrap... this is the RegExp lane's `lastIndex` data-property model
  (#5198), not the proxy's; leave with a note).
- **function / bound function** (`get/trap-is-missing-target-is-proxy`
  `Object.create(functionProxy).length`, `has/… "name"`, `defineProperty/…
  func.name = "foo"` + `prototype` accessor TypeError,
  `apply/trap-is-null-target-is-proxy` bound target deref): closure-carrier
  own props live in `closure-props.ts` (#3468) side tables; the bound
  function carrier (`construct-bound.ts`) must be admitted by
  `__apply_closure` — the deref says it is not when reached THROUGH
  `__proxy_apply_dispatch`'s forward (`:1230`): probe `new Proxy(f.bind(o),
  {})(1)`.
- **`Object.create(Array.prototype)` target** (`has/trap-is-undefined`,
  `has/trap-is-undefined-using-with`): `__extern_has`'s absent-tail consults
  the #4160 companions only for a real `$Object` root
  (`objectTerminalAllowsImplicitProtoIdx`, `object-runtime.ts:4830`); a proxy
  forward passes the target `$Object` whose root terminal is the Array
  proto-view — verify the terminal classifier admits it.

Expected from proxy-layer fixes alone: +3 to +6; the rest are carrier-lane
rows — record them in Results with the carrier owner, do not chase.

#### Step 7 — closed-struct targets (G, 5 rows) — `proxy-cl-G.txt`

The clean fix is representational: when a variable's initializer is an object
literal AND the variable is later passed as the TARGET of `new Proxy(<id>, …)`
/ `Proxy.revocable(<id>, …)` (extend `proxyBindingIsTarget`'s index,
`analysis/proxy-binding-escape.ts:284`, to record the TARGET identifier too),
compile the literal through the open-object path
(`compileObjectLiteralAsExternref`, the way the HANDLER already is per the
`__proxy_create` contract note at `:1425`) so the target is a real `$Object`
for `delete`/`defineProperty`/`getOwnPropertyDescriptor` forwards, and make
the `in` fold (`binary-ops-in.ts` ~`:208-260`) decline when the receiver
binding `proxyBindingNeedsExternref` (`:290`). Verify with
`deleteProperty/trap-is-undefined-strict.js` first (the smallest row), then
`setPrototypeOf/not-extensible-target-same-target-prototype.js` (its second
half is `Object.setPrototypeOf(outro, p)` on a `{}` literal bound to `outro`).
If the open-object demotion is judged too wide (it changes the target's
representation for every later static read), leave G and say so — 5 rows.

Expected: +3 to +5.

#### What NOT to do

- No new host imports; every new native has a standalone body (the runner
  fails a standalone row whose module imports `env::*`; the caller of
  `compile(src, { target: "standalone" })` in `.tmp/es2015/probes5267/imports-of.mts`
  prints the real import list — use it on one row per step).
- Never edit `tests/test262-runner.ts`, skip lists, `scripts/*-baseline.json`,
  or the `$262.createRealm` stub (X3 is a harness decision, not this issue).
- Do not touch the #3371 `construct` arm or the #2046 receiver refusal; do not
  write a second `__getOwnPropertySymbols` proxy arm / `__isPrototypeOf` hop
  rewrite / `Object.keys` enumerability filter (#5268 Step 2) or a second
  `__own_property_keys` — mint under the shared name with a `funcMap.has`
  guard.
- No `--no-verify`; never pipe a gate whose status you need.
- Do not validate trap callability or invariants in `__proxy_create` — every
  check is per operation (§7.3.9 GetMethod / §10.5.x run at call time; the
  tests construct successfully and expect the OPERATION to throw).
- `$ProxyTraps` field order is append-only (13 fields; never renumber).

### Acceptance criteria (r2)

- Expected flips (sub-list → `pass`, measured with `run-test262-paths.mts`
  per step, before/after in the Results section): Step 0 +21 (R) +6 with
  Step 1, Step 1 +29 (A1–A8), Step 2 +24…28 (C1–C8), Step 3 +3…4 (E), Step 4
  +9…12 (B), Step 5 +4 (D), Step 6 +3…6 (F), Step 7 +3…5 (G) — **floor +99,
  ceiling +115 of the 127 in-scope rows**; every row NOT flipped is named in Results with its first failing
  assertion and owner.
- Every row of `proxy-head.txt` is accounted for: in a `proxy-cl-*.txt`
  sub-list that was re-run, or in `proxy-cl-X*.txt` with its owner (X1/X2/X3/X4
  are not re-run here).
- Controls: all 18 rows of `.tmp/es2015/proxy-controls.txt` still pass
  after every step (HEAD: 18/18).
- Standalone modules stay host-import-free (`imports-of.mts` on
  `defineProperty/targetdesc-not-compatible-descriptor.js`,
  `has/call-in-prototype.js`, `revocable/revocation-function-length.js` → `[]`).
- Gates, chained before every commit:
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`,
  plus `pnpm run test:equivalence:gate`; also
  `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs`
  (CI diffs the merge preview). Growth outside the files/functions granted in
  this issue's frontmatter gets its own dated line here, never a baseline
  edit.
- Issue hygiene: `node scripts/update-issues.mjs --check`,
  `node scripts/check-issue-ids.mjs`, `node scripts/check-issue-spec-coverage.mjs`
  green; a focused vitest file `tests/issue-5196-es2015-proxy-r2.test.ts`
  (already exists from #5389 — extend it) with one host+standalone control
  per step (p1, p4, p5, p6, p11, p12 shapes) and the exact test262 rows via
  `runTest262File`.
