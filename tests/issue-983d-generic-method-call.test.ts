import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

// #983d — A call `obj.method(args)` where `method` is a HOST function value
// stored in `obj` (the generic-Array-method-on-plain-object pattern
// `var o = {}; o.pop = Array.prototype.pop; o.pop()`) used to fall past every
// static / struct-method handler and hit the graceful-null fallback in
// `compileCallExpression`, which DROPPED the method and returned
// `ref.null.extern` — so the call was never made: `o.pop()` yielded `null`
// instead of `undefined`, and any mutation the method would perform on `o`
// never happened.
//
// The fix routes such calls to `__extern_method_call(receiver, method, args)`
// (the live-mirror host bridge) before the fallback, so the host runs the
// generic Array method with the `_wrapForHost` proxy as `this` — giving the
// correct return value AND mutation observability.
//
// These test262 entries went 0 → pass with the dual-path dispatch (the residual
// `obj.length === undefined` assertions in the longer variants are a separate
// missing-field→null property-read bug, tracked separately).
describe("#983d generic Array-method-on-plain-object dispatch", () => {
  const TEST262 = "/workspace/test262/test";
  const cases = [
    "built-ins/Array/prototype/pop/S15.4.4.6_A2_T1.js",
    "built-ins/Array/prototype/pop/S15.4.4.6_A3_T1.js",
    "built-ins/Array/prototype/shift/S15.4.4.9_A2_T1.js",
  ];
  for (const rel of cases) {
    const abs = `${TEST262}/${rel}`;
    const name = rel.split("/").slice(-2).join("/");
    (existsSync(abs) ? it : it.skip)(`test262: ${name} passes (was null-drop)`, async () => {
      const r = await runTest262File(abs, rel.split("/").slice(0, 2).join("/"));
      expect(r.status).toBe("pass");
    });
  }
});
