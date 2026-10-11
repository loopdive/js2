// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6713 — calling or constructing the `RegExp` / Error-family constructor
 * carriers when they are held in a VARIABLE (`--target standalone`, no
 * runtime-eval provider, zero imports).
 *
 * lodash's `runInContext` aliases them off the realm object
 * (`var RegExp = context.RegExp; RegExp(src)`); before the fix the call went
 * through `__apply_closure`, which had no carrier arm and answered undefined,
 * so lodash threw "Cannot read properties of undefined (reading 'test')" at
 * module init. `new` through the alias built null, and the TYPED alias
 * spelling (`var R = globalThis.RegExp`) trapped uncatchably.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName: "ctor-value.js",
    emitWat: false,
    runtimeEvalProvider: false,
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  return (instance.exports.run as () => number)();
}

/** lodash's shape: the constructors reach `runInContext` through an untyped parameter. */
const UNTYPED_CONTEXT_ALIASES = `
var out = 0;
function runInContext(context) {
  var RegExp = context.RegExp, Error = context.Error, TypeError = context.TypeError;
  try { var r = RegExp('^a+$'); if (r.test('aa') && !r.test('ab')) out += 1; } catch (e) { out += 1000; }
  try { var r2 = new RegExp('^b+$', 'i'); if (r2.test('BB') && r2.flags === 'i') out += 2; } catch (e) { out += 2000; }
  try { var e1 = new Error('x'); if (e1.message === 'x') out += 4; } catch (e) { out += 4000; }
  try { var e2 = new TypeError('y'); if (e2.message === 'y' && e2.name === 'TypeError' && String(e2) === 'TypeError: y') out += 8; } catch (e) { out += 8000; }
  try { var e3 = Error('z'); if (e3.message === 'z') out += 16; } catch (e) { out += 16000; }
  try { throw new TypeError('w'); } catch (e) { if (e.message === 'w') out += 32; }
  // §22.2.4.1 steps 4/8: a RegExp pattern copies its source; explicit flags win.
  try { var re = /q/g; var c = new RegExp(re, 'i'); if (c !== re && c.source === 'q' && c.flags === 'i') out += 64; } catch (e) { out += 64000; }
}
runInContext(globalThis);
export function run() { return out; }
`;

/** The reduction's typed spelling: the alias carries the lib constructor interface. */
const TYPED_GLOBAL_ALIASES = `
var out = 0;
var R = globalThis.RegExp;
var E = globalThis.Error;
var T = globalThis.TypeError;
try { if (R('^a+$').test('aa')) out += 1; } catch (e) { out += 1000; }
try { if (new R('^a+$').test('aa')) out += 2; } catch (e) { out += 2000; }
try { var x = R('^a+$'); if (x instanceof RegExp) out += 4; } catch (e) { out += 4000; }
try { if (R === RegExp) out += 8; } catch (e) {}
try { var e1 = new E('m'); if (e1 instanceof Error && e1.message === 'm') out += 16; } catch (e) { out += 16000; }
try { var e2 = new T('n'); if (e2 instanceof TypeError && e2.message === 'n') out += 32; } catch (e) { out += 32000; }
export function run() { return out; }
`;

describe("#6713 builtin constructor carriers invoked through a variable (standalone)", () => {
  it("untyped realm aliases (lodash runInContext): RegExp / Error / TypeError call and construct", async () => {
    expect(await runStandalone(UNTYPED_CONTEXT_ALIASES)).toBe(127);
  });

  it("typed globalThis aliases: RegExp / Error / TypeError call and construct", async () => {
    expect(await runStandalone(TYPED_GLOBAL_ALIASES)).toBe(63);
  });
});
