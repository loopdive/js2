// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 N3) `export * as ns2 from './x.js'` — a NESTED module namespace.
//
// `namespaceFunctionExports` had an arm for every export form the
// `language/module-code/namespace/internals/*` corpus uses EXCEPT a
// `ts.NamespaceExport`. That one fell through to the terminal "mutable values
// require live-binding getters" decline, which rejects the WHOLE namespace
// object — so `get-nested-namespace-dflt-skip.js` and
// `get-nested-namespace-props-nrml.js` failed on the OUTER `ns` being
// undefined, never reaching the nested lookup they were written to test.
//
// On the reverted source both cases below answer 10 ("outer namespace declined,
// member read produced no object") on BOTH lanes; with the arm they answer 1.
import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/** The `dflt-skip` fixture shape: a nested namespace that carries a default. */
const NESTED_DEFAULT: Record<string, string> = {
  "./entry.js": `
import * as namedns1 from './named.js';
import * as productionns1 from './prod.js';
export function test() {
  if (!('namedOther' in namedns1.namedns2)) return 10;
  if (!('default' in namedns1.namedns2)) return 20;
  if (!('productionOther' in productionns1.productionns2)) return 30;
  if (!('default' in productionns1.productionns2)) return 40;
  return 1;
}
`,
  "./named.js": `export * as namedns2 from './named-end.js';`,
  "./named-end.js": `
var x;
export var namedOther = null;
export { x as default };
`,
  "./prod.js": `export * as productionns2 from './prod-end.js';`,
  "./prod-end.js": `
export var productionOther = null;
export default null;
`,
};

/**
 * Two levels of nesting plus the indirect re-export forms — the `props-nrml`
 * fixture minus its `export class`, which is a SEPARATE gap: a class binding
 * has no module-global cell (its constructor object lives in
 * `ctx.classObjectGlobals`), so that row still declines and is deliberately not
 * asserted here.
 */
const NESTED_DEEP: Record<string, string> = {
  "./entry.js": `
import * as ns from './f1.js';
export function test() {
  var e = ns.exportns;
  if (!('starAsVarDecl' in e)) return 10;
  if (!('starAsConstDecl' in e)) return 11;
  if (!('starAsFuncDecl' in e)) return 12;
  if (!('starAsGenDecl' in e)) return 13;
  if (!('starIdName' in e)) return 14;
  if (!('starAsIndirectIdName' in e)) return 15;
  if (!('namespaceBinding' in e)) return 16;
  if (!('starAsIndirectIdName' in e.namespaceBinding)) return 17;
  if ('notExportedVar' in e) return 30;
  return 1;
}
`,
  "./f1.js": `export * as exportns from './f2.js';`,
  "./f2.js": `
var notExportedVar;
var starAsBindingId;
export var starAsVarDecl;
export const starAsConstDecl = null;
export function starAsFuncDecl() {}
export function* starAsGenDecl() {}
export { starAsBindingId as starIdName };
export { starAsIndirectIdName } from './f3.js';
export * as namespaceBinding from './f3.js';
`,
  "./f3.js": `
export var indirectIdName;
export var starAsIndirectIdName;
`,
};

const LANES: [string, Record<string, unknown>][] = [
  ["host", {}],
  ["standalone", { target: "standalone", hostBridge: "off" }],
];

async function run(files: Record<string, string>, options: Record<string, unknown>): Promise<number> {
  const result = (await compileMulti(files, "./entry.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...options,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; binary: Uint8Array };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const imports = (result as unknown as { importObject?: Record<string, unknown> }).importObject ?? {};
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports.test as () => number)();
}

describe("#6651 N3 nested module namespace (`export * as ns from …`)", () => {
  for (const [lane, options] of LANES) {
    it(`materializes a nested namespace that carries a default export (${lane})`, async () => {
      expect(await run(NESTED_DEFAULT, options)).toBe(1);
    });

    it(`materializes two levels of nesting with indirect re-exports (${lane})`, async () => {
      expect(await run(NESTED_DEEP, options)).toBe(1);
    });
  }
});
