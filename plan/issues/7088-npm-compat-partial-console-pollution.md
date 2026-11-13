---
id: 7088
title: "npm-compat partial workers must publish after an upstream suite mutates console.log"
status: done
assignee: ttraenkler/codex
created: 2026-10-18
updated: 2026-10-18
priority: high
horizon: xs
feasibility: easy
reasoning_effort: high
task_type: bug
area: ci, testing, npm-compat
es_edition: n/a
language_feature: npm-compat-refresh
goal: reliability
sprint: current
parent: 6979
related: [3988, 5385, 6708, 6749]
---

# #7088 — npm-compat partial workers must survive `console.log` pollution

The post-S6 npm-compat refresh for main revision
`4103aab54b1d8703fece24d94e233c87abfa55e0` measured React's package entry and
upstream suite, wrote its focused partial JSON, then failed before the workflow
could upload it:

```text
TypeError: console.log is not a function
    at scripts/generate-npm-compat-report.mjs:3425:11
```

React's upstream tests execute in the report generator process and may replace
host globals, including `console.log`. The generator correctly treats package
code as untrusted for result values, but its final focused-worker status writes
still called the mutable global console. The failed step's cleanup then deleted
the already-written partial, so the coordinator could only carry the old React
row forward as stale. This blocks #6979's post-flip npm-compat entry evidence.

## Scope

- Write the two post-measurement messages on the `--partial-output` path
  directly to `process.stdout`, whose method the package suite did not receive
  and cannot replace through the compiled console capability.
- Keep aggregate-report logging unchanged; this issue is about focused matrix
  workers after an upstream suite has run.
- Add a source guard covering both partial-path messages so a later cleanup
  cannot reintroduce a dependency on the mutable `console` object.

## Acceptance

- [x] The focused partial path contains no `console.*` call after it writes the
      package fragment.
- [x] `tests/issue-7088-npm-compat-partial-console-pollution.test.ts` passes.
- [x] A refreshed React matrix row uploads its partial instead of failing after
      measurement.

## Evidence

- GitHub Actions run `39159738679`, job `117770413335`, React row at
  `4103aab54b1d8703fece24d94e233c87abfa55e0`.
- The failure occurs after 261 seconds in `Measure package`, at the first
  `console.log` following the synchronous partial `writeFileSync`.
- Local focused replay on the same source revision completed both new stdout
  writes, exited zero, and retained `/private/tmp/npm-compat-react-7088.json`.
  Local Node 24 lacks the exnref opcode enabled by CI's Node 25, so its perf
  lanes compile-error before execution; that runtime difference is unrelated
  to the post-suite publication failure this issue owns.
- The fix landed through PR `#6760` at
  `4df0306bd1fa4776335f2115b6d3f7d847fafe87`. The immediately triggered
  refresh run `39170921043`, React job `117803649762`, completed successfully
  at `2026-10-18T22:12:18Z` and uploaded artifact `12152735922`
  (`npm-compat-partial-fast-react`). Its partial reports the exact source
  revision above and a measured `perf.lanes.jsHost` row, proving the
  post-suite publication path survived React's host-global mutations.
