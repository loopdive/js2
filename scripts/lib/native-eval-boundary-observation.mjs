import { createHash } from "node:crypto";

// #2929 N1: diagnostic-only, frozen N0 assembled sources. No raw exception,
// payload, tag, instance, export or callable is stored in this accumulator.
export const NATIVE_EVAL_OBSERVATION_ENV = "JS2WASM_NATIVE_EVAL_BOUNDARY_OBSERVATION";
export const NATIVE_EVAL_OBSERVATION_FIELD = "nativeEvalBoundaryObservation";
export const NATIVE_EVAL_OBSERVATION_SOURCES = Object.freeze({
  "55ed60f0a66f8ba87d04e8ceda31a2bad5b89a919f87a69002526245bbdb184d": "cd/direct-var-new",
  ad30b9880a624beb3a04b821127e22c789a13a66600965de5c32e352b2ad5953: "cd/direct-func-new",
  "8cd9203238b82e76bc78cb2fdf05e03f6bffd384e8e5175585454268da1b0368": "cd/indirect-var-new",
  "4558424a46ed2d7627dba34a36d202ffeaa9628d8268b7948b6609197b9ab84f": "cd/existing",
  b344488fc6e29d060c9664ed3817d391f21eb4f90098fec7ae1e709b34d65e73: "cd/annexb-existing-primitive-call",
  "593679293b451f1011e6fcad996a02d934c92a4a821f5ce4bcf2b4bdb643351b": "cd/delete-severs",
  "5113f696fbe3e4d4de80f1a7ea43bb7df250f6130929c7835daabbe48fe80e9a": "cd/assign-only",
  "11e3530f96962ba2dde522459f044e62ebb9b5efcc4be5cb8813319677495104": "d/direct-var",
  "1829780fe2bd6d186c69f68b22c7f89d640a5d523ece8192cea37ee94aafbdc9": "d/indirect-var",
  cce4566a4f39850ea101a5bd3a75692b72096f50be27b4019140d2b145a2e1b1: "d/indirect-func",
  e305b5a302d9a8d43db4c0f58f9e94d6f203ce41fba9ebf0b2e3755b4084e8b2: "gap/nan-not-own",
});

const MAX_EVENTS = 128;
const MAX_STRING = 1024;
const hashSource = (source) => createHash("sha256").update(source).digest("hex");
const hasOwn = Object.hasOwn;

export function startNativeEvalBoundaryObservation(source, env = process.env) {
  if (env[NATIVE_EVAL_OBSERVATION_ENV] !== "1" || typeof source !== "string") return null;
  let sourceSha256;
  try {
    sourceSha256 = hashSource(source);
  } catch {
    return null;
  }
  if (!hasOwn(NATIVE_EVAL_OBSERVATION_SOURCES, sourceSha256)) return null;
  let events = [];
  let invocations = 0;
  let incomplete = null;
  function record(invocation, event, value = null) {
    try {
      if (incomplete) return;
      if (events.length >= MAX_EVENTS) {
        incomplete = "event-overflow";
        return;
      }
      if (
        typeof event !== "string" ||
        event.length > MAX_STRING ||
        (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      ) {
        incomplete = "non-primitive-record";
        return;
      }
      if (typeof value === "string" && value.length > MAX_STRING) {
        incomplete = "string-overflow";
        return;
      }
      events[events.length] = { invocation, event, value };
    } catch {
      incomplete = "capture-error";
    }
  }
  return {
    reader(context) {
      try {
        const invocation = ++invocations;
        record(invocation, "reader-context", context);
        return (event, value) => record(invocation, event, value);
      } catch {
        incomplete = "capture-error";
        return undefined;
      }
    },
    snapshot() {
      try {
        // Only our own primitive records are copied; no test value is visited.
        const copied = [];
        for (let i = 0; i < events.length; i++) copied[i] = { ...events[i] };
        return {
          version: 1,
          sourceSha256,
          label: NATIVE_EVAL_OBSERVATION_SOURCES[sourceSha256],
          observationComplete: incomplete === null,
          captureError: incomplete,
          invocations,
          events: copied,
        };
      } catch {
        return { version: 1, sourceSha256, observationComplete: false, captureError: "snapshot-error" };
      } finally {
        events = [];
      }
    },
  };
}
