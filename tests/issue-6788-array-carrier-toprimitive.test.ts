// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6788) Array carriers in primitive-expecting positions must run
 * ToPrimitive/ToString — `String(arr)`, `` `${arr}` ``, `[] + []`, `+[1]`,
 * `Number([5])`, `[1, 2] == "1,2"`, `[10] < [9]` — on the JS-host lane, where
 * they used to return the array itself or NaN. Every row is compared against
 * Node evaluating the same source (type-stripped), on the JS-host lane and,
 * unless the row says otherwise, on `--target standalone`.
 *
 * Measured on the parent (origin/main 3d3dfda3): 41 of the 66 host rows below
 * differed from Node; with the fix none do. The standalone lane was already
 * correct for every row it runs, and must stay so.
 */
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface Row {
  readonly name: string;
  /** Statements of a `(): number` body; `return` the observed value. */
  readonly body: string;
  /** A pre-existing standalone gap this issue does not own (named, not hidden). */
  readonly hostOnly?: string;
  /**
   * Where the row compiles (default: the shared `main` module). `own` compiles
   * it alone; the class groups add their {@link PRELUDES}.
   */
  readonly module?: "methods" | "classes" | "plainClass";
}

/**
 * Rows whose objects carry `toString`/`valueOf` methods compile apart from the
 * rest. Once ANY struct in a module has such a method, the host walker's
 * `__call_toString`/`__call_valueOf` dispatcher answers `null` for every OTHER
 * struct, so `String({a: 1})` reads "null" there — on main as well, through the
 * `any` and `o + ""` spellings this issue does not touch. Keeping them apart
 * stops that pre-existing defect from masking the rows below.
 */
const PRELUDES: Record<string, string> = {
  classes: `class WithToString { toString() { return "c"; } }\nclass WithValueOf { valueOf() { return 3; } }`,
  plainClass: `class Plain { x = 1; }`,
};

const ROWS: readonly Row[] = [
  // ── the issue's table ──
  {
    name: 'String(numArr) === "0,9,0"',
    body: `const arr: number[] = [0, 9, 0]; return String(arr) === "0,9,0" ? 1 : 0;`,
  },
  { name: "String(numArr).length", body: `const arr: number[] = [0, 9, 0]; return String(arr).length;` },
  { name: "template ${arr}", body: `const arr: number[] = [0, 9, 0]; return \`\${arr}\` === "0,9,0" ? 1 : 0;` },
  { name: "template a${arr}b", body: `const arr: number[] = [1, 2]; return \`a\${arr}b\` === "a1,2b" ? 1 : 0;` },
  { name: '[] + [] === ""', body: `const s: any = [] + []; return s === "" ? 1 : 0;` },
  { name: '[] + {} === "[object Object]"', body: `const s: any = [] + {}; return s === "[object Object]" ? 1 : 0;` },
  { name: "+[]", body: `return +[];` },
  { name: "+[1]", body: `return +[1];` },
  { name: "Number([5])", body: `return Number([5]);` },
  { name: "Number([])", body: `return Number([]);` },
  // ── the reference spellings stay correct ──
  { name: 'arr + "" (reference)', body: `const arr: number[] = [0, 9, 0]; return (arr + "") === "0,9,0" ? 1 : 0;` },
  {
    name: "arr.toString() (reference)",
    body: `const arr: number[] = [0, 9, 0]; return arr.toString() === "0,9,0" ? 1 : 0;`,
  },
  // ── more ToString positions ──
  { name: "String(string[])", body: `const a: string[] = ["a", "b"]; return String(a) === "a,b" ? 1 : 0;` },
  { name: "String([])", body: `return String([]) === "" ? 1 : 0;` },
  { name: "String(nested)", body: `const a: number[][] = [[1, 2], [3]]; return String(a) === "1,2,3" ? 1 : 0;` },
  { name: "template nested", body: `const a: number[][] = [[1, 2], [3]]; return \`\${a}\` === "1,2,3" ? 1 : 0;` },
  {
    name: "String(arr with null)",
    body: `const a: (number | null)[] = [1, null, 2]; return String(a) === "1,,2" ? 1 : 0;`,
  },
  { name: "String(array of objects)", body: `const a = [{ x: 1 }]; return String(a) === "[object Object]" ? 1 : 0;` },
  {
    name: "template array of objects",
    body: `const a = [{ x: 1 }]; return \`a\${a}b\` === "a[object Object]b" ? 1 : 0;`,
  },
  {
    name: "String(arr.map(...))",
    body: `const a: number[] = [1, 2]; return String(a.map((x) => x * 2)) === "2,4" ? 1 : 0;`,
  },
  { name: "String(Uint8Array)", body: `const a = new Uint8Array([1, 2]); return String(a) === "1,2" ? 1 : 0;` },
  {
    name: "String.raw substitution",
    body: `const a: number[] = [1, 2]; return String.raw\`x\${a}\` === "x1,2" ? 1 : 0;`,
  },
  // ── ToNumber positions ──
  { name: "Number(string[])", body: `const a: string[] = ["12"]; return Number(a);` },
  { name: "Number([1, 2]) is NaN", body: `const a: number[] = [1, 2]; return Number.isNaN(Number(a)) ? 1 : 0;` },
  { name: "Number(arr.slice(1))", body: `const a: number[] = [7, 8]; return Number(a.slice(1));` },
  { name: "unary + typed", body: `const a: number[] = [42]; return +(a as any);` },
  { name: "unary - typed", body: `const a: number[] = [4]; return -(a as any);` },
  { name: "unary - typed (no cast)", body: `const a: number[] = [4]; return -a;` },
  { name: "[1] * 2", body: `const a: any = [1]; return a * 2;` },
  { name: "typed [1] * 2", body: `const a: number[] = [1]; return a * 2;` },
  { name: "typed arr - 1", body: `const a: number[] = [4]; return a - 1;` },
  { name: "typed arr | 0", body: `const a: number[] = [7]; return a | 0;` },
  { name: "isNaN(arr)", body: `const a: number[] = [2]; return isNaN(a as any) ? 1 : 0;` },
  // ── `+` with a non-string other side ──
  {
    name: "typed arr + 1",
    body: `const a: number[] = [1, 2]; const s: any = a + 1; return s === "1,21" ? 1 : 0;`,
  },
  {
    name: "typed 1 + arr",
    body: `const a: number[] = [3]; const s: any = 1 + a; return s === "13" ? 1 : 0;`,
  },
  {
    name: "typed arr + arr",
    body: `const a: number[] = [1]; const b: number[] = [2]; const s: any = a + b; return s === "12" ? 1 : 0;`,
  },
  { name: "1 + [2]", body: `const s: any = 1 + ([2] as any); return s === "12" ? 1 : 0;` },
  // ── relational ──
  { name: "[2] > [1]", body: `const a: any = [2]; const b: any = [1]; return a > b ? 1 : 0;` },
  {
    name: "typed [10] < [9] compares strings",
    body: `const a: number[] = [10]; const b: number[] = [9]; return a < b ? 1 : 0;`,
  },
  { name: "typed arr <= 1", body: `const a: number[] = [1]; return a <= 1 ? 1 : 0;` },
  // ── loose equality: ToPrimitive against a primitive, identity against an object ──
  { name: '[1,2] == "1,2"', body: `const a: any = [1, 2]; return a == "1,2" ? 1 : 0;` },
  {
    name: 'typed [1,2] == "1,2"',
    body: `const a: number[] = [1, 2]; return a == "1,2" ? 1 : 0;`,
  },
  {
    name: 'typed "1,2" == [1,2]',
    body: `const a: number[] = [1, 2]; return "1,2" == a ? 1 : 0;`,
    hostOnly: "standalone string-left loose equality answers false (pre-existing)",
  },
  { name: "typed [5] == 5", body: `const a: number[] = [5]; return a == 5 ? 1 : 0;` },
  { name: "typed [5] != 5", body: `const a: number[] = [5]; return a != 5 ? 1 : 0;` },
  { name: "same array == is identity", body: `const a: number[] = [1]; const b = a; return a == b ? 1 : 0;` },
  {
    name: "equal-content arrays are not ==",
    body: `const a: number[] = [1]; const b: number[] = [1]; return a == b ? 1 : 0;`,
    hostOnly: "standalone answers `[1] == [1]` true (pre-existing)",
  },
  { name: "arr == null stays nullish", body: `const a: number[] = [1]; return a == null ? 1 : 0;` },
  // ── objects with custom valueOf / toString / @@toPrimitive in each position ──
  { name: "String({a:1})", body: `const o = { a: 1 }; return String(o) === "[object Object]" ? 1 : 0;` },
  { name: "template {a:1}", body: `const o = { a: 1 }; return \`\${o}\` === "[object Object]" ? 1 : 0;` },
  {
    name: "String(obj valueOf+toString)",
    body: `const o = { valueOf() { return 5; }, toString() { return "s"; } }; return String(o) === "s" ? 1 : 0;`,
    module: "methods",
  },
  {
    name: "template obj valueOf+toString",
    body: `const o = { valueOf() { return 5; }, toString() { return "s"; } }; return \`\${o}\` === "s" ? 1 : 0;`,
    module: "methods",
  },
  { name: "obj valueOf + 1", body: `const o = { valueOf() { return 5; } }; return o + 1;`, module: "methods" },
  {
    name: 'obj valueOf+toString + ""',
    body: `const o = { valueOf() { return 7; }, toString() { return "T"; } }; return (o + "") === "7" ? 1 : 0;`,
    module: "methods",
  },
  {
    name: "Number(obj valueOf)",
    body: `const o = { valueOf() { return 5; }, toString() { return "6"; } }; return Number(o);`,
    module: "methods",
  },
  {
    name: "unary + obj valueOf",
    body: `const o = { valueOf() { return 5; }, toString() { return "6"; } }; return +o;`,
    module: "methods",
  },
  {
    name: "Number(obj toString)",
    body: `const o = { toString() { return "8"; } }; return Number(o);`,
    module: "methods",
  },
  {
    name: "String(obj @@toPrimitive)",
    body: `const o = { [Symbol.toPrimitive](h: string) { return h; } }; return String(o) === "string" ? 1 : 0;`,
    module: "methods",
  },
  {
    name: "template obj @@toPrimitive",
    body: `const o = { [Symbol.toPrimitive](h: string) { return h; } }; return \`\${o}\` === "string" ? 1 : 0;`,
    module: "methods",
  },
  {
    name: "obj @@toPrimitive + (default hint)",
    body: `const o = { [Symbol.toPrimitive](h: string) { return h === "default" ? 10 : 20; } }; return (o as any) + 1;`,
    module: "methods",
  },
  {
    name: "Number(obj @@toPrimitive) (number hint)",
    body: `const o = { [Symbol.toPrimitive](h: string) { return h === "number" ? 9 : 0; } }; return Number(o);`,
    module: "methods",
  },
  {
    name: "obj valueOf == 5",
    body: `const o = { valueOf() { return 5; } }; return (o as any) == 5 ? 1 : 0;`,
    module: "methods",
  },
  {
    name: "String(class instance without toString)",
    body: `const c = new Plain(); return String(c) === "[object Object]" ? 1 : 0;`,
    module: "plainClass",
  },
  {
    name: "String(class with toString)",
    body: `return String(new WithToString()) === "c" ? 1 : 0;`,
    module: "classes",
  },
  {
    name: "String(array of class instances)",
    body: `const a = [new WithToString(), new WithToString()]; return String(a) === "c,c" ? 1 : 0;`,
    module: "classes",
  },
  { name: "Number(class valueOf)", body: `return Number(new WithValueOf());`, module: "classes" },
];

const moduleOf = (row: Row): string => row.module ?? "main";
const MODULES = [...new Set(ROWS.map(moduleOf))];

/** One module per (group, lane): every row is its own exported function `r<i>`. */
function sourceOf(module: string): string {
  const rows = ROWS.flatMap((row, i) => (moduleOf(row) === module ? [{ row, i }] : []));
  const fns = rows.map(({ row, i }) => `export function r${i}(): number {\n${row.body}\n}`);
  return `${PRELUDES[module] ?? ""}\n${fns.join("\n")}\n`;
}

type Exports = Record<string, () => unknown>;

async function instantiate(source: string, target: "host" | "standalone"): Promise<Exports> {
  const result = await compile(
    source,
    target === "standalone" ? { fileName: "issue-6788.ts", target: "standalone" } : { fileName: "issue-6788.ts" },
  );
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (target === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return instance.exports as unknown as Exports;
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return instance.exports as unknown as Exports;
}

function evaluateInNode(source: string): Exports {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports: Exports = {};
  new Function("exports", "module", js.outputText)(exports, { exports });
  return exports;
}

/**
 * Wasm returns `f64`; normalize Node's booleans the same way. Every row returns
 * a number, so anything else (e.g. an opaque WasmGC struct) is reported by its
 * type instead of being handed to the assertion differ.
 */
const observe = (value: unknown): unknown =>
  typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "number" ? value : `<${typeof value}>`;

describe("#6788 array carriers run ToPrimitive/ToString", () => {
  const node: Exports = {};
  const host: Exports = {};
  const standalone: Exports = {};

  // A few whole-module compiles instead of one per row.
  beforeAll(async () => {
    for (const module of MODULES) {
      const source = sourceOf(module);
      Object.assign(node, evaluateInNode(source));
      Object.assign(host, await instantiate(source, "host"));
      Object.assign(standalone, await instantiate(source, "standalone"));
    }
  }, 300_000);

  it.each(ROWS.map((row, i) => [row.name, i] as const))("JS-host: %s", (_name, i) => {
    expect(observe(host[`r${i}`]!())).toStrictEqual(observe(node[`r${i}`]!()));
  });

  it.each(ROWS.flatMap((row, i) => (row.hostOnly ? [] : [[row.name, i] as const])))("standalone: %s", (_name, i) => {
    expect(observe(standalone[`r${i}`]!())).toStrictEqual(observe(node[`r${i}`]!()));
  });
});
