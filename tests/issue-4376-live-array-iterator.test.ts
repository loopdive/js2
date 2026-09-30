// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const runner = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const module = new WebAssembly.Module(Buffer.concat(chunks));
if (WebAssembly.Module.imports(module).length !== 0) throw new Error("unexpected host imports");
const instance = await WebAssembly.instantiate(module, {});
instance.exports.__module_init?.();
process.stdout.write(String(instance.exports.probe(3)));
`;

describe("Deno native-array iterator live reads", () => {
  it.each([
    ["mixed", '[1, "2"]'],
    ["numeric", "[1, 2]"],
    ["empty-array adoption shape", '([] as any[]).concat([1, "2"])'],
  ])("observes indexed mutation for a dynamic %s receiver", async (_kind, literal) => {
    const result = await compile(
      `
      export function probe(replacement: number): number {
        const array: any = ${literal};
        const iterator: any = array[Symbol.iterator]();
        array[1] = replacement;
        if (array[1] !== replacement) return -1;
        iterator.next();
        return Number(iterator.next().value);
      }
    `,
      { target: "standalone", nativeStrings: true, deferTopLevelInit: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const child = spawnSync(process.execPath, ["--experimental-wasm-exnref", "--input-type=module", "--eval", runner], {
      input: result.binary,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(Number(child.stdout)).toBe(3);
  });

  it.each([
    [
      "growth before exhaustion",
      `
      const array: any = [1];
      const iterator: any = array[Symbol.iterator]();
      iterator.next();
      array.push(replacement);
      return Number(iterator.next().value);
    `,
    ],
    [
      "one-way exhaustion",
      `
      const array: any = [1];
      const iterator: any = array[Symbol.iterator]();
      iterator.next();
      if (!iterator.next().done) return -1;
      array.push(replacement);
      const last: any = iterator.next();
      return last.done && last.value === undefined ? replacement : -2;
    `,
    ],
    [
      "remaining elements",
      `
      const array: any = [1, 2];
      const iterator: any = array[Symbol.iterator]();
      iterator.next();
      array[1] = replacement;
      const rest: any = Array.from(iterator);
      return rest.length === 1 ? Number(rest[0]) : -1;
    `,
    ],
  ])("preserves %s", async (_name, body) => {
    const result = await compile(`export function probe(replacement: number): number { ${body} }`, {
      target: "standalone",
      nativeStrings: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const child = spawnSync(process.execPath, ["--experimental-wasm-exnref", "--input-type=module", "--eval", runner], {
      input: result.binary,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(Number(child.stdout)).toBe(3);
  });
});
