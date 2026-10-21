// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S1i — an IR direct call with FEWER arguments than the callee's fixed
// formals (propertyHelper's `verifyProperty` → `isWritable(obj, name)` on four
// formals, `verifyNotWritable` → `isWritable(obj, name, verifyProp)`). Legacy
// pads each missing formal with the canonical `undefined` and, when the
// callee reads `arguments`, publishes `__argc = actual` before the call; the
// IR does exactly that (`dyn.undefined` pads + `dyn.publish_argc`). Every
// verdict is checked against node running the same source.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

type Compiled = Awaited<ReturnType<typeof compile>>;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Compiled): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

function outcome(result: Compiled, name: string): { code?: string; detail?: string } | undefined {
  return (result.irOutcomes ?? []).find((o) => o.displayName === name) as { code?: string } | undefined;
}

/** The same program under node: strip `export`, return the named function's value. */
function node(source: string, name: string): number {
  return new Function(`${source.replace(/\bexport /g, "")}\nreturn ${name}();`)() as number;
}

async function compileOk(source: string, fileName: string): Promise<Compiled> {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

describe("#7106 S1i — under-arity direct calls", () => {
  it("pads missing dynamic formals with undefined and publishes the actual count to an arguments reader", async () => {
    const source = `
      /** @param {object} obj @param {string|symbol} name @param {object} verifyProp @param {object} value */
      function isWritableLike(obj, name, verifyProp, value) {
        return arguments.length * 10 + (value === undefined ? 1 : 2) + (verifyProp === undefined ? 4 : 0);
      }
      /** @param {object} obj @param {string|symbol} name */
      function two(obj, name) { return isWritableLike(obj, name); }
      /** @param {object} obj @param {string|symbol} name @param {object} vp */
      function three(obj, name, vp) { return isWritableLike(obj, name, vp); }
      export function ok() { return two({}, "x") * 1000 + three({}, "x", {}); }
    `;
    const result = await compileOk(source, "issue-7106-s1i-argc.js");
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["isWritableLike", "two", "three"]),
    );
    expect(node(source, "ok")).toBe(25031);
    expect(await call(result.binary, "ok")).toBe(25031);
  });

  it("publishes nothing for a callee that does not read arguments, and the next reader sees its own count", async () => {
    const source = `
      /** @param {object} a @param {object} b @param {object} c */
      function pad(a, b, c) { return c === undefined; }
      /** @param {object} a @param {object} b */
      function count(a, b) { return arguments.length; }
      /** @param {object} x */
      function chain(x) { return (pad(x) ? 10 : 0) + count(x, x); }
      export function ok() { return chain({}); }
    `;
    const result = await compileOk(source, "issue-7106-s1i-pad.js");
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["pad", "count", "chain"]),
    );
    expect(node(source, "ok")).toBe(12);
    expect(await call(result.binary, "ok")).toBe(12);
  });

  // A missing CONCRETE formal is legacy's `0` sentinel (not `undefined`, so
  // `add(3)` is 3 there and NaN in node): it stays legacy, and is not compared.
  it("keeps concrete missing formals, spread and over-arity calls on legacy", async () => {
    const source = `
      /** @param {number} a @param {number} b */
      function add(a, b) { return a + b; }
      /** @param {number} x */
      function concrete(x) { return add(x); }
      /** @param {object} a @param {object} b */
      function two(a, b) { return arguments.length; }
      /** @param {object} x */
      function spread(x) { return two(...[x]); }
      /** @param {object} x */
      function over(x) { return two(x, x, x); }
      export function ok() { return 10 * spread({}) + 100 * over({}); }
      export function keep() { return concrete(3); }
    `;
    const result = await compileOk(source, "issue-7106-s1i-legacy.js");
    for (const name of ["concrete", "spread", "over"]) {
      expect(outcome(result, name)?.code, name).toBe("call-arity-unsupported");
    }
    expect(node(source, "ok")).toBe(310);
    expect(await call(result.binary, "ok")).toBe(310);
  });
});
