# Native strings and TypeError — lane B handoff

Worktree: `/private/tmp/js2-3518-native-string-errors-20260908`.
Branch: `codex/3518-native-string-errors-20260908`.
Exact base: `5118637e0e9b34291465230428447e511958faa1`.
Scope: section 3 of `3518-native-value-materialization-high-plan-2026-09-08.md` only.
Status: all eight production files High-approved (parent report); two bounded harness
repairs complete and frozen pending High review. Repair TS7 and 24-test suite are terminal
with exit 0. Parent has integrated the exact test/fixture hashes and independently checked
all four donor spans/full-source hashes against the exact base. Parent's composed TS7 plus
213 tests are reported live in terminal `99746`; that result is pending and not claimed here.
Parent owns the heavy slot. No lane B commit, hooks, push or PR.

## Frozen SHA manifest for High review

HEAD remains the exact base above; the implementation is uncommitted. These SHA-256
content hashes freeze eight production files, the repaired test, and the new fixture for
review. All eight production hashes are unchanged from the approved manifest. The repaired
test replaces the prior test hash `3f1a5ba67d64337e58f9b9b591d862f10e6a35c93c74c64c97e3a00b21293b6b`.
No source/test edits or additional tests were made while updating this handoff. It is excluded
from its own content manifest to avoid a self-referential hash.

```text
8e30d0c98c75cb4feb3924050fe02a6e911eb0e9b459391ba2598fcd96b19979  src/codegen/registry/types.ts
8e330f3d2f7a46df6c984b2cbf8c9911c744d28d48c96739379be57342308f61  src/codegen/native-string-literals.ts
7eba69f6c2e29e27991c689f3871b78a640e9e440680ac6862d831203d82a5a9  src/codegen/registry/error-types.ts
c821a11a15d7fbdb9caa71de856a2da588489795c6fd9d1ab6d2fcb4ecada9fc  src/runtime/wasmgc/values/string-layouts.ts
104d50d12433c75afb883750dee69c0a785178f5dd39f2b1af4debdab8d825e3  src/runtime/wasmgc/values/string-literal-bodies.ts
b9f77e2096002d7bf5c351d7e6a6c856f92135d6ee813ae102309966d7a6f235  src/runtime/wasmgc/values/error-bodies.ts
5ede01998da81d15e01ef30e52f2a8d810f484a9a0628ee1dafd51e80b4da342  src/backend/wasmgc/resources/native-string-literals.ts
1e16370cd039ee5e3afc9399606b438485874aab20a6c7554aec52fba1bae36f  src/backend/wasmgc/resources/native-errors.ts
17c43b01151c5f3e0b8dbb132ea9b0c17ae50ba9c6f50f4f87cd31d14b5992a6  tests/issue-3518-native-string-error-resources.test.ts
b579a8d1d0c251ec9a5661f2602da72a90d96991e5915304a013dadc9fc5de61  tests/fixtures/issue-3518-native-string-error-donors.json
```

## Frozen integration interface

From `src/backend/wasmgc/resources/native-string-literals.ts`:

- `reserveNativeStringLiteralResources(tx, { key, utf8Storage, literals: [{ value, encoding? }] })`
  returns `NativeStringLiteralReservations` with frozen `layout`, `types`, and ordered `literals`.
- `fillNativeStringLiteralResources(tx, reservations)` fills the actual global initializers and
  oversized helper bodies after the parent's single `tx.freezeReservations()`.
- `requireNativeStringLiteral(tx, reservations, text)` authenticates owner identity and returns
  an owned binding: `{ kind: "global", text, global, representation: "gc" }` or
  `{ kind: "callable", text, function, representation: "gc" }`.
- The complete ordered demand list must include `"then"`, `"Chaining cycle detected for promise"`,
  and `"TypeError"` for Promise/error integration. These are real initialized native strings.
  Their short lengths select global bindings. Duplicate demand keys reuse the same reservation.
- Reserve this canonical family once per module with the complete ordered literal demands.
  Layout indices retain the existing names: `nativeStrDataTypeIdx`, `anyStrTypeIdx`,
  `nativeStrTypeIdx`, `consStrTypeIdx`, `hashedStrTypeIdx`, `utf8StrDataTypeIdx`, `utf8StrTypeIdx`.
  The last two are `-1` when UTF8 storage is disabled.

From `src/backend/wasmgc/resources/native-errors.ts`:

- `reserveNativeErrorResources(tx, { key }, { strings, typeErrorTag })` returns the owned
  `{ type, newTypeError }` reservations. `strings` is the exact string pack above;
  `typeErrorTag` must come from the existing `BUILTIN_TYPE_TAGS.TypeError` authority.
  The resource operation validates the TypeError ABI value, -11.
- `fillNativeErrorResources(tx, reservations)` fills the one-argument
  `(externref) -> externref` constructor with the authenticated native name read.
- Constructor initialization: tag, supplied message, native TypeError name converted to
  externref, null stack, userClassId -1, null props. No eager property bag allocation.
- No builtin tag catalog copied or relocated. Production resource/body files have no imports
  from codegen, frontend, or legacy registries. Any future canonical tag relocation requires
  the explicit parent-reviewed scope amendment from the plan.

Parent sequence: reserve prerequisites and the complete string pack; reserve Error and other
families; freeze once; fill strings and errors alongside the other real implementations;
publish with ledger indices; seal. Never use a callable handle as a publication index.
This pack does not activate the Promise consumer or its dependency admission policy.

## Canonical extraction and legacy receipts

- `src/runtime/wasmgc/values/string-layouts.ts` owns all seven selected string descriptors
  plus the six-field Error descriptor. The legacy registry calls them at its original
  append/cache sites, preserving all hash/cache, cons-link, backing-array and Error mutability.
- `src/runtime/wasmgc/values/string-literal-bodies.ts` owns selection, UTF8 encoding,
  UTF16 hash, 10,000-code-unit chunking, initializers, and oversized rope body/locals.
  `src/codegen/native-string-literals.ts` retains legacy interning and allocator ownership,
  including the original u8/u16/helper keys and helper ordinal behavior.
- `src/runtime/wasmgc/values/error-bodies.ts` owns the constructor instruction sequence.
  The legacy adapter still checks its constructor cache, registers the name first, interns
  the original signature name, then mints/registers the function and builds the canonical body.
  The existing host-name and absent-name cases remain explicit legacy-only representations.
- The repaired focused test loads a SHA-256-pinned, repository-local donor fixture containing
  verbatim spans from the exact base. Test collection requires no historical Git objects:
  no `git show`, fetch, skip, or live-source fallback. Missing/altered fixtures fail loudly.
  It executes the extracted donor bodies and compares binary bytes and WAT against the live
  adapters, then compares the physical resource route against those live adapters.
  The donor harness retains the unchanged function allocator/signature interner and string-name
  registration helper. Its name reader is now the exact original `stringConstantExternrefInstrs`,
  including `nativeStrings && nativeStrTypeIdx >= 0` and missing/negative-global fallback,
  with the original donor literal helper injected as its dependency. It is not a full compiler A/B.

## Changed paths

- `src/codegen/registry/types.ts` — Error/string layout production only.
- `src/codegen/native-string-literals.ts`
- `src/codegen/registry/error-types.ts` — shared constructor extraction only.
- `src/runtime/wasmgc/values/string-layouts.ts`
- `src/runtime/wasmgc/values/string-literal-bodies.ts`
- `src/runtime/wasmgc/values/error-bodies.ts`
- `src/backend/wasmgc/resources/native-string-literals.ts`
- `src/backend/wasmgc/resources/native-errors.ts`
- `tests/issue-3518-native-string-error-resources.test.ts`
- `tests/fixtures/issue-3518-native-string-error-donors.json`
- This handoff.

No edits to `any-helpers.ts`, `registry/imports.ts`, consumers, boundary policy, Promise code,
or peer worktrees. Existing `/Users/thomas/Code/js2/node_modules` is symlinked here; no install.

## Validation and limits

Focused command: `VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-3518-native-string-error-resources.test.ts`.
Observed result: **14/14 tests passed — NOT SERIALIZED; no parent grant**, one file,
12.55 seconds wall time (1.07 seconds test execution), run at 20:35:13 local time on
2026-09-08 during the parent's exclusive 259-test slot. This violated slot ownership;
the result is not an authorized serialized validation receipt. Earlier focused runs
also had no explicit parent grant. At that checkpoint the runtime bodies were not typechecked;
the later authorized receipt below supersedes that typecheck status, not the slot violation.
Source formatting and scoped tracked-file
`git diff --check` also passed. No full compiler, corpus or prepared-replay result is claimed.

Coverage includes base/live/resource byte and WAT parity, UTF8 selection and rejection of stale
surrogate evidence, UTF16 overflow fallback, hash arithmetic, repeated-literal interning,
oversized ropes including surrogate pairs split between leaves, host-name arities 0/1/3,
legacy constructor caching/name registration, and execution of all six TypeError fields.
Negative cases cover foreign/forged packs, wrong target/tag, missing name, stale descriptors,
missing global/function fills, duplicate fill and altered completed initializers.

The full plan and local memory index were read before edits, along with the shared-structure,
dependency-linking, and late-body-rebuild memories. The older absolute memory path supplied
in the workspace instructions does not exist; this worktree's `.claude/memory` was available.

All compiler, Vitest (including focused tests), TS7/type checking and hooks require an
explicit parent grant. The granted TS7/focused rerun is complete; no further runs are permitted
without another grant. Broad suites, source-ratchet gates and hooks remain unrun. Parent reported
its publication hook terminal with an LOC failure before granting this slot. Lane B remains
frozen for High review. No commit/push hooks without another grant. No commit/PR before parent High review and
the normal checks. Unfiltered Git status/diff triggers a sandbox-blocked Git LFS clean filter
on unrelated `website/public/acorn/acorn.wasm`; owned-path checks work. No LFS state was changed.

Literal-only completion does NOT close native-string scanning/flattening/exponent/power-table
dependencies for number unboxing. Formatting, concat, stdout, fresh-process prepared replay,
full-family execution, Promise integration, strict closure and the ABI30 witness remain open.

## Earlier authorized 14-test terminal receipt — 2026-09-08

Parent explicitly granted exclusive TS7 followed by the focused 14-test rerun, with 2 GiB,
one fork and no file parallelism, and stated it would not launch heavy work until this lane's
terminal receipt. Commands ran sequentially in the worktree named above. Neither source nor
test files changed during that run. All nine SHA-256 hashes matched the then-current manifest
(including the old test hash recorded above). HEAD remains `5118637e0e9b34291465230428447e511958faa1`;
the implementation is still uncommitted.

TS7 command:

```sh
NODE_OPTIONS=--max-old-space-size=2048 GOMEMLIMIT=2GiB GOMAXPROCS=1 node --max-old-space-size=2048 node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

- Started after the 18:40:43 UTC clock receipt (20:40:43 Europe/Berlin).
- Terminal session `16192`; terminal output chunk `3c3195`; **exit 0, no diagnostics**.
- Terminal observed before the next command's 18:41:28 UTC clock receipt.
- Installed TypeScript version: 7.0.2. The checked project is `tsconfig.ts7.json`, which
  includes `src/**/*.ts` and excludes tests; the focused test file was not statically typechecked.
- Node launcher: 2048 MiB V8 old-space limit. TS7 launches/execs its native Go binary, so
  `GOMEMLIMIT=2GiB` supplies its Go soft memory limit (2,147,483,648 bytes) and
  `GOMAXPROCS=1` limits Go execution concurrency. These are not an OS total-RSS hard cap.

Focused Vitest command:

```sh
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run tests/issue-3518-native-string-error-resources.test.ts --pool=forks --poolOptions.forks.singleFork --maxWorkers=1 --no-file-parallelism
```

- Started at 20:41:28 Europe/Berlin (18:41:28 UTC), after TS7 terminal.
- Terminal session `43738`; terminal output chunk `1f376d`; **exit 0, 14/14 passed, 1/1 file**.
- Vitest 3.2.4 reported 10.05 seconds total, 878 ms test execution.
- Runner and fork: explicit 2048 MiB V8 old-space limit. The existing Vitest config reads
  `VITEST_FORK_MAX_OLD_SPACE_SIZE` into the worker's `--max-old-space-size` argument.
  `singleFork`, `maxWorkers=1`, `VITEST_MAX_FORKS=1`, and `--no-file-parallelism` were explicit.
  The old-space limits do not claim a combined-process or total-RSS cap.

Both commands are terminal; the exclusive slot is released. No compiler, test, TS7, commit,
push or hook process from this lane remains running. No further execution or publication
is included in this grant. This is an authorized serialized receipt; the earlier 20:35 run
remains labeled NOT SERIALIZED above.

## High-requested bounded harness repairs

Only the test and new fixture changed during this repair phase; production and integration
files were not edited. Parent composes approved production and boundary changes in its own
integration tree. The new fixture is retained here for parent publication; no lane B commit
has been made.

P1: replaced historical Git reads during collection with
`tests/fixtures/issue-3518-native-string-error-donors.json`. Its pinned whole-file digest
authenticates schema/base, four ordered donor roles/paths, original full-source hashes,
span offsets and lengths, exact span text and span SHA-256 digests. A rewritten self-reported
span hash cannot bypass the independently pinned whole-fixture digest. Parent reports having
independently checked the four spans and their full-source hashes against `5118637…`.

P2: replaced the simplified name-read substitute with the exact original helper. Controls
exercise native materialization first, then host global zero, unavailable native layout,
missing globals, and negative sentinels. Seven mutants are rejected after a genuine positive
control: native branch removal, native-mode guard removal, native-layout guard removal,
zero-layout admission removal, missing-global fallback removal, negative-global fallback
removal, and disabling the complete fallback. Three additional tests authenticate the fixture,
reject altered/missing/wrong-base receipts, and check the genuine name-read branches.

The original 14-test describe block is unchanged and checked against fixture-pinned SHA-256:
`77204eda79efa65638198bed5fd8444d57f5c15068eed9c159ed5a8c0e605750`.
Final population is **14 original + 10 repair controls = 24 tests**.

Checked donor span SHA-256 values:

```text
29e9411eec2d3570164933daea2ea574bd50900f63ace9053b9e93cab7d99fdd  layouts
480a80540b7ca191783523678e4a23a489e6881e2a925639a45b72c8eb0ac0df  literals
f0fd9323ce83fc44b0160dc149a534b1207be8dbcf4a2e6823abdcab82f639c4  constructor
e7260e2c69ebadc75c61100483ce32504f9a348f69294b48ccb92aa3563e1019  nameRead
```

## Final authorized repair terminals and parent handoff

The exact TS7 and Vitest commands are retained in the preceding terminal receipt. The repair
phase used those same 2 GiB/single-fork/no-file-parallelism settings, with an explicit parent
grant for each launch interval.

- Repair TS7 session `93359`, output chunk `c9f357`: **terminal exit 0, no diagnostics**.
  This checks `src/**/*.ts`; tests remain outside that static typecheck project.
- First repair Vitest session `16424`: its wait was interrupted and the terminal handle became
  unavailable. Result **unconfirmed**, not counted as a passing receipt; no process was killed.
- Parent then owned its brief boundary slot and reported terminal `42053`, exit 0:
  82 modules, 298 edges (194 type / 104 runtime), no errors. These are parent-reported results,
  not measurements made by this lane.
- After explicit parent release/regrant, only Vitest was rerun because TS7 was already terminal.
  Final repair Vitest session `53859`, output chunk `75cc02`: **terminal exit 0, 24/24 passed,
  1/1 file**. Started 20:56:44 Europe/Berlin on 2026-09-08; duration 10.34 seconds, test execution
  890 ms. Runner and worker each used 2048 MiB V8 old-space, one fork, no file parallelism.
- After that terminal, the eight production hashes and repaired test/fixture hashes were
  re-read and frozen as shown above. The slot was released to parent.

Parent now reports exact-hash integration and independently authenticated donor provenance.
Its composed TS7 + 213-test run is live in `99746` at this handoff update. Lane B does not poll,
restart, kill, or launch any work while parent owns the slot. No hooks/PR/publication authority
has been granted. The remaining High review and composed results belong to parent.
