# npm-suite effort — handoff (2026-10-10)

Lead session `npm-unit-test-failures-420ca0` (Opus 5.5 lead + Opus 5.5
workflow agents), 2026-10-05 → 10-10. Follows
[npm-suite-handoff-2026-09-29.md](npm-suite-handoff-2026-09-29.md).

Goal: **fix failing unit tests of npm packages.** These suites only run on
the JS-host lane, so this goal overrides the 09-23 "standalone only"
instruction. Wave 9 still worked on the standalone lane.

## JS-host upstream unit suites

| package | 10-05 | now | PRs |
|---|---|---|---|
| prettier | 75/151 (regressed from 108) | 111/151 | #6524 |
| hono | 271/324 | 294/324 → 308 in open #6613 | #6511, #6556, #6559, #6613 (open) |
| redux | 67/82 | 76/82 | #6508 |
| jest | 336/356 | 344/356 | #6547 |
| axios | 212/231 | 219/231 | #6531 |
| marked | 18/30 | 30/30 | #6557 |
| react | 139/180 | 150/180 | #6585 |
| lodash | 60/62 | 60/62 | — |

Unchanged at 100 %: uuid, clsx, cookie, moment, tailwindcss, webpack, jsdom,
styled-components, stylelint, typescript (14/14). three stays 17/18 (Math.exp
precision, a design decision).

## Standalone-dynamic perf lane (wave 9)

12 of 24 packages are measured (was 9 at the 09-29 handoff). Next blocker per
package:

| package | state | next blocker |
|---|---|---|
| lodash | module init completes (#6506) | #6751 checksum `called value is not a function` |
| jest | fs refusal gone (#6491) | `__get_builtin` #1472 Phase B |
| tailwindcss | Map-subclass layout fixed (#6502) | #6862 stack-balance in `parseCandidate` |
| prettier | `Intl.ListFormat` native (#6496) | #6849 `navigator.platform` leak, then `__closure_532` invalid Wasm |
| styled-components | 0 host imports (#6522) | #6855 module-init TypeError; #6858 `typeof importedFn` |
| axios | budget ladder (#6288) | #6746 57 host imports at -O1 |
| three | — | #6842 `requestAnimationFrame` host import |
| stylelint | — | #6843 globby `isDynamicPattern` host import |
| eslint, typescript, webpack | — | standalone codegen alone exceeds the CI budget (#4287) |
| jsdom | report no longer OOMs (#6498) | #4299 |

#6288 makes a budget overrun name its phase. For three, stylelint and eslint
the overrun happens in codegen, so lowering the wasm-opt level cannot help
them.

## Still running at handoff (wave 13 resume, run `wf_ddd1e7fa-b7b`)

- **hono agent:** PR #6613 (fixes #6860 #6900 #6901 #6902, 294 → 308) is
  CLEAN. Its `hold` label was set by the agent, not by the bot. Lift it only
  after the agent's scoped test262 check on both lanes is recorded in the PR.
- **prettier agent:** still working; no PR yet. #6616 (sort/toSorted
  variadic ABI, #6912) may belong to it; check its branch before acting.

If the session dies, resume with `Workflow({scriptPath: <session>/workflows/scripts/npm-unit-wave13.js, resumeFromRunId: "wf_ddd1e7fa-b7b"})`.
The react agent is cached and will replay.

## Filed follow-ups (all have plans)

- **hono:** #6860 (async arrow with destructured param, in #6613), #6863 (two
  awaits in one statement).
- **jest:** #6869 deepCyclicCopy reflection (5), #6870 `boolean[]` via a union
  param (2), #6871 interface extending an unresolved base (2).
- **axios:** #6873 dynamic `instanceof` against a class value (4), #6874
  hoisted function captures a TDZ const (1).
- **redux:** #6852 shared-copy method captures read null (2), #6853 `undefined`
  into a `number` param reads NaN (3), #6854 `o[k]()` on a host callable.
- **prettier:** #6845 class value loses identity (instanceof via param,
  `typeof` of an imported class, `C.name` via `any`).
- **react:** #4618 umbrella, now with 30 failures grouped by symptom. Strongest
  lead: `function Base(p){this.props=p} class C extends Base {}` loses
  `this.props` set during `super()`.
- **test262:** #6886 spread-call mis-slotting, #6887 non-callable
  `Symbol.iterator` value invisible to the host.

## Lessons (new this window)

1. **A bot `hold` does not remove a PR from the merge queue.** #6511 and
   #6502 both merged while parked. A park therefore has to be diagnosed
   promptly, not left as a gate.
2. **Diagnose a park against the fresh baseline, not a local base run.**
   #6511's agent called 27 of 36 rows "fails on main too" because its local
   run lacked CI's Temporal provider, so both sides failed. Every row was
   `pass` in `fetch-baseline-jsonl.mjs`. `scripts/run-test262-paths.mts`
   builds the provider in-process; give each compiler state its own
   `JS2WASM_TEMPORAL_CACHE`.
3. **A "regression" can be an exposed false pass.** All 36 #6511 rows had
   passed vacuously: `forEach` callbacks with assertions inside were dropped.
   The real bug was an argument-unwrap in the class-method host bridge
   (#6556). Same pattern for prettier: #6798 fixed `typeof class` and exposed
   dropped Error-subclass field initializers (#6524).
4. **A merge-group park names the whole group.** #6502 was blamed for
   #6504's 158 Temporal `illegal_cast` regressions.
5. **Uncommitted work survives in `.tmp/` copies.** The marked agent reached
   30/30 and then stopped without committing. Its `.tmp/fix/` file copies
   were enough to recover the work as #6557.
6. **Orphaned measurements eat cores.** A `--only typescript` standalone run
   ran for 8 days at ~80 % CPU after its agent died. Check for
   `generate-npm-compat-report` processes whose parent PID is 1 at session
   start.
7. **The box is shared.** Load of 50–390 came mostly from other users and
   sessions. Local timings are unreliable, and timeouts under load are not
   regressions.
8. **The weekly limit kills agents mid-run.** wave13 prettier and hono died
   on 10-07 and were resumed after the reset on 10-09 23:00.
