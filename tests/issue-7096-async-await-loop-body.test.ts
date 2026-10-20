// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7096 — an `await` of a PENDING promise inside a `for (init; cond; incr)` or
 * `do … while` body must deliver the settled value, not the Promise object
 * (which added as 0). `while` and `for…of` bodies were already driven by the
 * async loop CFG; `for` and `do … while` were declined by its shape analysis
 * (`analyzeLoopAsync` in src/codegen/async-cps.ts), so the whole function fell
 * back to the pass-through where `await` is an identity.
 *
 * Also covered: a pre-loop local read only AFTER the loop must survive the
 * loop's suspensions (it was not in the loop spill set, `while` included).
 *
 * Every row runs in the native regime in a JS environment (exports read
 * through `wrapCompiledExports`) and under `--target standalone`, and is
 * checked against the value Node computes for the same body.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type CompileResult, compile } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";
const LANES: Lane[] = ["native-first", "standalone"];

const wrap = (body: string): string => `export async function test(): Promise<any> { ${body} }`;

async function runWasm(body: string, lane: Lane): Promise<unknown> {
  const options =
    lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const };
  const result = (await compile(wrap(body), options as never)) as CompileResult;
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports ?? [], {}, result.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as any).test();
}

async function runNode(body: string): Promise<unknown> {
  const js = ts.transpileModule(wrap(body).replace("export ", ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(`${js}; return test();`)();
}

const PENDING = "Promise.resolve(2).then((v: number) => v)";
const SETTLED = "Promise.resolve(2)";
const LOOPS: Record<string, (body: string) => string> = {
  for: (b) => `for (let i = 0; i < 3; i++) { ${b} }`,
  "do-while": (b) => `let i = 0; do { ${b} i++; } while (i < 3);`,
};
const BODIES: Record<string, (p: string) => string> = {
  "r += await p": (p) => `r += await ${p}; r += i * 100;`,
  "const v = await p; r += v": (p) => `const v = await ${p}; r += v + i * 100;`,
  "x = await p; r += x": (p) => `x = await ${p}; r += x + i * 100;`,
};

const ROWS: Record<string, string> = {};
for (const [loop, wrapLoop] of Object.entries(LOOPS)) {
  for (const [shape, body] of Object.entries(BODIES)) {
    for (const [state, p] of [
      ["pending", PENDING],
      ["settled", SETTLED],
    ] as const) {
      ROWS[`${loop}: ${shape} (${state})`] = `let r = 0; let x = 0; ${wrapLoop(body(p))} return r;`;
    }
  }
}
Object.assign(ROWS, {
  "for: var head read after the loop": `let r = 0; for (var i = 0; i < 3; i++) { r += await ${PENDING}; } return r + i;`,
  "for: expression initializer": `let r = 0; let i = 9; for (i = 0; i < 3; i++) { r += await ${PENDING}; } return r + i * 10;`,
  "for: no initializer": `let r = 0; let i = 0; for (; i < 3; i++) { r += await ${PENDING}; } return r + i * 10;`,
  "for: two declarators and a comma incrementor": `let r = 0; for (let i = 0, j = 10; i < 3; i++, j--) { r += (await ${PENDING}) * j; } return r;`,
  "for: zero iterations": `let r = 1; for (let i = 0; i < 0; i++) { r += await ${PENDING}; } return r;`,
  "for: two awaits in the body": `let r = 0; for (let i = 0; i < 3; i++) { const a = await ${PENDING}; const b = await Promise.resolve(i).then((v: number) => v); r += a * 10 + b; } return r;`,
  "for: bound from a pre-loop const": `const k = 3; let r = 0; for (let i = 0; i < k; i++) { r += (await ${PENDING}) + k; } return r;`,
  "for: pre-loop local read only after the loop": `let a = 5; let r = 0; for (let i = 0; i < 3; i++) { r += await ${PENDING}; } return r + a;`,
  "while: pre-loop local read only after the loop": `let a = 5; let r = 0; let i = 0; while (i < 3) { r += await ${PENDING}; i++; } return r + a;`,
  "do-while: body runs once on a false condition": `let r = 1; do { r += await ${PENDING}; } while (r < 0); return r;`,
  "do-while: induction variable in the condition": `let i = 0; let r = 0; do { r += await ${PENDING}; i++; } while (i < 5); return r * 100 + i;`,
});

describe("#7096 await of a pending promise inside a for / do-while body", () => {
  for (const lane of LANES) {
    for (const [name, body] of Object.entries(ROWS)) {
      it(`${name} (${lane})`, async () => {
        const expected = await runNode(body);
        expect(await runWasm(body, lane)).toBe(expected);
      });
    }
    it(`for: a rejection inside the body rejects the result (${lane})`, async () => {
      const body = `let r = 0; for (let i = 0; i < 3; i++) { r += await Promise.reject(7).then((v: any) => 1); } return r;`;
      await expect(runNode(body)).rejects.toBe(7);
      await expect(runWasm(body, lane)).rejects.toBe(7);
    });
  }
});
