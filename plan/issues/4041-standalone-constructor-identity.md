---
id: 4041
title: "standalone RegExp constructor write/species leaks env::Object_set_constructor (7 ES2015 rows)"
status: blocked
sprint: current
created: 2026-08-02
updated: 2026-09-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, regexp
language_feature: regexp, constructor, species
es_edition: ES2015
goal: standalone-mode
related: [1781, 3006, 3051, 4040, 4444]
checkpoint: 2026-09-01-original-harness-reachability-handoff
test262_fail: 7
origin: "2026-09-01 immutable f841 standalone census; exact env::Object_set_constructor ES2015 residual."
---

# #4041 — standalone RegExp constructor-write/species host-import leak

## Reopen decision and immutable evidence

The original 2026-08-02 sizing is stale and mixed unrelated Object/Number read
identity rows. #3006 later completed the genuine builtin-constructor **read**
carrier and explicitly deferred the distinct `Object_set_constructor` write
tail. The immutable f841 ES2015 census now isolates exactly seven rows, all in
the RegExp constructor/species surface, with one host-import signature:

~~~
standalone target emitted host imports: env::Object_set_constructor (#2961)
~~~

| Item | Value |
| --- | --- |
| Source baseline | `f841cddc0f0ea665b63700d9944a4372a34a8b57` |
| Census JSONL SHA-256 | `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf` |
| Frozen ES2015 denominator | 11,704 |
| Exact residual | 7 `compile_error`, 0 pass/fail/timeout |

### Exact seven paths

1. `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-undef.js`
2. `test/built-ins/RegExp/prototype/Symbol.split/splitter-proto-from-ctor-realm.js`
3. `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-species-undef.js`
4. `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-err.js`
5. `test/built-ins/RegExp/call_with_regexp_not_same_constructor.js`
6. `test/built-ins/RegExp/prototype/Symbol.split/species-ctor-species-non-ctor.js`
7. `test/built-ins/RegExp/prototype/Symbol.split/species-ctor.js`

## 2026-09-01 research checkpoint — no production implementation shipped

The exact isolated runner was repeated from this issue worktree against the
then-current upstream-base `2c3c27a54f` with the maintained command:

~~~sh
node --import tsx scripts/run-test262-paths.mts \
  .tmp/4041-regexp-constructor-paths.txt --isolate --standalone
~~~

Its result remains **3 pass / 4 fail**:

| Partition | Exact rows | Verdict |
| --- | --- | --- |
| Existing controls | `species-ctor-ctor-undef`, `species-ctor-species-undef`, `call_with_regexp_not_same_constructor` | pass |
| Local provider infrastructure | `splitter-proto-from-ctor-realm` | fail: QuickJS provider is not built in this worktree; not a semantic verdict |
| Reachable semantics | `species-ctor-err`, `species-ctor-species-non-ctor`, `species-ctor` | fail: no expected abrupt completion / wrong split result |

The candidate implementation was deliberately removed before this checkpoint:

- [`src/codegen/expressions/assignment.ts`](../../src/codegen/expressions/assignment.ts)
  briefly routed proven native-RegExp `.constructor` writes through the
  ordinary sidecar MOP.
- [`src/codegen/regexp-standalone.ts`](../../src/codegen/regexp-standalone.ts)
  briefly added a dirty-only SpeciesConstructor path and a first-class
  `RegExp.prototype[Symbol.split]` bridge.

Small direct compiler probes showed that the candidate write/read path could
avoid `env::Object_set_constructor` and preserve an own closure value, but the
authoritative original-harness run gained **zero** rows. The native-prototype
bridge also made no difference to the three reachable semantic failures.
That is insufficient evidence that the original-harness wrappers reach either
candidate seam, so the code was removed rather than shipping an inert
host-free-looking route. TS7 type checking passed while the candidate was
present; it is recorded only as a structural check, not semantic validation.

### Precise handoff

1. Instrument the canonical `runOriginalHarnessVariant` compilation shape (not
   `wrapTest` or a hand-written repro) to record which assignment lowering and
   first-class `RegExp.prototype[Symbol.split]` reification route each of the
   three reachable rows uses.
2. Trace that route through the existing #3006 constructor carrier and #3051
   raw-closure write representation. Establish the real `[[Set]]` and
   `SpeciesConstructor` boundary before adding another fast path.
3. Implement only at the proven route; retain Proxy/exotic refusal boundaries,
   accessor/deletion/reassignment/order/abrupt behavior, and the seven-row
   runner as the acceptance gate. A direct-probe zero-import result alone is
   not sufficient.

No GitHub issue was created. This checkpoint is documentation/handoff only;
the semantic fix remains blocked on original-harness reachability evidence.

### Publication environment note

An initial normal pre-commit attempt, without `--no-verify`, exposed a
transient cached-runtime problem: its `node` overlay lacked `npx`, and the
cached `pnpm` fallback began reinitializing the shared repository
`node_modules` while attempting an unavailable package download. That owned
process was terminated with `TERM`; no install was retried from this
checkpoint. The prescribed canonical-workspace recovery subsequently restored
the module metadata and relevant links (including TS7 7.0.2, Vitest 3.2.4, and
Prettier 3.8.1). The observation is now resolved local tooling context, not a
validation failure or a reason to claim the semantic fix.

## Ownership boundary

- #3006 owns builtin `.constructor` value **reads** and names this write tail as
  deferred; reuse its genuine constructor carrier instead of inventing another
  identity.
- #3051 records that the current `Object_set_constructor` → `_safeSet` route can
  store a raw closure representation. Preserve the representation contract when
  moving the write host-free.
- The task owns only RegExp `constructor` writes/species derivation for the seven
  paths above. It does not own general Proxy MOP support, other RegExp symbol
  protocol semantics, constructor reads, or arbitrary object-property writes.
- Recheck active worktrees and open PRs immediately before production edits;
  the dirty root checkout is user state and must never be used as an
  implementation worktree.

## Implementation plan

1. Re-run the exact seven paths on current upstream main `2c3c27a54f` with the
   maintained isolated path runner and record the current verdict/import set.
   `runTest262File` alone is insufficient because it can satisfy host imports.
2. Trace the precise assignment that registers `Object_set_constructor` and
   partition direct RegExp-instance writes from species-constructor reads. Add
   a focused unit probe that asserts the standalone module has zero host imports
   before changing the emitter.
3. Route the supported RegExp carrier's ordinary `constructor` data-property
   write through the existing native object/sidecar MOP and the same genuine
   constructor value representation used by #3006. Preserve strict-write
   failure, accessors, deletion/reassignment, evaluation order, and abrupt
   completion; do not replace observable species lookup with a static constant.
4. Keep Proxy targets and arbitrary exotic receivers on their established loud
   boundary unless their full `[[Set]]` semantics are already supplied by the
   shared runtime. A CE→wrong-value conversion is a regression, not progress.
5. Add controls for the default RegExp constructor, an own constructor value,
   `undefined`, throwing getters/species, non-constructor species, and the
   existing #3006 read-identity suite. Run host and standalone for the owned
   seven paths, then a focused RegExp Symbol.split/copy-constructor regression
   sweep plus TS5/TS7, lint/format, host-import, oracle, LOC/function, and issue
   integrity gates.

## Delivery

A seven-row pass with zero host imports and green controls is a completed,
mergeable non-draft PR. If faithful writes require missing Proxy/exotic MOP
support, update this file with the exact dependency and publish only a genuinely
nonmergeable draft checkpoint. No GitHub issue is created.
