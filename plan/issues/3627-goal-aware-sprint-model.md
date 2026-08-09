---
id: 3627
title: "Goal-aware sprint model: schedule a goal into the rolling window and expand it to its actionable members"
status: ready
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: planning
language_feature: n/a
goal: maintainability
sprint: current
---

# Goal-aware sprint model

**Stakeholder ask (four rounds):**

> _"Change the sprint model to allow referencing goals in addition to issues. If
> a goal is added to a sprint, all its issues will be worked on in the priority
> given. Issues in the sprint that are entailed by a goal should reference it as
> a parent. I wonder if a goal should be an issue itself or separate?"_

> _"I think a goal like an issue should also be able to be **completed**. I
> wonder what's the best way to slice this longer-horizon planning. I think they
> could be **hierarchical** — if I add a goal to a sprint the TaskList should be
> filled with tasks that are **most important and ready first** — and we should
> be able to define **subgoals** like 'everything except dynamic features that
> require an interpreter' first. Actually I think adding **ES3 as a goal ES5
> depends on** would make sense."_

> "What about goals that are **not measurable**? Goals should have a
> **definition of done** that _could_ be that. If not, it will just stay open and
> **carry over to the next sprint** at the end of a sprint if not said
> otherwise — and that's fine."

> _"An issue should be attributable to **more than one goal**, and also always
> state **which ES edition** and **mode** (standalone, js host) it is applicable
> to if it is specific to a mode. If the goal of a sprint is **'es5-conformance
> standalone'**, all issues that apply here should be drawn into the sprint."_

**Answer to the literal question, up front: a goal stays SEPARATE from an issue,
and `goal:` already _is_ the parent link being asked for — 3,056 of 3,178 issues
(96 %) carry it today. No new parent field is needed.** What is missing is three
things a goal cannot currently do: be **scheduled** (D4), be **completed** (D7),
and be **decomposed** (D8).

The unifying claim of this spec: a goal is separate from an issue because
**openness means something different for each**. An open issue is a _debt_ —
every tool treats it as needing action, which is why umbrella issues generate
endless "merged-but-open" noise. An open goal is the _normal steady state_; it
carries over across budget windows and nothing reports that as a defect (D10).
Every goal still declares a **definition of done** (D7) — which _may_ be a
machine-checked metric, but is allowed to be a human judgement, because some
goals are genuinely not measurable and that must be first-class.

---

## Measured baseline (2026-07-25, `origin/main` @ `07c8d239`)

Every number below was measured over the real corpus, not estimated.

| Measurement                                         |                                                                        Value |
| --------------------------------------------------- | ---------------------------------------------------------------------------: |
| issue files (`plan/issues/^\d+[a-z]?-.+\.md$`)      |                                                                        3,178 |
| carry `goal:`                                       |                                                               3,056 (96.2 %) |
| carry `parent:`                                     |                                                                          381 |
| carry `umbrella:`                                   |                                                                          142 |
| carry `depends_on:`                                 |                                                                          423 |
| goal files in `plan/goals/` (excl. `goal-graph.md`) |                                                                           29 |
| **`goal:` values with NO matching goal file**       |                                        **512 refs across 63 distinct names** |
| goal files with zero member issues                  |                                                       1 (`full-conformance`) |
| `sprint: current` issues                            | 190 (ready 152, in-progress 16, in-review 5, done 14, wont-fix 2, blocked 1) |
| **actionable (`ready`/`in-progress`) `current`**    |                                                                      **168** |
| actionable issues NOT `sprint: current`             |                           185 (backlog 161, **numbered/frozen 19**, unset 5) |
| current-actionable missing `priority:`              |                                                                  **0 / 168** |
| current-actionable missing `horizon:`               |                                                          **35 / 168 (21 %)** |

### Expansion scale — the number that decides the design

Net-new tasks added to the (already 168-item) TaskList by putting one goal in
the window:

| goal                  | members | net-new, **actionable-only** | net-new, **all members** |
| --------------------- | ------: | ---------------------------: | -----------------------: |
| `spec-completeness`   |     371 |                       **24** |                  **364** |
| `standalone-mode`     |     338 |                           17 |                      305 |
| `platform`            |     113 |                           15 |                      111 |
| `test262-conformance` |     128 |                            7 |                      104 |
| `test-infrastructure` |     123 |                            6 |                      123 |

**All-members expansion of a single goal is a 15× blow-up** (364 vs 24), and
~85 % of what it adds is already `done` — tasks the reconciler would have to
immediately flip back to `completed`. Two goals would take the queue from 168
to ~840. This is measured, not extrapolated.

---

## Decisions

### D1 — A goal stays a FILE, not an issue

**Decision: goals remain `plan/goals/<slug>.md`. They do not become issues.**

Evidence:

1. **The link already exists.** 96 % of issues carry `goal:`. The stakeholder's
   "issues should reference their goal as a parent" is already satisfied;
   converting goals to issues means rewriting 3,056 frontmatter fields to gain
   nothing new.
2. **Different shape.** Goals form a DAG with inter-goal dependencies
   (`plan/goals/goal-graph.md`, 203 lines of ASCII DAG + a status summary
   table). Issue `depends_on:` is a flat id list.
3. **Openness means the opposite thing.** An open issue is a debt that every
   tool treats as needing action (`reconcile-tasklist.mjs`, the #3474
   done-status gate); an open goal is the normal steady state that carries over
   between windows (D10). A goal _does_ complete (D7) — but via a declared
   definition of done, and its `state:` vocabulary
   (`active`/`activatable`/`blocked`/`done`/`abandoned`/`superseded`/`paused`,
   D11) is deliberately not the issue lifecycle. Merging the two would force
   every issue tool to special-case ~29 rows that never behave like issues.

**Honest counter-argument, and why it does not win.** Goals-as-issues would
inherit three real benefits: atomic id allocation via `claim-issue.mjs
--allocate`, the `check:issue-ids:against-main` CI gate, and the
`issue-assignments` claim lock. The measured 512 dangling `goal:` refs are
_exactly_ the failure mode those mechanisms prevent — string slugs have no
allocator and no gate. This is a genuine point in favour of the other design.
It is answered more cheaply by **D6's `check:goal-refs` gate**, which buys the
same referential integrity for one CI check instead of a 3,056-row migration.

#### Correction to the premise this issue was scoped with

The scoping brief claimed umbrella issues "drift because a long-lived container
is forced through a work-unit lifecycle," citing #2860 and #3029.

- **The drift is real and roughly 3×, but the sample is small.** Open issues
  that are the target of ≥1 `parent:`/`umbrella:` ("containers") are flagged
  `merged-but-open` by `reconcile-tasklist.mjs` at **8/37 = 21.6 %**, versus
  **27/371 = 7.3 %** for open leaf issues. n = 37 containers; treat as
  directional.
- **The cited example is half wrong: #2860 IS flagged; #3029 is NOT.**
- **The mechanism is not the lifecycle — it is a reconciler heuristic bug.**
  `reconcile-tasklist.mjs:228` runs `title.matchAll(/#(\d+[a-z]?)/gi)` over
  merged-PR titles and treats every captured id as "fixed by a merged PR".
  Confirmed by primary source: merged PR **#3501** is titled
  `fix(#3535): standalone lane defers top-level init so (start) throws render real signatures (#2860 F3)`.
  That PR implements **#3535**; it merely _mentions_ #2860 as context — and the
  container gets falsely flagged. A container is mentioned by every child's PR,
  so it false-flags by construction.
- **Therefore this bug SURVIVES D1 and is out of scope here.** Keeping goals as
  files does not fix it: the 142 `umbrella:` members and their 13 container
  issues remain issues either way. Do not read D1 as a fix for container drift.
  File separately against `reconcile-tasklist.mjs` (suggested narrowing: only
  credit the id in the PR title's **leading** `type(scope):` position).

### D2 — Goal frontmatter (new; goal files currently have none)

Goal files today open directly with `# Goal: <slug>` and carry metadata as prose
bullets (`- **Status**: Active`). **They have no YAML frontmatter at all** — this
decision introduces one. The prose body and the
`<!-- AUTOGENERATED:GOAL-ISSUES-START -->` table are untouched.

```yaml
---
goal: es5-static # MUST equal the filename without .md
title: "ES5 semantics excluding interpreter-dependent dynamic features"
state: active # D11 — active|activatable|blocked|done|abandoned|superseded|paused
sprint: current # ONLY `current` or absent. A numbered sprint is REJECTED (see D6).
priority: high # default for members that omit priority; also orders goals vs each other (D9)
horizon: l # default for members that omit horizon
dod: # D7 — every goal has a definition of done, of a declared kind
  kind: measured # measured | asserted | all-issues-done
  statement: "Every ES5-bucket test not requiring the interpreter passes on host."
  source: test262-editions # must resolve to a real artifact, else it's `asserted` in disguise
  lane: host # REQUIRED for kind: measured (D7c)
  bucket: "ES5" # MUST state exclusive-vs-cumulative intent explicitly
  target: 100
partition_of: es5 # subset of the SAME population — expands transitively (D8)
depends_on: [es3-complete] # ordering edge only — does NOT expand (D8)
aliases: [] # legacy `goal:` values that resolve here
---
```

A `kind: asserted` goal replaces `source`/`lane`/`bucket`/`target` with a
`judge:` — the honest shape for the ~15 qualitative goals (D7a). `state:` is
computed for `kind: measured` and persisted for `kind: asserted` (D7b).

> **The `aliases:` values are illustrative only.** Which legacy names fold into
> which goal is the **D6 follow-up triage**, not a decision made here.
> `standalone-gap` in particular is named in `CLAUDE.md` as its own Lane B goal
> and may well warrant its own file rather than folding into `standalone-mode`.
> Do not copy an example alias list as the answer.

Two fields carry the design weight:

- **`sprint: current`** is the entire scheduling surface. Absent ⇒ the goal is
  not in the window.
- **`aliases:`** is what makes the feature work against the real corpus. #2860
  itself is tagged `goal: standalone` — a dangling name. 43 of the 168
  current-actionable issues point at names with no goal file. Without aliases,
  putting `standalone-mode` in the window silently misses the 101 issues tagged
  `standalone`.

The deliberately distinct key names (`goal:` not `id:`, `state:` not `status:`)
make a goal file structurally unmistakable for an issue file to any future
frontmatter reader.

### D3 — Precedence: the issue wins on `priority`, the goal supplies defaults

**Decision: an issue's own `priority:`/`horizon:` always wins. The goal's value
is used only when the issue omits the field.**

This is settled by measurement, not taste: **0 of 168** current-actionable
issues omit `priority:`. If the goal won, adding one goal to the window would
silently override 168 individually curated priorities and reshuffle the whole
dispatch order. Goal-wins is destructive by measurement; issue-wins is a no-op
on today's corpus and therefore safe.

Goal-level `priority:` is still load-bearing in two places:

1. **Ordering goals against each other** when several are `current`.
2. **Bulk-created members** — a census that creates 30 issues in one pass can
   omit `priority:` and inherit it.

Goal-level `horizon:` is immediately live: **35 of 168 (21 %)** current-actionable
issues omit `horizon:` and today silently default to `m` in `normHorizon()`
(`sync-current-tasklist.mjs:127`), which mis-sizes them for
`budget-status.mjs --pick`. Goal default beats a blanket `m`.

### D4 — Expansion rule: ACTIONABLE members only (the decision that matters)

**Decision: a `sprint: current` goal expands to its members whose `status` is
`ready` or `in-progress` — the same actionable filter issues already pass. It
does NOT pull in `backlog`, `blocked`, `in-review`, `done` or `wont-fix`
members.**

**Confirmed by the stakeholder's second round** ("the TaskList should be filled
with tasks that are most important and **ready** first"). The measurement below
was taken before that confirmation and independently reached the same rule.
Ordering within the expansion is specified in **D9**; transitive expansion
through subgoals in **D8**.

The governing principle, stated so nobody "fixes" this later:

> **`sprint:` is the axis a goal speaks to. `status:` is the axis an issue
> speaks to.** Putting a goal in the window is a statement about _selection_,
> so it substitutes for `sprint: current`. It is not a statement about whether
> a given work unit is triaged and dispatchable — that remains the issue's own
> `status:`, and goal membership must not override it.

Measured consequence at real scale: the TaskList already holds **168**
actionable items. Actionable-only expansion of `spec-completeness` adds **24**
(→ 192, +14 %). All-members expansion adds **364** (→ 532, +217 %), of which
306 are already `done`. Adding a second goal under all-members takes it past 800. The over-provisioned-queue model only means something while the queue is
readable; all-members expansion destroys that on the first use.

**Additional exclusion — frozen sprints.** A member is skipped if its `sprint:`
is a **numbered** value. Measured: 19 actionable issues currently sit in numbered
sprints. A numbered sprint is a _retrospective record_ (`SCHEMA.md`); pulling
one of its issues back into the live window corrupts that record. Eligible
member `sprint:` values are therefore: `current`, `Backlog`, or unset.

**No cap.** An earlier draft proposed truncating expansion at ~25 members per
goal. Rejected on measurement: the largest net-new is 24, so a cap of 25 binds
on nothing — dead code that reads as a safety guarantee it does not provide.
Worse, truncating by priority-then-id would permanently starve low-priority
members, directly contradicting the stakeholder's "all its issues will be worked
on in the priority given." Instead emit a **loud warning** when one goal
contributes > 40 net-new tasks, and let the operator decide.

### D5 — The `es5` contract (its first real use)

**Verified at time of writing: no `plan/goals/es5*.md` exists, and the string
`es5` appears nowhere under `plan/`.** The census agent's output has
not landed, so this is stated as a contract, not an inference about another
agent's work.

D4 has a sharp edge for a brand-new goal: if `es5`'s members are
bulk-created as `status: backlog`, **actionable-only expansion surfaces zero of
them** and the feature is a no-op on its first real use.

> **Contract:** goal expansion only surfaces `ready`/`in-progress` members.
> Therefore bulk-created goal members MUST be created with `status: ready` if
> they are intended to be worked in the window. A member deliberately parked as
> `backlog` stays out until the goal owner promotes it to `ready`.

Document this in `SCHEMA.md` next to the goal frontmatter block, and have
`check:goal-refs` **warn** (not fail) when a `sprint: current` goal expands to
zero members — that is the exact symptom of a violated contract, and it should
be visible rather than silent.

### D6 — Freeze, reconciler, and referential integrity

**Freeze exclusion is already structural — pin it, do not add mechanism.**
`freeze-sprint.mjs:99-101` (`listIssues()`) globs only
`plan/issues/^\d+[a-z]?-.+\.md$`. Goal files live in `plan/goals/` and can never
match, so a goal is already unreachable by the `sprint: current → sprint: N`
re-tag at line 177. The risk is a future well-meaning edit that widens the glob.
Mitigate with a comment at the glob **and** a regression test (see the plan).

**A goal is never re-tagged, but it IS recorded.** `freeze-sprint.mjs` should
append a "Goals in this window" section to `sprints/N.md`, listing each
`sprint: current` goal — a read-only record. The goal's own `sprint: current`
persists across the freeze, because a goal outlives a budget window by design.

**Never materialize a task for the goal itself.**
`reconcile-tasklist.mjs:149-151` (`targetIssueId()`) resolves a task to an issue
via the first `#\d+[a-z]?` in its subject. A goal has no numeric id, so a
goal-level task would resolve to `null`, be invisible to the reconciler, and
never be completed — a permanently stale queue entry. Goals expand to member
tasks and are otherwise not represented in the TaskList. **This is a hard
non-goal.**

**Referential integrity: baseline-then-ratchet, not a day-one hard gate.** A
strict `check:goal-refs` cannot land against 512 existing violations. Follow the
established shape of `scripts/ir-fallback-baseline.json`: snapshot today's
violations, fail only on **growth**, auto-bank decreases. The 63 dangling names
split three ways, and the triage is a **separate follow-up issue**, not part of
this implementation:

| bucket                    | examples                                                                | resolution                    |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| alias of an existing goal | `standalone` (101), `host-independence` (37), `standalone-gap` (10)     | add to that goal's `aliases:` |
| needs a new goal file     | `test262-conformance` (128), `acorn-dogfood` (30)                       | create `plan/goals/<slug>.md` |
| junk / typo               | `real-world-compat,` (2+1), `performance,` (1), `native-messaging,` (1) | fix the issue frontmatter     |

### D7 — Every goal declares a DEFINITION OF DONE, of a declared kind

**Decision: every goal carries a `dod:` block with an explicit `kind:`. A
`measured` DoD is machine-evaluated and non-drifting; an `asserted` DoD is a
human judgement and is first-class, not a defect. Being unmeasurable is a
legitimate shape for a goal, not a reason to deny it a DoD.**

Two earlier framings were wrong and are retracted here:

- I was scoped with "goals shouldn't be completable, because long-lived
  containers drift." **Wrong** — goals are completable.
- I then over-narrowed to "goal completion must be _derived from a metric_."
  **Also wrong**, and the stakeholder's correction is the right generalisation:
  a DoD _could_ be a metric; it need not be.

The general model:

| `dod.kind`        | completes when                                          | evaluated by                       | drifts?   |
| ----------------- | ------------------------------------------------------- | ---------------------------------- | --------- |
| `measured`        | an expression over conformance data reaches target      | `eval-goal-metrics.mjs` on promote | no        |
| `all-issues-done` | its member set has no actionable issues left            | `eval-goal-metrics.mjs` on sync    | no        |
| `asserted`        | a named human/lead judges the `dod.statement` satisfied | a person, deliberately             | n/a (D10) |

**A `measured` DoD must be EXECUTABLE, not prose.** This is the load-bearing
constraint: a `dod.kind: measured` whose `expr` no evaluator can run is
`asserted` wearing a costume, and it is worse than an honest `asserted` because
it claims a rigour it does not have. `check:goal-refs` therefore rejects a
`measured` DoD whose `source`/`bucket` do not resolve against a real artifact.

```yaml
dod:
  kind: measured
  statement: "Every test in the ≤ES3 edition bucket passes on the host lane."
  source: test262-editions # must resolve to a real generated artifact
  lane: host # REQUIRED — host | standalone (see (c))
  bucket: "≤ ES3"
  target: 100
```

```yaml
dod:
  kind: asserted
  statement: "src/codegen/index.ts is under 2,000 lines and no module imports
    across the layer boundary documented in docs/architecture/codegen-axes.md."
  judge: tech-lead
```

Three measured refinements:

**(a) `measured` does not generalise to the existing 29 goals — which is exactly
why `asserted` must exist.** Surveying every goal file's `- **Target**:` line,
only **~4 of 29** have a predicate a machine can evaluate today
(`full-conformance` "48,102 / 48,102", `spec-completeness` "90 %+ pass rate",
`compilable` "CE < 500", `crash-free` "Traps → 0"). About **9** state an _impact
estimate_, not a completion predicate ("Estimated +1,200 tests" — a forecast of
delta; a goal is not done when it has delivered +1,200 tests). The remaining
**~15** are irreducibly qualitative: `maintainability`,
`contributor-readiness`, `developer-experience`, `observability`, `performance`
("competitive with JIT-compiled JavaScript"). So **~15 of 29 goals land as
`asserted`**, and that is the honest answer rather than a gap to close.

**(b) `Done` is NOT terminal for a `measured` goal — it can revert, and that is
a feature.** A `measured` goal at 100 % un-completes when a regression lands or
when the test262 submodule is upgraded and adds tests to its bucket. Hard
consequence: **a goal must never be frozen, archived, or removed from
`plan/goals/` on reaching `Done`** — contrast an issue, where `done` is a
one-way door. For `kind: measured` the state is always recomputed, never
persisted as a decision; a hand-edited state on a `measured` goal is a lint
error. For `kind: asserted` the state IS the persisted decision (D11).

**(c) A `measured` DoD MUST name its lane, or it is unfalsifiable.** `≤ ES3` is
83 % on the **host** lane; there is a separate
`test262-standalone-editions.json` with different numbers. The project's
recorded history is full of standalone-floor figures inflated by vacuous passes
and swallowed exceptions. A goal that declares itself `Done` off an inflated
lane is a false victory _with a machine's authority behind it_ — strictly worse
than an un-flipped umbrella issue. `dod.lane` is **required** for
`kind: measured`.

**(d) Keep `all-issues-done`, but guard TWO vacuity paths.** It is distinct from
`measured` (it reads the issue corpus, not conformance data) and is the right
DoD for goals like `ci-hardening` whose completion genuinely is "the work items
are done." But it has failure modes `measured` does not:

- **Zero members ⇒ trivially Done.** Not hypothetical: measured,
  **`full-conformance` currently has zero member issues**, so unguarded it would
  report Done while the project sits at 70.5 %. Guard: require ≥ 1 member issue
  to have ever existed.
- **All members non-actionable ⇒ Done with the work untouched.** A goal with 20
  `backlog` members has members (passes the first guard) and zero
  _actionable_ ones. This collides head-on with **D5**, which permits
  bulk-created members to land as `backlog` — a freshly-created `es5-static`
  with 30 backlog members would be **Done on creation**. Guard: for this DoD,
  `backlog` and `blocked` members count as **outstanding**. Only the terminal
  states `done` and `wont-fix` stop counting.

> **This filter is deliberately DIFFERENT from D4's expansion filter, and the
> two must never be unified.** D4 asks "what may I dispatch _now_?" ⇒
> `ready`/`in-progress` only. D7d asks "is any work left _at all_?" ⇒ everything
> non-terminal. Same vocabulary, opposite purpose. A well-meaning refactor that
> shares one predicate between them silently makes goals complete early.

`check:goal-refs` also rejects `all-issues-done` on a goal that has a
`measured`-capable population. When in doubt, `measured` beats
`all-issues-done`.

### D8 — Two decomposition axes: dependency is an EDGE, partition is a SUBSET

**Decision: `depends_on` and `partition_of` are separate fields with different
semantics, and — the operative difference — `partition_of` expands transitively
into the TaskList while `depends_on` does not.**

The stakeholder named both in one breath ("subgoals like 'everything except
dynamic features'" and "ES3 as a goal ES5 depends on"), but they are different
relations:

| axis           | field                        | means                                                   | expands into the queue? |
| -------------- | ---------------------------- | ------------------------------------------------------- | ----------------------- |
| **dependency** | `depends_on: [es3-complete]` | ordering / readiness — an edge in the existing goal DAG | **NO**                  |
| **partition**  | `partition_of: es5` | a scope-restricted subset of the _same_ population      | **YES, transitively**   |

**Why dependency must not expand.** If scheduling `es5` also dragged in
every member of `es3-complete` — and transitively `compilable`, `core-semantics`,
… — one goal would pull most of the backlog. Dependencies exist to tell you
_what to schedule first_, which is an operator decision, not an automatic one.
Adding `es5` while `es3-complete` is unmet should produce a **warning**
("depends on es3-complete, currently 83 % — schedule that first?"), never a
silent expansion.

**Why partition must expand.** A subgoal is not separate work; it is a
_narrower view of the same work_. `es5-static` ⊂ `es5`. Scheduling the
parent must reach the child's members, or the hierarchy is decorative. This is
the "hierarchical" property the stakeholder asked for.

**Representation — no new subsystem.** A subgoal is an ordinary goal file with
one extra field, `partition_of: <parent-slug>`. Issue membership is unchanged:
an issue names **exactly one** goal in `goal:`, always **the most specific one**
(the subgoal). Parent membership is _derived_ by walking `partition_of` upward —
never written into the issue. This keeps `goal:` single-valued (as all 3,056
existing uses are), keeps `sync-goal-issue-tables.mjs` working, and means
partitioning an existing goal requires re-tagging only the issues that move into
the narrower bucket.

**Invariants `check:goal-refs` must enforce:**

- `partition_of` forms a **tree** (one parent per goal) and is **acyclic** —
  cycle-guard the transitive walk, or expansion hangs.
- A partition's `dod.bucket` predicate must be a **subset** of its parent's,
  and sibling partitions of the same parent must be **disjoint**. Overlapping
  siblings double-count and make the parent's roll-up wrong.
- A goal may carry both `partition_of` and `depends_on` — they are orthogonal
  (`es5` is not a partition of anything, and depends on
  `es3-complete`; `es5-static` is a partition of `es5` and inherits
  nothing from the dependency).

### D9 — Ordering: "most important and ready first"

**Decision: expansion order is the tuple `(goal priority, issue priority,
horizon, id)`, and it is expressed through the EXISTING `[P1]`/`[P2]`/`[P3]`
subject tag. No new ordering mechanism.**

Measured constraint: a TaskList task JSON is
`{id, subject, description, status, blocks, blockedBy, owner}`
(`sync-current-tasklist.mjs:237-245`) — **there is no order or rank field.**
Ordering is conveyed entirely by the `[P1]`/`[P2]`/`[P3]` tag that
`subjectFor()` (line 189-195) writes and that agents read at claim time. So
"most important first" is implemented by mapping the _effective_ priority into
that tag, which requires no new mechanism at all.

- **`ready` first** is already guaranteed by D4 — nothing that is not
  `ready`/`in-progress` is ever in the queue.
- **Goal priority orders goals against each other**; issue priority orders
  within a goal (D3: issue wins when set). Effective tag = issue priority if
  present, else goal priority.
- **Horizon is a filter, not a sort key.** `budget-status.mjs --pick` already
  selects the highest-priority task whose `horizon` fits the remaining
  per-agent share. Goal expansion must not fight that: it supplies a `horizon`
  default (D3) and otherwise stays out of the way.
- **Cross-goal tie-break.** When two goals are both `current` with equal
  priority, order by `partition_of` depth (deepest/most-specific first — a
  partition is the narrower, more actionable slice), then by goal slug for
  determinism.

### D10 — Carry-over is the DEFAULT, and it is what actually defuses the drift objection

**Decision: a goal that is not Done at budget-window rollover simply stays
`sprint: current`. That is the expected, unremarkable default — not an anomaly,
not a warning, not something any tool reports as stale.**

This is the real resolution of the objection I was scoped with, and it is better
than the one I reached in D7. **My diagnosis was wrong.** #2860 and #3029 do not
drift because they are long-lived; they drift because they are **issues**, and
every tool that reads issues treats "still open" as a condition requiring
action. A goal that stays open across five windows is _normal_, and once nothing
treats openness as a defect, there is no drift signal to generate.

Concretely, three tools must agree that an open goal is uninteresting:

1. **`reconcile-tasklist.mjs` must never flag a goal.** **Verified: it does not
   and structurally cannot** — the script contains **zero** references to
   `goals` and never opens `plan/goals/`. So no exclusion code is needed. But it
   is exactly the kind of property a future edit silently breaks, so pin it with
   a test asserting the reconciler reports nothing for a `sprint: current` goal,
   and a comment saying goals are deliberately out of its domain (#3627 D10).
   **This is the single property that prevents the #2860-class false signal from
   reappearing on goals.**
2. **`freeze-sprint.mjs` must never re-tag a goal `sprint: {N}`.** Already
   structural via the `plan/issues/` glob (D6). Retagging would silently _retire
   an unfinished goal_ into a frozen retrospective record — the worst outcome,
   because the goal disappears from the live window without anyone deciding it
   should.
3. **The retrospective reports goal PROGRESS, not goal completion.** Since most
   goals span many windows, "completed goals: 0" would be the answer nearly
   every time and is useless. `sprints/N.md` should carry, per goal in the
   window, the **metric delta over the window** for `measured` goals (e.g.
   "`es3-complete`: 83 % → 91 %, 47 → 25 failures") and the count of member
   issues closed for the others. That requires snapshotting each `measured`
   goal's value at freeze so the next freeze can difference against it — store
   it in `sprints/N.md` itself, so the record is self-contained.

### D11 — Goal states: distinguish "finished" from "no longer pursuing"

**Decision: reuse the existing `- **Status**:`line's vocabulary, lifted into
frontmatter as`state:`, extended with terminal states that record *why* a goal
stopped.**

The escape hatch the stakeholder's "if not said otherwise" implies:

| state         | meaning                                  | carries over? | set by                                  |
| ------------- | ---------------------------------------- | ------------- | --------------------------------------- |
| `active`      | being worked                             | yes (default) | operator                                |
| `activatable` | dependencies met, not started            | yes           | derived from DAG (D11b)                 |
| `blocked`     | dependencies unmet                       | yes           | derived from DAG (D11b)                 |
| `done`        | **DoD satisfied** — we finished it       | no            | `measured`: computed; `asserted`: judge |
| `abandoned`   | deliberately stopped; DoD NOT satisfied  | no            | operator, `reason:` required            |
| `superseded`  | replaced by another goal                 | no            | operator, `superseded_by:` required     |
| `paused`      | deliberately not now; expected to resume | no            | operator, `reason:` required            |

**Do not collapse `done` / `abandoned` / `superseded`.** All three stop
carry-over, but conflating them destroys the reason — and the reason is the only
thing that tells a future reader whether the goal's population is covered
(`done`), knowingly uncovered (`abandoned`), or moved (`superseded`). A
`superseded` goal without `superseded_by:` orphans its members; make it a hard
error in `check:goal-refs`.

Note the existing files already carry values like `Partially activatable` and
`New (not active)` in prose. Normalize on transcription (D2); do not invent a
parallel field.

**(b) The DAG becomes machine-checkable — but scope the promise.** Once a goal
can be `done`, `goal-graph.md`'s prose rule ("a goal is activatable when all its
dependencies are met") becomes computable: `es5` is `activatable` when
`es3-complete` is `done`. `activatable`/`blocked` therefore become **derived**
states, not hand-set ones.

**Verified before promising it:** `plan/goals/goal-graph.md` is
**hand-maintained** apart from a single `<!-- AUTO:conformance-start -->` block
(the conformance line, written by `sync-conformance-numbers.mjs`). The 100-line
ASCII DAG and the "Goal Status Summary" table are hand-drawn prose. So:

- **Do** add a new `<!-- AUTO:goal-status-start -->` block to `goal-graph.md`
  carrying the generated status/activatability table, written by
  `eval-goal-metrics.mjs` — the same marker pattern
  `sync-goal-issue-tables.mjs` already uses.
- **Do not** promise to regenerate the ASCII DAG or replace the hand-written
  Goal Status Summary. Hand-drawn structure with a generated status block beside
  it is the honest split.
- Cross-check the two: `check:goal-refs` warns when a `depends_on` edge in
  frontmatter has no counterpart in the hand-drawn DAG, so the prose cannot
  silently diverge from the data.

### D12 — `goal:` becomes multi-valued, accepting scalar OR list

**Decision: the reader normalizes `goal:` to an array. A scalar stays legal
forever as a one-element list. There is no migration.**

Measured: **3,056 issues carry a scalar `goal:`; exactly 0 use list form.** A
rewrite would touch 3,056 files for zero functional gain, so the change is
entirely in `normalizeGoalRefs()` (D-plan) — `String` → `[String]`, `Array` →
itself.

**Measured hazard — do NOT accept a bare comma-separated form.** Five existing
`goal:` values already contain a comma (`real-world-compat,`, `performance,`,
`native-messaging,` — trailing-comma typos, part of the 512 dangling set). If
`goal: a, b` parsed as two goals, those five silently become multi-goal issues
pointing at garbage. **Multi-valued requires explicit YAML list syntax**
(`goal: [a, b]` or block form); a bare comma remains one value and is caught by
`check:goal-refs` as dangling.

**Four existing readers must be updated in the same PR** or they silently see
`"[a, b]"` as a single goal name: `scripts/sync-goal-issue-tables.mjs`
(groups by raw value), `scripts/assign-issue-goals.mjs`,
`scripts/update-issues.mjs`, `scripts/symphony.mjs`. All should call the shared
`normalizeGoalRefs()` from `goal-model.mjs`.

Note this makes an issue appear in **several** goal issue-tables — correct and
intended, but `sync-goal-issue-tables.mjs` currently assumes one row per issue
per corpus, so its dedupe (`byId`, keyed by issue id) must move to a
`(goal, issue)` key.

### D13 — `edition:` and `mode:` describe APPLICABILITY, not ownership

**Decision: two new optional issue fields. Neither is required, and `n/a` is
first-class.**

```yaml
edition: es5 # ≤es3 | es5 | es2015 … es2026 | n/a   (single value; see below)
mode: both # standalone | js-host | both | n/a
```

Measured: **neither field exists in any issue frontmatter today** — both are
genuinely new, so there is no legacy form to accept.

Three constraints, in order of how easily they are got wrong:

1. **Applicability ≠ ownership.** "descriptor `[[Set]]` doesn't check
   `[[Writable]]`" fixes ES5 tests in _both_ modes; it is not "owned" by a mode.
   These fields answer "what does fixing this affect?", never "who runs it."
   Keeping them orthogonal to `goal:` is the whole point — otherwise we have
   re-invented the single-owner problem D12 just removed.
2. **`n/a` must not be a forced choice.** A large share of the corpus is infra
   with no edition and no mode — `ci-hardening` (69 issues), `maintainability`
   (99), `test-infrastructure` (123), tooling, dashboards. Making these fields
   required would generate thousands of meaningless values, and a predicate that
   matched `n/a` loosely would sweep infra work into a conformance sprint. So:
   **absent and `n/a` both mean "not applicable", and a predicate never matches
   them unless it names `n/a` explicitly.**
3. **`edition` is a single value with `≤` semantics applied by the predicate,
   not by the field.** An issue is tagged with the **earliest** edition whose
   tests it affects (descriptor bugs ⇒ `es5`, even though ES2015 tests also
   exercise them). The predicate then decides whether it wants `== es5` or
   `<= es5`. Putting the ordering in the predicate rather than the tag is what
   keeps the exclusive-bucket ambiguity visible instead of buried.

**Prefer hand-set over derived.** These could in principle be inferred from
which test262 paths an issue cites — but #3621 showed the classifier mis-bucketed
4,144 tests, and a derived tag would have inherited that silently. Hand-set with
a `check:goal-refs` warning for conformance issues missing `edition:` is the
honest trade. Add both fields to `SCHEMA.md` under "Classification Fields".

### D14 — A goal may declare a PREDICATE, not just a member list

**Decision: a goal's membership is `members` ∪ `selector`, where `selector` is a
predicate over issue attributes. Either may be omitted. This is the round-4
centrepiece.**

```yaml
selector:
  edition: { lte: es5 } # or {eq: es5}, or a list
  mode: [standalone, both] # `both` MUST be included — see below
  status: [ready, in-progress] # optional; D4's filter applies regardless
```

`es5-conformance-standalone` is then a goal nobody tags — it _is_
`edition ≤ es5 AND mode ∈ {standalone, both}`.

**This dissolves problems already in this spec:**

- **The 512 dangling refs shrink to "legacy explicit tags only."** A predicate
  goal has no membership list, so it cannot dangle. `aliases:` (D2) is still
  needed, but only for goals that keep an explicit `members`/`goal:` tag.
- **It removes a forced choice the census already hit.** Verified in
  `plan/goals/es5.md`, written by `dev-es5-census`: _"Standalone lane —
  ES5 is 5,273 / 8,931 = 59 % … **it trails host by 1,226 tests and is tracked by
  the `standalone` goals**."_ That sentence exists **only** because an issue
  could hold one goal. Under D12 + D14 the standalone ES5 work is simply
  `edition: es5, mode: standalone` and appears in both goals with no retagging.
- **`es5-static` / `es5-standalone` / `es5-host` / `es3-complete` become free** —
  four goals over one set of issue attributes, which is exactly the partition
  (D8) I previously had to defer to the census.

**Predicate hygiene:**

- **`both` is the trap.** A selector for `mode: standalone` that omits `both`
  misses every dual-mode issue — which is most real semantics work. Make
  `mode: standalone` **expand** to `{standalone, both}` in the evaluator, and
  require an explicit `mode: {eq: standalone}` to mean strictly-standalone-only.
  Defaulting to the wrong one here silently halves a goal.
- A selector matching **nothing** is a hard error, not an empty goal (same
  class of bug as D7d's vacuous `all-issues-done`).
- `members` ∪ `selector` is a **union**, never an intersection — otherwise an
  explicitly-added issue outside the predicate would be silently dropped.
- Selectors match on issue attributes only, never on other goals — no recursive
  selectors, so evaluation stays a single pass.

#### The stability question: re-evaluate, and therefore `--prune` is now REQUIRED

Membership is computed, so it moves as issues are edited. **Decision:
re-evaluate on every sync, do not snapshot.** Reasons:

1. **Snapshotting reintroduces exactly the drift this model was built to avoid.**
   A frozen member list is an assertion that goes stale, which is the #2860
   failure mode wearing new clothes.
2. **Re-evaluation is already the existing behaviour.** `sync-current-tasklist.mjs`
   recomputes the whole queue from frontmatter on every run; issues already
   enter and leave as their `status` changes. Predicate goals add no new
   category of churn.
3. **A correction should take effect.** If an issue's `edition` was wrong and
   someone fixes it, the queue _should_ follow. That is the feature.

**But re-evaluation exposes a real asymmetry I have to correct from my own
earlier text.** I deferred `--prune` to a follow-up (D6 edge cases) on the
grounds that no-prune was pre-existing behaviour. **With predicate goals that
becomes unsafe**: the sync only ever _upserts_, so an issue that leaves a
predicate keeps its task forever. Additions would appear and removals would
not — strictly worse than either snapshot or clean re-evaluation, and invisible.

So, promoted from follow-up to **in-scope**:

- The sync **prunes** tasks whose issue no longer matches any scheduled goal.
- **Never prune a task that is `in_progress` or has a non-empty `owner`** —
  that would yank work out from under a running agent. Instead retag its
  subject `[OUT-OF-SCOPE]` and report it; a human decides.
- Every sync **reports adds and removes explicitly** (`+3 −1 via es5-static`).
  Movement must be visible, never silent. This is the concrete form of the
  lead's instinct, and it is what makes re-evaluation safe rather than merely
  current.

---

## Worked example: ES3 / ES5 (the intended first use)

> **STALE-NUMBER WARNING — read this before quoting any figure here.** An
> earlier revision of this spec quoted `ES5 = 9,000 / 3,958 / 13,075` from the
> committed `test262-editions.json` (2026-07-19). **Those numbers were produced
> by a broken classifier.** PR **#3621** (merged) fixed a 2,048-byte
> frontmatter-read window that was mis-bucketing **4,144 ES2015+ tests as ES5**.
> `13,075 − 4,144 = 8,931` — exactly the census figure. Anything derived from
> the pre-#3621 artifact is wrong by that margin.

Authoritative source is now the census in **#3626** / `plan/goals/es5.md`
(measured 2026-07-25 against the CI baselines in `loopdive/js2wasm-baselines`):

| bucket / lane          |  pass |  fail | total | pct  |
| ---------------------- | ----: | ----: | ----: | ---- |
| `ES5` host             | 6,499 | 2,432 | 8,931 | 73 % |
| `ES5` host, reachable¹ | 6,162 | 1,772 | 7,934 | 78 % |
| `ES5` standalone       | 5,273 |     — | 8,931 | 59 % |
| `≤ ES3` host           |     — |    43 |     — | —    |

¹ excluding the 660 failures that require `eval` (512) or `with` (148).

**Two consequences for this spec.** First, **a `dod.source` must be versioned
or dated** — a `measured` DoD silently changed meaning when #3621 landed, and
nothing flagged it. `check:goal-refs` should record the artifact's generating
commit alongside the value, so a classifier change surfaces as a DoD change
rather than a silent retarget. Second, **prefer hand-set `edition:` on issues
over deriving it from test data** (D13): derived values inherit whatever the
classifier currently says, including its bugs.

**The buckets are EXCLUSIVE, not cumulative.** `EDITION_ORDER = [0, 5, 2015, …]`
in `scripts/generate-editions.ts:315` assigns each test exactly one edition, so
the ES5 bucket does **not** contain the ≤ES3 tests. "100 % ES5" is therefore
ambiguous between the ES5 bucket alone and everything through ES5. **Every goal
file MUST state which it means in `dod.bucket`**, and a predicate (D14) must
write `edition <= ES5` explicitly when that is the intent — `edition == ES5`
means something materially different.

The stakeholder's instinct (ES3 as a separate goal ES5 depends on) resolves it
correctly, and decomposes into:

```
es3-complete          dod{kind: measured, lane: host, bucket: "≤ ES3", target: 100}
                      47 failures. Genuinely completable near-term.

es5-static            partition_of: es5
                      depends_on: [es3-complete]
                      dod{kind: measured, lane: host, bucket: "ES5 minus <census predicate>", target: 100}
                      ES5 bucket MINUS interpreter-dependent tests. Reachable now.

es5          depends_on: [es3-complete, runtime-eval]
                      dod{kind: measured, lane: host, bucket: "ES5", target: 100}
                      The remainder needs eval / new Function ⇒ the interpreter.
```

This is what makes 100 % an honest claim rather than an unattainable one: the
interpreter-dependent residue is quarantined into a partition that openly
depends on `runtime-eval`, instead of silently capping the parent below target
forever.

**Do not hardcode the exclusion predicate as "eval and new Function."** The
brief's own instruction is to take the exact partition from the census
(`dev-es5-census`), which had not landed at time of writing (verified: no
`plan/goals/es5*.md`, no `es5` string under `plan/`). `2927`
(interpreter foundation) and `2928` (E2 self-compile canary) are the existing
interpreter work the partition should depend on.

**Scale check for D4** — ES3's 47 failures will not map 1:1 to issues; a census
typically produces a handful of clustered issues. Even if it produced 30, that
is +30 on a 168-item queue under actionable-only expansion, versus the 364 a
single all-members goal would add. The rule holds at this use case.

---

## Implementation Plan

### Root cause

`scripts/sync-current-tasklist.mjs` is the only path from planning artifacts to
the live TaskList, and it reads exclusively from `plan/issues/*.md`
(`ISSUES_DIR`, line 61). `plan/goals/` is never opened, so a goal has no way to
express "schedule me." Everything else in this plan is plumbing around that one
gap.

### Changes

**File: `plan/issues/SCHEMA.md`**

- New section **"Goal Files"** after "Relationship Fields", documenting the D2
  frontmatter block, the D3 precedence rule, the D4 expansion rule, and the D5
  contract verbatim.
- Amend the `goal` bullet under "Relationship Fields": a value may match a goal
  filename **or** an entry in some goal's `aliases:`.
- Amend the `umbrella` documentation per the migration section below.

**File: `plan/goals/<slug>.md` (all 29)**

- Prepend the D2 frontmatter block. Populate `goal`, `title`, `state`,
  `depends_on` from the existing prose bullets and the `goal-graph.md` "Goal
  Status Summary" table — this is transcription, not new judgement.
- Set `dod.kind: asserted` on **all 29** in this PR, transcribing the existing
  `- **Target**:` prose into `dod.statement`. Measured: only ~4 have a
  machine-evaluable target today (D7a), and ~9 more state an _impact estimate_
  that must not be mistaken for a completion predicate. Promoting a goal to
  `kind: measured` is a per-goal decision requiring a real, resolvable
  `source`/`bucket` — do it in follow-ups, starting with the ES3/ES5 set, not in
  bulk here.

**File: `plan/goals/es3-complete.md`, `es5-static.md`, `es5.md` (NEW)**

- Create per the worked example. **Blocked on the `dev-es5-census` output** for
  the exact `es5-static` exclusion predicate — do not guess it.
- Add the ES3→ES5 edge to `plan/goals/goal-graph.md`'s DAG and Goal Status
  Summary table (hand-maintained prose; the autogenerated block is only the
  per-goal issue table).

**File: `scripts/eval-goal-metrics.mjs` (NEW) — D7, D11b**

- Reads `website/public/benchmarks/results/test262-editions.json` (and the
  `-standalone-` variant, selected by `dod.lane`), evaluates every
  `dod.kind: measured` goal, and rewrites its `state:` to `done` or back to
  `active` (D7b — the transition is bidirectional).
- Evaluates `dod.kind: all-issues-done` against the member set, with the
  zero-member guard (D7d). Never touches a `kind: asserted` goal's `state:`.
- Recomputes `activatable`/`blocked` from `depends_on` + dependency states, and
  rewrites the `<!-- AUTO:goal-status-start -->` block in `goal-graph.md`
  (D11b). Does **not** touch the hand-drawn ASCII DAG.
- Called from `scripts/run-pages-build.mjs` **after** `generate-editions.ts`
  (line 34) so it always reads freshly promoted data.
- Idempotent; writes only `state:` and the AUTO block; reports transitions in
  both directions.

**File: `scripts/reconcile-tasklist.mjs`**

- **No code change** — verified to contain zero references to `plan/goals/`, so
  goals are already outside its domain. Add a header comment recording that this
  is **deliberate** (#3627 D10): an open goal is the normal steady state and
  must never be reported as stale/drifted. Pinned by a test.

**File: `scripts/freeze-sprint.mjs` (D10, in addition to the D6 comment)**

- Snapshot each `sprint: current` `measured` goal's current metric value into
  `sprints/N.md` so the **next** freeze can report a per-window **delta**
  ("83 % → 91 %, 47 → 25 failures"). Self-contained in the retro file; no new
  state store. Report goal **progress**, never goal completion.
- Set `sprint: current` on **no goal** in this PR. Scheduling a goal is an
  operator act; landing the mechanism must be a behavioural no-op (see
  Acceptance).

**File: `scripts/goal-model.mjs` (NEW, ~70 lines)**

Single shared reader so the two consumers cannot disagree about membership.

- `parseGoalFrontmatter(text)` — same regex shape as
  `sync-current-tasklist.mjs:82`, plus flow-list parsing for `depends_on` /
  `aliases` (`[a, b]` and `- item` block form; `sync-goal-issue-tables.mjs:83-88`
  already has the block-form logic to copy).
- `normalizeGoalRef(v)` — **the normalizer both consumers must share**:
  `String(v ?? "").trim().replace(/,$/, "").toLowerCase()`. Today
  `sync-current-tasklist.mjs` does not read `goal:` at all, while
  `sync-goal-issue-tables.mjs:120` groups on the **raw, case-sensitive,
  comma-inclusive** value. If the new expansion normalizes and the table
  generator does not, the two will disagree about membership for values like
  `real-world-compat,` — the goal page will show an issue the queue does not.
  **Update `sync-goal-issue-tables.mjs` to call `normalizeGoalRef` too**, in the
  same PR.
- `loadGoals(goalsDir)` → `Map<slug, goal>`; skips `goal-graph.md`.
- `currentGoals(goals)` → goals with `sprint === "current"`, **plus their
  transitive `partition_of` descendants** (D8). Cycle-guarded with a visited
  set; a cycle is a hard error, not a silent truncation.
- `scheduledGoalSet(goals)` — the same walk exposed for `check-goal-refs.mjs`
  and `freeze-sprint.mjs` so all three agree on "which goals are in the window."
- `goalIndex(goals)` → `Map<ref, slug>` covering the canonical slug **and every
  alias**, all passed through `normalizeGoalRef`. Throws on an alias claimed by
  two goals (a silent-misrouting hazard).

**File: `scripts/sync-current-tasklist.mjs`**

- `readIssue()` (line 101-122): add `goal: normalizeGoalRef(fm.goal)` to the
  returned object.
- New `expandedByGoal(issue, idx, goals)` helper, immediately after
  `normHorizon()` (line 133). Returns the goal slug or `null`:
  - `null` unless `idx` maps `issue.goal` to a goal that is `sprint: current`
    **or is a transitive `partition_of` descendant of one** (D8) — the walk is
    over `partition_of` only, never `depends_on`, and must be cycle-guarded;
  - `null` if the issue's own `sprint` is a **numbered** value
    (`/^\d+$/` — the frozen-record guard from D4);
  - otherwise the slug. (`sprint: current` members return the slug too; they are
    already in the queue, so this is purely informational for the subject tag.)
- Full-scan selection (line 266-270): replace
  `.filter(i => i.sprint === "current")` with
  `.filter(i => i.sprint === "current" || i.viaGoal)`, where `viaGoal` is set
  from `expandedByGoal` during the map.
- `syncIssue()` (line 205): `if (issue.sprint !== "current") return;` becomes
  `if (issue.sprint !== "current" && !issue.viaGoal) return;`. **Line 206's
  `ACTIONABLE` check is deliberately left untouched** — that is D4's whole
  point. Add a comment saying so.
- `subjectFor()` (line 189-195): append `[G:<slug>]` after the horizon tag when
  `issue.viaGoal` is set.
- **Defaults from the goal (D3):** in `readIssue()`, when `fm.priority` is
  absent and the issue resolves to a goal, use the goal's `priority`; same for
  `horizon`. The issue's own value always wins. Note `normHorizon()` currently
  collapses "absent" and "m" — thread the raw value through so "absent" is
  distinguishable.
- **`--goal <slug>` fast path**, mirroring `--issue` (line 51-54, 257-264):
  syncs only that goal's members.
- **Warn** when one goal contributes > 40 net-new tasks (D4), and when a
  `sprint: current` goal expands to **zero** members (D5).

**File: `.claude/hooks/post-file-edit` (or wherever `--issue` is invoked)**

- **This is the bug that would make the feature look broken.** The hook calls
  `sync-current-tasklist.mjs --issue <path>`. A `plan/goals/*.md` path matches no
  entry in `issueFiles()` (line 96-99, which requires `^\d+[a-z]?-`), so
  `issues` resolves to `[]` (line 264) and **editing a goal to add
  `sprint: current` silently syncs nothing.** Route paths under `plan/goals/` to
  `--goal <slug>` (or, simplest, to a full scan).

**File: `scripts/freeze-sprint.mjs`**

- Comment at `listIssues()` (line 99-101): _"This glob deliberately excludes
  `plan/goals/*.md`. A goal is never re-tagged to a numbered sprint (#3627 D6) —
  it outlives the budget window. Widening this glob would corrupt goal
  scheduling."_
- After the "Rolled forward" section (line 205-211), append a read-only
  **"## Goals in this window"** list from `currentGoals()`. No writes to goal
  files.

**File: `scripts/check-goal-refs.mjs` (NEW) + `package.json` script `check:goal-refs`**

- Fails on: a goal file whose `goal:` ≠ its filename; a **numbered** `sprint:` on
  a goal (only `current` or absent is legal — D2); an alias claimed by two goals;
  an alias colliding with a real goal slug.
- **D7 checks:** every goal has a `dod:` with a valid `kind:`; `kind: measured`
  without `dod.lane` (unfalsifiable — D7c) or with a `dod.source` that does not
  resolve to a real artifact (prose masquerading as executable — D7); a
  hand-edited `state:` on a `kind: measured` goal (it is an output, not an input
  — D7b); `kind: asserted` without `statement:` + `judge:`;
  `kind: all-issues-done` on a goal with zero members ever (vacuously Done —
  D7d, the `full-conformance` trap).
- **D11 checks:** `state: superseded` without `superseded_by:`;
  `state: abandoned`/`paused` without `reason:`; a `depends_on` edge with no
  counterpart in `goal-graph.md`'s hand-drawn DAG (warn — D11b).
- **D12 checks:** a `goal:` value containing a bare comma (the 5 known
  trailing-comma typos — never silently split it into a list).
- **D13 checks:** an unknown `edition:`/`mode:` value; warn when a conformance
  issue (`goal` in a conformance goal, or `area: codegen`) omits `edition:`.
- **D14 checks:** a `selector` matching zero issues (hard error — vacuous goal);
  a selector naming an unknown attribute; a `dod.source` whose recorded
  generating commit differs from the current artifact's (the #3621 trap — the
  DoD silently retargeted).

**File: `scripts/sync-current-tasklist.mjs` (D14 additions)**

- Evaluate `selector` predicates against the issue corpus; membership is
  `members ∪ selector`. `mode: standalone` expands to `{standalone, both}`
  unless written as `{eq: standalone}`.
- **Prune** tasks that no longer match any scheduled goal — **except** tasks
  that are `in_progress` or have a non-empty `owner`, which are retagged
  `[OUT-OF-SCOPE]` and reported instead.
- Report `+N −M via <goal>` on every run so membership movement is visible.
- **D8 checks:** `partition_of` cycles or multiple parents (must be a tree);
  a `partition_of` target that does not exist; sibling partitions whose
  `dod.bucket` predicates overlap (double-counts the parent roll-up); a
  partition whose bucket is not a subset of its parent's.
- Baseline-ratchets dangling `goal:` refs against
  `scripts/goal-ref-baseline.json` (seeded at 512): fail on growth,
  `--update-on-decrease` banks improvement. Mirrors `check:ir-fallbacks`.
- Warns (does not fail) when a `sprint: current` goal expands to zero members.
- Wire into the `quality` CI job.

**File: `tests/planning-scripts.test.ts` (or nearest existing home)**

1. `freeze-sprint.mjs --force --dry-run` over a fixture containing a
   `sprint: current` goal file ⇒ the goal file is **not** in `toFreeze` and is
   unmodified. _This is the regression test that pins D6._
2. Goal `sprint: current` + member `status: backlog` ⇒ no task (D4).
3. Goal `sprint: current` + member `status: ready`, `sprint: Backlog` ⇒ task
   created, subject carries `[G:<slug>]`.
4. Goal `sprint: current` + member `status: ready`, `sprint: 68` ⇒ **no** task
   (frozen-record guard).
5. Member reached via `aliases:` ⇒ task created (the #2860 `goal: standalone`
   case).
6. Member with its own `priority: low` under a `priority: high` goal ⇒ subject
   tag is `[P3]` (D3 issue-wins).
7. Member with no `horizon:` under a `horizon: l` goal ⇒ subject tag is `[L]`.
8. No task is ever created whose subject lacks a `#<id>` reference (pins the D6
   non-goal — otherwise `reconcile-tasklist.mjs` can never complete it).
9. **D8:** goal `P` is `sprint: current`, goal `C` has `partition_of: P` and no
   `sprint:` ⇒ `C`'s ready members ARE queued (transitive partition expansion).
10. **D8:** goal `A` is `sprint: current` with `depends_on: [B]`, `B` not
    scheduled ⇒ `B`'s members are **NOT** queued, and a warning is emitted.
11. **D8:** a `partition_of` cycle is a hard error, not a hang.
12. **D7:** a `kind: measured` goal reaching target flips `state:` to `done` on
    recompute, and flips **back** when the metric regresses (pins D7b
    non-terminality). A hand-edited `state:` on a `measured` goal is a lint
    failure; on an `asserted` goal it is the intended write path.
13. **D7d:** a `kind: all-issues-done` goal with zero members is **rejected**,
    not reported Done (the `full-conformance` trap); and one whose members are
    all `backlog` is **NOT** Done (the D5 collision — outstanding counts
    everything non-terminal, unlike D4's dispatch filter).
14. **D10:** `reconcile-tasklist.mjs` reports **nothing** for a `sprint: current`
    goal that has been open across several windows — no stale, no drift, no
    merged-but-open. _This is the test that pins the #2860-class false signal out
    of existence for goals._
15. **D10:** after `freeze-sprint.mjs --force`, an unfinished goal is still
    `sprint: current`, and `sprints/N.md` records its metric **delta**, not a
    completion claim.
16. **D12:** an issue with `goal: [a, b]` appears in **both** goals' tables and
    is queued once (task keyed by issue id — no duplicate).
17. **D12:** `goal: real-world-compat,` stays **one** dangling value; it is
    never split into a list.
18. **D14:** a goal with `selector: {edition: {lte: es5}, mode: [standalone, both]}`
    queues an issue tagged `edition: es5, mode: both` and one tagged
    `mode: standalone` — and does **not** queue `mode: js-host`.
19. **D14:** `mode: standalone` in a selector matches `mode: both` issues;
    `mode: {eq: standalone}` does not.
20. **D14:** an issue whose `edition` is corrected so it leaves a predicate has
    its task pruned — **unless** the task is `in_progress`/owned, which is
    retagged `[OUT-OF-SCOPE]` and reported, never deleted.
21. **D14:** a selector matching zero issues is a hard error, not an empty goal.

### Edge cases

- **Issue already `sprint: current` AND a member of a `current` goal** — no
  duplicate: `syncIssue()` is keyed by issue id (line 248) and idempotent. Only
  the subject gains `[G:<slug>]`.
- **First run reports a large "updated" count.** Adding the `[G:…]` tag changes
  `subjectFor()` output for every issue that is both `current` and a `current`
  goal member, so the sync rewrites those task files. Expected, not a bug —
  call it out in the PR description. (Zero if this PR schedules no goal, per the
  no-op Acceptance criterion.)
- **Removing `sprint: current` from a goal orphans its expanded tasks.** The
  script only upserts; it never deletes. This is pre-existing behaviour for
  issues, but one goal edit can now orphan ~24 tasks at once. **Accepted for
  this issue** (`reconcile-tasklist.mjs` still closes them as their issues
  complete); note it in the script header and file `--prune` as a follow-up.
- **Alias claimed by two goals** — hard error in `goalIndex()`. Silent
  misrouting of ~100 issues is the worst available failure.
- **Trailing-comma / case-variant `goal:` values** — handled by
  `normalizeGoalRef`, and only correct because both consumers share it.
- **Goal file with no `## Issues` section** — `sync-goal-issue-tables.mjs:169`
  `continue`s. Expansion must not depend on the table; it is generated output.
- **A member's `status` flips to `done` while its goal stays `current`** — the
  existing `skipped_done` path (line 206-209) and the reconciler handle it
  unchanged.

### Migration: `umbrella:` → `parent:`

**Measured: all 142 `umbrella:` values are numeric issue ids** — the identical
shape and meaning as `parent:` (issue → issue containment). It is **never** a
goal reference, so the brief's "redundant with `goal:` in some cases" does not
hold. Only 3 issues carry both fields. This is a pure mechanical rename across
13 container issues.

| container | members | container  | members |
| --------- | ------: | ---------- | ------: |
| **#2860** |  **79** | #3178      |       8 |
| #1781     |      19 | #3182      |       6 |
| #1712     |      11 | #3185      |       6 |
| #2039     |       5 | others (6) |  1 each |

Three phases, no big bang:

1. **Readers accept both.** Any consumer of `parent:` also reads `umbrella:`.
   Zero file churn. (`sync-current-tasklist.mjs` reads neither today, so this is
   a no-op there.)
2. **Writers emit `parent:`.** Update `SCHEMA.md` and `/create-issue` to
   document `parent:` only and mark `umbrella:` deprecated. New issues stop
   producing it. Migrate the 142 files opportunistically — whenever an issue is
   touched for other reasons, drop `umbrella: N` in favour of `parent: N`. For
   the 3 issues carrying both, keep `parent:` and delete `umbrella:` only if the
   two agree; otherwise flag for manual triage.
3. **Drop `umbrella:`** from readers and `SCHEMA.md` once the count reaches
   zero.

**What happens to #2860 specifically:** nothing structural. It remains issue
#2860, `status: in-progress`, `sprint: current`, an ordinary XL epic. Its 79
`umbrella: 2860` children become `parent: 2860` in phase 2. Its own
`goal: standalone` is a dangling ref and is fixed by adding `standalone` to
`standalone-mode`'s `aliases:` (D2) — which is also what makes it and its
children reachable when `standalone-mode` is scheduled.

### Explicitly out of scope

- **The `reconcile-tasklist.mjs` merged-PR title-scan bug** (D1). Real,
  measured, confirmed by PR #3501 — and unaffected by this design. Separate
  issue.
- **Triaging the 63 dangling goal names.** This issue ships the gate and the
  baseline; the triage is a follow-up.
- ~~**`--prune` for orphaned tasks.** Follow-up.~~ **Promoted to in-scope by
  D14** — predicate membership makes removals routine, and upsert-only would
  make them invisible.
- **Scheduling any goal.** Landing the mechanism must change no behaviour.
- **Promoting the existing 29 goals to `dod.kind: measured`.** All land as
  `asserted`; per-goal promotion is a follow-up requiring a real, resolvable
  `source`/`bucket` (D7a).
- **The `es5-static` exclusion predicate.** Comes from `dev-es5-census`; this
  spec defines the container, not its contents.

## Acceptance criteria

1. Adding `sprint: current` to a goal file surfaces **exactly** the members
   whose `status` ∈ {`ready`, `in-progress`} and whose `sprint` is not a
   numbered value — including members reached transitively via `partition_of`,
   and excluding anything reached via `depends_on`. Verify by diffing
   `--dry-run` before and after. (As a dated illustration, on the 2026-07-25
   corpus `spec-completeness` yields 24 rather than 364; **assert the invariant,
   not the number** — the corpus moves.)
2. Editing a goal file **through the hook** syncs the queue (the `--issue`
   fast-path gap is closed).
3. `freeze-sprint.mjs --force` never modifies a goal file, and `sprints/N.md`
   records the window's goals — pinned by test 1.
4. No task exists whose subject lacks a `#<id>`; `reconcile-tasklist.mjs`
   reports no new unresolvable tasks.
5. `check:goal-refs` passes at the 512 baseline and fails when a PR adds a
   dangling `goal:` value.
6. An issue's own `priority:` is never overridden by its goal's.
7. **This PR is a behavioural no-op**: with no goal carrying `sprint: current`,
   `sync-current-tasklist.mjs --dry-run` reports zero created and zero updated.
