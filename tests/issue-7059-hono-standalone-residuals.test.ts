// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// hono's upstream unit suite on `--target standalone` (wave 17). Each block is
// one compiler/runtime defect reduced from a hono module, asserted on a pure
// WasmGC binary instantiated with an EMPTY import object. Every `was ✗` line
// answered differently on the parent commit; every `control` line answered the
// same on the parent and must keep doing so (the anti-vacuity half: the probe
// itself is wired correctly, only the defect moved).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

type Exports = Record<string, (...args: unknown[]) => unknown>;

async function runStandalone(files: Record<string, string>): Promise<Exports> {
  const root = mkdtempSync(join(tmpdir(), "issue-7059-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  } as Parameters<typeof compileProject>[1]);
  expect(result.errors.filter((e) => e.severity === "error").map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Exports;
}

describe("#7059 builtin callback over reference elements", () => {
  it("filter/some/every(Boolean) and a `var`-bound callback reach the elements", async () => {
    const ex = await runStandalone({
      "entry.ts": `
var keep = function (s: string) { return s.length > 1; };
const o = { keep: (s: string, i: number) => i !== 1 };
export function filterBoolean(): number { return ["a", "", "b"].filter(Boolean).length; }
export function splitMapFilter(): number { return "a\\nb\\n\\nc".split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean).length; }
export function someBoolean(): number { return ["", "", "b"].some(Boolean) ? 1 : 0; }
export function varCallback(): number { return ["aa", "b", "cc"].filter(keep).length; }
export function memberCallback(): number { return ["aa", "b", "cc"].filter(o.keep).length; }
export function numericBoolean(): number { return [1, 0, 2].filter(Boolean).length; }
export function arrowBoolean(): number { return ["a", "", "b"].filter((x) => Boolean(x)).length; }
`,
    });
    expect(ex.filterBoolean()).toBe(2); // was ✗ (0)
    expect(ex.splitMapFilter()).toBe(3); // was ✗ (0)
    expect(ex.someBoolean()).toBe(1); // was ✗ (0)
    expect(ex.varCallback()).toBe(2); // was ✗ (0)
    expect(ex.memberCallback()).toBe(2); // was ✗ (0)
    expect(ex.numericBoolean()).toBe(2); // control
    expect(ex.arrowBoolean()).toBe(2); // control
  });
});

describe("#7060 any-receiver .use() is the receiver's own member", () => {
  it("calls the stored closure; a real DisposableStack still takes the native arm", async () => {
    const ex = await runStandalone({
      "u.js": `export class A { constructor() { this.use = (a1, ...hs) => hs.length + 10; } }\n`,
      "entry.ts": `import { A } from "./u.js";
let n = 0;
export function ownUse(): number { const a: any = new A(); return a.use("*", 1, 2); }
export function stackUse(): number { n = 0; const s: any = new DisposableStack(); s.use({ [Symbol.dispose]() { n = 7; } }); s.dispose(); return n; }
export function stackDefer(): number { n = 0; const s: any = new DisposableStack(); s.defer(() => { n = 3; }); s.dispose(); return n; }
export function primitiveUse(): number { const s: any = 5; try { s.use(1); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
`,
    });
    expect(ex.ownUse()).toBe(12); // was ✗ (TypeError: requires a DisposableStack receiver)
    expect(ex.stackUse()).toBe(7); // control
    expect(ex.stackDefer()).toBe(3); // control
    expect(ex.primitiveUse()).toBe(1); // control
  });
});

describe("#7061 members installed on C.prototype at runtime", () => {
  it("are visible to instances, including a method-shorthand defineProperty value", async () => {
    const ex = await runStandalone({
      "u.js": `class H {
  get(x) { return x; }
  static add(n) { Object.defineProperty(this.prototype, "get" + n, { value() { return 7; }, configurable: true }); }
}
class K { m() { return 1; } }
export function install() { K.prototype.zz = function () { return 11; }; }
export function callZz() { const k = new K(); return k.zz(); }
export default H;
`,
      "entry.ts": `import H, { install, callZz } from "./u.js";
export function onInstance(): number { H.add("E"); const h: any = new H(); return typeof h.getE === "function" ? 1 : 0; }
export function callInstance(): number { H.add("F"); const h: any = new H(); return h.getF(); }
export function assignedInFunction(): number { install(); return callZz(); }
export function shorthandValue(): number { const o: any = {}; Object.defineProperty(o, "x", { value() { return 3; } }); return o.x(); }
export function shorthandAttrs(): number { const o: any = {}; Object.defineProperty(o, "x", { value() { return 3; }, configurable: true }); const d: any = Object.getOwnPropertyDescriptor(o, "x"); return (d.writable ? 100 : 0) + (d.enumerable ? 10 : 0) + (d.configurable ? 1 : 0); }
export function declared(): number { const h: any = new H(); return h.get(4); }
export function arrowValue(): number { const o: any = {}; Object.defineProperty(o, "x", { value: () => 5 }); return o.x(); }
`,
    });
    expect(ex.onInstance()).toBe(1); // was ✗ (0)
    expect(ex.callInstance()).toBe(7); // was ✗ (TypeError)
    expect(ex.assignedInFunction()).toBe(11); // was ✗ (0)
    expect(ex.shorthandValue()).toBe(3); // was ✗ (TypeError)
    expect(ex.shorthandAttrs()).toBe(1); // was ✗
    expect(ex.declared()).toBe(4); // control
    expect(ex.arrowValue()).toBe(5); // control
  });
});

describe("#7078 join of a BigInt array", () => {
  it("validates and formats each element", async () => {
    const ex = await runStandalone({
      "entry.ts": `
export function joinBigInts(): number { const s: bigint[] = []; for (let i = 0; i < 4; i++) s.push(BigInt(i * 64)); return s.join(".") === "0.64.128.192" ? 1 : 0; }
export function joinNumbers(): number { return [1, 2].join("-") === "1-2" ? 1 : 0; }
`,
    });
    expect(ex.joinBigInts()).toBe(1); // was ✗ (module failed validation)
    expect(ex.joinNumbers()).toBe(1); // control
  });
});

describe("#7079 host-free atob / btoa", () => {
  it("encodes, decodes and rejects without retaining env.atob/env.btoa", async () => {
    const ex = await runStandalone({
      "u.js": `export const e = (s) => btoa(s);\nexport const d = (s) => atob(s);\nexport const n = (b) => new Uint8Array(b).length;\n`,
      "entry.ts": `import { e, d, n } from "./u.js";
const T = (f: () => unknown): number => { try { f(); return 0; } catch (x) { return 1; } };
export function encode(): number { return (e("") === "" ? 1 : 0) + (e("f") === "Zg==" ? 1 : 0) + (e("fo") === "Zm8=" ? 1 : 0) + (e("foo") === "Zm9v" ? 1 : 0) + (e("\\xff\\xff\\xff") === "////" ? 1 : 0); }
export function decode(): number { return (d("Zg==") === "f" ? 1 : 0) + (d("Zm8") === "fo" ? 1 : 0) + (d(" Zm 9v\\n") === "foo" ? 1 : 0) + (d("////") === "\\xff\\xff\\xff" ? 1 : 0); }
export function rejects(): number { return T(() => btoa("\\u0100")) + T(() => atob("Z")) + T(() => atob("Zg=")) + T(() => atob("Zm=v")) + T(() => atob("Zm*v")); }
export function control(): number { return n(new ArrayBuffer(3)); }
`,
    });
    expect(ex.encode()).toBe(5); // was ✗ (env.atob/env.btoa retained → not instantiable)
    expect(ex.decode()).toBe(4); // was ✗
    expect(ex.rejects()).toBe(5); // was ✗
    expect(ex.control()).toBe(3); // control
  });
});

describe("#7080 callable dispatch keeps an externref result", () => {
  it("a `=> number` callback whose closure returns a boxed value", async () => {
    const ex = await runStandalone({
      "entry.ts": `
function each(fn: (a: any) => number): number { return fn("abc"); }
function eachBool(fn: (a: any) => boolean): boolean { return fn(2); }
export function lengthOfAny(): number { return each((e) => e.length); }
export function truthyAny(): number { return eachBool((x: any) => x.foo) ? 0 : 1; }
export function typedReturn(): number { return each((e) => (e as string).length); }
`,
    });
    expect(ex.lengthOfAny()).toBe(3); // was ✗ (NaN)
    expect(ex.truthyAny()).toBe(1); // control (dropped result read as false)
    expect(ex.typedReturn()).toBe(3); // control
  });
});

describe("#7081 shift / unshift on an any receiver", () => {
  it("mutates the array", async () => {
    const ex = await runStandalone({
      "u.js": `export const splitPath = (path) => { const paths = path.split("/"); if (paths[0] === "") { paths.shift(); } return paths; };\n`,
      "entry.ts": `import { splitPath } from "./u.js";
export function shiftAny(): number { const a: any = ["x", "y"]; const v = a.shift(); return a.length * 10 + (v === "x" ? 1 : 0); }
export function shiftEmpty(): number { const a: any = []; return a.shift() === undefined && a.length === 0 ? 1 : 0; }
export function unshiftAny(): number { const a: any = "a/b".split("/"); const r = a.unshift("c", "d"); return r * 10 + (a[0] === "c" && a[3] === "b" ? 1 : 0); }
export function hono(): number { const p: any = splitPath("/hello"); return p.length * 10 + (p[0] === "hello" ? 1 : 0); }
export function popControl(): number { const a: any = ["x", "y"]; a.pop(); return a.length; }
`,
    });
    expect(ex.shiftAny()).toBe(11); // was ✗ (20)
    expect(ex.shiftEmpty()).toBe(1); // was ✗
    expect(ex.unshiftAny()).toBe(41); // was ✗
    expect(ex.hono()).toBe(11); // was ✗ (20)
    expect(ex.popControl()).toBe(1); // control
  });
});

describe("#7082 optional element access on an any string", () => {
  it("indexes the string", async () => {
    const ex = await runStandalone({
      "u.js": `export const first = (b) => b?.[0];\nexport const mergeHead = (base) => \`\${base?.[0] === "/" ? "" : "/"}\${base}\`;\n`,
      "entry.ts": `import { first, mergeHead } from "./u.js";
export function optFirst(): number { return first("/a") === "/" ? 1 : 0; }
export function optOob(): number { const s: any = "/a"; return s?.[5] === undefined ? 1 : 0; }
export function hono(): number { return mergeHead("/book") === "/book" ? 1 : 0; }
export function nullish(): number { const s: any = null; return s?.[0] === undefined ? 1 : 0; }
export function arrayControl(): number { const s: any = ["x"]; return s?.[0] === "x" ? 1 : 0; }
`,
    });
    expect(ex.optFirst()).toBe(1); // was ✗ (undefined)
    expect(ex.optOob()).toBe(1); // control
    expect(ex.hono()).toBe(1); // was ✗ ("//book")
    expect(ex.nullish()).toBe(1); // control
    expect(ex.arrayControl()).toBe(1); // control
  });
});

describe("#7083 a dynamic undefined string bound means omitted", () => {
  it("slice/substring to the end", async () => {
    const ex = await runStandalone({
      "u.js": `export const tail = (u, end) => u.slice(1, end);\nexport const sub = (u, end) => u.substring(1, end);\n`,
      "entry.ts": `import { tail, sub } from "./u.js";
export function sliceUndef(): number { return tail("abcd", undefined).length; }
export function substringUndef(): number { return sub("abcd", undefined).length; }
export function sliceNumber(): number { return tail("abcd", 2).length; }
export function sliceNull(): number { return tail("abcd", null).length; }
`,
    });
    expect(ex.sliceUndef()).toBe(3); // was ✗ (0)
    expect(ex.substringUndef()).toBe(3); // was ✗ (1)
    expect(ex.sliceNumber()).toBe(1); // control
    expect(ex.sliceNull()).toBe(0); // control: ToIntegerOrInfinity(null) = 0
  });
});

describe("#7084 o[k] += rhs on an any receiver concatenates", () => {
  it("string += on an element", async () => {
    const ex = await runStandalone({
      "u.js": `export const append = (str, buffer) => { buffer[0] += str; };\nexport const bump = (buffer) => { buffer[0] += 1; };\nexport const times = (buffer) => { buffer[0] *= 3; };\n`,
      "entry.ts": `import { append, bump, times } from "./u.js";
export function appendTwice(): number { const b: any = ["x"]; append("ab", b); append("c", b); return b[0] === "xabc" ? 1 : 0; }
export function numeric(): number { const b: any = [1]; bump(b); return b[0]; }
export function multiply(): number { const b: any = [2]; times(b); return b[0]; }
`,
    });
    expect(ex.appendTwice()).toBe(1); // was ✗ (NaN)
    expect(ex.numeric()).toBe(2); // control
    expect(ex.multiply()).toBe(6); // control
  });
});

describe("#7086 String.prototype.concat on an any receiver", () => {
  it("concatenates; Array concat keeps its arm", async () => {
    const ex = await runStandalone({
      "u.js": `export const c = (s, a) => s.concat(a);\nexport const c2 = (s) => s.concat("x", 1);\n`,
      "entry.ts": `import { c, c2 } from "./u.js";
export function strConcat(): number { return c("ab", "/x") === "ab/x" ? 1 : 0; }
export function strVariadic(): number { return c2("ab") === "abx1" ? 1 : 0; }
export function arrConcat(): number { const r: any = c([1, 2], [3]); return r.length; }
`,
    });
    expect(ex.strConcat()).toBe(1); // was ✗ (TypeError: called value is not a function)
    expect(ex.strVariadic()).toBe(1); // was ✗
    expect(ex.arrConcat()).toBe(3); // control
  });
});
