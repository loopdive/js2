// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (#6972 lead review) — the `__ir_arr_borrow_<m>_<n>` wrapper opens with
// §23.1.3's `ToObject(this value)` TypeError. Its template receiver is a
// parameter, so legacy's call-site refusal of a literal `null`/`undefined`
// receiver never applied, and the array-like search loop answered `-1`/`false`
// from a nullish receiver: `Array.prototype.indexOf.call(undefined)` returned
// normally once #6977 planned the harness `assert.throws` callback
// (`indexOf/15.4.4.14-1-1.js`, `lastIndexOf/15.4.4.15-1-1.js` flipped
// pass → fail). Every method the wrapper admits is checked with an `undefined`
// and a `null` receiver, from a claimed `<module-init>`, against node.
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

/** Every `Array.prototype` method `arrayPrototypeBorrowCompilesHostFree` admits. */
const ADMITTED = [
  "at",
  "concat",
  "copyWithin",
  "fill",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "lastIndexOf",
  "pop",
  "reverse",
  "shift",
  "unshift",
  "slice",
  "sort",
  "splice",
  "includes",
  "indexOf",
  "join",
  "keys",
  "entries",
  "values",
  "forEach",
  "filter",
  "flat",
  "flatMap",
  "map",
  "every",
  "some",
  "reduce",
  "reduceRight",
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
  "toLocaleString",
  "toString",
] as const;

/** Legacy's own dynamic-receiver gap (answers instead of throwing), predating the wrapper. */
const LEGACY_ANSWERS_NULLISH = new Set<string>(["concat", "indexOf", "lastIndexOf", "includes"]);

/** `run()` sets bit 1 when the `undefined` receiver throws a TypeError, bit 2 for `null`. */
function program(method: string): string {
  return `/** @returns {number} */ function subject() { return 0; }
subject.f = function (r, k) { if (k === 9) return; Array.prototype.${method}.call(r); throw "returned"; };
export function run() {
  var n = 0;
  try { subject.f(undefined, 0); } catch (e) { if (e instanceof TypeError) n += 1; }
  try { subject.f(null, 0); } catch (e) { if (e instanceof TypeError) n += 2; }
  return n;
}`;
}

async function build(source: string, experimentalIR: boolean): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...(experimentalIR ? {} : { experimentalIR: false }),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<number> {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

describe("#7106 — the Array.prototype borrow wrapper throws on a nullish receiver", () => {
  it.each(ADMITTED)(
    "%s.call(undefined | null) throws a TypeError",
    async (method) => {
      const source = program(method);
      expect(vm.runInNewContext(`${source.replace("export function", "function")}\nrun();`)).toBe(3);
      const ir = await build(source, true);
      const init = (ir.irOutcomes ?? []).find((entry) => entry.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
      expect(await run(ir)).toBe(3);
      if (!LEGACY_ANSWERS_NULLISH.has(method)) expect(await run(await build(source, false))).toBe(3);
    },
    60_000,
  );
});
