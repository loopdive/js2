// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6835 Slice A: only the borrowed find miss producer changes. Host dependency,
// inherited TypedArray length, plain Array carrier and detached-entry residuals
// remain separately tracked; these controls must not repair their shared paths.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { undefinedExternInstrs } from "../src/codegen/any-helpers.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

const dynamic = (body: string) => `function run(TA) { ${body} } export function probe() { return run(Float64Array); }`;
const ordinary = (body: string) => `export function probe() { ${body} }`;
const OWN_GETTER = dynamic(`
  const a = new TA([1, 2, 3]);
  let hits = 0, calls = 0;
  Object.defineProperty(a, "length", {
    configurable: true, get: function () { hits++; return 1; }
  });
  const result = Array.prototype.find.call(a, function (value) {
    calls++; return value === 3;
  });
  return hits * 100 + calls * 10 + (result === undefined ? 1 : 0);
`);

async function run(source: string, undefinedSingleton: boolean, emitWat = false) {
  const result = await compile(source, {
    fileName: "issue-6835-borrowed-find-miss.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    undefinedSingleton,
    emitWat,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports, "declared standalone imports").toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "actual standalone imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return { value: (instance.exports.probe as () => unknown)(), wat: result.wat };
}

const CASES: readonly [string, string, unknown][] = [
  ["own getter and one callback retain the original miss reproduction", OWN_GETTER, 111],
  [
    "empty and nonempty misses return the lane's undefined",
    dynamic(`
      const a = new TA([]), b = new TA([1, 2, 3]);
      let calls = 0;
      const empty = Array.prototype.find.call(a, function () { calls++; return true; });
      const missing = Array.prototype.find.call(b, function () { calls++; return false; });
      return calls === 3 && empty === undefined && missing === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "ordinary array-like getter miss preserves length and callback effects",
    ordinary(`
      const a = { 0: 7, 1: 9 };
      let gets = 0, calls = 0;
      Object.defineProperty(a, "length", { get: function () { gets++; return 2; } });
      const result = Array.prototype.find.call(a, function () { calls++; return false; });
      return gets === 1 && calls === 2 && result === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "ordinary absent index is visited in order with undefined and receiver identity",
    ordinary(`
      const a = { 0: 7 }; let gets = 0, calls = 0, order = 0, valid = 1;
      Object.defineProperty(a, "length", { get: function () { gets++; return 2; } });
      const result = Array.prototype.find.call(a, function (value, index, receiver) {
        calls++; order = order * 10 + index;
        if (receiver !== a || (index === 0 ? value !== 7 : value !== undefined)) valid = 0;
        return false;
      });
      return gets === 1 && calls === 2 && order === 1 && valid === 1 &&
        !(1 in a) && result === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "ordinary absent index can successfully match undefined",
    ordinary(`
      const a = { 0: 7 }; let calls = 0, order = 0, valid = 1;
      Object.defineProperty(a, "length", { get: function () { return 2; } });
      const result = Array.prototype.find.call(a, function (value, index, receiver) {
        calls++; order = order * 10 + index;
        if (receiver !== a || (index === 0 ? value !== 7 : value !== undefined)) valid = 0;
        return index === 1 && value === undefined;
      });
      return calls === 2 && order === 1 && valid === 1 && !(1 in a) &&
        result === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "borrowed findIndex successfully visits the ordinary absent index",
    ordinary(`
      const a = { 0: 7 }; let calls = 0, order = 0, valid = 1;
      Object.defineProperty(a, "length", { get: function () { return 2; } });
      const result = Array.prototype.findIndex.call(a, function (value, index, receiver) {
        calls++; order = order * 10 + index;
        if (receiver !== a || (index === 0 ? value !== 7 : value !== undefined)) valid = 0;
        return index === 1 && value === undefined;
      });
      return calls === 2 && order === 1 && valid === 1 && !(1 in a) && result === 1 ? 1 : 0;
    `),
    1,
  ],
  [
    "class array-like empty receiver does not invoke its predicate",
    `class Receiver { constructor() { this.length = 0; } }
     function run(Ctor) {
       const a = new Ctor(); let calls = 0;
       const result = Array.prototype.find.call(a, function () { calls++; return true; });
       return calls === 0 && result === undefined ? 1 : 0;
     } export function probe() { return run(Receiver); }`,
    1,
  ],
  [
    "successful null is the actual null value",
    ordinary(`
      const a = { length: 1, 0: null };
      return Array.prototype.find.call(a, function () { return true; });
    `),
    null,
  ],
  [
    "successful explicit undefined retains its value",
    ordinary(`
      const a = { length: 1, 0: undefined }; let calls = 0;
      const result = Array.prototype.find.call(a, function (value) {
        calls++; return value === undefined;
      });
      return calls === 1 && result === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "successful legitimate NaN is not a miss",
    ordinary(`
      const a = { length: 1, 0: NaN }; let calls = 0;
      const result = Array.prototype.find.call(a, function (value) { calls++; return value !== value; });
      return calls === 1 && typeof result === "number" && result !== result ? 1 : 0;
    `),
    1,
  ],
  [
    "successful finite value and first match are unchanged",
    dynamic(`
      const a = new TA([5, 7, 9]); let calls = 0;
      const result = Array.prototype.find.call(a, function (value) { calls++; return value > 5; });
      return calls === 2 && result === 7 ? 1 : 0;
    `),
    1,
  ],
  [
    "successful object retains identity",
    ordinary(`
      const marker = { token: 7 }, a = { length: 1, 0: marker };
      const result = Array.prototype.find.call(a, function (value) { return value === marker; });
      return result === marker ? 1 : 0;
    `),
    1,
  ],
  [
    "callback value, index, receiver and thisArg remain intact",
    dynamic(`
      const a = new TA([5, 7, 9]), context = { token: 11 };
      let calls = 0, order = 0, valid = 1;
      const result = Array.prototype.find.call(a, function (value, index, receiver) {
        calls++; order = order * 10 + index;
        if (value !== index * 2 + 5 || receiver !== a || this !== context) valid = 0;
        return index === 1;
      }, context);
      return calls === 2 && order === 1 && valid === 1 && result === 7 ? 1 : 0;
    `),
    1,
  ],
  [
    "length snapshot and live mutation return the visited value",
    dynamic(`
      const a = new TA([1, 2, 3]); let calls = 0;
      const result = Array.prototype.find.call(a, function (value, index) {
        calls++;
        if (index === 0) a[1] = 7;
        if (index === 1) { a[1] = 9; return value === 7; }
        return false;
      });
      return calls === 2 && a[1] === 9 && result === 7 ? 1 : 0;
    `),
    1,
  ],
  [
    "predicate abrupt completion is preserved",
    dynamic(`
      const a = new TA([1, 2, 3]); let calls = 0;
      try { Array.prototype.find.call(a, function () { calls++; throw 71; }); }
      catch (error) { return error === 71 && calls === 1 ? 1 : 0; }
      return 0;
    `),
    1,
  ],
  [
    "throwing length getter precedes any predicate",
    dynamic(`
      const a = new TA([1, 2, 3]); let calls = 0, gets = 0;
      Object.defineProperty(a, "length", { get: function () { gets++; throw 72; } });
      try { Array.prototype.find.call(a, function () { calls++; return false; }); }
      catch (error) { return error === 72 && gets === 1 && calls === 0 ? 1 : 0; }
      return 0;
    `),
    1,
  ],
  [
    "later abrupt argument is evaluated before reading length",
    dynamic(`
      const a = new TA([1, 2, 3]); let gets = 0, extra = 0, calls = 0;
      Object.defineProperty(a, "length", { get: function () { gets++; return 1; } });
      function abrupt() { extra++; throw 73; }
      try { Array.prototype.find.call(a, function () { calls++; return false; }, {}, abrupt()); }
      catch (error) { return error === 73 && gets === 0 && calls === 0 && extra === 1 ? 1 : 0; }
      return 0;
    `),
    1,
  ],
  [
    "first-class borrowed find remains a positive control",
    dynamic(`
      const a = new TA([1, 2, 3]); let calls = 0;
      const fn = Array.prototype.find;
      const result = fn.call(a, function () { calls++; return false; });
      return calls === 3 && result === undefined ? 1 : 0;
    `),
    1,
  ],
  [
    "borrowed findIndex miss remains minus one",
    dynamic(`
      const a = new TA([1, 2, 3]); let gets = 0, calls = 0;
      Object.defineProperty(a, "length", { get: function () { gets++; return 1; } });
      const result = Array.prototype.findIndex.call(a, function (value) { calls++; return value === 3; });
      return gets === 1 && calls === 1 && result === -1 ? 1 : 0;
    `),
    1,
  ],
  ["typeof undefined positive control", ordinary(`return typeof undefined === "undefined" ? 1 : 0;`), 1],
  ["undefined/null positive control", ordinary(`return undefined === null ? 1 : 0;`), 0],
  [
    "unpassed argument positive control",
    `function run(value) { return value === undefined ? 1 : 0; } export function probe() { return run(); }`,
    1,
  ],
];

describe("#6835 standalone borrowed find miss respects the undefined regime", () => {
  for (const undefinedSingleton of [true, false]) {
    describe(`undefinedSingleton=${undefinedSingleton}`, () => {
      it.each(CASES)("%s", async (_name, source, expected) => {
        expect((await run(source, undefinedSingleton)).value).toBe(expected);
      });

      it("normal emitted initializer follows the regime without changing the success store", async () => {
        const { value, wat } = await run(OWN_GETTER, undefinedSingleton, true);
        expect(value).toBe(111);
        const header = /^ {2}\(func \$run \(type (\d+)\)\n/m.exec(wat);
        expect(header, "normal WAT must contain the run function").not.toBeNull();
        const start = header!.index;
        const nextFunction = /^ {2}\(func /gm;
        nextFunction.lastIndex = start + header![0].length;
        const end = nextFunction.exec(wat)?.index;
        expect(end, "run must have a following top-level function boundary").toBeDefined();
        expect(end!).toBeGreaterThan(start);
        const body = wat.slice(start, end);
        const types = wat.match(/^ {2}\(type .*$/gm)!;
        expect(types[Number(header![1])], "run(TA) has exactly one externref parameter").toBe(
          "  (type $run_type (func (param externref) (result f64)))",
        );
        const match = body.match(/\(local \$__ali_fd_res_(\d+) externref\)/);
        expect(match, "borrowed inline find must be exercised").not.toBeNull();
        const resultIndex = Number(match![1]) + 1; // one run(TA) parameter
        expect(body).toMatch(
          undefinedSingleton
            ? new RegExp(`global.get \\d+\\s+extern.convert_any\\s+local.set ${resultIndex}\\b`)
            : new RegExp(`ref.null extern\\s+local.set ${resultIndex}\\b`),
        );
        expect(body).toMatch(new RegExp(`local.get \\d+\\s+local.set ${resultIndex}\\s+br 2`));
      });
    });
  }

  for (const standalone of [false, true]) {
    for (const nativeStrings of [false, true]) {
      for (const undefinedSingleton of [false, true]) {
        it(`helper predicate standalone=${standalone}/nativeStrings=${nativeStrings}/flag=${undefinedSingleton}`, () => {
          const ctx = { standalone, nativeStrings, undefinedSingleton, undefinedGlobalIdx: 7 } as CodegenContext;
          expect(undefinedExternInstrs(ctx)).toEqual(
            undefinedSingleton && (standalone || nativeStrings)
              ? [{ op: "global.get", index: 7 }, { op: "extern.convert_any" }]
              : undefined,
          );
          expect(ctx.undefinedGlobalIdx).toBe(7);
        });
      }
    }
  }
});
