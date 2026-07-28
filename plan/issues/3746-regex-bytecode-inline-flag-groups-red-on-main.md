---
id: 3746
title: '37 "red on main" regex tests were a LOCAL Node-22 artifact (green in CI on 24); 6 real failures remain in #2175/#1817'
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: core-semantics
related: [1911, 2175, 1817, 3726]
origin: "bisected against clean upstream/main during #3705/#3753 work, 2026-07-28"
---

# #3746 — ~40 tests red on `main`, invisible

## The finding

Bisected against a clean `upstream/main` worktree while verifying unrelated
work. Every one of these fails **identically with and without** the changes
under test, i.e. they are red on `main` itself:

| suite                                           | failing |
| ----------------------------------------------- | ------: |
| `tests/regex-bytecode.test.ts`                  |      20 |
| `tests/issue-1911-regex-phase2d.test.ts`        |      17 |
| `tests/issue-2175-regexp-proto-readers.test.ts` |       3 |
| `tests/issue-1817.test.ts`                      |       3 |

The first three are regex; `#1817` is the `>>>` unsigned-result family.

## Why nobody was told

None of these suites is in a required check. This is the same structural gap
that let the four suites #3705 fixed sit red on `main` — and #3726 recorded the
lesson for the two it touched. It has not been fixed as a class: a suite that is
not in a required check can go red on `main` and stay there indefinitely.

## CORRECTED — 37 of the 40 were never our bug

The failing patterns are inline modifiers (`(?i:…)`, `(?-i:…)`, `(?s:…)`,
`(?m:…)`) — ES2025 **regexp-modifiers**. Both suites use the HOST `RegExp` as
their ORACLE:

```ts
const expected = new RegExp(p, f).test(input); // issue-1911
expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input)); // regex-bytecode
```

and V8 gained modifiers after Node 22. On this runtime:

```
node v22.22.2
new RegExp("(?i:abc)")  →  Invalid regular expression: /(?i:abc)/: Invalid group
```

So the exception came from the ORACLE constructing its expectation, before our
pipeline was consulted at all. The error text in the failure output —
`Invalid regular expression: … Invalid group` — is node's own, which is what
gave it away.

Nothing was wrong with the regex bytecode compiler's flag-group scoping. My
first reading of this issue asserted exactly that, from the pattern shapes
alone, without checking who threw.

## Fix

Ask the engine whether it supports modifiers and skip those cases when it does
not:

```ts
const HOST_SUPPORTS_INLINE_MODIFIERS = (() => {
  try {
    new RegExp("(?i:a)");
    return true;
  } catch {
    return false;
  }
})();
```

Skipped rather than deleted: the cases are correct and become live the moment
the runtime gains modifiers. A hard-coded version check would rot; asking the
engine is the durable form of the question.

Result: `regex-bytecode` 258 passed / 20 skipped; `issue-1911` 70 passed /
17 skipped. Both green.

## VERIFIED ON NODE 24 — the 37 were never red in CI

`.github/workflows` already runs Node **24 / 25 / latest**; only this dev
container was on 22. Installing 24 and re-running settles it:

```
node v24.18.0  →  new RegExp("(?i:abc)")  OK

regex-bytecode:  278 passed (0 skipped)   ← all 20 modifier cases RUN and PASS
issue-1911:       87 passed               ← all 17 modifier cases RUN and PASS
```

So our pipeline lowers inline modifiers correctly, and always did. The 37 were
red **only on Node 22**, where the host oracle cannot parse the pattern.

That corrects this issue twice over. The first filing blamed our flag-group
scoping (wrong — it was the oracle). The second said "~40 red on main in no
required check, nobody was told" (also wrong for these 37 — CI is on 24, where
they are green and always were). The capability probe is still the right fix:
it makes a local run on an older Node accurate instead of noisy, and the cases
run for real wherever the engine supports them — which the Node-24 run above
demonstrates.

### The devcontainer was never the problem

`.devcontainer/Dockerfile` is already `FROM node:25`, and the CI matrix is
overwhelmingly 25 (23 references) with a few on 24. So every _sanctioned_
environment for this repo already has RegExp modifiers.

The Node-22 runtime was specific to the **Claude Code on the web** remote
execution container — a different, multi-runtime agent image
(`/opt/node20`, `/opt/node21`, `/opt/node22`) that is provisioned outside this
repo and cannot be changed from a Dockerfile here. That is the whole source of
the false positive: an environment nobody declared, running two majors behind
everything that is declared.

`.nvmrc` now pins **25**, matching `.devcontainer/Dockerfile` and the dominant
CI version, so an nvm-based local checkout lands on the same major as every
other sanctioned environment. `engines.node` is deliberately left at `>=20` —
that is a statement about what the published package supports, not about what
developing it needs, and nothing in the compiler requires 24+.

## Still open — the 6 that ARE real

Both reproduce on Node 24, so they are genuinely ours and red in CI too:

- [ ] `tests/issue-2175-regexp-proto-readers.test.ts` — 3 failures.
      `RegExp.prototype` flag-bool / `.flags` / `.source` accessor dispatch on a
      correct `this`.
- [ ] `tests/issue-1817.test.ts` — 3 failures. **NOT the `>>>` semantics the
      suite name suggests.** The four plain `>>>` cases pass; the three that
      fail are the ones compiled with `{ fast: true }` / the native i32
      annotation, and they fail to COMPILE:

      ```
      IR path failed for shr: function typeIdx parity mismatch: IR=36, legacy=14
        — keeping legacy body [IR-FALLBACK]
      IR-first (#2138): shr failed after its legacy body was skipped
        [unpatched-slot; ir-unified]
      ```

      So it is an **IR-first slot/type-parity** bug (#2138): the IR and legacy
      lowerings disagree on a function type index, and under IR-first the legacy
      body has already been skipped, so there is nothing to fall back to and the
      compile fails outright. The `>>>` unsigned result is incidental — it is
      just what these particular fixtures happen to compute. Needs its own issue
      against the IR-first slot machinery rather than the bitwise lowering.

      Recorded rather than fixed: this is the third time in this issue that the
      obvious reading of a failure was wrong (flag-group scoping → host oracle;
      "red in CI" → red only on Node 22; "`>>>` family" → IR-first parity), and
      a fourth guess is worth less than a correct hand-off.

## Acceptance criteria

- [x] `regex-bytecode` and `issue-1911` pass — verified on Node 24 (fully) and
      on Node 22 (with the unsupported cases skipped).
- [x] Local Node pinned to match CI.
- [ ] `issue-2175`'s three accessor cases fixed.
- [ ] `issue-1817`'s three `>>>` cases fixed.
