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
  it("pins complete clsx, cookie, Redux, Axios, and Prettier unit-file inventories", () => {
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
    expect(pin("redux")).toMatchObject({
      tag: "v5.0.1",
      commit: "50b010210df25c470386f7e39a9389a4a77b3842",
      testFileCount: 9,
      registrationSites: 82,
    });
    expect(pin("axios")).toMatchObject({
      tag: "v1.16.1",
      commit: "1337d6b537afb2d3f501074c8ac4ef4308221197",
      testFileCount: 49,
      registrationSites: 645,
    });
    expect(pin("prettier")).toMatchObject({
      tag: "3.8.1",
      commit: "90983f40dce5e20beea4e5618b5e0426a6a7f4f0",
      testFileCount: 20,
      registrationSites: 48,
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

  const reduxHeavy = process.env.DOGFOOD_REDUX_UPSTREAM_SUITE === "1" ? it : it.skip;
  reduxHeavy("runs Redux's complete original runtime callback inventory", { timeout: 600_000 }, () => {
    const report = run("redux");
    expect(report.extraction).toMatchObject({
      filesSeen: 9,
      filesSelected: 9,
      testsRegistered: 82,
      nativePassed: 78,
      nativeFailed: 4,
    });
    expect(report.compile).toMatchObject({ modules: 9, succeeded: 9, validated: 9 });
    expect(report.results).toMatchObject({ scored: 78 });
    expect(report.results.passed).toBeGreaterThanOrEqual(5);
  });

  const axiosHeavy = process.env.DOGFOOD_AXIOS_UPSTREAM_SUITE === "1" ? it : it.skip;
  axiosHeavy("runs Axios's selected original synchronous unit files", { timeout: 600_000 }, () => {
    const report = run("axios");
    expect(report.extraction).toMatchObject({
      filesSeen: 49,
      filesSelected: 25,
      filesDeferred: 24,
      testsRegistered: 170,
      nativePassed: 170,
      nativeFailed: 0,
    });
    expect(report.compile).toMatchObject({ modules: 25, succeeded: 25, validated: 25 });
    expect(report.results).toMatchObject({ scored: 170 });
    expect(report.results.passed).toBeGreaterThanOrEqual(16);
  });

  const prettierHeavy = process.env.DOGFOOD_PRETTIER_UPSTREAM_SUITE === "1" ? it : it.skip;
  prettierHeavy("runs Prettier's selected original synchronous unit files", { timeout: 600_000 }, () => {
    const report = run("prettier");
    expect(report.extraction.filesSeen).toBe(20);
    expect(report.extraction.filesSelected).toBe(3);
    expect(report.extraction.filesDeferred).toBe(17);
    expect(report.extraction.nativeFailed).toBe(0);
    expect(report.compile.modules).toBe(3);
    expect(report.results.scored).toBeGreaterThan(0);
  });
});
