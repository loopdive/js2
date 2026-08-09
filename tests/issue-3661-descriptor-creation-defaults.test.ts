import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #3661 — property-descriptor CREATION DEFAULTS are correct, including the
 * omitted-attribute case.
 *
 * WHY THIS TEST EXISTS (it is a guard, not a fix):
 *
 * #3661's two candidate mechanisms were (1) creation defaults and (2) descriptor
 * read-back. A prior lane ruled (1) out — correctly, but on narrower evidence
 * than the conclusion stated: every case it probed passed `writable: false`
 * **explicitly**, so the path where the attribute is **OMITTED** was never
 * exercised. That is precisely the shape the failing population files use
 * (`built-ins/Object/defineProperty/15.2.3.6-4-201`, `-190`, `-204`, `-214` all
 * omit `writable`), and §6.2.5.6 CompletePropertyDescriptor requires an absent
 * attribute on a NEW property to default to **false**.
 *
 * That gap was measured on 2026-07-31 and there is genuinely no defect there:
 * `Object.defineProperty` + `getOwnPropertyDescriptor` agree with V8 on every
 * combination of carrier (plain object / Array), key kind (named / index) and
 * attribute completeness (omit-all / omit-writable / explicit).
 *
 * These assertions are therefore a REGRESSION GUARD over behaviour that is
 * already correct, pinned so that a future fix to #3661's real defect — the
 * [[Set]]/[[Delete]] REJECTION paths, which fail in opposite directions per
 * value carrier (see the issue file) — cannot silently regress creation
 * defaults or descriptor read-back while chasing enforcement.
 *
 * Descriptor state is encoded as `100*writable + 10*configurable + enumerable`
 * so a partial regression is visible rather than collapsing to a boolean.
 * Every expectation below was verified against plain V8 (node) first.
 */
async function runEncoded(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as unknown as { test: () => number }).test();
}

/** `Object.defineProperty(recv, key, desc)` then read the descriptor back, encoded. */
function defineAndRead(receiver: string, key: string, descriptor: string): string {
  return `
    export function test(): number {
      const o: any = ${receiver};
      Object.defineProperty(o, ${key}, ${descriptor});
      const d: any = Object.getOwnPropertyDescriptor(o, ${key});
      return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
    }`;
}

describe("#3661 — descriptor creation defaults (omitted attributes)", () => {
  // Proves the instrument can report a distinguishing value. Without this, a
  // "0" from a harness never seen returning anything else proves nothing — this
  // surface has already produced three separate vacuous probes, one of which
  // encoded every expectation AND its sentinel to 0.
  it("sentinel: the harness reports a distinguishing value", async () => {
    expect(await runEncoded(`export function test(): number { return 999; }`)).toBe(999);
  });

  // Negative control: an all-true descriptor must read back all-true, so a
  // blanket "everything reads false" bug could not masquerade as a pass above.
  it("control: an explicitly all-true descriptor reads back 111", async () => {
    expect(
      await runEncoded(
        defineAndRead("{}", '"p"', "{ value: 1, writable: true, enumerable: true, configurable: true }"),
      ),
    ).toBe(111);
  });

  describe("omitted attributes default to false (§6.2.5.6)", () => {
    it("plain object, named key, all attributes omitted → 0", async () => {
      expect(await runEncoded(defineAndRead("{}", '"p"', "{ value: 1 }"))).toBe(0);
    });

    it("Array, index key, all attributes omitted → 0", async () => {
      expect(await runEncoded(defineAndRead("[]", '"0"', "{ value: 1 }"))).toBe(0);
    });

    it("Array, named key, all attributes omitted → 0", async () => {
      expect(await runEncoded(defineAndRead("[]", '"prop"', "{ value: 1 }"))).toBe(0);
    });

    // The exact shape of the failing population files: `writable` omitted while
    // `enumerable`/`configurable` are given explicitly.
    it("plain object, writable omitted but enumerable given → 1", async () => {
      expect(await runEncoded(defineAndRead("{}", '"p"', "{ value: 1, enumerable: true, configurable: false }"))).toBe(
        1,
      );
    });

    it("Array index, writable omitted but enumerable given → 1", async () => {
      expect(await runEncoded(defineAndRead("[]", '"0"', "{ value: 1, enumerable: true, configurable: false }"))).toBe(
        1,
      );
    });
  });

  describe("explicit attributes still read back correctly", () => {
    it("plain object, explicit all-false → 0", async () => {
      expect(
        await runEncoded(
          defineAndRead("{}", '"p"', "{ value: 1, writable: false, enumerable: false, configurable: false }"),
        ),
      ).toBe(0);
    });

    it("Array index, explicit all-false → 0", async () => {
      expect(
        await runEncoded(
          defineAndRead("[]", '"0"', "{ value: 1, writable: false, enumerable: false, configurable: false }"),
        ),
      ).toBe(0);
    });
  });

  // Bookkeeping guard: a REJECTED write must not corrupt the stored value.
  // (Whether the rejection is silent or throws is the open #3661 defect; that
  // the retained value stays 1 is already correct and must remain so.)
  it("a rejected write leaves the stored value intact", async () => {
    const ret = await runEncoded(`
      export function test(): number {
        const o: any = [];
        Object.defineProperty(o, "prop", { value: 1, writable: false, enumerable: false, configurable: false });
        try { o.prop = 42; } catch (e) {}
        return o.prop;
      }`);
    expect(ret).toBe(1);
  });
});
