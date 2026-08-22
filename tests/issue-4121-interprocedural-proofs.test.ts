// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4121, slice 2) The route-2 definition prover gets a DECLARATION-RESOLVED
 * call arm.
 *
 * Route 2 (#3765) already proves `var i = g(1)` numeric when `g` is in
 * `numericFunctions` — but that set is keyed by NAME over every function-like
 * in the program, so one same-named member withdraws the verdict for all of
 * them:
 *
 *     const o = { g: function () { return "s"; } };
 *     function g(x) { return x + 1; }
 *     var i = g(1);      // `g` withdrawn because of `o.g`; `i` stays boxed
 *
 * `inferBindingAwareNumericReturnTypes` (#4121's 2026-08-09 return-carrier
 * checkpoint) resolves the callee to its exact declaration and keeps the
 * verdict. This slice feeds that map back into the slot fixpoint, as a
 * stratified third level — locals ground returns, returns ground this.
 *
 * Kill switches, composed, no new variable: `JS2WASM_NUMERIC_RETURNS=0`
 * (the fact source) and `JS2WASM_NUMERIC_ADMISSION=0` (slice 1's gate) each
 * restore the previous carrier exactly.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function build(source: string, env?: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await compile(source, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The `(func $fn …)` body, paren-balanced. */
function bodyOf(wat: string, fn: string): string {
  const start = wat.indexOf(`(func $${fn}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === "(") depth++;
    else if (wat[i] === ")" && --depth === 0) return wat.slice(start, i + 1);
  }
  return wat.slice(start);
}

function localType(body: string, name: string): string {
  return body.match(new RegExp(`\\(local \\$${name} ([^)]*)\\)`))?.[1] ?? "";
}

async function run(source: string, env?: Record<string, string>): Promise<unknown> {
  const { binary } = await build(source, env);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
  return (exports as { main: () => unknown }).main();
}

/**
 * The shape this slice exists for. `o.g` is a genuine non-numeric function of
 * the same NAME, so the name-keyed `numericFunctions` set drops `g` and route 2
 * has no evidence for `i`. Route 1 bails too — `i + 1` is `+`, which dispatches
 * on the runtime type. Only the declaration-resolved return carrier can decide.
 */
const NAME_COLLISION = `
const o = { g: function(){ return "s"; } };
function g(x){ return x + 1; }
function f(){ var i = g(1); i = i + 1; return o.g().length + i * 2; }
export function main(){ return f(); }
`;

describe("#4121 slice 2 — the route-2 call-definition arm resolves the callee, not its name", () => {
  it("unboxes a local defined by a direct call the NAME-keyed set had to withdraw", async () => {
    const { wat } = await build(NAME_COLLISION);
    expect(localType(bodyOf(wat!, "f"), "i")).toBe("f64");
  });

  it.each([
    ["JS2WASM_NUMERIC_RETURNS", "0"],
    ["JS2WASM_NUMERIC_ADMISSION", "0"],
  ])("is off under %s=%s, restoring the boxed carrier", async (key, value) => {
    const { wat } = await build(NAME_COLLISION, { [key]: value });
    expect(localType(bodyOf(wat!, "f"), "i")).toBe("externref");
  });

  it("computes what JS computes, with the arm on and with each switch off", async () => {
    // node: g(1) === 2, i === 3, "s".length === 1, 1 + 6 === 7.
    expect(await run(NAME_COLLISION)).toBe(7);
    expect(await run(NAME_COLLISION, { JS2WASM_NUMERIC_RETURNS: "0" })).toBe(7);
    expect(await run(NAME_COLLISION, { JS2WASM_NUMERIC_ADMISSION: "0" })).toBe(7);
  });

  // --- "What must still decline" (#4121). ------------------------------------

  /**
   * The `` `${b}` `` → `1` trap. `p` returns a comparison, so the return map
   * brands it `i32`/boolean rather than `f64` — and the arm accepts ONLY a
   * plain `f64` carrier, so it contributes nothing here. The slot #2847's
   * boolean brand gives this binding is `i32`, and the brand knows to print
   * "true"; an f64 carrier would print "1".
   */
  it("declines a boolean-branded return carrier (the brand keeps the slot, not this arm)", async () => {
    const source = `
      const o = { p: function(){ return "s"; } };
      function p(x){ return x > 1; }
      function f(){ var b = p(2); return \`\${b}\`.length + o.p().length; }
      export function main(){ return f(); }
    `;
    const { wat } = await build(source);
    // NOT f64 — the boolean brand's i32, exactly as with the arm switched off.
    expect(localType(bodyOf(wat!, "f"), "b")).toBe("i32");
    expect(localType(bodyOf((await build(source, { JS2WASM_NUMERIC_RETURNS: "0" })).wat!, "f"), "b")).toBe("i32");
    // "true".length + "s".length — what node computes. An f64 carrier would
    // print "1" and give 2.
    expect(await run(source)).toBe(5);
    expect(await run(source, { JS2WASM_NUMERIC_ADMISSION: "0" })).toBe(5);
  });

  it("declines a mixed boolean/number return (neither carrier can represent it)", async () => {
    const source = `
      const o = { m: function(){ return "s"; } };
      function m(x){ if (x > 5) { return true; } return x + 1; }
      function f(){ var v = m(9); return \`\${v}\`.length + o.m().length; }
      export function main(){ return f(); }
    `;
    const { wat } = await build(source);
    expect(localType(bodyOf(wat!, "f"), "v")).toBe("externref");
    // A/B, not an absolute: `${v}` on a boxed `any` local holding a boolean
    // FROM A CALL already prints "1" instead of "true" on plain `origin/main`
    // (minimal repro in the issue file; `var v = true` prints "true"). That is
    // a pre-existing divergence this slice neither causes nor fixes, so what
    // belongs here is the assertion that the kill switch changes nothing.
    expect(await run(source)).toBe(await run(source, { JS2WASM_NUMERIC_ADMISSION: "0" }));
  });

  it("declines a capture — a captured binding lives in a ref cell", async () => {
    const source = `
      const o = { g: function(){ return "s"; } };
      function g(x){ return x + 1; }
      function f(){ var i = g(1); const h = () => i * 2; return h() + o.g().length; }
      export function main(){ return f(); }
    `;
    const { wat } = await build(source);
    expect(localType(bodyOf(wat!, "f"), "i")).toBe("externref");
    expect(await run(source)).toBe(5);
  });

  it("declines a read before the definition — an f64 slot reads 0/NaN, JS says undefined", async () => {
    const source = `
      const o = { g: function(){ return "s"; } };
      function g(x){ return x + 1; }
      function f(c){ if (c) { return (typeof v).length; } var v = g(1); return v * 2 + o.g().length; }
      export function main(){ return f(1); }
    `;
    const { wat } = await build(source);
    expect(localType(bodyOf(wat!, "f"), "v")).toBe("externref");
    // A/B again: `(typeof u).length` answers NaN rather than 9 on plain
    // `origin/main` even for a local with no call in sight — a second
    // pre-existing divergence recorded in the issue file.
    expect(await run(source)).toBe(await run(source, { JS2WASM_NUMERIC_ADMISSION: "0" }));
  });

  it("declines an ungrounded return cycle (the least fixpoint refuses to type itself)", async () => {
    const source = `
      const o = { a: function(){ return "s"; } };
      function a(x){ return b(x); }
      function b(x){ return a(x); }
      function f(){ var i = a(1); i = i + 1; return i * 2 + o.a().length; }
      export function main(){ return 0; }
    `;
    const { wat } = await build(source);
    expect(localType(bodyOf(wat!, "f"), "i")).toBe("externref");
  });

  /**
   * The reduced case the issue's table calls row 4, and slice 1 left red.
   *
   * It is STILL red, deliberately pinned so a future slice that closes it has
   * to update this expectation on purpose. The blocker is neither of this
   * slice's arms: `s` is the unannotated parameter of an exported function, so
   * nothing proves it is a string, so `s.indexOf(";")` is not a proven-numeric
   * definition. Route 1 cannot carry it either — `i + 1` is `+`. Closing this
   * needs the string-receiver proof the issue names as "a second, independent
   * gap", not a call-return or argument-use arm.
   */
  it("still declines row 4 — the blocker is the unproven string receiver, not the call arm", async () => {
    const { wat } = await build(`export function f(s){ var i = s.indexOf(";"); i = i + 1; return i * 2; }`);
    expect(localType(bodyOf(wat!, "f"), "i")).toBe("externref");
  });
});
