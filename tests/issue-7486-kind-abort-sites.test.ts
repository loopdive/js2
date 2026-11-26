// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7486 — the Prepared run-time kind abort names its site. Where the test262 Prepared entry records abort bodies,
// each abort site gets a program-wide id: the site calls `js.value.unsupported_at(id)`, whose helper stores the id in
// the exported global `__js_value_unsupported_site` and traps, and the record maps the id to the site's reason. The
// census reads the global, never the frame, so a copy of a site the middle end made (an inlined call, a clone) names
// the same reason. A build without the record keeps the nullary abort, byte for byte.
import { describe, expect, it } from "vitest";
import {
  compile,
  requiredPreparedAbortBodies,
  requiredPreparedAbortSites,
} from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { abortSiteOf, wasmErrorSite } from "../scripts/lib/wasm-exn-render.mjs";
import { INTRINSIC_SIGNATURE_VERSION } from "../src/ir/core/intrinsics.js";
import { asBlockId, asValueId, irUnitFuncRef, irVal, type IrFunction, type IrInstr } from "../src/ir/index.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { abortsAtRunTime, runnerOptions, yieldToRpc } from "./helpers/prepared-node-agreement.js";

const SLOW = 180_000;
const TRIM = "member read 'trim' of a string needs String.prototype's properties";
const STRING_DESCRIPTOR = "Object.getOwnPropertyDescriptor of a string: needs the String object's own properties";

/** `source` compiled through the strict Prepared entry and run to its trap: the site row the trap left, and its frames. */
async function trapSite(source: string) {
  await yieldToRpc();
  const result = await compile(source, runnerOptions());
  expect(result.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  const sites = requiredPreparedAbortSites(result)!;
  let instance: WebAssembly.Instance | undefined;
  try {
    instance = instantiatePreparedArtifact(result).instance;
    (instance.exports.__module_init as () => void)();
  } catch (error) {
    return { result, sites, row: abortSiteOf(instance, sites), frames: wasmErrorSite(error).frames };
  }
  throw new Error("expected the run-time abort");
}

describe("#7486 — a run-time abort names its site", () => {
  it(
    "the smallest program: the global names the string arm's site and its reason",
    async () => {
      const source = 'function g(v){ return v.trim(); } g({ trim: function(){ return 1; } }); g(" a ");';
      await abortsAtRunTime(source, runnerOptions(), TRIM);
      const { sites, row, frames } = await trapSite(source);
      expect(sites).toHaveLength(1);
      expect(row).toMatchObject({ site: 0, name: "g", detail: TRIM });
      expect(frames.slice(0, 2)).toEqual(["__js_value_unsupported_at", "g"]);
    },
    SLOW,
  );

  it(
    "an inlined copy: the trap's frame is the caller, the global still names the callee's site",
    async () => {
      const source = 'function d(){ return Object.getOwnPropertyDescriptor("ab", "length"); } var r = d();';
      await abortsAtRunTime(source, runnerOptions(), STRING_DESCRIPTOR);
      const { row, frames } = await trapSite(source);
      // `inlineSmall` moved d's single-block body into module-init.
      expect(frames.slice(0, 2)).toEqual(["__js_value_unsupported_at", "<module-init>"]);
      expect(row).toMatchObject({ site: 0, name: "d", detail: STRING_DESCRIPTOR });
    },
    SLOW,
  );

  it(
    "a retried unit: ids stay dense from 0, and the refused attempt leaves no row",
    async () => {
      // f is legalized (minting its site) before g's computed key refuses; g then gets the abort body and the unit is
      // lowered again, minting f's site anew.
      const source =
        'var f = function (v) { return v.trim(); }; var g = function (v, k) { return v[k]; }; var t = g; f(" a ");';
      const { result, sites, row } = await trapSite(source);
      expect(requiredPreparedAbortBodies(result)!.map((body) => body.name)).toEqual(["<module-init>__closure_1"]);
      expect(sites).toEqual([{ unit: sites[0]!.unit, name: "<module-init>__closure_0", site: 0, detail: TRIM }]);
      expect(row).toBe(sites[0]);
    },
    SLOW,
  );

  it(
    "two sites, the second taken: the module validates and the global reads the second id",
    async () => {
      // No answer is read: the second abort is straight-line code, kept as an effect with its id operand.
      const source = 'var f = function (v) { v.trim; Object.getOwnPropertyDescriptor("ab", "length"); }; f({});';
      const { result, sites, row } = await trapSite(source);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(sites.map((site) => site.detail)).toEqual([TRIM, STRING_DESCRIPTOR]);
      expect(row).toBe(sites[1]);
    },
    SLOW,
  );

  it(
    "without the record the abort stays nullary: no site global, no export",
    async () => {
      await yieldToRpc();
      const source = 'function g(v){ return v.trim(); } g({ trim: function(){ return 1; } }); g(" a ");';
      const plain = await compile(source, runnerOptions(), undefined, "refuse");
      const exports = WebAssembly.Module.exports(new WebAssembly.Module(plain.binary)).map((row) => row.name);
      expect(exports).not.toContain("__js_value_unsupported_site");
      expect(requiredPreparedAbortSites(plain)).toBeUndefined();
      const recorded = await compile(source, runnerOptions());
      expect(WebAssembly.Module.exports(new WebAssembly.Module(recorded.binary))).toContainEqual({
        name: "__js_value_unsupported_site",
        kind: "global",
      });
    },
    SLOW,
  );
});

describe("#7486 — a monomorphize clone keeps the site's id", () => {
  // No Prepared program reaches a clone (source lowering normalizes direct-call tuples first, #3520), so the pass is
  // run on a module whose callee is the abort site itself.
  const identities = createTestIrFunctionIdentityFactory("issue-7486");
  const F64 = irVal({ kind: "f64" });
  const EXTERNREF = irVal({ kind: "externref" });
  const I32 = irVal({ kind: "i32" });
  const block = (instrs: IrInstr[], values: number[]) => ({
    id: asBlockId(0),
    blockArgs: [],
    blockArgTypes: [],
    instrs,
    terminator: { kind: "return" as const, values: values.map(asValueId) },
  });
  const abortSite: IrInstr[] = [
    { kind: "const", value: { kind: "i32", value: 7 }, result: asValueId(1), resultType: I32 },
    {
      kind: "intrinsic",
      id: "js.value.unsupported_at",
      version: INTRINSIC_SIGNATURE_VERSION,
      args: [asValueId(1)],
      result: asValueId(2),
      resultType: { kind: "string" },
    },
  ];
  const site: IrFunction = {
    ...identities.next("site"),
    params: [{ value: asValueId(0), type: F64, name: "x" }],
    resultTypes: [F64],
    blocks: [block(abortSite, [0])],
    exported: false,
    valueCount: 3,
  };
  const caller = (name: string, type: typeof F64): IrFunction => ({
    ...identities.next(name),
    params: [{ value: asValueId(0), type, name: "n" }],
    resultTypes: [type],
    blocks: [
      block(
        [{ kind: "call", target: irUnitFuncRef(site), args: [asValueId(0)], result: asValueId(1), resultType: type }],
        [1],
      ),
    ],
    exported: true,
    valueCount: 2,
  });

  it("the clone carries the site's id operand into the same intrinsic", () => {
    const { module, cloneOrigins } = monomorphize({
      functions: [site, caller("num", F64), caller("extern", EXTERNREF)],
    });
    const [cloneUnit] = [...cloneOrigins.keys()];
    const clone = module.functions.find((fn) => fn.unitId === cloneUnit)!;
    expect(cloneOrigins.get(cloneUnit!)).toBe(site.unitId);
    expect(clone.blocks[0]!.instrs).toEqual(abortSite);
  });
});
