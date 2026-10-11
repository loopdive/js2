import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeUnicodeExtensionKey } from "../scripts/generate-intl-locale-data.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts/generate-intl-locale-data.mjs");
const ASSET_DIRECTORY = join(ROOT, "assets", "intl");
const OUTPUT_PATH = join(ASSET_DIRECTORY, "generated", "locale-data.json");
const CLDR_COMMIT = "bb334e8d6250c9363e957e131bf7e6d08ec72f91";

function generate(root: string, check = false) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...(check ? ["--check"] : [])], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function expectGeneratorSuccess(root: string, check = false) {
  const result = generate(root, check);
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
}

function withAssetFixture(callback: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "js2-intl-locale-data-"));
  try {
    mkdirSync(join(root, "assets"), { recursive: true });
    cpSync(ASSET_DIRECTORY, join(root, "assets", "intl"), { recursive: true });
    callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("issue #6717 CLDR locale-data foundation", () => {
  it("keeps the checked-in table reproducible and carries its complete pin", () => {
    expectGeneratorSuccess(ROOT, true);
    const output = readFileSync(OUTPUT_PATH, "utf8");
    const data = JSON.parse(output);

    expect(data.schemaVersion).toBe(1);
    expect(data).not.toHaveProperty("generatedAt");
    expect(output).not.toContain(ROOT);
    expect(data.source.cldrJson).toEqual({
      cldrVersion: "48",
      commit: CLDR_COMMIT,
      release: "48.2.0",
      unicodeVersion: "16.0.0",
      url: `https://github.com/unicode-org/cldr-json/tree/${CLDR_COMMIT}`,
    });
    expect(data.source.license).toMatchObject({
      path: "license/UNICODE-LICENSE-3.0.txt",
      sha256: "220ba0e1c43b99530d2d5bdb892a99dca0989414f51ab695ecd90163eaa1ec3b",
    });
    expect(data.source.inputs).toHaveLength(11);
  });

  it("derives generic aliases, Unicode extension keys, and non-sample locales from CLDR", () => {
    const data = JSON.parse(readFileSync(OUTPUT_PATH, "utf8"));

    // `iw` → `he` is a CLDR language alias, not a Test262-specific exception.
    expect(data.localeAliases.language.iw).toEqual({ reason: "deprecated", replacement: "he" });
    expect(data.unicodeExtension.keys.ca.typeAliases.gregorian).toBe("gregory");
    expect(data.unicodeExtension.keys.ca.types.islamicc).toMatchObject({
      deprecated: true,
      preferred: "islamic-civil",
    });
    expect(data.unicodeExtension.keys.ca.typeAliases).not.toHaveProperty("islamic-civil");
    expect(data.unicodeExtension.keys.kr.placeholders.REORDER_CODE).toEqual({
      aliases: [],
      deprecated: false,
      preferred: null,
    });

    // `zu` is deliberately outside any targeted conformance fixture: this
    // asserts that the full CLDR inventory, rather than a tested-locale list,
    // feeds the table.
    expect(data.availableLocales).toContain("zu");
    expect(data.counts.availableLocales).toBeGreaterThan(700);
    expect(data.counts.likelySubtags).toBeGreaterThan(7000);
    expect(data.counts.unicodeExtensionKeys).toBeGreaterThan(20);
    expect(data.counts.unicodeExtensionTypePlaceholders).toBeGreaterThan(0);
  });

  it("permits only a metadata-supported preferred/canonical alias collision", () => {
    const supported = normalizeUnicodeExtensionKey({
      canonical: { _description: "canonical type" },
      legacy: {
        _alias: "canonical",
        _deprecated: true,
        _description: "deprecated type",
        _preferred: "canonical",
      },
    });
    expect(supported.typeAliases).toEqual({});
    expect(supported.types.legacy).toMatchObject({
      aliases: ["canonical"],
      deprecated: true,
      preferred: "canonical",
    });

    expect(() =>
      normalizeUnicodeExtensionKey({
        canonical: { _description: "canonical type" },
        ambiguous: { _alias: "canonical", _description: "ambiguous alias" },
      }),
    ).toThrow("collides with a canonical type");
  });

  it("rejects duplicate provenance keys before regeneration and preserves the prior table", () => {
    withAssetFixture((root) => {
      const provenancePath = join(root, "assets", "intl", "provenance", "cldr-json-48.2.0.json");
      const fixtureOutput = join(root, "assets", "intl", "generated", "locale-data.json");
      const outputBefore = readFileSync(fixtureOutput);
      const original = readFileSync(provenancePath, "utf8");
      const duplicate = original.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,');
      expect(duplicate).not.toBe(original);
      writeFileSync(provenancePath, duplicate);

      const result = generate(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('duplicate object key "schemaVersion"');
      expect(readFileSync(fixtureOutput)).toEqual(outputBefore);
    });
  });

  it("rejects an un-hashed provenance release mismatch before regeneration", () => {
    withAssetFixture((root) => {
      const provenancePath = join(root, "assets", "intl", "provenance", "cldr-json-48.2.0.json");
      const fixtureOutput = join(root, "assets", "intl", "generated", "locale-data.json");
      const outputBefore = readFileSync(fixtureOutput);
      const original = readFileSync(provenancePath, "utf8");
      const mismatched = original.replace('"release": "48.2.0"', '"release": "48.2.1"');
      expect(mismatched).not.toBe(original);
      writeFileSync(provenancePath, mismatched);

      const result = generate(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('provenance.source.release expected "48.2.0", got "48.2.1"');
      expect(readFileSync(fixtureOutput)).toEqual(outputBefore);
    });
  });

  it("regenerates byte-for-byte from a copied pinned input set", () => {
    withAssetFixture((root) => {
      expectGeneratorSuccess(root);
      const fixtureOutput = join(root, "assets", "intl", "generated", "locale-data.json");
      const first = readFileSync(fixtureOutput);

      expectGeneratorSuccess(root, true);
      expectGeneratorSuccess(root);
      expect(readFileSync(fixtureOutput)).toEqual(first);
    });
  });

  it("fails closed when a pinned input is tampered with", () => {
    withAssetFixture((root) => {
      const aliasesPath = join(root, "assets", "intl", "pinned-input", "aliases.json");
      const original = readFileSync(aliasesPath, "utf8");
      const tampered = original.replace('"aa-saaho"', '"aa-zahoo"');
      expect(tampered).not.toBe(original);
      writeFileSync(aliasesPath, tampered);

      const result = generate(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("aliases.json sha256 mismatch");
      expect(readFileSync(join(root, "assets", "intl", "generated", "locale-data.json"))).toEqual(
        readFileSync(OUTPUT_PATH),
      );
    });
  });
});
