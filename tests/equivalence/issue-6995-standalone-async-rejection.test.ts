// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";

// #6995 — standalone async: a body the drive engine declines falls to the
// synchronous pass-through, whose `await` read a REJECTED `$Promise`'s reason
// as if it were the fulfilled value (catch never ran, the function fulfilled),
// and the #3587 loud refusal returned early on standalone/wasi.
//
// Shipped behaviour, pinned here:
//   - honest unwrap: on the pass-through a REJECTED `$Promise` throws its
//     reason into the enclosing `try` (a fulfilled one yields its value), so a
//     declined body whose awaited operands are provably SETTLED runs like node;
//   - a declined TOP-LEVEL async declaration (what the drive engine can claim)
//     whose in-`try` await operand may still be PENDING is refused at compile
//     time with the #3587 message (the pass-through cannot suspend), as on gc;
//   - parked arrows / function expressions / methods (never claimed by the
//     engine) are not refused: they get the honest unwrap.

interface Run {
  out: string[];
  error: string | null;
  compileErrors: string[];
}

async function runWasm(src: string, target: "standalone" | "gc"): Promise<Run> {
  const result = await compile(src, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) return { out: [], error: null, compileErrors: result.errors.map((e) => e.message) };
  const out: string[] = [];
  let imports: WebAssembly.Imports = {};
  if (target === "gc") {
    imports = result.importObject as WebAssembly.Imports;
    const env = ((imports as Record<string, unknown>).env ?? {}) as Record<string, unknown>;
    for (const k of ["console_log_number", "console_log_string", "console_log_bool"]) {
      env[k] = (v: unknown) => out.push(String(v));
    }
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  const exp = instance.exports as Record<string, (...a: number[]) => number>;
  let error: string | null = null;
  try {
    exp.__module_init?.();
    exp.__drain_microtasks?.();
  } catch (e) {
    error = String(e);
  }
  if (typeof exp.__stdout_prepare === "function") {
    const len = exp.__stdout_prepare() | 0;
    let sink = "";
    for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
    for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  }
  return { out, error, compileErrors: [] };
}

async function runNode(src: string): Promise<string[]> {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return out;
}

/** Single-string logging so the standalone sink and node render identically. */
const LOG = `function log(v) { console.log(String(v)); }\n`;

async function expectSameAsNode(body: string, target: "standalone" | "gc" = "standalone"): Promise<string[]> {
  const src = LOG + body;
  const [wasm, node] = await Promise.all([runWasm(src, target), runNode(src)]);
  expect(wasm.compileErrors).toEqual([]);
  expect(wasm.error).toBeNull();
  expect(wasm.out).toEqual(node);
  return node;
}

async function expectRefused(body: string, target: "standalone" | "gc" = "standalone"): Promise<void> {
  const wasm = await runWasm(LOG + body, target);
  expect(wasm.compileErrors.length).toBeGreaterThan(0);
  expect(wasm.compileErrors.join("\n")).toContain("#3587");
}

const THEN = `a().then((v) => log(v), (e) => log("rej " + e));`;

// The audit repros: a try/catch/finally around the await nested inside another
// `try` has no drive plan, so the declaration declines.
const NESTED_SHAPES: Record<string, string> = {
  "nested try, rethrow": `let s = ""; try { try { await Promise.reject(1); } catch (e) { s += "c"; throw e; } finally { s += "f"; } } catch (e2) { s += "o" + e2; } return s;`,
  "nested try, no rethrow": `let s = ""; try { try { await Promise.reject(1); } catch (e) { s += "c"; } finally { s += "f"; } } catch (e2) { s += "o" + e2; } return s;`,
  "outer try/finally": `let s = ""; try { try { await Promise.reject(1); } catch (e) { s += "c"; } finally { s += "f"; } } finally { s += "F"; } return s;`,
  "block-wrapped inner try": `let s = ""; try { { try { await Promise.reject(1); } catch (e) { s += "c"; } finally { s += "f"; } } } catch (e2) { s += "o" + e2; } return s;`,
  "preceded by await null": `let s = ""; await null; try { try { await Promise.reject(1); } catch (e) { s += "c"; throw e; } finally { s += "f"; } } catch (e2) { s += "o" + e2; } return s;`,
};

/** Same shapes, with an operand that is still PENDING when the await runs. */
const PENDING = `new Promise((res, rej) => { Promise.resolve().then(() => rej(1)); })`;

describe("#6995 standalone async: declined shapes never swallow a rejection", () => {
  for (const [name, body] of Object.entries(NESTED_SHAPES)) {
    it(`top-level declaration (${name}) runs the catch/finally chain like node`, async () => {
      await expectSameAsNode(`async function a() { ${body} }\n${THEN}`);
    });

    it(`async arrow (${name}) runs the catch/finally chain like node`, async () => {
      await expectSameAsNode(`const a = async () => { ${body} };\n${THEN}`);
    });

    it(`top-level declaration (${name}) with a PENDING operand is refused, not silently fulfilled`, async () => {
      await expectRefused(`async function a() { ${body.replace("Promise.reject(1)", PENDING)} }\n${THEN}`);
    });
  }

  it("the audit repro reports node's value, and the promise does not fulfil", async () => {
    const node = await expectSameAsNode(`async function a() { ${NESTED_SHAPES["nested try, rethrow"]} }\n${THEN}`);
    expect(node).toEqual(["cfo1"]);
  });

  it("an uncaught awaited rejection rejects the arrow's promise", async () => {
    const node = await expectSameAsNode(`const a = async () => { await Promise.reject(3); return "x"; };\n${THEN}`);
    expect(node).toEqual(["rej 3"]);
  });

  it("a method's awaited rejection reaches its catch", async () => {
    const node = await expectSameAsNode(
      `const o = { async m() { let s = ""; try { await Promise.reject(5); } catch (e) { s += "c" + e; } return s; } };
       const a = () => o.m();\n${THEN}`,
    );
    expect(node).toEqual(["c5"]);
  });

  it("a fulfilled await through the pass-through still yields its value", async () => {
    await expectSameAsNode(`const a = async () => { const v = await Promise.resolve(7); return v + 1; };\n${THEN}`);
  });

  it("`await <thenable>` adopts the thenable (driven declaration)", async () => {
    // One handler: `.then(f, g)` over a thenable-adopted value reads `null` on
    // standalone through `Promise.resolve(thenable)` too — pre-existing, noted in #6995.
    const node = await expectSameAsNode(
      `async function a() { return await { then(res) { res(42); } }; }\na().then((v) => log(v));`,
    );
    expect(node).toEqual(["42"]);
  });

  it("`await <rejecting thenable>` throws into the catch (driven declaration)", async () => {
    const node = await expectSameAsNode(
      `async function a() { try { await { then(res, rej) { rej(7); } }; } catch (e) { return "c" + e; } }\n${THEN}`,
    );
    expect(node).toEqual(["c7"]);
  });

  // Await → PromiseResolve performs ONE observable Get(then) and runs the
  // function it fetched (§27.2.1.3.2 steps 9-14) — review on PR #6700.
  it("`await <thenable>` reads `then` exactly once", async () => {
    const node = await expectSameAsNode(
      `let reads = 0;
       const operand = { get then() { reads++; return (resolve) => resolve(reads); } };
       async function a() { return await operand; }
       a().then((v) => log(v + " " + reads));`,
    );
    expect(node).toEqual(["1 1"]);
  });

  it("`await <thenable>` calls the FIRST fetched `then`, not a re-read one", async () => {
    const node = await expectSameAsNode(
      `let reads = 0;
       const operand = { get then() { reads++; return reads === 1 ? (resolve) => resolve("first") : (resolve) => resolve("second"); } };
       async function a() { return await operand; }
       a().then((v) => log(v + " " + reads));`,
    );
    expect(node).toEqual(["first 1"]);
  });

  it("a throwing `then` getter rejects the await with the thrown value", async () => {
    const node = await expectSameAsNode(
      `const boom = { tag: "boom" };
       const operand = { get then() { throw boom; } };
       async function a() { try { await operand; return "no"; } catch (e) { return (e === boom) + " " + e.tag; } }
       a().then((v) => log(v));`,
    );
    expect(node).toEqual(["true boom"]);
  });

  it("`await <plain value>` and a non-callable `then` deliver the operand", async () => {
    const node = await expectSameAsNode(
      `async function a() { const v = await 5; const o = await { then: 3 }; return v + o.then; }
       a().then((v) => log(v));`,
    );
    expect(node).toEqual(["8"]);
  });

  it("`await <plain object>` yields the object, no illegal cast", async () => {
    const node = await expectSameAsNode(
      `async function a() { const o = { k: 1 }; const r = await o; return r.k; }\n${THEN}`,
    );
    expect(node).toEqual(["1"]);
  });

  it("a driven declaration's try/catch around a rejected await is unchanged", async () => {
    const node = await expectSameAsNode(
      `async function a() { try { await Promise.reject(2); } catch (e) { return "c" + e; } }\n${THEN}`,
    );
    expect(node).toEqual(["c2"]);
  });
});

// A value call cannot rely on the caller knowing the async modifier.
describe("#6995 native async closure completion boundary", () => {
  const indirect = `function invoke(f) { return f(); }\n`;
  const observe = `function observe(f, reason) {
    try {
      const p = invoke(f); log(p instanceof Promise);
      p.then(() => log("fulfilled"), e => log(e === reason));
    } catch (e) { log("synchronous throw"); }
  }\n`;

  it("an await-free async function value rejects with its original reason", async () => {
    expect(
      await expectSameAsNode(
        indirect + observe + `const reason = { marker: 17 }; observe(async function () { throw reason; }, reason);`,
      ),
    ).toEqual(["true", "true"]);
  });

  it("a custom TypeError keeps its constructor identity through rejection", async () => {
    expect(
      await expectSameAsNode(
        indirect +
          `function TypeError() {} const reason = new TypeError();
       const p = invoke(async function () { throw reason; });
       log(p instanceof Promise);
       p.then(() => log("fulfilled"), e => log((e === reason) && e.constructor === TypeError));`,
      ),
    ).toEqual(["true", "true"]);
  });

  it("an uncaught await rejection rejects the dynamically invoked void closure", async () => {
    expect(
      await expectSameAsNode(
        indirect +
          observe +
          `const reason = { marker: 18 }; observe(async () => { await Promise.reject(reason); }, reason);`,
      ),
    ).toEqual(["true", "true"]);
  });

  it("finally overrides an abrupt completion before the boundary rejects", async () => {
    expect(
      await expectSameAsNode(
        indirect +
          observe +
          `const first = { marker: 1 }; const reason = { marker: 2 };
       observe(async function () { try { throw first; } finally { log("finally"); throw reason; } }, reason);`,
      ),
    ).toEqual(["finally", "true", "true"]);
  });

  it("normal void completion remains fulfilled after finally and explicit return", async () => {
    expect(
      await expectSameAsNode(
        indirect +
          `const p = invoke(async function () { try { return; } finally { log("finally"); } });
       log(p instanceof Promise); p.then(v => log(v === undefined), () => log("rejected"));`,
      ),
    ).toEqual(["finally", "true", "true"]);
  });

  it("a non-async function value still throws synchronously", async () => {
    expect(
      await expectSameAsNode(
        indirect +
          `const reason = { marker: 19 }; try { invoke(function () { throw reason; }); log("returned"); }
       catch (e) { log(e === reason); }`,
      ),
    ).toEqual(["true"]);
  });
});
