import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(target: "standalone" | "wasi"): Promise<Record<string, number>> {
  const result = await compile(
    `
      export function lone(): number { return "\\u03A3".toLowerCase().charCodeAt(0); }
      export function finalAscii(): number { return "A\\u03A3".toLowerCase().charCodeAt(1); }
      export function medial(): number { return "A\\u03A3B".toLowerCase().charCodeAt(1); }
      export function ignoredBefore(): number { return "A.\\u03A3".toLowerCase().charCodeAt(2); }
      export function ignoredAfter(): number { return "A\\u03A3\\u0345".toLowerCase().charCodeAt(1); }
      export function casedAfterIgnored(): number { return "A\\u03A3\\u0345\\u0391".toLowerCase().charCodeAt(1); }
      export function astralBefore(): number {
        return "\\uD835\\uDCA2\\u03A3".toLowerCase().charCodeAt(2);
      }
      export function localeFinal(): number {
        return "A\\u03A3".toLocaleLowerCase().charCodeAt(1);
      }
    `,
    { target },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
  const names = [
    "lone",
    "finalAscii",
    "medial",
    "ignoredBefore",
    "ignoredAfter",
    "casedAfterIgnored",
    "astralBefore",
    "localeFinal",
  ];
  return Object.fromEntries(names.map((name) => [name, (exports[name] as () => number)()]));
}

describe("#3773 standalone Unicode Final_Sigma lowercasing", () => {
  for (const target of ["standalone", "wasi"] as const) {
    it(`uses Cased and Case_Ignorable context under ${target}`, async () => {
      expect(await run(target)).toEqual({
        lone: 0x03c3,
        finalAscii: 0x03c2,
        medial: 0x03c3,
        ignoredBefore: 0x03c2,
        ignoredAfter: 0x03c2,
        casedAfterIgnored: 0x03c3,
        astralBefore: 0x03c2,
        localeFinal: 0x03c2,
      });
    });
  }
});
