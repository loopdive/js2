// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3548 — a ZERO-ARG call of a function whose other call site passes a string
// literal trapped unconditionally on the zero-arg (usually PASS) path:
// `inferParamTypeFromCallSites` skipped absent args entirely, so the param was
// inferred as a NON-NULLABLE native-string ref, and the zero-arg pad's only
// filler was `ref.null` + `ref.as_non_null` — a guaranteed null-deref trap.
// The soundness fix: an under-applied call site means the param can be
// `undefined`, so a non-nullable ref inference widens to `ref_null` (NOT
// externref — keeps the precise type). The second half: ToBoolean of a
// nullable native string routed through the null-guarded `__str_truthy`
// helper (`__str_flatten(null)` also trapped).
//
// This was the canonical test262 template shape ($DONE('msg') on fail paths,
// bare $DONE() on the pass path) — but nothing about it is async: the minimal
// repro is two lines at module scope. Optional arguments are ubiquitous in
// real user code, so the fix is justified on soundness, not corpus yield.

async function runStandalone(src: string): Promise<string> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "always",
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports.filter((i) => i.module === "env").map((i) => i.name)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exp = instance.exports as Record<string, unknown>;
  const drain = exp.__drain_microtasks;
  if (typeof drain === "function") (drain as () => void)();
  const prepare = exp.__stdout_prepare;
  const charAt = exp.__stdout_char;
  if (typeof prepare !== "function" || typeof charAt !== "function") return "<no sink>";
  const len = ((prepare as () => number)() | 0) as number;
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(((charAt as (i: number) => number)(i) | 0) & 0xffff);
  return out;
}

describe("#3548 under-applied + string-applied function params", () => {
  it("the collapsed 2-line repro: d('m'); d(); runs both calls (was an unconditional trap)", async () => {
    const out = await runStandalone(`
      function d(x) { console.log("called"); }
      d("m");
      d();
    `);
    expect(out.split("called").length - 1).toBe(2);
  });

  it("truthiness of the missing (undefined) param is falsy; string param truthy; empty string falsy", async () => {
    const out = await runStandalone(`
      function d(x) { console.log(x ? "T" : "F"); }
      d("m");
      d();
      d("");
    `);
    expect(out).toBe("T\nF\nF\n");
  });

  it("the canonical $DONE-style template shape completes on the zero-arg pass path", async () => {
    const out = await runStandalone(`
      function DONE(err) {
        if (err) { console.log("FAIL:" + err); } else { console.log("PASS"); }
      }
      var value = {};
      var p2 = new Promise(function (_, reject) { reject(); })
        .then(function () {}, function () { return value; });
      p2.then(function (x) {
        if (x !== value) { DONE("mismatch"); return; }
        DONE();
      }, function () { DONE("rejected"); });
    `);
    expect(out).toBe("PASS\n");
  });

  it("no-regression: fully-applied string params keep the precise non-null path", async () => {
    const out = await runStandalone(`
      function greet(name) { console.log("hi " + name); }
      greet("a");
      greet("b");
    `);
    expect(out).toBe("hi a\nhi b\n");
  });
});
