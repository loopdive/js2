// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) ONE renderer for a thrown Wasm payload, shared by every test262
// execution lane.
//
// Why this file exists
// --------------------
// The local in-process runner (`tests/test262-runner.ts`, used by
// `runTest262File`, the baseline validator and ~40 issue tests) and the
// authoritative CI worker (`scripts/test262-worker.mjs`) each carried their
// OWN copy of this logic, "kept in sync" by a comment. They drifted:
// `originalHarnessThrownText` — the local ORIGINAL-HARNESS path — never called
// `tryNativeExnRender`, so on the standalone lane every `Test262Error` was
// reported locally as
//
//     uncaught Wasm-GC exception (non-stringifiable payload)
//
// while CI reported the real assertion text. Triage done against the local
// runner therefore saw one giant undifferentiated bucket where CI saw distinct
// failures, and standalone runtime-negative tests could not match their
// expected error TYPE locally because the type name was not in the string.
//
// This is the same failure family as a vacuous pass: the machinery lying about
// what happened. Two implementations of one policy is how that lie survives —
// so there is now one implementation and a parity test
// (`tests/issue-3613-render-parity.test.ts`) that pins the two lanes to it.

/**
 * (#2870) Stringify a thrown payload WITHOUT ever letting a host TypeError
 * escape. A `--target standalone` module's thrown value is frequently a
 * Wasm-GC error struct (an `anyref` with no JS-reachable `toString`); calling
 * `String()` on it makes the HOST `ToPrimitive` throw "Cannot convert object
 * to primitive value". Unguarded, that host throw escaped the extractor and
 * was recorded as the test's failure — masking the REAL signature behind a
 * phantom formatter TypeError and collapsing ~2,014 heterogeneous standalone
 * failures onto one string (#2862).
 *
 * @param {unknown} v
 * @returns {string}
 */
export function safeStringifyThrown(v) {
  try {
    return String(v);
  } catch {
    const t = typeof v;
    return t === "object" || t === "function"
      ? "uncaught Wasm-GC exception (non-stringifiable payload)"
      : `uncaught Wasm exception (${t})`;
  }
}

/**
 * (#2962) Render a natively-thrown Wasm-GC payload through the module's own
 * `__exn_render_prepare` / `__exn_render_char` exports (standalone/wasi
 * binaries emit them at finalize). The module runs the payload through the
 * same `__any_to_string` chain its in-module `String(x)` uses — so an
 * `$Error_struct` renders "TypeError: boom" per §20.5.3.4 and a Test262Error
 * yields its real assertion message — then exposes the flat string one code
 * unit at a time (WasmGC arrays are not host-indexable). Returns `null` when
 * the exports are absent (JS-host binaries), the payload renders empty, or
 * anything throws — the caller then falls back to the #2870 opaque label. The
 * 64k cap is defensive (a corrupt length must not build a giant string).
 *
 * @param {any} instance
 * @param {any} payload
 * @returns {string | null}
 */
export function tryNativeExnRender(instance, payload) {
  try {
    const prep = instance?.exports?.__exn_render_prepare;
    const chr = instance?.exports?.__exn_render_char;
    if (typeof prep !== "function" || typeof chr !== "function") return null;
    const len = prep(payload);
    if (typeof len !== "number" || len <= 0 || len > 65536) return null;
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(chr(i));
    return out;
  } catch {
    return null;
  }
}

/**
 * Pull the thrown payload out of a `WebAssembly.Exception` using the module's
 * own exception tag. Returns `undefined` when there is no instance, no tag, or
 * the lookup throws.
 *
 * @param {any} error
 * @param {any} instance
 * @returns {any}
 */
export function exceptionPayload(error, instance) {
  if (typeof WebAssembly === "undefined") return undefined;
  if (!(error instanceof WebAssembly.Exception) || !instance) return undefined;
  try {
    const tag = instance.exports?.__exn_tag ?? instance.exports?.__tag;
    return tag ? error.getArg(tag, 0) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE renderer for an original-harness thrown value. One policy, both lanes:
 *
 *   1. host-readable `.name` on the payload  → `"Name: message"`.
 *      The NAME PREFIX IS LOAD-BEARING: `originalNegativeMatches` decides a
 *      runtime-negative verdict with `detail.includes(meta.negative.type)`, so
 *      dropping the name would silently fail every host-lane runtime negative.
 *   2. host-opaque WasmGC payload → render through the module's own exports.
 *      This is the step the local runner was missing; the rendered text
 *      carries the error name too (`"TypeError: …"` per §20.5.3.4), so the
 *      negative-type match keeps working on the standalone lane as well.
 *   3. anything else → the #2870 guarded fallback.
 *
 * @param {unknown} error
 * @param {any} [instance]
 * @returns {string}
 */
export function renderHarnessThrownText(error, instance) {
  const payload = exceptionPayload(error, instance);
  if (payload !== undefined) {
    if (payload != null && (typeof payload === "object" || typeof payload === "function")) {
      const name = payload.name;
      const message = payload.message;
      if (typeof name === "string") return `${name}${message ? `: ${String(message)}` : ""}`;
      const native = tryNativeExnRender(instance, payload);
      if (native != null) return native;
    }
    if (payload !== null) return safeStringifyThrown(payload);
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return safeStringifyThrown(error);
}
