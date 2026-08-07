# Session handoff — 2026-08-07 (coordinator lane)

Written at session end. Covers what landed, what is **in flight and unmerged**,
what is filed-but-unowned, and the traps that cost real time today.

The goal that drove this session (`90% ES5 cumulative, --target standalone`) was
**cleared by the project lead at the end of it**. Nothing below is a commitment;
it is state, so the next session does not re-derive it.

---

## 1. Landed — 22 PRs, +86 ES5 standalone, zero regressions

| PR | issue | effect |
| --- | --- | ---: |
| #4203 | #4207 primitive receivers resolve wrapper-prototype props | **+19** |
| #4190 | #4201 `<wrapper>.valueOf()` returns `[[PrimitiveValue]]` | **+12** |
| #4194 | #4203 explicit-null receiver + `.bind` evaluate-and-drop | **+12** |
| #4196 | #4204 heterogeneous module-`var` widening (was silently `NaN`) | **+10** |
| #4192 | #4205 script-goal global object | **+7** |
| #4200 | #4208 S1 — `Type()` before the f64 slot merge in strict equality | **+6** |
| #4210 | #4187 hasOwnProperty const-fold vs runtime `delete` | **+1** |
| #4197 | #4206 standalone Tier-2 `with` HasBinding | 0 (real fix, see §4) |

Plus infrastructure: **#4195** (harness compile-budget rebanked 98,089 → 111,568;
it had 1.1 % headroom and was a trap for the next lane), **#4204** (the
`sync:conformance` ordering fix, #4211), **#4214** (two stale DATE pins in
`tests/issue-4047.test.ts`), and the census + its correction (#4191, #4193).

---

## 2. IN FLIGHT — unmerged work, both lanes killed by a container restart

**Both branches are fully pushed (local == remote). No work was lost.** Neither
has an open PR.

### `issue-4210-error-carrier-bag` @ `778b35e459` — #4210 Error carrier

The most advanced. **Error receivers silently lose ALL own-property writes** —
both `err.x = 7` and `Object.defineProperty` — with no throw and no refusal.

- **Lever measured: +21, pass→fail 0**, on a re-derived **71**-file population.
- **Implementation complete**, including an `__integrity_bag` Error arm that is
  load-bearing (see the vacuous pass in §5).
- **What is missing: the control.** A trimmed 4,221-file control was ~1,129 rows
  in per arm when the restart killed it. **Do not open a PR on the lever number
  alone** — byte-identity is *not* available as a safety argument here (71/71
  modules change, because `__extern_set`'s body moves for every standalone
  module with an object runtime), so safety rests entirely on execution.
- Re-run guidance from the lane: 2 shards per arm (not 12 — see §6), population
  is the Error/NativeErrors/AggregateError/SuppressedError trees + the whole
  `Object` descriptor/integrity surface + `Reflect` + every non-Array lever
  directory, **complete, 3,936 files**, plus a **separately-labelled** 285-file
  sample of the deliberately-dropped `Array/prototype` region.
- The Array region was dropped on a **reachability** argument, not size: a vec
  receiver never reaches this code (the vec arm returns first in `__extern_set`,
  `vecOverlayArm` precedes the define substitution, `__integrity_bag` tests vec
  first). Keep that reasoning with the numbers.
- Its 1 signature change is fail→fail and documented; its 15 base-arm
  disagreements are one cause (`env::__new_SuppressedError`, #2961, since fixed
  on main — the baseline is simply older than the base), identical in both arms.

### `issue-4208-s3s7-ordinarytoprimitive` @ `5a2b4f04b0` — #4208 S3+S7

Started late, killed early. **Contents unassessed** — check the two-dot diff
against main before assuming anything is complete. Slice is 18 files: one
`OrdinaryToPrimitive` engine serving the relational operators, `+`, and the
unary numeric operators, which are the same defect reached from two paths.

**Two constraints that must survive:**
1. Do **not** re-do S1. `src/codegen/strict-eq-type-disjoint.ts` is on main and
   owns the strict-equality fold *and* the i32/f64 promotion whose **order** was
   the fix.
2. Do **not** remove the Boolean `++`/`--` guard `isUpdateRetypedBoolean` on the
   assumption it is redundant. It was proven load-bearing by a kill-switch
   experiment (disable only the guard: `var x = true; x--` fails again). It can
   only be removed by repeating that proof — and it **should** be removed by the
   PR that extends #4204's predicate to UpdateExpression targets, because at
   that point those files pass for the right reason.

---

## 3. Filed, unowned, not started

| id | what | note |
| --- | --- | --- |
| #4209 | refusal-vacuous-pass census | The decisive experiment is swapping the standalone refusal to **RangeError** and re-running; every currently-passing file that flips was passing *because a feature is missing*. Its 825-file pool is an **upper bound, not a count**. |
| #4212 | a missing argument becomes the **zero value of the unified param type**, not `undefined` | `sum('ab')` → `"ab0"`. Trigger is cross-call-site unification: adding an unrelated second caller silently changes the first caller's result. **Both lanes.** test262 impact deliberately unmeasured. |
| #4213 | Error read-path slice (deferred from #4210) | `err.message` write lands but the *read* still answers the struct field — a self-contradiction #4210 knowingly introduces. 11 files, **0 currently pass**, so 0 regression risk. |
| #4214 | §10.1.9: update-after-`preventExtensions` refused for **every** receiver kind | Pre-existing, receiver-independent, spec-violating (only *creation* is blocked; an existing writable own property stays writable). Two candidate sites named in the issue. |
| — | **global-binding unification** | The #4206 lane identified this as the real head of the `with` cluster (≥19 files). `this.p1 = 1; p1 = 'x1'` — bare `p1` and `this.p1` use different storage, with no `with` involved. **Still needs an issue.** |

---

## 4. The finding that should shape the next session

**Five census entries were sent to lanes to implement. Three came back as
corrections rather than fixes, and a fourth was already done.**

| lever | filed | actual |
| --- | ---: | --- |
| #4205 script-goal global object | 133 | **7** — filed root cause did not reproduce; "standalone has no realm global object" has been false since #2996 |
| #4206 `with` | 118 → 50 | **105**, and its headline bucket was not a `with` defect at all |
| #4207 transferred proto method | 70/59 | **60 → 19 fixed**; filed mechanism wrong — a prototype-chain gap, not a transfer gap |
| #4165 reflective MOP | 857 | **already closed** by upstream #4010/#4017/#4055/#4161 |
| #4208 operator abstract-ops | 59 | **51** — root cause DID reproduce |

The census (#4191) ran **no local compiles**; every count came from the
published baseline plus a shape predicate. That is the whole explanation. Its
correction is #4193, and its remaining unverified entries are flagged in it.

Two structural conclusions from it worth keeping:

- **ES5 standalone is ~5.4 points AHEAD of ES5 host**, and ~64 % of failures
  fail in *both* lanes. Framing work as "close the standalone gap" mis-targets
  two thirds of it.
- A population derived from **body + `includes:`** is systematically
  under-counted, because the runner **always** prepends `assert.js` + `sta.js`.
  That is why #4210's lever was 71 and not the filed 58.

---

## 5. Vacuous passes are the live hazard, and the controls earned their keep

Three separate instances today, each caught only by a **full control
population**, never by the lever:

1. `var x = true; x--` — two files whose `x !== 0` was answered by the very f64
   collapse being removed. A lever-only run would have shipped a silent
   regression.
2. `preventExtensions/15.2.3.10-3-{10,20}.js` — pass today **because the Error
   write is dropped**. A working write side alone converts them to failures;
   that is why #4210's integrity arm is in the same change and not a follow-up.
3. The general class: **a standalone not-yet-implemented refusal throws
   `TypeError`**, so any test asserting a TypeError passes because the feature
   is missing. Recorded in
   `.claude/memory/project_hostfree_pass_can_be_vacuous_inject_throw_probe.md`
   (second mechanism); census is #4209.

The incentive here is inverted and worth stating plainly: implementing a member
*correctly* converts such files to failures, and because the regression gates run
on the merged state it surfaces as a `merge_group` auto-park **after the author
has stood down**, attributed to the wrong PR.

---

## 6. Environment traps that cost real time

- **The container restarted THREE times**, killing five lanes, with **no
  notification**. Detect it via `uptime` (a low value) and via worktrees losing
  their `locked` flag. Every lane whose work survived had **pushed**.
- **A tree can sit in the BASE arm of an A/B.** That looks like an abandoned
  approach and is finished work — it nearly cost #4204's completed result. If
  you leave a tree in a base arm, say so in a commit message.
- **This box is 4 cores / 16 GB with no swap.** One lane ran 12 concurrent
  processes believing it was 8-core; load hit **42**. The real constraint was
  **RAM-thrashing** (~1.1 GB RSS each, available RAM down to 1.0 GB), with load
  as the symptom — the spawn gate keys on load average and would throttle the
  wrong dimension. 2 shards per arm is the working figure.
- The instrument memory
  (`.claude/memory/reference_standalone_eval_instrument_reports_unmeasured_failures.md`)
  now records **five** ways a measurement lies, including two found today: the
  pool worker imports `scripts/compiler-bundle.mjs`, **not `src/`**; and
  `provision-worktree-deps.sh` silently no-ops here (use
  `JS2_WORKTREE_SOURCE=/home/user/js2`, then **verify where `node_modules` and
  `test262` actually linked** — a repaired run linked them into another lane's
  worktree).
- **Do not bound exposure by a pre-scan dirty gate.** 48,587 of 48,619 rows have
  `protoNamedDirty` set, because the harness shim prepended to every file
  contains `return eval(sourceText)`. "Gated on X ⇒ byte-identical" is worth
  0.07 % here.

---

## 7. One open verification

**#4211's sync-ordering fix (landed in #4204) has not been behaviourally
tested.** `sync:conformance` has not fired since, but there may not have been a
high-water rise, so that is **not** proof.

If a PR fails `quality` on standalone-line drift again, the fix is **incomplete
and there is a third writer** of the README standalone line. Say so and
investigate — do not hand-carry a fifth repair commit. Four were carried today
before the cause was found.
