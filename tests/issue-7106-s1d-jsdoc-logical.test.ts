// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 item 1 (S1d) — the propertyHelper.js parameter shapes: a JSDoc type
// the IR cannot express (`@param {object} obj`, `{string|symbol} name`,
// `{PropertyDescriptor|undefined} desc`, a bracketed `[options]`) defers to
// the legacy projection (externref ⇒ dynamic) instead of rejecting the
// function, and `options && options.label || String(name)` lowers as a
// dynamic VALUE through nested `dyn.truthy` selections.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S1d — JSDoc-typed harness parameters and nested logical values", () => {
  it("the propertyHelper label idiom with JSDoc-typed parameters ships an IR body and runs", async () => {
    const result = await compile(
      `
        /**
         * @param {object} obj
         * @param {string|symbol} name
         * @param {PropertyDescriptor|undefined} desc
         * @param {object} [options]
         * @param {boolean} [options.label]
         */
        function labelOf(obj, name, desc, options) {
          var label = options && options.label || String(name);
          if (desc === undefined) return undefined;
          return label;
        }
        export function ok() {
          var n = 0;
          if (labelOf({}, "p", undefined, undefined) === undefined) n += 1;
          if (labelOf({}, "p", { value: 1 }, { label: "L" }) === "L") n += 2;
          if (labelOf({}, 7, { value: 1 }, {}) === "7") n += 4;
          if (labelOf({}, "q", { value: 1 }, { label: "" }) === "q") n += 8;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1d-label-of.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("labelOf");
    expect(await call(result.binary, "ok")).toBe(15);
  });

  it("a bracketed JSDoc parameter keeps legacy's externref ABI (a typed tag would otherwise claim a string slot)", async () => {
    const result = await compile(
      `
        /**
         * @param {string} [functionName]
         * @param {number} functionLength
         */
        function nameOf(functionName, functionLength) {
          if (functionName === undefined) return functionLength > 1 ? "anon" : "anon1";
          return functionName;
        }
        export function ok() { return (nameOf(undefined, 2) === "anon" ? 1 : 0) + (nameOf("f", 1) === "f" ? 2 : 0); }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1d-bracketed.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("nameOf");
    expect(await call(result.binary, "ok")).toBe(3);
  });

  it("member-read and nested logical carriers short-circuit per §13.13.1", async () => {
    const result = await compile(
      `
        /** @param {object} o */
        function pick(o) { return o && o.label; }
        /** @param {object} o */
        function store(o) { var v = o && o.label; return v; }
        /** @param {object} a  @param {*} b */
        function both(a, b) { return a && a.x || b; }
        export function ok() {
          var n = 0;
          if (pick(undefined) === undefined) n += 1;
          if (pick(0) === 0) n += 2;
          if (pick({ label: "L" }) === "L") n += 4;
          if (store({ label: 3 }) === 3) n += 8;
          if (both({ x: 0 }, "b") === "b") n += 16;
          if (both({ x: "x" }, "b") === "x") n += 32;
          if (both(null, 5) === 5) n += 64;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1d-carriers.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const bodies = irBodies(result);
    expect(bodies, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["pick", "store", "both"]),
    );
    expect(await call(result.binary, "ok")).toBe(127);
  });
});
