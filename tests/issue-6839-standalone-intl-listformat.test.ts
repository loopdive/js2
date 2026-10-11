// #6839 — `Intl.ListFormat` was registered as an extern class on every target,
// so a `--target standalone` module that merely CONTAINED
// `new Intl.ListFormat(..).format(..)` (prettier's doc-printer error path) kept
// `env.Intl_ListFormat_new` / `_format` imports and could not be instantiated
// host-free (#2961). Standalone now rewrites `Intl.ListFormat` to a Wasm-native
// prelude class carrying the CLDR `en` list patterns.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

// Compiling the 45-case driver is slow on a loaded box; the first test also
// pays the compiler warm-up.
const TIMEOUT = 180_000;

type Exports = Record<string, (...args: unknown[]) => unknown>;

const TYPES = ["conjunction", "disjunction", "unit"] as const;
const STYLES = ["long", "short", "narrow"] as const;
const LISTS = [[], ["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]];

// Every (type, style, list) case, with Node's ICU output as the oracle.
const CASES = TYPES.flatMap((type) =>
  STYLES.flatMap((style) =>
    LISTS.map((list) => ({
      expr: `new Intl.ListFormat("en-US", { type: "${type}", style: "${style}" }).format(${JSON.stringify(list)})`,
      expected: new Intl.ListFormat("en-US", { type, style }).format(list),
    })),
  ),
);

const FORMAT_SRC = `
export function matches() {
  let ok = 0;
  ${CASES.map((c) => `if (${c.expr} === ${JSON.stringify(c.expected)}) ok++;`).join("\n  ")}
  return ok;
}
export function parts() {
  let s = "";
  for (const p of new Intl.ListFormat("en").formatToParts(["x", "y", "z"])) s += p.type + ":" + p.value + "|";
  return s === "element:x|literal:, |element:y|literal:, and |element:z|" ? 1 : 0;
}
export function options() {
  const r = new Intl.ListFormat("en-US", { type: "disjunction" }).resolvedOptions();
  const d = new Intl.ListFormat().resolvedOptions();
  const fallback = new Intl.ListFormat(["de-DE", "en-GB"]).resolvedOptions();
  const other = new Intl.ListFormat("fr").resolvedOptions();
  return (r.locale === "en-US" && r.type === "disjunction" && r.style === "long" ? 1 : 0) +
    (d.locale === "en-US" && d.type === "conjunction" && d.style === "long" ? 2 : 0) +
    (fallback.locale === "en" ? 4 : 0) +
    (other.locale === "en-US" ? 8 : 0);
}
export function iterables() {
  let closed = 0;
  const bad = {
    i: 0,
    [Symbol.iterator]() { return this; },
    next() { this.i++; return this.i <= 2 ? { value: this.i === 1 ? "p" : 7, done: false } : { value: undefined, done: true }; },
    return() { closed++; return {}; },
  };
  let threw = 0;
  try { new Intl.ListFormat("en").format(bad); } catch (e) { if (e instanceof TypeError) threw = 1; }
  function* gen() { yield "a"; yield "b"; yield "c"; }
  const viaGen = new Intl.ListFormat("en", { type: "disjunction" }).format(gen()) === "a, b, or c" ? 4 : 0;
  const viaSet = new Intl.ListFormat("en", { style: "short" }).format(new Set(["x", "y"])) === "x & y" ? 8 : 0;
  return threw + closed * 2 + viaGen + viaSet;
}
export function errors() {
  let bits = 0;
  try { new Intl.ListFormat("en", { type: "bogus" }); } catch (e) { if (e instanceof RangeError) bits |= 1; }
  try { new Intl.ListFormat("en_US"); } catch (e) { if (e instanceof RangeError) bits |= 2; }
  try { new Intl.ListFormat("en").format(["a", 1]); } catch (e) { if (e instanceof TypeError) bits |= 4; }
  try { new Intl.ListFormat("en", null); } catch (e) { if (e instanceof TypeError) bits |= 8; }
  const sup = Intl.ListFormat.supportedLocalesOf(["en-us", "fr", "EN-gb"]);
  if (sup.length === 2 && sup[0] === "en-US" && sup[1] === "en-GB") bits |= 16;
  return bits;
}
`;

async function instantiate(binary: Uint8Array): Promise<{ imports: string[]; exports: Exports }> {
  const module = await WebAssembly.compile(binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  if (imports.length > 0) return { imports, exports: {} };
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return { imports, exports: instance.exports as Exports };
}

describe("#6839 standalone Intl.ListFormat is Wasm-native", () => {
  for (const fileName of ["input.js", "input.ts"]) {
    it(
      `${fileName}: no host import, en output equals Node's ICU for all ${CASES.length} cases`,
      async () => {
        const result = await compile(FORMAT_SRC, { target: "standalone", fileName });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        const { imports, exports } = await instantiate(result.binary);
        expect(imports).toEqual([]);
        expect(exports.matches!()).toBe(CASES.length);
        expect(exports.parts!()).toBe(1);
        expect(exports.options!()).toBe(15);
        expect(exports.errors!()).toBe(31);
        expect(exports.iterables!()).toBe(15);
      },
      TIMEOUT,
    );
  }

  it(
    "prettier's multi-file shape (`.mjs` error-message helper) links with zero imports",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "issue-6839-"));
      writeFileSync(
        join(dir, "doc.mjs"),
        `var ho = (e) => new Intl.ListFormat("en-US", { type: "disjunction" }).format(e);
export function describe(types) { return ho(types.map((t) => "'" + t + "'")); }
`,
      );
      writeFileSync(
        join(dir, "main.mjs"),
        `import { describe } from "./doc.mjs";
export function check() { return describe(["string", "array", "group"]) === "'string', 'array', or 'group'" ? 1 : 0; }
`,
      );
      const result = await compileProject(join(dir, "main.mjs"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      const { imports, exports } = await instantiate(result.binary);
      expect(imports).toEqual([]);
      expect(exports.check!()).toBe(1);
    },
    TIMEOUT,
  );

  it("a top-level user `Intl` binding is never rewritten", async () => {
    const result = await compile(
      `const Intl = { ListFormat: class { format() { return "mine"; } } };
export function t() { return new Intl.ListFormat().format(["a", "b"]) === "mine" ? 1 : 0; }`,
      { target: "standalone", fileName: "input.js" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { imports, exports } = await instantiate(result.binary);
    expect(imports).toEqual([]);
    expect(exports.t!()).toBe(1);
  });

  // Anti-vacuity control: the JS-host lane still binds the ICU-backed host
  // constructor — the prelude is host-free-target-only.
  it("JS-host lane keeps the Intl_ListFormat host bridge", async () => {
    const result = await compile(
      `export function t(): string { return new Intl.ListFormat("en").format(["a", "b"]); }`,
      { fileName: "input.ts" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.imports.map((i) => i.name)).toContain("Intl_ListFormat_new");
  });
});
