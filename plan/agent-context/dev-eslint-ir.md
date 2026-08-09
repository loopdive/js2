# dev-eslint-ir — context summary (2026-07-31)

Lane: ESLint IR + heap blockers (#3672, #3657, #3656). Branch
`issue-3672-eslint-graph-compile-budget`. Everything below is measured on
`origin/main` at `371e9cec` + 3 catch-up commits, on the shared 8-core
container (`free -m` available 16,464 MB, 1-min load 4.14 at first run).

## 1. #3656 and #3657 are already merged — they need a status flip only

Both fixes are on `main` and neither needs implementation work:

| issue | impl commit on `main`                                                    | test on `main`             |
| ----- | ------------------------------------------------------------------------ | -------------------------- |
| #3656 | `9f69413e` `fix(ir): preserve JSDoc parameter types in overlay planning` | `tests/issue-3656.test.ts` |
| #3657 | `61bba431` `fix(ir): lower ambient host calls in class members`          | `tests/issue-3657.test.ts` |

Non-vacuity: `npx vitest run tests/issue-3656.test.ts tests/issue-3657.test.ts`
→ **4 passed / 4 attempted / 0 skipped**. The `skipIf(FLAGS_FILE === null)` rung
genuinely ran (the `eslint` devDependency is present), so this is not a vacuous
pass.

Both issue files still say `status: ready`. **Not flipped here on purpose** —
PR #3687 already edits both of those issue files, so a competing flip conflicts.
The tech lead is reconciling them separately.

The pre-dispatch gate returns **STOP on #3657** (it flags `2668-*` as an active
overlap that references it). Moot given the work is merged, but honour it if
anyone re-dispatches.

## 2. #3672's premise was stale — measured, not assumed

The issue claimed the resolved 149-file graph "exhausts a 2 GB compiler heap",
exiting 134 after ~45 minutes. Re-run with the **identical** command and the
**identical** `--max-old-space-size=2048`:

| heap cap | wall   | peak RSS | exit | structured report |
| -------- | ------ | -------- | ---- | ----------------- |
| 2048 MB  | 12.5 s | 572 MB   | 0    | yes               |
| 2048 MB  | 11.6 s | 592 MB   | 0    | yes               |
| 2048 MB  | 18.6 s | 633 MB   | 0    | yes               |
| 8192 MB  | 16.4 s | 717 MB   | 0    | yes               |

`--trace-gc`: 63 scavenges, 1 mark-compact, peak committed heap 439 MB,
`average mu = 0.996` (GC = 0.4 % of wall). **No OOM regime exists on `main`.**

It is fast because codegen **aborts** on exactly one hard error out of 125
diagnostics:

```
Codegen error: inherited class callable LazyLoadingRuleMap_has
has no exact defined function for handle 676
```

(`ProgramAbiInvariantError`, `src/codegen/program-abi-class-callable-planning.ts:246`.)
Package entry (`import { Linter } from "eslint"`) hits the same thing at
**handle 590**, 10.8 s, 628 MB, and with only **2** diagnostics and **zero**
unresolved modules. PR #3687 measured **handle 615 vs `numImportFuncs` 650** on
its branch — same defect, same import-handle diagnosis, three independent
handles.

`--cpu-prof` attribution of the aborting compile: **54.2 % `node_modules/typescript`**,
~14 % `stat`/`read`/`open` syscalls, and **no `src/` module above 3.5 %**. The
frontier compile is checker- and I/O-bound, not codegen-bound.

## 3. Root cause of the abort, reduced to six lines

`src/codegen/class-bodies.ts` sets `parentClassName = baseExpr.text` (line 640),
then the inherited-member scan walks `ctx.funcMap` for **every key with the
textual prefix `${parentClassName}_`**. A separate plain use of the builtin
registers _host-import_ entries under exactly those keys; the scan hands that
import handle to `setProgramAbiInheritedClassCallableAlias` →
`observeInheritedAlias`, which requires a _defined_ function and throws.

```ts
class Registry extends Map<string, number> {}
const plain = new Map<string, number>();
plain.set("x", 1);
const r = new Registry();
export function test(): number {
  return (plain.has("x") ? 1 : 0) + (r.has("a") ? 1 : 0);
}
```

→ `Codegen error: inherited class callable Registry_set ... handle 13`

The discriminator is the **separate plain use of the builtin** — `extends Map`
alone compiles clean. That is why five earlier reduction attempts failed. Also
reproduces with `extends Set` (`Bag_add`), in plain JS/CJS, and on `--target gc`
without `platform: node` (handle 54).

**This defect has no issue on `main`.** #3687 claims a fix on its branch. It
needs a home issue; the repro is landed and executable in
`tests/issue-3672.test.ts`.

## 4. The ESLint stress ladder was 100 % vacuous

`tests/stress/eslint-tier1.test.ts` on `main`: **5 tests, 5 `it.skip`,
0 attempted** — and per #3687 the file is in **no required check**. There was
zero automated signal on ESLint compilation; anything "fixed" there would have
looked green regardless. Tier 1a is now un-skipped and passing against the
measured frontier.

## 5. What landed on this branch

- `tests/helpers/eslint-graph-probe.ts` (new) — supervises the child probe under
  an **enforced** heap cap + wall-clock kill; rejects with a typed
  `EslintGraphProbeFailure` (`timeout` / `abnormal-exit` /
  `no-structured-report`). Budgets are enforced, not compared, so a breach
  cannot degrade into a pass.
- `tests/issue-3672.test.ts` (new) — real graph under 2048 MB / 120 s, frontier
  pinned, two controls proving the supervision can fail, plus the reduced repro
  and its isolating control. 5 passed / 5 attempted / 0 skipped.
- `tests/stress/eslint-tier1.test.ts` — Tier 1a un-skipped, child routed through
  the shared supervisor.
- `plan/issues/3672-eslint-linter-resolved-graph-codegen-timeout.md` — full
  measurement record, `status: done`.

No `src/` change. `src/compile-profile.ts` deliberately **not** written — #3687
already introduces it and `--cpu-prof` answered the question without it.

Non-vacuity proofs (broken deliberately, confirmed red, reverted): heap cap
lowered to 192 MB → real `node::OOMErrorHandler` SIGABRT reported as
`abnormal-exit ... it is NOT a compiler diagnostic`; frontier substring replaced
with a sentinel → red on the real diagnostic text.

## 6. Bearing on the standalone ES5 push

- On `--target standalone` / `--target wasi` the builtin-subclass pattern is
  caught first by the **explicit #2620 guard** ("native collection subclass not
  yet supported"), which fails loudly with an actionable message. The standalone
  lane is protected by design here — the inherited-alias defect is **specific to
  the WasmGC JS-host lane**. Fixing it will not move the standalone score.
- The one transferable lesson is the vacuity pattern, not the defect: a whole
  stress ladder sat at 0 attempted while reading as green. Before crediting any
  standalone-lane gain, check `attempted`, not just `passed`.

## 7. Open threads for whoever picks this lane up

1. File the builtin-subclass inherited-alias defect as a real issue and point it
   at `tests/issue-3672.test.ts`'s repro block.
2. Decide #3687's fate — it is DIRTY, `hold`-labelled, self-reports that the
   ESLint graph stopped compiling after its main merge, and escalates that to
   **#3798, which has no issue file on `main`**. It also carries the only
   implementation of #3655 (`tests/issue-3655.test.ts` exists nowhere else).
3. My branch touches `tests/stress/eslint-tier1.test.ts`, which #3687 also
   edits. A one-time conflict resolution is expected and was accepted knowingly.
4. Once the inherited-alias defect is fixed, `tests/issue-3672.test.ts` and
   Tier 1a **go red on purpose** — the frontier moved. Advance the rungs and
   re-measure the budget; do not widen it without a fresh measurement, because
   full codegen will then run for the first time and #3687's branch measured
   **615.9 s** for it.
