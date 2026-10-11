# Actual changed-root hook qualification

Executed `pnpm run test:changed-root` at published HEAD
`0d210cfa5f9a214309681ef1b8ecf2a6c260c6d7` with independently approved local
parent manifest. The hook selected exactly the unchanged append regression
and routed it through the trusted parent. Node22.23.2; source tree953f74f8.
Runner and hook bytes are unchanged from the first trusted-parent archive.

Actual result:36 passed, zero failed/skipped/todo, strict exit0,16,520ms,
44,273,881 stdout bytes. Complete custody before/after is equal. All38 graph
envelopes, raw streams, reporter, decoded records and receipts are retained.
The renamed previous reporter is also retained, not discarded.

Replay `node plan/log/6915-linear-append-20261007/ci-hook-parent-20261008/compare.mjs`.
It requires exact equality of all36 observation graphs and the completion
graph against repaired-v3, with no filtered graph fields. Deliberately different
execution provenance is retained and independently validated by the parent.
The original failing baseline, previous repairs, fixtures and first execution
archive remain unchanged. No native implementation or retirement proof follows.
