# PR 5753 — merge-queue floor failure, not delivered

## Current checkpoint scope

WeakMap registry repair is integrated as `e5f2cc15fb` (source
`9d63cb83664102e072a5edced65f7e88cf33e11c`), with explicit O0/O2 controls in
`2ab60119af` (source `e5addb7f314fc5206c84e386e19ef5f09e9a2c4e`). Agent
focused38/38 and existing33/33 pass. Default original-worker paired results
are e9 2/2, cb0/2, fixed2/2; extra forced-strict diagnostics are4/4,0/4,4/4.
Default strict-neutral elision is NOT two executions. The original fixtures and
failed exploratory controls are retained. See the committed WeakMap handoff.

Clean publication composition controls passed58/58 across class/array/WeakMap
tests before the eight additive optimizer controls, plus the separate existing
collection suite33/33. The initially requested nonexistent3172 filename selected
nothing; the real `tests/issue-3172.test.ts` was then explicitly run (33/33).
TypeScript7 and scoped formatting pass. Publication excludes the Error attempt
and no full-floor/CI25 or main-delivery claim is made.

The reviewed class producer-only prerequisite is integrated as `90330c95e9`
(source `dc12270720f0c731197bed60e469f001fb5b3d8d`); the complete two-array
repair is integrated as `79ba30cc13` (source
`abd4c907364e800c245e71c46fe4d6524974113f`). Both preserve the original failed
comparison evidence. Array own controls7/7 and pinned original2/2 pass; the
producer's focused21/21 and complete binary/module9/9 comparisons pass.
The producer fixes no class runtime assertions. Related array suite1472 has the
same documented runtime-eval-harness failure on e9 and fixed (7/8), not waived.

The parent has a separate UNCOMMITTED Error guard attempt in
`/private/tmp/js2-5753-queue-failure-20260915`; it is NOT part of this checkpoint.
It restores original Error2/2 but introduces a positive-control regression:
`Object(Symbol('boxed'))` succeeds before the guard and throws after it at O0/O2.
Eight other object controls pass; all28 primitive checks and evaluation counts
pass. The original combined positive assertion remains red. Do not publish this
attempt until its genuine wrapper dependency is resolved. Before/after exact
program logs `.tmp/5753-error-positive-{before,after}.log` retain complete WAT
and source hashes. Immutable preguard snapshot `.tmp/error-guard-before` is a
git archive of `79ba30cc13`, not a separate git checkout. Normal TypeScript7 and
LOC checks pass; an earlier wrong import/build and wrong tsconfig invocation
are retained as setup failures, not conformance evidence.

The parent composition is now mutable, so future cb comparisons must use an
immutable git archive/worktree, not assume this directory is still cb. Earlier
receipts identify the then-current source hashes and remain valid.

Published head: `3175837a9b17161d4c11bc46e01f88bf1abac42a`.
Failed merge-group: `cb07815129e65312bc8f02675644146318e1ce49`, with parents
`e9b43d3325352435aa7f84185ccb308c52ab909b` (main) and the published head above.
The queue tested the intended checkpoint, not a stale head.

CI run 34916266009 passed. Test262 run 34916265939 failed job 104217767023:
host-free passes 35661 below high-water 35767 minus tolerance 50 = floor35717.
The PR remains OPEN, held, unqueued and without auto-merge. No unresolved review
threads were present at the fresh check. Do not remove the hold, lower the mark,
change tolerance, or blindly rerun. Main delivery has not happened.

## Original comparison evidence

Preceding passing run: 34914537075, merge group
`d6de81ced13f27930c83980e498a510e044435cd`. Main `e9b43d` differs from it only
by nine benchmark-result artifact files; no compiler, workflow, package or
test262 source changed. Both corpora pin test262
`b363f29d3c43c626dc852744ad64a0b48a003693`.

Tesla retained both full reports at
`/private/tmp/js2-5753-floor-34916265939.uL4fla/{predecessor,candidate}`.
Candidate artifact ID 10376532377, archive SHA-256
`67249724f3eab6671f31a6f645dee915bfedff48ca81b2513c04d13cca92ffd0`.
Standalone original JSONL hashes:

- Baseline: `065ee96841631f86e0dfc812793b6206739e084ab3a34d797cca9448652b213c`.
- Candidate: `ca920db1af76f3cf1db9a1d48322928a0702ca3938129e83ec2c54d747ac8add`.

Rawls independently downloaded the preceding run to
`/private/tmp/js2-5940-test262-baseline.Y8tRKR/merged`, verified the same baseline
hash and recomputed the comparison. Both full reports contain 48735 unique,
identical row identities. Counting status pass with no host-import leak class:
35767 → 35661, **137 losses, 31 gains, net −106**. Every loss was previously
pass, reached_test true, and host-free. There are no pass→compile_timeout losses.
Two other timeout changes were already failing and do not account for the floor.

The green regression job compared HOST results (two losses, four gains), not
standalone clearance. All 102 successful shard jobs likewise do not clear this
absolute standalone floor.

Complete rows and reproduction comparison script are retained in Tesla's folder:
`standalone-hostfree-losses.jsonl` (137), `standalone-status-deltas.jsonl` (176),
`standalone-all-verdict-deltas.jsonl` (383), `compare-evidence.mjs` and
`source-report-sha256.json`. Counts are summaries, not root-cause partitions.

## Observed losses and current ownership

- 124 class-element own-property failures: 120 constructor `foo` checks, two
  constructor `y` checks, two instance `$` checks. Parent reproduces; Wegener
  traces actual selected property owners; Nash reviews repair scope.
- Four generator method creation/metadata tests newly emit forbidden host
  generator imports. Rawls traced source routing; exact emitted culprit of the
  async-generator case remains uninstrumented.
- Nine other cases: two Array prototype trap-order checks, four Error stack
  checks, one Iterator.join receiver check and two WeakMap key checks. Tesla
  traces these separately. Shared error wording is not proof of one cause.

## Controlled class reproduction

Candidate checkout `/private/tmp/js2-5753-queue-failure-20260915` is exact failed
queue commit `cb07815129`. Base control checkout
`/private/tmp/js2-5753-floor-base-20260915` is exact main `e9b43d3325`.
Fresh compiler/runtime bundles were built independently. Three original test
files plus original harness were extracted directly from the pinned test262 git
object; the shared corpus has untracked probes and was NOT copied wholesale.

Original expression/class/elements paths:

- `multiple-definitions-private-field-usage.js`
- `redeclaration.js`
- `field-definition-accessor-no-line-terminator.js`

Both runs used the real `test262-chunk-dynamic.test.ts` → original harness →
unified compiler-worker path, four workers, 1024 MB worker/parent limits,
standalone, QuickJS/full-runtime-eval, proposals enabled, empty IR_FIRST and
layout flags, chunk0/1. **Local Node22.23.2 differs from CI Node25.9.0**; this is
a controlled same-runtime A/B, not exact CI-runtime reproduction.

- Candidate session57639: exit1, 0/3, 18.45s; the three errors exactly match CI.
- Base session94433: exit0, 3/3, 16.55s.

Logs live in each checkout's `.tmp/5753-{candidate,base}-class-original-harness.log`.
No fixture changes, ignored assertions, host-import allowances or gate edits.
Paired diagnostic WAT now pins one original failing assertion's changed route.
Both inputs have source SHA256
`1fce5f238f0df904c433526eaccf7efae5e5afbc6c58b6ce44a3a2a588bc2609`
and assembled SHA256
`27530f8ac790b2edac5fd7260a9157129483a2e9e71e7f5d45df43d51cb82987`.
Both have zero imports. Logs are `.tmp/5753-class-route-wat-ci-options.log`
in their respective checkouts (contain NUL; use `rg -a`). These compilations
add emitWat for diagnosis; the original harness executions above are the
runtime evidence. An earlier extra-tracking attempt failed duplicate body
receipt checks; its original `.tmp/5753-class-route-wat.log` is preserved.

Nash pinned the third assert in `__module_init_chunk_1`: global31 is the class
constructor, global613 decodes to `foo`, and global614 is the exact constructor
own-property failure message. Base line151265 follows folded false/eqz;
candidate line152436 follows reified global544, ref.func515 and call_ref113.
That reified helper calls native own-property function222 (base ordinal219).
The eleven matching direct calls in `__module_init` are initialization
scaffolding, NOT those fixture assertions. This proves exposure at this one
callsite, not all 124 failures or a safe blanket bridge revert.

Wegener owns a producer-only public-class-field provenance prerequisite in
`/private/tmp/js2-5753-class-provenance-20260915`. It must leave emitted bytes
unchanged; no native own-property consumer activation is approved yet. Static
field initialization/presence and constructor identity need a coherent repair,
not unconditional constructor-false or declaration-exists answers.

## Array cycle repair in progress

Tesla's isolated `/private/tmp/js2-5753-vec-cycle-fix-20260915` retains the
two original fixtures and paired harness results: base2/2, candidate0/2 with
the exact forbidden getPrototypeOf trap, initial fix2/2. The fix stops ordinary
cycle traversal at an actual Proxy before querying its prototype. It does not
unwrap proxies or skip actual prototype installation.

New O0/O2 controls remain red: eleven prototype-query identity/value assertions
per level expose Array-specific static folds ignoring installed overrides.
Parent reviewed the actual reader and authorized the narrow additional Array
arms in `expressions/object-get-prototype-of.ts`: evaluate the receiver once,
use existing override-has/get authority (including explicit null), preserve
the intrinsic fallback and helper-index shift discipline. No typed-array
behavior change or test casts. All failed controls remain; no commit until
the repair's own checks pass. Two restored originals do not clear 137 losses.

## Additional paired Error receiver evidence

The same two private pinned corpora now additionally contain original
`built-ins/Error/prototype/stack/{getter,setter}-this-not-object.js`. The previous
three-file logs are unchanged. The five-file paired original-worker runs finish
base5/5 (session50194 exit0,48.16s), candidate0/5 (session10579 exit1,47.14s).
Both Error failures exactly identify `true` not throwing TypeError. Logs are
`.tmp/5753-{base,candidate}-class-error-original-harness.log` in their respective
trees. All options and the Node22 versus CI25 caveat remain as above.

Read-only getter WAT diagnostics in the candidate tree:
`.tmp/5753-error-getter-base-route.log` and `.tmp/5753-error-getter-route.log`.
Both source SHA256 `bba757a77bb67002cf86071d2ea551f82a336cb5bda8d14e144b886348a2b838`,
assembled SHA256 `35c7a15dedebd658ea2222aa8853a5c8a049861b73af36c1ed1aa79ec6257c0c`,
zero imports. Base732217 bytes; candidate735950 bytes. Getter bodies have the
same null/undefined-only guard; original callback calls the same dynamic
call-method dispatcher. The Function.call body changes from a TypeError-only
body to actual callable validation and apply-closure dispatch. This supports
exposure of an existing primitive guard gap, not reverting real calls. High is
reviewing the precise carrier predicate and boxed-object distinction; no Error
production changes have been released.

Rawls now implements the separately reviewed WeakMap two-row guard repair in
`/private/tmp/js2-5753-weakmap-registry-20260915` (basecb): use actual native
Symbol ID and the existing canonical registry key lookup, whose non-null result
means registered (including empty string). Prepare dependencies before the
one-time kernel capture; preserve native-provider/host distinction, original
fixtures, aliases and callback/order controls. No broad weak-collection rewrite.

## Generator source evidence (not execution proof)

The original four files under `test/language/expressions/object/` are
`__proto__-permitted-dup.js`, `method-definition/generator-name-prop-symbol.js`,
`method-definition/generator-prop-name-eval-error.js` and
`method-definition/fn-name-gen.js`. All now stop at compile_error before test
execution. First three gain `env::__create_generator` and
`env::__gen_create_buffer`; the fourth additionally gains next/result/return/throw
generator imports. The CI import refusal remains unchanged.

Change 05a791a94b, composed via bd99f7f7e1, recognizes MethodDeclaration generator
closures as well as FunctionExpression. The real native attempt in closures.ts
consults generators-native.ts, whose computed-name restriction declines those
methods; the existing fallback then emits/registers host generator support.
This explains a concrete routing dependency, not a safe blanket guard removal.
The first file also contains an async generator; its exact culprit needs proof.

These tests inspect creation, function-name descriptors or abrupt computed-key
evaluation; they do not invoke generators. A repair still must preserve lazy,
correct invocation. Do not classify generators as ordinary functions just to
remove imports. Any computed-name admission requires genuine factory/source
identity, descriptor and abrupt-evaluation controls plus nonvacuous invocation.

## Next handoff

Keep one integration owner. Diagnose and review each repair before implementing;
preserve all 137 original losses and 31 gains in the release comparison. Do not
equate fixing the largest group with clearing the full queue gate. Compose fixes
onto the actual queued-source tree, rerun the exact changed controls plus scoped
regressions, publish to the existing PR, then use the protected queue. Recheck
main ancestry/content after an actual merge. No new checkpoint PR is required.
