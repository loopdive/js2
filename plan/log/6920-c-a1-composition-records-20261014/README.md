# #6920 A-C1 composition records (2026-10-14)

Complete records for the A-C1 composition measurement on
PR 6666, published as requested in review comment 6200963986.

## Source identities

| Side | Tree | Identity check |
| --- | --- | --- |
| base | `git archive a4d4c99ccc9cd4fe27bd6dba91180fc575616529` (B's #6662 head), extracted to a snapshot dir | `diff -rq` against a fresh `git archive` of that sha: 0 differences outside `node_modules` |
| composed | clean worktree at `9d681274c4f40081c99168396c7e3a2975362c4a` (parent `a4d4c99c`) | `git status` clean at run time |

Both trees used the same `node_modules` (symlink) and the same
`pnpm-lock.yaml` (sha256 in `environment.txt`).

## Inputs and commands

- `input-75-files.txt`: the 75 test files run on each side.
- `base-files.txt` (74) / `composed-files.txt` (75): the files actually passed
  to vitest. The base tree lacks `tests/issue-6920-vector-representation.test.ts`
  (added by the composition), so the base run has 74 files.
- `rerun.sh.txt`: the full sequential run, both sides, JSON reporter,
  `--testTimeout=35000`. Output: `base.json.txt`, `composed.json.txt`,
  `base-stdout.txt`, `composed-stdout.txt` (both exit 1: failures exist on both sides).
- `nue-rerun.sh.txt`: isolated re-run of
  `tests/issue-6920-native-number-undefined-execution.test.ts`, twice per side,
  after `rerun.sh` finished. Output: `nue-{base,composed}-{1,2}.json.txt`.
- `environment.txt`: node, vitest, lockfile hashes, nproc. Captured
  2026-10-15, after the runs, from the same container and trees.
- `counts.txt`: suite/test counts read from each JSON report.

## per-case.tsv

One row per test case in the union of both reports: 1,450 rows. Columns:
`file`, `test_full_name`, `occurrence` (1-based index among cases with the same
file and full name), `base_status`, `composed_status` (`absent` when the case is
not in that report), `same_first_failure_line`, and each side's first failure line.

**Correction:** the per-case table I described earlier keyed rows by
file + full name only, which collapsed duplicate names to 1,407 rows. This
version keys by occurrence too. The conclusions do not change.

## Results

| | base | composed |
| --- | --- | --- |
| tests | 1,432 | 1,450 |
| passed | 1,384 | 1,404 |
| failed | 46 | 44 |

20 status differences:

- 18 `absent → passed`: the new vector-representation tests.
- 2 `failed → passed` in `issue-6920-native-number-undefined-execution`.
  The isolated re-runs show this file is unstable on both sides: base 6/10 and
  6/10 passed, composed 6/10 and 7/10 passed.

44 cases fail on both sides. All have the same first failure line except
`issue-3518-lowering-cycle`, where the expected inventory length is 33 on base
and 34 on composed (the composition adds one module to the pinned list).

`issue-4376-post-position-main-inventory-successor` times out and is not
measured on either side.

## Hashes

`SHA256SUMS.txt` lists the full sha256 of every file here except itself.
Verify with `sha256sum -c SHA256SUMS.txt`.

The vitest JSON reports are stored as `*.json.txt` so the repository's
JSON formatter does not rewrite them; the bytes are exactly what vitest wrote.
