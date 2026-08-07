---
id: 4198
title: "standalone: `this` inside a function DECLARATION used as a descriptor getter/setter does not bind the receiver (function EXPRESSION getters do) — both consumer and non-consumer mode"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone, property-descriptors
language_feature: property-descriptors, functions, this-binding
goal: runtime-eval
related: [4197, 1888, 1636]
origin: "W16, split out of #4197 — found as a control while fixing the consumer-mode carrier dispatch, 2026-08-07"
---

# #4198 — `this` in a declaration getter does not see the receiver

## Summary (measured on origin/main @ `fb4a76d83b`, `--target standalone`)

```ts
function getOwn(this: any): any { return this.raw; }

export function test(): number {
  var o: any = { raw: 5 };
  Object.defineProperty(o, "p", { get: getOwn, configurable: true });
  return o.p === 5 ? 1 : 30;   // → 30
}
```

The getter **is invoked** (a declaration getter returning a constant reads back
correctly), but `this` is not the receiver, so `this.raw` is not `5`.

## Why this is NOT #4197

Measured with the same probe in four combinations
(`.tmp/w16-this.mts` in worktree `agent-ac439b35311a3b782`):

| getter form              | non-consumer | consumer |
| ------------------------ | ------------ | -------- |
| function **declaration** | **30 (fail)**| **30 (fail)** |
| function **expression**  | 1 (pass)     | 1 (pass) |

#4197 was a consumer-mode-only defect (the `$RuntimeEvalAotCallable` carrier had
no arm in `__call_fn_method_<arity>`). This one reproduces in **non-consumer
mode too**, so it is a separate, older gap and #4197's carrier front-guard
neither causes nor fixes it. It was found precisely because #4197's fix made the
declaration getter *reachable*, which exposed the next layer.

## Where to look

`__call_accessor_get` / `__call_accessor_set` (`src/codegen/accessor-driver.ts`)
forward `recv` as the leading `thisVal` of `__call_fn_method_0` / `_1`, and that
dispatcher installs it into the `__current_this` module global (#1636-S1). So
the receiver reaches the dispatcher. The divergence is therefore in how a
`this` READ inside a **function declaration** body resolves — a declaration
body is compiled as an ordinary top-level function, and its `this` most likely
does not route through `__current_this` the way a closure/method body's does.
Confirm that first; do not assume the accessor driver is at fault (the
expression-getter control proves the driver threads the receiver correctly).

## Acceptance criteria

- The probe above returns `1` on array, plain-object and function receivers.
- Two distinct receivers each see their own `this` (`{raw:5}` → 5, `{raw:7}` → 7).
- The function-EXPRESSION getter control still passes (it does today).
- Setter lane: `this` inside a declaration setter sees the receiver.
- Non-consumer and consumer modules both fixed — this is not a consumer-mode
  issue, so a carrier-gated fix would be the wrong shape.

## Instrument warning

Any standalone A/B over this area must follow
`.claude/memory/reference_standalone_eval_instrument_reports_unmeasured_failures.md`,
plus the two corrections W16 confirmed on 2026-08-07:

1. The runtime-eval provider cache key is **`no-bundle`-static** — it does NOT
   change when you edit `src/`. `build-runtime-eval-provider.mjs` reports
   `cache HIT` and no-ops while you are silently measuring the OLD compiler.
   Delete `.test262-cache/runtime-eval-*.wasm` and verify the emitted byte count
   moved (W16 saw 3,970,952 → 3,971,726).
2. `tests/test262-runner.ts` still omits the `js2wasm:runtime-eval` namespace
   (#4163 unlanded as of this writing), so an unshimmed in-process run reports a
   link error in place of every real per-file signature.
