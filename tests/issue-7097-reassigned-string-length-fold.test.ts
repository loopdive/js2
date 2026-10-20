// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7097 — `s.length` of a reassigned `let`/`var` string must not fold to the
 * length of the binding's INITIALIZER.
 *
 * The direct-AST constant folder `tryStaticToNumber`
 * (src/codegen/expressions/misc.ts) resolved `s.length` through any variable's
 * string-literal initializer, without checking that the binding is `const`. So
 * `let s = "a"; s += "bc"; return s.length * 10` compiled to `f64.const 10`
 * whenever the function took the direct-AST path — every async function, and
 * any sync function the IR declines (a closure capture, for instance). It was
 * found after an `await` and first read as an async-frame defect; it is not.
 * A bare `return s.length` was already right (no binary fold runs there).
 *
 * Every row runs in the native regime in a JS environment (exports read
 * through `wrapCompiledExports`) and under `--target standalone`, and is
 * checked against the value Node computes for the same body.
 */
import { describe, expect, it } from "vitest";
import { type CompileResult, compile } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";
const LANES: Lane[] = ["native-first", "standalone"];

function sourceOf(body: string): string {
  return body.startsWith("SYNC ")
    ? `export function test(): number { ${body.slice(5)} }`
    : `export async function test(): Promise<number> { ${body} }`;
}

async function runWasm(body: string, lane: Lane): Promise<unknown> {
  const options =
    lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const };
  const result = (await compile(sourceOf(body), options as never)) as CompileResult;
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports ?? [], {}, result.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as any).test();
}

async function runNode(body: string): Promise<unknown> {
  const js = body.replace(/^SYNC /, "").replace(/: (string|number)\b/g, "");
  return new Function(`return (async () => { ${js} })()`)();
}

const AWAIT = "await Promise.resolve(0);";
const ROWS: Record<string, string> = {
  "two compounds before the await": `let s: string = ""; s += "a"; s += "bc"; ${AWAIT} return s.length * 10;`,
  "compound after the await": `let s: string = "a"; ${AWAIT} s += "bc"; return s.length + 0;`,
  "awaited then() value appended": `let s: string = "a"; const t = await Promise.resolve("b").then((v: string) => v + "c"); s += t; return s.length * 10 + (s === "abc" ? 1 : 0);`,
  "compound in a loop": `let s: string = ""; for (let i = 0; i < 3; i++) s += "x"; ${AWAIT} return s.length * 10;`,
  "plain assignment of a concat": `const a: string = "a"; let s: string = "z"; s = a + "bc"; ${AWAIT} return s.length * 10;`,
  "assignment of a template": `const a: string = "a"; let s: string = "z"; s = \`\${a}bc\`; ${AWAIT} return s.length * 10;`,
  "var binding": `var s: string = "a"; s += "bc"; ${AWAIT} return s.length * 10;`,
  "charCodeAt in arithmetic": `let s: string = "a"; s += "bc"; ${AWAIT} return s.charCodeAt(2) + 0;`,
  "never-reassigned let still folds right": `let s: string = "abc"; ${AWAIT} return s.length * 10;`,
  const: `const s: string = "abc"; ${AWAIT} return s.length * 10 + 1;`,
  "sync, closure capture (direct-AST path)": `SYNC var s: string = "a"; s = s + "bc"; const f = () => s; return s.length * 10 + (f() === "abc" ? 1 : 0);`,
  "sync, compound": `SYNC let s: string = "a"; s += "bc"; return s.length * 10;`,
};

describe("#7097 reassigned string binding: .length is not folded to the initializer's length", () => {
  for (const lane of LANES) {
    for (const [name, body] of Object.entries(ROWS)) {
      it(`${lane}: ${name}`, async () => {
        expect(await runWasm(body, lane)).toBe(await runNode(body));
      });
    }
  }
});
