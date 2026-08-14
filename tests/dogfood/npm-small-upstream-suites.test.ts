import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function pin(name: string) {
  return JSON.parse(readFileSync(join(HERE, `${name}-upstream-suite-pin.json`), "utf-8"));
}

function run(name: string) {
  const output = execFileSync("node", ["--import", "tsx", join(HERE, `${name}-upstream-suite.mjs`), "--json"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

describe("small npm package upstream suites", () => {
  it("pins complete clsx and cookie unit-file inventories", () => {
    expect(pin("clsx")).toMatchObject({
      tag: "v2.1.1",
      commit: "925494cf31bcd97d3337aacd34e659e80cae7fe2",
      testFileCount: 3,
      registrationSites: 32,
    });
    expect(pin("cookie")).toMatchObject({
      tag: "v2.0.1",
      commit: "51c485421a95ee796de6d8dab53a5ade0a20db8a",
      testFileCount: 4,
    });
  });

  const clsxHeavy = process.env.DOGFOOD_CLSX_UPSTREAM_SUITE === "1" ? it : it.skip;
  clsxHeavy("runs all 32 original clsx callbacks in Node and Wasm", { timeout: 300_000 }, () => {
    const report = run("clsx");
    expect(report.extraction).toMatchObject({ filesSeen: 3, filesSelected: 3, testsRegistered: 32, nativePassed: 32 });
    expect(report.results.scored).toBe(32);
    expect(report.results.passed).toBeGreaterThanOrEqual(20);
  });

  const cookieHeavy = process.env.DOGFOOD_COOKIE_UPSTREAM_SUITE === "1" ? it : it.skip;
  cookieHeavy("runs cookie's complete original callback inventory", { timeout: 300_000 }, () => {
    const report = run("cookie");
    expect(report.extraction).toMatchObject({
      filesSeen: 4,
      filesSelected: 4,
      testsRegistered: 63_740,
      nativePassed: 63_672,
      nativeFailed: 68,
    });
    expect(report.results.scored).toBe(63_672);
    expect(report.results.passed).toBeGreaterThanOrEqual(63_625);
  });
});
