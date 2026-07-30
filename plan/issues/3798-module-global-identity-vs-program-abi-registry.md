---
id: 3798
title: "Declaration-keyed module globals vs the structural program-ABI registry"
status: ready
created: 2026-07-30
updated: 2026-07-30
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, codegen, program-abi
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
horizon: l
required_by: [1400, 1282, 2693]
es_edition: n/a
related: [1400, 3520, 3521, 3654, 3655, 3672]
---

# #3798 — Declaration-keyed module globals vs the structural program-ABI registry

Two invariants that each hold on their own branch **contradict each other**
once both are in the same tree. The ESLint package graph is the only workload
in the repo large enough to exercise the conflict, which is why neither parent
fails and why fixing it site-by-site keeps finding new sites.

## The conflict

| Side                                                    | Invariant it requires                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1400 / #3672** module-global identity (PR #3687)     | ONE global per **declaration**. A name declared in N files gets N globals; only the first claimant keeps the bare `__mod_<name>` spelling, the rest get `__mod_<name>_<n>`. |
| **#3520 / #3521** structural program-ABI registry (main) | ONE allocator per declaration, named **exactly** `__mod_<displayName>` / `__tdz_<displayName>`, one `displayName` per declaration, TDZ observed only after its value. |

The identity work exists because bare-name keying is precisely the ESLint
defect: `ms/index.js` declares `var s = 1000; var m = s * 60;` while esquery
and minimatch carry lexical helpers named `s`/`m`. Keying module globals by
bare name let one package's numeric win and be loaded into another package's
reference slot (`local.tee[0] expected (ref null N), found global.get of type
f64`). So the registry's bijection cannot simply be imposed on it.

## Measured evidence

**Pre-merge control** — branch head `489f96dd`, `tests/stress/eslint-tier1.test.ts`:

| Stage       | Result                                                    |
| ----------- | --------------------------------------------------------- |
| compile     | **success**, 615.9 s                                      |
| validate    | **true**                                                  |
| instantiate | **true**                                                  |
| `verify()`  | fails — `__extern_method_call: TypeError: deprecate is not a function` (the known #3657 host seam) |

**Post-merge** (that same branch + current `origin/main`): compile **fails**.
Four distinct hard errors surfaced in sequence, each only after the previous
was fixed:

1. `inherited class callable LazyLoadingRuleMap_has has no exact defined
   function for handle 615` — measured `numImportFuncs=650`, so handle 615 is
   a host **import**. `class LazyLoadingRuleMap extends Map` makes the
   inherited-member scan in `class-bodies.ts` yield import handles, which the
   registry rejects. Fixed in PR #3687 (skip the structural observation for
   import handles; keep the funcMap alias).
2. `module declaration KEYS was observed with contradictory tdz global
   allocator objects` — value path recorded the suffixed display name, TDZ
   path the bare one. Fixed.
3. `module TDZ global minimatch was observed before its value global` — a
   declaration that never got a value global (shadowed by a real user
   function) while `ctx.moduleGlobals` still held the name for another file's
   declaration. Fixed.
4. **OPEN — two at once, and in a different subsystem (IR bindings, not global
   registration), which is why the site-by-site approach was abandoned:**
   - `IR path failed for getPlaceholderMatcher: ir/from-ast: concrete return
     needs a dynamic box [IR-FALLBACK]`
   - `ABI drafts ir-binding:v1:callable:ir-source%3Av1%3A…%3Aentry%3Atier1-entry.js:intrinsic-provider:…
     and ir-binding:v1:support:…` (collision)

Fixes 2 and 3 were self-inflicted by the merge port; 1 and 4 are genuine
cross-branch conflicts. The frontier **widened** at step 4 rather than
narrowing, so the remaining count is unknown — every prior estimate would have
said "one more".

## Why CI does not catch this

`tests/stress/eslint-tier1.test.ts` is in **no required check**, verified:

- `equivalence-gate` runs only `tests/equivalence/`.
- `linear-tests` runs `tests/linear-*`, `c-abi`, `simd*`.
- The #3008 "changed root test files must pass" gate is **root-only**
  (`^tests/[^/]+\.test\.ts$`), so a `tests/stress/` path never matches.
- No workflow references `tests/stress` at all.

So PR #3687 can be fully green while the ESLint graph does not compile. That
gap is itself worth closing (see "Follow-up" below).

## The decision this issue exists to make

This is architectural, not a merge-resolution call. Two candidate resolutions:

**A. Teach the registry multi-global-per-name.** `displayName` becomes the
minted spelling (already true for the value path after PR #3687) and the
registry's bijection is stated per-declaration rather than per-name
everywhere, including the IR binding-id derivation that produced the step-4
draft collision. Larger change to #3520/#3521 territory, but it makes the
registry model what the compiler actually emits.

**B. Move the disambiguation below the registry's observation layer.** Keep
one observed allocator per name and give the branch's scope-aware resolution a
representation the sidecar does not enumerate. Smaller blast radius on main's
work, but risks re-introducing the bare-name collision the identity work
exists to prevent — so it needs a positive proof (the `ms` + esquery/minimatch
regression cases in `tests/issue-3672.test.ts`) rather than an argument.

Pick one deliberately, with the owner of #3520/#3521 in the loop.

## Acceptance criteria

1. `tests/stress/eslint-tier1.test.ts` on the merged tree reaches the SAME
   stage the pre-merge control reached: compile success, `validate === true`,
   `instantiate === true`.
2. The remaining failure is the #3657 host seam (`deprecate is not a
   function`) — not a codegen or ABI-invariant error.
3. `tests/issue-3672.test.ts` stays green (the `ms` vs esquery/minimatch
   collision cases must not regress).
4. The chosen resolution is written down here with its rationale.

## Follow-up

`tests/stress/` runs in no required check. Either wire the ESLint Tier 1 proof
into a gate (it is ~10 min, so probably post-merge rather than per-PR), or
record explicitly that it is a manual milestone probe — but do not leave it
looking gated when it is not.
