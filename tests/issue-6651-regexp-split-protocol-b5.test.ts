// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5) §22.2.6.14 `RegExp.prototype[@@split]`, generic
 * over an Object receiver, standalone: SpeciesConstructor, the splitter
 * Construct, ToUint32(limit), and the sticky splitter walk over B2's
 * observable RegExpExec — reached from the reflective closure AND from the
 * direct `re[Symbol.split](…)` spelling (B3's route).
 *
 * The exact rows each pin a different step:
 *
 * - `species-ctor-y` / `coerce-flags` — the species constructor receives
 *   `newFlags` (step 7: `y` appended exactly when absent, `ToString(flags)`).
 * - `species-ctor-species-non-ctor` — a non-constructor `@@species` is a
 *   TypeError (and the direct spelling reaches the body, not the static core).
 * - `species-ctor-ctor-undef` — an own `constructor = undefined` is the
 *   default lane (and the `.constructor` WRITE no longer binds the
 *   `Object_set_constructor` host import).
 * - `limit-0-bail` — `lim = 0` answers `[]` before any exec.
 * - `str-set-lastindex-match` — the walk's `lastIndex` Set per position.
 * - Annex B `Symbol.match-getter-recompiles-source` — the default splitter's
 *   `IsRegExp` read of `@@match` runs before the receiver's slots are cloned.
 *
 * Seven rows, not every row that went green: the file shares one 512 MB fork
 * (`VITEST_FORK_MAX_OLD_SPACE_SIZE`) and eleven in-process test262 compiles
 * plus the inline cases exhausted it. The inline cases below cover the steps
 * the dropped rows pinned (captures + `ToLength(length)`, the limit, the
 * default lane).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "annexB/built-ins/RegExp/prototype/Symbol.split/Symbol.match-getter-recompiles-source.js",
  "built-ins/RegExp/prototype/Symbol.split/coerce-flags.js",
  "built-ins/RegExp/prototype/Symbol.split/limit-0-bail.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-undef.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-species-non-ctor.js",
  "built-ins/RegExp/prototype/Symbol.split/species-ctor-y.js",
  "built-ins/RegExp/prototype/Symbol.split/str-set-lastindex-match.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number]) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b5",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

/**
 * Compile standalone, assert no host import leaked, and return what the
 * source's `run(): string` answers. A standalone string is an opaque GC ref on
 * the JS side, so it is read back one code unit at a time through `unit(i)`.
 */
async function runStandalone(source: string, fileName: string): Promise<string> {
  const program = `${source}
let __out = "";
export function prepare(): number { __out = run(); return __out.length; }
export function unit(i: number): number { return __out.charCodeAt(i); }
`;
  const result = await compile(program, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { prepare: () => number; unit: (i: number) => number };
  const length = exports.prepare();
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(exports.unit(i));
  return text;
}

describe("#6651 B5 — RegExp.prototype[@@split], generic, standalone", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        const result = await runExactRow(relativePath);
        expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
      },
      200_000,
    );
  }

  it("the default lane splits a real RegExp through a sticky clone, with captures and limit", async () => {
    const source = `
function run(): string {
  const split: any = (RegExp.prototype as any)[Symbol.split];
  const a: any = split.call(/[db]/, "abcde");
  const b: any = split.call(/(-)/, "x-y-z", 4);
  const c: any = split.call(/,/, "p,q,r", 0);
  const d: any = split.call(/,/, "p,q,r", -1);
  const e: any = split.call(/x/, "");
  const f: any = split.call(/(?:)/, "");
  return a.join("/") + "|" + b.join("/") + "|" + c.length + "|" + d.length + "|" + e.length + "|" + f.length;
}
`;
    // lim = 4 stops after the 4th push; ToUint32(-1) is 2^32 - 1; an empty
    // subject yields [S] on no match and [] on a (zero-width) match.
    expect(await runStandalone(source, "b5-default-lane.ts")).toBe("a/c/e|x/-/y/-|0|3|1|0");
  }, 200_000);

  it("unicodeMatching advances over a surrogate pair as one step", async () => {
    const source = `
function run(): string {
  const split: any = (RegExp.prototype as any)[Symbol.split];
  const astral = "\\ud834\\udf06";
  return split.call(/(?:)/u, astral).length + "|" + split.call(/(?:)/, astral).length;
}
`;
    expect(await runStandalone(source, "b5-unicode-advance.ts")).toBe("1|2");
  }, 200_000);

  it("a species constructor receives (rx, newFlags) and its splitter's exec drives the walk", async () => {
    const source = `
function run(): string {
  let seen = "";
  const obj: any = { flags: "gi", constructor: function () {} };
  // A sticky "b" matcher: the walk Sets lastIndex = q before each exec and
  // reads the match end back from it.
  const fake: any = { lastIndex: 0 };
  fake.exec = function (s: any): any {
    const i: number = fake.lastIndex;
    if (String(s).charAt(i) !== "b") return null;
    fake.lastIndex = i + 1;
    return ["b"];
  };
  obj.constructor[Symbol.species] = function (rx: any, flags: any): any {
    seen = (rx === obj ? "rx" : "?") + ":" + flags;
    return fake;
  };
  const out: any = (RegExp.prototype as any)[Symbol.split].call(obj, "abcb");
  return seen + "|" + out.join("/");
}
`;
    expect(await runStandalone(source, "b5-species-lane.ts")).toBe("rx:giy|a/c/");
  }, 200_000);

  it("an own `constructor` on a RegExp instance is visible to the static read", async () => {
    const source = `
function run(): string {
  // RegExp-TYPED on purpose: the #3006 static fold is the read this pins (an
  // \`any\`-typed receiver takes the tag-recovery path instead).
  const re = /a/;
  const before = re.constructor === RegExp;
  const f = function () {};
  (re as any).constructor = f;
  const after = (re.constructor as unknown) === f;
  const other = /b/;
  return String(before) + "|" + String(after) + "|" + String(other.constructor === RegExp);
}
`;
    expect(await runStandalone(source, "b5-own-constructor.ts")).toBe("true|true|true");
  }, 200_000);

  it("control — the ungated direct and String spellings keep their answers", async () => {
    const source = `
function run(): string {
  const re = /,/;
  return re[Symbol.split]("a,b,c").length + "|" + re[Symbol.split]("a,b,c", 2).length + "|" +
    "a,b".split(",").length + "|" + "abc".replace(/b/, "x");
}
`;
    expect(await runStandalone(source, "b5-static-control.ts")).toBe("3|2|2|axc");
  }, 200_000);
});
