---
id: 6779
title: "runtime: default `dynamicCode: \"compat\"` runs program eval strings in the HOST realm on any non-SyntaxError, and re-executes a string whose body threw"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
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
