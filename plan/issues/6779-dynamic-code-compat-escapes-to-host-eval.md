---
id: 6779
title: "runtime: default `dynamicCode: \"compat\"` runs program eval strings in the HOST realm on any non-SyntaxError, and re-executes a string whose body threw"
status: done
assignee: "ttraenkler/claude-dev-6779"
branch: "claude/issue-6779-eval-compat-policy"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: eval
goal: runtime-eval
related: [1006, 1164, 2960, 1066, 1584]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C3"
---

# #6779 — the `compat` eval policy is a host-realm escape, and it is the default

## Problem

With default options (`compileAndInstantiate`, no `dynamicCode` given), a
compiled program's `eval` reaches the host's global scope:

```ts
eval("globalThis.process.pid")          // → the real host pid
eval("process.binding ? 'hasBinding' : 'no'")  // → "hasBinding"
```

(runtime-built strings, so compile-time eval folding does not apply.)

README.md line 42 presents Wasm compilation as "an isolation boundary" for
third-party and multi-tenant code; `checkPolicy` (`src/runtime.ts:19392`)
only inspects `extern_class` / `declared_global` manifests, so a host that
blocklists `process` still has it reachable through `eval`.
`src/runtime-eval.ts:11-20` names this exact leak as the reason `(0, eval)`
was removed — the compat fallback re-introduces it.

## Evidence

`src/runtime.ts:12725-12740`:

```ts
try {
  return wasmEvalShim(src, _isDirect);
} catch (e: any) {
  const isSyntaxError = e instanceof SyntaxError;
  if (isSyntaxError) {
    return _legacyHostEval(src);   // ← identical to the else branch
  }
  return _legacyHostEval(src);     // → (0, eval)(src) in the host
}
```

The `if` branch and the fall-through are the same call, so **every** failure
of the Wasm path, including a `TypeError` thrown by the eval'd code's own
execution, routes to host eval. Default policy: `src/runtime.ts:11490`
`dynamicCode: DynamicCodePolicy = "compat"`. `new Function` has the same arm:
`src/runtime/dynamic-function-import.ts:70-77` falls to host `new Function`.

Second consequence — **double execution**. `src/runtime-eval.ts:544` runs
`entry()` inside the try, so a runtime throw from the eval'd body re-runs the
whole string in the host:

```ts
eval("globalThis.__probe = (__probe|0)+1; null.x")   // host __probe === 2 after ONE call
```

Side effects double and the error class changes (a module-local reference
becomes a host `ReferenceError` instead of the original `TypeError`).

## Correction

1. Default `dynamicCode` to `"deny"` (or `"evaluator"` where the isolated
   evaluator is wired). `deny` already fails closed for `__extern_eval`,
   `__extern_direct_eval`, `__extern_new_function` (verified).
2. Rename the host fallback so it is unmistakable: `dynamicCode: "hostEval"`
   (keep `"compat"` as a deprecated alias for one release with a one-time
   warning).
3. Split the failure classes: only compile/instantiate failures of the Wasm
   eval module may fall back; move `entry()` out of the try (or tag compile
   errors with a distinct class) so a throw from the evaluated body propagates
   once, unchanged.
4. README: replace the isolation-boundary paragraph with the truthful
   statement from `docs/js-host-eval-isolation.md:120-123` (realm/Worker are
   not security boundaries) and say which policies keep code inside the
   module.
5. test262 runs that rely on host-eval semantics set the policy explicitly in
   `scripts/test262-import-object.mjs`.

## Acceptance

- Default instantiate: `eval("globalThis.process")` throws the same error the
  `deny` policy throws today; the probe cannot observe `process`.
- `eval("globalThis.__probe = (__probe|0)+1; null.x")` increments once and
  throws `TypeError` under every policy that runs it.
- host test262 conformance unchanged when the runner passes the explicit
  policy; a diff of the two lanes is attached to the PR.
- `docs/js-host-eval-isolation.md` and README agree.

## Implementation Plan

What was done (2026-10-01, branch `claude/issue-6779-eval-compat-policy`):

1. **Policy module** — new `src/runtime/dynamic-code-policy.ts`:
   `DynamicCodePolicy = "deny" | "evaluator" | "hostEval" | "native" | "compat"`,
   `DEFAULT_DYNAMIC_CODE_POLICY = "deny"`, and `resolveDynamicCodePolicy()`,
   which `buildImports` calls once per instance: `undefined` → `deny`,
   `compat` → `hostEval` plus one `console.warn` deprecation per
   `buildImports` call, an unknown string → `TypeError` (a misspelt policy must
   not silently pick an arm). `src/runtime.ts` re-exports the type under the
   same public name and passes the resolved policy to `resolveImport`.
   - **Why `deny`, not `evaluator`:** `evaluator` needs an embedder-supplied
     `dynamicCodeEvaluator` (an iframe realm or a Node eval Worker,
     `src/runtime-isolated-evaluator.ts` / `src/runtime-node-eval-worker.ts`);
     without one every eval throws anyway. `deny` is the only policy that
     needs no wiring and keeps strings out of the host.
2. **Failure-class split** — the same module tracks *build* failures by
   identity (`markDynamicCodeBuildFailure` / `isDynamicCodeBuildFailure`, a
   WeakSet, so a `SyntaxError` stays a `SyntaxError`).
   - `src/runtime-eval.ts` `createEvalShim`: compile + instantiate moved into
     `buildEvalModule()`; the public `__extern_eval` marks anything thrown
     before the child's entry call and calls the entry outside that try, via
     `callChildExport()`, which re-exposes the child's exception payload (a
     `TypeError` stays a `TypeError`, not a `WebAssembly.Exception`).
   - `createNewFunctionShim`: same shape (`buildNewFunction()` + marking
     wrapper); constructing never runs the body, so every failure there is a
     build failure. The callable shares `callChildExport()`.
   - `src/runtime.ts` `__extern_eval` hostEval arm: the identical `if`/`else`
     is gone; only `isDynamicCodeBuildFailure(e)` falls back to
     `_legacyHostEval`, anything else rethrows once.
   - `src/runtime/dynamic-function-import.ts`: the `hostEval` arm rethrows
     anything that is not a build failure; unknown policies fail closed.
3. **Unbound-name refusal (hostEval only)** — measured, not planned: the split
   alone turned 25 of the first 484 slice rows from pass to fail. The child
   module cannot see the caller's global environment, so the compiler lowers a
   free identifier such as test262's `assert` to a static
   `"<name> is not defined"` throw; the old code ran the child up to that
   throw and then re-ran the whole string in the host. `unboundNamesError()`
   (`src/runtime-eval.ts`) reads those messages from the child's string pool,
   drops names the source itself declares (TDZ checks), and refuses the
   string as a BUILD failure before anything runs. Enabled by
   `createEvalShim({ hostFallback: true })`, which only the runtime's
   `hostEval` arm passes. Refusals are negative-cached. All 25 rows pass again.
4. **Nested dynamic code** — `EvalShimOptions.dynamicCode` threads the
   parent's policy into the child module's `buildImports`, so a nested eval
   under `hostEval` is not silently denied by the new default.
5. **Harness pins** (only the library default changes): `TEST262_DYNAMIC_CODE_POLICY = "hostEval"`
   in `scripts/test262-import-object.mjs`, used by every test262 lane and
   applied to linked providers inside `instantiateTest262Module`; npm-compat /
   dogfood lanes and the tests that exercise the old default pass
   `dynamicCode: "hostEval"` explicitly (full list in the PR).
6. **Docs** — README "security boundaries" paragraph rewritten (the boundary is
   the import object; only `deny` keeps strings inside the module; realms /
   Workers are not security boundaries); README host-mode note;
   `docs/js-host-eval-isolation.md` gains a policy table and a boundary note.
7. `scripts/compiler-boundaries.json` classifies the new module
   (`legacy-host`, `unmigrated`, like `dynamic-function-import.ts`).

## Resolution

Probe (`ev(src) { return eval(src) }`, `nf(body) { return new Function(body)() }`,
strings passed in from JS):

| Probe | before, default (`compat`) | after, default (`deny`) | after, `hostEval` |
| --- | --- | --- | --- |
| `eval("globalThis.process.pid")` | host pid | `EvalError` | host pid |
| `eval("globalThis.__p=(…)+1; null.x")` | `TypeError`, `__p === 2` | `EvalError`, `__p` unset | `TypeError`, `__p === 1` |
| `new Function("globalThis.__q=…; return null.x")()` | `TypeError`, `__q === 1` | `EvalError` | `TypeError`, `__q === 1` |
| `eval("1+2")` | `3` | `EvalError` | `3` |
| `compat` | — | — | same as `hostEval`, one warning |

test262 host lane, before/after on the slice that can reach runtime
eval / `new Function` (2,891 rows: every test whose source mentions `eval`,
`Function(` or `evalScript`, or includes `fnGlobalObject.js`,
`wellKnownIntrinsicObjects.js` or `resizableArrayBufferUtils.js`), run through
`runTest262File` (honest lane) at HEAD and at this branch with the pinned
policy: **pass 1617 / fail 985 / skip 283 / compile_error 6 on both, 0 rows
changed status.** The lanes in CI run the linked oracle; that lane was not run
locally.

Tests: `tests/issue-6779-eval-policy.test.ts` (11 cases; 7 fail against the
pre-change runtime). Eval-adjacent suites re-run per file; every remaining
failure also fails at HEAD (`issue-1006` 1, `issue-2973` 1, `issue-3521` 3,
`issue-3058-dyn-view` 1, `issue-4484` 3, `issue-3685` 1, `lodash-compile` 38)
or needs inputs this checkout lacks (test262 submodule, QuickJS artifact:
`issue-3418`, `issue-3451`, `issue-4162`, `issue-4464`). The six changed root
test files pass under CI's `test:changed-root` with
`JS2WASM_EVAL_ENGINE=interpreter`.

- `tests/issue-1006.test.ts` is left unchanged: its six eval cases are folded
  at compile time and pass under `deny`. Its seventh case
  (`(eval as any)()` → `undefined`) fails identically on `origin/main` under
  the same env (file-copy A/B of `src/runtime.ts`, `src/runtime-eval.ts`,
  `src/runtime/dynamic-function-import.ts` and the test): the compiler lowers
  a no-argument `eval()` to `ref.null extern` (JS `null`) with no runtime
  import at all — a codegen bug independent of this policy (follow-up).
- `tests/issue-1073.test.ts` "eval'd assert_sameValue failure throws to outer
  scope" failed on `origin/main` too: its literal `eval('assert_sameValue(1,
  2);')` has been inlined at compile time since #1163, so it called the
  module's own non-throwing `assert_sameValue` and never reached the harness
  shim the case covers. The string is now built at runtime; the assertion is
  unchanged and passes under `hostEval` (the unbound-name refusal sends it to
  the host shim, which throws).

Gates (after merging `origin/main` 3d3dfda3), all exit 0: `typecheck`,
`lint`, `format:check`, `test:guard` (20 files / 255 tests), LOC / function /
coercion budgets (merge-base and `LOC_GATE_BASE=origin/main`),
`check:oracle-ratchet`, `check:dead-exports`, `check:ir-fallbacks`,
`check-compiler-boundaries --mode inventory --base origin/main`,
`check:ir-dialect`, `check:ir-kind-neutrality`, `check:jstag-seam`,
`check:ir-layering`, `check:codegen-fallbacks`, `check:any-box-sites`,
`check:speculative-rollback`, `check:stack-balance`, `check:pushraw`,
`check:host-import-policy`, `check:ir-only`, `check:ir-adoption`,
`check:issues`, `check:done-status-integrity`, `check:issue-spec-coverage`,
`check:harness-compile-budget`, `check:verdict-oracle`. No budget allowances
were needed: after #6776 added six lines to `createEvalShim` on main, the
stage-boundary wrapper and the unbound-name pre-check moved into top-level
helpers (`runEvalModule`, `refuseUnboundNames`), leaving `createEvalShim` at
290 lines against main b4ac0b7a.

Left out, deliberately:

- **Default `deny` breaks lodash's module init.** lodash's root detection
  (`freeGlobal || freeSelf || Function('return this')()`) reaches the
  `Function` fallback in a js2wasm module (its `global.Object === Object`
  check fails), so a default-instantiated lodash / lodash-es throws
  `EvalError`. Harnesses are pinned; library users need `hostEval` or a
  compile-time fold of the `Function("return this")` idiom (follow-up).
- **Not governed by `dynamicCode`:** the default import object's
  `globalThis` is the host global, so a module reads `globalThis.process`
  without eval, and `globalThis["ev" + "al"](…)` calls the host's own eval
  (verified). Documented in `docs/js-host-eval-isolation.md`; containment is an
  import-object question (follow-up).
- `instantiateLinkedProject` builds linked providers with the library default;
  it has no options parameter, so the dogfood upstream-suite worker's linked
  path gives providers `deny`.
