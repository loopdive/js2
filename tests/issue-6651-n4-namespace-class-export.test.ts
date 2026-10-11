// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 N4) `export class C {}` inside a module whose namespace is taken.
//
// N3 gave `moduleSymbolNamespaceExports` an arm for every export form the
// `language/module-code/namespace/internals/*` corpus uses EXCEPT a class
// DECLARATION. A class binding has no module-global cell — `ctx.moduleGlobals`
// does not hold it and its constructor object lives behind the
// `__class_<Name>` singleton in `ctx.classObjectGlobals` — so the declaration
// fell through to the terminal "mutable values require live-binding getters"
// decline, which rejects the WHOLE namespace object.
//
// On the reverted source every case below answers its first sentinel (the
// namespace itself is undefined, so the very first member read produces no
// object) on BOTH lanes; with the arm they answer 1.
//
// The class slot is filled by CALLING a getter minted during the reservation
// phase, never by inlining `emitLazyClassObjectGet`: that helper interns
// string-constant globals and flushes late imports mid-build, which the
// namespace emitter's single-batch index discipline forbids. The IDENTITY case
// below is what would catch a mis-resolved index — a stale `global.get` reads a
// neighbouring singleton, so the namespace slot and the direct import would no
// longer be the same object.
import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/** The minimal shape: one exported class, read through the namespace. */
const DIRECT_CLASS: Record<string, string> = {
  "./entry.js": `
import * as ns from './m.js';
export function test() {
  if (!('C' in ns)) return 10;
  if (!('other' in ns)) return 11;
  if ('NotExported' in ns) return 12;
  return 1;
}
`,
  "./m.js": `
class NotExported {}
export class C { m() { return 7; } }
export var other = null;
`,
};

/**
 * The same class reached BOTH through the namespace and through a direct named
 * import. `__class_<Name>` is one singleton per class, so the two reads must be
 * the same object; a stale baked global index would make them differ.
 */
const CLASS_IDENTITY: Record<string, string> = {
  "./entry.js": `
import * as ns from './m.js';
import { C } from './m.js';
export function test() {
  if (!('C' in ns)) return 10;
  if (ns.C !== C) return 20;
  return 1;
}
`,
  "./m.js": `export class C {}`,
};

/**
 * The `get-nested-namespace-props-nrml` fixture shape in full — the class line
 * N3 deliberately left out, alongside every form it already covered, two levels
 * deep and behind a re-exported namespace.
 */
const NESTED_WITH_CLASS: Record<string, string> = {
  "./entry.js": `
import * as ns from './f1.js';
export function test() {
  var e = ns.exportns;
  if (!('starAsVarDecl' in e)) return 10;
  if (!('starAsLetDecl' in e)) return 11;
  if (!('starAsConstDecl' in e)) return 12;
  if (!('starAsFuncDecl' in e)) return 13;
  if (!('starAsGenDecl' in e)) return 14;
  if (!('starAsClassDecl' in e)) return 15;
  if (!('starAsBindingId' in e)) return 16;
  if (!('starIdName' in e)) return 17;
  if (!('starAsIndirectIdName' in e)) return 18;
  if (!('namespaceBinding' in e)) return 19;
  if ('notExportedVar' in e) return 30;
  if ('notExportedClass' in e) return 31;
  return 1;
}
`,
  "./f1.js": `export * as exportns from './f2.js';`,
  "./f2.js": `
var notExportedVar;
class notExportedClass {}
var starAsBindingId;
export var starAsVarDecl;
export let starAsLetDecl;
export const starAsConstDecl = null;
export function starAsFuncDecl() {}
export function* starAsGenDecl() {}
export class starAsClassDecl {}
export { starAsBindingId };
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

describe("#6651 N4 module namespace carries an exported class declaration", () => {
  for (const [lane, options] of LANES) {
    it(`publishes an exported class as a namespace property (${lane})`, async () => {
      expect(await run(DIRECT_CLASS, options)).toBe(1);
    });

    it(`the namespace slot and a direct import are one class object (${lane})`, async () => {
      expect(await run(CLASS_IDENTITY, options)).toBe(1);
    });

    it(`materializes a re-exported namespace containing a class (${lane})`, async () => {
      expect(await run(NESTED_WITH_CLASS, options)).toBe(1);
    });
  }
});
