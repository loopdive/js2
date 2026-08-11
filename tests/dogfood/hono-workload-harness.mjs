// Hono npm-compat workload (#4286 follow-up).
//
// The package-entry harness proves that the published bundle compiles and
// validates. This companion workload consumes route registration, base-path
// cloning, and the published router's matcher, then compares one primitive
// summary against the same pinned package in native Node.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createNpmWorkloadHarness, isCli, runWorkloadHarnessCli } from "./npm-workload-harness.mjs";
import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";

const DRIVER_SOURCE = `
import { Hono } from "./package/dist/index.js";

function routeHandler() { return 1; }

export function runCase() {
  const app = new Hono();
  app.get("/users", routeHandler);
  app.post("/users", routeHandler);
  app.on(["GET", "PUT"], ["/health", "/status"], routeHandler);
  app.basePath("/api").get("/v1/items/:id", routeHandler);

  const hit = app.router.match("GET", "/api/v1/items/42");
  const miss = app.router.match("DELETE", "/missing");
  let routeText = 0;
  for (let i = 0; i < app.routes.length; i++) {
    routeText += app.routes[i].method.length + app.routes[i].path.length;
  }
  return app.routes.length * 10000 + hit[0].length * 100 + miss[0].length * 10 + routeText;
}
`;

function runNative(Hono) {
  function routeHandler() {
    return 1;
  }
  const app = new Hono();
  app.get("/users", routeHandler);
  app.post("/users", routeHandler);
  app.on(["GET", "PUT"], ["/health", "/status"], routeHandler);
  app.basePath("/api").get("/v1/items/:id", routeHandler);

  const hit = app.router.match("GET", "/api/v1/items/42");
  const miss = app.router.match("DELETE", "/missing");
  let routeText = 0;
  for (let i = 0; i < app.routes.length; i++) {
    routeText += app.routes[i].method.length + app.routes[i].path.length;
  }
  return app.routes.length * 10000 + hit[0].length * 100 + miss[0].length * 10 + routeText;
}

async function nativeOracle(setup) {
  const { Hono } = await import(pathToFileURL(setup.entryModulePath).href);
  return runNative(Hono);
}

export const runHarness = createNpmWorkloadHarness({
  name: "hono",
  issue: 4286,
  reportName: "hono-workload",
  setup: () => setupNpmCompatCatalogPackage("hono"),
  driverPath: (setup) => join(setup.root, ".js2-hono-workload.mjs"),
  driverSource: DRIVER_SOURCE,
  oracle: nativeOracle,
  timeoutMs: Number(process.env.DOGFOOD_HONO_WORKLOAD_TIMEOUT_MS ?? 180_000),
});

if (isCli(import.meta.url, process.argv[1])) runWorkloadHarnessCli(runHarness);
