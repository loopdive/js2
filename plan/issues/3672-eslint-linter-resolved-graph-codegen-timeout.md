---
horizon: m
id: 3672
title: "ESLint linter.js: resolved 149-file graph exhausts a 2 GB compiler heap"
status: done
created: 2026-07-26
updated: 2026-08-18
completed: 2026-07-31
assignee: ttraenkler/dev-eslint-ir
priority: critical
feasibility: hard
reasoning_effort: max
task_type: performance
area: compiler, codegen, observability
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
required_by: [1400, 2693]
es_edition: n/a
related: [824, 1282, 1400, 1573, 1942, 3654, 3655, 3656, 3657]
---

# #3672 — Bound full codegen for the resolved ESLint Linter graph

## Problem

After #3654 restores ESLint's physical pnpm package context and exact virtual
module edges, direct `eslint/lib/linter/linter.js` analysis completes with 149
canonical sources. The entry has zero TS2307 diagnostics for the packages,
relative modules, type-only packages, and Node builtin owned by #3654; only
the static `../../package.json` edge owned by #3655 remains.

The honest next frontier is scale: this Node-host WasmGC probe does not return
within the 180-second budget used by the first ESLint integration test:

```sh
node --max-old-space-size=2048 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/eslint/lib/linter/linter.js \
  '{"allowJs":true,"target":"gc","platform":"node"}'
```

The bounded probe eventually exited 134 after about 45 minutes. V8 reported
repeated mark-compacts at 2,031 MB followed by:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

It emitted no structured compile result. This is not a TS2307 resolver failure
and must not be folded back into #3654.

## Required investigation

- Add phase timing and peak-memory telemetry around graph expansion, checker
  construction/diagnostics, reachability, declaration collection, function
  lowering, Wasm emission, and optimization.
- Determine whether the compiler is making forward progress, repeating work,
  or expanding code that is unreachable from the direct Linter entry.
- Record source/function counts entering each phase and identify the dominant
  files/functions.
- Keep the probe in the WasmGC JS-host lane under Node. Standalone/WASI work is
  not required for the first ESLint rung.
- Do not hide the problem by increasing the test timeout without a measured
  upper bound and a CI-safe regression budget.

## Acceptance criteria

- A deterministic reduced fixture reproduces the dominant repeated-work or
  reachability failure if one exists.
- The direct real `linter.js` child probe remains within an explicit,
  measured CI-safe time and memory budget and emits a structured result.
- The result records the compile/validate split even if a later semantic
  blocker still prevents execution.
- The Tier 1 test fails clearly on timeout or abnormal child exit; it never
  treats missing output as an expected compiler diagnostic.
- Phase timing and peak-memory evidence are recorded here before the issue is
  closed.

## Measurement (2026-07-31) — the premise does not reproduce

Re-run on `origin/main` with the **identical** command line and the **identical**
`--max-old-space-size=2048` cap this issue reported as exhausted. Single 8-core
container shared with other agents; `free -m` available 16,464 MB and 1-minute
load average 4.14 at the start of the first run.

| heap cap | wall   | peak RSS | exit | structured report |
| -------- | ------ | -------- | ---- | ----------------- |
| 2048 MB  | 12.5 s | 572 MB   | 0    | yes               |
| 2048 MB  | 11.6 s | 592 MB   | 0    | yes               |
| 2048 MB  | 18.6 s | 633 MB   | 0    | yes               |
| 8192 MB  | 16.4 s | 717 MB   | 0    | yes               |

There is **no 2 GB heap exhaustion and no 45-minute run**. `--trace-gc` over the
8192 MB run: 63 scavenges, 1 mark-compact, peak committed heap 439 MB,
`average mu = 0.996` — GC took 0.4 % of wall time. Peak RSS is read from
`/proc/<pid>/status` `VmHWM`, sampled every 2 s by a parent supervisor, so an
OOM-killed child still yields a number.

All four runs are identical in outcome: 125 diagnostics, `success:false`,
`binaryByteLength:0`, `valid:false`, exactly **one** `Codegen error:`, exactly
**one** unresolved module.

### Why it is fast: codegen aborts at one hard error

```text
Codegen error: inherited class callable LazyLoadingRuleMap_has
has no exact defined function for handle 676
```

A thrown `ProgramAbiInvariantError` from
`src/codegen/program-abi-class-callable-planning.ts:246`. The compile stops
there, so **`main` has never reached the full-codegen regime this issue was
written about.** Any budget measured today is a budget on an early abort — that
is stated in the test rather than papered over.

The remaining 124 diagnostics are not blockers: 112 ordinary TS checker notes on
untyped JS, 11 CJS-interop shape errors (`no default export` ×3,
`declares X locally, but it is not exported` ×8), and 1
`Cannot find module '../../package.json'` — the last unresolved edge in the
149-file graph, owned by #3655. #3654's resolver work has landed; #3656's
dynamic-destructuring invariant and #3657's unknown-ambient-call invariant are
both absent.

### Phase attribution (`--cpu-prof`, self time, 8192 MB run)

| bucket                                                 | self time | share  |
| ------------------------------------------------------ | --------- | ------ |
| `node_modules/typescript` (parse / bind / check)       | 6,590 ms  | 54.2 % |
| native (`stat` 791, `read` 508, `open` 242, GC 311 ms) | 2,369 ms  | 19.5 % |
| `src/ts-api.ts` (`forEachChild`)                       | 431 ms    | 3.5 %  |
| `src/codegen/declarations/import-collector.ts`         | 219 ms    | 1.8 %  |
| `src/codegen/struct-field-boolean-brand.ts`            | 122 ms    | 1.0 %  |
| `src/ir/identity.ts`                                   | 107 ms    | 0.9 %  |

No `src/` module exceeds 3.5 %. The frontier compile is **checker- and
I/O-bound**, not codegen-bound; ~14 % of wall time is filesystem syscalls from
module resolution. There is no repeated-work or reachability pathology to
reduce, so the "deterministic reduced fixture … **if one exists**" criterion is
answered in the negative, with numbers.

## Reduced repro of the actual blocker

The abort _does_ reduce. Root cause read off `src/codegen/class-bodies.ts`: the
inherited-member scan walks `ctx.funcMap` for every key with the textual prefix
`${parentClassName}_`, where `parentClassName` is literally `baseExpr.text`
(line 640) — so `extends Map` produces the prefix `Map_`. A separate, ordinary
use of the builtin registers **host-import** entries under exactly those keys,
and the scan hands that import handle to
`setProgramAbiInheritedClassCallableAlias` → `observeInheritedAlias`, which
requires a _defined_ function and throws.

Minimisation (all on `origin/main`); the discriminator is the separate plain use
of the builtin, which is why `extends Map` alone never reproduced:

| fixture                                   | result                                        |
| ----------------------------------------- | --------------------------------------------- |
| subclass **+** separate plain builtin use | FAILS — `Registry_set`, handle 13             |
| subclass alone, no separate plain use     | compiles clean                                |
| `extends Set` + plain `Set` use           | FAILS — `Bag_add`, handle 13                  |
| plain JS / CJS flavour                    | FAILS identically                             |
| `--target gc` without `platform: node`    | FAILS — handle 54                             |
| `--target standalone` / `--target wasi`   | different, deliberate #2620 guard fires first |

Handle 13 is unambiguously in import index space, confirming the import-handle
diagnosis. Six lines reproduce it:

```ts
class Registry extends Map<string, number> {}
const plain = new Map<string, number>();
plain.set("x", 1);
const r = new Registry();
export function test(): number {
  return (plain.has("x") ? 1 : 0) + (r.has("a") ? 1 : 0);
}
```

**Standalone-lane note:** on `--target standalone`/`wasi` this pattern is caught
by the explicit #2620 "native collection subclass not yet supported" guard, which
fails loudly and correctly. The standalone lane is protected by design here; the
defect is specific to the WasmGC JS-host lane.

## Implementation (2026-07-31)

No `src/` change. #3672 is a measurement-and-guard issue, and the measurement
says the compiler is fine at this frontier; inventing a fix would have been
fitting code to a stale premise.

- Added `tests/helpers/eslint-graph-probe.ts`: supervises the out-of-process
  `compileProject` probe under an **enforced** heap cap and wall-clock kill.
  Rejects with a typed `EslintGraphProbeFailure` whose `kind` is `timeout`,
  `abnormal-exit`, or `no-structured-report`. The budget is _enforced_, not
  compared against a recorded number, so a breach cannot degrade into a pass —
  and a killed child can never be mistaken for a compiler diagnostic.
- Added `tests/issue-3672.test.ts`: the real `linter.js` graph under the 2048 MB
  / 120 s budget with the compile/validate split and the frontier pinned; two
  control rungs that prove the supervision can fail; and the reduced repro plus
  its isolating control.
- Un-skipped **Tier 1a** in `tests/stress/eslint-tier1.test.ts` and routed its
  child through the shared supervisor. Before this change that file was 5 tests
  / 5 `it.skip` / **0 attempted** — 100 % vacuous, and in no required check, so
  there was zero automated signal on ESLint compilation. The package entry
  measures 10.8 s / 628 MB peak RSS and reaches the same frontier with only two
  diagnostics and zero unresolved modules.

`src/compile-profile.ts` was deliberately **not** written: PR #3687 already
introduces it, and once the failure mode was known, phase attribution needed
nothing beyond `--cpu-prof`.

## Verification (2026-07-31)

- `tests/issue-3672.test.ts` — **5 passed / 5 attempted / 0 skipped**.
- `tests/stress/eslint-tier1.test.ts` — Tier 1a now **1 passed / 1 attempted**
  (was 0 attempted); the four later rungs stay skipped behind their own blockers.
- Non-vacuity, deliberate breaks confirmed red before being reverted:
  - heap budget lowered to 192 MB → the real graph dies with
    `node::OOMErrorHandler`, SIGABRT, exit code `null`, empty stdout after
    11.6 s, and the suite reports
    `compileProject probe exited abnormally … it is NOT a compiler diagnostic`.
    A genuine OOM lands in the loud branch, never in a silent skip.
  - frontier substring replaced with a sentinel → red with
    `expected 'Codegen error: inherited class callab…' to contain
'SENTINEL_MUST_NOT_MATCH'`, proving the pin inspects real diagnostics.
  - the permanent timeout rung is itself a live proof: the real graph under a
    750 ms budget is killed and reported as `kind: "timeout"`.
- The repro's isolating control (subclass without the separate plain builtin
  use) compiles successfully, so the failing rung is not passing for an
  unrelated reason.

## Follow-up (2026-07-31, later the same day) — the inherited-alias defect is fixed, frontier advanced

The builtin-subclass inherited-alias defect that this issue's measurement work
isolated is now **fixed**, and the ESLint frontier has moved past it.

**Root cause.** `ProgramAbiCallableRegistry.observeInheritedAlias`
(`src/codegen/program-abi-class-callable-planning.ts`) used a single signal —
`definedFuncAt(...) === undefined` — to mean "corrupt locator", collapsing two
structurally distinct causes:

1. the handle is an **import** handle — a host-import `funcMap` entry the
   `${ancestor}_` prefix scan in `collectClassInfo`
   (`src/codegen/class-bodies.ts`) matched by textual coincidence; and
2. the handle is a **non-import** handle with no defined record — a genuinely
   stale/never-pushed locator (the #2043 late-import-shift corruption class the
   check was actually written for).

Only (2) is an invariant violation. An import can never *be* a canonical class
unit, so (1) is the same "nothing exact to observe" outcome the existing
zero-canonical-owner branch already tolerates with `return undefined`.

**Fix.** One guarded early return using the sanctioned `isImportFuncIdx`
chokepoint (`src/codegen/func-space.ts`), placed ahead of the `definedFuncAt`
check; the throw is retained unchanged for case (2).

**Why this cannot regress a passing program.** Every input that reaches the new
early return previously *threw*, aborting the whole compile. So the set of
successfully-compiling programs can only grow. `setProgramAbiInheritedClassCallableAlias`
still writes `ctx.funcMap` exactly as before, so sidecar-off modes — which never
threw here because the call is optional-chained — are byte-for-byte unaffected.

**Measured frontier advance** (8-core container, `--target gc`,
`platform: node`):

| entry                        | before                                                 | after                                                                                |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| direct `lib/linter/linter.js` | `inherited class callable LazyLoadingRuleMap_has … 676` | `source callable validate has no consistent exact top-level or compiler-support inventory owner` |
| package entry (`import { Linter }`) | `inherited class callable … 590`                | identical new diagnostic                                                             |

Still one hard codegen error, 124 total errors, 10.6 s wall — so the compile
still aborts early and the 2048 MB / 120 s budget is unchanged and still a
budget on a compile that stops at the frontier.

**Scope — what this does NOT fix.** Inherited builtin-collection members on a
subclass are still not backed by real collection state in the JS-host lane.
Measured on **unmodified `main`**, using the clean-compiling subclass-alone
control (so this is pre-existing, not introduced here): `r.set("k", 2)` followed
by `r.size` reads `0` and `r.get("k")` reads `undefined` — the module compiles
and silently computes the wrong answer. That is the #2620 native-subclass
substrate, tracked separately. This change only stops an unrelated `new Map()`
elsewhere in the program from turning that already-wrong compile into a hard
abort; it does not make builtin subclassing correct.

**Test changes.** The repro block in `tests/issue-3672.test.ts` is inverted from
pinning the defect to guarding the fix (plus an explicit
`not.toContain("inherited class callable")` so the retired rung cannot come
back); the real-graph rung and Tier 1a in `tests/stress/eslint-tier1.test.ts`
are advanced to the new diagnostic. `tests/issue-3672.test.ts` 5 passed /
5 attempted / 0 skipped; Tier 1a 1 passed / 1 attempted.

## Remaining work owned elsewhere

- **NEXT FRONTIER (unowned, no issue yet):** `source callable validate has no
  consistent exact top-level or compiler-support inventory owner`, thrown from
  `observeWithExpectedKind` in
  `src/codegen/program-abi-source-callable-planning.ts:357`. A `function
  validate` declaration whose inventory unit is neither `top-level-function` nor
  `synthetic-support`. Not reduced yet — this is an inventory-modelling gap, a
  different class of defect from the import-handle confusion fixed above.
- The builtin-subclass inherited-alias defect never got its own issue id; it is
  fixed and recorded here instead (the allocator's open-PR scan was offline, and
  minting an id to close it in the same change is ceremony with collision risk).
  PR #3687 also claims a fix for it on its branch (measured handle 615 vs
  `numImportFuncs` 650) — that overlap still needs deciding.
- `Cannot find module '../../package.json'` — #3655.
- The CJS-interop shape diagnostics (`no default export`,
  `declares X locally, but it is not exported`) — #3654 follow-up.
