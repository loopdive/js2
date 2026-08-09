// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3542 — standalone async-fn rejections must carry the THROWN VALUE.
//
// `wrapAsyncCallInTryCatch`'s standalone arm caught a synchronously-unwinding
// async-body throw with a bare `catch_all` and minted the rejected `$Promise`
// with `ref.null.extern` as the reason — an unfinished #1326 Phase-1C TODO.
// Every sync-unwinding async throw (sync throw, AG0 sync-unwrapped await
// continuation, sync-settling for-await drive) rejected with NULL; test262's
// for-await-dstr rejection handlers then destructured null and manufactured
// the "Cannot destructure 'null' or 'undefined'" corpus signature (~130 rows
// — an ECHO of the defect, not the defect). Fix: a `catch $exn` arm whose tag
// payload becomes the rejection reason; `catch_all` remains the reason-less
// fallback for foreign exceptions only.

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

describe("#3542 standalone async-fn rejection reason carries the thrown value", () => {
  it("sync throw in an async fn rejects with the real TypeError (not null)", async () => {
    const out = await runStandalone(`
      async function f() { throw new TypeError("boom-sync"); }
      f().catch(function (e) {
        if (e === null) console.log("reason NULL");
        else if (e instanceof TypeError) console.log("TypeError:" + e.message);
        else console.log("other:" + typeof e);
      });
    `);
    expect(out).toContain("TypeError:boom-sync");
    expect(out).not.toContain("reason NULL");
  });

  it("throw after a sync-unwrapped await rejects with the real TypeError", async () => {
    const out = await runStandalone(`
      async function f() { await Promise.resolve(1); throw new TypeError("boom-await"); }
      f().catch(function (e) {
        if (e === null) console.log("reason NULL");
        else if (e instanceof TypeError) console.log("TypeError:" + e.message);
        else console.log("other:" + typeof e);
      });
    `);
    expect(out).toContain("TypeError:boom-await");
    expect(out).not.toContain("reason NULL");
  });

  it("for-await dstr TypeError reaches the rejection handler intact (the #3417 cluster shape)", async () => {
    // `[{ x }]` against `[]` → ObjectBindingPattern vs undefined → TypeError.
    // Pre-fix the handler received NULL and its own destructure-of-null threw.
    const out = await runStandalone(`
      async function fn() { for await (let [{ x }] of [[]]) { return; } }
      fn().then(function () { console.log("resolved BAD"); }, function (e) {
        if (e === null) console.log("reason NULL");
        else if (e instanceof TypeError) console.log("TypeError ok");
        else console.log("other:" + typeof e);
      });
    `);
    expect(out).toContain("TypeError ok");
    expect(out).not.toContain("reason NULL");
    expect(out).not.toContain("resolved BAD");
  });

  it("no-regression: direct and executor rejections still carry their reason", async () => {
    const out = await runStandalone(`
      Promise.reject(new TypeError("direct")).catch(function (e) {
        console.log(e instanceof TypeError ? "direct ok" : "direct broken");
      });
      new Promise(function (res, rej) { rej(new TypeError("exec")); }).catch(function (e) {
        console.log(e instanceof TypeError ? "exec ok" : "exec broken");
      });
    `);
    expect(out).toContain("direct ok");
    expect(out).toContain("exec ok");
  });
});
