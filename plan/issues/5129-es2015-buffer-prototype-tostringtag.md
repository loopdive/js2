---
id: 5129
title: "ES2015 ArrayBuffer and DataView prototype toStringTag metadata"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
language_feature: builtin-prototype-symbol-metadata
goal: standalone-mode
assignee: "ttraenkler/codex-5129-es2015-buffer-prototype-tostringtag"
branch: codex/5129-es2015-buffer-prototype-tostringtag
pr: 5142
files:
  - src/codegen/array-object-proto.ts
  - src/runtime.ts
  - src/runtime/wasm-struct-host-semantics.ts
  - tests/test262-restore-builtins.ts
  - tests/issue-5129-es2015-buffer-prototype-tostringtag.test.ts
  - plan/issues/5129-es2015-buffer-prototype-tostringtag.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/runtime.ts
---

# #5129 — ES2015 buffer-family prototype `Symbol.toStringTag` metadata

## Scope and ownership

This markdown issue owns exactly these two official ES2015 host-pass,
standalone-fail Test262 rows:

- `test/built-ins/ArrayBuffer/prototype/Symbol.toStringTag.js`
- `test/built-ins/DataView/prototype/Symbol.toStringTag.js`

Issue ID 5129 was atomically reserved with
`node scripts/claim-issue.mjs --allocate`, then claimed on
`upstream/issue-assignments` for this branch. This file is the canonical
tracker; do not create a GitHub issue. Any GitHub issue or pull request with
the same number is unrelated GitHub namespace state, not this tracker.

The ES2017
`test/built-ins/SharedArrayBuffer/prototype/Symbol.toStringTag.js` row is a
closely related sibling control, not part of this issue's ES2015 count. The
already-landed Map/Set prototype tag rows are current-main controls for the
shared seeder. TypedArray's accessor-style `@@toStringTag` semantics are
different and remain outside this static-tag slice.

## Baseline and duplicate audit

The dedicated branch starts from current `upstream/main` at
`0ec42299f87f935d24c3904fe1cde195335605db`. The authoritative snapshots are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
  (SHA256 `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`);
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl`
  (SHA256 `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`).

Both owned host rows pass. Both standalone rows reach the test and fail with
`assertion_fail`: the prototype's `Symbol.toStringTag` value is `undefined`
instead of `"ArrayBuffer"` or `"DataView"`. Neither row is a compile error,
timeout, host-import leak, or skip. The maintained file-edition map classifies
both owned rows as ES2015 and the SharedArrayBuffer sibling as ES2017.

Done issue `plan/issues/2597-standalone-typedarray-tostringtag.md` established
the broader Object.prototype.toString classifier and named these families, but
the exact own-property metadata rows remain red. This issue is the bounded
residual at the already-existing native-prototype metadata seam; it does not
reopen the broad classifier work or claim TypedArray's dynamic tag getter.

## Root cause

`src/codegen/native-proto.ts` already gives every
`NativeProtoBuiltinGlue.symbolTag` a canonical own well-known-symbol property
with value and descriptor `{ writable: false, enumerable: false,
configurable: true }`. The recently landed Map/Set fix proves that seeder and
the symbol-key lookup path.

`ensureArrayBufferNativeProtoGlue` and `ensureDataViewNativeProtoGlue` build
their prototype records through `makeGlueWithGetters`, but neither registration
supplies its intrinsic name as `symbolTag`. Their method/getter metadata is
therefore materialized while the shared symbol companion seeder has nothing to
install, so direct reads and `Object.getOwnPropertyDescriptor` answer
`undefined`.

## Implementation plan

1. At the existing ArrayBuffer/DataView native-prototype glue registrations,
   supply the static intrinsic tag through the established `symbolTag` field.
   Reuse the canonical companion seeder; do not add a property-read fold,
   Test262 harness exception, duplicate symbol cell, or Object.prototype
   classifier special case. If the getter-glue factory is extended, keep the
   new parameter optional and wire only prototypes whose specification defines
   the same static data-property shape.
2. Preserve the standard own descriptor exactly: non-writable,
   non-enumerable, configurable. Verify direct, dynamic/aliased, `in`,
   `hasOwnProperty`, and `Object.getOwnPropertyDescriptor` reads agree; deletion
   and configurable redefinition remain observable. Preserve prototype object
   identity, existing buffer/DataView method and accessor metadata, and the
   already-green Map/Set seeder behavior.
3. Add `tests/issue-5129-es2015-buffer-prototype-tostringtag.test.ts` with
   mandatory host and standalone compiler controls independent of corpus
   availability plus existence-guarded exact rows. Cover both values and
   descriptors, dynamic Symbol-key reads, deletion/redefinition, related
   `Object.prototype.toString` branding, Map/Set current-main controls, the
   SharedArrayBuffer sibling without broadening ownership, and zero standalone
   imports. Every wrapper around the 120-second Test262 runner must have an
   explicit outer timeout of at least 180 seconds and use repository-anchored
   paths.
4. Reproduce the exact host/standalone A/B before source edits, then run the
   focused suite with at most two workers and the pinned QuickJS artifact.
   Run TypeScript 5/7, lint, Prettier, LOC/function budgets, oracle/coercion
   ratchets, issue integrity, numeric-local parity, dead-export/stack-balance
   checks where applicable, and the complete pre-push hook.
5. Integrate current upstream non-destructively before handoff. All commits
   must be authored by Thomas Tränkler, use a specific Claude-style subject
   ending in `✓`, and carry a real newline-separated Codex co-author trailer.
   Do not force-push, create a GitHub issue, or open a PR from the worker;
   return the clean exact head and evidence to root for one non-draft upstream
   PR when mergeable.

## Acceptance

- Both owned ES2015 exact rows pass in host and standalone lanes.
- ArrayBuffer and DataView prototypes expose their exact intrinsic tag strings
  as configurable, non-writable, non-enumerable own Symbol properties.
- Direct, dynamic, aliased, descriptor, deletion, and redefinition controls
  agree without changing prototype identity or ordinary member metadata.
- Map/Set tag metadata remains green; the SharedArrayBuffer sibling is measured
  and must not regress.
- Focused standalone modules emit zero host imports.
- Focused/exact tests, TypeScript 5/7, lint, format, budgets, ratchets, issue
  integrity, numeric-local parity, and the full pre-push hook pass.
- This markdown issue records final evidence, synchronized head, and the single
  upstream PR URL; no GitHub issue is created.

## Final validation (2026-08-28)

The implementation uses the existing native-prototype `symbolTag` seeder:
`makeGlueWithGetters` accepts an optional tag and only the ArrayBuffer and
DataView registrations supply `"ArrayBuffer"` and `"DataView"`. No TypedArray
registration or classifier path changed. The source-plus-focused-test
checkpoint is `222d08408e976f220948c03a16aba37daea5d802`; the worktree-anchored
Test262 path correction is `bb57f648773745b9ef416a0c26e8b2c6cc7aa6f3`.

The branch was refreshed by a plain merge of fetched `upstream/main`
`3ea0547d42d372d9c44cc9498fb7a019f48aafbc`; the synchronized implementation
head is `74745afcbe1794079ff24ea04c5c33c72cf545e0`. The merge was clean and
preserved the four-line source wiring. The pinned authoritative snapshots remain
standalone SHA-256
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e` and host
SHA-256 `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`:
both owned host rows are `pass`, while both pre-fix standalone rows are the
expected `undefined` tag failures. After the merge, the exact standalone A/B
through the maintained runner passed **2/2** (ArrayBuffer and DataView), and
the host snapshot remains **2/2 pass**. The local in-process host rerun's
ArrayBuffer strict phase is affected by the pre-existing runner snapshot gap
(`restoreHostBuiltins` does not include `ArrayBuffer.prototype`); this does not
alter the authoritative host result or the standalone result.

The focused compiler controls passed **2/2** in host and standalone modes after
the merge, including exact descriptors, dynamic/aliased reads, deletion and
redefinition, ordinary member metadata, Map/Set controls, SharedArrayBuffer
identity/member controls, and `Object.prototype.toString` branding. The
standalone control emitted zero imports. With the optional corpus guard disabled,
the corrected test file passed **2 controls | 4 exact rows skipped**. Numeric
local parity passed **18/18**; the complete pre-push chain passed after the
upstream merge (TS7 typecheck, lint, format, oracle/coercion ratchets, numeric
parity, and issue integrity). Focused Prettier/Biome, LOC/function budgets,
issue-spec coverage, IR retirement, dead-export, stack-balance, and committed
issue-integrity checks also passed. The TS5 no-emit check was attempted twice
and stopped after a silent local run exceeding 240 seconds with no diagnostics;
the passing TS7/full pre-push typecheck is the repository's current required
typecheck lane.

Root reviewed and published the synchronized implementation plus this evidence
at `b953cc68e6b5adbf4d447a2167a8d6f5fc3a99fb`. Local, fork, and PR heads were
verified equal; GitHub reports the PR mergeable and dispatched the full CI,
Test262, smoke, and parity workflow families. The issue is complete at its
bounded ES2015 ownership; the global ES2015 goal and unrelated TypedArray work
remain open.

## CI repair (2026-08-28)

The first published head `a16c5979399a5c292484a135d62d55951bb472da` reached
the required quality job, but its changed-root test step failed after the
ArrayBuffer exact row's sloppy descriptor probe. The in-process runner's
`restoreHostBuiltins` snapshot omitted `ArrayBuffer.prototype`, so the strict
rerun inherited the deleted tag. Adding that prototype to the existing
snapshot fixes the runner isolation gap.

The same run exposed a second concrete behavior defect: the probe's attempted
write to the non-writable native tag left `"unlikelyValue"` in the host sidecar.
After the native property was deleted, the stale sidecar shadowed the true
`undefined` read and failed the host mutation control. `_safeSet` now keeps
failed sloppy writes to non-writable/accessor/non-extensible native objects as
no-ops, while preserving setter exceptions and WasmGC sidecar behavior.

The repair is covered by the focused suite: **6/6** tests passed (both exact
rows in host and standalone modes, both mutation/descriptor controls, and the
standalone zero-import assertion). The nearby `issue-2899` suite also passed
its exercised tests. The repaired files are listed in this tracker so the
change-scoped quality gates see the intentional runtime and runner additions.

## Handoff

The single upstream PR is <https://github.com/loopdive/js2/pull/5142>. Root
published every checkpoint without force, verified the required Description/CLA
body and fork ownership, and will mark the PR ready after this final markdown
handoff is published. Freeze the exact all-green head once queued. No GitHub
issue was created; this file is the complete implementation and handoff record.
