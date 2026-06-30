---
id: 2890
title: "Standalone #1897 regression guard must be host-free-aware — don't count leaky-pass → host-free-fail as a regression (#2879 §4 per-test completion)"
status: done
assignee: ttraenkler/sendev-promise
completed: 2026-06-30
created: 2026-06-30
priority: high
task_type: tooling
area: tooling
goal: standalone
sprint: current
horizon: m
related: [2879, 1897, 2867, 2864, 2865, 2866]
---

# Standalone regression guard must be host-free-aware

## Problem

#2879 made the standalone **floor** (high-water `check-standalone-highwater.mjs`)
key on `host_free_pass`, so a leaky-pass → native-carrier migration that removes
a host dependency is scored as progress, and a mid-flight migration (leaky pass →
incomplete native carrier → fail) does not breach the floor (host_free_pass is
unchanged — the leaky pass never counted).

But the **per-test** standalone regression guard (`scripts/diff-test262.ts`, run
by the `Standalone regression guard (#1897)` step in `test262-sharded.yml`) still
counts **raw status pass→fail flips** and is NOT host-free-aware. So it trips on
exactly the carrier migrations #2879 set out to credit.

### Evidence (from #2867 PR #2367 merge_group, run 28428158322)

- High-water floor PASSED: `current host_free pass=13136, mark=12883, delta=+253`.
- #1897 standalone guard FAILED: `net -1337 (improvements 76 − regressions 1413)`.
- A 120-file sample of the regressed buckets classified against the standalone
  baseline JSONL: **19 pass→fail flips, ALL leaky-baseline** (the baseline pass
  carried an `env::` import / `host_import_leak_class`), **0 genuine host-free
  regressions**.

So every regression the guard flagged was a **leaky pass → host-free fail** — a
test that only "passed" by leaning on the host Promise, now honestly failing
under the native carrier. Per #2879 §4 this is NOT a regression. This blocks
EVERY carrier-migration PR (#2867 Promise, #2865 async-gen, #2866 symbol, …);
#2864 generators slipped through only because generators run synchronously and
don't convert host-passes to fails at this scale.

## Fix (surgical, additive, gated)

In `scripts/diff-test262.ts`, **excuse a pass→fail flip from the GATED
regression count ONLY when**:
1. the **baseline** entry was a **leaky pass** (`host_import_leak_class` set, or
   its `imports` carried an `env::` import), AND
2. the **current** result is **host-free** (no `host_import_leak_class`, no
   `env::` import).

**Preserve protection (critical):** a baseline that was ALREADY host-free
flipping to fail STILL counts at full strength. Only `leaky → host-free-fail` is
excused (per #2879 §4). The js-host (`pass`-count) lane must be unaffected, so the
behaviour is **gated behind a flag** (`--exclude-leaky-baseline-regressions`)
that ONLY the standalone guard step passes; the catastrophic guard / dev-self-merge
/ triage callers are byte-unchanged unless they opt in.

The reported `Regressions (pass → other)` line stays unchanged (transparency); a
new `Excused leaky→host-free regressions (#2879 §4)` line surfaces the excused
count, and only the **gated** `regressionsWasmChange` count (and thus the net /
ratio / bucket gates) drops the excused flips.

## Acceptance

- `diff-test262.ts` exports a pure, unit-tested host-free-aware filter.
- Both-directions verification: (a) a leaky-baseline → host-free-fail flip is
  excused from the gated count; (b) a genuine host-free-baseline → fail flip STILL
  counts (full strength).
- The flag is opt-in; the js-host catastrophic guard / dev-self-merge are
  byte-unchanged without it.
- `test262-sharded.yml` `Standalone regression guard (#1897)` passes the flag.
- Unblocks #2867 (+253 host_free) and the rest of the carrier track.
