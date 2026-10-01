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

// Errors raised while BUILDING the child module for a dynamic-code string —
// parse, js2wasm compile, Wasm compile, import wiring, instantiation. Tracked
// by identity rather than by class so the error the caller observes keeps its
// own class (`SyntaxError` for a bad source).
const buildFailures = new WeakSet<object>();

/**
 * Mark `error` as a build-stage failure: nothing of the dynamic-code string has
 * run yet, so `hostEval` may hand the string to the host instead. A primitive
 * thrown value is wrapped so it can carry the mark.
 */
export function markDynamicCodeBuildFailure(error: unknown): object {
  const marked = typeof error === "object" && error !== null ? error : new SyntaxError(String(error));
  buildFailures.add(marked);
  return marked;
}

/**
 * True only for a {@link markDynamicCodeBuildFailure} error. Anything else came
 * from RUNNING the string's code, and re-running the string in the host would
 * execute its side effects a second time — so it must propagate unchanged.
 */
export function isDynamicCodeBuildFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && buildFailures.has(error);
}
