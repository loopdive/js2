// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { _installIteratorHelperPolyfills } from "./iterator-polyfills.js";
import { _installLegacyRegExpAccessors, type LegacyRegExpState } from "./legacy-regexp.js";
import { _installPromiseKeyedCombinators, type ThenableMirror } from "./promise-keyed-combinators.js";

export interface AmbientCompatibilityOptions {
  enabled: boolean;
  deps?: Record<string, any>;
  legacyRegExpState: LegacyRegExpState;
  /**
   * (#6492 r17) The embedder's realm object, when there is one — the test262
   * runner's per-test `globalSandbox`. Compiled code reads `Promise` THROUGH
   * this object, so it is the realm whose `Promise` a polyfilled static has to
   * live on. See {@link resolvePromiseCompatibilityTarget}.
   */
  globalSandbox?: Record<string, any>;
  /**
   * (#6492 r20) Mirror for a COMPILED thenable, supplied by `src/runtime.ts`
   * (the only place that can resolve the owning module's exports). The keyed
   * combinators must `Invoke(nextPromise, "then", …)` on whatever the user's
   * `resolve` returned, and that is a WasmGC struct for seven rows of the
   * family. Omitted ⇒ identity, which is correct for a pure-host embedder.
   */
  mirrorThenable?: ThenableMirror;
}

/**
 * Which `Promise` object the keyed combinators are installed on.
 *
 * ## Why this is not simply the host intrinsic (#6492 r17)
 *
 * `allKeyed` reads its `resolve` off the RECEIVER (`C = this`, §7.3.x
 * GetPromiseResolve) — which is correct, and was never the bug. The bug was
 * that the receiver could not be the object the test had written to, because
 * the method only existed on ANOTHER realm's `Promise`.
 *
 * Measured in the real runner on
 * `built-ins/Promise/allKeyed/invoke-resolve-get-once.js`, linked lane, with
 * the two sites instrumented:
 *
 * ```
 * [DBG dpa] prop=resolve  isNativePromise=false name=Promise   ← the test's defineProperty target
 * [DBG gpr] typeofC=function isNativePromise=true  resolveIsNative=true   ← C inside the combinator
 * ```
 *
 * Two different host `Promise` objects. The compiled
 * `Object.defineProperty(Promise, "resolve", …)` lands on the SANDBOX's
 * `Promise` (correct — that is the realm compiled code reads `Promise` from);
 * the combinator was reached through the worker's intrinsic and saw a pristine
 * native `resolve`. Every `invoke-resolve-*` / `resolve-*` / `invoke-then-*`
 * row in the family depends on exactly that write being visible.
 *
 * So: prefer an explicitly injected `deps.Promise`, then the sandbox's, and
 * only fall back to the ambient intrinsic when there is no sandbox at all —
 * which is the ordinary product embedding. As a side effect the host intrinsic
 * stops being mutated per instantiate in the runner lane, which is the drift
 * the #6492-r5 canary prime in `scripts/test262-worker.mjs` works around; that
 * prime is kept deliberately, because a no-sandbox embedding still reaches the
 * intrinsic and the prime is what keeps its one-time install inside the
 * baseline snapshot.
 */
export function resolvePromiseCompatibilityTarget(options: AmbientCompatibilityOptions): any {
  return resolvePromiseRealm(options.globalSandbox, options.deps?.Promise);
}

/**
 * The `%Promise%` intrinsic for the realm compiled code is running against.
 *
 * ## Why this is Promise-SCOPED and not a blanket realm switch (#6492 r18)
 *
 * The same question was answered "host realm, on purpose" in #2623 P-7b
 * (2026-07-12), and the comment on `_resolveCtor` still says so. That decision
 * rested on one premise, stated in its own design note:
 *
 * > The CI sharded worker calls `buildImports(...)` with NO `globalSandbox` —
 * > the CI lane is single-realm by construction.
 *
 * **That premise is no longer true.** CI's host shards run
 * `TEST262_ORACLE_MODE=linked` (#3451 slice 6), and the worker hands BOTH the
 * consumer and the linked provider a per-test `globalSandbox` (#6475/#6476).
 * The authoritative lane is now the sandboxed one, so "single realm by
 * construction" has become "two realms, silently" — which is exactly the shape
 * of the bug: the test's `Promise.resolve = fn` lands on the sandbox's
 * `Promise` while `Get(C,"resolve")` reads the worker's.
 *
 * What is NOT revived from that round is the part that actually regressed: the
 * prototype it rejected made `__get_builtin` sandbox-first for ALL builtins and
 * unified the Promise-minting shims, which mixed realms cross-builtin
 * (`Promise.*` sandbox vs `Object`/`Boolean` host) and broke
 * `Promise/prototype/proto.js` and
 * `prototype/catch/this-value-obj-coercible.js`. This helper is the narrow
 * version that round's own pre-landing note recommended instead: Promise only,
 * at the two sites that decide the capability `C`.
 *
 * Resolution order — injected dependency, then the sandbox, then the ambient
 * intrinsic (the ordinary product embedding, byte-identical to before).
 */
export function resolvePromiseRealm(globalSandbox?: Record<string, any>, injected?: unknown): any {
  if (typeof injected === "function") return injected;
  const sandboxPromise = globalSandbox?.Promise;
  if (typeof sandboxPromise === "function") return sandboxPromise;
  return typeof Promise !== "undefined" ? Promise : undefined;
}

/**
 * Install the historical ambient compatibility surface. Native-first adapter
 * plans never call this path; compatibility profiles opt in explicitly.
 */
export function installAmbientCompatibility(options: AmbientCompatibilityOptions): void {
  if (!options.enabled) return;
  _installIteratorHelperPolyfills();
  // (#6492 round 5) await-dictionary: no engine ships these, so js2 owns them.
  // (#6492 r17) …on the REALM the compiled code reads `Promise` from.
  const PromiseConstructor = resolvePromiseCompatibilityTarget(options);
  if (PromiseConstructor) _installPromiseKeyedCombinators(PromiseConstructor, options.mirrorThenable);
  const RegExpConstructor = options.deps?.RegExp ?? (typeof RegExp !== "undefined" ? RegExp : undefined);
  if (RegExpConstructor) _installLegacyRegExpAccessors(RegExpConstructor, options.legacyRegExpState);
}
