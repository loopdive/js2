---
id: 3418
title: "Standalone: unused harness-shim host refs leak console_log/structuredClone imports — deflates standalone conformance ~18–30k"
status: in-progress
assignee: ttraenkler/fable-dev-6
created: 2026-07-18
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen-standalone
goal: standalone-mode
model: fable
sprint: current
horizon: l
related: [3370, 3393, 2961, 2860, 1781, 3417]
---

# #3418 — the runtime shim leaks two UNUSED host imports into every standalone test

## Problem (the single highest-leverage standalone lever)

After the oracle-v8 flip (#3370) made the literal upstream harness authoritative,
the standalone (host-free) lane collapsed from **24,843 → 4,312** official passes
(−20,531). Root cause is **not** genuine host-dependence:

- `test262/harness/assert.js` and `test262/harness/sta.js` compile **100% host-free
  (0 imports)** — verified by direct compile with `--target standalone`.
- The entire collapse is `scripts/test262-fyi-runtime.js` (the runtime shim the
  literal-harness assembler prepends to every non-`raw` test — see
  `tests/test262-original-harness.ts::assembleVariant`, line ~61) leaking **exactly
  two host imports**:
  - `console_log_externref` — from `var print = function (value) { console.log(value); };`
  - `structuredClone` — from `$262.detachArrayBuffer` which calls `structuredClone(...)`.

Both `print` and `$262.detachArrayBuffer` are **unused by the vast majority of
tests**, but the compiler emits the import for any *referenced* host builtin
regardless of call-reachability. Because the shim is prepended to every non-`raw`
test, the #2961 standalone gate (`scripts/test262-worker.mjs` line ~1388,
`standalone target emitted host imports`) rejects nearly every non-`raw` test.

### Measured recoverability (oracle-v8 merged report, run 29634290540)

| Quantity | Official count |
| --- | ---: |
| standalone `host_import_leak` reclassifications | 34,409 |
| …of which **shim-only** (the 2 shim imports are the *only* imports) | **29,791** |
| …shim-only **and** passing in v7 (pure over-reclassification) | **18,763** |

Fixing the leak makes shim-only binaries genuinely host-free (0 imports → clears the
#2961 gate). Upper-bound recovery ≈ **29,791** official tests; the ≈18,763
that already passed in v7 are the honest floor. This would take standalone from
4,312 back toward ~20k — plausibly the biggest single standalone lever of the sprint.

This is honesty-preserving, NOT a #3370 regression: assert.js/sta.js keep their full
real semantics (real `Test262Error`, real constructor identity, real `throw`). The
shim leak penalises tests that never touch `print`/`$262` — removing it weakens no
assertion.

## Root cause

The tree-shaker (`src/treeshake.ts`) seeds reachability from entry **exports**, but a
test262 script has no exports — the whole top level runs as `__module_init`. So
`var print = …` and `var $262 = { global: globalThis, … }` are live top-level
statements, and codegen emits an import for every host builtin *referenced* in their
initialisers/bodies (`console.log`, `structuredClone`) even though `print()` /
`$262.detachArrayBuffer()` are never **called** from `__module_init`. An import is
currently "live" if *referenced*; it should be "live" only if *reachable via a call*.

## Implementation Plan

Two options — spec both; recommend **Option A** (principled, benefits every standalone
program, not just test262), with **Option B** as a fast interim if A slips the window.

### Option A (recommended) — import-level dead-code elimination

Prune host imports that are only referenced from functions never reachable (via a
call edge) from module entry (`__module_init` / exported functions).

**File: `src/treeshake.ts`** (or a new `src/import-dce.ts` invoked from
`src/index.ts::compile`, after codegen collects `result.imports`).
- Build a call-graph reachability set rooted at: top-level executed statements of
  `__module_init` **plus** all exported functions. A function is reachable only if it
  is *called* (direct call, `.call/.apply`, passed as a first-class value that is later
  invoked, or installed on a reachable object and later invoked). Referencing a
  function value without invoking it does NOT make its body's imports live — but be
  conservative: if a function escapes to a host boundary or is stored where the
  analysis can't prove non-invocation, keep it.
- An `ImportDescriptor` (`src/index.ts:132`) is live iff at least one reachable
  function (or a reachable top-level statement) references it. Drop non-live imports
  from `result.imports` AND from the emitted import section.
- **Critical**: dropping an import must also drop the function-index it would have
  occupied — reuse/verify the `addUnionImports` index-shift invariant (see CLAUDE.md
  "addUnionImports") so no `call`/`call_ref` index drifts. Prefer computing the live
  import set BEFORE index assignment rather than post-hoc removal.

**Edge cases**
- `print` IS called by some tests (`includes`-driven or explicit) → those keep the
  `console_log_externref` import and remain honestly host-dependent (correct).
- `$262.detachArrayBuffer` genuinely used (ArrayBuffer detach tests) → keeps
  `structuredClone`, stays host-dependent (correct).
- Do not prune imports referenced from `catch`/`finally` or generator/async
  continuation bodies that are reachable.
- Guard against pruning imports still needed by runtime-emitted helpers.

### Option B (interim, ~15 lines, runner-side) — host-free standalone shim variant

Give the standalone lane a shim whose `print`/`$262.detachArrayBuffer` don't
reference host builtins (print → host-free no-op or WASI `fd_write`;
detachArrayBuffer → `throw new Error("unsupported")`). Keep the js-host lane on the
current shim (test262.fyi parity). The standalone lane is *not* compared against
test262.fyi, so a host-free standalone shim is architecturally correct, not a
weakening.
- **File: `tests/test262-original-harness.ts`** — thread a `hostFree`/`target` flag
  into `assembleVariant`; when set, substitute a host-free runtime shim
  (`scripts/test262-fyi-runtime-standalone.js`).
- Downside: two shim variants to maintain; does not help non-test262 standalone
  programs. Prefer A; ship B only if A can't land in the window.

## Verification
- Repro (host-free confirmation): compile `assert.js`+`sta.js` alone → 0 imports;
  compile shim alone → `[console_log_externref, structuredClone]`.
- After fix: a shim-only test compiles standalone with 0 imports, clears the #2961
  gate, and runs. Scoped suite: pick ~30 shim-only files (e.g.
  `language/expressions/*`) across categories and confirm standalone pass.
- Full validation is a CI standalone-shard run: expect standalone official pass to
  jump from 4,312 toward ~18–20k. Coordinate the standalone-highwater re-seed (#3393
  mechanism) since this is a large intended INCREASE.
- Zero-regression on the js-host default lane (Option A must not drop a live import;
  Option B leaves js-host untouched).

## Notes
- Do NOT relitigate the v8 basis (#3370) — this recovers the honest gap v8 exposed.
- Umbrella: #3417. Standalone umbrellas: #2860, #1781.

## Implementation Notes (fable-dev-6, 2026-07-18)

**Chosen approach: Option A, implemented as a pre-parse source-level DCE of
provably-dead top-level pure bindings** — semantically Option A's "compute the
live set BEFORE index assignment" taken to its honest extreme: the dead code is
elided *before the parser*, so the unified import collector
(`src/codegen/declarations/import-collector.ts`, which walks the WHOLE
sourceFile including never-called function-expression bodies) never requests
the imports at all. Zero index-shift hazard, zero post-hoc import-section
surgery, benefits every standalone/wasi program, not just test262.

### Why not a codegen-level live-import set

Imports are requested by ~15 independent AST walkers that run before/during
body compilation (`collectAllSourceImports`, `collectUsedExternImports`,
`collectDeclaredGlobals`, lib-globals scan, …) and function indices interleave
with import registration (`addImport` / `ensureLateImport` +
`flushLateImportShifts`). Threading a reachability skip-set through every
walker AND keeping compiled bodies from emitting `call <import>` in dead
functions is far more invasive than eliding the dead statements at the source
layer — and post-hoc import removal after emission would require shifting
every defined-function index and every baked `call` (the exact #2043/#1787
late-import-shift hazard class).

### The transform (new `src/deadcode-elide.ts`, wired in `compiler.ts`)

`elideDeadTopLevelBindings(source, { jsMode })` — runs in `compileSourceSync`
**only for `target: "standalone" | "wasi"`** (host `gc` + `linear` lanes stay
byte-identical), after `preprocessImports` (so nothing later re-introduces
references), position-preserving (same-length whitespace blanking, identity
PositionMap → sourcemaps/diagnostics unaffected):

1. Parse with `ts.createSourceFile` (matching JS/TS script kind).
2. **Candidates**: top-level, non-exported, non-declare `VariableStatement`s
   where every declarator is a plain identifier with a **pure initializer**
   (function/arrow exprs; string/number/bool/null/regex/no-substitution
   template literals; `undefined`/`globalThis`/`NaN`/`Infinity`; object
   literals with non-computed keys, plain/method/accessor members, pure
   values, no spread/shorthand; array literals of pure elements, no spread;
   `!`/`-`/`+`/`~`/`void` of pure; parens/as-casts of pure) or no initializer.
3. **Occurrence scan** (very conservative): an occurrence of a candidate name
   is ANY identifier with that exact text, any exact-match string literal, or
   any exact-match template chunk, anywhere outside the candidate statement's
   own [start, end) range. Property names count (they are Identifiers).
   Shadowing declarations count as occurrences → conservative keep.
4. **Fixpoint**: occurrences inside *currently-dropped* statements don't
   count; iterate until stable (handles chains like `var a = fn; var b = a;`
   conservatively — `b`'s identifier initializer is impure → kept → `a` kept).
5. **Blanking**: each dropped statement's [getStart, end) is replaced by `;`
   followed by spaces, newlines preserved. The leading `;` (an
   EmptyStatement) keeps ASI/paren-continuation behaviour of the surrounding
   statements identical and terminates a directive prologue exactly like the
   original var-statement did.

For the shim: `print` and `$262` are dropped whenever the test never mentions
them (identifier OR string), which is precisely the shim-only bucket. Tests
that DO use `print` (async `doneprintHandle.js` calls `print(msg)`) or `$262`
keep the bindings and their imports — honestly host-dependent, per spec.

### Honesty argument

This is a whole-program semantics-preserving transform applied uniformly to
all standalone/wasi compiles (not test-aware, not harness-aware): a top-level
binding with a side-effect-free initializer whose name is never mentioned
again — by identifier, property name, or string — cannot be observed by the
rest of the program under this compiler's semantics (no `eval`/`with` in
standalone; `globalThis` dynamic lookup counts as a string occurrence and
blocks the drop). Dropping it changes nothing observable; the import drop is
a consequence, not a rewrite of test semantics.

### Verified (local probes)

- shim+assert.js+sta.js+body, standalone: **before** → imports
  `[structuredClone, console_log_externref]`; **after manual blanking** →
  `[]`, module instantiates with `{}` and runs assert.sameValue +
  assert.throws(Test262Error) correctly.
- assert.js+sta.js alone: 0 imports (unchanged).

### Done / Remaining checklist

- [x] Root-cause analysis + approach decision (this section)
- [x] Repro probes (.tmp/probe-3418.mjs, .tmp/probe-blank.mjs — verified
      manual blanking → 0 imports + module runs)
- [ ] `src/deadcode-elide.ts` — analysis + blanking
- [ ] Wire into `compileSourceSync` (standalone/wasi gate, after preprocessImports)
- [ ] `tests/issue-3418.test.ts` — leak gone, live-use kept, host-lane untouched,
      strict-mode variant, generality beyond the harness, edge cases
- [ ] Sample-set validation: ~20-30 real shim-only test262 files 0-import PASS
      standalone (incl. strict variants); print/$262 users keep imports
- [ ] Scoped regression: existing #2961 + standalone suites green
- [ ] PR open, CI green
- [ ] merge-queue landed *(auto-enqueue picks it up)*
