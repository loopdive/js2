import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #2180 — Host-mode `Proxy` completion.
 *
 * In JS-host mode a compiled `new Proxy(target, handler)` reaches the runtime
 * with `target`/`handler` as opaque WasmGC structs. Three defects kept
 * `built-ins/Proxy` conformance stuck at ~23 % after #1466:
 *
 *  1. Construction never threw the §28.2.1.1 `TypeError`s for a non-object
 *     target/handler (`proxy_create` swallowed the native throw and returned
 *     the target).
 *  2. The host could not discover ANY trap on the struct handler — every
 *     `handler[trapName]` read on an opaque struct returns `undefined`, so no
 *     trap ever fired and operations silently fell through to the target.
 *     `proxy_create` now bridges each trap closure off the raw struct (via the
 *     `__sget_<name>` field getter + the closure-wrap helper) into a
 *     plain-object handler the host can read, with `this` re-threaded to the
 *     raw handler struct for trap-receiver identity.
 *  3. `Proxy(t,h)` without `new` did not throw (`Proxy` was missing from
 *     `NAMESPACE_NON_CALLABLE`).
 *
 * The boundary helpers (`__extern_get`/`__extern_has`/`__extern_set`/
 * `__delete_property`) also re-throw a revoked-proxy `TypeError` instead of
 * swallowing it in their struct-getter fallback.
 *
 * These tests assert the buckets that flipped to `pass`. Cases that depend on
 * unrelated codegen (extern-class proxy targets, `with`, object-literal
 * function returns) remain out of scope and are not asserted here.
 */

const TEST262 = "/workspace/test262";
const ROOT = `${TEST262}/test/built-ins/Proxy`;

// Construction TypeErrors (§28.2.1.1 step 1/2) — target/handler must be objects.
const constructionThrows = [
  "create-target-not-object-throw-number.js",
  "create-target-not-object-throw-string.js",
  "create-target-not-object-throw-boolean.js",
  "create-target-not-object-throw-null.js",
  "create-target-not-object-throw-undefined.js",
  "create-target-not-object-throw-symbol.js",
  "create-handler-not-object-throw-number.js",
  "create-handler-not-object-throw-string.js",
  "create-handler-not-object-throw-boolean.js",
  "create-handler-not-object-throw-null.js",
  "create-handler-not-object-throw-undefined.js",
  "create-handler-not-object-throw-symbol.js",
];

// Trap dispatch + receiver/argument fidelity — the host now finds the struct
// handler's traps and fires them with spec-correct arguments.
const trapDispatch = ["get/call-parameters.js", "set/call-parameters.js", "getPrototypeOf/call-parameters.js"];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#2180 host-mode Proxy", () => {
  describe("construction throws TypeError for non-object target/handler", () => {
    for (const rel of constructionThrows) {
      it(rel, async () => {
        const r = await runTest262File(`${ROOT}/${rel}`, "built-ins/Proxy");
        expect(r.status, `error: ${(r as any).error ?? ""}`).toBe("pass");
      });
    }
  });

  describe("trap dispatch + receiver/argument fidelity", () => {
    for (const rel of trapDispatch) {
      it(rel, async () => {
        const r = await runTest262File(`${ROOT}/${rel}`, "built-ins/Proxy");
        expect(r.status, `error: ${(r as any).error ?? ""}`).toBe("pass");
      });
    }
  });
});
