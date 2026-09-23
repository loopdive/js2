// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster G, slice G3 — two cross-cluster defects G2 recorded.
 *
 * 1. An array ASSIGNMENT pattern whose source is a non-tuple WasmGC struct
 *    (an object literal carrying `[Symbol.iterator]`) read the struct's FIELDS
 *    as elements instead of calling GetIterator (§13.15.5.2), top-level and
 *    nested. On the host lane the lenient `__array_from_iter_n` also could not
 *    see a compiled `@@iterator` method, so the struct route takes the strict
 *    GetIterator twin there.
 * 2. A mixed-kind array literal (`[0, 'a']`, an `$AnyValue`-element array on
 *    standalone) handed the element BOX to the externref plane on an unproven
 *    read; a `string | number` binding then wrapped it again as tag 5, so
 *    `typeof w` answered "string" for the number 0.
 *
 * Every case below is RED on the branch base (file-copy A/B of the edited
 * files), except the pure-numeric guard, which is green on both sides.
 *
 * The program runs at MODULE scope (where the defects live) and builds a
 * string `r`; `test()` answers 1 when `r` is the expected text. A standalone
 * string cannot cross to JS, so on a mismatch reproduce with a probe.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function check(program: string, expected: string, standalone: boolean): Promise<number> {
  const source = `${program}\nexport function test() { return r === ${JSON.stringify(expected)} ? 1 : 0; }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: standalone ? "issue-6651-g3.js" : "issue-6651-g3-host.js",
    ...(standalone ? { target: "standalone" as const } : {}),
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  let exports: Record<string, () => number>;
  if (standalone) {
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).map((e) => `${e.module}::${e.name}`)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    exports = instance.exports as Record<string, () => number>;
  } else {
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (v: WebAssembly.Instance) => void }).__setInstance?.(instance);
    exports = instance.exports as Record<string, () => number>;
  }
  exports.__module_init?.();
  return exports.test!();
}

const ITERABLE = `
var log = [];
var it = {
  [Symbol.iterator]() {
    log.push("iter");
    var i = 0;
    return { next() { i++; log.push("next"); return { value: i * 10, done: i > 2 }; } };
  }
};
`;

describe("#6651 G3 — an object iterable on the right of an array assignment pattern", () => {
  for (const standalone of [true, false]) {
    const lane = standalone ? "standalone" : "host";

    it(`iterates it instead of reading its fields (${lane})`, async () => {
      const program = `${ITERABLE}
        var a, b;
        [a, b] = it;
        var r = a + "|" + b + "|" + log.join(",");`;
      expect(await check(program, "10|20|iter,next,next", standalone)).toBe(1);
    });

    it(`iterates it as a nested pattern's source (${lane})`, async () => {
      const program = `${ITERABLE}
        var holder = [it];
        var a, b;
        [[a, b]] = holder;
        var c, d;
        var src = { p: it };
        ({ p: [c, d] } = src);
        var r = a + "|" + b + "|" + c + "|" + d;`;
      expect(await check(program, "10|20|10|20", standalone)).toBe(1);
    });
  }
});

describe("#6651 G3 — a mixed-kind array literal keeps each element's kind (standalone)", () => {
  it("a number element read into a union-typed binding stays a number", async () => {
    const program = `var array = [0, 'a', true, null, undefined];
      var w = array[0];
      var s = array[1];
      var r = [typeof w, w === 0, 1 / w, typeof s, s, typeof array[2], array[3] === null, typeof array[4], typeof array[9]].join(",");`;
    expect(await check(program, "number,true,Infinity,string,a,boolean,true,undefined,undefined", true)).toBe(1);
  });

  it("for-of over the literal and an index read agree element by element", async () => {
    const program = `var array = [0, 'a', true, false, null, , undefined, NaN];
      var i = 0, bad = -1;
      for (var value of array) {
        var e = array[i];
        if (!(value === e || (value !== value && e !== e)) && bad < 0) bad = i;
        i++;
      }
      var r = i + ":" + bad;`;
    expect(await check(program, "8:-1", true)).toBe(1);
  });

  it("guard: a pure-numeric literal is untouched", async () => {
    const program = `var array = [0, 1, 2];
      var w = array[0];
      var r = typeof w + "," + (w === 0) + "," + (array[1] + array[2]);`;
    expect(await check(program, "number,true,3", true)).toBe(1);
  });
});
