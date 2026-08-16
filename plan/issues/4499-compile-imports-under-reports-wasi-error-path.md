---
id: 4499
title: "compile() result `imports` under-reports: reports [] while the binary links wasi_snapshot_preview1 on any throw-under-wasi path"
status: ready
sprint: Backlog
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: correctness
related: [2867, 2895, 1326]
---

# `CompileResult.imports` under-reports the WASI error-path imports

## Problem

`compile(src, { target: "wasi" })` returns `imports: []` for a module whose
emitted binary genuinely imports `wasi_snapshot_preview1.fd_write` and
`wasi_snapshot_preview1.proc_exit`. The reported list and the binary's real
import section disagree.

This matters beyond cosmetics: `r.imports` is the project's **host-free oracle**.
A test that asserts `expect(r.imports).toEqual([])` is asserting "this module
needs no host", and for any throwing program under `--target wasi` that assertion
currently passes **vacuously**.

## Measured evidence

**Provenance: measured 2026-08-15 on `9e17d34f3` + the #2867 boundary commit
`5cde3f054`, via `.tmp/gap2-trigger.mts` / `.tmp/gap2-imports.mts`, comparing
`r.imports` against `WebAssembly.Module.imports(await WebAssembly.compile(r.binary))`
for the same `CompileResult`.** All rows `--target wasi`.

| source shape | binary imports (truth) | `r.imports` (reported) |
|---|---|---|
| async fn, **no throw** | *(none)* | `[]` — agrees |
| `try { throw 1 } catch {}` — sync, caught | `fd_write` | `[]` **under-reports** |
| `throw 1` — sync, uncaught | `fd_write` | `[]` **under-reports** |
| async throw → `.then` reject handler | `fd_write`, `proc_exit` | `[]` **under-reports** |
| async throw, no reject handler | `fd_write`, `proc_exit` | `[]` **under-reports** |
| async throw, no `await` | `fd_write`, `proc_exit` | `[]` **under-reports** |
| throwing `.then` handler | `fd_write`, `proc_exit` | `[]` **under-reports** |

Two independent facts:

1. **Any `throw` under `--target wasi` links the WASI error path.** Even a
   plain caught sync `throw` pulls in `fd_write`. That behaviour is consistent
   with the documented purpose of the target (`--target wasi` emits WASI imports
   instead of JS-host ones) and is **not** what this issue asks to change.
2. **`r.imports` does not report it.** That is the defect.

## How it surfaced

`tests/issue-2867-gap2.test.ts` asserted `expect(r.imports).toEqual([])` and then
called `WebAssembly.instantiate(r.binary, {})`. The assertion **passed** (because
of this bug) and the instantiate then failed with:

```
WebAssembly.instantiate(): Import #0 module="wasi_snapshot_preview1":
  module is not an object or function
```

Three of that file's five cases throw on purpose, which is exactly the three that
failed. A/B by file copy against the #2867 S2/S2b source changes reproduced the
identical failures on the pre-#2867 base, so this is **pre-existing on main** and
was not introduced by that commit.

## Blast radius — census

**Provenance: measured 2026-08-15 by `.tmp/imports-census2.mjs` over all 3,278
`.ts` files under `tests/`.**

| population | count |
|---|---:|
| test files mentioning `.imports` | 1,463 |
| test files **asserting an empty import set** via that oracle | **213** |
| …of those, also `instantiate(binary, {})` | 177 |
| …of the 213, asserting on a `wasi`/`standalone` target | 195 |
| …of those 195, whose file also contains a `throw` (**upper bound** on at-risk) | **60** |

**It breaks measurement TOOLING, not just tests — which is the stronger priority
argument.** Measured 2026-08-15 during #4500 Slice B: an ad-hoc probe harness
that signals "wrong value" by `throw`ing had **every single row** die at
`WebAssembly.instantiate` under `--target wasi`, because the throw linked
`fd_write`/`proc_exit` and `r.imports` reported `[]` so the harness built no
shim. The rows were not failing — the instrument was. A defect that silently
converts "my measurement is broken" into "the compiler is broken" costs far more
than a vacuous assertion, and it will keep doing so to every future lane that
writes a throw-based oracle.

**Second worked example, same failure mode one layer up (2026-08-15).** During
#4500 Slice A a probe harness invoked `instance.exports.__module_init?.()`;
`--target wasi` exports **`_start`**, so the optional call was a silent no-op and
every wasi row reported "ok" without executing an instruction — producing a false
"the defect is standalone-only" finding that reached an issue file and a slice
plan before a contradicting probe exposed it. Different symbol, identical shape:
**an instrument reporting a state it never observed, with success as the default
answer.** The lesson generalises past this issue — a probe must make "I did not
actually run/see it" a hard error, never a pass.

The 60 is an **upper bound, not a confirmed-broken count**: the regex counts a
`throw` anywhere in the file (including in the test's own assertion helpers), not
specifically inside compiled source. The precise at-risk set is "asserts empty
imports for a wasi/standalone module whose *compiled source* throws". Only a
subset of those will fail loudly — a file only breaks when it *also* instantiates
with a bare `{}` (`tests/issue-2867-gap2.test.ts` was one; `tests/issue-2007.test.ts`
and `tests/issue-2978-forawait-rejected.test.ts` are the other two matching the
narrow throw+target+empty-assert filter and are worth checking first).

> **Correction, recorded deliberately.** An earlier hand-run `grep | wc -l`
> during the #2867 CI-fix reported "67 test files" for this population. That
> number came from a malformed alternation in a non-extended `grep` and is
> **wrong**. The oracle-assertion population is **213**; 60 is the throw-adjacent
> upper bound. Re-derived with the script above rather than re-quoted.

## Suggested fix

Two separable pieces:

1. **Make `r.imports` truthful.** The WASI error-path imports are added late
   (they are pulled in by the throw/abort lowering), and the reported list is
   evidently snapshotted before or beside that step. Reporting must be derived
   from the same structure the encoder writes, so the two cannot drift.
2. **Add a regression guard** that asserts, for a representative throwing wasi
   module, that `r.imports` equals `WebAssembly.Module.imports(binary)` exactly.
   A guard comparing the two is strictly better than one asserting a fixed list,
   because it cannot itself go stale.

Consider also exposing a small helper (e.g. `binaryImports(result)`) so tests
stop hand-rolling the `WebAssembly.Module.imports` dance.

## Exemplar remediation pattern

`tests/issue-2867-gap2.test.ts` (fixed in the #2867 CI-fix boundary) is the
reference. It does three things, and a fix to other affected suites should copy
all three rather than just adding a shim:

```ts
// 1. Read the import list from the BINARY — immune to this bug.
const binaryImports = WebAssembly.Module.imports(await WebAssembly.compile(r.binary))
  .map((i) => `${i.module}.${i.name}`);
// 2. Keep the assertion that actually matters: no JS-host carrier import.
expect(binaryImports.filter((n) => !n.startsWith("wasi_snapshot_preview1."))).toEqual([]);
// 3. Shim WASI, and assert it is never CALLED — so a throw that escapes to the
//    abort path instead of being routed still fails the test.
expect(shim.calls).toEqual([]);
```

Step 3 is the important one: replacing `instantiate(binary, {})` with a shim
alone would make the test pass while *weakening* it. Asserting the shim is
unused preserves the original host-free intent.

## Acceptance criteria

1. For every row in the evidence table, `r.imports` equals the binary's real
   import list.
2. A regression guard compares `r.imports` against
   `WebAssembly.Module.imports(binary)` for a throwing wasi module.
3. No behavioural change to what the compiler *emits* — this issue is about
   reporting only. The WASI error path continues to link `fd_write`/`proc_exit`.
4. The at-risk suites identified by the census are re-checked; any that were
   passing vacuously are converted to the exemplar pattern above.

## Falsified hypotheses (kept visible)

- ~~"It is a local-environment difference — CI lacks a WASI shim that the dev box
  provides."~~ **False.** The failure reproduces verbatim locally with the same
  message; there is no shim on either side.
- ~~"The #2867 boundary commit introduced it."~~ **False.** That commit's only
  edit to the failing file was a comment, and all its other non-inference files
  were comment-only; reverting the two files with real changes reproduces the
  failure.
- ~~"The module should be host-free, so the compiler regressed by emitting a WASI
  import."~~ **Not supported.** A plain caught sync `throw` links `fd_write`
  under `--target wasi`, which is that target's documented job. The contract the
  carrier actually owes is "no **JS-host** (`env.*`) import", and that still
  holds. Do not "fix" this by suppressing the WASI imports.
