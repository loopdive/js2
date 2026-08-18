---
id: 4117
title: "`claim-issue.mjs --allocate` reserves against the FORK's `issue-assignments` ref — two lanes get the same id and it reports `pr_scan=ok`"
status: done
completed: 2026-08-03
assignee: ttraenkler/senior-4096-elision
superseded_by: 4045
sprint: 78
created: 2026-08-03
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: tooling
goal: dev-workflow
related: [4045, 2531, 3880, 3598, 4096]
---

# #4117 — the atomic allocator is atomic against the wrong ledger

> **SUPERSEDED BY #4045**, which filed the same mechanism a day earlier with
> three more incidents. Fixed there; this file is kept as the fourth incident
> and for the one correction below that #4045 needs. Do not work this issue
> separately — read #4045.
>
> **Controls live with the primary record**, in
> `tests/issue-4045-one-assignment-ledger.test.ts` — including the two
> properties this incident contributed: a reservation another lane made on
> upstream must block a second `--allocate`, and a claim written directly to
> upstream must be visible to `--check` (it answered `UNASSIGNED` here). They
> are NOT duplicated under a `tests/issue-4117-*.ts` name: two test files for
> one mechanism is how a fix gets half-reverted later, with the surviving file
> still green.
>
> **The correction, and it matters:** #4045 records `--allocate` reporting
> `pr_scan=ok` while an open PR had held the id for 40 minutes, and concludes
> the open-PR scan is broken too. In THIS incident the scan was innocent — PR
> #4055 was created 11 minutes AFTER the reservation, so a correct scan would
> still have said `ok`. Two incidents that look identical, different causes.
> Check the timestamps before blaming the scan.

`--allocate` is documented (CLAUDE.md, #2531) to reserve the next id
**atomically** against `origin/main` ∪ every open PR's added issue files ∪
**ids already reserved on the orphan `issue-assignments` ref**. In a checkout
where `origin` is the **fork**, that third set is read from and written to the
**fork's** `issue-assignments` ref, which is a *different ledger* from
upstream's. Two lanes therefore keep two independent reservation books, and the
allocator's guarantee is vacuous across them.

This is not a hypothetical. It handed the same id to two lanes on 2026-08-02.

## Evidence — two ledgers, same id, 24 minutes apart

```
$ git show upstream/issue-assignments:4113.json
{ "id": "4113", "assignee": "ttraenkler/codex",
  "requested_by": "ttraenkler/codex", "status": "in-progress",
  "branch": "codex/4113-ir-final-alloc-provenance",
  "claimed_at": "2026-08-02T21:10:58Z", "write_id": "91573-ddb7ju0t" }

$ git show origin/issue-assignments:4113.json      # origin == the FORK
{ "id": "4113", "assignee": "",
  "requested_by": "ttraenkler/senior-4096-elision", "status": "reserved",
  "reserved_at": "2026-08-02T21:35:13Z", "write_id": "35203-ar8fcwop",
  "pr_scan": "ok" }
```

The codex lane claimed 4113 on **upstream's** ref at 21:10:58Z. 24 minutes
later `--allocate` handed 4113 to a second lane, wrote it to the **fork's** ref,
exited **0**, and recorded `pr_scan: "ok"`.

The collision surfaced ~30 min later as a red required `quality` check
(`Issue-ID open-PR collision gate (#3598)`) on PR #4056, and cost a renumber
plus a CI round-trip.

## The open-PR scan is NOT the defect — check the timing before blaming it

The obvious hypothesis is "the open-PR scan missed PR #4055". It did not:
**#4055 was created at 2026-08-02T21:46:23Z**, eleven minutes *after* the
21:35:13Z reservation. At reservation time no open PR carried the id, so a
correct open-PR scan would still have answered `ok`.

The only signal that existed at 21:35 was the **reservation ref record**, which
is exactly the protection `--allocate` claims to provide — and it was on
upstream's ref, invisible to a fork-rooted allocator. Fixing the PR scan would
not have prevented this; it would only have narrowed the race window from 24
minutes to 11.

## Secondary: `--check` cannot see a reservation, and names the wrong ref

```
$ node scripts/claim-issue.mjs --check 4113
#4113 is UNASSIGNED.
claim-issue: OK — #4113 is unassigned (verified against origin/issue-assignments) (exit 0)
```

At that moment **both** ledgers carried a 4113 record — the fork's a
`reserved` one written minutes earlier by the caller itself, upstream's an
`in-progress` claim. The answer "UNASSIGNED" is wrong under either. Two
compounding faults:

1. it reports **claims** only, so a `reserved` record is invisible to the tool
   that writes `reserved` records — you cannot audit your own allocation;
2. it says "verified against `origin/issue-assignments`", naming the **fork's**
   ref as though it were authoritative, which reads as reassurance.

A detector that answers "nothing there" when it is looking at the wrong book
and cannot see half the records in it is the "detector that cannot say I don't
know" shape.

## Live exposure

`4116` and `4117` (this file) were reserved by the same fork-rooted path and
exist **only** on the fork's ledger — hand-verified absent from upstream's ref
and from `upstream/main` at creation time, but with the identical race window.
Every id allocated from a fork checkout carries it.

## Acceptance criteria

- `--allocate` resolves the `issue-assignments` ref against **upstream**
  (whatever the remote is named — resolve by URL/`gh-resolved`, not by the name
  `origin`), reads the union of both ledgers if both exist, and writes where a
  parallel lane will read it.
- Running `--allocate` from a fork checkout and from an upstream checkout at the
  same time cannot yield the same id — demonstrated with a real two-lane test,
  not asserted.
- When the ref cannot be resolved to upstream, `--allocate` **refuses** rather
  than silently reserving against a local book (a reservation nobody else can
  see is worse than no reservation, per #3880's own reasoning about
  `--no-pr-scan`).
- `--check <id>` reports `reserved` records as well as claims, states WHICH ref
  it read (with its remote URL), and never answers `UNASSIGNED` on the strength
  of one ledger when another exists.
- Kill-switch seen to fail: with the fix reverted, the two-lane test collides
  again.

## Not in scope

The `#3598` open-PR collision gate is working correctly and caught this — it is
the backstop, not the bug. Nothing here argues for weakening it.
