// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7366 review round 1 — the `undefined` default of an f64 field is two instructions (`i64.const` +
// `f64.reinterpret_i64`). `fixupStructNewArgCounts` counted one field value per instruction, took the constructor to
// be short of values whenever another field default followed, and padded it; the surplus pushed the class tag off
// its slot. An instance then had tag 0: `instanceof` answered false, an override dispatched to the base method and a
// field read threw. Every row runs the same program in node and compares.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

function nodeMain(source: string): number {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports: { main?: () => number } = {};
  new Function("exports", outputText)(exports);
  return exports.main!();
}

interface Shape {
  readonly name: string;
  /** Class declarations `L0` … `L<depth>`, each overriding `m()` to return its level. */
  readonly classes: string;
  readonly depth: number;
}

const FIELD_SPELLINGS = [
  ["`a: number | undefined`", (name: string) => `${name}: number | undefined;`],
  ["`a?: number`", (name: string) => `${name}?: number;`],
] as const;

function shapes(): Shape[] {
  const out: Shape[] = [];
  for (const [spelling, declare] of FIELD_SPELLINGS) {
    for (const depth of [1, 2, 3]) {
      for (const uninitialisedFirst of [true, false]) {
        const ordered = (uninitialised: string, initialised: string): string =>
          uninitialisedFirst ? `${uninitialised} ${initialised}` : `${initialised} ${uninitialised}`;
        const classes = [`class L0 { ${ordered(declare("a"), "x = 1;")} m(): number { return 0; } }`];
        for (let level = 1; level <= depth; level++) {
          // The leaf also declares an uninitialised field of its own, next to its inherited ones.
          const own = `y${level} = ${level + 1};`;
          const fields = level === depth ? ordered(declare("b"), own) : own;
          classes.push(`class L${level} extends L${level - 1} { ${fields} m(): number { return ${level}; } }`);
        }
        out.push({
          name: `${spelling}, ${depth} level(s) deep, uninitialised field ${uninitialisedFirst ? "first" : "last"}`,
          classes: classes.join(" "),
          depth,
        });
      }
    }
  }
  return out;
}

const levels = (depth: number): number[] => Array.from({ length: depth + 1 }, (_, level) => level);

// [what the row observes, the body of `main` for a hierarchy of that depth]
const CHECKS: readonly (readonly [string, (depth: number) => string])[] = [
  [
    "`instanceof` every class of its chain",
    (depth) =>
      `const o = new L${depth}(); const base = new L0(); let r = base instanceof L${depth} ? 1 : 0; ` +
      levels(depth)
        .map((level) => `if (o instanceof L${level}) r += ${10 ** (level + 1)};`)
        .join(" ") +
      " return r;",
  ],
  ["dispatch to the leaf's override", (depth) => `const o: L0 = new L${depth}(); return o.m();`],
  [
    "uninitialised fields reading `undefined`",
    (depth) =>
      `const o = new L${depth}(); return (o.a === undefined ? 1 : 0) + (o.b === undefined ? 10 : 0) + ` +
      `(o.a ?? 7) * 100 + (o.b ?? 8) * 1000 + (o.x + o.y${depth}) * 10000;`,
  ],
  [
    "a value assigned later",
    (depth) =>
      `const o = new L${depth}(); const before = (o.a ?? 7) + (o.b ?? 8); o.a = 4; o.b = 5; ` +
      "return before + (o.a === undefined ? 100 : 0) + (o.b === undefined ? 1000 : 0) + " +
      `(o.a ?? 7) * 10000 + (o.b ?? 8) * 100000 + (o.x + o.y${depth}) * 1000000;`,
  ],
];

const ROWS = shapes().flatMap((shape) =>
  CHECKS.map(([check, body]) => {
    const source = `${shape.classes} export function main(): number { ${body(shape.depth)} }`;
    return [`${shape.name}: ${check}`, source] as const;
  }),
);

describe.each(["gc", "standalone"] as const)(
  "#7366 — a derived class keeps its tag and field defaults (%s)",
  (target) => {
    it.each(ROWS)("%s", async (_, source) => {
      expect(await runMain(source, target)).toBe(nodeMain(source));
    });
  },
);
