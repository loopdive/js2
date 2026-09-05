---
id: 4767
title: "Upstream-suite worker truncates reports >64 KB at the pipe buffer, wiping cookie from 63740/63740 to 212/63740"
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: dogfood, tooling
goal: npm-library-support
sprint: current
related: [3995, 4756, 4898]
files:
  - tests/dogfood/upstream-suite-compile-worker.mjs
  - tests/dogfood/upstream-suite-worker-protocol.mjs
  - tests/issue-4767.test.ts
---

## Problem

The `npm-compat` dashboard reported **cookie at 212 / 63740 (0.3 %)**, down from a
clean **63740 / 63740**. The drop looked like a catastrophic compiler regression —
63,528 newly failing tests in one package — but no compiled-cookie behaviour
changed at all. The measurement harness lost the result.

Every failing test lived in exactly one file:

| file | native | Wasm (before fix) |
| --- | --- | --- |
| `src/parse-cookie.spec.ts` | 30/30 | 30/30 |
| `src/parse-set-cookie.spec.ts` | 85/85 | 85/85 |
| **`src/stringify-cookie.spec.ts`** | 63528/63528 | **0/63528** |
| `src/stringify-set-cookie.spec.ts` | 97/97 | 97/97 |

`212 = 30 + 85 + 97` — every other file passed completely. An all-or-nothing
zero across a single file is the signature of a lost result, not of 63,528
independent assertion failures.

The recorded "compile error" for that file was the harness's own IPC sentinel
leaking into the error channel:

```json
{ "file": "src/stringify-cookie.spec.ts", "success": false, "binaryBytes": 0,
  "errors": [{ "message": "__JS2WASM_COMPILE_COMPLETE__:4855" }] }
```

## Root cause

`emit()` in `tests/dogfood/upstream-suite-compile-worker.mjs` wrote the worker's
single terminal JSON result and exited immediately:

```js
writeFileSync(process.stdout.fd, `${JSON.stringify(value)}\n`);
process.exit(exitCode);
```

The parent (`runIsolatedCompile` in `upstream-suite-runner.mjs`) captures that
stdout **through a pipe** (`spawn` with `stdio: ["ignore", "pipe", "pipe"]`). A
pipe accepts only its buffer — 64 KB on Linux — before the remainder has to be
drained asynchronously by the reader. `process.exit()` does not wait for that
drain, so any report larger than the pipe buffer was cut off mid-document.

`stringify-cookie.spec.ts` builds a ~63.5 K-case fuzz table (every BMP code
point) and its report is **~508 KB**, so it was truncated to exactly the buffer
size. The parent's `JSON.parse(stdout)` then threw, fell into its catch, and
used `stderr.trim()` as the failure detail — and stderr held nothing but the
`__JS2WASM_COMPILE_COMPLETE__` sentinel. With no result, all 63,528 tests in the
file were scored as failures.

Measured on the regressing commit, same worker, same input:

| stdout destination | bytes delivered |
| --- | --- |
| file (`> out`) | 508,384 (complete) |
| **pipe (`\| wc -c`)** — what `spawn` uses | **66,010** (truncated at ~64 KB) |

The three small files each emit far less than 64 KB, complete in one synchronous
write, and were never affected — which is why the failure looked package-specific
rather than size-specific.

### Provenance

`git bisect --first-parent` over 111 mainline commits, zero skips, verifying the
real harness result at each step:

- first bad commit: **`89058479f`** — "Merge pull request #4898 from
  ttraenkler/codex/npm-package-compile-once" (2026-08-26 02:47 UTC)
- verified parent `6a5f67238`: `63528/63528 Wasm` ✅
- verified `89058479f`: `0/63528 Wasm` ❌

#4898 rewrote `emit()` from `process.stdout.write(...)` + `process.exitCode = 1`
(a natural exit, which flushes) to `writeFileSync` + `process.exit()`. Its
comment shows the intent — guarantee the disposable child cannot be held open by
abandoned upstream timers, streams, or scheduler handles, turning a finished
result into an outer worker timeout. That goal is sound; the flush was the
casualty.

**The committed artifact lags the code**, which is worth knowing when dating a
regression from `npm-compat.json`: `npm-compat-refresh` measures for ~24 min and
promotes through a PR, so the artifact landing on commit X reflects an older
main. The artifact still read `63740/63740` at `766d91e88`, hours after the bug
had actually landed. Bisect on observed behaviour, never on artifact timestamps.

## Fix

Keep the forced exit, but take it from the write callback so the payload is
actually flushed first:

```js
process.stdout.write(`${JSON.stringify(value)}\n`, () => {
  process.exit(exitCode);
});
```

This preserves #4898's guarantee (the child still exits regardless of lingering
handles) while making the result survive an arbitrarily large report.

The emit path moves into `tests/dogfood/upstream-suite-worker-protocol.mjs` as
`emitWorkerResult()` — it is transport, it belongs beside the rest of the worker
protocol, and putting it there makes it directly testable without standing up a
compile.

## Repro

`tests/issue-4767.test.ts` guards the transport rather than any one package:
it spawns a child that emits an over-buffer payload through the real
`emitWorkerResult`, reads it back over a real pipe, and requires it byte-for-byte.

Confirmed to catch the original defect — with the pre-fix
`writeFileSync` + immediate `process.exit()` restored, the large-report case
fails with `SyntaxError: Unterminated string in JSON at position 146176`, while
the small-report case still passes, which is exactly the size-dependence that
made this look package-specific.

## Acceptance criteria

- [x] `pnpm run dogfood:cookie-upstream-suite` reports **63740/63740**, with
      `src/stringify-cookie.spec.ts` at `63528/63528 Wasm`
- [x] The worker's ~508 KB report survives a pipe intact (508,384 bytes through
      `| wc -c`, matching the file-redirect byte count)
- [x] No `__JS2WASM_COMPILE_COMPLETE__` sentinel appears in any recorded
      `errors[].message`
- [x] The three small cookie spec files stay at 30/30, 85/85 and 97/97
- [x] `tests/issue-4767.test.ts` passes on the fix and fails on the pre-fix
      emit path

## Notes

- The compiled cookie package was never broken. `compile()`, validation and the
  21-op differential harness stayed green throughout; only the transport of the
  result regressed.
- Any upstream suite whose report crosses 64 KB was exposed to the same
  truncation, so other packages' counts in `npm-compat.json` measured between
  `89058479f` and this fix may be understated. The post-merge
  `npm-compat-refresh` re-measures every package, so the artifact corrects
  itself on the next cycle — no hand-editing of `npm-compat.json` is needed
  (main is its sole writer).
- Reported by the project lead from the dashboard, 2026-08-26.
