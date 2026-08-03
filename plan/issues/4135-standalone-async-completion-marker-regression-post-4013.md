---
id: 4135
title: "REGRESSION (#4013): 264 standalone async tests stop signalling completion — 121 were passing; 119 of those 121 use no dynamic code"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: async
goal: standalone-mode
related: [1781, 3469, 3545, 3421, 2928, 4013]
origin: "2026-08-03 delta /harvest-errors, baselines 2090e7bfd342 (gitHash b65d2f5a, 13:19Z standalone) vs 8dac2d708782 (gitHash c480fb66); oracle v12/honest both sides"
---

# #4135 — standalone: `async completion marker not observed` jumps 17 → 274 at PR #4013

## TL;DR

The standalone lane's `async completion marker not observed` bucket went from
**17 records to 274** (264 of them `scope_official`) in a single promotion.
**121 of those files were passing** at the previous baseline.

The jump is attributable to **exactly one merge**: PR **#4013**
(`codex/2929-direct-eval-capture`). Eight consecutive baseline promotions
between the two harvests hold the count flat at 17; the count moves only at the
promotion of `b65d2f5a`.

| baselines commit | js2 gitHash | landed through | `async completion marker not observed` |
| --- | --- | --- | ---: |
| `8dac2d708782` | `c480fb66` | (previous harvest) | 17 |
| `c6dfcec4f341` | `617fcb65` | #4059 | 17 |
| `ed08c4d865e6` | `28604516` | #4058 (#4010 own-property table) | 17 |
| `5712d415c8a6` | `73ee7169` | #4063 (#4010 S2 tombstones) | 17 |
| `4ab9e86d1143` | `df21c880` | #4065 (IR final async) | 17 |
| `e30c0710d8f0` | `e5c7747c` | #4081 (class-member retirement) | 17 |
| `8a61375f8bee` | `ddb14e6d` | #4083 (#4131 annexB) | 17 |
| **`2090e7bfd342`** | **`b65d2f5a`** | **#4013 (direct-eval capture)** | **274** |

## This is NOT the interpreter-linking arm — control included

PR #4013 does two separable things: (a) it makes CI's standalone shards link the
**real** runtime-eval provider instead of the refusal provider, and (b) it lands
a large codegen refactor (`call-tail-dispatch.ts` +778, `calls.ts` +593,
`eval-inline.ts` +617, `closure-exports.ts`, `closures/*`, `generators-native.ts`).

**The control that separates them:** of the 121 files that regressed from `pass`
into this bucket, **119 contain no `eval`, no `Function(`, and no `with`**. Over
all 234 official standalone regressions in this window, **209 are dynamic-code-free**.
So this is collateral of arm (b), the codegen refactor — not a consequence of the
lane gaining eval.

## Population

264 official records. Path concentration:

| area | files |
| --- | ---: |
| `language/expressions/class/elements` | 50 |
| `language/statements/class/elements` | 50 |
| `language/expressions/class/dstr` | 24 |
| `language/statements/class/dstr` | 24 |
| `language/expressions/async-generator/dstr` | 12 |
| `language/statements/async-generator/dstr` | 6 |
| `language/expressions/object/dstr` | 6 |
| rest (for-await-of, top-level-await, Promise) | 92 |

Shape split: async-method 100, async-gen 90, await 41, async-private-gen-meth 24.

Samples (all `pass` → `fail` at `b65d2f5a`):

- `test/language/expressions/class/elements/same-line-method-rs-static-async-method-privatename-identifier-alt.js`
- `test/language/statements/class/elements/same-line-async-method-private-method-getter-usage.js`
- `test/language/expressions/class/dstr/async-private-gen-meth-static-obj-ptrn-rest-getter.js`
- `test/language/statements/for-await-of/async-gen-dstr-const-async-obj-ptrn-rest-getter.js`

## The other 143 members are a loud → quiet degradation

The 143 members that were already failing did not merely stay failing — they
**lost their diagnostic**. Their previous signatures were specific assertion
failures:

| old signature | files |
| --- | ---: |
| `Test262:AsyncTestFailure:Test262Error: Expected SameValue(...)` | 38 |
| `Test262:AsyncTestFailure:Test262Error: a should be an own property` | 24 |
| `Test262:AsyncTestFailure:Test262Error: TypeError: Cannot convert undefined or null to object` | 24 |
| `Test262:AsyncTestFailure:Test262Error: x should be an own property` | 21 |
| (already in this bucket) | 10 |

A test that used to say *what* was wrong now says only *nothing happened*. That
is worse than the failure it replaced, independently of the pass-count change.

## Why this matters beyond the 264

**#3469 — "Standalone async tests: originalHarness completion marker unobservable
host-free (channel + drain gate)" — is `status: done`.** Its symptom is back.
Either the channel/drain gate regressed, or a second mechanism produces the same
observable. #3545 (`standalone: an uncaught trap inside a microtask job silently
ends __drain_microtasks`) is `status: ready` and describes a mechanism that would
present exactly this way — check it first.

## Acceptance criteria

- [ ] Root cause identified as codegen (which of the #4013 changes) or as a
      re-opening of the #3469 channel/drain mechanism — stated explicitly, not
      inferred from the count.
- [ ] The 121 previously-passing files pass again in the standalone lane.
- [ ] The 143 files that lost their diagnostic report a specific assertion
      failure again (they may still fail — they must not fail *silently*).
- [ ] A regression test covering at least one `class/elements` async-method
      shape and one `async-generator/dstr` shape.
- [ ] If #3469's mechanism is implicated, #3469 is re-opened rather than a
      parallel fix landed beside it.

## Reproduction

```bash
node scripts/fetch-baseline-jsonl.mjs --force            # host lane
curl -sLO https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl
grep -c 'async completion marker not observed' test262-standalone-current.jsonl   # 274
```

Bisect by fetching the same file at the baselines commits in the table above.
