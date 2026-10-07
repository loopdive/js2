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
      "first-class entries advances past a throwing indexed getter",
      `
      const array: any = {length: 2, 1: replacement};
      Object.defineProperty(array,"0",{get(){throw new Error("indexed Get");}});
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      let caught=false;
      try {iterator.next();} catch {caught=true;}
      const pair: any = iterator.next().value;
      return caught && pair[0]===1 ? Number(pair[1]) : -1;
    `,
    ],
    [
      "first-class entries creates fresh pairs",
      `
      const array: any = [1, replacement];
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      const first: any = iterator.next().value;
      const second: any = iterator.next().value;
      return first!==second && first[0]===0 && second[0]===1 ? Number(second[1]) : -1;
    `,
    ],
    [
      "first-class entries stops after shrinking",
      `
      const array: any = [1, "2"];
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      iterator.next();
      array.length=1;
      return iterator.next().done ? replacement : -1;
    `,
    ],
    ...["keys", "entries"].map((member) => [
      `first-class ${member} defers length and latches exhaustion`,
      `
      const array: any = {};
      let count=0;
      Object.defineProperty(array,"length",{get(){count++; if(count>1) throw new Error("late length"); return 0;}});
      const method: any = Array.prototype.${member};
      const iterator: any = method.call(array);
      if(count!==0) return -1;
      if(!iterator.next().done) return -2;
      return iterator.next().done && count===1 ? replacement : -3;
    `,
    ]),
    ...["keys", "entries"].map((member) => [
      `first-class ${member} keeps the Array iterator prototype`,
      `
      const array: any = [replacement];
      const method: any = Array.prototype.${member};
      const iterator: any = method.call(array);
      const values: any = array[Symbol.iterator]();
      return Object.getPrototypeOf(iterator)===Object.getPrototypeOf(values) ? replacement : -1;
    `,
    ]),
    [
      "first-class keys observes growth",
      `
      const array: any = [1];
      const method: any = Array.prototype.keys;
      const iterator: any = method.call(array);
      if (iterator.next().value !== 0) return -1;
      array.push(replacement);
      return iterator.next().value === 1 ? replacement : -2;
    `,
    ],
    [
      "first-class entries observes indexed mutation",
      `
      const array: any = [1, "2"];
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      array[1] = replacement;
      iterator.next();
      const pair: any = iterator.next().value;
      return pair[0] === 1 ? Number(pair[1]) : -1;
    `,
    ],
    [
      "first-class keys does not read indexed getters",
      `
      const array: any = {length: 1};
      Object.defineProperty(array,"0",{get(){throw new Error("indexed Get");}});
      const method: any = Array.prototype.keys;
      const iterator: any = method.call(array);
      return iterator.next().value === 0 ? replacement : -1;
    `,
    ],
    [
      "first-class entries delays indexed getters until next",
      `
      const array: any = {length: 1};
      let count=0;
      Object.defineProperty(array,"0",{get(){count++; return replacement;}});
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      if(count !== 0) return -1;
      const pair: any = iterator.next().value;
      return count===1 && pair[0]===0 ? Number(pair[1]) : -2;
    `,
    ],
    [
      "first-class entries drains current values",
      `
      const array: any = [1, "2"];
      const method: any = Array.prototype.entries;
      const iterator: any = method.call(array);
      iterator.next();
      array[1]=replacement;
      const rest: any = Array.from(iterator);
      return rest.length===1 && rest[0][0]===1 ? Number(rest[0][1]) : -1;
    `,
    ],
    [
      "first-class keys stays exhausted after growth",
      `
      const array: any = [1];
      const method: any = Array.prototype.keys;
      const iterator: any = method.call(array);
      iterator.next();
      if(!iterator.next().done) return -1;
      array.push(replacement);
      return iterator.next().done ? replacement : -2;
    `,
    ],
    [
      "first-class Array.prototype iterator",
      `
      const array: any = [1, "2"];
      const method: any = Array.prototype.values;
      const iterator: any = method.call(array);
      array[1] = replacement;
      if (array[1] !== replacement) return -1;
      iterator.next();
      return Number(iterator.next().value);
    `,
    ],
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
