// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4157 — Acorn constructs its keyword predicates at runtime as
// `^(?:word|word|...)$`. Keep that optimization generic: index every dynamic,
// no-flags, fully anchored literal alternation, and preserve the byte-for-byte
// legacy path behind a same-tree kill switch.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SWITCH = "JS2WASM_REGEX_ANCHORED_ALT_HASH";
const savedSwitch = process.env[SWITCH];

function fnv16(value: string): number {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return hash;
}

afterEach(() => {
  if (savedSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = savedSwitch;
});

const source = String.raw`
function dynamic(value: string): any { return value; }
function anchored(body: string, flags: string = ""): RegExp {
  return new RegExp(dynamic("^(?:" + body + ")$"), dynamic(flags));
}

export function run(): number {
  let passed = 0;
  const words = anchored("break|case|catch|class|const|continue|debugger|default|delete|do|else|export");
  if (words.test("break")) passed++;
  if (words.test("export")) passed++;
  if (!words.test("unknown")) passed++;
  if (!words.test("caseX")) passed++;
  if (!words.test("Xcase")) passed++;

  const empty = anchored("|x|middle");
  if (empty.test("")) passed++;
  if (empty.test("x")) passed++;
  if (empty.test("middle")) passed++;
  if (!empty.test("middl")) passed++;

  const unicode = anchored("café|😀|東京");
  if (unicode.test("café")) passed++;
  if (unicode.test("😀")) passed++;
  if (unicode.test("東京")) passed++;

  // These distinct, same-length strings collide under the indexed FNV filter.
  // The authoritative code-unit comparison must still reject the second one.
  const collision = anchored("uwxqzevt|safe");
  if (collision.test("uwxqzevt") && !collision.test("rlttrteo")) passed++;

  // Multi-unit escapes, wildcard semantics, and flags deliberately stay on
  // the ordinary bytecode VM rather than being misclassified as raw literals.
  const escapedPipe = anchored("a\\|b|cd");
  if (escapedPipe.test("a|b") && escapedPipe.test("cd")) passed++;
  const wildcard = anchored("a.c|zz");
  if (wildcard.test("abc") && wildcard.test("a.c")) passed++;
  const insensitive = anchored("alpha|beta", "i");
  if (insensitive.test("ALPHA") && insensitive.test("Beta")) passed++;
  return passed;
}
`;

async function build(indexed: boolean): Promise<Uint8Array> {
  if (indexed) delete process.env[SWITCH];
  else process.env[SWITCH] = "0";
  const result = await compile(source, {
    fileName: "issue-4157-anchored-alt-index.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    experimentalIR: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result.binary;
}

async function run(binary: Uint8Array): Promise<number> {
  const module = await WebAssembly.compile(binary);
  expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { run(): number }).run();
}

describe("#4157 indexed dynamic anchored literal alternatives", () => {
  it("preserves exact and fallback semantics with the same-tree switch on and off", async () => {
    expect(fnv16("uwxqzevt")).toBe(fnv16("rlttrteo"));
    const indexed = await build(true);
    const legacy = await build(false);

    expect(await run(indexed)).toBe(16);
    expect(await run(legacy)).toBe(16);
    expect(Buffer.from(indexed).equals(Buffer.from(legacy))).toBe(false);
    expect(indexed.byteLength).toBeGreaterThan(legacy.byteLength);
  }, 30_000);
});
