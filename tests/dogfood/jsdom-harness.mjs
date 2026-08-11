// jsdom npm-compat workload (#3995 follow-up).
//
// jsdom's published tarball omits its upstream Mocha/WPT suites.  Until a
// matching upstream checkout is pinned, this harness keeps the runtime axis
// honest with one small, consumed API workload: the same DOM construction and
// primitive checks run in native Node and in the compiled module.  It is an
// API smoke workload, not an upstream-suite pass rate; the report says so.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createNpmWorkloadHarness, isCli, runWorkloadHarnessCli } from "./npm-workload-harness.mjs";
import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";

const DRIVER_SOURCE = `
import { JSDOM } from "./package/lib/api.js";

export function runCase() {
  const dom = new JSDOM("<!doctype html><main><h1 id=title>Hello</h1><ul><li>A</li><li>B</li></ul></main>");
  const document = dom.window.document;
  let checks = 0;
  checks += document.querySelector("#title")?.textContent === "Hello" ? 1 : 0;
  checks += document.querySelectorAll("li").length === 2 ? 1 : 0;
  checks += document.querySelector("main")?.outerHTML.includes("Hello") ? 1 : 0;
  dom.window.close();
  return checks;
}
`;

async function nativeOracle(setup) {
  const module = await import(pathToFileURL(setup.entryModulePath).href);
  const dom = new module.JSDOM("<!doctype html><main><h1 id=title>Hello</h1><ul><li>A</li><li>B</li></ul></main>");
  const document = dom.window.document;
  let checks = 0;
  checks += document.querySelector("#title")?.textContent === "Hello" ? 1 : 0;
  checks += document.querySelectorAll("li").length === 2 ? 1 : 0;
  checks += document.querySelector("main")?.outerHTML.includes("Hello") ? 1 : 0;
  dom.window.close();
  return checks;
}

export const runHarness = createNpmWorkloadHarness({
  name: "jsdom",
  issue: null,
  reportName: "jsdom-workload",
  setup: () => setupNpmCompatCatalogPackage("jsdom"),
  driverPath: (setup) => join(setup.root, ".js2-jsdom-workload.mjs"),
  driverSource: DRIVER_SOURCE,
  oracle: nativeOracle,
  timeoutMs: Number(process.env.DOGFOOD_JSDOM_WORKLOAD_TIMEOUT_MS ?? 180_000),
});

if (isCli(import.meta.url, process.argv[1])) runWorkloadHarnessCli(runHarness);
