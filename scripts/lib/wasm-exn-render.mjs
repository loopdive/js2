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
  if (!(error instanceof WebAssembly.Exception) || !instance) return undefined;
  try {
    const tag = instance.exports?.__exn_tag ?? instance.exports?.__tag;
    return tag ? error.getArg(tag, 0) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `Name: message` text for a thrown value, used by the npm-compat report, the dogfood lanes and the local
 * runner's compile-crash detail. No runtime-negative verdict reads it: those read `readThrownValue`'s kinds.
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

/**
 * A trap (`unreachable`, out of bounds, illegal cast, null dereference). A
 * JavaScript throw leaves Wasm as a `WebAssembly.Exception` carried by the
 * exception tag, or as the host's own error object, never as this class.
 *
 * @param {unknown} err
 */
export function isWasmTrap(err) {
  return err instanceof WebAssembly.RuntimeError;
}

/**
 * (#7486) The run-time abort site a trap fired at: the id the site-naming abort left in the module's exported global
 * `__js_value_unsupported_site` (-1 until one fires), as its row of the Prepared site table.
 *
 * @template Row
 * @param {any} instance
 * @param {readonly Row[]} [abortSites]
 * @returns {Row | undefined}
 */
export function abortSiteOf(instance, abortSites = []) {
  const site = instance?.exports.__js_value_unsupported_site?.value;
  return site >= 0 ? abortSites[site] : undefined;
}

/**
 * The Wasm frames of `err`'s stack, innermost first, and, for a trap, the abort it was: (#7486) the run-time abort
 * site it fired at (`abortSiteOf`), or else, where its innermost frame is a Prepared function with an abort body
 * (#7354 U: its body could not be lowered, so the abort is its whole body), that function's row.
 *
 * @param {any} err
 * @param {readonly { name: string }[]} [abortBodies]
 * @param {{ name: string }} [abortSite]
 */
export function wasmErrorSite(err, abortBodies = [], abortSite) {
  const frames = [...String(err?.stack ?? "").matchAll(/at\s+(\S+)\s+\(wasm:\/\//g)].map((m) => m[1]);
  const aborted =
    isWasmTrap(err) && frames.length > 0 ? (abortSite ?? abortBodies.find((row) => row.name === frames[0])) : undefined;
  return { frames, aborted };
}

/**
 * A host error's message, followed for a trap by its Wasm frames in
 * trap-first order (#1316/#1317: the leaf is often a tiny lifted helper whose
 * name alone says nothing without its callers).
 *
 * @param {any} err
 * @param {readonly { name: string, detail: string }[]} [abortBodies]
 * @returns {string}
 */
export function renderHostError(err, abortBodies = []) {
  let info = err.message ?? String(err);
  if (!/illegal cast|null|unreachable|out of bounds/.test(info)) return info;
  const { frames, aborted } = wasmErrorSite(err, abortBodies);
  if (frames.length === 0) return info;
  if (aborted) info = `aborted in unlowerable unit ${aborted.name}: ${aborted.detail}`;
  info = `${info} [in ${frames[0]}()`;
  // Cap at 3 caller frames so the line stays readable inside the 300-char
  // `error.substring(0, 300)` truncation downstream.
  if (frames.length > 1) info += ` ← ${frames.slice(1, 4).join(" ← ")}`;
  return `${info}]`;
}

/**
 * (#7354 X) The error kinds of a thrown value that was READ: its `name` and its constructor's name (a
 * `class Test262Error extends Error` instance is named "Error"); none for a primitive or a function (a thrown
 * constructor is not an instance of it). A runtime-negative verdict compares these and never the message, so
 * `new Error("expected a TypeError")` is an `Error`.
 *
 * A host-opaque WasmGC payload has neither; `rendered` is then the module's own `String(payload)`
 * (`__exn_render_*`, standalone/wasi), whose §20.5.3.4 form is `name: message`, or the bare name for an empty
 * message, so the kind is the text before the first `": "`. That split is a stopgap: on the ordinary lanes the
 * rendered text of an opaque payload still counts (a thrown string or a `toString` rendering "TypeError: x" reads
 * as a TypeError) until a kind export replaces it (#7453).
 *
 * @param {unknown} value
 * @param {string} [rendered]
 * @returns {string[]}
 */
function thrownErrorKinds(value, rendered) {
  if (value === null || typeof value !== "object") return [];
  let kinds;
  try {
    kinds = [value.name, value.constructor?.name].filter((kind) => typeof kind === "string");
  } catch {
    // A throwing `name`/`constructor` getter: the kind was not read.
    return [];
  }
  if (kinds.length > 0 || rendered === undefined) return kinds;
  const colon = rendered.indexOf(": ");
  return [colon < 0 ? rendered : rendered.slice(0, colon)];
}

/** A value the reader could not read: no kind, and a text that says what was not read. */
function unread(text, observation) {
  observation?.("text-route", "wasm-nullish-label");
  observation?.("reader-text", text);
  return { kinds: [], text };
}

/** The reading of a payload whose text is known. */
function payloadReading(payload, text, route, observation, rendered) {
  observation?.("text-route", route);
  observation?.("reader-text", text);
  return { kinds: thrownErrorKinds(payload, rendered), text };
}

/**
 * Read a `WebAssembly.Exception`'s payload through the instance's own tag: `{ payload }`, or `{ missing }` naming
 * what could not be read.
 */
function tagPayload(error, instance, observation) {
  if (!instance) {
    observation?.("consumer-tag", "no-instance");
    return { missing: "wasm exception during module init" };
  }
  const noTag = { missing: "unknown thrown value: the module exports no exception tag" };
  let stage = "tag-read";
  try {
    const exnTag = instance.exports.__exn_tag;
    const tag = exnTag ?? instance.exports.__tag;
    observation?.("consumer-tag", tag ? (exnTag != null ? "__exn_tag" : "__tag") : "no-tag");
    if (!tag) return noTag;
    stage = "getArg";
    const payload = error.getArg(tag, 0);
    observation?.("extraction", "success");
    observation?.("payload-category", payload === null ? "null" : typeof payload);
    return { payload };
  } catch {
    observation?.("extraction", stage === "getArg" ? "failed" : "tag-read-failed");
    return stage === "getArg"
      ? { missing: "unknown thrown value: the module's exception tag does not carry it" }
      : noTag;
  }
}

/**
 * (#7354 X) THE reader of a thrown value, for every test262 lane: its error kinds (`thrownErrorKinds`; none when it
 * could not be read) and its text. A runtime-negative verdict reads only the kinds, so a label written for a value
 * that could not be read can never match an expected type.
 *
 * `peers` are the linked harness providers' exports (#6723), `abortBodies` the Prepared abort table (#7354 U),
 * `observation` the native-eval boundary recorder.
 *
 * @param {unknown} error
 * @param {{ instance?: any, peers?: readonly any[], abortBodies?: readonly any[], observation?: Function }} [context]
 * @returns {{ kinds: string[], text: string }}
 */
export function readThrownValue(error, { instance, peers = [], abortBodies = [], observation } = {}) {
  observation?.("consumer-instance", Boolean(instance));
  if (error instanceof WebAssembly.Exception) {
    observation?.("exception-kind", "wasm");
    const read = tagPayload(error, instance, observation);
    if (read.missing !== undefined) return unread(read.missing, observation);
    const { payload } = read;
    // A null payload is the ordinary codegen's null guard or TDZ throw, or a user `throw null`, so its kind is not
    // known. Its text stays the label that failing positive rows are bucketed by.
    if (payload == null) return unread("TypeError (null/undefined access)", observation);
    if (payload instanceof Error)
      return payloadReading(payload, payload.message ?? safeStringifyThrown(payload), "payload-Error", observation);
    // (#2962) A host-opaque GC payload renders through the module's own
    // exports before falling back to the #2870 label; host-readable
    // primitives keep the direct String() path.
    if (typeof payload === "object" || typeof payload === "function") {
      const native = tryNativeExnRender(instance, payload);
      observation?.("consumer-native", native);
      // (#6723 D4) The consumer renders a PROVIDER-minted `Test262Error`
      // (a provider fnctor instance) as the generic "[object Object]": its
      // `toString` lives on the provider's prototype. Treat that answer as
      // "not mine" when a linked peer can do better.
      if (native != null && (native !== "[object Object]" || peers.length === 0))
        return payloadReading(payload, native, "consumer-native", observation, native);
      // (#6723) A STANDALONE linked row: the payload may be minted by the
      // harness provider (a `Test262Error` thrown by `assert.*`), whose GC
      // layout only the provider's own `__exn_render_*` exports can read.
      let generic = native;
      let peerOrdinal = 0;
      for (const peer of peers) {
        const viaPeer = tryNativeExnRender({ exports: peer }, payload);
        observation?.("linked-peer-ordinal", ++peerOrdinal);
        observation?.("linked-peer-native", viaPeer);
        if (viaPeer != null && viaPeer !== "[object Object]")
          return payloadReading(payload, viaPeer, "linked-peer-native", observation, viaPeer);
        generic ??= viaPeer;
      }
      if (generic != null) return payloadReading(payload, generic, "generic-native", observation, generic);
    }
    return payloadReading(payload, safeStringifyThrown(payload), "payload-safe-stringification", observation);
  }
  if (error instanceof Error) {
    observation?.("exception-kind", "host-Error");
    return payloadReading(error, renderHostError(error, abortBodies), "host-Error", observation);
  }
  observation?.("exception-kind", "non-wasm");
  return payloadReading(error, safeStringifyThrown(error), "non-wasm-fallback", observation);
}
