import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const setup = `
  const object = {};
  Object.defineProperty(object, "hidden", {value: -7, enumerable: false});
  if (mode !== 2) object[Symbol("first")] = -1;
  for (let i = n - 1; i >= 0; i--) {
    object["k" + i] = i + 10000;
    object[String(i)] = i;
  }
  if (n > 0) {
    delete object["k" + Math.floor(n / 2)];
    object["k" + Math.floor(n / 2)] = 777;
  }
  if (mode !== 2) object[Symbol("second")] = -2;
`;

describe("heap-sorted open-object key order", () => {
  it("matches exact native JS keys, values and entries across growth, deletion, descriptors and symbols", async () => {
    const result = await compile(
      `
      let output:any[] = [];
      export function run(n:number, mode:number):void {
        ${setup.replace("const object = {}", "const object:any = {}")}
        output = [];
        const keys = mode === 0 ? Object.keys(object) : mode === 1 ? Object.getOwnPropertyNames(object) :
          mode === 2 ? Reflect.ownKeys(object) : mode === 3 ? Object.values(object) : Object.entries(object);
        for (let i = 0; i < keys.length; i++) {
          const key:any = keys[i];
          output.push(mode === 4 ? key[0] + ":" + key[1] :
            typeof key === "symbol" ? "symbol:" + key.description : "" + key);
        }
      }
      export function length():number {return output.length;}
      export function width(i:number):number {return output[i].length;}
      export function unit(i:number,j:number):number {return output[i].charCodeAt(j);}
    `,
      { fileName: "heap-order.ts", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const sizes = [0, 1, 2, 3, 7, 32, 100, 257, 700];
    const cases = sizes.flatMap((n) => [0, 1, 2, 3, 4].map((mode) => ({ n, mode })));
    const actual = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          "-e",
          `
      const module = new WebAssembly.Module(require("node:fs").readFileSync(0));
      const e = new WebAssembly.Instance(module,{}).exports;
      const rows = ${JSON.stringify(cases)}.map(({n,mode})=>{
        e.run(n,mode); const keys=[];
        for(let i=0;i<e.length();i++){let key="";for(let j=0;j<e.width(i);j++)key+=String.fromCharCode(e.unit(i,j));keys.push(key);}
        return keys;
      });
      process.stdout.write(JSON.stringify({imports:WebAssembly.Module.imports(module),rows}));
    `,
        ],
        { input: result.binary, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      ),
    );
    expect(actual.imports).toEqual([]);
    expect(actual.rows).toHaveLength(45);
    // Symbol exclusion is covered in the string-only APIs. Reflect.ownKeys
    // uses a string-only fixture here; its symbol-merging path is separate
    // from the sorter under test and is not certified by this test.
    const reference = new Function("n", "mode", setup + "return object;");
    for (let index = 0; index < cases.length; index++) {
      const { n, mode } = cases[index]!;
      const object = reference(n, mode);
      const keys =
        mode === 0
          ? Object.keys(object)
          : mode === 1
            ? Object.getOwnPropertyNames(object)
            : mode === 2
              ? Reflect.ownKeys(object)
              : mode === 3
                ? Object.values(object)
                : Object.entries(object);
      const expected = keys.map((key: any) =>
        mode === 4 ? key[0] + ":" + key[1] : typeof key === "symbol" ? "symbol:" + key.description : "" + key,
      );
      expect(actual.rows[index], JSON.stringify({ n, mode })).toEqual(expected);
    }
  });
});
