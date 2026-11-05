---
id: 7238
title: "Two same-named classes in one file still share one legacy shape (wrong value or trap); #4646 does not cover it"
status: ready
sprint: Backlog
created: 2026-11-05
updated: 2026-11-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [4646, 7234, 7227]
---

# #7238: same-named classes in one file collide in legacy codegen

Found during the review of PR #7065 (#7234). Every row below reproduces on
main, with the IR path on or off (`experimentalIR: false`), on gc,
`--target standalone` and `--target wasi`. #4646 (struct-map keying by class
name) is `done`, but the cases below still fail.

| Probe | node | main |
|---|---|---|
| two sibling `function f(){ class C … }` / `function g(){ class C … }`, each reading its own static | 12 | **11** (silently wrong) |
| top-level `class C { static #m(){return 1} … }` + `function f(){ const C = class { static #m(){return 12} … }; return C.a(); }` | 12 | null-pointer **trap** |
| same as above, but with a static private field instead of a method | 12 | **2** (silently wrong) |

The full probes are in the #7234 review artifacts (`rv7234/` probes a03, a14, a24).

**Cause:** legacy class codegen still keys some class artefacts by the class
**name**: static-field globals (`__static_C_*`), shapes, the implicit
constructor `C_new`, and the method function names `C_m`. A second class with
the same name in another scope reuses or overwrites the first one.

**Fix direction:** key class artefacts by declaration identity, using a
per-file unique suffix for the second and later same-named declaration. Do it
in one place, the class-name → emitted-name allocator, rather than at each use.
- Typed-corpus bytes must stay identical, because no typed-corpus file has two
  same-named classes. Verify this.
- After the fix, #7234's `classNameIsAmbiguous` refusal can be revisited.

**Test:** `tests/equivalence/issue-7238-*.test.ts` with the three probes on 3
lanes, asserting node's value.
