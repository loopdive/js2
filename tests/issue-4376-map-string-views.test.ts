import { beforeAll, expect, it } from "vitest";
import { compile } from "../src/index.js";

let e: Record<string, (n: number) => number>;
beforeAll(async () => {
  const result = await compile(
    `
function build(n:number):string {
  let text="";
  for(let i=0;i<n;i++) text+=String.fromCharCode(97+i);
  return text;
}
export function builtKey(n:number):number {
  const m=new Map<string,number>();m.set(build(n),7);
  return m.get(n===0?"":"ab") ?? -1;
}
export function literalKey(n:number):number {
  const m=new Map<string,number>();m.set(n===0?"":"ab",9);
  return m.get(build(n)) ?? -1;
}
export function slicedKey(n:number):number {
  const m=new Map<string,number>();m.set("xabz".slice(n,n+2),11);
  return m.get("ab") ?? -1;
}
export function setMember(n:number):number {
  const s=new Set<string>();s.add(build(n));return s.has("ab")?1:0;
}
export function replaceKey(n:number):number {
  const m=new Map<string,number>();m.set(build(n),1);m.set("ab",2);
  return m.size*10+(m.get(build(n))??0);
}
`,
    { target: "standalone", platform: "deno", hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  e = instance.exports as typeof e;
});
for (const [name, n, value] of [
  ["builtKey", 0, 7],
  ["builtKey", 2, 7],
  ["literalKey", 0, 9],
  ["literalKey", 2, 9],
  ["slicedKey", 1, 11],
  ["setMember", 2, 1],
  ["replaceKey", 2, 12],
] as const) {
  it(`${name}(${n}) hashes logical string contents`, () => expect(e[name](n)).toBe(value));
}
