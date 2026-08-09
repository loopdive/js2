---
name: regression-triage
description: Bulk-classify a list of test262 pass→other transitions from a CI run. Distinct from handle-regression (single fix) and analyze-regression (diff two runs). Use after a merge wave when the sharded run reports N regressions and you need to bucket them by root cause and decide which are false positives.
---

# Regression Triage

Given the regression artifact from a sharded test262 CI run, bucket the regressions by path prefix and error message pattern, sample each concentrated bucket to determine root cause, and classify as **false positive**, **known gap**, or **real regression** with a fix path.

## When to use

- After a sharded run fails with N regressions but the net delta is positive (e.g. "+479 pass with 80 regressions")
- When you need to decide which regressions block a baseline commit vs which get filed as follow-ups
- When multiple merges could have introduced overlapping fails and you need to untangle them

Distinct from:
- `handle-regression` — fixing a single specific regression
- `analyze-regression` — diffing two JSONL result files (that's step 1 here)

## Step 1: Download the merged report artifact

```bash
mkdir -p output/regressions-$(date +%s)
gh run download <RUN_ID> -n test262-merged-report -D output/regressions-<TIMESTAMP>
```

Files: `test262-report-merged.json`, `test262-regressions.txt`, `test262-results-merged.jsonl`.

`test262-regressions.txt` only has summary stats. Extract the actual regression LIST by diffing the merged jsonl against the current baseline:

## Step 2: Compute the regression list

The baseline JSONL is fetched on demand from `loopdive/js2wasm-baselines`
(#1528). Make sure the local cache is populated before diffing:

```bash
node scripts/fetch-baseline-jsonl.mjs
```

```python
import json
base = {}
with open('.test262-cache/test262-current.jsonl') as f:
    for line in f:
        try:
            d = json.loads(line)
            base[d['file']] = d['status']
        except: pass

new = {}
new_details = {}
with open('/tmp/regressions-<TS>/test262-results-merged.jsonl') as f:
    for line in f:
        try:
            d = json.loads(line)
            new[d['file']] = d['status']
            new_details[d['file']] = d
        except: pass

regressions = [(f, new.get(f, 'missing'), new_details.get(f, {}))
               for f, s in base.items()
               if s == 'pass' and new.get(f, 'missing') != 'pass']
print(f"Total: {len(regressions)}")
```

## Step 2b: Read the mechanical triage signals from `diff-test262` (#2098)

`scripts/diff-test262.ts` now encodes two triage rules that used to live only
in memory files, so you can read them straight off the diff output instead of
re-deriving them per run:

```bash
npx tsx scripts/diff-test262.ts .test262-cache/test262-current.jsonl \
  /tmp/regressions-<TS>/test262-results-merged.jsonl
```

- **`ct_flake` vs `ct_suspect`** — `pass → compile_timeout` regressions are
  split by the BASELINE-side `compile_ms`. `ct_flake` (baseline ≤ 5000 ms) is
  runner-load noise and already excluded from the gate. `ct_suspect` (baseline
  > 5000 ms, or no recorded baseline compile) is the only timeout bucket worth
  reading — a PR may have pushed an already-slow compile over the 30s wall. The
  suspect file list is printed inline (non-`--quiet`).
- **Regression bucket signature** — a 16-hex sha256 over the sorted set of
  `{file, destination-status}` for all non-CT regressions. It is independent of
  the PR, run order, and counts. If **another open PR's diff prints the same
  signature**, the two PRs regress the identical cluster ⇒ it is almost
  certainly pre-existing **baseline drift**, not N independent regressions
  (`feedback_baseline_drift_cross_check`). Triage the cluster once and treat the
  matching PRs as false-positive-by-drift.

These are output-only signals — they do not change the gate. Use them to skip
ahead: a run whose only regressions are `ct_flake` + a signature that matches
another PR needs no per-test sampling.

## Step 3: Bucket by path + error message pattern

```python
from collections import Counter
import re

path_buckets = Counter()
msg_buckets = Counter()

for f, s, d in regressions:
    parts = f.split('/')
    path_buckets['/'.join(parts[:5])] += 1
    msg = d.get('error') or d.get('message') or ''
    nmsg = re.sub(r'\d+', 'N', msg[:80])
    msg_buckets[(s, nmsg)] += 1

print("Top path buckets:")
for p, c in path_buckets.most_common(10):
    print(f"  {c:4d}  {p}")

print("\nTop error patterns:")
for (status, msg), c in msg_buckets.most_common(10):
    print(f"  {c:4d}  [{status}]  {msg}")
```

Any bucket with ≥ 5 regressions is worth investigating as a cluster. Singletons get grouped under "scattered / individual".

## Step 4: Sample each concentrated bucket

For each top bucket, read 2-3 sample tests and their error messages:

```python
samples = ['test/...', 'test/...', 'test/...']
for s in samples:
    d = new_details.get(s, {})
    print(f"[{d.get('status')}] {s}")
    print(f"  {(d.get('error') or d.get('message') or '')[:200]}")
```

Look for patterns that indicate **false positives** (see `feedback_regression_analysis.md`):

1. **Wrapper-object method coincidences** — tests that "pass" on main because the assertion happens on a dropped expression. Pattern: `String.prototype.writable = true` compiled as `drop`. After a real defineProperty fix, the test actually runs and fails.
2. **Error-class mismatch on harness error** — test expects `TypeError` in setup, harness throws `TypeError` at a different point that happens to match.
3. **Zero-assert tests** — test has `found 0 asserts in source`, our harness marks that as pass.
4. **Negative tests where both branches return pass** — old bug, check if still present.
5. **Coincidental SyntaxError** — test expects parse-phase SyntaxError, our compiler throws one at codegen for an unrelated reason.

## Step 5: Classify buckets

For each bucket, decide:

| Classification | Meaning | Action |
|----------------|---------|--------|
| **False positive** | Pre-existing coincidental pass, exposed by correct behavior | Patch baseline or skip-list with comment; file tracking issue for real fix later |
| **Known gap** | Real gap we haven't addressed yet | File follow-up issue if not already filed |
| **Real regression** | Genuinely broken by the merge | Revert or fix-forward; open bug against the responsible PR |

## Step 6: Act on classification

### False positives

File/extend a tracking issue (reference the specific test paths). Don't block the merge. Optionally patch the baseline with a skip-list comment citing the issue.

### Known gaps

File a new issue with `create-issue` skill. Use the bucket path + count in the title (e.g. "TypedArray.prototype.toLocaleString element null path (9 FAIL)").

### Real regressions

- Single-PR cause: revert the PR or push a fix-forward commit
- Multiple-PR interaction: bisect via `git log --oneline <old-baseline>..<new-baseline>` and test each commit

## Step 7: Summarize for the tech lead

```
Total: N regressions
  ~X false positives (tracked by #issue-A, #issue-B)
  ~Y known gaps (filed #NNN, #NNN)
  ~Z scattered / individual (acceptable, noise)
  0 real regressions requiring revert
Action: admin-merge proceed, baseline refresh with allow_regressions=true.
```

## Output

An updated plan/diary.md entry and any new issue files in plan/issues/.

## Notes

- **Always sample before classifying** — don't assume from the path name. A `test/built-ins/Array/prototype/indexOf/*.js` regression could be a real Array.prototype bug OR a coincidental harness issue. 2-3 minutes of reading saves hours of chasing.
- **Concentrated buckets almost always share a root cause** — if you find one real regression in a bucket of 9, the other 8 are very likely the same bug.
- **Scattered singletons are usually noise** — flakes, hash-sensitive tests, or harness quirks. Don't chase them individually unless they're blocking.
