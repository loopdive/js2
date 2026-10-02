---
id: 6810
title: "Execute semantic eval guards with the full native provider in CI"
status: in-progress
sprint: current
created: 2026-10-02
updated: 2026-10-02
priority: high
feasibility: medium
task_type: infrastructure
area: test262
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-native-eval-ci
---

# Executable native eval CI contract

## Evidence and scope

The changed-root quality gate builds only the REFUSAL provider and selects
the interpreter engine without `TEST262_FULL_RUNTIME_EVAL=1`. Issue 5157's
semantic fixture correctly refuses to treat this as an executable evaluator.
Keep its fifteen diagnostics and expectations unchanged; infrastructure
non-results are not semantic passes or additional measured regressions.

The latest completed native-interpreter anti-rot run 36703238178 at
`df9e3e54` compiled and canary-verified an 8,471,499-byte full provider in
123,125 ms. Its later guards failed on missing `runtime-bundle.mjs` and
parallel workers' default 512 MB heap. This proves build feasibility, not
semantic acceptance or a current-source pass rate.

Own only the changed-root preparation/engine environment hunk in
`.github/workflows/ci.yml`, the native-interpreter anti-rot workflow, a focused
workflow-contract guard, and this issue MD. PRs 6425/6430 touch independent
earlier CI hunks; preserve them on integration. No compiler, interpreter,
runtime provider selector, existing semantic fixture, or IR edits belong here.
The worktree is `/Users/thomas/.codex/worktrees/es6-native-eval-ci/js2`,
branch `codex/es6-native-eval-ci`, base
`1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99`.

## Implementation plan

1. Prepare the full native provider after the existing compiler/runtime
   bundle builds, with an explicit 3 GiB builder heap. Keep canary verification
   and provider-cache keys; never fall back to refusal for semantic scoring.
2. Explicitly enable the full native interpreter for changed-root tests.
   Preserve the unchanged serialized runner, its selected file population,
   assertions, and its existing caller-configurable worker heap.
3. Fix the anti-rot lane's missing runtime bundle and serialize its semantic
   guards with an explicit worker heap. Retain the measured floor and all
   original runner scope; do not demote checks or permit fewer tests.
4. Add focused structural controls for both workflow contracts, including
   negative controls rejecting refusal-only preparation and absent full-engine
   selection. These controls prove wiring, not interpreter semantics.
5. Under the team's serialized heavy lease, run the focused controls and
   normal gates, then build/canary-verify the full provider and execute the
   retained semantic fixture. Report all registered verdicts and exact source
   provenance, including remaining semantic failures; do not claim this CI
   infrastructure slice fixes the iterator or tuple defects.

## Acceptance and handoff

- [ ] Changed-root eval tests receive an executable native provider, not REFUSAL.
- [x] Anti-rot has both worker bundles and bounded serialized workers.
- [ ] Focused wiring controls and normal publication gates pass.
- [x] Current-source full-provider canary and complete semantic receipt recorded.
- [ ] Separate upstream PR opened; no existing semantic expectations weakened.

Full ES2015 completion still requires all 11,778 frozen originals to pass
under the authoritative standalone runner. No Test262 gain is credited to
workflow assertions alone. Issue 5157 and issue 6739 retain semantic ownership.

### 2026-10-02 implementation and first validation checkpoint

The two owned workflow hunks now prepare/select the full native provider,
retain the unchanged changed-root runner, build the missing anti-rot runtime
bundle, and bound/serialize its semantic guard workers. All six existing
guard files and the original floor measurement/enforcement remain present.
No compiler, provider selector, Test262 scope, or semantic fixture changed.

Focused structural controls are **8/8 pass**, one file, zero pending,
terminal session 55448 exit 0 (288 ms overall). They include refusal-only,
missing full-engine selection, absent/duplicate step, missing runtime bundle,
parallel-worker, and missing heap negative controls. They prove workflow
wiring, not executable evaluator semantics. TypeScript 7 validation is
terminal session 27666 exit 0 under verified Node 24.19.0, pnpm 10.30.2,
and 4 GiB Node heap. Owned-file Prettier and whitespace checks pass.

Only an existing verified dependency directory was linked; no packages were
installed and no shared dependency target was modified. The team's heavy
lease was returned to the iterator owner after these terminal checks. Next:
obtain the lease, build/canary-verify a current-source full native provider,
record actual selection and complete semantic verdicts, then run normal
commit/push gates and open the separate upstream PR. None of that pending
work is inferred complete from the historical successful anti-rot build.

### 2026-10-02 full native executable verification and retained failures

Current-source production baseline is exactly
`1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99`; this branch has no production
source edits. Normal CI-equivalent preparation under verified Node 24.19.0,
pnpm 10.30.2, and a 3 GiB builder heap completed as session 39731, exit 0.
Both compiler/runtime bundles built, then the full native provider compiled
in 75,373 ms to **6,243,897 bytes** and passed all five builder canaries.
Its key is `f672c24b5ff46645`, compiler bundle key `0ce07e5fb4ce1a5d`.
The actual post-build selector announced INTERPRETER with the full-engine
flag, and WebAssembly module introspection confirmed zero imports.

Provider SHA256:
`5871f19b95b2a791dfa738bc3746ab9f936198374a146bf9363e5ea19070d40b`.
Compiler bundle SHA256:
`35f6f894fe9551d33d5b0cf364cf7d350dc7ec1394622e20632b39abcb3a297e`.
Runtime bundle SHA256:
`3aaf2742cdd255fb48f3dbff83ff8abcee5f520b7fceabf0bb6e8f1e314534e6`.
The local harness links point only to the verified pinned corpus
`b363f29d3c43c626dc852744ad64a0b48a003693`; no corpus bytes were changed.

The exact six unchanged anti-rot guard files ran serially with a 3 GiB
Vitest worker, actual INTERPRETER selected in the worker, and full-engine
selection enabled. Session 76699 is terminal exit 1: **60 pass / 7 fail /
67 registered**, six files, zero pending/skipped, 48.70 s. JSON completeness
was independently checked for 67 unique file/name verdicts. There was no
missing runtime bundle, OOM, or REFUSAL scoring. This is executable native
semantic evidence, but emphatically not a green anti-rot result or original
Test262 credit.

All seven failures are in the untouched
`tests/issue-2929-cd-global-materialization.test.ts`: six global declaration/
update/delete controls report `fail: undefined`; a seventh control explicitly
asserts the old limitation that NaN is absent as an own global property, but
the current implementation reports that NaN is now present. Do not infer
that the six share one root cause merely from their undefined error signature.
Do not remove or skip them to claim success. The NaN expectation needs a
separate standards-backed update to assert correct own-property behavior and
descriptors, not preservation of an old implementation gap. Any such change
requires the existing fixture/runtime ownership to be coordinated outside
this infrastructure-only slice. Current issue-5157 eval-spread semantics were
not measured by this six-file run and remain outstanding.

Durable receipts are in `/private/tmp/js2-6810-native-provider.xz1tZR/`:
`provider-build.log` SHA256
`962ece7ec56825737f6c0fc259e8dcb1693988dd7bfd479608bf2f8bd7864f37`,
`guards.json` SHA256
`9554c0a86f8ebb2afb00f54d9082be93a395a1f2c058f83200f64e118d954751`,
and `guards.log` SHA256
`c85a31c1547515f162a18190540f344b6af587378762121e31aa47fc4d584787`.
The heavy lease was returned after terminal results. Normal checkpoint and
publication gates are next; preserve the seven reds and disclose them in any
unfinished draft checkpoint. Separately, current shared quality CI has four
CLAUDE.md path-reference failures outside this slice; a fixing PR exists
(6431) but its queued head contains a corrupted first-line resource marker.
Do not copy or merge that corrupt document or weaken the path checker.

### 2026-10-02 publication and upstream integration handoff

Checkpoint `a5fc13c12464d2416c3fcfbd8212d193fdda27cb` passed normal commit
and push gates and was published as upstream PR
[6435](https://github.com/loopdive/js2/pull/6435). It remains an unfinished
draft because the seven retained native semantic failures above are not fixed.
The PR does not claim a green semantic lane or any original Test262 gain.

At the user's request, verified upstream main
`1255c536b4c275a2dbe4c4605bf5cb5775584efa` was merged locally as
`c466dbd08e05533aa5be7347b1c8b51178b12f40`, without conflicts. The resulting
tree was clean, with zero commits behind that upstream revision and only the
same four owned files in the PR diff. All eight focused CI-contract controls
passed again (terminal session 30113, exit 0, one file, zero skips). This is
structural integration evidence only: the earlier 60/67 semantic receipt
remains attributed to production baseline `1f1b0ad61c`, not this merged source.

Next: publish the integrated checkpoint only after a fresh queue/state check
and normal push gates; keep the draft unfinished. Coordinate a separate
runtime/fixture slice to isolate the six undefined failures and replace the
stale NaN-gap assertion with standards-backed positive descriptor controls.
Do not edit held runtime/IR files, weaken expectations, or count infrastructure
checks toward the frozen 11,778-file goal.
