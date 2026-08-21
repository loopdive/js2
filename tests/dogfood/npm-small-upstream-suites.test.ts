import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

function pin(name: string) {
  return JSON.parse(readFileSync(join(HERE, `${name}-upstream-suite-pin.json`), "utf-8"));
}

async function run(name: string) {
  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", join(HERE, `${name}-upstream-suite.mjs`), "--json"],
    {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

describe("small npm package upstream suites", () => {
  it("pins complete small-package unit-file inventories", () => {
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
    expect(pin("marked")).toMatchObject({
      tag: "v18.0.2",
      commit: "c4f4529d69d254458831f3c22187d080db2f3c83",
      testFileCount: 6,
      registrationSites: 181,
    });
    expect(pin("stylelint")).toMatchObject({
      tag: "17.14.1",
      commit: "cd66b035087270dd62d33542154463266cc5e81a",
      testFileCount: 281,
      registrationSites: 1574,
    });
    expect(pin("three")).toMatchObject({
      tag: "r185",
      commit: "2431a09f46f34c560bc8e44b33be0e567723d5b9",
      testFileCount: 232,
      registrationSites: 1313,
    });
    expect(pin("jsdom")).toMatchObject({
      tag: "v30.0.1",
      commit: "6584485f094d5b271553005b68804c93a455c002",
      testFileCount: 17,
      registrationSites: 318,
    });
    expect(pin("styled-components")).toMatchObject({
      tag: "styled-components@6.4.4",
      commit: "5f69a304df5de81aae114928dcd98896c627c94a",
      testFileCount: 41,
      registrationSites: 668,
    });
    expect(pin("webpack")).toMatchObject({
      tag: "v5.109.2",
      commit: "6a24bd65b72c43207c36ce61b54e1f5833486906",
      testFileCount: 98,
      registrationSites: 1357,
    });
    expect(pin("jest")).toMatchObject({
      tag: "v30.4.2",
      commit: "746f2a0f57c56e3bba555280f0587d40f3db95c0",
      testFileCount: 241,
      registrationSites: 3288,
    });
    expect(pin("tailwindcss")).toMatchObject({
      tag: "v4.3.3",
      commit: "c2b24dd15fed1c59dd521bd86082f520c9f5ad0d",
      testFileCount: 42,
      registrationSites: 1376,
    });
    expect(pin("typescript")).toMatchObject({
      tag: "v5.9.3",
      commit: "c63de15a992d37f0d6cec03ac7631872838602cb",
      testFileCount: 256,
      registrationSites: 1761,
    });
    expect(pin("uuid")).toMatchObject({
      tag: "v14.0.1",
      commit: "70177807e9229dfacde2038dc1e722f1828f358a",
      testFiles: expect.any(Array),
    });
    expect(pin("uuid").testFiles).toHaveLength(10);
  });

  const clsxHeavy = process.env.DOGFOOD_CLSX_UPSTREAM_SUITE === "1" ? it : it.skip;
  clsxHeavy("runs all 32 original clsx callbacks in Node and Wasm", { timeout: 300_000 }, async () => {
    const report = await run("clsx");
    expect(report.extraction).toMatchObject({ filesSeen: 3, filesSelected: 3, testsRegistered: 32, nativePassed: 32 });
    expect(report.results.scored).toBe(32);
    expect(report.results.passed).toBeGreaterThanOrEqual(20);
  });

  const cookieHeavy = process.env.DOGFOOD_COOKIE_UPSTREAM_SUITE === "1" ? it : it.skip;
  cookieHeavy("runs cookie's complete original callback inventory", { timeout: 300_000 }, async () => {
    const report = await run("cookie");
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
  reduxHeavy("runs Redux's complete original runtime callback inventory", { timeout: 600_000 }, async () => {
    const report = await run("redux");
    expect(report.extraction).toMatchObject({
      filesSeen: 9,
      filesSelected: 9,
      testsRegistered: 82,
      nativePassed: 82,
      nativeFailed: 0,
    });
    expect(report.compile).toMatchObject({ modules: 9, succeeded: 9, validated: 9 });
    expect(report.results).toMatchObject({ scored: 82 });
    expect(report.results.passed).toBeGreaterThanOrEqual(5);
  });

  const axiosHeavy = process.env.DOGFOOD_AXIOS_UPSTREAM_SUITE === "1" ? it : it.skip;
  axiosHeavy("runs Axios's selected original synchronous unit files", { timeout: 600_000 }, async () => {
    const report = await run("axios");
    expect(report.extraction).toMatchObject({
      filesSeen: 49,
      filesSelected: 33,
      filesDeferred: 16,
      testsRegistered: 231,
      nativePassed: 231,
      nativeFailed: 0,
    });
    expect(report.compile).toMatchObject({ modules: 33, succeeded: 33, validated: 33 });
    expect(report.results).toMatchObject({ scored: 231 });
    expect(report.results.passed).toBeGreaterThanOrEqual(21);
  });

  const prettierHeavy = process.env.DOGFOOD_PRETTIER_UPSTREAM_SUITE === "1" ? it : it.skip;
  prettierHeavy("runs Prettier's selected original synchronous unit files", { timeout: 600_000 }, async () => {
    const report = await run("prettier");
    expect(report.extraction.filesSeen).toBe(20);
    expect(report.extraction.filesSelected).toBe(3);
    expect(report.extraction.filesDeferred).toBe(17);
    expect(report.extraction.nativeFailed).toBe(0);
    expect(report.compile.modules).toBe(3);
    expect(report.results.scored).toBeGreaterThan(0);
  });

  const markedHeavy = process.env.DOGFOOD_MARKED_UPSTREAM_SUITE === "1" ? it : it.skip;
  markedHeavy("runs Marked's original Hooks unit file", { timeout: 600_000 }, async () => {
    const report = await run("marked");
    expect(report.extraction).toMatchObject({
      filesSeen: 6,
      filesSelected: 1,
      filesDeferred: 5,
      testsRegistered: 30,
      nativePassed: 15,
      nativeFailed: 15,
    });
    expect(report.compile.modules).toBe(1);
    expect(report.compile).toMatchObject({ succeeded: 1, validated: 0 });
    expect(report.results.scored).toBe(15);
    expect(report.results.passed).toBe(0);
  });

  const stylelintHeavy = process.env.DOGFOOD_STYLELINT_UPSTREAM_SUITE === "1" ? it : it.skip;
  stylelintHeavy("runs Stylelint's selected original utility units", { timeout: 600_000 }, async () => {
    const report = await run("stylelint");
    expect(report.extraction).toMatchObject({
      filesSeen: 281,
      filesSelected: 30,
      filesDeferred: 251,
      testsRegistered: 108,
      nativePassed: 108,
      nativeFailed: 0,
    });
    expect(report.compile).toMatchObject({ modules: 30, succeeded: 30, validated: 30 });
    expect(report.results).toMatchObject({ scored: 108, passed: 104, failed: 4, runtimeFailed: 0 });
  });

  const threeHeavy = process.env.DOGFOOD_THREE_UPSTREAM_SUITE === "1" ? it : it.skip;
  threeHeavy("runs Three.js's original MathUtils QUnit module", { timeout: 600_000 }, async () => {
    const report = await run("three");
    expect(report.extraction).toMatchObject({
      filesSeen: 232,
      filesSelected: 1,
      filesDeferred: 231,
      testsRegistered: 18,
      nativePassed: 18,
      nativeFailed: 0,
    });
    expect(report.compile.modules).toBe(1);
    expect(report.results.scored).toBe(18);
    expect(report.results.passed).toBeGreaterThanOrEqual(17);
  });

  const jsdomHeavy = process.env.DOGFOOD_JSDOM_UPSTREAM_SUITE === "1" ? it : it.skip;
  jsdomHeavy("runs jsdom's selected original VirtualConsole callbacks", { timeout: 600_000 }, async () => {
    const report = await run("jsdom");
    expect(report.extraction).toMatchObject({
      filesSeen: 17,
      filesSelected: 1,
      filesDeferred: 16,
      testsRegistered: 6,
      nativePassed: 6,
      nativeFailed: 0,
      callbacksSelected: 6,
      callbacksDeferred: 312,
    });
    expect(report.compile.modules).toBe(1);
    expect(report.results).toMatchObject({ scored: 6, passed: 6, failed: 0, runtimeFailed: 0 });
  });

  const styledComponentsHeavy = process.env.DOGFOOD_STYLED_COMPONENTS_UPSTREAM_SUITE === "1" ? it : it.skip;
  styledComponentsHeavy("runs styled-components' selected original utility units", { timeout: 600_000 }, async () => {
    const report = await run("styled-components");
    expect(report.extraction).toMatchObject({
      filesSeen: 41,
      filesSelected: 3,
      filesDeferred: 38,
      testsRegistered: 6,
      nativePassed: 6,
      nativeFailed: 0,
    });
    expect(report.compile.modules).toBe(3);
    expect(report.results.scored).toBe(6);
  });

  const webpackHeavy = process.env.DOGFOOD_WEBPACK_UPSTREAM_SUITE === "1" ? it : it.skip;
  webpackHeavy("runs webpack's selected original utility units", { timeout: 600_000 }, async () => {
    const report = await run("webpack");
    expect(report.extraction).toMatchObject({
      filesSeen: 98,
      filesSelected: 3,
      filesDeferred: 95,
      testsRegistered: 16,
      nativePassed: 16,
      nativeFailed: 0,
    });
    expect(report.compile.modules).toBe(3);
    expect(report.results.scored).toBe(16);
  });

  const jestHeavy = process.env.DOGFOOD_JEST_UPSTREAM_SUITE === "1" ? it : it.skip;
  jestHeavy("runs Jest's selected original utility units", { timeout: 600_000 }, async () => {
    const report = await run("jest");
    expect(report.extraction).toMatchObject({
      filesSeen: 241,
      filesSelected: 12,
      filesDeferred: 229,
      testsRegistered: 234,
      nativePassed: 232,
      nativeFailed: 2,
    });
    expect(report.extraction.unavailableInfra).toBe(3054);
    expect(report.compile).toMatchObject({ modules: 12, succeeded: 12, validated: 12 });
    expect(report.results).toMatchObject({ scored: 232, passed: 113, failed: 119, runtimeFailed: 0 });
  });

  const uuidHeavy = process.env.DOGFOOD_UUID_UPSTREAM_SUITE === "1" ? it : it.skip;
  uuidHeavy("runs UUID's complete original runtime callback inventory", { timeout: 600_000 }, async () => {
    const report = await run("uuid");
    expect(report.extraction).toMatchObject({
      upstreamTestsSeen: 75,
      admitted: 75,
      rejected: 0,
    });
    expect(report.results).toMatchObject({ nativePassed: 75, scored: 75, passed: 10, failed: 65 });
    expect(report.compile).toMatchObject({ success: true, validates: true });
    expect(report.compile.files).toHaveLength(10);
  });

  const tailwindcssHeavy = process.env.DOGFOOD_TAILWINDCSS_UPSTREAM_SUITE === "1" ? it : it.skip;
  tailwindcssHeavy("runs Tailwind CSS's original segment utilities", { timeout: 600_000 }, async () => {
    const report = await run("tailwindcss");
    expect(report.extraction).toMatchObject({
      filesSeen: 42,
      filesSelected: 2,
      filesDeferred: 40,
      testsRegistered: 13,
      nativePassed: 13,
      nativeFailed: 0,
    });
    expect(report.compile.modules).toBe(2);
    expect(report.results.scored).toBe(13);
  });

  const typescriptHeavy = process.env.DOGFOOD_TYPESCRIPT_UPSTREAM_SUITE === "1" ? it : it.skip;
  typescriptHeavy("runs TypeScript's original base64 and bigint units", { timeout: 600_000 }, async () => {
    const report = await run("typescript");
    expect(report.extraction).toMatchObject({
      filesSeen: 256,
      filesSelected: 3,
      filesDeferred: 253,
      testsRegistered: 11,
      nativePassed: 11,
      nativeFailed: 0,
    });
    expect(report.extraction.unavailableInfra).toBe(1750);
    expect(report.compile).toMatchObject({ modules: 3, succeeded: 3, validated: 3 });
    expect(report.results.scored).toBe(11);
  });
});
