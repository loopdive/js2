---
id: 7357
title: "Two pin tests red on main: effect-table text pins and the retired host-assisted string_constants lane"
status: done
sprint: current
created: 2026-11-17
updated: 2026-11-17
completed: 2026-11-17
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: test
area: ir, tests
goal: ir-full-coverage
related: [3518, 3526, 6708, 6921, 6979, 7354, 7356]
---

# #7357 — Two pin tests red on main

## Problem

Two root test files failed on `origin/main` 3d73ae6c93. CI runs a root test file
only when a PR touches it (the `quality` changed-root gate), so the failures went
unnoticed until #7354 D1 touched both files.

- **A. `tests/issue-3518-semantic-verification-ownership.test.ts`** — the
  relocation receipt for `src/ir/effects.ts` → `src/ir/analysis/effects.ts`
  pinned the full text hash of `effectsOf` and `isSideEffecting`. Both are tables
  over every IR op and grow with each new op. They were last re-pinned on
  purpose in 402cec73c3 (#6921, 2026-10-08). These later commits changed them
  without re-pinning, and were **not re-certified** against the pin:
  - `effectsOf`: 7abd9c099f, 0b02a7d813 (#7104); 5789d2a7ee, 404bc1d361,
    418aad3714, 2fb17de5b1, 1af5492c11, ebfdc92ead, 47eecc4c76, fc62f9ed1b,
    c1b9c82608, 44bc571430 (#7106/#7107); dacce136ab (#7118);
  - `isSideEffecting`: 2fb17de5b1 (#7106 S3a); be746dc990, aad8abd899,
    81aa579416 (#7269).
- **B. `tests/issue-3526-string-boundary-const.test.ts`** — 5 tests. Bisected
  over main: the parent 429e8ffbc6 passes, and 612cea9864 (#6708 S6-A,
  "semanticProviders defaults to native-first") is the first failing commit.
  That flip is deliberate and reviewed. Since #6979 S7-a, `semanticProviders:
  "host-assisted"` and `nativeStrings: false` are compile errors, so the
  host-assisted `string_constants` import layout these tests pinned cannot be
  produced by any option. Checked: `generateModule` with either option throws
  "selected the host-assisted semantic profile, which #6979 removed". JS-host
  output did not change by accident; the lane was retired.

## Implementation Plan

- **Module:** the two test files only. No source change, no host code deleted.
- **A:** keep `effectsOf` and `isSideEffecting` in the receipt's ordered
  declaration list, with no text hash (`null`). Their ownership is still checked:
  declared exactly once in `src/ir/analysis/effects.ts`, at their position in
  its declaration list, and forwarded unchanged by `src/ir/effects.ts`, which
  the existing identity assertion covers. The other rows keep their hashes. The
  receipt counts (17/7/22… and 94) are unchanged, because the rows stay.
- **B, per test:**
  1. *counts a regex literal as demand, so a regex-only module names its
     namespace.* It asserted four `string_constants` globals for a regex-only
     module. **Retired:** that namespace is never imported since S6-A/S7-a; on
     the native core the regex pattern and flags are native literals. No
     regex-specific test remains; the manifest's demand rules are still covered
     by the provider-policy tests of the same file ("freezes NOTHING when the
     demand is absent", "names ONLY the namespaces the module actually imports").
  2. *binds the host lane's literal at the SAME import position.* **Rewritten**
     to its living counterpart on the default JS environment: the literal adds
     no `string_constants` import. The module imports exactly the native-string
     bridge, `env.__str_from_mem`, `env.__str_to_mem` and `env.__str_extern_len`.
  3. *keeps the string_constants16 namespace INTERLEAVED in scan order.*
     **Retired:** neither namespace exists on any lane (native lanes are covered
     by "imports no string_constants namespace on any native-strings lane").
  4. *keeps the FUNC import ahead of the IR-only literals it mints.*
     **Retired:** same reason; the `wasm:js-string.concat` host import is not
     emitted by the native core.
  5. *answers every hazardous literal shape exactly as JavaScript does.*
     **Rewritten:** the behaviour is live. The test read raw Wasm exports; it now
     reads them as an embedder does, through `jsFacingExports` (the compiled JS
     value adapter) with `setInstance` bound, as the shared compile helpers have
     done since #6708.
- **Kept untouched:** the 37 other tests of the 3526 file.
- **Quality criterion:** no hash of an evolving table; every changed assertion
  states a behaviour today's compiler produces, or the retirement says why it
  cannot.

## Result

- Both files pass in full: semantic-verification-ownership 35/35, 3526
  string-boundary 39/39.
- Non-vacuity of A (file copies, restored; the unmutated control passes). For
  `effectsOf` and for `isSideEffecting`, each of these fails the file:
  - a duplicate as an overload signature, caught by the receipt's exactly-once
    check (2 and 1 tests);
  - a duplicate implementation (the module no longer loads);
  - a rename in the owner;
  - a redefinition in the old path instead of the forward (2 tests).
