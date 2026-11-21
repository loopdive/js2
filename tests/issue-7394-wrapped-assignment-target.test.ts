// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7394 — an assignment whose target sits in parentheses or a type-erased wrapper (`!`, `as`, `satisfies`, `<T>`)
// assigns to the wrapped reference. Compound assignments, `(x!) = v` and `(x!)++` used to compile to nothing, and
// `as` / `satisfies` targets were refused as invalid.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target, experimentalIR?: false): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target, experimentalIR });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

const WRAPPERS: readonly (readonly [string, (t: string) => string])[] = [
  ["(t)", (t) => `(${t})`],
  ["((t))", (t) => `((${t}))`],
  ["(t!)", (t) => `(${t}!)`],
  ["(t as number)", (t) => `(${t} as number)`],
  ["(t satisfies number)", (t) => `(${t} satisfies number)`],
  ["(<number>t)", (t) => `(<number>${t})`],
];

// [target, declarations, the reference, how `main` reads it back]; `T` is the slot type.
const TARGETS: readonly (readonly [string, (init: string, T: string) => string, string])[] = [
  ["a local", (init, T) => `let x: ${T} = ${init};`, "x"],
  ["a captured local", (init, T) => `let x: ${T} = ${init}; const peek = (): ${T} => x;`, "x"],
  ["a field", (init, T) => `const o = new (class { a: ${T} = ${init}; })();`, "o.a"],
  ["an element", (init, T) => `const a: (${T})[] = [${init}];`, "a[0]"],
  ["a module global", () => "", "g"],
];

const moduleGlobal = (target: string, init: string, T: string): string =>
  target === "a module global" ? `let g: ${T} = ${init}; ` : "";

// [operator, start value, right operand, node's result]
const COMPOUND: readonly (readonly [string, number, number, number])[] = [
  ["+=", 2, 5, 7],
  ["-=", 2, 5, -3],
  ["*=", 2, 5, 10],
  ["/=", 10, 4, 2.5],
  ["%=", 7, 4, 3],
  ["**=", 2, 5, 32],
  ["<<=", 3, 2, 12],
  [">>=", -16, 2, -4],
  [">>>=", -16, 28, 15],
  ["&=", 6, 3, 2],
  ["|=", 6, 3, 7],
  ["^=", 6, 3, 5],
];

// [operator, start value, slot type, node's result]: each start value makes the assignment happen.
const LOGICAL: readonly (readonly [string, string, string, number])[] = [
  ["||=", "0", "number", 7],
  ["&&=", "2", "number", 7],
  ["??=", "undefined", "number | undefined", 7],
];

describe.each(["gc", "standalone"] as const)("#7394 — a wrapped assignment target is assigned (%s)", (runTarget) => {
  for (const [targetName, declare, ref] of TARGETS) {
    for (const [wrapperName, wrap] of WRAPPERS) {
      const program = (init: string, T: string, body: string): string =>
        `${moduleGlobal(targetName, init, T)}export function main(): number { ${declare(init, T)} ${body} }`;

      it(`${targetName}: \`${wrapperName} = v\``, async () => {
        expect(await runMain(program("2", "number", `${wrap(ref)} = 5; return ${ref};`), runTarget)).toBe(5);
      });

      it.each(COMPOUND)(`${targetName}: \`${wrapperName} %s v\``, async (op, start, rhs, expected) => {
        const source = program(
          String(start),
          "number",
          `const r = (${wrap(ref)} ${op} ${rhs}); return r * 1000 + ${ref};`,
        );
        expect(await runMain(source, runTarget)).toBe(expected * 1000 + expected);
      });

      it(`${targetName}: \`${wrapperName}++\`, \`++${wrapperName}\`, \`--\``, async () => {
        const body = `const p = ${wrap(ref)}++; const q = ++${wrap(ref)}; const u = ${wrap(ref)}--; return p * 100 + q * 10 + u + ${ref} * 1000;`;
        // p = 2, q = 4, u = 4, then the slot holds 3.
        expect(await runMain(program("2", "number", body), runTarget)).toBe(3244);
      });

      // `satisfies number` and `<number>` do not type-check against `number | undefined`; `as` covers that wrapper family.
      // `t!` asserts the slot is not nullish, so TypeScript rejects a `??=` through it on an element.
      if (wrapperName === "(t satisfies number)" || wrapperName === "(<number>t)") continue;
      const logical = wrapperName === "(t!)" ? LOGICAL.filter(([op]) => op !== "??=") : LOGICAL;
      it.each(logical)(`${targetName}: \`${wrapperName} %s v\``, async (op, init, T, expected) => {
        const wrapped = wrapperName === "(t as number)" ? `(${ref} as ${T})` : wrap(ref);
        const source = program(init, T, `const r = (${wrapped} ${op} 7); return (r ?? 0) * 1000 + (${ref} ?? 0);`);
        expect(await runMain(source, runTarget)).toBe(expected * 1000 + expected);
      });
    }
  }

  it("a string `+=` through `!`", async () => {
    const source =
      'export function main(): number { let s: string = "ab"; (s!) += "cd"; return s.length * 10 + (s === "abcd" ? 1 : 0); }';
    expect(await runMain(source, runTarget)).toBe(41);
  });

  it("`(o.a as number) ??= 7` on a `number | undefined` field", async () => {
    const source =
      "class C { a: number | undefined = undefined; } " +
      "export function main(): number { const o = new C(); const r = ((o.a as number) ??= 7); return r * 10 + (o.a ?? 0); }";
    expect(await runMain(source, runTarget)).toBe(77);
  });

  it("an `any` target under `+=`", async () => {
    const source = "export function main(): number { let v: any = 2; (v as number) += 5; return v; }";
    expect(await runMain(source, runTarget)).toBe(7);
  });

  // The legacy i32-local analysis counted only some compound operators as writes, so a local whose writes were all
  // integers kept an i32 slot through `/=`, `%=`, `**=` and the logical operators, and the result was truncated.
  it.each([
    ["x /= 4", 2.5],
    ["x %= 0.75", 0.25],
    ["x **= 0.5", Math.sqrt(10)],
    ["x &&= 2.5", 2.5],
    ["(x) /= 4", 2.5],
  ] as const)("a legacy-path local under `%s` keeps its fraction", async (write, expected) => {
    const source = `export function main(): number { let x: number = 10; ${write}; return x; }`;
    expect(await runMain(source, runTarget, false)).toBe(expected);
  });

  // An optional chain stays an invalid target through a type-erased wrapper (TS2779 / §13.15.1); peeling the wrapper
  // must not admit it.
  it.each([
    "(o?.a as number) = 5",
    "(o?.a as number) += 5",
    "(o?.a as number)++",
    "(o?.a!) = 5",
    "(o?.a satisfies number) = 5",
  ])("`%s` is still a compile error", async (write) => {
    const source = `class C { a = 1; } export function main(): number { const o: C | undefined = new C(); ${write}; return 0; }`;
    const result = await compile(source, { fileName: "test.ts", target: runTarget });
    expect(result.success).toBe(false);
  });

  // An array `length` store grows the array whatever wraps it: the #7164 share-group and hole pre-scans see through
  // the wrapper, as the store does. `main` reads `g[8]` (a hole) and the new length back.
  it.each([
    "g.length = 9",
    "(g.length as any) = 9",
    "g.length! = 9",
    "((g.length)) = 9",
    "(g.length satisfies number) = 9",
  ])("`%s` grows the array", async (write) => {
    const source =
      "export function main(): number { const g: any[] = []; g.push('a'); " +
      `${write}; return (g[8] === undefined ? 1 : 0) + g.length * 10; }`;
    expect(await runMain(source, runTarget)).toBe(91);
  });

  // A call target is not a reference: like `f() += 1` (Annex B), a wrapped one evaluates `f()` and then throws a
  // ReferenceError instead of compiling to nothing.
  it.each(["(f() as number) += 1", "(f()!)++", "++(f()!)", "(f()) += 1"])(
    "`%s` calls `f()` and throws",
    async (write) => {
      const source =
        "let calls = 0; function f(): any { calls++; return 1; } let x = 1; " +
        `export function main(): number { try { ${write}; } catch (e) { x = 7; } return x * 100 + calls; }`;
      expect(await runMain(source, runTarget)).toBe(701);
    },
  );
});
