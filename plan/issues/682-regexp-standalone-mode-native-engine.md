---
id: 682
title: "RegExp standalone mode: native engine or embedded library for non-JS targets"
status: done
created: 2026-03-20
updated: 2026-06-02
completed: 2026-06-02
priority: high
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: 58
owner: Raman
loc-budget-allow:
  - src/codegen/string-ops.ts
files:
  src/codegen/regexp-standalone.ts:
    new:
      - "typed native standalone RegExp ABI scaffold and engine availability hook"
      - "reduced native literal-substring backend for static standalone RegExp.test"
      - "global RegExp identifier guard so local shadows are not lowered as builtins"
      - "opaque RegExp receiver provenance guard for standalone .test"
  src/codegen/context/types.ts:
    changed:
      - "CodegenContext.standaloneRegExpEngine documents the enabled reduced backend and refusal fallback"
  src/codegen/context/create-context.ts:
    new:
      - "enable reduced standalone literal-substring RegExp engine for --target standalone"
  src/codegen/declarations.ts:
    changed:
      - "avoid pre-registering JS-host string method imports for standalone RegExp refusal paths"
  src/codegen/string-ops.ts:
    changed:
      - "explicitly refuse standalone string method RegExp/symbol-protocol search values before host fallback"
  src/codegen/typeof-delete.ts:
    changed:
      - "route standalone RegExp literals through the reduced native backend"
  src/codegen/expressions/calls.ts:
    changed:
      - "route standalone RegExp(...) and RegExp.prototype.test through the reduced native backend"
      - "route standalone RegExp.prototype.test.call(...) through the reduced native backend instead of the host prototype bridge"
      - "refuse direct standalone RegExp symbol protocol calls before JS-host helper lowering"
      - "refuse unsupported standalone RegExp.prototype.*.call(...) forms before JS-host prototype bridge lowering"
      - "preserve user-defined RegExp(...) calls by checking the resolved global declaration"
  src/codegen/expressions/new-super.ts:
    changed:
      - "route standalone new RegExp(...) through the reduced native backend"
      - "avoid treating user-defined RegExp classes as the standalone builtin"
  tests/issue-682.test.ts:
    new:
      - "standalone RegExp literal/new/call .test execution and unsupported-syntax refusals"
      - "standalone RegExp.prototype.test.call(...) execution without host prototype bridge imports"
      - "standalone RegExp call shadowing regression"
      - "standalone refusal for direct RegExp symbol protocol calls without host imports"
      - "standalone refusal for unsupported RegExp.prototype.*.call(...) without host prototype bridge imports"
      - "standalone refusal for opaque RegExp receivers not created by the backend"
      - "standalone RegExp-consuming string method refusals emit no JS-host string imports"
  tests/issue-682-regexp-standalone-abi.test.ts:
    new:
      - "pins default null hook and non-JS-host ABI shape"
  tests/issue-1474-standalone-regex-refuse.test.ts:
    changed:
      - "document that #1474 now covers forms outside #682's reduced native subset"
---
# #682 — RegExp standalone mode: native engine or embedded library for non-JS targets

## Status: done

#676 proposed host imports for RegExp. That path is now partially implemented and
was pushed forward further by [#763](../done/763.md), which completed major
js-host-mode runtime gaps such as `exec`, `match`, `replace`, `split`, and
`search` wrappers.

This issue is now scoped only to **standalone mode**. The remaining host-mode
completion work is tracked separately in `#1002`.

In standalone mode (wasmtime/WASI/native strings), there is no JS `RegExp`
object to delegate to. We need an embedded regex backend.

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). RegExp unsupported appears in 1,882
non-exclusive failures, confirming that a native RegExp backend is now a
material standalone test262 root cause rather than only a portability gap.

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The ordered root-cause classifier assigns **1,513** rows primarily to the
standalone RegExp bucket: 1,502 `compile_error` rows and 11 assertion-failure
rows. The decline from the June 1 non-exclusive 1,882 count is mostly because
earlier buckets (#1472 object dispatch and #1776 harness validation) now claim
some RegExp-path rows first; it does not mean native RegExp semantics have
landed.

Representative diagnostic:

```text
Codegen error: RegExp literals are not supported in --target standalone (#1474).
```

Example file:
`test/built-ins/RegExp/CharacterClassEscapes/character-class-non-digit-class-escape-positive-cases.js`.
This keeps #1474 as the refusal gate and this issue as the native-engine owner.

## Goal

Support `RegExp` for non-JS targets by embedding or compiling a regex engine
that works without a host JS runtime.

## Candidate approaches

### 1. Rust `regex` crate

- Official docs: [docs.rs/regex](https://docs.rs/crate/regex/latest)
- Strength: linear-time finite-automata engine, good portability, Rust/Wasm-friendly
- Limitation: explicitly does **not** support look-around or backreferences

This is a strong candidate only for a deliberately reduced standalone subset.

### 2. Rust `fancy-regex`

- Official docs: [docs.rs/fancy-regex](https://docs.rs/fancy-regex/)
- Strength: supports backreferences and look-around, while delegating simpler
  cases to `regex`
- Limitation: falls back to backtracking for “fancy” features, so worst-case
  runtime can still blow up

This is the best Rust-native candidate if we want broader JS-style feature
coverage without writing an engine from scratch.

### 3. Google RE2 / RE2-Wasm

- Official repo: [google/re2](https://github.com/google/re2)
- Wasm build: [google/re2-wasm](https://github.com/google/re2-wasm)
- Strength: fast and safe, good standalone portability
- Limitation: no backreferences or look-around by design

Good for a safe subset, not for near-ECMAScript parity.

### 4. PCRE2

- Official repo: [PCRE2Project/pcre2](https://github.com/PCRE2Project/pcre2)
- Docs: [PCRE2 manual](https://pcre2project.github.io/pcre2/doc/pcre2/)
- Strength: mature C library, wide feature support, ECMAScript-compatibility
  options, portable, embeddable
- Limitation: bigger integration surface; backtracking engine has the usual
  worst-case behavior tradeoffs

This is a serious candidate if broad syntax coverage matters more than minimal
engine size.

### 5. QuickJS `libregexp`

- Official docs: [QuickJS](https://bellard.org/quickjs/)
- Strength: includes a small regexp library described by QuickJS as fully
  compliant with the JavaScript ES2023 regexp specification
- Limitation: integration may mean extracting/adapting QuickJS’s regexp
  subsystem rather than consuming a clean standalone package

This is the highest-potential candidate for semantic alignment with JS
RegExp if the library can be cleanly isolated.

### 6. Oniguruma

- Official repo: [kkos/oniguruma](https://github.com/kkos/oniguruma)
- Strength: very feature-rich and battle-tested
- Limitation: the upstream repository was archived in April 2025

This is still technically viable, but the archival state makes it a weaker
long-term dependency than PCRE2 or a maintained Rust option.

### Phased approach

1. Decide whether standalone mode aims for:
   - a safe subset (`regex` / `RE2`)
   - or near-JS parity (`fancy-regex`, PCRE2, QuickJS libregexp)
2. Build a thin standalone RegExp ABI:
   - compile pattern
   - execute/test
   - capture groups
   - flags / `lastIndex`
3. Start with literal/class/quantifier/anchor coverage if we go custom
4. Prefer embedding an existing maintained engine over writing a full new one
   from scratch unless integration cost proves unacceptable

## ECMAScript spec reference

- [§22.2 RegExp Objects](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects) — RegExp constructor and prototype
- [§22.2.2 The RegExp Constructor](https://tc39.es/ecma262/#sec-regexp-constructor) — pattern compilation semantics
- [§22.2.7.1 RegExpExec](https://tc39.es/ecma262/#sec-regexpexec) — abstract operation for executing a regexp

## Acceptance criteria

- standalone targets can execute basic `RegExp` operations without JS host imports
- the chosen backend and its semantic limitations are documented
- if a subset engine is chosen, unsupported features fail explicitly instead of
  silently diverging from JS semantics

## Complexity

XL for near-JS parity, M only if we intentionally adopt a reduced-feature
standalone subset.

## Implementation Plan

(Author: architect, 2026-05-21. Recommendation: phased approach
starting with **QuickJS libregexp** (option 5) extracted as a C
file compiled to wasm via wasi-sdk; QuickJS libregexp is the only
candidate with explicit JS-spec semantics.)

### Implementation note — 2026-06-01 first mergeable slice

Added an implementation-neutral scaffold in `src/codegen/regexp-standalone.ts`
and threaded `CodegenContext.standaloneRegExpEngine` as a nullable hook
initialized to `null`. This deliberately keeps #1474's standalone refusal gate
closed while establishing the future native-engine contract:

- selected engine kind: `quickjs-libregexp`
- ABI version: `1`
- in-module native symbols only, not JS-host imports:
  `__re_compile`, `__re_exec`, `__re_free`, `__re_group_start`,
  `__re_group_end`
- pointer/handle ABI shape pinned as `i32` values for the first slice

The scaffold does not implement RegExp semantics yet and does not alter the
current `RegExp` constructor, literal, or `String.prototype` RegExp-argument
refusals. Next slice can link/register the embedded engine and then open the
#1474 gate by querying `hasStandaloneRegExpEngine(...)`.

Validation for this slice:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/context/types.ts src/codegen/context/create-context.ts tests/issue-682-regexp-standalone-abi.test.ts`
  - result: passed
- `pnpm run typecheck`
  - result: passed
- `pnpm exec vitest run tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 2 files / 18 tests

Full test262 was not run; this was intentionally limited to scoped checks.

### Implementation note — 2026-06-02 reduced standalone `.test` slice

Added a deliberately reduced native standalone backend named
`native-literal-substring`. This opens the #1474 refusal gate only for static
plain literal patterns with no flags and only for `RegExp.prototype.test`.
Supported construction forms:

- `/plain/.test("...")`
- `new RegExp("plain").test("...")`
- `RegExp("plain").test("...")`
- escaped literal metacharacters such as `/a\.b/`

The backend represents RegExp values as an in-module `$__StandaloneRegExp`
struct carrying the native string pattern and lowers `.test` to
`__str_indexOf(input, pattern, 0) >= 0`. It emits no `RegExp_*`,
`__regex_symbol_call`, `wasm:js-string`, or `string_constants` imports.

Unsupported forms still fail explicitly with `#682/#1474` diagnostics instead
of silently diverging from JS semantics. Current refusals include dynamic
constructor patterns/flags, all flags (`g`/`y` lastIndex state included),
metacharacters, classes, quantifiers, captures, backreferences, lookaround,
argument coercion, and RegExp-consuming `String.prototype.*` methods.

QuickJS `libregexp` remains the documented future ABI target for near-JS
parity; this slice is a compiler-native bridge for basic standalone execution.

Validation for this slice:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/context/types.ts src/codegen/context/create-context.ts src/codegen/typeof-delete.ts src/codegen/expressions/new-super.ts src/codegen/expressions/calls.ts tests/issue-682.test.ts tests/issue-1474-standalone-regex-refuse.test.ts plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 33 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Full local test262 was not run per scoped-validation rule.

### Codex verification note — 2026-06-02

Re-reviewed the reduced `native-literal-substring` backend in the assigned
`symphony/682` worktree. The implementation remains intentionally scoped to
plain static patterns with no flags and `.test()` lowering through native string
`indexOf`; unsupported syntax and RegExp-consuming string methods continue to
fail explicitly with `#682/#1474` diagnostics.

Scoped validation rerun in this attempt:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 25 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this Codex verification pass.

### Codex final implementation note — 2026-06-02

Found and fixed one remaining standalone escape path in the direct
`RegExp.prototype[@@match/@@replace/@@search/@@split/@@matchAll]` lowering.
That path is correct for JS-host mode, but in standalone mode it could compile a
direct symbol protocol call such as `re[Symbol.search](s)` instead of refusing
the unsupported operation. `src/codegen/expressions/calls.ts` now reports an
explicit `#682/#1474` compile error before it can lower to the JS-host
`__regex_symbol_call` helper.

Added a focused regression in `tests/issue-682.test.ts` proving the unsupported
symbol protocol form fails explicitly and emits no `RegExp_*`,
`__regex_symbol_call`, `wasm:js-string`, or `string_constants` imports. The
accepted reduced subset remains unchanged: static plain patterns with no flags
and `.test()` only.

Scoped validation in this final pass:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/context/types.ts src/codegen/context/create-context.ts src/codegen/typeof-delete.ts src/codegen/expressions/new-super.ts src/codegen/expressions/calls.ts tests/issue-682.test.ts tests/issue-1474-standalone-regex-refuse.test.ts plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts tests/issue-1330.test.ts`
  - result: passed, 4 files / 32 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found.

### Codex import-collector follow-up — 2026-06-02

Found and fixed a remaining standalone import pre-scan leak for
RegExp-consuming `String.prototype` methods. The lowering already refuses these
forms under `--target standalone`, but the unified import collector could
pre-register JS-host `env::string_*` imports first. `src/codegen/declarations.ts`
now skips those imports for standalone `match`/`matchAll`/`search` and for
standalone `replace`/`replaceAll`/`split` calls whose first argument requires
RegExp protocol semantics.

Aligned `src/codegen/string-ops.ts` with that collector gate so standalone
`replace`/`replaceAll`/`split` calls with non-string search values now report an
explicit `#1474` RegExp/symbol-protocol refusal before the host fallback path.

Extended `tests/issue-682.test.ts` to prove both refusal shapes emit no
RegExp or JS-host string imports:

- `s.replace(/a/g, "b")`
- `s.search("a")`

Scoped validation in this follow-up:

- `pnpm exec prettier --write src/codegen/declarations.ts src/codegen/string-ops.ts tests/issue-682.test.ts plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 28 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this follow-up.

### Codex shadowing guard and final validation — 2026-06-02

Found and fixed one remaining semantic risk in the reduced standalone lowering:
the direct `RegExp(...)` standalone branch matched only the identifier text, so a
user-defined local function named `RegExp` could be intercepted as the builtin.
`src/codegen/regexp-standalone.ts` now exposes a declaration-based global
`RegExp` guard, and both call/new-expression lowering use it before selecting
the native literal-substring backend. Explicit `undefined` constructor handling
also now checks the resolved type instead of only the identifier text.

Added a focused regression in `tests/issue-682.test.ts` proving a local
`function RegExp(...)` still runs as user code under `--target standalone`.

Scoped validation in this final pass:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts tests/issue-682.test.ts`
  - result: passed
- `pnpm exec prettier --write plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 29 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found.

### Codex `.test()` receiver shadowing follow-up — 2026-06-02

Found and fixed a narrower shadowing path in the standalone
`RegExp.prototype.test` reduction. The `.test()` fast path previously accepted
any receiver whose TypeScript type symbol was named `RegExp`, which could
intercept a user-defined local `class RegExp { test(...) { ... } }` before the
normal class method lowering ran.

`src/codegen/regexp-standalone.ts` now checks that RegExp receiver types resolve
only to declaration-file symbols before selecting the native literal-substring
backend. `src/codegen/expressions/new-super.ts` uses the same declaration-file
type guard for non-identifier constructor forms, preserving global RegExp
support while avoiding source-defined shadows.

Added a focused regression in `tests/issue-682.test.ts` proving a local
`RegExp` class with its own `.test()` method still runs as user code under
`--target standalone`.

Scoped validation in this follow-up:

- `pnpm exec vitest run tests/issue-682.test.ts --reporter verbose`
  - result: passed, 1 file / 12 tests
- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/expressions/new-super.ts tests/issue-682.test.ts plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 30 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this follow-up.

### Codex opaque receiver provenance follow-up — 2026-06-02

Found and fixed one remaining over-acceptance path in the standalone
`RegExp.prototype.test` reduction. A value typed as declaration-file `RegExp`
but supplied opaquely, such as an exported `re: RegExp` parameter, previously
entered the reduced backend and was cast from `externref` to the private
`$__StandaloneRegExp` struct. That could compile a value the backend did not
create, leaving a runtime cast trap instead of an explicit standalone refusal.

`src/codegen/regexp-standalone.ts` now requires static provenance before
casting an `externref` receiver back into the reduced backend. Direct RegExp
literals/constructors and variables initialized from those forms are still
eligible; opaque receivers now report a `#682/#1474` compile error.

Added a focused regression in `tests/issue-682.test.ts` proving an exported
`RegExp` parameter receiver is refused and emits no `RegExp_*`,
`__regex_symbol_call`, `wasm:js-string`, or `string_constants` imports.

Scoped validation in this follow-up:

- `pnpm exec vitest run tests/issue-682.test.ts --reporter verbose`
  - result: passed, 1 file / 13 tests
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this follow-up.

### Codex attempt 24 verification — 2026-06-02

Re-checked the `symphony/682` worktree against the assigned #682 scope. The
current branch remains focused on the reduced `native-literal-substring`
standalone backend: static plain patterns with no flags lower to native string
`indexOf` for `.test()`, while unsupported syntax, direct symbol protocol calls,
opaque RegExp receivers, and RegExp-consuming string methods still refuse
explicitly without registering JS-host RegExp/string imports.

No additional implementation gap was found in this pass.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in attempt 24.

### Codex current verification — 2026-06-02

Re-validated the assigned `symphony/682` branch after reviewing the reduced
standalone RegExp backend and focused #682 tests. No further implementation
gap was found in this pass: the branch still supports only static plain
patterns with no flags for `RegExp.prototype.test`, and unsupported syntax,
symbol protocol calls, opaque RegExp receivers, and RegExp-consuming string
methods continue to refuse explicitly without JS-host RegExp/string imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this verification pass.

### Codex PR-state verification — 2026-06-02

Re-read the assigned #682 implementation and focused tests in the
`symphony/682` worktree. No code changes were needed in this pass. The current
branch remains scoped to the reduced `native-literal-substring` standalone
backend for static plain patterns with no flags and `RegExp.prototype.test`;
unsupported syntax, symbol protocol calls, opaque receivers, and
RegExp-consuming string methods still refuse explicitly without JS-host RegExp
or string-method imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 is open as a draft from `symphony/682` to `main`,
with GitHub reporting a clean merge state. No blockers were found in this
verification pass.

### Codex lane validation — 2026-06-02

Reviewed the assigned #682 implementation and focused tests in the
`symphony/682` worktree. No additional code changes were needed. The branch
still implements the reduced `native-literal-substring` standalone backend for
static plain patterns with no flags and `RegExp.prototype.test`, while
unsupported syntax, direct symbol protocol calls, opaque RegExp receivers, and
RegExp-consuming string methods refuse explicitly without JS-host RegExp or
string-method imports.

Scoped validation rerun in this lane:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 remains open as a draft from `symphony/682` to
`main`; GitHub reports it as clean and mergeable, with the current check rollup
green. No blockers were found.

### Codex teammate validation — 2026-06-02

Reviewed the assigned #682 standalone RegExp implementation and focused tests
for this lane. No additional code change was needed: the branch remains scoped
to the reduced `native-literal-substring` backend for static plain patterns
with no flags and `RegExp.prototype.test`, while unsupported syntax, direct
symbol protocol calls, opaque receivers, and RegExp-consuming string methods
still refuse explicitly without JS-host RegExp/string imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 remains open as a draft from `symphony/682` to
`main`; GitHub reports it as clean and mergeable, with all reported checks
successful. No blockers were found in this validation pass.

### Codex final scoped validation — 2026-06-02

Re-reviewed the assigned #682 standalone RegExp implementation in this
worktree. No additional code change was needed. The branch remains scoped to
the reduced `native-literal-substring` backend: static plain patterns with no
flags lower to native string `indexOf` for `RegExp.prototype.test`, and
unsupported syntax, direct RegExp symbol protocol calls, opaque RegExp
receivers, and RegExp-consuming string methods refuse explicitly without
registering JS-host RegExp or string-method imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 remains open as a draft from `symphony/682` to
`main`; GitHub reports it as clean and mergeable, with all reported checks
successful. No blockers were found in this final scoped validation pass.

### Codex developer lane verification — 2026-06-02

Re-read the assigned #682 issue context, implementation, and focused tests in
the `symphony/682` worktree. No additional code changes were needed. The branch
continues to implement only the reduced `native-literal-substring` standalone
backend for static plain patterns with no flags and `RegExp.prototype.test`,
while unsupported syntax, direct symbol protocol calls, opaque RegExp
receivers, and RegExp-consuming string methods refuse explicitly without
registering JS-host RegExp/string imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 remains open as a draft from `symphony/682` to
`main`; GitHub reports it as mergeable/clean at
`8e30b7322b1656992534c962794e0467dab0f41f`, with the current reported checks
successful. No blockers were found in this developer-lane verification pass.

### Codex current handoff verification — 2026-06-02

Re-read the assigned implementation, focused #682 tests, and #1474 refusal
coverage in the `symphony/682` worktree. No additional code change was needed.
The branch remains scoped to the reduced `native-literal-substring` standalone
backend: static plain patterns with no flags lower to native string `indexOf`
for `RegExp.prototype.test`, while unsupported syntax, direct RegExp symbol
protocol calls, opaque RegExp receivers, and RegExp-consuming string methods
continue to refuse explicitly without JS-host RegExp/string-method imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 31 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. `gh pr view` reports PR #1038 open as a draft from
`symphony/682` to `main`, mergeable, at
`8e30b7322b1656992534c962794e0467dab0f41f`; reported checks are successful,
with only the baseline-promotion job skipped. No blockers were found in this
handoff verification pass.

### Codex prototype-call bridge follow-up — 2026-06-02

Found and fixed one remaining standalone host-bridge escape path:
`RegExp.prototype.test.call(re, s)` was routed through the generic
`__proto_method_call` JS-host bridge before the reduced #682 backend could see
it. In `--target standalone`, global `RegExp.prototype.test.call(...)` now
rewrites into the existing standalone `.test` lowering, so static backend
receivers still execute through native string `indexOf` with no JS-host
prototype bridge import.

Unsupported global `RegExp.prototype.*.call(...)` forms now fail with an
explicit `#682/#1474` diagnostic before `__proto_method_call` can be requested.
The generic prototype bridge also now requires the resolved declaration-file
global `RegExp`, preserving user-defined `RegExp` shadows.

Added focused coverage in `tests/issue-682.test.ts` for:

- successful `RegExp.prototype.test.call(/abc/, "zzabc")`
- refusal of `RegExp.prototype.exec.call(/abc/, "abc")` without
  `__proto_method_call` imports

Scoped validation in this follow-up:

- `pnpm exec prettier --write src/codegen/expressions/calls.ts tests/issue-682.test.ts`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 33 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this follow-up.

### Codex developer final validation — 2026-06-02

Re-audited the current dirty diff in the `symphony/682` worktree. The only code
follow-up remains the standalone `RegExp.prototype.test.call(...)` bridge fix in
`src/codegen/expressions/calls.ts`, with focused coverage in
`tests/issue-682.test.ts`. No additional implementation gap was found in this
lane.

Scoped validation rerun:

- `pnpm exec prettier --write src/codegen/expressions/calls.ts tests/issue-682.test.ts plan/issues/682-regexp-standalone-mode-native-engine.md`
  - result: passed, unchanged
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 33 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No blockers were found in this final developer validation
pass.

### Codex current validation handoff — 2026-06-02

Re-reviewed the assigned #682 implementation, focused tests, and #1474 refusal
coverage in the `symphony/682` worktree. No additional code change was needed in
this pass. The branch remains scoped to the reduced `native-literal-substring`
standalone backend: static plain patterns with no flags lower through native
string `indexOf` for `RegExp.prototype.test`, while unsupported syntax, direct
RegExp symbol protocol calls, opaque RegExp receivers, and RegExp-consuming
string methods refuse explicitly without JS-host RegExp/string-method imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 33 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. PR #1038 remains open as a draft from `symphony/682` to `main`
and is mergeable. The GitHub check rollup observed during this verification had
completed checks green while some long test262 shards were still in progress.
No local implementation blockers were found in this handoff pass.

### Codex verification refresh — 2026-06-02

Re-reviewed the assigned #682 implementation, focused tests, and #1474 refusal
coverage in the `symphony/682` worktree. No source changes were needed in this
pass. The current branch still implements the reduced
`native-literal-substring` standalone backend for static plain patterns with no
flags and `RegExp.prototype.test`; unsupported syntax, direct symbol protocol
calls, opaque receivers, and RegExp-consuming string methods refuse explicitly
without JS-host RegExp/string-method imports.

Scoped validation rerun:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 33 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review**. Full local test262 was not run per the scoped
validation rule. No local implementation blockers were found in this refresh.

### Codex implementation refresh — 2026-06-02

Found and fixed one provenance hole in the reduced
`native-literal-substring` backend. A mutable binding initialized from a static
standalone RegExp could later be overwritten with an opaque `RegExp` value, but
the `.test` lowering still trusted the original initializer and cast the current
value to `$__StandaloneRegExp`. The provenance guard now trusts `const` backend
receivers and never-written `let`/`var` backend receivers, but refuses mutable
bindings once the compiler sees writes to that binding.

Added focused coverage in `tests/issue-682.test.ts` for both sides:

- never-overwritten `let re = /abc/` still executes through the backend
- `let re = /abc/; re = otherRegExp; re.test(...)` refuses with the
  existing `#682/#1474` opaque-receiver diagnostic and emits no JS-host RegExp
  imports

Scoped validation rerun:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts tests/issue-682.test.ts`
  - result: passed
- `pnpm exec vitest run tests/issue-682.test.ts`
  - result: passed, 1 file / 17 tests
- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 35 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

Status remains **in review** for this validation note. Full local test262 was
not run per the scoped validation rule.

### Completion note — 2026-06-02

PR #1038 merged through the GitHub merge queue at
`116723fc5da1e3b1c2ce34401dd1b1105e21a689`. The landed slice is the reduced
`native-literal-substring` standalone backend for static plain patterns with no
flags and `RegExp.prototype.test`, including the prototype-call bridge and
mutable receiver provenance guard follow-ups documented above.

Post-merge rescue validation passed:

- `pnpm exec vitest run tests/issue-682.test.ts tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 3 files / 35 tests
- `pnpm run typecheck`
  - result: passed
- `git diff --check`
  - result: passed

### Phase 0 — Decision and ABI

Pick QuickJS libregexp. Rationale:

- explicit ECMAScript ES2023 semantics
- ~3000 LOC, manageable extract surface
- no backtracking blowup for non-fancy patterns (NFA-based)
- already licensed compatibly (MIT)

Define ABI in `src/codegen/builtins/regexp-standalone.ts`:

```ts
// Wasm functions exported by the embedded engine:
//   __re_compile(pattern_ptr, pattern_len, flags) -> handle (i32)
//   __re_exec(handle, str_ptr, str_len, startIdx) -> match_struct_ref
//   __re_free(handle) -> void
//   __re_get_group(match, idx) -> {start: i32, end: i32}
```

### Phase 1 — Engine integration

1. Extract QuickJS `libregexp.c` and dependencies into a new
   `vendor/libregexp/` directory.
2. Add a build step: compile with `wasi-sdk clang` to produce a
   wasm module `libregexp.wasm`.
3. Link strategy: either (a) statically embed at compile time via
   `wasmMerge` (binaryen), or (b) instantiate as a side-module at
   runtime and import its exports. Prefer (a) for single-binary
   output.
4. Convert JS strings → libregexp `JSString` representation at the
   ABI boundary (UTF-16 native strings already match libregexp's
   internal repr).

### Phase 2 — Codegen lowering

In `src/codegen/builtins/regexp-standalone.ts`:

1. `new RegExp(pattern, flags)`:
   - Allocate `$RegExp_struct` (existing).
   - Call `__re_compile`, store the handle in `$compiled` field.
   - Store source pattern + flags for `.source` / `.flags` accessors.
2. `re.exec(s)`:
   - Call `__re_exec(handle, s, lastIndex)`.
   - Build match-array struct from the returned struct.
3. `re.test(s)`: exec, check null/non-null.
4. `s.match(re)`, `s.replace(re, ...)`, etc.: route through
   exec + result processing. Reuse logic from JS-host implementation;
   only the underlying exec changes.

### Edge cases

- **Sticky `y` flag** — engine state mutated; ensure `lastIndex`
  updates per spec.
- **Unicode `u` flag** — libregexp supports this; pass through.
- **`v` flag** (ES2024) — libregexp supports it; pass through.
- **Backreferences** — libregexp supports.
- **Look-behind** — supported.
- **Named capture groups** — supported via `(?<name>...)`.
- **Compile errors** — propagate as `SyntaxError`.
- **Memory ownership** — wasm-side `$RegExp_struct` holds the
  libregexp handle; on GC, finalizer (or explicit dispose) calls
  `__re_free`. WasmGC currently lacks finalizers — use a sidecar
  cleanup registry or live with the small leak.
- **String mutability** — libregexp expects immutable input strings;
  pass copies if the source is a mutable buffer.

### Phase 3 — Test262 conformance

- `test/built-ins/RegExp/*` — target ≥85% pass in standalone mode.
- `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`
  via #1105 Tier 2.

### Dependencies

- **#1105 Tier 2** — depends on this; coordinate ABI.
- **#1539** — alternative: port `regress` (Rust). Architectural
  choice; pick one.
- **#1101 WeakRef** — finalizer story shared.

### Risks

- **Engine maintenance**: forking libregexp ties us to QuickJS
  upstream. Plan: keep a thin compatibility shim, follow upstream
  bugfixes manually.
- **Binary size**: +50-80KB for the engine. Acceptable for a
  standalone wasm; consider lazy-loading for browser targets.
- **Memory leak**: without WasmGC finalizers, RegExp objects leak
  their compiled state until process exit. Use a manual `dispose()`
  API for long-running programs.
