---
id: 5116
title: "ES2015 standalone Map/Set prototype Symbol.toStringTag"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
assignee: codex/es2015-next-lane-g
priority: high
horizon: s
feasibility: easy
reasoning_effort: max
task_type: bugfix
area: codegen
es_edition: es2015
language_feature: map-set-prototype-tostringtag
goal: host-and-standalone
files:
  - src/codegen/array-object-proto.ts
  - tests/issue-5116-map-set-prototype-tostringtag.test.ts
  - plan/issues/5116-es2015-map-set-prototype-tostringtag.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::makeCollectionGlue
---

# #5116 — ES2015 standalone Map/Set prototype `Symbol.toStringTag`

## Exact cohort and baseline evidence

This bounded slice owns exactly these three official ES2015 rows:

- `test/built-ins/Map/prototype/Symbol.toStringTag.js`
- `test/built-ins/Set/prototype/Symbol.toStringTag.js`
- `test/built-ins/Set/prototype/Symbol.toStringTag/property-descriptor.js`

The authoritative source baseline is `upstream/main` at
`5a6a42664a7967a27a2bda8b34439f789b656f9e` (2026-08-27), with Test262 at
`b363f29d3c43c626dc852744ad64a0b48a003693` and oracle version 13. The
authoritative current snapshots are `/private/tmp/js2-baseline-host-current-20260828.jsonl`
and `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`; the three
standalone records are timestamped 2026-08-28 and all have `reached_test: true`:

- host snapshot SHA-256: `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`
- standalone snapshot SHA-256: `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`
- edition-map SHA-256: `4e1b3409bb509052128fca642e1b982a0f27c4c9224a596753b498be5b421db1`

| row | host snapshot | standalone snapshot |
| --- | --- | --- |
| Map prototype tag | `pass` | `fail`: `undefined` instead of `"Map"` |
| Set prototype tag | `pass` | `fail`: `undefined` instead of `"Set"` |
| Set tag descriptor | `pass` | `fail`: `undefined` instead of `"Set"` |

The inspected edition map is
`website/public/benchmarks/results/test262-file-editions.json`; each path maps
to edition index `2` (`ES2015`). The snapshots contain 48,735 rows each and
the ES2015 host-pass/standalone-nonpass intersection contains 1,316 rows;
this plan claims only the three rows above. The cohort is separate from the
excluded 4786, 4779, 5091, 5099, 5100, 5102, 5104, 5107, and 5108 cohorts and
from active lanes e/f (#5109 and #5115).

Before the source change, the clean-upstream focused A/B through Vitest's
maintained `runTest262File` harness measured host **3/3 pass** and standalone
**0/3 pass** on source `5a6a42664a`. The standalone failures were the same
three `undefined` tag reads captured in the snapshot; the direct no-corpus
control returned code `2` at the first Map tag check.

## Root-cause hypothesis

Standalone builtin prototypes use `$NativeProto` values and a mutable
companion seeded by `ensureNativeProtoCompanionSeeder`. The seeder already
accepts optional `symbolTag` metadata and emits the specified data descriptor
(`writable: false`, `enumerable: false`, `configurable: true`) for
`Symbol.toStringTag`. However, `makeCollectionGlue` builds Map/Set glue without
setting `symbolTag`, so the companion has only the string-keyed method CSV and
the `size` accessor. A computed read of `Map.prototype[Symbol.toStringTag]` or
`Set.prototype[Symbol.toStringTag]` therefore returns `undefined` in standalone.
Host mode consults the host realm’s intrinsic prototypes and already passes.

## Implementation plan

1. Extend the collection glue factory’s call sites so Map and Set pass their
   required tag values (`"Map"` and `"Set"`) into the existing symbol-tag
   seeding path. Keep the change confined to collection prototype metadata;
   do not alter Map/Set instance storage, method bodies, or iterator behavior.
2. Add a focused regression suite that runs the exact three Test262 rows in
   host and standalone modes and checks both tag values plus the required own
   descriptor flags. Include identity and wrong-symbol controls so the test
   exercises the same mutable companion contract rather than a hard-coded
   value-only shortcut.
3. Run exact host/standalone A/B on the three rows, repeat standalone, focused
   controls, mandatory no-corpus controls, and the normal TypeScript, lint,
   format, issue, budget, and hook gates with at most two workers.

## Acceptance criteria

- Exact cohort is 3/3 pass in host and 3/3 pass in standalone, with no skips,
  compile errors, or timeouts; standalone output is host-import-free.
- `Map.prototype[Symbol.toStringTag]` is `"Map"` and
  `Set.prototype[Symbol.toStringTag]` is `"Set"`, each as an own data property
  with writable false, enumerable false, configurable true.
- Unrelated Map/Set methods, `size`, iterator identity, and non-tag symbols
  remain unchanged in both lanes.
- The focused regression, repeat/determinism check, no-corpus controls, and
  normal repository gates pass; the implementation remains bounded to the
  collection glue and its regression test.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-lane-g-20260828`.
Branch: `codex/es2015-next-lane-g`.

## Final validation (2026-08-28)

The branch was refreshed against current `upstream/main`
`fefcf1348e979651142128098b629cf7328b2517`. With the fixed project PATH and
`JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`,
the exact three-row A/B completed with host **3/3 pass**, standalone **3/3
pass**, and a repeated standalone **3/3 pass**. The focused host/standalone
controls completed **2/2 pass**; the standalone control reported zero host
imports. With `test262` temporarily absent, the same suite completed **2 pass |
6 skipped**, proving the optional corpus guard does not skip either direct
control. Corpus-backed cases use a 180-second Vitest timeout while the
maintained harness timeout remains 120 seconds.

TypeScript 5 and TypeScript 7 no-emit checks, focused Biome lint, focused
Prettier formatting, location/function budgets, issue-spec coverage, oracle
ratchet, coercion-site, IR-retirement, and `scripts/update-issues.mjs --check`
all completed successfully. The only update-index diagnostics were the
repository's unrelated generated-index/dependency drift warnings; no issue
plan was rewritten. `git diff --check` is clean and the change remains limited
to the collection glue, this plan, and the focused regression.

The implementation commit SHA, non-draft upstream PR URL, final head audit,
CI state, and review state will be appended after publication. No GitHub issue
is created or referenced.
