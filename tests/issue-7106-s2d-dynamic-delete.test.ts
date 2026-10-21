// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S2d — `delete obj[name];` over two dynamic parameters (propertyHelper's
// `isConfigurable`) ships an IR body: `dyn.delete_property` calls a wrapper
// holding legacy's generic delete tail verbatim — RequireObjectCoercible on the
// base, the runtime `__delete_property`, and in strict code the refusal
// TypeError. Every verdict is checked against node running the same program as
// strict code (the compiled file is a module, so legacy and IR are strict).

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

function irBodies(result: Compiled): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

/** The same program under node as strict code: strip `export`, return the named function's value. */
function node(source: string, name: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn ${name}();`)() as number;
}

async function compileOk(source: string, fileName: string): Promise<Compiled> {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

const HELPERS = `
  /** @param {object} obj @param {string|symbol} name */
  function del(obj, name) {
    delete obj[name];
    return true;
  }
  /** @param {object} obj @param {string|symbol} name */
  function delTry(obj, name) {
    try {
      delete obj[name];
    } catch (e) {
      return false;
    }
    return true;
  }
  /** @param {string} k */
  function mk(k) {
    var o = {};
    o[k] = 1;
    return o;
  }
`;

describe("#7106 S2d — dynamic delete statement", () => {
  it("deletes an own configurable property (object and array receivers)", async () => {
    const source = `${HELPERS}
      export function ok() {
        var o = mk("a");
        del(o, "a");
        var arr = [1, 2, 3];
        del(arr, "1");
        var missing = mk("a");
        del(missing, "zz");
        return (o.hasOwnProperty("a") ? 1 : 0) + (arr.hasOwnProperty("1") ? 10 : 0) + (missing.hasOwnProperty("a") ? 100 : 0);
      }
    `;
    const result = await compileOk(source, "issue-7106-s2d-own.js");
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["del", "delTry"]),
    );
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(node(source, "ok")).toBe(100);
    expect((instance.exports.ok as () => number)()).toBe(100);
  });

  it("throws TypeError in strict code for a non-configurable property and for a null/undefined base", async () => {
    const source = `${HELPERS}
      export function ok() {
        var o = mk("a");
        Object.defineProperty(o, "b", { value: 2, configurable: false });
        var n = delTry(o, "b") ? 1 : 0;
        n = n + (o.hasOwnProperty("b") ? 10 : 0);
        n = n + (delTry(null, "a") ? 100 : 0);
        n = n + (delTry(void 0, "a") ? 1000 : 0);
        n = n + (delTry(o, "a") ? 10000 : 0);
        return n;
      }
    `;
    const result = await compileOk(source, "issue-7106-s2d-strict.js");
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(expect.arrayContaining(["delTry"]));
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(node(source, "ok")).toBe(10010);
    expect((instance.exports.ok as () => number)()).toBe(10010);
  });

  it("keeps every other delete shape on its existing path", async () => {
    const source = `
      /** @param {object} obj */
      function literalKey(obj) { delete obj["a"]; return true; }
      /** @param {object} obj */
      function named(obj) { delete obj.a; return true; }
      /** @param {object} obj @param {string|symbol} name */
      function valueUse(obj, name) { return delete obj[name]; }
      export function ok() { return 1; }
    `;
    const result = await compileOk(source, "issue-7106-s2d-other.js");
    const bodies = irBodies(result);
    for (const name of ["literalKey", "named", "valueUse"]) expect(bodies, name).not.toContain(name);
  });
});
