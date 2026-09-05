// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 — the four root causes behind cookie's last 69 upstream failures
// (cookie went 63671 → 63740/63740 with these):
//
// 1. `new Date(x)` with a DYNAMIC (any/unknown) single arg ToNumbered an
//    any-held string to NaN, so parseSetCookie silently dropped `expires`.
//    §21.4.2.1 wants ToPrimitive-then-branch: String → parse, else ToNumber.
// 2. Array HOFs (forEach/map/find/…) on a typed REF-element receiver (vec of
//    tuple structs — `Object.entries(top)`) silently NO-OPPED in the gc host
//    lane: the hofElemKindOk gate declined and the generic fallback dropped
//    the call. The cookie corpus registration loop registered zero tests.
// 3. `let x = null; … x = function(){…}; x()` — the #4221 non-callable fold
//    trusted the inferred `null` type of a MUTABLE binding and compiled the
//    call to an unconditional TypeError ("__upstreamSnapshotMatcher is not a
//    function").
// 4. A struct field name CONTAINING a comma (the snapshot table's cookie-string
//    keys) corrupted the comma-joined `__struct_field_names` CSV, so dynamic
//    (and even literal-key) property reads answered undefined.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-cookie-fixes.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 cookie-suite root causes", () => {
  it("new Date(dynamic) parses an any-held string, ToNumbers an any-held number", async () => {
    const exp = await run(`
      export function t(): string {
        const s: any = "Wed, 21 Oct 2015 07:28:00 GMT";
        const n: any = 1000;
        return String(+new Date(s)) + "|" + String(+new Date(n));
      }`);
    expect(exp.t!()).toBe("1445412480000|1000");
  });

  it("forEach over a vec of tuple structs invokes the callback (destructured and plain)", async () => {
    const exp = await run(`
      const out: string[] = [];
      const top = { "a.com": ["k=v", "k2=v2"], "b.com": ["k3=v3"] };
      export function t(): string {
        const pairs: [string, number][] = [["a", 1], ["b", 2]];
        pairs.forEach(([k, v]) => { out.push("P=" + k + String(v)); });
        pairs.forEach((p) => { out.push("Y=" + p[0]); });
        Object.entries(top).forEach(([domain, values]) => {
          (values as any).forEach((value: any) => { out.push("V=" + String(value)); });
        });
        return out.join("|");
      }`);
    expect(exp.t!()).toBe("P=a1|P=b2|Y=a|Y=b|V=k=v|V=k2=v2|V=k3=v3");
  });

  it("calling a deferred-init let binding assigned a function later works", async () => {
    const exp = await run(`
      let matcher = null;
      matcher = function (v: any) { return "L=" + String(v); };
      const tests: any[] = [];
      function it2(name: string, body: any) { tests.push({ body: function (a: any) { return body(a); } }); }
      it2("x", () => String((matcher as any)(1)));
      export function t(): string {
        return String(tests[0].body(undefined)) + "|" + String(typeof matcher);
      }`);
    expect(exp.t!()).toBe("L=1|function");
  });

  it("dynamic property reads work on struct literals with comma-bearing keys", async () => {
    const exp = await run(`
      const obj: any = { "with, comma": 1, plain: 2 };
      export function t(): string {
        const k1: any = "with, comma";
        const k2: any = "plain";
        return String(obj[k1]) + "|" + String(obj[k2]) + "|" + String(obj["with, comma"]);
      }`);
    expect(exp.t!()).toBe("1|2|1");
  });
});
