---
id: 5216
title: "ES2018 call rows — object spread descriptors, observation, and Symbol keys"
status: blocked
sprint: current
created: 2026-08-30
updated: 2026-08-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen, runtime, object-literals
es_edition: ES2018
language_feature: object-spread-copy-data-properties
goal: standalone-mode
assignee: "ttraenkler/luna-es2018-object-spread-call"
branch: codex/5216-es2018-object-spread-descriptors-r2
related: [5131]
files:
  - src/codegen/literals.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/runtime.ts
  - tests/issue-5216-es2018-call-object-spread-residuals.test.ts
  - plan/issues/5216-es2018-call-object-spread-residuals.md
---

# #5216 — ES2018 call rows: object spread descriptors, observation, and Symbol keys

## Canonical tracking

This repository-local markdown file is the sole issue record. ID 5216 was
reserved atomically with `node scripts/claim-issue.mjs --allocate` and verified
on upstream's `issue-assignments` ref for
`ttraenkler/luna-es2018-object-spread-call`. Do not create a GitHub issue. PR
bodies and handoffs must cite this file explicitly.

This implementation worktree is `/private/tmp/js2-object-spread-5216-r2-20260830`,
branch `codex/5216-es2018-object-spread-descriptors-r2`, created from exact
`upstream/main` commit `b916fae2a360988cbe9f26c090ddcd9158d461d4`
and fast-forwarded before publication to current upstream commit
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`.

## Scope and edition correction

The six `language/expressions/call/spread-*.js` rows selected during the #5131
sweep contain object spread inside an ordinary call argument. They do not
exercise #5131's iterator provider. Every fixture has `features:
[object-spread]`; `scripts/generate-editions.ts::classifyEdition` therefore
classifies them as ES2018. They are absent from the frozen 11,704-row ES2015
filter and no result here may be counted toward or claimed as progress on that
census.

The six paths are frozen in `.tmp/issue-5216-six-paths.txt` (SHA-256
`2b4de4f21df273f6c883d3cad49e339fb2d62a397516db6c9c7603e330940854`):

1. `language/expressions/call/spread-mult-obj-ident.js`
2. `language/expressions/call/spread-sngl-obj-ident.js`
3. `language/expressions/call/spread-obj-override-immutable.js`
4. `language/expressions/call/spread-obj-manipulate-outter-obj-in-getter.js`
5. `language/expressions/call/spread-obj-skip-non-enumerable.js`
6. `language/expressions/call/spread-obj-symbol-property.js`

This time-boxed handoff investigates cluster 1 only: the first three
descriptor/overwrite rows. No source implementation was made because the
cluster does not have a safely bounded single-provider fix yet. Getter
ordering, non-enumerable filtering, and Symbol-key routing remain out of scope
until cluster 1 reaches its bounded 6/6 requirement.

## Clean baseline

Before source edits on `b916fae2a3`, the exact six rows were run through the
maintained Vitest runner with `TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`,
`VITEST_MAX_FORKS=1`, `TEST262_CHUNK_INDEX=0`, `TEST262_CHUNK_TOTAL=1`, and
`TEST262_IT_TIMEOUT_MS=300000`.

| lane | pass | fail | compile error | timeout | skip | reached |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| host (`20260830-113122`) | 0 | 6 | 0 | 0 | 0 | 6 |
| standalone (`20260830-113203`) | 0 | 6 | 0 | 0 | 0 | 6 |

The standalone run used `JS2WASM_EVAL_ENGINE=quickjs` and pinned artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda` (libquickjs SHA-256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`). All
standalone rows had `imports: null`, proving zero host-import leakage; the
completion manifest recorded `registeredTests=6`, `recordedRows=6`,
`canonicalVerdicts=6`, `callbacksStarted=6`, `callbacksSettled=6`, and
`allCallbacksSettled=true`.

Host signatures were writable-descriptor failures for the first three rows,
plus non-enumerable/getter/Symbol failures for the remaining three. Standalone
signatures were descriptor failures for the first two, `NaN` for the overwrite
row, native-function SameValue failures for the observation rows, and an
`illegal_cast` for the Symbol row.

## Cluster 1 routing trace

`emitWat` on the requested clean `b916fae2a3` base showed that host and
standalone choose the same closed anonymous data-struct carrier for ordinary
object-literal spreads. A source `{c: 3, d: 4}` is an `__anon_0` struct, and
the spread result is built by `struct.new` from statically read fields rather
than `__object_assign` or a `CopyDataProperties` descriptor loop. The
multiple-spread result is another closed anonymous struct containing literal
and copied fields.

The override row has an additional carrier split. Host keeps the source as a
closed struct and lowers `Object.defineProperty` through
`__defineProperty_value`; standalone opens the source as `$Object` while the
result remains a closed anonymous struct. `compileObjectLiteralForStruct` then
stores that open value in a local typed as the source closed struct. The
standalone result has no valid closed-struct spread arm for the dynamic source,
so its later `a: 3` field is present while `b` is absent/undefined, explaining
the observed `NaN`.

The descriptor tables are not simply missing every anonymous name. In this
base, `object-runtime.ts`'s has-own/own-key/extern-get finalizers include
anonymous user structs, and `instance-props.ts` can prepend a native
`__getOwnPropertyDescriptor` arm for user-declared carriers. The remaining
failure is semantic: a closed spread result exposes typed scalar fields to
dynamic `verifyProperty` writes. Host `_safeSet` and standalone
`fillClosedStructExternSetArms` coerce an arbitrary property-helper marker into
the field type (for example, a string marker becomes `NaN` in an `f64` slot),
so the writable/configurable checks do not observe ordinary JavaScript data
property behavior. A diagnostic direct descriptor read can pass in both lanes;
that is not evidence that the later dynamic write/delete operations work.

Getter-order and Symbol-key routing were deliberately not touched.

## Cluster 1 provider investigation and blocker

The following providers were inspected on `b916fae2a3`:

1. **Spread carrier construction — `src/codegen/literals.ts`.** The narrow
   standalone overwrite defect is at `compileObjectLiteralForStruct`: an open
   `$Object` spread operand is compiled once and assigned to a local whose
   declared type is the source closed struct. The existing
   `materializeStructAsDynamicObject` helper only converts closed structs to
   open objects, while `compileHostObjectAsStruct` starts from an expression
   and does not adapt an already-compiled open local. A nullish-safe
   open-object-to-closed-struct materialization helper is therefore needed for
   this path. It cannot repair descriptor mutation of the resulting closed
   fields.
2. **Closed-field external writes — `src/codegen/closed-struct-extern-set.ts`
   and `src/runtime.ts`.** Both providers intentionally give declared closed
   fields precedence over the instance property bag. Making an unrepresentable
   dynamic marker fall through to that bag would leave static `__sget_*` reads
   and typed consumers stale or inconsistent. This is not a safe one-line
   descriptor fix; the result needs either an open dynamic carrier or a
   coordinated sidecar/read/write design.
3. **Descriptor/own-key helpers — `src/codegen/object-runtime.ts` and
   `src/codegen/instance-props.ts`.** Adding another anonymous-struct
   `getOwnPropertyDescriptor` arm would not make a typed `f64` field retain an
   arbitrary JavaScript marker. Host descriptor reading already consults the
   sidecar/closed-field path, while standalone descriptor observation and
   external writes are separate native providers.
4. **Host-path widening — `objectLiteralSpreadTakesHostPath` and call
   lowering.** Forcing every concrete spread result open would avoid the typed
   field write problem, but direct call arguments can have concrete closed
   struct parameter ABIs. An expression-specific escape/dynamic-descriptor set
   (or a coordinated caller ABI change) is required; a target, filename, or
   harness-variable special case is not acceptable.

These findings make cluster 1 a multi-provider boundary, not a safely bounded
single source edit. The r2 lane therefore stops without source changes.

### Smallest next implementation experiment

First prototype only the source-carrier half: refactor or add a helper beside
`compileHostObjectAsStruct` that materializes an already-compiled open
`$Object` spread operand into the expected closed source struct, with explicit
nullish handling, and call it only from the typed-spread loop in
`compileObjectLiteralForStruct`. Validate just the standalone overwrite row's
`obj.b === 2` and static descriptor reads. If that succeeds, separately design
the dynamic descriptor carrier (open result or coordinated sidecar/read/write
provider) before attempting the single- and multiple-spread writable/delete
checks. Do not combine these experiments or broaden to getter/Symbol rows.

## Deferred implementation and evidence plan

1. Keep the exact six paths and the renamed ES2018 focused Vitest controls in
   this worktree. The focused file was run after the rename and intentionally
   remains red on two of its three controls, as recorded below; it is a failing
   regression checkpoint, not passing acceptance evidence.
2. On a new implementation lane, run the source-carrier experiment above and
   then trace the dynamic descriptor provider separately.
3. Do not add filename, harness-variable, or target-mode special cases. Any
   eventual fix must preserve concrete typed consumers and ordinary
   `CopyDataProperties` semantics.
4. After source work, run focused assertions and the exact three cluster-1
   Test262 rows in host and standalone with one worker and the pinned QuickJS
   artifact. Require 6/6 classifications (three rows × two lanes), zero
   compile errors, timeouts, skips, and standalone imports.
5. Record every transition here before considering clusters 2 or 3. Do not
   touch getter-order, non-enumerable, or Symbol clusters in this handoff.

## Acceptance and handoff

The completed issue ultimately requires all six rows to pass in both lanes,
with descriptor flags, overwrite, getter order, non-enumerable filtering, and
Symbol identity matching ECMAScript. This time-boxed investigation stops
before implementation because cluster 1 needs at least the separate
source-carrier and dynamic-descriptor providers described above. No source
edits, commit, push, or GitHub mutation were made or authorized from this
worktree.

The source investigation used the requested exact
`b916fae2a360988cbe9f26c090ddcd9158d461d4` base. The tracking branch was then
fast-forwarded without conflict to current `upstream/main`
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`; any later implementation still
requires a fresh carrier trace and revalidation on its publication head. The
six rows are ES2018 only: this lane made zero progress on, and makes no
numerator claim toward, the 11,704-row ES2015 census.

### R2 truthful handoff (2026-08-30)

- **Disposition:** blocked pending a coordinated provider design; no source
  edits.
- **Investigated:** typed spread construction in `literals.ts`, host/native
  closed-field external writes, anonymous-carrier descriptor/own-key finalizers,
  and the concrete-call host-path widening boundary.
- **Exact blocker:** standalone can lose `b` when an open `$Object` source is
  consumed as a typed closed struct, while both lanes can coerce dynamic
  descriptor-test markers through typed closed fields. Fixing one provider does
  not fix the other without changing representation or coordinating sidecar
  reads/writes.
- **Next owner/action:** prototype the nullish-safe open-source materializer,
  validate the overwrite row, then design and measure the dynamic descriptor
  carrier. Rebase/integrate against current main before evidence publication.
- **Accounting:** all owned rows and all tracker/test paths are ES2018; zero
  ES2015 numerator progress is claimed. No GitHub issue was created or changed.

### Cluster 1 evidence (implementation deferred)

- focused controls: **1 passed / 2 failed** on current upstream with one
  compiler worker and one Vitest fork. The multiple-spread descriptor control
  passed; the single-spread control failed in the host lane and the immutable
  overwrite control failed in standalone. Compilation succeeded, and every
  standalone module passed the focused helper's zero-import assertion. Command:
  `pnpm exec vitest run tests/issue-5216-es2018-call-object-spread-residuals.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose`
- exact three Test262 rows, host: pending
- exact three Test262 rows, standalone: pending
- standalone import manifests: pending
- source diff: none
- provider rationale: recorded above; current-main integration required
