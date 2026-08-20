import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setupReactUpstreamSuite } from "./setup-react-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadReactDomUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "react-dom-upstream-suite-pin.json"), "utf-8"));
}

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

// react-dom's published tarball, sha1-verified. The hash lives in
// `npm-compat-catalog.json`, which is react-dom's existing pin — this suite
// reads it rather than carrying a second, independently-editable copy that
// could drift from the one the package-entry card already uses.
export function setupReactDomImplementation({ force = false, build = "production" } = {}) {
  if (build !== "production" && build !== "development") {
    throw new Error(`[dogfood] unsupported react-dom build: ${build}`);
  }
  const suitePin = loadReactDomUpstreamSuitePin();
  const catalog = JSON.parse(readFileSync(join(HERE, "npm-compat-catalog.json"), "utf-8"));
  const packagePin = catalog.find((entry) => entry.name === "react-dom");
  if (!packagePin) throw new Error("[dogfood] npm-compat-catalog.json has no react-dom entry");
  if (packagePin.version !== suitePin.implementation.version) {
    throw new Error(
      `[dogfood] react-dom version skew: suite pin says ${suitePin.implementation.version}, ` +
        `npm-compat-catalog.json says ${packagePin.version}`,
    );
  }

  const tarballPath = resolve(HERE, packagePin.tarball);
  if (!existsSync(tarballPath)) throw new Error(`[dogfood] pinned react-dom tarball missing at ${tarballPath}`);
  const actualSha1 = sha1(readFileSync(tarballPath));
  if (actualSha1 !== packagePin.shasum) {
    throw new Error(
      `[dogfood] react-dom tarball integrity mismatch.\n  expected sha1 ${packagePin.shasum}\n  got      sha1 ${actualSha1}`,
    );
  }

  const root = join(HERE, ".react-dom-upstream-suite-impl");
  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  const suffix = `.${build}.js`;
  const modulePath = (name) => join(root, "package", "cjs", `${name}${suffix}`);
  const sharedPath = modulePath("react-dom");
  const clientPath = modulePath("react-dom-client");
  const serverPath = modulePath("react-dom-server-legacy.browser");
  const fizzServerPath = modulePath("react-dom-server.browser");
  const nodeFizzServerPath = modulePath("react-dom-server.node");
  const edgeFizzServerPath = modulePath("react-dom-server.edge");
  const moduleNames = {
    shared: `package/cjs/react-dom.${build}.js`,
    client: `package/cjs/react-dom-client.${build}.js`,
    server: `package/cjs/react-dom-server-legacy.browser.${build}.js`,
    fizzServer: `package/cjs/react-dom-server.browser.${build}.js`,
    nodeFizzServer: `package/cjs/react-dom-server.node.${build}.js`,
    edgeFizzServer: `package/cjs/react-dom-server.edge.${build}.js`,
  };
  if (
    !existsSync(sharedPath) ||
    !existsSync(clientPath) ||
    !existsSync(serverPath) ||
    !existsSync(fizzServerPath) ||
    !existsSync(nodeFizzServerPath) ||
    !existsSync(edgeFizzServerPath)
  ) {
    mkdirSync(root, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", root], { stdio: "pipe" });
  }
  for (const path of [sharedPath, clientPath, serverPath, fizzServerPath, nodeFizzServerPath, edgeFizzServerPath]) {
    if (!existsSync(path)) throw new Error(`[dogfood] react-dom extraction did not produce ${path}`);
  }
  return {
    root,
    sharedPath,
    clientPath,
    serverPath,
    fizzServerPath,
    nodeFizzServerPath,
    edgeFizzServerPath,
    moduleNames,
    build,
    version: packagePin.version,
    pin: packagePin,
  };
}

// react-dom is versioned in lockstep with react in the SAME monorepo, so the
// tests come from the checkout the react suite already acquires and verifies —
// one clone, one commit check, and no way for the two suites to drift onto
// different revisions of the same repository.
export function setupReactDomUpstreamSuite({ force = false } = {}) {
  const pin = loadReactDomUpstreamSuitePin();
  const { root, pin: reactSuitePin } = setupReactUpstreamSuite({ force });

  if (reactSuitePin.commit !== pin.commit || reactSuitePin.tag !== pin.tag) {
    throw new Error(
      `[dogfood] react-dom suite pin (${pin.tag} @ ${pin.commit}) does not match the react suite ` +
        `checkout (${reactSuitePin.tag} @ ${reactSuitePin.commit}); they must share one revision`,
    );
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  for (const file of testPaths) {
    if (!existsSync(file)) throw new Error(`[dogfood] react-dom source pin is missing expected test file ${file}`);
  }
  return { root, pin, testPaths };
}
