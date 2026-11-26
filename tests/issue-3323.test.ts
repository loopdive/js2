import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// (#3323) for-in over an ARRAY receiver must enumerate the own enumerable
// non-index STRING keys (added via `arr.k = v` / `Object.defineProperty`) in
// addition to the integer indices. The native array for-in path previously
// emitted only "0".."length-1" and dropped every string key, so a
// `defineProperty(arr,"a",{get,enumerable})` produced `[]` instead of `["a"]`
// (test262 language/statements/for-in/order-after-define-property.js assert #2).
async function forInKeys(body: string): Promise<string> {
  const src = `${body}
var __s = "";
for (var __k in arr) { __s = __s + __k + ","; }
export function test() { return __s; }`;
  const r: any = await compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports as any).test() as string;
}

describe("#3323 for-in over array: own enumerable string keys", () => {
  it("accessor defined then redefined keeps insertion order, no duplicate", async () => {
    // The order-after-define-property.js scenario: accessor "a", data "b",
    // redefine "a" (must NOT re-create / reorder) → ["a", "b"].
    const keys = await forInKeys(`
var arr = [];
Object.defineProperty(arr, "a", { get: function () { return 1; }, enumerable: true, configurable: true });
arr.b = 2;
Object.defineProperty(arr, "a", { get: function () { return 1; } });`);
    expect(keys).toBe("a,b,");
  });

  it("integer indices come before string keys", async () => {
    const keys = await forInKeys(`
var arr = [10, 20];
arr.x = 5;`);
    expect(keys).toBe("0,1,x,");
  });

  it("plain array with only integer indices is unaffected", async () => {
    const keys = await forInKeys(`var arr = [10, 20, 30];`);
    expect(keys).toBe("0,1,2,");
  });

  it("empty array with no keys yields nothing", async () => {
    const keys = await forInKeys(`var arr = [];`);
    expect(keys).toBe("");
  });

  it("non-enumerable defined key is skipped, enumerable data key kept", async () => {
    const keys = await forInKeys(`
var arr = [];
Object.defineProperty(arr, "hidden", { value: 1, enumerable: false });
arr.shown = 2;`);
    expect(keys).toBe("shown,");
  });

  it("a deleted string key is not enumerated", async () => {
    const keys = await forInKeys(`
var arr = [1, 2];
arr.p = 9;
delete arr.p;`);
    expect(keys).toBe("0,1,");
  });
});
