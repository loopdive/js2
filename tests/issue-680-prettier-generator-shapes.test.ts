// (#680) Generator shapes prettier's standalone bundle uses, lowered by the
// Wasm-native state machine in the standalone target (no host imports):
//   - a yield in an `&&` / `||` / `?:` / comma operand of an expression statement;
//   - `for (x of <array | string | any>)` with a yield in the body;
//   - `if` / `while` conditions that are not numeric (object / string / any);
//   - locals bound by a destructuring declaration, read after a suspension.
// Before this slice every generator below was refused with "native generator
// lowering currently supports only sequential numeric yields" (the destructuring
// case compiled but read the frame's inert default after the yield).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, fileName = "issue-680-prettier.ts"): Promise<unknown> {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    allowJs: fileName.endsWith(".js"),
    skipSemanticDiagnostics: true,
  });
  const errors = result.errors.filter((e) => e.severity === "error");
  if (!result.success || errors.length > 0) {
    throw new Error(`Compile failed:\n${errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  const exports = instance.exports as Record<string, Function>;
  exports.__module_init?.();
  return exports.test!();
}

describe("#680 native generators — prettier standalone shapes", () => {
  it("prettier's child-node walker: destructuring default, closure, nested for-of over any, `&&`-guarded yields", async () => {
    const value = await runStandalone(
      `function ge(n){return n!==null&&typeof n==="object"}
function*be(e,t){let{getVisitorKeys:u,filter:r=()=>!0}=t,o=n=>ge(n)&&r(n);for(let n of u(e)){let a=e[n];if(Array.isArray(a))for(let s of a)o(s)&&(yield s);else o(a)&&(yield a)}}
export function test(){
  const tree={type:"A",kids:[{type:"B"},{type:"C"}],x:{type:"D"},n:1};
  let c=0; for(const n of be(tree,{getVisitorKeys:(e)=>["kids","x","n"]})) c+=n.type.charCodeAt(0);
  return c;
}`,
      "prettier-be.js",
    );
    expect(value).toBe(66 + 67 + 68);
  });

  it("prettier's breadth-first walker: for over a growing any[], for-of over a generator, comma-sequenced yield", async () => {
    const value = await runStandalone(
      `function ge(n){return n!==null&&typeof n==="object"}
function*be(e,t){let{getVisitorKeys:u}=t;for(let n of u(e)){let a=e[n];if(Array.isArray(a))for(let s of a)ge(s)&&(yield s);else ge(a)&&(yield a)}}
function*Cr(e,t){let u=[e];for(let r=0;r<u.length;r++){let o=u[r];for(let n of be(o,t))yield n,u.push(n)}}
export function test(){
  const tree={type:"A",kids:[{type:"B",kids:[{type:"E"}]},{type:"C"}]};
  let s=""; for(const n of Cr(tree,{getVisitorKeys:()=>["kids"]})) s+=n.type;
  return s==="BCE"?1:0;
}`,
      "prettier-cr.js",
    );
    expect(value).toBe(1);
  });

  it("prettier's parser-name enumerator: any-typed if, closure over the loop binding, object yield", async () => {
    const value = await runStandalone(
      `function*Ko(e,t,u){let r=new Set(e.map(o=>o.value));for(let o of t)if(o.parsers){for(let n of o.parsers)if(!r.has(n)){r.add(n);let a=u.find(i=>i.parsers&&Object.prototype.hasOwnProperty.call(i.parsers,n)),s=o.name;a?.name&&(s+=\` (plugin: \${a.name})\`),yield{value:n,description:s}}}}
export function test(){
  let d=""; for(const x of Ko([{value:"a"}],[{name:"L",parsers:["a","b","c"]},{name:"M"}],[{name:"P",parsers:{c:1}}])) d+=x.value+"="+x.description+";";
  return d==="b=L;c=L (plugin: P);"?1:0;
}`,
      "prettier-ko.js",
    );
    expect(value).toBe(1);
  });

  it("for-of over arrays and strings, non-numeric conditions, `?:` / `||` statement yields", async () => {
    const value = await runStandalone(`
function* nums(): Generator<number> { for (const x of [1, 2, 3]) yield x * 2; }
function* chars(s: string) { for (const ch of s) yield ch; }
function* cond(o: any) { if (o) { yield "yes"; } else { yield "no"; } }
function* tern(f: boolean, a: any) { f ? yield a : yield "other"; yield "end"; }
function* orYield(a: any) { a || (yield "fallback"); yield "end"; }
function* whileAny(xs: any) { let i = 0; while (xs[i]) { yield xs[i]; i++; } }
function join(g: any): string { let s = ""; for (const v of g) s += v + ","; return s; }
export function test(): number {
  let r = 0;
  for (const v of nums()) r += v;
  if (join(chars("xyz")) === "x,y,z,") r += 100;
  if (cond({}).next().value === "yes" && cond("").next().value === "no") r += 1000;
  if (join(tern(true, "A")) + join(tern(false, "A")) === "A,end,other,end,") r += 10000;
  if (join(orYield(0)) + join(orYield(1)) === "fallback,end,end,") r += 100000;
  if (join(whileAny(["p", "q", ""])) === "p,q,") r += 1000000;
  return r;
}`);
    expect(value).toBe(1111112);
  });

  it("closes the loop's iterator when the generator is returned mid-loop", async () => {
    const value = await runStandalone(`
function* loop(it: any) { for (const v of it) { yield v; } }
export function test(): number {
  let closed = 0;
  const src: any = {
    i: 0,
    next() { this.i++; return { value: this.i, done: this.i > 5 }; },
    return() { closed++; return {}; },
  };
  src[Symbol.iterator] = function () { return src; };
  const g = loop(src);
  const a = g.next().value;
  const b = g.next().value;
  g.return(undefined);
  return a * 100 + b * 10 + closed;
}`);
    expect(value).toBe(121);
  });

  it("keeps destructuring-declaration locals across a suspension", async () => {
    const value = await runStandalone(`
function* destr(o: any) { const { a, b: [c] } = o; yield 0; yield a + c; }
function* strs() { yield "x"; yield "y"; }
export function test(): number {
  let n = 0;
  for (const v of strs()) n++;
  const d = destr({ a: 5, b: [7] });
  d.next();
  return d.next().value * 10 + n;
}`);
    expect(value).toBe(122);
  });
});
