// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6779) The JS-host runtime's policy for a compiled module's dynamic code —
 * `eval(src)` and `new Function(params, body)` — and the failure-class split
 * the `hostEval` policy depends on.
 *
 * Policies:
 *
 *   - `deny` (default) — fail closed with an `EvalError`. Nothing runs.
 *   - `evaluator` — delegate to the embedder's `dynamicCodeEvaluator` (an
 *     iframe realm or a Node eval Worker, see docs/js-host-eval-isolation.md).
 *   - `hostEval` — compile the string with js2wasm into a child Wasm module
 *     first; if that module cannot be BUILT, run the string with the host
 *     realm's own `eval` / `Function`. This reaches the host's globals
 *     (`process`, `require`, `document`, …), so it is an explicit opt-in.
 *   - `native` — the host realm's `eval` / `Function` directly.
 *   - `compat` — deprecated alias of `hostEval` (the default until #6779);
 *     warns once per `buildImports` call.
 *
 * The default used to be `compat`, which made every embedder's eval reach the
 * host realm unless it opted out. It is now `deny`, the only policy that needs
 * no wiring and keeps dynamic code from reaching the host.
 */

export type DynamicCodePolicy = "deny" | "evaluator" | "hostEval" | "native" | "compat";

/** A policy after the deprecated `compat` alias has been resolved. */
export type ResolvedDynamicCodePolicy = Exclude<DynamicCodePolicy, "compat">;

export const DEFAULT_DYNAMIC_CODE_POLICY: ResolvedDynamicCodePolicy = "deny";

const COMPAT_DEPRECATION =
  'js2wasm: dynamicCode "compat" is deprecated; it now means "hostEval", which runs eval / new Function ' +
  'strings in the host realm. Pass dynamicCode: "hostEval" to keep that, or "deny" / "evaluator" to keep ' +
  "dynamic code out of the host.";

/**
 * Resolve the policy one `buildImports` call uses. Called once per call, so the
 * `compat` deprecation warning is emitted at most once per instance. An unknown
 * value throws rather than silently picking an arm: a misspelt policy must not
 * decide whether code reaches the host realm.
 */
export function resolveDynamicCodePolicy(
  policy: DynamicCodePolicy | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): ResolvedDynamicCodePolicy {
  switch (policy) {
    case undefined:
      return DEFAULT_DYNAMIC_CODE_POLICY;
    case "compat":
      warn(COMPAT_DEPRECATION);
      return "hostEval";
    case "deny":
    case "evaluator":
    case "hostEval":
    case "native":
      return policy;
    default:
      throw new TypeError(`unknown dynamicCode policy: ${String(policy)}`);
  }
}

/**
 * Normalize an error raised while BUILDING the child module for a dynamic-code
 * string (parse, js2wasm compile, Wasm compile, import wiring, instantiation):
 * a primitive thrown value is wrapped in a `SyntaxError`; an object keeps its
 * own identity and class. (#6979 S7-d) The build/run split this used to record
 * served only the host `__extern_eval` provider, which no WasmGC profile emits.
 */
export function markDynamicCodeBuildFailure(error: unknown): object {
  return typeof error === "object" && error !== null ? error : new SyntaxError(String(error));
}
