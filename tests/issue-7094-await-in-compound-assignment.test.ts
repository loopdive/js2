// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7094 — an `await` that is the right operand of a compound assignment or a
 * binary operator (`r += await p`, `r = r + await p`, `return k + await p`)
 * must deliver the settled value of a PENDING promise (a `then`/`catch`
 * derived promise), not 0.
 *
 * Two shared async-CPS planner defects (src/codegen/analysis/
 * async-leading-await-replay.ts + `analyzeAsyncBody` in async-cps.ts):
 *  1. the leading-await replay declined a `let`/`var` left operand, so the
 *     function fell back to the pass-through that adds the Promise object;
 *  2. a binding the replay re-reads after resumption lexically precedes the
 *     await, so the liveness walk did not spill it and it resumed as 0.
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

async function runWasm(body: string, lane: Lane): Promise<unknown> {
  const source = `export async function test(): Promise<any> { ${body} }`;
  const options =
    lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const };
  const result = (await compile(source, options as never)) as CompileResult;
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports ?? [], {}, result.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as any).test();
}

async function runNode(body: string): Promise<unknown> {
  const js = body.replace(/: (any|number)\b/g, "");
  return new Function(`return (async () => { ${js} })()`)();
}

const REJECTED_THEN = `Promise.reject(new Error("x")).then((v: any) => 1, (e: any) => 2)`;
const ROWS: Record<string, string> = {
  "compound, then(f, g) on a rejected promise": `let r = 0; const p = ${REJECTED_THEN}; r += await p; return r;`,
  "compound, inline operand": `let r = 5; r += await ${REJECTED_THEN}; return r;`,
  "compound, then(f) on a resolved promise": `let r = 1; r += await Promise.resolve(5).then((v: number) => v + 1); return r;`,
  "compound, catch(g)": `let r = 10; r -= await Promise.reject(new Error("x")).catch((e: any) => 3); return r;`,
  "compound, plain resolved promise": `let r = 1; r += await Promise.resolve(4); return r;`,
  "two-statement form": `let r = 1; const v = await ${REJECTED_THEN}; r += v; return r;`,
  "r = r + await": `let r = 3; r = r + await ${REJECTED_THEN}; return r;`,
  "two compound awaits": `let r = 1; r += await Promise.resolve(2).then((v: number) => v); r *= await Promise.reject(1).catch((e: any) => 5); return r;`,
  "var local": `var r = 2; r += await Promise.resolve(3).then((v: number) => v); return r;`,
  "return let + await": `let r = 10; return r + await Promise.resolve(1).then((v: number) => v);`,
  "return const + await (replayed read is spilled)": `const k = 10; return k + await Promise.resolve(1).then((v: number) => v);`,
  "const local callee and argument": `const k = 10; const f = (a: number, b: number) => a * b; return f(k, await Promise.resolve(3).then((v: number) => v));`,
};

describe("#7094 await as the right operand of a compound assignment / binary operator", () => {
  for (const lane of LANES) {
    for (const [name, body] of Object.entries(ROWS)) {
      it(`${name} (${lane})`, async () => {
        const expected = await runNode(body);
        expect(await runWasm(body, lane)).toBe(expected);
      });
    }
  }
});
