// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Host-side support for a compiled module that DECLARES its own
 * `function Test262Error` — which the literal upstream harness always does
 * (`sta.js`), i.e. every assembled test262 module.
 *
 * The constructed value has to stay a real host `Error` subclass: the exception
 * bridge, the failure renderer and every `String(err)` / `.stack` path depend
 * on it. But that means its prototype chain can never reach the module's own
 * compiled WasmGC closure, so both identity questions the harness actually asks
 * — `err.constructor === Test262Error` and `err instanceof Test262Error` —
 * answered `false` for an error that plainly is one.
 *
 * Both are closed here by recording the module's carrier, and nothing wider: an
 * unrelated compiled closure is not in the carrier set, and a value that is not
 * a host Test262Error is still decided by the ordinary prototype walk.
 *
 * Lives outside `src/runtime.ts` on purpose — see #4395's host-import migration
 * ratchet, which holds that file and the eight owned adapters at a fixed size.
 * If this module should be counted by that ratchet, add it to `ownedAdapterPaths`
 * in `scripts/check-host-import-policy.ts`.
 */

/**
 * The single host-side `Test262Error` class behind every `new Test262Error(msg)`
 * lowering. It is hoisted to module scope so that the `__new_Test262Error_ctor`
 * builtin and the generic `extern_class` arm mint instances of the SAME class —
 * previously a fresh class was minted per resolver call, so `err.constructor`
 * identity depended on which import a given module happened to bind.
 */
export class HostTest262Error extends Error {
  constructor(msg?: string) {
    super(msg);
    this.name = "Test262Error";
  }
}
