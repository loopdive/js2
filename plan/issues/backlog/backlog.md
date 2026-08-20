# Backlog index

Lightweight pointer index for unscheduled issues that need sprint candidacy. Authoritative status lives in each issue file's frontmatter.

## 2026-08-20 — Node API compatibility and provider hardening

- [#4567](../4567-node-builtins-provider-explicit-fail-closed.md) — replace the
  gap between recognized `node:*` modules and runnable members with one
  provider-explicit registry; unavailable and unknown members fail before
  emission instead of becoming null, empty, or undefined placeholders.
- [#4568](../4568-node-path-posix-win32-provider-parity.md) — complete POSIX and
  Win32 path semantics through a portable `node:path` provider, including
  namespace objects, parse/format, target policy, and an explicit cwd
  dependency.
- [#4569](../4569-node-crypto-secure-provider-only.md) — remove insecure
  randomness degradation and require Node crypto, Web Crypto, WASI
  `random_get`, or another explicitly injected secure provider.
- [#4570](../4570-node-fs-shared-validation-error-contract.md) — centralize the
  observable filesystem contract so JS-host and WASI providers agree on
  validation, first-error ordering, stable error fields, and async settlement.
- [#4571](../4571-wasi-preopen-node-fs-provider.md) — implement the bounded
  path-based `node:fs`/`node:fs/promises` surface as a linkable WASI-preopen
  provider without ambient access or implementation-specific import names.
- [#4572](../4572-portable-node-utility-provider-tranche.md) — measure and
  implement a portable utility tranche covering assert, querystring,
  incremental string decoding, and a bounded pure `node:util` subset.
- [#2512](../2512-node-host-apis-as-separate-linkable-wasm-modules.md) — make
  standard `node:<module>`/real-member imports the stable interface and link
  only the provider families proven used by prepared IR.
- [#4419](../4419-compilefiles-drops-node-builtin-bindings.md) — restore the
  missing `compileFiles` binding path first and test every import shape/compiler
  entry point against both supported and unavailable members.

“Compiler-derived capability manifest and per-program explain workflow” (#4382)
and “Differential whole-program target matrix” (#3681) gain
Node-member/provider projections and contract fixtures; they remain indexed in
the architecture section below. Recommended order: the `compileFiles` binding
repair (#4419), provider-explicit registry (#4567), secure crypto provider
(#4569), shared filesystem contract (#4570), link-on-demand module interface
(#2512), then path/WASI-filesystem/utility providers (#4568/#4571/#4572).
Networking and stream expansion stays deferred until the shared async scheduler
has an explicit, measured callback-order contract.

## 2026-08-12 — Compiler capability, diagnostics, and portability hardening

- [#3518](../3518-ir-only-default-and-direct-frontend-retirement.md) and
  [#3521](../3521-ir-r2-prepared-program-free-function-compile-once.md) — make
  one versioned, validated, losslessly serializable `PreparedIrProgram` the
  sole frontend-to-backend handoff; backend inability must fail typed before
  emission rather than reparse, reselect, or fall back.
- [#3678](../3678-ir-rejection-diagnostics-error-codes.md) — replace internal
  reason strings with stable project codes, source frames, typed categories,
  JSON diagnostics, and actionable remediation shared by compiler and tooling.
- [#4382](../4382-compiler-capability-manifest-explain-workflow.md) — project
  production compiler decisions into an explicit capability schema and a
  coherent `build`/`run`/`explain` workflow, with visible `unknown` results and
  generated documentation rather than hand-maintained support claims.
- [#3681](../3681-differential-whole-program-corpus-testing.md) — extend the
  existing differential harness across JS-host, standalone/WASI, and linear
  lanes, comparing stdout, stderr, exit/error behavior, and observable exports
  with explicit denominators and owned divergences.
- [#2514](../2514-runtime-helpers-as-shared-linkable-module.md) — factor stable
  runtime families into feature-granular, link-gated core-Wasm providers whose
  ABI/version and capability requirements are selected by the frozen runtime
  manifest; keep inline providers until measurements justify promotion.

Recommended dependency order: prepared-program/semantic-manifest ownership
(#3518/#3521/#3526), stable diagnostics (#3678), public capability projection
(#4382), target-matrix promotion (#3681), then broader linked-provider rollout
(#2514). Differential corpus and ABI experiments can proceed in bounded slices
while the earlier architectural gates remain active.

## 2026-08-12 — Deno primordials bootstrap

- [#4378](../4378-deno-primordials-array-prototype-iterator.md) — let the
  unchanged Deno bootstrap capture `%ArrayIteratorPrototype%` from the pristine
  `Array.prototype` through js2wasm's host-free iterator substrate.
- [#4380](../4380-empty-object-widening-iife-body.md) — make the empty-object
  widening prepass enter arrow/function-expression IIFEs before Deno initializes
  its primordials object.

## 2026-08-11 — Jest accessor descriptor import

- [#4367](../4367-jest-parenthesized-accessor-descriptor-import.md) — unwrap
  transparent parentheses/type wrappers before the accessor-descriptor import
  pre-pass decides whether Jest's Webpack export getters need the
  `__make_getter_callback` bridge.

## 2026-08-09 — Prepared provider transaction rollback

- [#4260](../4260-prepared-provider-plans-leak-across-aborted-component-seal.md)
  — make blocking callable-provider and import plans commit or abort with their
  prepared component, so a failed seal cannot leave a stale
  `__new_ReferenceError` reservation or an unplanned direct fallback.

## 2026-08-09 — ES2015 TypedArray native-prototype reads

- [#2375](../2375-typedarray-nativeproto-value-read-init-trap.md) — add the
  missing IR/runtime `$NativeProto` arm for dynamic method-valued reads. The
  first exact cohort is 48 host-pass/standalone-fail invalid-receiver files;
  the frozen 125-file exposure set remains a layered rerun, not a promised
  125-pass slice.

## 2026-08-09 — ES2015 class accessor IR writeback (done)

- [#4259](../4259-es2015-class-accessor-outer-binding-writeback-ir.md) —
  **Done:** prepared IR owns the bounded class declaration/expression getter and
  setter bodies, and exact class-root writes reach them during module init. On
  the frozen 84-file set, all 72 positives now pass in each lane; the 12
  computed-error controls remain unchanged.

## 2026-07-29 — npm standalone versus JS-host performance lanes

- [#3781](../3781-npm-perf-standalone-js-host-lanes.md) — split every npm
  performance result into a host-free standalone lane, where the package and
  benchmark driver are compiled into Wasm together, and a JS-host lane, where
  Node owns inputs, the repeated-call loop, result observation, and assertions.
  Unsupported standalone packages remain visible as explicit failure rows.
- [#3782](../3782-acorn-linked-standalone-module-start.md) — Acorn's
  linked standalone graph now compiles to a valid 1.67 MB zero-import binary,
  after #3781 removed a left-deep synthetic string-concat chain, but the module
  still throws during start-function initialization. Isolate the token/prototype/
  regexp/table initializer and restore a real standalone timing.

## 2026-07-29 — Acorn Wasm performance (in progress)

- [#3780](../3780-acorn-wasm-faster-than-node.md) — make the real pinned
  parameterized `acorn@8.16.0 parse(source, options)` self-host operation faster
  in optimized Wasm than native Node, while retaining exact AST behavior for
  changed sources and options. Export-result caching is excluded from official
  timings. Corrected result: 1,279,410.541 µs Wasm versus 4,323.208 µs Node
  (295.94x Node advantage), with 3,507/3,518 unchanged.

## 2026-07-29 — cookie Wasm performance (in progress)

- [#3779](../3779-cookie-wasm-faster-than-node.md) — make the real pinned
  parameterized `cookie@2.0.1 parseCookie(header)` operation faster in optimized
  Wasm than native Node. Export-result caching is excluded from official
  timings. Corrected result: 143.1675 µs Wasm versus 0.2631 µs Node (544.13x
  Node advantage), with the existing 18/21 correctness surface unchanged.

## 2026-07-29 — clsx Wasm performance

- [#3778](../3778-clsx-wasm-faster-than-node.md) — make the real pinned
  `clsx@2.1.1` hot operation faster compiled to optimized Wasm than the same
  package running natively in Node. **Done:** the official nine-round rerun is
  0.0106524 µs Wasm versus 0.0492999 µs Node (**4.6281x faster**), with the
  existing 17/18 correctness result unchanged. A bounded pure-subset partial
  evaluator removes all 112 inner host crossings from the closed hot export;
  `pnpm run benchmark:clsx` provides the focused non-writing setup.

## 2026-07-26 — compiled Acorn full-Test262 differential follow-ups

The #1712 acceptance branch compares pinned compiled Acorn 8.16.0 against
node-acorn on every Git-tracked Test262 JavaScript parser input, including exact
positions and Test262 strict/module variants. The clean published-head
four-shard result is **53,259/53,259 exact files** and
**102,312/102,312 exact variants**, with zero mismatches. Recursive
Wasm→host→Wasm prototype-method dispatch is stack-flat, dynamic indexed and
nested-vec mutations update the live compiled backing, lexical early errors
preserve null sentinels, and arbitrary-width BigInt literals remain exact.
[#2802](../2802-nested-any-vec-multipush-join-first-element-drop.md) and
[#2846](../2846-acorn-bigint-literal-corrupted-to-f64.md) are completed under
the #1712 umbrella; no parser-fidelity residual remains in this census.

## 2026-07-26 — TypeScript frontend incremental reuse

- [#700](../700-superseded-reuse-typescript-host-state.md) — **in review,
  PRs #3645 / #3650**: replace per-build TypeScript Program/checker construction
  with persistent single- and multi-file Language Services. Measured edited
  single-file rebuilds improve 2.2–2.6× and unchanged rebuilds 4.1–6.2×, with
  Program invalidation, cross-service isolation, JS byte parity, 100-source
  sequential isolation, and Test262 fixture-graph reuse covered by focused
  tests.

## 2026-07-26 — Test262 linked-harness implementation

- [#3451](../3451-linked-harness-wasm-separate-compilation.md) — **in progress,
  high priority, hard, XL.** Slice 1 now provides the deterministic
  strict-neutral harness/body split, target-specific content keys, and a
  maintained-corpus inventory: 64 harness sources / 128 target objects versus
  82,628 potential harness-bearing variants per lane, with 82,660 authoritative
  split-parity checks. Next is the two-target `assert.sameValue` linked smoke,
  gated on WasmGC/shared-realm linker substrate.

## 2026-07-17 - /harvest-errors (baselines run 20260717-151504, 32,139 pass)

Harvested both lanes (default JS-host + standalone) from
`loopdive/js2wasm-baselines`. One new >50 pattern filed; all other top
patterns map to existing tracked issues.

- [#3371](../3371-standalone-reflect-construct-newtarget.md) - standalone
  `Reflect.construct` (with NewTarget) refused, **160 tests**, 0 in the default
  lane. #1905 explicitly left construct out of scope; the refusal self-cites the
  closed #1472, so there was no dedicated tracking issue. `goal: standalone-mode`,
  umbrella #1781, builds on #3240.

No other new issues warranted: the standalone host-import-leak cluster (5,715
records citing #2961) is tracked under umbrella #3178 / #2864 / #2865 / #2867
(in-progress); the default-lane vacuous async-callback cluster is #3227
(in-progress) and **shrank** to 346 (from ~1,100 at the 2026-07-13 harvest) —
active progress, not a regression. BigInt-TypedArray null-access (174 default /
510 standalone) → #2939/#3089; ShadowRealm (61/58) → #1356; `with` (67) → #1387;
Proxy standalone (374) → #1355; `Object.defineProperties` residual descriptor
shapes (73) are #1906's deliberate fail-loud tail.

## 2026-07-17 - Current `origin/main` PO audit (verified high-leverage gaps)

Audit scope: current `origin/main` after fetch, existing `plan/issues`, sprint
files, open PRs, TODO/FIXME markers, tests, CI scripts, backend contracts, and
recent backend-architecture areas. Filed only non-duplicate, independently
dispatchable gaps:

- [#3336](../3336-linear-memory-plan-target-neutral-ownership.md) - planning:
  make `LinearMemoryPlan` ownership target-neutral before dispatch. Highest
  architecture value because the prose invariant already exists, but canonical
  issue titles/sprints still route target-neutral planner work through the
  Porffor backend wave.
- [#3337](../3337-wasi-process-argv-args-get.md) - WASI `process.argv` must
  materialize through `args_get` instead of silently returning an empty,
  import-free vector. A second-pass runtime probe corrected the original
  invalid-binary premise: validity is fixed, argv semantics are not.
- [#3338](../3338-cli-refuse-invalid-wasm-artifacts.md) - CLI must validate the
  final binary before writing any artifacts. Verified in both default `-O3` and
  `--no-optimize`: the CLI exits zero and writes the same invalid private-field
  module; #3024 owns the producer, not this systemic publication boundary.
- [#3339](../3339-compileproject-axios-core-oom.md) - bound `compileProject`
  graph expansion on Axios core. The current probe exhausts a 512 MB heap after
  about 85 seconds, blocking four Tier 1 entries; architect phase attribution
  is required before implementation.
- [#3340](../3340-issue-tests-unexpected-pass-baseline.md) - keep inverted
  expected-failure sentinels out of the root issue-test baseline. Two #2143
  programs now validate and the WASI validity check now passes, but all three
  improvements are stored as accepted failures because the gate has no
  unexpected-pass class.

Investigated, no new issue filed: cross-backend parity as a required advisory
gate is already owned by #2711; the linear-IR overlay ratchet and flag-on
coverage are active in #2956 (PR #3200 has landed for the L2 aggregate/ref-cell
slice, with later slices still tracked there), so a separate gate-hardening
issue would duplicate current work.

The stronger-model second pass also rechecked CLI emission, Axios Tier 1,
root-suite baseline semantics, current test262 categories, and active PRs. It
did not file separate issues for producer-specific invalid Wasm, Axios
validator sub-buckets, or full root-suite required gating because #3024,
#1571's other proposed blockers, and #3008 already own those scopes.

## 2026-07-03 — `/harvest-errors` sweep (both lanes, fresh baselines)

Default lane (`test262-current.jsonl`, run `20260703-092808`, gitHash
`51622ba2`): 31,878/43,106 official pass (73.9%). Standalone lane
(`test262-standalone-current.jsonl`, same-day run): 24,915/43,136 official
pass (57.8%). Full harvest cross-referenced embedded `#NNNN` error citations

- sub-bucketed uncited "other" failures against `plan/issues/`. Filed
  `sprint: current`, `status: ready`:

* [#3021](../3021-class-elements-static-private-field-placement-residual.md) — class elements: static/private field & method placement residual (~1,522 default-lane fails) — high, horizon L. Residual after #1047/#1144/#1226/#1348/#1364/#1365/#1591/#1643 each closed a narrower slice.
* [#3022](../3022-defineproperty-descriptor-fidelity-tail-residual.md) — Object.defineProperty(ies) descriptor fidelity tail + non-object receiver arm (~728 default-lane fails) — high, horizon M. Tail after #1334/#1629 ("biggest single bucket" at the time).
* [#3023](../3023-iterator-protocol-forof-abrupt-completion-residual.md) — iterator protocol: `.next` callability + for-of/for-await abrupt-completion residual (~508 default-lane fails) — high, horizon M. Coordinate with #2669 (shared `for-of/dstr` surface).
* [#3024](../3024-invalid-wasm-default-lane-emitter-residual.md) — invalid Wasm binary emission residual, **default `gc` target** (~131 fails) — high, horizon M. Distinct from the several standalone-target invalid-Wasm issues (#2039/#2878/#2934).
* [#3025](../3025-with-statement-closed-shape-residual.md) — `with` statement closed-object-literal-shape residual (~167 default-lane fails) — medium, horizon S. Tail after #1387.
* [#3026](../3026-negative-test-fail-early-error-gaps-jul03.md) — residual `negative_test_fail` early-error/static-semantics gaps (~79 default-lane, 64 unenforced SyntaxErrors) — medium, horizon S. Same whack-a-mole pattern as #927/#1091/#1435/#1805/#1931/#2912/#2920.
* [#3027](../3027-standalone-dynamic-object-property-reader-residual.md) — standalone: `$Object` dynamic-object-property reader residual — null/undefined reads on unmodeled shapes (~1,552 host-free fails) — high, horizon L, umbrella #2860. This is the umbrella's own promised "not-yet-issued follow-on" (`$Object` dynamic-object-property reader, previously estimated ~669), re-measured larger now that #2861/#2863 have landed.

Updated (not new): [#1524](../1524-test262-harness-resizable-buffer-ctors-fixture.md) — `ctors is not defined` harness-fixture scoping bug, confirmed firing in **both** lanes (259 default + 175 standalone = 434 combined); still `feasibility: easy`, still `backlog` — flagged as a strong promotion candidate (cheap, well-scoped, cross-lane win).

Investigated, no new issue needed: #2940's default-lane 1,496-record "vacuous harness-wrapper callback" tag is the **intended** honest reclassification (not a regression) — already tracked for policy ratchet by #3001/#3004. Most standalone-lane uncited patterns (`Cannot convert object to primitive`, `illegal cast` in iterator dstr, `Property description must be an object`, etc.) map cleanly onto existing open issues (#1900/#2733/#2042/#2864/#2875) — counts noted in harvest, no duplicates filed.

## 2026-07-21 — IR-only default and direct-front-end retirement (current priority)

The explicit completion directive supersedes the June 30 demotion of IR work.
The active program is
[#3518](../3518-ir-only-default-and-direct-frontend-retirement.md), a staged
prepare-before-emit migration that remains **in-progress**, rather than another
fallback-count sweep:

- [#3529](../3529-ir-r0-typed-producer-equivalence-parity.md) — **done
  2026-07-21**: restored full-equivalence parity at 1,608 passing / 35 failing
  against 36 committed known failures. One baseline-known case now passes,
  there are zero new regressions, and the baseline is unchanged.
- [#3519](../3519-ir-only-typed-outcomes-and-honest-gate.md) — **done
  2026-07-21**: landed typed emitted/Unsupported/Invariant outcomes and the
  honest gate. Hybrid is green at 5/5 entries, 37 terminal units, 31 emitted IR
  bodies, 6 Unsupported, 0 Invariants, and 37 legacy bodies; strict is
  intentionally red on the six typed blockers plus legacy emission.
- [#3520](../3520-ir-r1-source-qualified-identity-program-abi.md) — **ready,
  critical, current**: R1 source-qualified identities and whole-program ABI;
  this is the next executable retirement slice.
- [#3521](../3521-ir-r2-prepared-program-free-function-compile-once.md) —
  **blocked, critical, current**: R2 Prepared-program ownership and compile-once
  top-level free functions; depends on #3520.
- [#3522](../3522-ir-r3-classes-closures-compile-once.md) — **blocked,
  critical, current**: R3 exhaustive classes/members/closures and support-unit
  ownership; depends on #3521.
- [#3523](../3523-ir-r4-module-init-compile-once.md) — **blocked, critical,
  current**: R4 typed ordered module-init and exactly-once startup; depends on
  #3521 and #3522.
- [#3525](../3525-ir-r5-whole-program-multi-source-ownership.md) — **blocked,
  critical, current**: R5 one Prepared owner/ABI/init plan across single- and
  multi-source/M0; depends on #3520–#3523.
- [#3526](../3526-ir-r6-semantic-runtime-contract.md) — **blocked, critical,
  current**: R6 typed intrinsic/runtime-feature/host-capability contract,
  pre-lowering manifest freeze, and measured provider-family slices; depends
  on #3521.
- [#3527](../3527-ir-r7-ast-free-async-plan.md) — **blocked, critical,
  current**: R7 AST-free suspension plans and canonical async ABI through the
  existing frame engine; depends on #3522, #3525, and #3526.
- [#3528](../3528-ir-r8-shared-linear-prepared-program.md) — **blocked,
  critical, current**: R8 linear consumption of the exact shared Prepared
  program with zero direct AST lowering; depends on #3525–#3527.
- [#3090](../3090-shrink-codegen-delete-dormant-legacy-handlers.md) — blocked
  R10 deletion ledger. The remaining ~59,676 frontend fn-lines are still
  reachable and may be deleted only after #3518 R9.
- [#2950](../2950-ir-first-default-flip-retire-compile-twice.md) — completed
  historical default-flip milestone; its undelivered retirement scope moved to
  #3518.
- [#3142](../3142-ir-module-level-statement-adoption.md) — completed
  module-init claim/patch milestone; compile-once module ownership remains R4.

The earlier corpus-ratchet epic
[#2855](../2855-ir-frontend-migration-ratchet-buckets-to-zero.md) is now closed
as the narrow function-level milestone. Its children are complete:

- [#2856](../2856-ir-body-shape-rejected-to-zero.md) — `body-shape-rejected` 31 → 0 — **done 2026-07-21**.
- [#2857](../2857-ir-class-method-residual-to-zero.md) — `class-method` 6 → 0 — done.
- [#2858](../2858-ir-call-graph-closure-to-zero.md) — `call-graph-closure` 7 → 0 — done.
- [#2859](../2859-ir-param-type-not-resolvable-to-zero.md) — `param-type-not-resolvable` 1 → 0 — done.

The final R0 lane records six typed Unsupported units: `async-function` (2),
`call-graph-closure` (1), `body-shape` (1), and static class members (2).
Corpus-zero reasons remain non-strict until their source-language coverage is
genuinely complete. Classes, module init, M0, linear, runtime entry points,
fail-closed defaulting, and reachability deletion remain separate structural
gates under #3518.

## 2026-06-23 — Sprint-65 value-rep substrate landings (session)

Architecture-spine slices that merged this session (0-regr vs `merge_group`
floor #2097). They **advance** their parent epics — none close them, so the
parents remain carried to s66 (see `plan/issues/sprints/65.md` carry-over):

- [#2580](../2580-dynamic-receiver-length-undefined-substrate.md) M3 Stage A (PR #1975) — standalone inline-literal `[[Prototype]]` link; M3 B-pre `__is_truthy` desync fix open as PR #1986 (BLOCKED).
- #2623 (PR #1977) — class-extends-Promise value-read identity unified (+1 row); feeds Promise epic #1042/#2614/promise-async-capability-residual.
- #2623-A (PR #1981) — async-closure `alreadyBoxed` capture box-depth; feeds async epic #1042.
- [#2637](../2637-promise-subclass-executor-body-protocol.md) — NEW architecture epic: the #2623 executor-body half (ctx-ctor asserts #3/#4), VERIFIED not-bounded with WAT evidence (PR #1996). `__promise_subclass_ctor ↔ <Sub>_new ↔ NewPromiseCapability` protocol re-architecture, B1→B2 sequenced; route to architect, not a dev slice.
- [#2618](../2618-proxy-host-apply-construct-call-path.md) Slice 1 (PR #1984) — Proxy START-timing + callable-target wrap, apply/construct 14→15; Slice C confirmed DEFER (#56-zone); feeds Proxy epic #1355.

**Corrected M3 sequencing** (supersedes the "168-row functor lap" framing):
accessor cluster (`Object.defineProperty`, 181/266 files) first → functor
`.prototype=` lap (51 files, escape-analysis-gated, #1888-eject risk) last.

## 2026-06-19 — Sprint-64 conformance-pool refill (PO standalone failure mining)

Mined current standalone test262 failures (`.test262-cache/test262-standalone-current.jsonl`)
for fresh dev-claimable conformance slices that are **independent of the
in-progress standalone epics** (#2175 builtin-prototype readers, #2158/#2159/#2101
class/TA descriptors, #2036 array generics, #2042 defineProperty, #2039 invalid-Wasm,
ToPrimitive value-rep, BigInt #2044) and not deferred (async-gen/Proxy/eval/Temporal).
All four also fail in JS-host, so devs can validate without standalone-only setup.
Filed `sprint: 64`, `status: ready`:

- [#2200](../2200-annexb-block-level-function-hoisting.md) — Annex B B.3.3 block-level function hoisting (~186) — medium, **highest impact**
- [#2203](../2203-array-destructuring-elision-default-miscount.md) — array destructuring elision + default miscount (~54 standalone CE) — medium
- [#2202](../2202-arguments-trailing-comma-spread-generator-method.md) — `arguments.length` for trailing-comma+spread in generator methods (~30) — medium
- [#2201](../2201-logical-assignment-named-evaluation.md) — logical-assignment NamedEvaluation `fn.name` (~9) — easy/XS

## Sprint-61 merged-PR code review (2026-06-10)

Static review of all 24 sprint-61 merged PRs (9 issues). #1909/#1910/#1902/#2177
clean; #1832 fix correct (test-only PR); the rest produced these follow-ups.
Also backfilled `status: done` on the 7 merged-but-in-review issues
(#1832, #1886, #1904, #1905, #1907, #1909, #1910).

- [#2045](../2045-linear-uint8-soundness-holes.md) — linear Uint8Array silent-corruption holes: name-keyed scope-blind buffer registry, no bounds checks on linear element access; + escape-analysis demotion gaps that fail valid WASI programs (#1886 follow-up) — critical, medium, **ready (backlog)**.
- [#2046](../2046-standalone-reflect-spec-gaps.md) — standalone Reflect: receiver arg silently dropped (wrong `this` for accessors), deleteProperty deletes frozen props and returns true, no ToPropertyKey (#1905 follow-up) — high, medium, **ready (backlog)**.
- [#2047](../2047-unify-standalone-isarray-predicate.md) — unify standalone Array.isArray: live #1907 snapshot predicate diverges from direct calls; #1904's native finalize-filled helper is dead code; both misclassify ArrayBuffer/TypedArray carriers — high, medium, **ready (backlog)**.
- [#2048](../2048-post-merge-issue-status-automation.md) — process: automate merged-PR ⇒ `status: done` flip; stale in-review issues caused 17/24 doc-churn PRs and merge-queue thrash in sprint 61 — medium, easy, **ready (backlog)**.

## Standalone 38%→71% gap review (2026-06-10)

Full standalone-vs-host baseline diff (2026-06-10 `test262-standalone-current.jsonl`
vs `test262-current.jsonl` from `loopdive/js2wasm-baselines`): standalone is at
**16,405/43,106 official (38.1%)** vs host **30,797/43,106 (71.4%)** — a gap of
15,480 rows that pass host but not standalone (8,124 compile_error + 7,356 fail).
Already-owned buckets: built-in static property reads 3,587 (#1907/#1888 S6-b),
ToPrimitive 1,292 (#1910), RegExp ~1,190 (#1911–#1914), `__get_builtin`/
`__defineProperty_desc` refusals 453 (#1472/#1888), borrowed-`.call` refusals
~250 (#1888 S3/S4), Proxy/Reflect.construct ~180 (#1100/#1888 Phase C), direct
eval ~180 (#1066). New issues for the unowned remainder (all repro-confirmed on
main @ 936d1ac51):

- [#2029](../2029-standalone-u32-out-of-range-binary-emit.md) — `Binary emit error: u32 out of range: -1` on builtin subclassing / await-using / Object.create / Iterator.prototype (497 tests; minimal repro `class A extends Uint8Array {}`) — critical, medium, **ready (backlog)**.
- [#2036](../2036-standalone-array-generics-arraylike-invalid-wasm.md) — Array.prototype generics over array-like receivers: invalid Wasm + null-deref + silently wrong results instead of loud refusal (~500 tests) — high, medium, **ready (backlog)**.
- [#2037](../2037-standalone-fn-name-destructuring-defaults.md) — NamedEvaluation `.name` wrong for destructuring-default-bound functions (683 tests) — high, medium, **ready (backlog)**.
- [#2038](../2038-standalone-iterator-next-illegal-cast-async-dstr.md) — `illegal cast` in `__iterator_next` / async destructuring & `yield*` (~470 tests) — high, medium, **ready (backlog)**.
- [#2039](../2039-standalone-invalid-wasm-residual-bucket.md) — invalid-Wasm residual bucket post-#1623/#1666/#1677, split by validator signature (async-gen i64 ABI, `__obj_find` externref key, `__str_flatten`, arguments arity; ~1,135 tests) — critical, hard, **ready (backlog)**.
- [#2040](../2040-standalone-generator-dstr-runtime-semantics.md) — generator/destructuring runtime semantics: rest-pattern aliasing, lazy defaults, private generator methods (~1,750 tests) — critical, hard, **ready (backlog)**.
- [#2041](../2041-standalone-temporal-null-deref-bucket.md) — Temporal compiles then traps with opaque null deref; needs fail-loud refusal + classifier bucket (544 tests) — medium, medium, **ready (backlog)**.
- [#2042](../2042-standalone-defineproperty-descriptor-semantics.md) — defineProperty/defineProperties: `__obj_insert` illegal cast + ValidateAndApply descriptor semantics (~340 tests) — high, medium, **ready (backlog)**.
- [#2503](../2503-standalone-toprimitive-operator-receiver-residual.md) — ToPrimitive residual (successor to #1910): `Cannot convert object to primitive value` on `==`/`+`/array-literal/destructuring object receivers; grew 784→1,292→**2,835**, now the largest standalone runtime bucket and untracked (all #1910 owners done) — critical, hard, **ready (backlog)** _(2026-06-19 harvest, run e9579720)_.

Unfiled smaller residuals (classified, for later splitting): DataView abrupt/OOB
closures ~204, String.prototype runtime ~180, Set.prototype ~124, Number/Date
formatting ~110 — mostly downstream of #1907/#1910/#1888 slices; re-measure
after those land.

### Fable-tier issues (2026-06-10)

`model: fable` frontmatter marks issues whose spec/decision work should run on
Claude Fable 5 (spawn the architect/senior-dev with `model: "fable"`); the
implementation slices they produce stay Opus-tier. Annotated: #1888, #2029,
#2039, #1851, #1852, plus two new decision issues:

- [#2043](../2043-retire-late-import-index-shift-class.md) — retire the late-import function-index-shift bug class structurally (always-on total emit-time index validation + stale-proof func references); 6th+ recurrence as #2029 — high, hard, **ready (backlog)**.
- [#2044](../2044-bigint-i64-brand-valtype-decision.md) — architect decision: BigInt i64-bigint-brand ValType vs TS-type-driven boxing; gates #1644 slices, must attribute the #2039 i64/extern.convert_any bucket — high, hard, **ready (backlog)**.

## RegExp residual split (2026-06-07)

The standalone RegExp residual bucket was split under #1909 so the report no
longer points the whole cluster at completed umbrellas:

- [#1909](../1909-standalone-regexp-residual-bucket.md) — residual standalone
  RegExp bucket split/fix, in review.
- [#1911](../1911-standalone-regexp-phase-2d-unicode-lookaround.md) —
  standalone RegExp Phase 2d: `u/v/d`, Unicode, lookaround, modifiers.
- [#1912](../1912-standalone-regexp-phase-2b-boundaries-backrefs-classes.md) —
  standalone RegExp Phase 2b: boundaries, backrefs, class compatibility.
- [#1913](../1913-standalone-regexp-string-protocol-lastindex.md) —
  standalone RegExp string protocol, `matchAll`, split/replace, lastIndex.
- [#1914](../1914-standalone-regexp-native-engine-reflection-result-shape.md) —
  standalone RegExp native-engine reflection and result-shape gaps.

## Harvest re-run 2026-06-04 (post sprint-58/59 merge)

Re-ran `/harvest-errors` after pulling 346 commits. Both prior-harvest issues are genuinely fixed (#1809 shift-walker 157→0; #1808 emit crash per-file clean). One baseline-accounting follow-up filed:

- [#1862](../1862-residual-poison-burst-binary-emit-still-in-baseline.md) — residual poisoned-worker `Binary emit error` burst still in the published baseline (~269, barely down from 291) despite #1808's blast-radius cap; either the cap is incomplete or `promote-baseline` carried the entries forward without re-running. Over-counts the failure set by ~0.6%. medium, medium, **ready (backlog)**. Follow-up to #1808; ties to #1080 drift umbrella.

## Sprint 57 — acorn dogfood + backend-agnostic IR (2026-05-29)

Architectural sprint (no pass-count target; zero-regression guard). Goals:
[`self-hosting-dogfood`](../../goals/self-hosting-dogfood.md),
[`backend-agnostic-ir`](../../goals/backend-agnostic-ir.md). Plan:
[sprints/57.md](../sprints/57.md).

Track 1 — acorn dogfood:

- [#1710](../1710-acorn-dogfood-harness.md) — acorn harness: compile + validate + diff-AST vs node-acorn — high, medium, **ready (s57)**.
- [#1711](../1711-acorn-failure-surface-triage.md) — triage harness surface → file sized child issues — high, medium, **ready (s57)**, depends on #1710.
- [#1712](../1712-acorn-acceptance-differential-ast.md) — acceptance: compiled acorn AST == node-acorn — high, hard, **carried to sprint 59** (#1710/#1711 done; unblocked by #1745).
- Prior blockers #1679/#1690/#1690b are **done**.

Track 2 — backend-agnostic IR (all need architect spec; #1713 blocking):

- [#1713](../1713-ir-backend-emitter-trait-seam.md) — BackendEmitter trait + WasmGC bias audit + WasmGcEmitter (pure refactor, zero conformance delta) — high, hard, **ready (s57), needs arch spec**.
- [#1714](../1714-ir-two-backend-proof-linear.md) — lower one IR node kind to BOTH WasmGC + linear via the trait (primary proof) — high, hard, **backlog→ready** after #1713.
- [#1715](../1715-ir-bytecode-proof-point.md) — minimal bytecode emitter + dispatch loop for an IR subset (stretch proof) — medium, hard, **backlog→ready** after #1713.
- Feeds [#1584](../1584-wasm-gc-native-interpreter.md) (in-Wasm bytecode interpreter) — gated on both tracks + #1712.

## Standalone (--target wasi) host-import audit (2026-05-25) — goal `standalone-mode`

Empirical per-construct audit of remaining JS-host (`env.*`) leaks under `--target wasi`. Audit record: [#1662](../1662-standalone-host-import-audit.md) (done). Each genuine remaining leak is owned by a tracking issue; new gaps filed where the cited issue was closed without coverage or no native-engine issue existed. Already-tracked: Map/Set → #1103, number→string → #1335, RegExp → #682/#1474, closures/callbacks → #1470, JSON Phase 2 → #1599. Expected/wont-fix (not filed): eval, Proxy, with, dynamic import, full Intl collation.

- [#1662](../1662-standalone-host-import-audit.md) — Audit record + findings table (done) — high, easy.
- [#1666](../1666-standalone-invalid-wasm-native-string-number-lowering.md) — **Bug**: `--target wasi` emits _invalid_ (non-instantiable) wasm for class/closure/callback-array-methods/number→string/regex/generator/typed-array — `__str_flatten`/`__str_to_extern` type mismatch + unbound late global (`0xffffffff`). More severe than a leak (won't instantiate even with a host). Fix first — masks #1664. — high, hard, ready.
- [#1663](../1663-standalone-parseint-parsefloat-native.md) — Pure-Wasm `parseInt`/`parseFloat`/`Number(string)`. `env.parseInt`/`env.parseFloat` still leak; #1471 (the cited owner) closed without implementing them. — medium, medium, ready.
- [#1664](../1664-standalone-extern-object-iterator-residual.md) — Residual `__extern_*`/`__register_*`/`__iterator*`/`__array_*`/`__get_undefined` leaks after #1472 landed partial. class/super, typed-array `.set`/`.subarray`, Map/Set. — medium, hard, ready (after #1666).
- [#1665](../1665-standalone-native-generators.md) — Wasm-native generators (state-machine lowering) to retire `__gen_*`/`__create_generator*`/`__iterator*` host scheduler. Currently only owned by the #1376 IR telemetry gate, not a native-engine issue. — medium, hard, **ready (sprint 58; after #1666)**.

## Harvest 2026-05-24b (fixable test262 compile-error causes — CE decomposition)

Decomposed the 1,367 `compile_error` results in `test262-current.jsonl`. The
528 `invalid Wasm binary` CEs were sub-clustered by validator error; sub-causes
already enumerated in #1522 / #1543 / #1556 are not re-filed.

## Harvest 2026-05-24 (new issues from test262 error analysis)

- [#1591](1591-class-elements-same-line-multi-definition.md) — class/elements same-line / stacked member definitions lost or reordered — **~294 fails**, high priority (formerly 779b)
- [#1592](1592-ary-ptrn-elision-rest-holes-dstr.md) — Array pattern elision holes / rest-array consume wrong iterator step — **~305 fails**, high priority
- [#1593](1593-default-init-triggers-on-null-should-be-undefined-only.md) — Destructuring default init triggers on `null` (spec: undefined-only) — **~165 fails**, easy
- [#1594](1594-annexb-strict-function-code-tdz-referenceerror.md) — AnnexB strict function-code / class name-binding TDZ not throwing ReferenceError — **~100 fails**, medium
- [#1595](1595-arraybuffer-transfer-methods-not-implemented.md) — ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented — **~40 fails**, medium
- [#1596](1596-function-prototype-apply-call-not-accessible.md) — Function.prototype.apply / .call not accessible on compiled Wasm functions — **~46 fails**, high

## Destructuring-lane sweep follow-ups (2026-05-24)

From the dev-1553b destructuring-lane verification sweep.

- [#1658](../1658-destructured-function-param-default-not-applied.md) — Destructured/scalar **function-parameter** default not applied: returns 30 where 40 is expected on the real runtime (distinct from the object/array decl-mode #1553b/#1553d which are done) — high, medium, **ready**. NOT currently caught by CI (see #1659); depends on #1659 for gating.
- [#1659](../1659-ci-equivalence-tests-not-run.md) — CI does not run `tests/equivalence/` (OOMs in runner) so genuine equivalence regressions (e.g. #1658) land silently. Options: shard like test262 / constrained workers / `--no-threads` / separate scheduled job. Sub-item: fix `__extern_get` harness-fidelity gap in `tests/equivalence/helpers.ts` so the suite runs clean — high, medium, **ready**. Gates CI-visibility of #1658.

## CI quality gate hardening (2026-06-01)

- [#1771](../1771-prepush-issue-integrity-committed-tree.md) — Pre-push issue integrity must check the committed tree so dangling `depends_on` edges cannot be masked by uncommitted sibling issue files — medium, easy, **DONE (sprint 58)**.
- [#1773](../1773-generate-graph-data-in-ci-and-labs.md) — Generate `website/public/graph-data.json` in CI/build output and publish the snapshot to labs instead of tracking the generated JSON in public source — medium, easy, **DONE (sprint 58)**.

## Landing page / conformance dashboard UX (2026-06-02)

- [#1777](../1777-landing-es-edition-slider-2026-notch-thumb-offset.md) — landing page ES edition slider shows ES2026 as a published notch and the thumb drifts right of ticks while dragging — medium, easy, **ready (sprint 59)**.
- [#1778](../1778-landing-standalone-test262-pass-rate-real-number.md) — landing page JS-host toggle should show the real standalone-mode test262 pass rate instead of a scaled estimate — medium, medium, **DONE (sprint 58)**.

## Standalone test262 root-cause refresh (2026-06-02)

From the full standalone JSONL published in `loopdive/js2wasm-baselines`
commit `b4684d8f97a462c6414716aea46f31b67f48b959` and mapped in #1781.
Existing high-volume root causes were updated in their owning issue files;
only one new root-cause issue was needed.

- [#1782](../1782-standalone-numeric-separator-literals-wrong-values.md) — standalone numeric and BigInt separator literals evaluate to wrong values: 50 assertion failures under `language/literals/*/numeric-separators/` — medium, medium, **ready (backlog)**; follow-up to done #53.

## Harvest 2026-06-03 (default-lane codegen crashes from baselines-repo run)

- [#1808](../1808-binary-emit-offset-out-of-bounds-codegen-crash.md) — `Binary emit error: offset is out of bounds`: `emitBinary()` crashes identically on **290** default-lane tests (Array/String/TypedArray/Temporal/DataView/eval-code) — one emit-layer back-patch/offset overflow, not 290 distinct bugs. High, medium, **ready (sprint 59)**. Distinct from done #203 (varint overflow). Surfaced harvesting the fresh `loopdive/js2wasm-baselines` data (gitHash f692249d).
- [#1809](../1809-method-trampoline-shift-walker-misses-import-funcidx.md) — `pendingMethodTrampolines … shift walker missed this (#1525b regression)`: late-import index-shift walker fails to rewrite a method-trampoline funcIdx pointing at an import (e.g. resizable-buffer `resizeTo`) — **157** default-lane compile errors. High, medium, **ready (sprint 59)**. Regression of done #1525b; distinct from done #1669.

## Harvest 2026-06-04 (cross-lane error analysis, baselines-repo sha f692249d)

Default lane:

- [#1805](../1805-negative-test-fail-early-error-enforcement-gaps.md) — 75 `negative_test_fail` tests: early-error enforcement gaps (parse/TDZ/TypeError) not covered by done #774/#927 — medium, medium, **ready (sprint 59)**.

Standalone lane:

- [#1806](../1806-standalone-toprimitive-cannot-convert-object.md) — standalone `Cannot convert object to primitive value`: **2,136 tests** — `__toPrimitive` host import refused in standalone; needs Wasm-native ToPrimitive or a proper refusal cite — high, medium, **ready (sprint 59)**.
- [#1807](../1807-standalone-issamevalue-async-gen-wasm-type-mismatch.md) — standalone isSameValue Wasm call type mismatch for async-generator parameters: **277 tests** — #1776 fixed the externref case but async-generator ref types produce a different call mismatch — medium, medium, **ready (sprint 59)**.

## IR / allowJs parity follow-ups (2026-06-03)

- [#1783](../1783-ir-js-ts-native-messaging-wasm-parity.md) — IR inference parity: native-messaging `.js` and `.ts` emit divergent WASI Wasm; JS path boxes numeric values and loses numeric template interpolation despite valid WASI output — medium, medium, **ready (backlog)**; follow-up to #1768/#389.

## TypedArray packed-integer follow-ups (2026-06-03)

- [#1810](../1810-typedarray-packed-lane-storage.md) — Generalize TypedArray storage to packed WasmGC lanes: `i8`/`i16`/`i32`/`f32`/`f64` backing instead of the legacy f64 representation for all numeric typed arrays — medium, hard, **ready (backlog)**; follow-up to #1767/#389.
- [#1811](../1811-typedarray-element-metadata.md) — TypedArray element metadata for signedness, clamping, storage lanes, and load/store behavior so codegen stops inferring semantics from vec-key strings — high, hard, **ready (backlog)**; unlocks #1810/#1786.
- [#1786](../1786-wrapexports-packed-typedarray-abi.md) — `wrapExports` ABI support for packed TypedArray vectors at the JS-host boundary, replacing the f64-only allocator/mutator assumption — medium, hard, **ready (backlog)**; follow-up to #1700/#1810.
- [#1787](../1787-packed-typedarray-semantics-regressions.md) — Regression coverage for packed TypedArray integer semantics: unsigned/signed reads, clamping, and invalid `array.get` guards — medium, medium, **ready (backlog)**; test guardrails for #1810/#1811.

## Sprint 55 — repo structure / website (2026-05-24)

- [#1656](../1656-group-website-files-into-website-dir.md) — Consolidate all website/frontend files under `website/` (components, dashboard, playground, index.html, public, frame-nav-sync.js, images, vite.config.ts, CNAME) — medium, medium, **ready (sprint 55)**. Needs architect spec (`arch(#1656)`) before dev; lands as one PR. Related: #1583, #1590.
- [#1657](../1657-mq-test262-paths-filter.md) — Skip `merge_group` test262 shards for non-src changes while keeping the "merge shard reports" required check green — medium, medium, **in-review (sprint 55)**. Conservative path detector (`scripts/test262-paths-match.sh`) + `changes` job gate the queue's shard matrix; fail-safe runs shards on any doubt. Related: #1656.
- [#1661](../1661-readme-programmatic-api-host-imports.md) — README programmatic-API example fails: `instantiate(binary, {})` but default JS-host mode emits `string_constants` + `env.*` imports, so the empty-imports snippet throws `Import #0 "string_constants"`. Recommend switching the example to standalone / no-host mode (#1471–#1474) so it genuinely runs under `{}`, and document the default-vs-standalone import requirement — **high**, easy, **ready (sprint 55)**. Plan-only; from guest271314 GitHub #601. Same theme as #389 (docs imply standalone behavior default mode doesn't deliver). Related: #1471, #1472, #1473, #1474, #1530.
- [#1667](../1667-dx-generate-import-object.md) — **DX feature**: `compile()` should return a ready-to-pass import object for default/JS-host mode, so `WebAssembly.instantiate(r.binary, r.importObject)` works out of the box (no hand-wiring) — surfaces the runtime the CLI already emits as `<name>.imports.js` through the programmatic API. Complements #1661 (docs): #1661 documents the standalone zero-import path; #1667 adds the JS-host convenience. Host-imports-required stays the explicit default; standalone/`wasi` remains the recommended portable default — **medium**, medium, **ready**. From guest271314 GitHub #601. Related: #601, #1661, #1471.

## WASI Native Messaging — AssemblyScript-reference alignment (2026-05-24)

Compiler gaps blocking full convergence of `examples/native-messaging/host.ts`
(#1530) on the reference `nm_assemblyscript.ts`. #1654 is the root (unblocks
both others); #1653 is the keystone for the read side + continuous loop.

- [#1654](../1654-wasi-dataview-arraybuffer-invalid-module.md) — DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under `--target wasi` — high, medium, **root (ready)**
- [#1653](../1653-wasi-process-stdin-read-binary.md) — `process.stdin.read(buffer, offset?)` binary incremental stdin read (keystone) — high, hard, **depends on #1654**
- [#1655](../1655-wasi-process-stdout-write-arraybuffer.md) — `process.stdout.write(ArrayBuffer)` accept ArrayBuffer arg, not only Uint8Array literal — medium, easy, **depends on #1654**

## Governance / legal — CLA gate (2026-05-24)

- [#1660](../1660-real-cla-gate.md) — Replace the placeholder `cla-check` workflow with a real CLA signature/approval gate — **DONE**. Self-hosted in-repo gate: signatures recorded in `.github/cla/signatures.json` via an affirmative PR comment; internal authors (org members / maintainer / `*[bot]`) exempt, external humans sign by comment. CLA version tied to `CLA.md` hash for re-acceptance. Promotion to a _required_ branch-protection check is deferred to an admin (documented follow-up in the issue) so the gate can't deadlock the internal merge queue before exemption is proven. Related: #1530.

## Spec-compliance easy wins (from #1563 gap analysis, 2026-05-21)

- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3) — ~12 fails, easy
- ~~[#1565](1565-toBoolean-bigint-i64-eqz.md)~~ — DONE (merged PR #541 in s55)
- ~~[#1566](1566-toNumber-symbol-throws-typeError.md)~~ — DONE (merged PR #541 in s55)

## Developer experience / docs

- [#1590](1590-first-5-min-ux-docs-and-hints.md) — First-5-minutes UX: Wasmtime run docs, coverage-honesty section, CLI run-hint, standalone I/O docs, pitch-language accuracy, "compare to…" section — docs+CLI only, 6 commits in order, easy

## Carry-over from earlier analysis

- [#779a](779a-class-dstr-method-tramp-residual.md) — class/dstr method-tramp residual (gen/async-gen/private/static) — **~727 fails**, ready
- [#779d](779d-object-literal-dstr-residual.md) — object-literal dstr non-method residuals — **~132 fails**, ready
- [#779e](779e-arguments-object-residual.md) — arguments-object mapped/trailing-comma/sloppy-strict residuals — **~134 fails**, ready
- [#846](846-assert-throws-not-thrown-built.md) — assert.throws not thrown: built-in methods accept invalid args silently — **~2,799 fails**, ready
- [#1319](../sprints/50/1319-cannot-convert-to-primitive-symbol-toprimitive.md) — Cannot convert object to primitive (Symbol.toPrimitive chain) — **~150 fails**, ready
- [#1529](1529-codegen-illegal-cast-at-closure-and-destructuring-boundaries.md) — illegal cast at closure/dstr boundaries — **~197 fails**, backlog
- [#1555](1555-destructure-param-array-streaming-iterator.md) — destructureParamArray streaming IteratorStep refactor — ready
- [#1568](1568-object-bigint-symbol-auto-box.md) — Object(BigInt) / Object(Symbol) auto-box wrappers — ready
- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol → TypeError — ~12 fails, easy

- [#1600](1600-finalizationregistry-host-delegate-noop-stub.md) — FinalizationRegistry host-delegate (JS mode, like WeakRef) + no-op standalone stub; clears ~12 CEs. Faithful standalone finalization stays out of scope (→ #1101).

## Test262 triage — untracked failure causes (PO, 2026-05-29)

New issues from a fresh main-baseline (`.test262-cache/test262-current.jsonl`,
48,117 records) root-cause triage. Dedup'd against all open issues; clusters
already covered by open issues (dstr WasmGC type-mismatch → #1556/#1623;
Promise non-constructor → #1528/#1694; Set set-like → #1627/#1646/#1674; bind
fidelity → #1463) were NOT re-filed.

- [#1716](../1716-spec-gap-toprimitive-residual-object-property-key-coercion.md) — **RESIDUAL of done #1090/#1319/#1525**: `Cannot convert object to primitive value` still thrown in 111 paths (Object property-key + String/RegExp/JSON/Date `this`-value coercion) — **high**, medium, **ready**
- [#1717](../1717-arraybuffer-prototype-slice-not-implemented.md) — `ArrayBuffer.prototype.slice` not implemented (`slice is not a function`, 17 fails) — medium, medium, **ready**
- [#1718](../1718-iterator-sequencing-helpers-concat-zip-flatmap.md) — Iterator sequencing helpers (`Iterator.concat`/`zip`/`zipKeyed`) + `Iterator.prototype.flatMap` not implemented (101 fails; distinct from done #1340) — medium, hard, **ready**
- ~~[#1719](../1719-array-destructuring-ignores-overridden-array-prototype-iterator.md) — Array destructuring ignores overridden `Array.prototype[Symbol.iterator]` (`items[Symbol.iterator]` must be a function, 71 fails)~~ — **DONE** 2026-05-30 (CPR read-drive across decl/for-of/param/assignment, PRs #963/#968/#976). Follow-ups: #1749 (spread), #1750 (TS-cast form).

### ES3 / edition-0 conformance → Sprint 57 (Track 3)

- [#1720](../1720-es3-incdec-reference-evaluation-order-null-base.md) — ES3: prefix/postfix inc-dec reference evaluated once before null deref (`base[prop()]++`, sputnik S11.x, ~10 fails) — medium, medium, **ready (sprint 57)**
- [#1721](../1721-es3-subclass-function-object-instanceof.md) — ES3 (residual of #1455): `class extends Function`/`extends Object` instanceof returns false (4 fails) — medium, medium, **ready (sprint 57)**
- [#1722](../1722-es3-assignmenttargettype-early-syntaxerror.md) — ES3: AssignmentTargetType early SyntaxError not raised (yield/arrow as assignment target, 4 fails) — low, medium, **ready (sprint 57)**
- [#1511](../1511-spec-gap-arguments-object-mapped-and-trailing-comma.md) — **MOVED to sprint 57** (was sprint 52): arguments object mapped semantics / descriptors / trailing-comma length — covers the ES3 mapped-arguments cluster (~19 edition-0 fails) — high, medium, **review**
- [#1757](../1757-async-compile-api-migration.md) — Migrate public `compile()` API to async (embed binaryen via await import; follow-up to #1756/#986) — **BREAKING**, ~1675 sites/761 files, medium, hard, **in-progress** [SENIOR-DEV]

### Platform / Component Model & runtime (from GitHub #389)

- [#1751](../1751-wit-generator-incomplete-world-package-imports.md) — WIT generator emits an incomplete world: hardcoded `local:module` package + no `import` side (vs `wasm-tools`-extracted component WIT) — medium, medium, **DONE (sprint 58)**
- [#1752](../1752-textencoder-textdecoder-runtime-api.md) — `TextEncoder`/`TextDecoder` runtime API (UTF-8, standalone + WASI; builds on #1588) — medium, medium, **DONE (sprint 58)**
- [#1754](../1754-build-from-repo-loopdive-js2-unresolved.md) — Build-from-repo `packages/index.js` re-exports unresolved `@loopdive/js2` — medium, medium, **ready (backlog)**
- [#1779](../1779-wit-generator-wasm-tools-roundtrip-parity.md) — Follow-up for #1751: WIT generator `wasm-tools` round-trip parity check — medium, medium, **ready (backlog)**
- [#1780](../1780-textencoder-encodeinto-standalone-wasi.md) — Follow-up for #1752: `TextEncoder.encodeInto` support for standalone/WASI — medium, medium, **ready (backlog)**
- [#1753](../1753-native-messaging-64mib-chunked-streaming.md) — Native-messaging host: 64 MiB read/write via ≤1 MiB chunked streaming (on the byte-native loop; builds on #1655) — medium, medium, **DONE (sprint 58)**
- [#1755](../1755-uint8array-arraybuffer-generic-annotation.md) — `Uint8Array<ArrayBuffer>` generic type annotation not accepted (from GitHub #389) — medium, medium, **DONE (sprint 58)**
- [#1759](../1759-wasi-native-number-to-string-bridge-gap.md) — WASI `process.stderr.write` numeric-template → native number→string bridge gap (from GitHub #389) — medium, medium, **DONE (sprint 58)**
- [#1765](../1765-nullable-number-alias-narrowing-byte-assignment.md) — Nullable `number | null` sentinel not narrowed through a boolean alias before typed-array byte assignment (from GitHub #389, 2026-06-01) — medium, medium, **DONE (sprint 58)**
- [#1766](../1766-process-stdout-write-drain-backpressure-api.md) — Node-style `process.stdout.write` backpressure / `once("drain")` pattern not supported; Preview-1 direct `fd_write` `write()`→`true` + no-op `once("drain")` shim done, full async helper still blocked (from GitHub #389, 2026-06-01) — medium, hard, **blocked (backlog)** on #1042/#1326/#1575
- [#1772](../1772-edgejs-node-wasi-shim-spike.md) — Spike edge.js as a separate Node API module / WASI shim layer for imported `node:process`-style compatibility instead of accumulating host API cases inline in the compiler — medium, medium, **backlog**
- [#1769](../1769-generalize-nullable-primitive-unions.md) — Generalize nullable primitive union lowering and narrowing beyond the narrow `number | null` typed-array byte-write fix: sentinel-preserving representation plus reusable non-null flow proofs for arithmetic, calls, returns, and writes — medium, hard, **DONE (sprint 58)**, follow-up to #1765
- [#1767](../1767-native-messaging-64mib-memory-growth.md) — 64 MiB native-messaging stress run now streams continuations without staging the full request; guarded wasmtime 64x array run peaked at 36.1 MiB RSS (from GitHub #389, 2026-06-01) — high, hard, **DONE (sprint 58)**
- [#1768](../1768-allowjs-native-messaging-sendmessage-invalid-wasm.md) — Plain `.js` / allowJs native-messaging `sendMessage` compiles but emits invalid WASI wasm (`unknown global`, earlier `expected externref, found f64`) — high, medium, **DONE (sprint 58)**
- [#1774](../1774-wasi-preview3-async-stream-semantics.md) — WASI 0.3 / Preview 3 async stream semantics for Node stdout/stderr: map `Writable.write()` backpressure, `drain`, callbacks, and errors onto component-model `stream<u8>` / `future` shapes when that backend exists (follow-up from PR #1016 comment, 2026-06-01) — medium, hard, **ready (backlog)**, depends on #1042/#1326/#1575

### String-hash warm perf — levers carved from #1746 umbrella (2026-05-31)

Native differential (PR #997) found the string **build** loop is ~99% of warm wall
time (the i32 hash path lever is DONE and already faster/char than V8). Two sized levers:

- [#1761](../1761-string-build-buffer-presize-static-trip-count.md) — Presize the string-build buffer from a static loop trip count to kill the reallocs + per-append cap-check (top AOT win, measured #1 of remaining levers) — **high**, medium, **ready (sprint 59)**
- [#1762](../1762-linear-memory-string-backing-build-hash-hot-path.md) — Linear-memory string backing for the build/hash hot path — drop the WasmGC `(array i16)` GC barrier (strategic ceiling; dual-backend like #679/#682/#1714) — **high**, hard, **ready, likely needs arch spec**

### Code-review findings — latent + redundancy (2026-06-04)

From the full-codebase review on 2026-06-04
(`plan/code-review/2026-06-04-compiler-review.md`). Reachable correctness bugs
went into sprint 59 (#1815–#1839); these are latent (not-yet-wired paths),
defense-in-depth, and cleanup:

- [#1840](../1840-linker-leb-truncation-and-rewrite-gaps.md) — linker `writeLEB128` truncates growing indices; `call_indirect`/`memory` rewrite gaps (latent — `.o` linker) — low, medium, **backlog**
- [#1841](../1841-element-section-flag-bitfield.md) — element-section flag bitfield only handles active flag-0 (latent — linker) — low, medium, **backlog**
- [#1842](../1842-none-heaptype-constant-collides-with-any.md) — `none` heap-type constant collides with `any` (0x6e); `noextern`/`nofunc` missing (latent — emit) — low, low, **backlog**
- [#1843](../1843-reloc-tag-index-leb-mismatch.md) — `R_WASM_TAG_INDEX_LEB` emitter (11) vs reader (10) mismatch (latent — linker) — low, low, **backlog**
- [#1844](../1844-ir-verify-no-nested-buffer-recursion.md) — IR `verify` doesn't recurse nested if/try/loop buffers; return-type gate + SSA holes (residual #1798, defense-in-depth) — low, medium, **backlog**
- [#1845](../1845-ir-propagate-bool-overclaim-seedconcrete.md) — IR propagate: `&&`/`||` over-claim `BOOL`; `seedConcrete` omits i32/u32 — low, low, **backlog**
- [#1846](../1846-minor-typeof-conformance-notes.md) — minor `typeof`: i64→"number" in `with`-bindings; externref→null fallthrough — low, low, **backlog**
- [#1847](../1847-forof-rollback-localmap-not-restored.md) — for-of tentative rollback doesn't restore `fctx.localMap` (robustness) — low, low, **backlog**
- [#1848](../1848-dead-code-sweep.md) — dead-code sweep: identical branches, unused locals/params, obsolete scaffolding — low, low, **backlog**
- [#1849](../1849-duplicate-logic-refactor.md) — refactor diverged copy-paste (super dispatch, closure drainers, `resolveVec`, `__extern_has`, typed-default) — low, medium, **backlog**

### Compiler-design lessons — architectural recommendations (2026-06-04)

From [`docs/architecture/compiler-design-lessons.md`](../../../docs/architecture/compiler-design-lessons.md)
(vendor-neutral synthesis of general compiler/IR/runtime patterns) and
[`docs/architecture/structure-and-language-assessment.md`](../../../docs/architecture/structure-and-language-assessment.md)
(structure + language review). Net-new issues only; recommendations already
tracked elsewhere are noted under "Already covered" below.

- [#1850](../1850-ir-verifier-hardening-dominance-legality.md) — R1: harden the IR verifier into a hard between-pass contract (cross-block dominance + per-backend legality + fail-CI; umbrella over #1844) — high, medium, **backlog**
- [#1851](../1851-backendemitter-legalization-boundary-type-converter.md) — R4: make `BackendEmitter` an explicit legalization boundary, extract a declared type-converter, add a backend-neutral mid-level — medium, hard, **backlog**
- [#1852](../1852-per-backend-value-representation.md) — R5: per-backend dynamic-value representation (typed refs / `i31ref` on WasmGC; f64-value + i32-tag on linear) — medium, hard, **backlog**
- [#1853](../1853-conformance-hard-error-stability-bucket.md) — R6: separate hard-error (compiler-crash / malformed-Wasm) stability bucket on the conformance dashboard — high, easy, **backlog**
- [#1854](../1854-cross-backend-differential-testing.md) — R7a: cross-backend differential testing harness (WasmGC / linear / bytecode-VM must agree) — high, medium, **backlog**
- [#1855](../1855-ub-free-ts-fuzzer-and-minimization.md) — R7b: UB-free TS program generator + automated validity-preserving minimization — medium, hard, **backlog**
- [#1856](../1856-linear-bump-arena-allocator-mode.md) — R10: bump/arena allocator mode for short-lived linear programs; commit to one fixed linear-GC strategy — medium, medium, **backlog**
- [#1857](../1857-ir-attributes-vs-operands-convention.md) — R11: carry compile-time-constant facts as IR node attributes, not synthetic SSA operands — low, easy, **backlog**
- [#1860](../1860-backend-naming-symmetry-gc-linear.md) — structure review: rename `codegen/` + `codegen-linear/` → `backend/gc` + `backend/linear` so neither backend reads as the default (pure rename; consider bundling with #1172) — low, medium, **backlog**
- [#1859](../1859-per-subdir-module-contract-readmes.md) — structure review: per-`src/`-subdir module-contract READMEs (responsibility, in/out, dependency direction) — low, easy, **backlog**

**Already covered (no new issue):** R2 (make illegal states unrepresentable / retire `as unknown as Instr`) → **#1095**; R3 (finish the strangler: drive fallback buckets to zero, promote to strict) → **#1376** + the per-bucket program (#1370 done, #1371 done, #1372, #1373…) tracked in `plan/log/ir-adoption.md`; R8 (cheap mid-level SSA cleanup: fold/DCE/simplify-cfg + conservative inline) → **#1167a** / **#1167b**; R9 (host-import gate) → standing CLAUDE.md rule + audit **#1662**.

### Real-world test coverage findings (2026-06-04)

Found while adding `tests/real-world-*.test.ts` (real-world code patterns
test262 doesn't cover: ESM, Web/WASI/Node/Deno APIs, Hono/React/Express):

- [#1801](../1801-wasi-process-exit-invalid-binary.md) — WASI `process.exit(code)` emits an invalid binary: the exit code is compiled as i32 but an `i32.trunc_sat_f64_s` (expects f64) is pushed on top (`calls.ts:3180-3186`); `wasi-target.test.ts` only checks WAT so missed it. Sentinel via `it.fails` in `real-world-wasi.test.ts` — medium, easy, **sprint 60, DONE** (2026-06-05). _(Was mistakenly cited as phantom "#2177" — corrected.)_

### Fable-team findings (2026-06-10)

- [#1915](../1915-gc-host-string-spread-empty-array.md) — gc JS-host mode: `[...str]` / `Array.from(str)` returns an empty array (externref-spread gap; pre-existing, verified independent of #1470's standalone fix) — medium, medium, **backlog**

### Compiler quality & architecture review (2026-06-10)

From [`docs/architecture/compiler-quality-review-2026-06.md`](../../../docs/architecture/compiler-quality-review-2026-06.md)
(seven-subsystem graded review; every finding file:line-evidenced, two
probe-verified). Grades: WasmGC codegen C−, IR B−, front-end C+, runtime B,
linear+emit C+, test/CI B+, optimization C+ — overall **B−**. Already-tracked
overlaps (#1098/#1172/#1095/#1530/#1850/#1852/#1854/#1855/#1858–#1860) were
not re-filed; the issues below are net-new.

**Fail-loud / correctness (children of #1858):**

- [#1937](../1937-linear-backend-fail-loud-break-continue.md) — linear backend: `break`/`continue` never compiled (silent infinite loops); dispatchers need default-arm diagnostics — **critical**, easy, **backlog**
- [#1941](../1941-differential-testing-optimize-output.md) — differential testing of `--optimize` output (wasm-opt miscompiles currently invisible; 3 reviewers converged) — **critical**, easy, **backlog**
- [#1939](../1939-encodeinstr-default-throw-funcref-validation.md) — emit: `encodeInstr` silently drops unknown ops; default-throw + un-gate `validateFuncRefs` + round-trip test — high, easy, **backlog**
- [#1921](../1921-structured-compile-failure-gate.md) — replace the `"Codegen error:"` string-prefix failure gate with structured severity — high, easy, **backlog**
- [#1938](../1938-linear-number-array-i32-truncation-double-eval.md) — linear: `number[]` i32 truncation (`[1.5]`→`[1]`) + element-assignment RHS double-eval — high, medium, **backlog**
- [#1918](../1918-stack-balance-strict-mode-fixup-ratchet.md) — stack-balance strict mode + fixup ratchet (lossy `drop; const 0` repairs mask emitter bugs) — high, medium, **backlog**
- [#1940](../1940-wit-generator-silent-param-drop.md) — WIT generator silently drops unmappable params (arity mismatch) — medium, easy, **backlog**

**Consolidation (divergent copies already shipping bugs):**

- [#1922](../1922-shared-ir-traversal-while-loop-dce-defect.md) — shared IR traversal module; fixes probe-verified live defect (ordinary `while` loops demote off the IR path) — high, medium, **backlog**
- [#1917](../1917-single-coercion-engine.md) — one coercion engine (4 matrices disagree: externref→f64 unboxes vs `f64.const 0` by context) — high, medium, **backlog**
- [#1927](../1927-single-pipeline-driver.md) — one front-end pipeline driver (3 divergent clones; multi-file silently skips early errors/hardened/IR/JSX) — high, medium, **backlog**
- [#1920](../1920-unify-instruction-walkers-peephole-catchall.md) — one instruction walker; peephole misses `catchAll` bodies (bug); NaN-const + tee fusion — medium, easy, **backlog**
- [#1919](../1919-transactional-speculative-compile.md) — transactional speculative-compile API (23 probe/rollback sites leak locals/imports/types) — medium, medium, **backlog**
- [#1934](../1934-decompose-resolveimport-domain-tables.md) — decompose `resolveImport` (5,000-line fn, 188 name checks) into domain tables; unify 3 ToPrimitive walkers; unbundle test262 shim — medium, hard, **backlog**
- [#1931](../1931-decompose-detect-early-errors-treeshake.md) — decompose `detectEarlyErrors` (3,350-line fn), run on every path; wire or delete dead `treeshake` option — medium, medium, **backlog**

**Gates that don't match documentation:**

- [#1943](../1943-enforce-ratio-bucket-thresholds-ci.md) — enforce the documented 10%-ratio / 50-per-bucket thresholds in CI (today only net ≥ 0 is enforced) — high, easy, **backlog**
- [#1942](../1942-compile-time-regression-gate.md) — compile-time regression gate (`pass→compile_timeout` excluded from every gate today) — high, easy, **backlog**
- [#1923](../1923-meter-ir-post-claim-demotions.md) — meter IR post-claim demotions in the fallback ratchet (build/verify/lower failures invisible to CI) — high, easy, **backlog**
- [#1945](../1945-test262-oracle-precision.md) — test262 oracle precision (expected error types discarded; undefined-asserts stripped; 71.6% is an upper bound) — medium, medium, **backlog**
- [#1949](../1949-representative-perf-gate.md) — representative perf gate (4 overfitted micros at 50% tolerance; honest suite ungated) — medium, easy, **backlog**
- [#1944](../1944-ci-cost-bundle-once-pnpm-cache.md) — CI cost: bundle-once artifact + pnpm cache (~120–170 wasted runner-min/run) — medium, medium, **backlog**

**Type information & performance:**

- [#1946](../1946-closure-devirtualization-singleton-callees.md) — closure devirtualization for singleton callees (~15-instr dynamic dispatch Binaryen provably can't remove) — high, medium, **backlog**
- [#1948](../1948-shared-numeric-i32-lattice.md) — shared numeric i32 lattice (3 duplicated matchers; `i-1` f64 round-trip survives -O3) — high, medium, **backlog**
- [#1947](../1947-end-to-end-gc-ref-typing.md) — end-to-end GC-ref typing; externref at host boundary only (unlocks Binaryen GC passes) — high, hard, **backlog**, needs `/architect-spec`
- [#1924](../1924-ir-verifier-instruction-type-rules.md) — instruction-level type rules in the IR verifier (operands/branch-arg types/resultType unchecked; extends #1850) — high, medium, **backlog**
- [#1950](../1950-default-on-optimization-pipeline.md) — default-on optimization (CLI/playground `-O` default; tiny always-on cleanups; **blocked by #1941**) — medium, easy, **backlog**

**Diagnostics & API quality:**

- [#1928](../1928-source-position-remapping-preparse-rewrites.md) — source-position remapping for pre-parse rewrites (diagnostics report wrong lines whenever a rewrite fires) — high, medium, **backlog**
- [#1929](../1929-compileerror-file-flatten-chains.md) — `CompileError.file` + flattened TS diagnostic chains — medium, easy, **backlog**

**Runtime hygiene:**

- [#1932](../1932-version-env-abi.md) — version the env ABI (~200 names, no handshake; regex engine already shows the pattern) — high, easy, **backlog**
- [#1933](../1933-runtime-multi-instance-isolation-leak.md) — multi-instance isolation (symbol/RegExp state bleed) + `_subclassCtors` instance-retention leak — high, medium, **backlog**
- [#1935](../1935-retire-undefined-sentinel-protocol.md) — retire the undefined-as-sentinel protocol (`MISS` symbol; getters returning `undefined` misread as absent) — medium, medium, **backlog**

**Strategic (architect-spec first):**

- [#1916](../1916-symbolic-function-references-codegen.md) — symbolic function references in WasmGC codegen; retire the late-import index-shift machinery (≥7 regressions trace to it) — high, hard, **backlog**, needs `/architect-spec`
- [#1930](../1930-typeoracle-type-query-boundary.md) — TypeOracle: one type-query boundary (~397 raw checker sites; unblocks TS7; kills suppression heuristics) — high, hard, **backlog**, needs `/architect-spec`
- [#1936](../1936-async-contract-migration-enable-cps.md) — async contract migration: enable the built-but-disabled CPS lowering via call-site census + await-elision — high, hard, **backlog**, needs `/architect-spec`
- [#1925](../1925-ir-hygiene-passes-nested-buffers.md) — run IR hygiene passes inside nested buffers, or commit to one control-flow representation (do before #1370/#1373 waves) — medium, hard, **backlog**
- [#1926](../1926-remove-valtype-typeidx-from-irtype.md) — remove backend `ValType`/`typeIdx` from `IrType` (blocks IR serialization + linear union adoption) — medium, medium, **backlog**

## 2026-06-12 — Sprint-62 planning triage (Fable architecture sprint)

Full record: `plan/issues/sprints/62.md` (+ pre-staged `63.md`). Summary:

- Scheduled into 62 (architecture/Fable): #1804 #1853 #1854 #1855(spec)
  #1899 #1919 #1921 #1922 #1923 #1924 #1925 #1926 #1927 #1931 #1950 #2085
  #2089 #2090 #2092 #2100 #2101 #2104 #2105 #2106 #2107 + #1095(re-scoped)
  - from sprint 61: #1916 #1917 #1930 #1965 #1979-#1981 #1983 #1988-#1990
    #2009 #2015 #2022 #2051 #2059 #2072 #2079 #2080 #2081 #2084
- New issues filed: #2134-#2143 (sprint 62), #2144-#2147 (sprint 63)
- Moved 61→63 (routine): #1994 #2001 #2007 #2008 #2011-#2013 #2017 #2021
  #2023-#2028 #2033 #2035 #2076 #2077 #2083 #2118 #2119; backlog→63:
  #2086-#2088 #2093-#2099 #2102 #2103 #2108
- Closed: #1624 (superseded by #2104-#2107 + #2141); duplicates
  #2110-#2117 (≡ #2118-#2125, high series canonical)
- Stale-ready → done (fix PRs merged): #1991 #2002-#2006 #2018-#2020
  #2027 #2078

## 2026-06-25 — Sprint-66 ES3/ES5/ES6 edition-gap grooming (PO)

Edition-gap review off the test262 baseline jsonl (`scripts/fetch-baseline-jsonl.mjs`),
classified by the `generate-editions.ts` rules. Gaps: ≤ES3 32, ES5 ~3415,
ES2015 ~4280 failing. Priority ES3 > ES5 > ES6, biggest fail-count clusters
first; eval / dynamic-code deprioritized. All added to sprint 66.

New issues (uncovered/residual clusters):

- [#2666](../2666-es3-member-ref-eval-order-compound-assign-incdec.md) — ≤ES3 `base[prop]` eval order in compound-assign + ++/-- (ToPropertyKey once) — ~100 tests across editions, **TOP**.
- [#2667](../2667-es3-mapped-arguments-nonconfigurable-delete-residual.md) — ≤ES3 mapped arguments non-config/non-writable + delete (residual of #1511) — 12 tests.
- [#2668](../2668-es5-object-defineproperty-descriptor-fidelity-residual.md) — ES5 Object.defineProperty/defineProperties descriptor fidelity residual — ~788, largest ES5.
- [#2669](../2669-es6-destructuring-correctness-residual-umbrella.md) — ES2015 destructuring correctness umbrella — ~696, largest ES6.
- [#2670](../2670-es6-array-prototype-iteration-method-semantics-residual.md) — ES2015 Array.prototype generic-receiver/holes/length residual — ~1017, largest single built-in.
- [#2671](../2671-es6-builtin-spec-residuals-date-regexp-promise-json-super.md) — ES2015 Date/RegExp/Promise/JSON/super residual tracker — ~400.

Existing covered issues pulled into sprint 66 (Backlog → 66): #1642 (for-of IteratorClose),
#2566 (generator over-consume in dstr), #1556 (param-pattern struct mismatch),
#1551 (SuperCall eval order). Already sprint:66: #1355 (Proxy), #1344 (generators),
#2580 (length on dynamic receiver), #2663 (with statement).

Deprioritized (eval / new Function / dynamic-import — NOT scheduled first):
~219 ES5 + ~87 ES6 eval/dynamic-code fails; tracked by #1066, #1102, #1240,
#1263-#1266 (eval tiers). Not added to the prioritized sprint-66 list.

## 2026-07-06 /harvest-errors run (both lanes; standalone de-vacuified)

Data: default baselines run 20260706-034320 (gitHash 2aa204b4, 32,514 pass);
standalone `test262-standalone-current.jsonl` (6.7.2026), post #3055/#2757
numeric-any-eq de-vacuification. New clusters filed:

- [#3074](../3074-typedarray-harness-wrapper-callback-vacuous-both-lanes.md) —
  TypedArray harness-wrapper callback never executes → vacuous fail in BOTH
  lanes (**1,535 default** = largest default cluster, **448 standalone**).
  Persists after #2939/#2940 both closed; reopens the feature gap.
- [#3075](../3075-standalone-forof-dstr-illegal-cast-iterator.md) — standalone
  for-of/for-await-of destructuring `illegal cast [in __iterator]` — **468**
  standalone, residual after #1323 (done). goal: standalone-mode.

Verdict on the de-vacuified numeric failures (#3055/#2757): **scattered, not a
coherent numeric cluster.** Number assertion-fails = 100 (mostly toString radix),
Math = 3. The ~1,958 newly-honest fails redistributed across general
assertion_fail categories (language/expressions 2,317, language/statements
1,927, Array 1,487, Object 1,358), not into a numeric-precision or
specific-builtin bucket. No numeric-cluster issue warranted.

## 2026-07-13 /harvest-errors run (both lanes)

Data: baselines run 20260713-085257 (gitHash bb27494f, 32,990 pass / 43,106),
harvested after syncing /workspace to upstream/main. Top `#NNNN` citations map
to existing issues — default: #2940 (vacuous detector, 1690), #1387/#1472 (67
each); standalone: #1472 Proxy (714), #2940 (581), #2928 eval (550, backlog),
#1906 (79), #1387 (67), #2046 Reflect (in-progress). Long-tail `assertion_fail`
spread across mature areas (Array/prototype, class, TypedArray,
Object.defineProperty) under existing goals — no new crash cluster. Actions:

- [#3227](../3227-default-lane-async-harness-callback-vacuous.md) — **NEW.**
  Default-lane **async-completion** harness callbacks never execute → **1,690
  vacuous fails** (largest default cluster), dominated by for-await-of (383),
  dynamic-import (234), Promise combinators (218), annexB/eval (168), async
  class methods (180). Distinct from #3074 (TypedArray harness-vacuous, **done**
  — cleared from top buckets), from #2903 (standalone `__make_callback` host
  leak), and from oracle-infra #3086/#3001. Dropped-async-continuation bug in
  the JS-host lane; residual after #2939/#2940 closed.
- **#1906 residual note** (issue is `done`) — 79 standalone records still emit
  `Object.defineProperties unsupported descriptor shape in standalone mode
(#1906)` + ~180 `Property description must be an object`. Accessor/mixed
  descriptor shapes still refused; incomplete-fix flag, follow-up optional.
- **negative_test_fail** (55/lane, 40 = "early SyntaxError not detected"):
  covered by existing spec-gap early-error issues (#1315/#1435); no new issue.

## 2026-07-17 /harvest-errors run (oracle-7 fresh baseline, both lanes)

Baselines run `20260717-111717` (host 32,138 / standalone 24,711 of 43,106),
oracle_version 7 — the honest async-scoring drop. Cross-referenced both lanes;
**nearly every >50 cluster maps to an existing tracked issue**. The single
genuinely-new, >50, untracked, high-value pattern:

- [#3360](../3360-async-gen-yield-star-abrupt-completion-protocol.md) — **NEW.**
  Async-generator `yield*` delegation drops iterator-protocol **abrupt
  completions** — **690 honest `yield-star-*` fails** in the default lane (0
  vacuous), the largest coherent honest-fail family oracle-7's #3227 S1/S4
  re-scoring exposed. Sub-families: getiter-async (182) + getiter-sync (144) =
  GetIterator-return-validation; next-then (108) + next-not (84) + next-call
  (36) + … = IteratorNext/step-protocol. Root: `__gen_yield_star`
  (`src/runtime.ts` ~L12510) — #3227 S3 fixed only the happy path. This is the
  S5 feature-fix carve-out of #3227 (`depends_on: [3227]`). `horizon: l`.

Verified-tracked (no new issue; safe-refill pointers for the lead):
Set-like method residuals → #2761 (ready) / #1674 (blocked); resizable
ArrayBuffer + `.transfer` → #1645 (ready) / #1595 (blocked); Reflect receiver
→ #2046 (in-progress); standalone host-import leaks (iterator_protocol 4,021 /
generic 1,720) → #2961 (in-progress) umbrella; new-Function/indirect-eval →
#2928 (backlog); with-statement PutValue-through-object-env residual
(30, `compound-assignment/S11.13.2_A5.*`) → #1387 (done) niche; import-attributes
early-SyntaxError (35, sub-50) → #1805 (done) residual. Temporal / ShadowRealm /
import.defer|source / Atomics.waitAsync = non-official proposals, excluded.

## 2026-08-11 /harvest-errors run (oracle-13 "honest", both lanes)

Baselines run `20260811-103533` (gitHash `9268d5a5`), oracle_version 13
`honest`. Default lane 31,776 / 43,621 official pass; standalone lane 29,519
passing records of the same 43,621 official. Cross-referenced both lanes;
**every standalone cluster >50 maps to an existing tracked issue** — the new
issues are three default-lane clusters plus one standalone leak family.

New issues:

- [#4363](../4363-bigint-typedarray-makearray-harness-coercion.md) — **NEW.**
  BigInt TypedArray paths reject the harness's own `makeArray` values —
  **287 default-lane fails**, all
  `TypeError: Cannot convert N to a BigInt (Testing with BigInt64Array and makeArray.)`.
  Largest named-category bucket in the default lane. Likely the same eager-f64
  failure mode as #1644 (`done`, scoped at 47) — see the regression note there.
- [#4364](../4364-test262-extern-class-dependency-not-provided.md) — **NEW.**
  `No dependency provided for extern class` — **224 default-lane fails** across
  9 names, 172 on `ctor`. Direct successor to #1524 (`done`): `ctors is not
  defined` is gone, but the family now fails one layer later at dependency
  injection. Most names are callback *parameters*, not globals.
- [#4365](../4365-test262-262-agent-missing-atomics.md) — **NEW.** `$262.agent`
  is `null`, so all **112 Atomics agent tests** die at `__module_init()` on
  `.bind`. Successor to #4020/#4170 (both closed, see below).
- [#4366](../4366-standalone-array-host-helper-leak.md) — **NEW.** Standalone
  array host-helper leak (`__js_array_new` / `__js_array_push` /
  `__array_concat_any`) — **542 standalone fails**, of which **195 already pass
  in the host lane** and are directly recoverable. Largest standalone leak
  family after generators.

Closed as already-fixed:

- **#4020 and #4170** — the TS8010/8017 "can only be used in TypeScript files"
  bucket is now **0 records** in both lanes; verified against #4020's own named
  sample. These two are **duplicates of each other** (identical title and body,
  same 2026-08-01 harvest; #4020's body header reads `# #3973`, so the pattern
  was filed three times). Both set `done`; #4020 is the canonical record.

Regression / residual flags on `done` issues (notes appended, status left as-is
pending a maintainer call):

- **#1073** (`done`) — `annexB/language/eval-code` still carries **184** fails
  with this issue's own root-cause shape (`assert is not defined` 120,
  `null is not a function` 64) vs **179** at close. The fix's JS-side shim list
  targets the *rewritten* harness names (`assert_throws`, …); the harness now
  emits bare `assert`, so the shim no longer matches. Not a count improvement.
- **#1644** (`done`, scoped 47) — family now 287; see #4363.
- **#1524** (`done`, scoped 202) — symptom moved, family now 224; see #4364.
- **#1171** (`done`) — **84** `compile_timeout (10s)` records remain, spread
  thinly (max 12 per directory). Sub-50 per family; no new issue.

Verified-tracked, no new issue (safe-refill pointers): standalone dynamic import
(402) → #3494 (blocked); native generator sequential-yield limit (317) → #680
(ready) / #2864 (in-progress); async completion marker not observed (264
standalone / 72 default) → #3421 (ready); `__get_builtin` dynamic-shape (118) →
#1472 (ready); `$262.detachArrayBuffer` (89) → #3975 (ready); with-statement
closed-shape refusal (66) → #1387 (done) / #2663 (in-progress);
`SharedArrayBuffer_new` leak (425) → #3178 (ready) / #1354 (backlog);
`Promise_*` leaks → #3178 (ready); generator `__gen_*` leaks → #680 / #2864.
`verifyProperty` null-receiver (112 default) spans many directories with mixed
root causes — aggregator, not one bug; not filed. ShadowRealm / Temporal =
non-official proposals, excluded by design.

**negative_test_fail**: 14 per lane, identical file set in both. 12 are
"expected runtime ReferenceError but succeeded" (TDZ / lexical-scope early
errors: `switch/scope-lex-*`, `global-use-before-initialization-*`), 2 are
early-SyntaxError-not-detected. Sub-50; covered by existing early-error
spec-gap issues (#1315/#1435); no new issue.
