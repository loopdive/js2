---
id: 5196
title: "ES2015 standalone proxy — r2 residual pass"
status: done
completed: 2026-09-04
sprint: current
created: 2026-08-29
updated: 2026-09-04
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
  # 2026-09-03 r3 plan (see "## Implementation Plan — r3 (2026-09-03)"):
  # R3-5 opens the representation of a proxy-TARGET object literal at the
  # variable-declaration compile sites (statements.ts / object-ops.ts, +~20
  # each); R3-3's E-1 rebuilds a descriptor object inside the new
  # `__defineProperty_value`/`_accessor` `$Proxy` front-guards; R3-2's C6 mints
  # `__own_property_keys` beside `__getOwnPropertySymbols`. All growth, no
  # refactor — every step adds an arm gated on the proxy runtime being present.
  - src/codegen/statements.ts
  - src/codegen/object-ops.ts
  # 2026-09-03 R3-0 implementation (measured, not predicted): the `Proxy`-as-a-
  # VALUE construct path needs (a) `new-super.ts` +21 for the
  # `tracesToProxyConstructorValue` gate, the open-`$Object` lowering of an
  # object-literal target/handler at a `new <Proxy ctor value>(…)` site, and the
  # module flag that arms the driver; (b) `builtin-value-read.ts` +21 for the
  # `Proxy.revocable` value-closure arm that replaces the "not yet implemented"
  # thrower; (c) `context/types.ts` +10 for the `proxyConstructorValueNewSite`
  # flag — the gate the plan proposed (proxy runtime / carrier global present)
  # was measured to be true in EVERY standalone module, so a module-scoped flag
  # is the only byte-inert gate available.
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/context/types.ts
  # 2026-09-04 R3-4 implementation (measured): the revocation function's own
  # `length`/`name` metadata lives in the NEW module
  # `src/codegen/proxy-revoker-meta.ts` (one `__builtinfn_get_meta` arm plus the
  # matching `__builtinfn_delete` / `__builtinfn_push_ownnames` arms), wired by
  # `index.ts`; `object-runtime-proxy.ts` gains the per-instance deleted-bits
  # field on `__proxy_revoker`; `typeof-natives-finalize.ts` gains the carrier's
  # typeof arm; `context/types.ts` gains the `proxyRevocableSite` flag; and
  # `expressions/non-constructable.ts` gains the `Proxy.revocable(…).revoke`
  # initializer shape so `new revoke()` throws the §13.3.5.1 TypeError instead
  # of evaluating to null.
  - src/codegen/proxy-revoker-meta.ts
  - src/codegen/expressions/non-constructable.ts
  # 2026-09-04 round-3 review fixes (see "## Round-3 review fixes"): F4's
  # inline-object-literal argument arm for a statically-known builtin-value
  # closure lands in `call-identifier.ts` (+27, mostly the measured rationale).
  # It has to live at the call site because that is where the argument is
  # compiled — the value closure only ever sees the finished `externref`.
  - src/codegen/expressions/call-identifier.ts
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
  # 2026-09-03 r3 plan: R3-4(c) adds a `ref.test __proxy_revoker` arm to
  # `emitHasOwn` (a nested helper of ensureObjectRuntime, already >300 LOC);
  # R3-5 may add an externref-slot decline to the `in` fold; R3-3 E-1 leaves
  # the syntactic gate in compileObjectDefineProperty in place but the grant is
  # here in case the implementer widens it via `tracesToProxyValue` (oracle).
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  # 2026-09-04 R3-4: `classifyNonConstructableValue`'s nested `classifyInit`
  # gains the `Proxy.revocable(…).revoke` shape (one more initializer arm in
  # the shape its existing arms already have).
  - src/codegen/expressions/non-constructable.ts::classifyNonConstructableValue
  # 2026-09-04 R3-4: `generateMultiModule` gains the one `fillProxyRevokerFnMeta`
  # phase line that `generateModule` already got (multi-source parity).
  - src/codegen/index.ts::generateMultiModule
  # 2026-09-04 round-3 review fixes: same F4 arm, same reason — one more
  # argument-shape branch inside the existing per-argument loop.
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
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

## Implementation Plan — r3 (2026-09-03)

Written by the Fable planning lane for an Opus implementer. The r2 residual
plan above (2026-09-01) was **never dispatched**; this section re-verifies it
against `origin/main` `bee5ddd535` (2026-09-03) and re-cuts it into steps that
each carry a regression check on PASSING behaviour, per the six-wave lesson
(five of six waves shipped regressions that a failing-row list cannot see).
Where an r2 step is restated it is by reference — do not re-read r2 for the
mechanics unless this section points there.

### Census and re-verification (2026-09-03)

- Input: `.tmp/census0903/proxy+reflect.tsv` — 157 non-pass rows
  (`built-ins/Proxy/**` 125 + `built-ins/Reflect/**` 32; 141 `fail`, 16
  `compile_error`), baseline stamped 2026-09-03 09:07 UTC, `oracle_lane:
  honest`. The set is r2's 157 with one swap: `Reflect/apply/call-target.js`
  now PASSES (dropped — the C4 `this`-threading question is closed) and
  `Proxy/apply/trap-is-undefined-target-is-proxy.js` (generator host-import
  compile error, #680/#2961) entered. Every other r2 cluster is unchanged.
- Root-cause groups (from the error column crossed with the r2 probes; sizes
  are exact, lists under `.tmp/census0903/probe5196/r3-*.txt`, partition
  verified 157/157 against the TSV):

  | group | rows | root cause (one line) |
  |---|---:|---|
  | R — `Proxy` read as a VALUE resolves to the namespace carrier, not a constructor | 27 | every `*-realm*` row does `new OProxy(t,h)` / `OProxy.revocable(t,h)` where `OProxy = $262.createRealm().global.Proxy` |
  | A — §10.5 post-trap invariants not enforced (A1–A8) | 29 | dispatch builders return the trap result as-is ("Phase-F scope: NO result-invariants") |
  | C — Reflect arm defects (C1–C6, C8a) | 22 | dropped booleans, missing non-object guards, string-only ownKeys, eager `#1472 Phase C` refusal |
  | E — define/gOPD routing bypasses the proxy | 3 | syntactic `new Proxy` gate at `object-ops.ts:1000`; 1-arg gOPD compile error |
  | D — revoker has no function metadata | 4 | `__proxy_revoker` is a 1-field struct known only to `fillApplyClosure` / `__typeof_function` |
  | G — proxy TARGET literal keeps a closed representation | 5 | `delete p.attr` forwards onto a non-`$Object`, silently no-op |
  | B — proxy as `[[Prototype]]` + receiver threading | 12 | DEFERRED (see below) |
  | F — exotic targets under the trap-absent forward | 18 | DEFERRED — carrier-lane MOPs |
  | C7 / C8b-d / E-3 | 5 | DEFERRED — wide blast radius for 1–2 rows each |
  | X — owned elsewhere (#3371 14, #2046 7, realm harness 3, misc 7) | 31 | not this issue |

- **Probe on `bee5ddd535`** (15 rows across R, A1, A2, A3, A7, B, C2, C4, C6,
  D, E, G — `.tmp/census0903/probe5196/sample.txt`):

  ```
  npx tsx scripts/run-test262-paths.mts .tmp/census0903/probe5196/sample.txt --standalone
  === counts ===
  { fail: 15 }
  ```

  All 15 fail with the baseline's signature (`sample-run1.txt`), e.g.
  `apply/null-handler-realm.js → TypeError: Proxy.revocable is not yet
  implemented in --target standalone` (proves R's premise: the `OProxy` read is
  the seeded namespace carrier whose `revocable` member is the
  `builtin-value-read.ts:1717` refusal closure), `has/call-in-prototype.js →
  handler is context Expected SameValue(«undefined», …)` (B: no trap fires
  through `Object.create(proxy)`), `Reflect/ownKeys/return-on-corresponding-order.js
  → Expected SameValue(«5», «7»)` (C6: symbols dropped). Nothing in the sample
  has been fixed by the 09-01…09-03 merges (#5268 Steps 1/2-partial/3/6 landed
  `object-integrity-proxy.ts`, `proxy-value-provenance.ts`,
  `object-proto-proto-accessor.ts`; **#5268 Step 2.5 (gOPS proxy arm) and
  2.7 (`__isPrototypeOf` hop) did NOT land** — `git show d21a768efa` touches
  neither, and `object-runtime-prototype.ts:760-770` still seeds
  `cur = candidate is $Object ? cast : null`).
- Three micro-probes (`.tmp/census0903/probe5196/p{A,C,D}-*.js`, run one at a
  time through `.tmp/probe-one.mts`, all `STATUS fail`):
  - `pA` — `delete p.attr` on `new Proxy({attr:1}, {})` returns `true` but
    `gOPD(target,"attr")` still answers the descriptor → G confirmed (forward
    is a no-op on the target carrier).
  - `pC` — `new OProxy({}, {get(){throw}})` throws `Cannot access property on
    null or undefined at 321:11` from the `new` itself: the construct driver
    takes the ordinary `callee.prototype` tail on the namespace carrier, never
    `__proxy_create` → R confirmed.
  - `pD` — `Object.defineProperty(r.proxy, "x", {value:1})` never fires the
    `defineProperty` trap (`r = Proxy.revocable(…)`) → E confirmed; the
    #5268 `tracesToProxyValue` predicate exists but `compileObjectDefineProperty`
    does not use it.
- Controls: `.tmp/census0903/probe5196/r3-controls.txt` — 70 rows, every one
  `pass` in the 09-03 baseline (r2's 18 + 52 chosen from the directories each
  step touches: Proxy/{construct,get,set,has,defineProperty,gOPD,ownKeys,
  getPrototypeOf,setPrototypeOf,preventExtensions,apply,revocable},
  Object/{setPrototypeOf,preventExtensions,freeze/proxy-*,getOwnPropertyNames,
  prototype/__proto__,create}, Reflect/{set,setPrototypeOf,preventExtensions,
  get,has,gOPD,defineProperty,ownKeys,apply}, language/expressions/{instanceof,
  new,delete,in}, Function/prototype/bind). Baseline pass counts for the wider
  directories, for the "N rows must stay green" checks below: Proxy 184/311,
  Reflect/get 9/11, Reflect/has 9/10, Reflect/set 10/18, Reflect/setPrototypeOf
  10/14, Reflect/preventExtensions 9/10, Reflect/ownKeys 10/13, Reflect/apply 7/9,
  Reflect/defineProperty 10/12, Object/setPrototypeOf 11/12,
  Object/preventExtensions 39/40, Object/freeze 51/53, Object/getOwnPropertyNames
  42/45, Object/getOwnPropertyDescriptor 310/310, Object/defineProperty
  1128/1131, Object/prototype/__proto__ 8/15, instanceof 37/43, new 56/59,
  delete 62/69, in 28/36 (all editions; the standalone baseline).

### Measurement protocol (every step)

1. Before the first edit of a file: `git show HEAD:<path> > .tmp/base-<name>.ts`
   (file-copy A/B; `git stash` is forbidden here — other agents share the
   clone).
2. After the step: `npx tsx scripts/run-test262-paths.mts .tmp/census0903/probe5196/r3-<X>.txt --standalone`
   (claimed rows) AND `… r3-controls.txt --standalone` (must stay 70/70).
   Batches ≤ 40 paths, one compile process at a time, `--isolate` only if a
   row hangs; a compile timeout under load is an artifact — re-run alone.
3. Byte-identity where a step promises it: compile the named control program
   on base and branch with `compile(src, {target:"standalone"})` and compare
   `sha256` of the bytes (`.tmp/es2015/probes5267/imports-of.mts` shows the
   `compile` call; add a hash print). Where a step edits an emitted path for
   ALL receivers (no byte-identity possible) it names the behavioural control
   instead — run that control's rows on BOTH trees.
4. Host-import check: `imports-of.mts` on one claimed row per step → `[]`.
5. Gates, chained, before every commit (never piped):
   `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`,
   then `LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-loc-budget.mjs`.
   New type queries go through `ctx.oracle` (`variableInitializerOf`, the way
   `proxy-value-provenance.ts` does) — never `ctx.checker.*` (oracle-ratchet).
6. Every `Instr[]` template inside the proxy runtime is a FACTORY (fresh array
   per use — `object-runtime-proxy.ts:96-104`); anything filled at finalize is
   reserve-then-fill (`fillProxyDispatch`, `:2323`). Gate every new arm on the
   proxy runtime being present (`ctx.funcMap.has("__proxy_get_dispatch")`) so
   gc/host lanes and proxy-free standalone modules stay byte-identical.

### Step R3-0 — `Proxy` as a first-class constructor value (R, 27 rows) — `r3-R.txt`

**Root cause.** A bare `Proxy` identifier read materialises the namespace
carrier (`builtin-static-globals.ts:40 ["Proxy", []]` →
`emitBuiltinNamespaceObject` `:469`, a plain `$Object` whose `revocable`
member is the `genericThrowBody` closure minted at `builtin-value-read.ts:1717`).
`new <carrier>(t, h)` enters `fillNativeConstructDrivers`
(`native-construct.ts:248`) whose only special arm is `ref.test $Proxy` (`:299-307`);
a plain `$Object` callee falls to the ordinary tail.

**Edits (in order).**
1. `native-construct.ts` `fillNativeConstructDrivers`, inside the per-arity
   loop, BEFORE the `canProxyConstruct` arm (`:299`): when
   `ctx.builtinObjectGlobals.get("Proxy") !== undefined` AND
   `ctx.funcMap.has("__proxy_create")`, push an arm: `local.get 0` /
   `any.convert_extern`, `global.get <ProxyGlobal>` / `any.convert_extern`,
   `ref.eq` (the global may still be `ref.null.extern` if never read — `ref.eq`
   on null vs a non-null callee is simply 0, no extra guard needed) → `if`:
   push arg0 / arg1 (`local.get 2` / `local.get 3`; for `arity < 2` push
   `ref.null.extern` for the missing one — `__proxy_create`'s `requireObject`
   (`object-runtime-proxy.ts:1494-1495`) turns that into the §28.2.1.1
   TypeError), `call __proxy_create`, `return`. Arity > 2: extra args ignored.
2. `builtin-value-read.ts` `ensureStandaloneBuiltinStaticMethodClosure`
   (`:996`): add `case "Proxy.revocable"` beside `case "Reflect.get"` (`:1071`):
   `paramTypes = [externref, externref]`, `returnType = externref`; then find
   the body-emission block for the `Reflect.*` cases further down the same
   function and add the twin: `ensureNativeProxyRuntime(ctx)` FIRST (it
   registers natives — must precede any `closureFctx.body` push; the trailing
   `flushLateImportShifts(ctx, closureFctx)` at `:1725` repairs the rest),
   then `local.get 0`, `local.get 1`, `call __proxy_revocable`
   (`object-runtime-proxy.ts:1658`). The namespace seed then carries a working
   `revocable`; `r.revoke()` already routes through `fillApplyClosure`'s
   revoker arm (#5389).
3. Nothing else: `Proxy.length` / `Proxy.name` are not asserted by any R row.

**Growth grant.** `native-construct.ts` (+~40 LOC, `fillNativeConstructDrivers`
already in `func-budget-allow`), `builtin-value-read.ts` (+~25 LOC,
`ensureStandaloneBuiltinStaticMethodClosure` already granted).

**Order-preservation.** The new arm must sit BEFORE the `ref.test $Proxy` arm
and AFTER nothing (it is the first test); it must not reorder the existing
arms. The `Proxy` global is read, never written, here.

**Acceptance.**
- Claimed: +21 of `r3-R.txt` immediately (the rows whose non-realm twin passes
  today), the remaining 6 (`defineProperty/targetdesc-*-realm` ×5,
  `gopd/result-type-is-not-object-nor-undefined-realm`) after R3-1. Re-run the
  list after BOTH steps.
- Passing shapes at risk: every dynamic `new <externref callee>(…)` (class
  values in `any` slots, `new F()` with `F` a closure, `Reflect.construct`
  fallbacks) — the arm is gated on the `Proxy` carrier global existing, so a
  module that never reads `Proxy` as a value must compile **byte-identical**:
  hash-compare on base vs branch for (a) a class-in-`any` `new` program and
  (b) `new Proxy({}, {})` + `Proxy.revocable({}, {})` (direct forms, which do
  not materialise the carrier). Behavioural controls: `language/expressions/new/`
  (56 pass), `built-ins/Proxy/construct/` (11 pass), `revocable/` (13 pass) on
  both trees; `r3-controls.txt` 70/70.
- `imports-of.mts` on `get/trap-is-not-callable-realm.js` → `[]`.

### Step R3-1 — §10.5 descriptor-model invariants (A1–A8, 29 rows + 6 R twins) — `r3-A.txt`

**Root cause.** `buildDispatch` (`object-runtime-proxy.ts:264`) trap arm,
`buildDefineDispatch` (`:928`), `buildOwnKeysDispatch` (`:732`) and
`buildProtoDispatch` (`:444`) return the trap result unvalidated (only #5140's
target-independent checks exist, `:405-443` and `:463-530`).

**Edits.** Implement r2 **Step 1** verbatim (its 1-a primitive table and 1-b
per-operation table are still exact — the descriptor model, `$PropEntry.flags`
and `__getOwnPropertyDescriptor` (`object-runtime-descriptors.ts:2909`) are
unchanged), in the NEW module `src/codegen/object-runtime-proxy-invariants.ts`
(export `registerProxyInvariantHelpers(ctx, deps)` + one `Instr[]` factory per
operation, called from `ensureProxyRuntime` after `:83`), with these r3 deltas:

1. `dispatchLocals()` (`:1001`) already reserves `res` at index `2 + arity`;
   add `tdesc` (externref) and `ext` (i32) after it — FRESH array per use.
2. A7 (`buildOwnKeysDispatch`): compute the TARGET's key set with
   `__getOwnPropertyNames(target)` ++ `__getOwnPropertySymbols(target)`
   (`object-runtime-descriptors.ts:3262` / `:3385`) — NOT
   `__proxy_own_keys_all` (`object-integrity-proxy.ts:175`, which takes the
   PROXY and would re-run the trap). Copy its `appendAll` loop idiom.
3. A8b (`instanceof`): #5268 2.7 did not land, so this step owns the
   `__isPrototypeOf` seed (`object-runtime-prototype.ts:760-770`): a `$Proxy`
   candidate → `cur = __getPrototypeOf(candidate)` (front-guarded → gpo
   dispatch, throws the §10.5.1 TypeError for
   `instanceof-target-not-extensible-not-same-proto-throws`), cast when
   `$Object` else answer 0. Leave the per-hop `struct.get` loop untouched.
4. A8a: replace the `invStrictEqIdx` compare in the `!isSet` block
   (`:504-526`) by the canonical proto-view compare r2 describes
   (`__proxy_get_target_if_absent` → `__proto_from_function` on the trap
   result vs the target `$Object`'s raw field 0, `ref.eq`, null-safe; keep the
   SameValue fallback for non-`$Object` targets). Verify the `p10` probe flips.
5. **Regression guard that r2 lacked:** a trap result that is a non-null,
   non-primitive value the readers cannot decompose (a CLOSED literal struct
   returned from a trap closure, a closure carrier, a `$Vec`) must be treated
   as "an Object with no readable fields" — CompletePropertyDescriptor defaults
   — and NEVER throw from a validator. Only a positive primitive/undefined
   (`__typeof_number/string/boolean/bigint`, `__extern_is_undefined`,
   `ref.is_null`) triggers the "not an Object" TypeError in A2. Probe this with
   a trap `getOwnPropertyDescriptor(){ return {value:1, configurable:true,
   enumerable:true, writable:true} }` over a configurable target prop —
   must NOT throw before and after.

**Growth grant.** New file `object-runtime-proxy-invariants.ts` (~450 LOC,
already in `loc-budget-allow`), `object-runtime-proxy.ts` (+~120 wiring,
`ensureProxyRuntime` already granted), `object-runtime-prototype.ts` (+~30,
`buildObjectPrototypeHelpers` granted).

**Order-preservation.** Validators run AFTER the driver call and BEFORE the
result is pushed; the trap-ABSENT forward arms are not touched; a throwing
trap propagates before any validator; `ToBoolean` is `__is_truthy` never
`ref.is_null`; a revoked proxy still throws first. `__proxy_target_desc` must
call the front-guarded `__getOwnPropertyDescriptor` (a proxy-of-proxy target
recurses) — never read `ptarget`'s struct directly.

**Acceptance.**
- Claimed: `r3-A.txt` 29/29 (A1 6, A2 7, A3 4, A4 2, A5 2, A6 2, A7 3, A8 3)
  plus the 6 R twins (re-run `r3-R.txt`).
- Passing shapes at risk: EVERY trap that returns a VALID result now passes
  through a validator — `built-ins/Proxy/` currently 184 pass: run all 311
  rows (8 batches of ≤40) on the branch; **zero pass→non-pass**, listing any
  by name. `language/expressions/instanceof/` (37 pass) and
  `built-ins/Function/prototype/Symbol.hasInstance/` on both trees for the
  `__isPrototypeOf` seed. The A8a compare touches `Object.getPrototypeOf` only
  inside the proxy dispatch, but re-run `built-ins/Object/getPrototypeOf/` and
  `Object/create/` (320 pass) anyway — the proto-view helpers are shared.
- Byte-identity: a standalone program with no `Proxy` must hash-equal base
  (the module is registered from `ensureProxyRuntime` only).

### Step R3-2 — Reflect arms and call-site booleans (C1–C6, C8a; 22 rows) — `r3-C.txt`

All arms live in `compileNamespaceStaticCall`
(`src/codegen/expressions/call-namespace-static.ts`; line numbers below are
current). The #2046 receiver refusal (`:887-920`) and the #3371 `construct`
arms (`:1568-1740`) are NOT edited. Sub-steps ordered by rows/risk; each is
independently shippable.

- **C2 (5) — `setPrototypeOf` booleans.** (i) Reflect arm `:1221-1320`: after
  `local.tee spoProtoLocal`, call `__object_setPrototypeOf_status`
  (`object-runtime-prototype.ts:708`, `ensureLateImport` it BEFORE compiling
  the operands — the `Object.setPrototypeOf` site `call-builtin-static.ts:1949-1962`
  shows the reservation order) — status 0 → push `i32 0` without calling the
  writer; else call `__object_setPrototypeOf`, `local.tee res`; if the target
  is a `$Proxy` (`any.convert_extern` + `ref.test`) push `__is_truthy(res)`
  else `drop; i32 1`. Keep the #5268 `immutable` branch as is. (ii)
  `buildProtoDispatch` forward arm (`:534-544`): when `ptarget` is itself a
  `$Proxy`, push the inner `__object_setPrototypeOf` result instead of
  `drop; local.get 0` (the inner front-guard returns the inner dispatch's
  booleanish), keep the token for ordinary targets. (iii)
  `Object.setPrototypeOf` site `call-builtin-static.ts:2056-2058`: after
  `call resolvedSpoIdx`, for a `$Proxy` receiver `__is_truthy` the result and
  throw the existing `throwRefused` TypeError on 0, then push `objLocal` (the
  spec return is `O`); ordinary receivers keep the current result push.
  Rows: `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js`,
  `…-if-target-and-proto-are-the-same.js`, `…-if-target-is-prototype-of-proto.js`,
  `Proxy/setPrototypeOf/toboolean-trap-result-false.js`,
  `…/trap-is-missing-target-is-proxy.js`.
- **C3 (3) — `preventExtensions` booleans.** Reflect arm `:1362-1414`: replace
  `drop; i32.const 1` after `call nativeIdx` by `call __is_truthy` (an ordinary
  `$Object` result is the object itself → truthy → 1, so the ordinary answer is
  unchanged; a proxy answers the trap's booleanish). `buildExt1Dispatch`
  forward arm for `TRAP_PREVEXT` (`:606+`): same "push inner result when the
  target is a `$Proxy`" change as C2(ii). `Object.preventExtensions` site
  (`call-builtin-static.ts:1786-1830`, `method === "preventExtensions"` ONLY —
  the branch is shared with freeze/seal): for a `$Proxy` receiver
  `__is_truthy` the `hostIdx` result, TypeError on 0 (§20.1.2.19 2.b), push
  `objLocal`. Rows: `Reflect/preventExtensions/return-boolean-from-proxy-object.js`,
  `Proxy/preventExtensions/return-false.js`, `…/trap-is-missing-target-is-proxy.js`.
- **C1 (2) — `Reflect.set` bypasses the proxy.** In `ensureProxyRuntime`,
  after the `setBody` patch (`:1760-1840`), `findBody("__reflect_set")`
  (`object-runtime.ts:4226`) and `unshift` the same `ref.test $Proxy` guard
  shape as `hasBody` (`:1845-1865`): `call __proxy_set_dispatch(p, key, value)`
  → `__is_truthy` → `return`. Rows: `set/return-true-target-property-is-not-configurable.js`,
  `set/trap-is-undefined-target-is-proxy.js` (the latter also needs its later
  array assertions — F; count it only if it flips).
- **C4 (4) — non-object / non-callable guards.** `get` (`:818`) and `has`
  (`:934`) arms: after `emitReflectArgumentLocals()` call the existing local
  `guardNativeReflectTarget(targetLocal, "Reflect.get called on non-object")`
  (`:777`, the helper the ownKeys/isExtensible arms already use — it admits
  closure carriers positively). `apply` arm (`:1416-1452`): (a) add to the
  brand ladder a positive-`$Object`-non-callable rejection
  (`__typeof_object(t) && !__typeof_function(t)`); (b) before `call applyIdx`,
  reject an `argumentsList` that is missing (`argLocals[2] === undefined`) or
  runtime null/undefined/primitive with the §7.3.19 TypeError. Rows:
  `Reflect/get/target-is-not-object-throws.js`, `Reflect/has/target-is-not-object-throws.js`,
  `Reflect/apply/target-is-not-callable-throws.js` (only the `{}` case fails
  today), `Reflect/apply/arguments-list-is-not-array-like.js` — its FIRST
  assertion needs `__extern_length` to invoke a `length` getter; probe
  `Reflect.apply(fn, null, {get length(){throw new Test262Error()}})` first;
  if it does not throw, leave the row open and say so in Results.
- **C5 (4) — ToPropertyKey abrupt.** Insert `call __to_property_key`
  (`object-runtime.ts:1533`) on the key local AFTER the target guard and
  BEFORE the native call in the `get` (`:818`), `set` 3-arg non-receiver path
  (`:887`), `getOwnPropertyDescriptor` (`:1049`) arms; `defineProperty`
  (`:1101`): accept `arguments.length >= 2`, pad the missing descriptor with
  the undefined singleton (`undefinedExternInstrs`, `any-helpers.ts:138`) so
  the key coercion throws first and `__obj_define_from_desc` raises the
  ToPropertyDescriptor TypeError otherwise. Rows: the four
  `Reflect/*/return-abrupt-from-property-key.js`.
- **C6 (3) — `Reflect.ownKeys` symbols + order.** Mint
  `__own_property_keys(obj) -> externref($ObjVec)` in
  `buildObjectDescriptorHelpers` right after `__getOwnPropertySymbols`
  (`object-runtime-descriptors.ts:3385`), guarded by
  `if (ctx.funcMap.has("__own_property_keys")) return` (the #5268 Step 2.5
  twin name), = names ++ symbols in ONE vec (copy `appendAll` from
  `object-integrity-proxy.ts:187`); route the arm (`:1008`) to it. FIRST
  reproduce r2's p7 null-deref (`Reflect.ownKeys({p1:1, [Symbol()]:1, 2:1,
  0:1})` in `__module_init`) — the suspect is the `__getOwnPropertyNames` walk
  casting a `$Symbol` key to `$AnyString` (`:3262+`); the fix there is a
  `ref.test` skip. Rows: `Reflect/ownKeys/return-on-corresponding-order.js`,
  `…-large-index.js`, `order-after-define-property.js`.
- **C8a (1) — `Reflect.hasOwnProperty("enumerate")`.** In the Phase-C refusal
  branch (`:1738`), when `reflectMethod === "hasOwnProperty"` and
  `expr.arguments.length === 1`: `emitBuiltinNamespaceObject(ctx, fctx, "Reflect")`,
  compile the key, `call __hasOwnProperty`, return i32. Row:
  `Reflect/enumerate/undefined.js` (its second assertion `Reflect.enumerate ===
  undefined` is a member read of the carrier — verify it already answers
  undefined; if it throws, the row stays open).

**Growth grant.** `call-namespace-static.ts` (+~150, `compileNamespaceStaticCall`
granted), `call-builtin-static.ts` (+~40, `compileBuiltinStaticCall` granted),
`object-runtime-proxy.ts` (+~40), `object-runtime-descriptors.ts` (+~60,
`buildObjectDescriptorHelpers` granted).

**Order-preservation.** Spec order inside each arm is target-guard → key
coercion → native call; `ArgumentListEvaluation` (all operands compiled by
`emitReflectArgumentLocals`) stays BEFORE every guard. `__object_setPrototypeOf_status`
must be consulted before the writer, and a 0 status must not call the writer
(the writer is a silent no-op today, so double-calling is invisible — keep it
single anyway). The `Object.preventExtensions` compile-away tracking
(`:1724`) must not change.

**Acceptance.**
- Claimed: `r3-C.txt` 22 rows; expected floor 18 (C4's getter row and C8a
  are conditional, `set/trap-is-undefined-target-is-proxy` needs F).
- Passing shapes at risk: these arms are edited for ALL receivers, so no
  byte-identity claim — behavioural controls on BOTH trees:
  `built-ins/Reflect/{set,setPrototypeOf,preventExtensions,get,has,
  getOwnPropertyDescriptor,defineProperty,ownKeys,apply}/` (current pass
  10/10/9/9/9/12/10/10/7), `built-ins/Object/setPrototypeOf/` (11),
  `Object/preventExtensions/` (39), `Object/freeze/` (51, incl. the #5268
  `proxy-*` rows), `Object/prototype/__proto__/` (8, the #5268 Step 1 branch
  in the same arm), `Object/getOwnPropertyNames/` (42) and
  `Object/getOwnPropertySymbols/` (7) for C6. `r3-controls.txt` 70/70.
- `imports-of.mts` on `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js` → `[]`.

### Step R3-3 — define/gOPD routing through the proxy (E, 3 rows) — `r3-E.txt`

**Root cause.** `compileObjectDefineProperty` (`object-ops.ts:979-1010`)
reroutes to `__obj_define_from_desc` only for a SYNTACTIC `new Proxy` binding
(its own `isNewProxy` + `ctx.checker.getSymbolAtLocation`, `:1006`), so
`r.proxy`, aliases and `any` receivers take the `__defineProperty_value` fast
path that stores on the proxy externref. `Object.getOwnPropertyDescriptor(p)`
with ONE argument falls past the `arguments.length >= 2` gate
(`call-builtin-static.ts:2739`) into the `__get_builtin` compile error.

**Edits.**
1. **E-1 runtime guard (complete fix).** In `ensureProxyRuntime`, next to the
   `objDefineBody` patch (`:2280`), `findBody("__defineProperty_value")`
   (`object-runtime-descriptors.ts:717`, params `obj, key, value, f64 flags`;
   flag word bits 0/1/2 = w/e/c, 3/4/5 = "specified", 7 = has value —
   `object-ops.ts:777`) and `findBody("__defineProperty_accessor")` (`:1188`),
   and `unshift` a `ref.test $Proxy` arm that rebuilds a descriptor `$Object`
   holding ONLY the specified fields (`__new_plain_object` + `__extern_set`
   per set bit; `call-parameters.js` counts the exact keys) and tail-calls
   `__proxy_define_dispatch(p, key, desc)`, returning its result. The
   syntactic gate at `object-ops.ts:1000` becomes redundant — leave it (its
   emitted bytes are unchanged for non-proxies). Do NOT widen the gate with
   `ctx.checker`; if a compile-time widening is wanted, use
   `tracesToProxyValue` (`proxy-value-provenance.ts:69`, oracle-based).
2. **E-2 1-arg gOPD.** `call-builtin-static.ts:2739`: under `ctx.standalone`
   accept `arguments.length >= 1`; pad the key with `undefinedExternInstrs`
   (the native coerces it to `"undefined"`; the revoked front-guard throws
   first). Row: `getOwnPropertyDescriptor/null-handler.js`.

**Growth grant.** `object-runtime-proxy.ts` (+~70), `call-builtin-static.ts`
(+~10).

**Order-preservation.** The guard is a FRONT test on param 0; the ordinary
body's `ref.cast $Object` and every later arm keep their order. A revoked
proxy must throw from the dispatch, not from the rebuild.

**Acceptance.**
- Claimed: `defineProperty/null-handler.js`, `defineProperty/call-parameters.js`,
  `getOwnPropertyDescriptor/null-handler.js`; plus the `pD` probe must print
  the trap firing.
- Passing shapes at risk: `__defineProperty_value` is the store behind EVERY
  `Object.defineProperty`, `Object.defineProperties`, `Object.create(p, descs)`
  and the namespace seeding (`emitBuiltinNamespaceObject`): run
  `built-ins/Object/defineProperty/` (1128 pass — 29 batches of 40; permitted
  to sample 200 spread across `15.2.3.6-4-*` if time-boxed, and say so),
  `Object/defineProperties/`, `Object/create/` (320), `Object/getOwnPropertyDescriptor/`
  (310) on the branch: zero pass→non-pass. Byte-identity for a standalone
  program that defines properties but never mentions `Proxy` (the guard is
  installed only by `ensureProxyRuntime`).

### Step R3-4 — first-class revoker (D, 4 rows) — `r3-D.txt`

**Root cause.** `__proxy_revoker` (`object-runtime-proxy.ts:1638`) is a 1-field
struct known only to `fillApplyClosure` (`object-runtime.ts:7694`) and
`__typeof_function`; `gOPD(revoke,"length")` is undefined, `hasOwnProperty`
false, `isConstructor(revoke)` throws "invoked with a non-function value".

**Edits.** Each native below already has a NON-`$Object` head for builtin-
function metadata (the #2896 `bfn…` arm — `buildNonObjectDeleteArms` in
`__delete_property` shows the shape); add a `ref.test __proxy_revoker` arm
IMMEDIATELY AFTER that existing arm in: (a) `__getOwnPropertyDescriptor`
(`object-runtime-descriptors.ts:2909`): `"length"` → `__create_descriptor(box 0,
FLAG_CONFIGURABLE)` (`:2998`), `"name"` → `{value:"", configurable}`, else
undefined singleton; (b) `__getOwnPropertyNames` (`:3262`): `["length","name"]`
in that order; (c) `emitHasOwn` (`object-runtime.ts:4545`): `length`/`name`
only; (d) `fillReflectIsConstructor` (`reflect-construct-native.ts:212`):
revoker → 0 — `isConstructor` in the harness is `Reflect.construct(function(){},
[], f)` and the arm at `call-namespace-static.ts:1611-1617` already throws
"newTarget is not a constructor" on 0; (e) `new revoke()`: check what the
construct driver does with a callee that is neither `$Proxy` nor `$Object`
(`native-construct.ts` ordinary tail) — add the revoker to its
"not a constructor" TypeError arm. `__typeof_function` already answers 1.

**Growth grant.** `object-runtime-descriptors.ts` (+~50), `object-runtime.ts`
(+~15, `ensureObjectRuntime` — NEW grant below), `reflect-construct-native.ts`
(+~10, `fillReflectIsConstructor` granted), `native-construct.ts` (+~15).

**Order-preservation.** The arm goes AFTER the #2896 builtin-fn arm and BEFORE
the `$Object` cast; it must not change what the builtin-fn arm answers for
closures and bound functions. `property-order.js` needs `length` before
`name`.

**Acceptance.**
- Claimed: `revocable/revocation-function-{length,name,property-order,
  not-a-constructor}.js`.
- Passing shapes at risk: `gOPD`/`getOwnPropertyNames`/`hasOwnProperty` on
  functions, bound functions and builtins: run `built-ins/Function/prototype/bind/`
  (93 pass), `built-ins/Function/length/`, `built-ins/Function/prototype/name*`,
  `built-ins/Object/prototype/hasOwnProperty/` (62), `Proxy/revocable/` (13)
  on both trees; `r3-controls.txt` 70/70. Byte-identity for a proxy-free
  program (all arms gated on `ctx.structMap.get("__proxy_revoker")`).

### Step R3-5 — open representation for a proxy TARGET literal (G, 5 rows) — `r3-G.txt`

**Root cause.** `pA`: with `var target = {attr:1}; var p = new Proxy(target, {})`,
`delete p.attr` forwards `__delete_property` onto a carrier that is not a
`$Object` (silent `return 1`), so the target still owns `attr`;
`gOPD(target,"attr")` and `"attr" in p` keep answering from the literal.
`proxyBindingIsTarget` (`analysis/proxy-binding-escape.ts:284`) already marks
the TARGET binding for externref storage (`proxyBindingNeedsExternref`,
`:290`), but the INITIALIZER is still compiled as a closed struct and boxed.

**Edits.** Find where `proxyBindingNeedsExternref` is consulted in the
variable-declaration paths (grep; both the module-global and the function-local
declaration compile) and, when it answers true AND the initializer is an
object literal, compile the initializer with `compileObjectLiteralAsExternref`
(the open `$Object` path the HANDLER already takes — `call-builtin-static.ts:3920`)
instead of the closed-struct path. The `in` fold (`compileInOperator`,
`binary-ops-in.ts:208-260`) already bypasses itself for externref-slot
receivers — verify, do not edit unless `has/return-false-target-prop-exists.js`
still folds. Verify with `pA` first, then the list.

**Growth grant.** The declaration site file(s) the grep finds — expected
`src/codegen/statements.ts` and/or `src/codegen/index.ts` (+~20 each; add the
file to `loc-budget-allow` with a dated line if the gate names it —
`index.ts::generateModule` is already granted), `binary-ops-in.ts` (+~10 if
needed, `compileInOperator` — NEW grant below).

**Order-preservation.** Only bindings for which `proxyBindingNeedsExternref`
is ALREADY true change representation; every other literal keeps its closed
struct. Static reads `target.attr` on such a binding already go through the
externref accessor path (`ctx.externrefAccessorVars`).

**Acceptance.**
- Claimed: `deleteProperty/trap-is-undefined-{strict,not-strict}.js`,
  `has/return-false-target-prop-exists.js`, `getOwnPropertyDescriptor/trap-is-undefined.js`,
  `setPrototypeOf/not-extensible-target-same-target-prototype.js` (its second
  half — `Object.setPrototypeOf(outro, p)` with `outro = {}` — also needs the
  literal open; if it stays red, name the assertion).
- Passing shapes at risk: every `var t = {…}; new Proxy(t, h)` row that passes
  today because static reads of `t` fold (the 184 Proxy passes are the
  population): run all `built-ins/Proxy/` again on the branch, zero
  pass→non-pass; `language/expressions/delete/` (62), `language/expressions/in/`
  (28), `r3-controls.txt` 70/70. Byte-identity for a program whose object
  literals are never proxy targets.

### DEFERRED (36 in-scope rows + 31 owned elsewhere) — do not start in this pass

| id | rows | why deferred | pointer |
|---|---:|---|---|
| B — proxy as `[[Prototype]]` + receiver-threaded `[[Set]]` | 12 | needs a new `$Object` field or reserved key and a per-hop arm in `__extern_get` / `__extern_has` / `__extern_set_decide` / `__isPrototypeOf` / for-in — the hottest walkers in the runtime; the blast radius is every property read in every standalone module, which no control list can cover. Own issue, with `pnpm run test:equivalence:gate` + a full `built-ins/Object/` re-run as its floor. | r2 Step 4 (representation + walker arms + `__proxy_set_dispatch_recv` + `__ordinary_set_receiver`) is the design; the receiver primitive is also what #2046 (X2) needs — build it once, there. |
| F — exotic targets under the trap-absent forward | 18 | each row's first failure is the carrier's MOP (array `length = 0`, String-wrapper deref, RegExp `lastIndex` brand check, bound-function `__apply_closure`), not the proxy layer; owners: array lane (#5268 N), #4491, #5198, `construct-bound.ts`. After R3-0…R3-5 re-run `proxy-cl-F.txt` and record the residue by carrier in Results; fix only a proxy-layer defect found (a dropped result, a `ref.cast $Object` on `ptarget`). | r2 Step 6 |
| C7 `Reflect.defineProperty` → `false` | 1 | a mutable global threaded through nine throw sites of the #2042 S4 preflight, for one row | r2 C7 |
| C8b `Object.getPrototypeOf(Reflect/Proxy)` | 2 | needs `%Object.prototype%` / `%Function.prototype%` as storable `$Object`s — measure first (`emitEs5IntrinsicPrototype` is not exported under that name; see `expressions/object-get-prototype-of.ts:177/259` `tryCompileEs5GetPrototypeOf{Early,Value}`); if either is a `$NativeProto`, it cannot be stored in `$Object.proto` | r2 C8(b) |
| C8c `Reflect.getPrototypeOf({})` | 1 | reuse `tryCompileEs5GetPrototypeOfValue(ctx, fctx, expr)` (`object-get-prototype-of.ts:259`, inspects `arguments[0]` only) in the `getPrototypeOf` arm (`:1185`); cheap but untested against the arm's non-object guard order — do it only if R3-2 finishes under budget | r2 C8(c) |
| C8d `defineProperty/desc-realm.js` | 1 | changes `__getPrototypeOf` for every ordinary object with a null `$proto` | r2 C8(0) |
| E-3 lazy GetMethod (`setPrototypeOf/return-abrupt-from-get-trap.js`) | 1 | 13 eager read sites in `__proxy_create` become per-operation handler reads | r2 E-3 |
| X1 #3371 (14), X2 #2046 (7), X3 realm harness (3), X4 misc (7: `Object.prototype.hasOwnProperty` value #5268-area, gOPS proxy arm = #5268 2.5, `enumerate` trap #1320, module-namespace exotic, two closed-struct Reflect receivers #2949/#2580, generator host imports #680/#2961) | 31 | owned elsewhere | r2 "Out of scope" table; `r3-owned-elsewhere.txt` |

### r3 acceptance criteria (whole pass)

- Floor **+80**, ceiling **+90** of the 126 in-scope rows: R 27, A 29, C 18–22,
  E 3, D 4, G 3–5. Every row NOT flipped is named in Results with its first
  failing assertion and owner.
- `r3-controls.txt` 70/70 after every step; the per-step directory controls
  above run on BOTH trees with zero pass→non-pass; the full `built-ins/Proxy/`
  311 re-run after R3-1 and after R3-5.
- Standalone modules host-import-free on one claimed row per step.
- Gates chained (protocol §5); growth outside the frontmatter grants gets a
  dated line in this file, never a baseline edit.
- `tests/issue-5196-es2015-proxy-r2.test.ts` extended with one host +
  standalone control per step (the `pA`/`pC`/`pD` shapes, r2's `p1`/`p4`/`p10`/
  `p11`) asserting `WebAssembly.Module.imports(module).length === 0`, plus the
  exact test262 rows via `runTest262File`; `node scripts/update-issues.mjs --check`,
  `check-issue-ids.mjs`, `check-issue-spec-coverage.mjs` green.

## Results — R3-0 (2026-09-03, Opus implementer)

Base for every number below: `4fa179f8` (this worktree's HEAD before the first
edit), standalone lane, quickjs eval tier, run by the implementer.

**Claimed: +11 of `r3-R.txt` (27 rows) — base 0/27 pass, lane 11/27.**

| row | base | lane |
|---|---|---|
| `Proxy/{get,set,has,apply,getPrototypeOf,isExtensible,preventExtensions,ownKeys}/trap-is-not-callable-realm.js` | fail | **pass** |
| `Proxy/{apply,construct,defineProperty}/null-handler-realm.js` | fail | **pass** |
| the other 16 `*-realm*` rows | fail | fail (unchanged signature) |

What landed:

1. `native-construct.ts` `fillNativeConstructDrivers` — a front arm that
   `ref.eq`-compares the callee against the `__builtin_Proxy` carrier global and
   tail-calls `__proxy_create`. The decision is made on the VALUE at runtime, so
   an alias, a parameter or a property read of the carrier all construct a proxy.
2. `proxy-value-provenance.ts` `tracesToProxyConstructorValue` — one shared
   predicate for "this expression IS the `Proxy` constructor" (bare binding,
   realm-global `.Proxy`, single-initializer alias), oracle-only.
3. `new-super.ts` — that predicate arms the driver (`ctx.proxyConstructorValueNewSite`),
   forces `ensureNativeProxyRuntime`, and lowers an object-literal target/handler
   at such a site to the OPEN `$Object` the syntactic `new Proxy` arm uses.
4. `analysis/proxy-binding-escape.ts` `isDirectProxyConstruction(expr, ctx?)` —
   with a ctx, `new <Proxy ctor value>(…)` gets the same externref binding
   storage as `new Proxy(…)`; the three call sites that have a ctx pass it.
5. `builtin-value-read.ts` — `Proxy.revocable` as a VALUE now calls
   `__proxy_revocable` instead of the "not yet implemented" thrower.

**Plan corrections (measured):**

- The plan's expected "+21 immediately" is wrong. The 16 rows still failing are
  NOT gated on the construct path: with the fix, `new OProxy(t, h)` demonstrably
  builds a working proxy (a `get` trap fires, a non-callable `get` trap throws),
  but the `getOwnPropertyDescriptor` / `defineProperty` / `ownKeys` / `construct`
  operations do not dispatch through the proxy in these shapes. Those are the
  A (§10.5 invariants) and E (define/gOPD routing) groups, i.e. R3-1/R3-3 work.
- The plan's byte-inertness gate (`ctx.funcMap.has("__proxy_get_dispatch")`, or
  the carrier global existing) does NOT work: measured on `4fa179f8`, a program
  that never mentions `Proxy` already has `__proxy_create`, `__proxy_get_dispatch`
  and the `__builtin_Proxy` global, and gating on them changed that program's
  bytes. Hence the module-scoped flag.
- `proxy-value-provenance.ts` exists but does NOT hold `isNewProxy` for the
  define path; `object-ops.ts:1006` still has its own syntactic gate (R3-3).

**Never-worse-than-base evidence (all re-run by the implementer on the lane):**

- `built-ins/Proxy/` — all 311 rows, 8 batches: base 184 pass → lane 195 pass,
  **zero pass→non-pass**.
- `language/expressions/new/` + `built-ins/Reflect/` — all 212 rows: base 178
  pass → lane 178 pass, **zero pass→non-pass**, zero new passes.
- `r3-controls.txt` 70/70 on the lane (two runs: before and after the gate was
  narrowed).
- `imports-of` on `Proxy/get/trap-is-not-callable-realm.js` → `[]`.

**Byte-identity caveat (honest):** a standalone program that never mentions
`Proxy` is NOT byte-identical to base. The construct-driver arm is inert (flag
gated, verified), but the `Proxy.revocable` value-closure arm changes the
namespace carrier's `revocable` member in every module where that carrier is
materialised — which measurement shows is every standalone module. The change
replaces a thrower with a working native call; the 593 rows re-run above show no
behavioural regression, but the bytes do move.

## Results — R3-2 C4 + C5 (2026-09-03, Opus implementer)

**Claimed: +8 of `r3-C.txt`.** All eight re-run and seen passing on the lane;
all eight `fail` on `4fa179f8`.

- C4 (4): `Reflect/{get,has}/target-is-not-object-throws.js` — the shared
  `guardNativeReflectTarget` (the §Type(V)-is-Object test the
  `deleteProperty`/`ownKeys`/`isExtensible` arms already use) now runs on the
  `get` and `has` arms too. `Reflect/apply/target-is-not-callable-throws.js` —
  the callable ladder gains a POSITIVE `typeof t === "object" && typeof t !==
  "function"` rejection, so `Reflect.apply({}, …)` throws while every callable
  carrier (compiled closure, bound function, `$Proxy` over a callable) is
  admitted exactly as before. `Reflect/apply/arguments-list-is-not-array-like.js`
  — §7.3.19 step 2: a missing third argument throws at compile time, a
  primitive/null one through the same Object guard.
- C5 (4): the four `Reflect/*/return-abrupt-from-property-key.js`. §7.1.19
  ToPropertyKey now runs at the CALL SITE (after the target guard, before the
  native call) for `get`, `set`, `getOwnPropertyDescriptor`; the natives coerce
  internally but swallow a throwing `toString`. `Reflect.defineProperty(t, k)`
  with two arguments got a new arm — before it hit the "#1472 Phase C" hard
  COMPILE refusal, so the row could not even run; it now does step 1, step 2
  (where the throw escapes) and then the step-3 TypeError.
- `Reflect.set`'s arguments now go through locals instead of straight onto the
  stack (needed to coerce the key in place). Evaluation order is unchanged.

**Never-worse-than-base (re-run by the implementer on the lane):**

- `language/expressions/new/` + `built-ins/Reflect/` all 212 rows: base 178 pass
  → lane 186 pass, **zero pass→non-pass**.
- `built-ins/Proxy/` all 311 rows: base 184 → lane 195, **zero pass→non-pass**
  (the `apply` guard sits on the path a proxy `apply` trap takes).
- `r3-controls.txt` 70/70.

**Not done in C:** C1 (Reflect.set proxy bypass), C2/C3 (setPrototypeOf /
preventExtensions booleans), C6 (ownKeys symbols+order), C8a. Not started —
budget, not a finding.

## Results — R3-4 (2026-09-04, Opus implementer)

Base for every number: a `git archive` of the merge-base `4fa179f8` materialised
under `.tmp/basetree`, run by this implementer on the same box, same quickjs
eval tier. Not inherited from any artifact.

**Claimed: +4 of 4 (`r3-D.txt`) — base 0/4, lane 4/4, standalone.**

| row | base | lane |
|---|---|---|
| `Proxy/revocable/revocation-function-length.js` | fail (`length should be an own property`) | **pass** |
| `Proxy/revocable/revocation-function-name.js` | fail (`name should be an own property`) | **pass** |
| `Proxy/revocable/revocation-function-property-order.js` | fail (`length comes before name`) | **pass** |
| `Proxy/revocable/revocation-function-not-a-constructor.js` | fail (`isConstructor invoked with a non-function value`) | **pass** |

### What landed

1. `object-runtime-proxy.ts` — `__proxy_revoker` gains a second field, a mutable
   `i32` deleted-bits mask (bit 0 `length`, bit 1 `name`), the same per-instance
   state the #2896 builtin-fn meta structs carry. Grepped: the type has exactly
   ONE `struct.new` site (this one); `object-runtime.ts:7694` only reads field 0.
2. `proxy-revoker-meta.ts` (NEW) `fillProxyRevokerFnMeta` — one arm in
   `__builtinfn_get_meta` (the single question `__builtinfn_gopd`,
   `__hasOwnProperty` and `__extern_get` all ask, so it answers the value, the
   descriptor and the has-own test at once), plus the matching
   `__builtinfn_delete` and `__builtinfn_push_ownnames` arms (`length` before
   `name` — the creation order `property-order.js` asserts). Splice discipline
   copied from `fillTaCtorGetMetaArm`: a receiver `ref.test` guard disjoint from
   every other arm, spliced at body index 0, reading only the params.
3. `typeof-natives-finalize.ts` — the carrier's `typeof` arm. Before it,
   `typeof revoke` answered "function" only on the compile-time path and
   "object" through any indirection (a parameter, an array element, a property
   read), which is what made the `isConstructor.js` harness throw.
4. `expressions/non-constructable.ts` — `classifyInit` learns the
   `Proxy.revocable(…).revoke` initializer shape and returns `"provable"`.
5. `context/types.ts` + the two call sites (`call-builtin-static.ts`,
   `builtin-value-read.ts`) — the `proxyRevocableSite` module flag.

### Plan corrections (measured, not predicted)

- **The plan's edit list (a)–(e) targets natives that are not where the answer
  lives.** `__getOwnPropertyDescriptor` / `__getOwnPropertyNames` / `emitHasOwn`
  all *delegate* the builtin-function case to `__builtinfn_get_meta` /
  `__builtinfn_push_ownnames`, so one arm in each of those two answers all
  three questions; four separate arms would have been four chances to disagree.
- **Plan edit (e) — "add the revoker to the construct driver's not-a-constructor
  arm" — does not reach the row.** Measured: `new revoke()` returns **null**,
  because the callee never reaches `__native_construct_N` at all
  (`resolvesToConstructableFunctionValue` declines and the dynamic-`new`
  ladder falls through to `ref.null.extern`). An arm was written in
  `fillNativeConstructDrivers` and **measured not to fire**; it was reverted in
  favour of the static classifier above, which is where the existing
  arrow-function / `Function.prototype.call` shapes are already decided.
- **`ctx.proxyRevocableSite` is needed because presence is not a gate.**
  Re-confirmed the R3-0 measurement: the `__proxy_revoker` struct type and the
  proxy natives exist in EVERY standalone module.

### Never-worse-than-base (all re-run by this implementer)

- **Standalone, `built-ins/Proxy/revocable/` + `language/expressions/new/`, all
  77 rows, 3 batches:** base **69** pass → lane **73** pass, **zero
  pass→non-pass**. The base non-pass set is a strict superset of the lane's: the
  4 claimed rows flipped; `Proxy/revocable/tco-fn-realm.js`,
  `new/ctorExpr-isCtor-after-args-eval.js`, `new/non-ctor-err-realm.js`,
  `new/spread-obj-spread-order.js` fail identically on both.
- **Standalone, function-metadata reflection controls (38 rows:
  `Function/length/`, `Function/prototype/bind/{name,length}*`,
  `Object/prototype/hasOwnProperty/`) — the shapes the three `__builtinfn_*`
  arms could collide with: lane 38/38 pass.** A perfect lane score cannot be
  worse than any base, so base was not re-run for this set.
- **JS-host lane, the 4 claimed rows:** base 3/4 → lane 4/4 (base failed
  `not-a-constructor` with a plain `Error`). The non-constructable classifier is
  the one target-agnostic edit; it improves host and regresses nothing there.
- **WASI:** both trees compile the revoker probe and a Proxy-free
  bound-function probe with **zero imports**; no compile error either side.
- **Standalone behaviour probe** (`typeof` + `length` + `name` + revoke):
  base returns 1 (`typeof revoke !== "function"`), lane returns 0. The
  Proxy-free bound-function probe returns 1 on **both** trees — wrong the same
  way as base (`bind` length/name is #5268-area, untouched here).
- `imports-of` equivalent: the vitest pin asserts
  `WebAssembly.Module.imports(module).length === 0` on the standalone control.

### Honest caveats

- **Byte-identity for a Proxy-free standalone program does NOT hold**, and this
  step widens the R3-0 caveat rather than repeating it: the `__proxy_revoker`
  deleted-bits field is added in `ensureProxyRuntime`, which runs in every
  standalone module, so the type section moves even where `proxyRevocableSite`
  is false (measured: the bound-function probe's sha differs, `3927941ef9f8c6bd`
  → `34bcbb558b62707e`, with identical behaviour). Everything that *emits* is
  flag-gated; the field is not, because `ensureProxyRuntime` can run before the
  revocable call site is compiled.
- **`LOC_GATE_BASE=origin/main` reports one failure this change did not cause:**
  `src/codegen/statements/loops.ts: 4437 > 4436 (+1)`. The branch does not touch
  that file at all (`git diff origin/main...HEAD -- src/codegen/statements/loops.ts`
  is empty) — it is a ceiling reset from main's post-merge baseline refresh and
  belongs to the integrator's `git merge origin/main`, not to a grant here. All
  five gates pass bare, and `LOC_GATE_BASE` func-budget passes.

### Pin

`tests/issue-5196-r3-4-revoker-fn.test.ts` — one standalone control (zero
imports; typeof through a parameter, `length`/`name` values, own-ness,
`getOwnPropertyNames` order, `configurable` descriptor, an effective
`delete revoke.length`, and that the carrier still revokes afterwards) plus the
four exact test262 rows. **Verified 5/5 FAIL on `.tmp/basetree` (`4fa179f8`) and
5/5 pass on the lane.**

### Not done in this pass

R3-1 (§10.5 invariants, 29 rows), R3-3 (define/gOPD routing, 3 rows), R3-5
(open proxy-TARGET literal, 5 rows), and the R3-2 residue (C1, C2/C3, C6, C8a).
Not started — budget, not a finding.

## Results — R3-3 E-2 only (2026-09-04, Opus implementer)

Same base tree and protocol as R3-4 above.

**Claimed: +1 of the 3 `r3-E.txt` rows — `Proxy/getOwnPropertyDescriptor/null-handler.js`,
base `compile_error` → lane `pass` (standalone).**

`Object.getOwnPropertyDescriptor(o)` with ONE argument was refused by the call
site's `arguments.length >= 2` gate, fell through to `__get_builtin`, and became
the "#1472 Phase B dynamic-shape" hard COMPILE error — the module did not
compile, so the row could not even run. §20.1.2.8 needs no second argument:
step 2 is `ToPropertyKey(undefined)`, the key `"undefined"`. Under
`ctx.standalone` the 1-argument form now routes straight to the dynamic
`__getOwnPropertyDescriptor` native with the undefined sentinel as the key, so
the receiver's own front guards run in their normal place — which is what makes
the revoked `$Proxy` throw its TypeError.

**Blast radius, measured not assumed:** `grep -rl
"getOwnPropertyDescriptor([A-Za-z_$][A-Za-z0-9_$.]*)"` over `built-ins/` +
`language/` returns **exactly one file** — the claimed row. No other test262 row
can reach the new block, and every such module previously failed to compile
outright, so no passing row can regress through it. `Object/getOwnPropertyDescriptor/`
sample (20 rows) is 20/20 on the lane, which cannot be worse than any base.
Host/gc is untouched by construction (the block is `ctx.standalone`-gated);
measured anyway: `r3-E.txt` on the host lane is 2 pass / 1 fail on **both**
trees, same row, same message.

Pin `tests/issue-5196-r3-3-gopd-arity.test.ts` (zero imports; 1-arg on an object
that lacks and one that owns `"undefined"`, the 2-arg form unchanged, and the
revoked-proxy TypeError) — **verified 2/2 FAIL on `.tmp/basetree`, 2/2 pass on
the lane.**

**E-1 NOT started (the other 2 E rows).** `defineProperty/null-handler.js` and
`defineProperty/call-parameters.js` need the `$Proxy` front guard inside
`__defineProperty_value` / `__defineProperty_accessor` — the store behind EVERY
`Object.defineProperty`, `Object.defineProperties`, `Object.create(p, descs)`
and the builtin-namespace seeding. The plan's own acceptance for it is
`Object/defineProperty/` (1128 passing rows), `Object/defineProperties/`,
`Object/create/` (320) and `Object/getOwnPropertyDescriptor/` (310) re-run on
both trees. At the ~20 s/row this 4-core box measures, that floor alone is many
hours; starting the edit without it would ship an unmeasured change to the
hottest store in the object runtime. Deferred deliberately, not forgotten.

## Round-3 review fixes (2026-09-04)

An adversarial review put this lane on hold with four reproduced findings (F1-F4)
and four lows (F5-F8). Base tree for every measurement below is the r3 merge-base
`4fa179f8`, extracted with `git archive`; its `src/` tree was verified
byte-identical to the reviewer's copy at `/home/user/js2/.tmp/rev5196/base`
before it was reused. Every "base" figure is a run this implementer executed.

### F1 (HIGH) — a REASSIGNED alias of the `Proxy` constructor was claimed

`src/codegen/proxy-value-provenance.ts` `tracesToProxyConstructorValue` followed
an identifier through `ctx.oracle.variableInitializerOf` with no single-assignment
proof. That oracle member is documented as "the binding-resolution seam for
analyses that SEPARATELY PROVE single assignment" (`src/checker/oracle.ts`), and
without the proof the trace reads a reassigned binding as its DECLARATION
initializer. `var P = Proxy; class K{…}; P = K; new P(5, 6)` therefore armed
`ctx.proxyConstructorValueNewSite` and routed the `new` through
`tryCompileNativeConstructFromValue`.

- Measured, standalone: node `5 true object`, base `5 true object`,
  lane-HEAD `undefined false object`. A correct answer turned wrong.

**Fix.** The alias hop is taken only under `isSingleAssignmentBinding` (new, in
the same file): exactly one declaration, a plain initialized `var`/`let`/`const`
declarator in a variable STATEMENT (so a destructuring binding, a `for…of` head
and a `catch` parameter all decline), and either `const` or a name that no
in-file syntax writes. Unproven ⇒ decline ⇒ the base lowering, never a guess.

The write scan reuses `identifierIsWrittenTo` (`native-ordinary-instanceof.ts`),
**widened** from "`<id> = …` / `++` / `--` with the identifier as the WHOLE
operand" to any write POSITION — so a destructuring assignment target
(`[P] = [K]`, `({x: P} = o)`) and a `for-in`/`for-of` head now count. Widening a
soundness gate can only make a caller DECLINE a fold it would otherwise take, so
the **eight** pre-existing callers (`add-to-primitive`, `binary-ops-in`,
`builtin-static-plain-alias` ×2, `expressions/identifiers`,
`fnctor-instance-prototype`, `native-is-prototype-of`, `native-user-instanceof`)
are safe by construction. An earlier draft of this paragraph said "three"; that
was a miscount, corrected here after grepping the callers.

A second declaration of the same binding is deliberately NOT part of it (the
declarator's own name node would then read as a write and break
`resolveVariadicBuiltinStaticPlainAlias`); it is answered by declaration COUNT
at the one call site that needs it.

**Correction applied on resumption (2026-09-04).** The first cut of the widening
counted ANY identifier of that name whose enclosing statement was an assignment,
including identifiers that only SPELL the word: a member name (`o.P = 1`), a
property-assignment key (`{ P: 1 }`), a qualified-name right side. Those are not
write positions, and the base shape could not see them either (it required
`node.left` to BE the identifier). Left in, an unrelated `obj.max = 1` anywhere
in a file would have silently disabled the `Math.max` alias fold for a binding
named `max` — a blanket de-optimisation reaching well past this change-set, with
no measurement behind it. The scan now counts only identifiers in a REFERENCE
position (`isReference`), keeping the widening to genuine writes.

### F2 (HIGH) — the new `Reflect.get` / `Reflect.has` target guard threw on real objects

`emitNativeReflectTargetGuard` is an OR of positive OBJECT brands. A value that
flows through a mixed array also holding a class instance takes a wrapped
representation that none of those brands recognise, so the guard threw.

- Measured, standalone, 14 ordinary target kinds (`p/r32/01-get-has-targets-a.js`):
  base answered `undefined`/`false` for 13 of them (wrong, but stable) and node
  answers a value for 4; lane-HEAD threw a TypeError for **13 of 14**. A stable
  wrong value turned into a throw.

**Fix.** A second emitter, `emitNativeReflectNonObjectGuard`, rejects only
POSITIVELY-branded non-objects — `__typeof_number`, `__typeof_string`,
`__typeof_boolean`, `__typeof_bigint` and the `$Symbol` carrier — and ADMITS
every unrecognised shape. This is the `Reflect.apply` arm's own rationale
(~L1660) applied to the target position. Those brands are `ref.test`s on the BOX
structs, so a wrapper object (`new Number(1)`) stays admitted, as §28.1.5
requires.

**`null` and `undefined` are deliberately NOT branded, and that took two
measured iterations to get right.** A `ref.is_null` arm was in the first cut and
reproduced the finding one level down: an ordinary object read out of a
heterogeneous `any[]` comes back as a NULL externref (the pre-existing widening
defect this file's own `isDirectProxyBinding` comment documents), so
`Reflect.get(vals[i], "k")` over `[[1,2], new C(), {k:4}]` threw for the array
and the literal where base answers a stable `undefined`. Dropping `ref.is_null`
fixed that shape but not the same call read from inside a NESTED function —
because `__typeof_undefined` answers TRUE for the same nulled value, under the
undefined-SINGLETON representation as well as the legacy one. Both arms are out.

The cost is bounded and is base-parity: a literal `null` or `undefined` target
answers `undefined`/`false` instead of throwing — exactly what base does. The
win that survives is real and is node parity: `Reflect.get(1, "x")`,
`Reflect.get("ab", "length")`, `Reflect.get(true, "x")` and
`Reflect.has(1, "x")` throw the §28.1.5/§28.1.8 step-1 TypeError where base
answered `undefined`/`false`, and `Reflect.get([1,2], "length")` answers `2`
where base answered `undefined`.

Applied to the FOUR guard sites this change-set added — `Reflect.get`,
`Reflect.has`, the new 2-argument `Reflect.defineProperty` arm, and the
`Reflect.apply` argumentsList. The six sites inherited from `origin/main`
(`deleteProperty` / `ownKeys` / `getOwnPropertyDescriptor` /
`defineProperty(3-arg)` / `isExtensible` / `preventExtensions`) keep the stricter
emitter unchanged: their admission behaviour is pre-existing and not this
review's to widen.

The intended win survives, and was re-measured on 2026-09-04 as the pin control
`p/pins/f2.js` (the 14-target sweep plus three primitive spellings, reduced to
two counters):

| | `threw` (of 14 ordinary targets) | `wins` (of 3 primitive rejections) |
|---|---|---|
| node | 0 | 3 |
| base `4fa179f8` | 0 | 0 |
| lane HEAD `d84b8f14` | **13** | 3 |
| lane, fixed | 0 | 3 |

**Correction to an earlier draft of this section:** it claimed
"`Reflect.has(undefined, "x")` still throws". It does **not**, and cannot —
`undefined` is one of the two values this emitter deliberately declines to
brand, three paragraphs up. The win covers `Reflect.get(1, "x")`,
`Reflect.has(1, "x")` and `Reflect.get("ab", "length")`; a `null`/`undefined`
target answers `undefined`/`false`, which is exactly base's answer, so it is a
win declined, not a regression. The same wrong sentence was in
`reflect-target-guard.ts` and is corrected there too.

### F3 (medium) — the "provable" revoker classification was reassignment-blind

`expressions/non-constructable.ts` read the `Proxy.revocable(t,h).revoke` shape
off the DECLARATION initializer; `new-super.ts` turns `"provable"` into an
unconditional throw under `noJsHost`.

- Measured, standalone: `var r = Proxy.revocable(t,h).revoke; class K{…}; r = K;
  new r()` — node and base `ok 7`, lane-HEAD `threw TypeError`.

**Fix.** The revoker arm now also requires `isSingleAssignmentBinding`. An
unproven binding returns `"no"`, which is precisely the base tree's behaviour
(the arm did not exist there), so this cannot be worse than base in any spelling.

**The pre-existing arrow arm was deliberately NOT touched.** It has the same
blindness on BOTH trees (`let f = () => 1; f = K; new f()` throws on base and on
the lane). Demoting it to `"no"` would remove a spurious throw in one spelling
and a CORRECT throw in another (`f` reassigned to a second arrow), i.e. it could
be worse than base. Recorded, not widened.

### F4 (medium) — `Proxy.revocable` as a VALUE with a trap handler TRAPPED

- Measured, standalone: `var R = Proxy.revocable; R({a:1}, {get(t,k){return 7}})`
  then `pr.proxy.a` — node `7`, base a catchable TypeError
  ("Proxy.revocable is not yet implemented in --target standalone"),
  lane-HEAD a wasm **TRAP `illegal cast`**.

Root cause, isolated by bisecting the argument shapes: the handler bound to a
`var` FIRST worked; only an INLINE object literal at the value call site broke.
`Proxy.revocable`'s lib signature types the handler as `ProxyHandler<T>`, a named
object type that `resolveWasmType` maps to a registered closed STRUCT, so the
generic slot-by-slot call path compiled the literal as that struct and the trap
read off it was not a callable. The direct `Proxy.revocable(t, h)` arm avoids
this by compiling an object-literal argument with `compileObjectLiteralAsExternref`.

**Fix, two parts.**

1. `builtin-static-plain-alias.ts` gains a named exception set
   `FIXED_ARITY_PLAIN_ALIAS_STATICS = {"Proxy.revocable"}` so `var R =
   Proxy.revocable` resolves to the reified closure's `[externref, externref]`
   ABI instead of the lib signature. Kept as a named exception rather than
   "every fixed-arity static", per that file's own header.
2. `expressions/call-identifier.ts`: an INLINE object literal in an `externref`
   slot of a statically-known builtin-value closure is built with
   `compileObjectLiteralAsExternref`. Scope is builtin-alias calls only, and the
   other members of that set (`Math.max`, `Math.min`, `String.fromCharCode`)
   never receive an object literal.

Result: the trap is gone and the value spelling constructs a real proxy —
`pr.proxy.a === 7`, `typeof pr.revoke === "function"`, and a revoked proxy still
throws. Better than base, which threw.

**One residual, measured precisely — and the earlier draft of this note got the
mechanism wrong.** `p/b9/02` (`console.log(pr.proxy.a)`) prints nothing on the
fixed lane where node prints `7`. The earlier draft blamed
"`console.log(<proxy-get-result>)` on standalone, identical on BASE with
`new Proxy`". That is false: measured 2026-09-04, standalone,
`var p = new Proxy({a:1},{get(){return 7}}); console.log(p.a)` prints `7` on
**both** trees (`p/f4b/01`). The gap is narrower and is specific to a
**revocable** proxy's `.proxy` field:

| probe | node | base | lane |
|---|---|---|---|
| `f4b/01` `new Proxy` → `console.log(p.a)` | `7` | `7` | `7` |
| `f4b/01` `new Proxy` → `console.log(String(p.a))` | `7` | *(nothing)* | *(nothing)* |
| `f4b/04` DIRECT `Proxy.revocable(t,h)` → `console.log(pr.proxy.a)` | `7` | *(nothing)* | *(nothing)* |
| `b9/02` VALUE `R = Proxy.revocable` → `console.log(pr.proxy.a)` | `7` | *throws "not yet implemented"* | *(nothing)* |

So the swallowed line is **pre-existing on base in the direct spelling**
(`f4b/04`), and the fix makes the value spelling behave exactly like base's
direct spelling. The value itself is correct and observable —
`String(pr.proxy.a)` is `7` on the lane (`p/pins/f4.js`), where base could not
run the program at all.

**Ship-gate honesty on this one row.** In this single spelling the transition is
base's catchable TypeError → lane's silent missing line, which is a shape the
ship gate names. It is recorded as a **residual**, not waved away: the program's
values are right, no trap and no exception, and the missing line reproduces on
base through the direct spelling, so it is a pre-existing stringification gap
this change-set surfaces rather than one it introduces. Fixing it means fixing
`console.log` of a revocable proxy's `.proxy` read on standalone, which is
outside this review.

### Lows

- **F5 (fixed).** The `__proxy_revoker` carrier's fields were named `proxy` and
  `bfnstate`, with no `__` prefix, so `exposedClosedStructFieldName` exposed them:
  `revoke.proxy` read back the inner proxy and a write to `revoke.bfnstate`
  corrupted the deleted-bits mask for the revoker's own `length`/`name`. Both are
  now `__proxy` / `__bfnstate`. Every access is POSITIONAL (`fieldIdx`), so the
  rename is inert to codegen; the synthetic getter `__sget_proxy` disappears from
  a Proxy-free standalone module, which is the direct measurement of the leak.
  Node agrees: the revocation function has no own `proxy` property.
- **F6 (fixed).** The one-argument `Object.getOwnPropertyDescriptor` block gated
  on `arguments.length === 1` and so accepted `gOPD(...args)`, whose arity is a
  run-time fact. It now declines a `SpreadElement` and leaves that call to the
  existing lowering.
- **F7 (recorded, not fixed).** "A caught one-arg gOPD TypeError on a revoked
  proxy disarms a later two-arg TypeError on the same proxy." The probe
  (`p/b12/03-revoked-1arg-then-2arg.js`) is a **COMPILE ERROR on base** — the
  one-argument form did not compile there at all — so the lane cannot be worse
  than base in this spelling, and the mechanism was not chased. It is a real
  residual defect of the R3-3 E-2 arm and belongs to whoever finishes E-1/E-2.
- **F8 (claim corrected; gating already present).** The write-up's
  "Everything that *emits* is flag-gated" was too strong and is corrected below.

### Byte-inertness — corrected claim

A standalone program that never mentions `Proxy` is **not** byte-identical to
base, and the earlier wording ("everything that emits is flag-gated; the field is
not") understated it. Measured 2026-09-04 on a Proxy-free bind/`length`/`name`
probe, standalone:

| | base `4fa179f8` | lane |
|---|---|---|
| module size | 276,346 B | 276,704 B (+358) |
| functions | 514 | 513 (`__sget_proxy` gone — the F5 fix) |
| `__proxy_revoker` type | `(struct (field $proxy externref))` | `(struct (field $__proxy externref) (field $__bfnstate (mut i32)))` |
| `ref.test` total | 2,399 | 2,429 |
| `ref.test` on the revoker type | 0 | 0 |

So: the emitted module MOVES for a Proxy-free program, in both directions
(one function fewer, more bytes). What is flag-gated on `ctx.proxyRevocableSite`
is the revoker METADATA (`proxy-revoker-meta.ts` returns early;
`typeof-natives-finalize.ts` resolves the type only under the flag). What is not
gated is the struct's shape itself, because `ensureProxyRuntime` can run before
the revocable call site is compiled — and `object-runtime.ts`'s
`fillApplyClosure` revoker arm, which is **pre-existing on base** and therefore
not gated here either. No further gating was attempted: with the metadata arms
already behind the flag, the residue is the type declaration, and moving that
would mean deferring `ensureProxyRuntime`, which is out of this review's scope.

The reviewer's specific figure — "53 `ref.test` on the revoker type in a
Proxy-free module vs 8 on base" — did **not** reproduce here: this measurement
finds zero on both trees. The conclusion it supported (not byte-inert) is
nevertheless correct and is recorded as such above.

### Resumption record (2026-09-04, second implementer)

The first implementer of this round was killed by a container restart with the
fixes **uncommitted** in the worktree. This section records what the resuming
implementer found, kept, changed and re-measured, so the provenance of every
figure above is traceable to a run someone actually executed.

**Found.** Uncommitted edits to nine `src/codegen` files, the F1-F4 write-ups
above, and a `tests/issue-5196-r3-review-fixes.test.ts` with four controls.
Typecheck (`tsc --noEmit -p tsconfig.ts7.json`) was clean on arrival. Its own
scratch recorded that the 212-row test262 batch had **hung for 80 minutes with
no output** and was killed, so **no row-set control had actually completed** —
the row evidence in this round is entirely the resuming implementer's.

**Kept, unchanged.** The F1 single-assignment proof, the F3 revoker arm, the F2
second emitter and its four call sites, the F4 two-part fix, and the F5/F6 lows.
Each was re-derived against the finding and re-measured (tables above).

**Changed on resumption.**

1. `identifierIsWrittenTo` gained the reference-position filter described under
   F1 — the widening as first written would have de-optimised unrelated
   bindings.
2. Two claims were wrong and are corrected in place: "`Reflect.has(undefined,
   "x")` still throws" (it does not, by design) and the caller count "three"
   (it is eight).
3. The F4 "honest note" blamed the wrong mechanism for a swallowed
   `console.log` line; the corrected table under F4 shows the gap is specific to
   a revocable proxy's `.proxy` read and is **pre-existing on base** in the
   direct spelling.
4. **The four pin controls were rewritten**, because two of them did not pin
   anything. Verified by file-copy A/B against lane HEAD `d84b8f14`: as
   originally written, F1 and F3 failed on HEAD (good pins) but **F2 and F4
   PASSED on HEAD** — they wrapped the program in an exported function, and
   neither finding reproduces in that shape. Both now run the program text as
   the review harness does (`nativeStrings` + `hostBridge: "always"` +
   `deferTopLevelInit`, stdout read back through `__stdout_prepare`/
   `__stdout_char`), and all four now fail on HEAD and pass with the fixes.
   A control that passes on the tree it is supposed to indict is not a pin, and
   this one nearly shipped as one.

### Verification on resumption — the review probe corpus, standalone

The full reviewer/skeptic probe corpus (92 programs across `p/r30`, `p/nc`,
`p/b4`, `p/b9`, `p/b11`-`b13`, `p/r32`, `p/r32b`, `p/gopd`, `p/gopd2`,
`p/meta`-`meta3`, `p/tof`, `p/free`, plus this round's `p/pins` and `p/f4b`) was
re-run base-vs-lane on **standalone** with the reviewer's own `ab.sh`/`cmp.mjs`,
against the final tree. Result:

- **39 of 92 differ from base; every one is lane-better or neutral.**
- **Zero new failure modes.** No probe carries `lane-TRAP`, `lane-COMPILE_ERROR`,
  `lane-WASM_INVALID` or `lane-THROW` that base does not carry identically. The
  three `WASM_INVALID` programs (`free/05-mapset`, `r32/03-keys`,
  `gopd/01-arity`) fail byte-for-byte the same way on both trees — pre-existing,
  untouched.
- The wins are concentrated where the round intended them: `r32b/01` base
  `2,NaN,…` → lane `2,1,…` (node parity); `r32b/07` base
  `undefined / no throw / no throw` → lane `1 ts / RangeError / TypeError`
  (node parity); `nc/06` base `no throw object` → lane `threw TypeError`
  (node parity); `b4/05` base drops `length,name` → lane keeps them;
  `tof/01` a `typeof` entry base reports `object` → lane `function`, matching
  node. The seven `base-COMPILE_ERROR` / `base-THROW` programs (the
  `Proxy.revocable`-as-value and one-arg-gOPD families) now run.
- `r32/02` line 2 is the one worth naming explicitly: node throws on all 13
  entries, base threw on 1, lane throws on 9. Lane is a strict superset of
  base's correct answers — no entry that base answered goes wrong.

### Verification on resumption — host and WASI probes, and a NEW finding (F9)

The finding-bearing probe directories (`p/pins`, `p/b9`, `p/r30`, `p/nc`,
`p/r32`, `p/free` — 42 programs) were re-run base-vs-lane on **host** and
**wasi**.

- **host: zero `BASE!=LANE`.** Every one of the 42 programs behaves identically
  to base on the JS-host lane, which is the byte-inertness expectation for that
  target.
- **wasi: 8 differ.** Six are lane-better or identical-in-kind (the two
  `WASM_INVALID` programs fail byte-for-byte the same on both trees; `01-alias`
  and `06-direct-provable` move toward node). Two are a new finding.

#### F9 (NEW, wasi-only) — `Reflect.defineProperty(target, <object key>, desc)` traps

`p/r32/04-topropertykey-order.js` and `p/r32/05-poisoned-key.js` go from
**base COMPILE_ERROR** ("Reflect.defineProperty not supported in standalone mode
(#1472 Phase C)") to **lane TRAP `illegal cast`** on `--target wasi`.

Bisected 2026-09-04 to one line — `Reflect.defineProperty(o, key, { value: 1 })`
where `key` is an ORDINARY OBJECT (the poisoned `toString` is incidental; a
plain `{ toString() { return "b"; } }` traps identically). Neither the arrow
wrapper nor the 2-argument arm is involved: the 2-arg arm answers a catchable
throw, and the same call on `--target standalone` answers node's
`RangeError:poison` correctly.

**It is base's own defect, reached through a new door.** The 3-argument arm
delegates to `emitDefinePropertyDescRuntime`, the shared applier that also backs
`Object.defineProperty`. Measured directly:

| probe, `--target wasi` | node | base `4fa179f8` | lane |
|---|---|---|---|
| `Object.defineProperty(o, <object key>, {value:1})` | `ok 1` | **TRAP illegal cast** | **TRAP illegal cast** |
| `Reflect.defineProperty(o, <object key>, {value:1})` | `ok` | COMPILE_ERROR (#1472 Phase C) | TRAP illegal cast |
| the same, `--target standalone` | `RangeError:poison` | COMPILE_ERROR | `RangeError:poison` (node parity) |

So the applier has been trapping on a non-primitive property key under WASI on
**both** trees since before this change-set; the Reflect arm (landed in R3-2,
`747c88c7` — **before** this fix round, and reproduced here on lane HEAD with
the round-3 fixes reverted) simply routes a second spelling into it.

**Not fixed here, and the ship-gate consequence is stated plainly.** The
available one-line "fix" is to decline the 3-argument arm for a non-primitive
key, which restores base's compile refusal on WASI at the cost of throwing away
the standalone node-parity win — trading a real correctness gain for the
appearance of parity while leaving the applier's actual bug untouched. That is
not a fix, so it was not made. The honest reading of the gate is therefore:
**`neverWorseThanBase` is FALSE**, on exactly these two WASI programs, for a
defect that is base's and that the lane makes reachable. It belongs to whoever
owns `emitDefinePropertyDescRuntime`'s WASI path.

### Verification on resumption — test262 row slices, base vs lane

Run with `scripts/run-test262-paths.mts … --standalone --isolate` (a fresh child
per row, 120 s cap — the in-process mode is what hung the previous
implementer's 212-row batch for 80 minutes and was killed at `exit=137`). Base
is the `git archive` extract of `4fa179f8` at `.tmp/basetree`, its `src/`
verified byte-identical to the reviewer's copy.

| slice | rows | base pass | lane pass | NEW non-pass on lane |
|---|---|---|---|---|
| `built-ins/Reflect/**` | 153 | 122 | **126** | 0 (see the artifact note) |
| `built-ins/Proxy/**` LP-00 | 50 | 30 | **31** | 0 |
| `built-ins/Proxy/**` LP-01 | 54 | 34 | **40** | 0 |
| `built-ins/Proxy/**` LP-02 | 53 | 27 | **32** | 0 |
| `built-ins/Proxy/**` LP-03 | 49 | 27 | **29** | 0 |
| `built-ins/Proxy/**` LP-04 | 54 | 31 | **33** | 0 |
| `built-ins/Proxy/**` LP-05 | 51 | 35 | 35 | 0 |
| `language/expressions/new/**` + `revocable/` | 59 | 56 | 56 | 0 |
| **total** | **523** | **362** | **382** | **0** |

**Net +20 passes over 523 rows measured on BOTH trees, zero rows lost.** All 311
`built-ins/Proxy/**` rows and all 153 `built-ins/Reflect/**` rows are covered.
The wins are the round's own: four `return-abrupt-from-property-key` rows (the
C5 ToPropertyKey coercion), `Reflect/apply/target-is-not-callable-throws`, nine
`trap-is-not-callable-realm` / `null-handler-realm` rows, and the four R3-4
revoker rows (`revocation-function-name`, `-length`, `-property-order`,
`-not-a-constructor`) — which is the full set this lane claimed for R3-4.

**Load artifacts, named so they are not mistaken for regressions.** The runs
shared a 4-core box with three other agents and up to four concurrent isolate
workers, so twenty rows changed non-pass KIND (`fail` → `error`/`compile_error`)
with reasons that are all `spawnSync … ETIMEDOUT` or `compilation timeout
(~15 s)`. Every one was already non-pass on base. The single row the diff called
a NEW non-pass — `Reflect/getPrototypeOf/target-is-symbol-throws.js`,
`compile_error compilation timeout (15286.83 ms)` — was **re-run alone on the
lane and PASSES** (`{ pass: 1 }`). `Reflect.getPrototypeOf` is untouched by this
change-set.

**Rows given up, honestly.** The 222-row function-metadata control set was NOT
run on either tree inside this session's budget (isolate mode costs ~15 s/row on
this box and the two trees double it). It is unmeasured here, not
measured-and-clean — and it is the set that would most directly exercise the F5
revoker field rename, whose evidence therefore rests on the four `revocable/`
rows above, `p/meta*`/`p/tof` probes and the `__sget_proxy` disappearance.

## Handover (2026-09-04, session claude/es6-test262-standalone-g10c7u)

**State.** r3 pass implemented by an Opus-medium lane in
`.claude/worktrees/wf_16f0b7f5-bf0-3` (branch `worktree-wf_16f0b7f5-bf0-3`,
merge-base `4fa179f85f`): R3-0 (a real proxy from the Proxy constructor
VALUE), R3-2 C4+C5 (Reflect target guards + ToPropertyKey at the call site),
R3-4 (first-class revocation function), R3-3 E-2 (one-argument
`Object.getOwnPropertyDescriptor`), then an adversarial review (HOLD, ten
findings) and one Opus-medium fix round — `366d0e0be3` fixes F1–F6,
`e06f6838b0` records the measurement. Final row table, `--isolate`, base vs
lane: 523 rows, **362 → 382 pass, zero rows lost** (Reflect/** 122 → 126;
Proxy/** slices +1/+6/+5/+2/+2/0; new/ + revocable/ 56 → 56).

**Fixed in the review round.** F1 `var P = Proxy; P = K; new P()` — the
alias hop is taken only under `isSingleAssignmentBinding` (one plain
initialised declarator, `const` or never written in-file). F2 the
`Reflect.get`/`has` target guard rejects only positively-branded primitives
and admits unrecognised shapes (`emitNativeReflectNonObjectGuard`; the six
guard sites inherited from main keep the stricter emitter). F3 the revoker
non-constructable classification needs the same single-assignment proof.
F4 `var R = Proxy.revocable; R(t, {get(){…}})` — a trap became node parity
(`FIXED_ARITY_PLAIN_ALIAS_STATICS` + object-literal arguments compiled as
externref). F5 the revoker carrier's fields are `__`-prefixed and hidden.
F6 the one-arg gOPD block declines a spread. Corrected in the write-up: the
"byte-inert unless a `Proxy.revocable` site compiled" claim is false
(+358 B on a Proxy-free program; measured table in the round-3 section).

**Open, recorded — read before touching this area.**
- **F9 (WASI only, arrived with R3-2 `747c88c75b`)**:
  `Reflect.defineProperty(o, key, desc)` with an ORDINARY OBJECT key traps
  `illegal cast` on `--target wasi` where main refused to compile the
  3-arg form. The trap is in the shared applier `emitDefinePropertyDescRuntime`
  — `Object.defineProperty(o, <object key>, …)` traps identically on both
  trees on WASI — reached through the new arm; on standalone the same call
  is node parity. The one-line option (decline the 3-arg arm for a
  non-primitive key on WASI) trades a real standalone win for main's compile
  refusal and leaves the applier bug in place; it was deliberately not taken.
  Owner: the applier's WASI path.
- F7: a caught one-arg gOPD TypeError on a revoked proxy disarms a later
  two-arg TypeError — base could not compile the one-arg form, so not worse
  than base; mechanism unidentified.
- The 222-row function-metadata control set was never run on either tree
  (F5's evidence is the revocable/ rows, the meta/tof probes and the
  disappearance of the synthetic getter).
- `Reflect.has(undefined, "x")` answers false (base parity) — `undefined`
  is deliberately unbranded because ordinary objects nulled by the
  pre-existing array-widening defect would otherwise throw.
- Not started: R3-1 (§10.5 invariants, 29 rows + 6), R3-5 (open
  representation for a proxy TARGET literal, 5), R3-3 E-1 (`$Proxy` front
  guard in `__defineProperty_*` — needs the ~1,750-row floor on both trees),
  the R3-2 residue (C1 Reflect.set bypass, C2/C3 booleans, C6 ownKeys order).

**Merge-group wedge, found and fixed after the PR went green
(2026-09-04, PR #5576, run 33867389640).** The first `identifierIsWrittenTo`
widening (F1/F3) used plain containment for the assignment's left side, so
`X.prop = v`, `X.prop++` and `X[k] = v` counted as writes to X. Every
test262 row carries `Test262Error.prototype.toString = …` (sta.js), so
`Test262Error` read as reassigned in every file and the `new` fold declined
everywhere; on `language/module-code/namespace/internals/is-extensible.js`
(a module importing itself as a namespace) the dynamic fallback
(`__fnctor_Test262Error_new` → `__instanceof_dynamic` → `__hasOwnProperty` →
`__str_equals`, per `--prof`) spun forever. Fixture-graph rows execute
IN-PROCESS in the vitest fork (`tests/test262-shared.ts`, "fixture tests are
rare"), outside the compiler pool's 30 s kill, so one such row wedges its
whole shard: 27 of 50 standalone shards hit the 40-minute job cap, twice,
with the same shard set (deterministic); the PR-level checks cannot see it
(no shard matrix on `pull_request`), and the pre-PR 1,200-row sample could
not either (the row is a baseline `fail`). Fix: the scan now requires the
identifier to reach the assignment target through PATTERN nodes only
(`isBindingWritePath`), i.e. the pre-widening semantics plus the intended
destructuring / for-in-of / default-value targets; a 30-case truth table is
in the fix commit's probe. Still open, pre-existing: the dynamic
`instanceof` chain walk itself loops on that namespace object — base never
reaches it because its fold holds; whoever lifts the fold for a legitimately
reassigned constructor will hit it.

**Validation** is on the combined session-branch tree (see the PR).

