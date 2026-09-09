// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Fresh canonical-owner admission, NOT whole preparation or backend execution.
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARM_PATHS,
  CANONICAL_ROOTS,
  childEnvironment,
  evidenceValue,
  sha256,
  sourceSnapshot,
} from "./semantic-provider-source-receipts.mjs";

const PROBES = [
  "src/ir/async-plan.ts",
  "src/ir/async-plan.ts?probe=1",
  "src/ir/async-plan.ts#probe",
  "src/ir/program-prepare-ir.ts",
  "src/ir/core/intrinsics.ts?duplicate=1",
];
function probeURL(root, probe) {
  assert(PROBES.includes(probe), "unknown admission probe");
  const path = probe.split(/[?#]/)[0];
  return pathToFileURL(join(root, path)).href + probe.slice(path.length);
}

/** Exit 1 alone is not a guard witness: require the exact rejected request. */
export function validateGuardProbe(report, { root, probe }) {
  const url = probeURL(root, probe);
  const plainNode = /[?#]/.test(probe);
  assert.equal(report.root, root);
  assert.equal(report.ok, false);
  assert.equal(report.probe.url, url);
  assert.equal(report.probe.mode, plainNode ? "plain-node" : "tsx");
  assert.match(report.guardSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.probe.guardSha256, report.guardSha256, "probe used a different guard");
  const denied = report.loads.filter((row) => row.allowed === false);
  assert.equal(denied.length, 1, "one exact guard rejection required");
  assert.equal(denied[0].url, url, "query/fragment must survive to the guard");
  assert.equal(denied[0].path, probe.split(/[?#]/)[0]);
  assert.equal(denied[0].phase, "requested");
  assert.equal(report.loads.length, 1, "probe must reject before any compiler source loads");
  if (plainNode) {
    const terminal = report.probe.terminal;
    assert(terminal, "missing plain-Node terminal");
    assert.equal(terminal.code, 1);
    assert.equal(terminal.signal, null);
    assert.equal(terminal.error, null);
    assert.equal(terminal.guardSha256, report.guardSha256);
    assert.equal(terminal.stdout, "");
    assert(terminal.stderr.includes(`Error: forbidden canonical load: ${url}\n`));
  } else assert.equal(report.error.message, `forbidden canonical load: ${url}`);
  return true;
}

export function allowedCanonicalPath(path) {
  if (/[?#]/.test(path) || path.split("/").includes("..")) return false;
  return (
    CANONICAL_ROOTS.includes(path) ||
    /^src\/ir\/core\//.test(path) ||
    /^src\/ir\/analysis\/contracts\//.test(path) ||
    path === "src/ir/analysis/alloc-registry.ts" ||
    /^src\/ir\/runtime\/contracts\//.test(path) ||
    /^src\/runtime\/contracts\//.test(path) ||
    /^src\/shared\/contracts\//.test(path) ||
    /^src\/wasm\/model\//.test(path) ||
    path === "tests/helpers/typed-program-transport.mjs"
  );
}
export function requireNonemptyAdmission(payload, { root, producerReceipt, producerSha256 } = {}) {
  assert(producerReceipt && producerSha256, "independently captured producer receipt/digest required");
  assert.equal(sha256(JSON.stringify(producerReceipt)), producerSha256, "producer receipt digest changed");
  assert.equal(producerReceipt.schema, "semantic-provider-admission-producer-v1");
  assert.equal(producerReceipt.root, root, "foreign producer root");
  assert.equal(producerReceipt.snapshot.root, root);
  assert(Object.hasOwn(ARM_PATHS, producerReceipt.arm));
  assert.deepEqual(
    producerReceipt.urls,
    Object.fromEntries(
      Object.entries(ARM_PATHS[producerReceipt.arm]).map(([name, path]) => [
        name,
        pathToFileURL(join(root, path)).href,
      ]),
    ),
  );
  assert.equal(payload.kind, "produced", "source preparation must produce the admission payload");
  assert.equal(payload.root, root);
  assert.equal(payload.sourceSha256, sha256(payload.source));
  assert.equal(payload.wireSha256, sha256(payload.wire));
  assert(payload.source.length > 0 && payload.wire.length > 0);
  assert.equal(payload.source, producerReceipt.source, "source was not captured by the producer");
  assert.equal(payload.sourceSha256, producerReceipt.sourceSha256);
  assert.equal(payload.sourcePath, producerReceipt.sourcePath);
  assert.equal(payload.wireSha256, producerReceipt.wireSha256);
  assert.deepEqual(payload.urls, producerReceipt.urls);
  assert.deepEqual(payload.inventory, producerReceipt.inventory);
  for (const key of ["sources", "allUnits", "terminalUnits"])
    assert(
      Array.isArray(payload.inventory[key]) && payload.inventory[key].length > 0,
      `empty producer inventory ${key}`,
    );
  assert.equal(payload.owner, producerReceipt.ownerRecord.id);
  assert.equal(producerReceipt.ownerRecord.terminal, true);
  assert.equal(producerReceipt.ownerRecord.terminalOwnerId, payload.owner);
}

/** Check the decoded owner, not merely a nonempty sibling JSON inventory. */
export function validateAdmissionInventory({ fn, inventory, policy }, producerReceipt) {
  assert.deepEqual(evidenceValue(inventory), producerReceipt.inventory);
  assert.equal(fn.unitId, producerReceipt.ownerRecord.id);
  assert.equal(fn.asyncPlan.ownerUnitId, fn.unitId);
  assert.deepEqual(policy, { target: "standalone", backend: "wasmgc" });
  for (const key of ["terminalUnits", "allUnits"]) {
    const owners = inventory[key].filter((unit) => unit.id === fn.unitId);
    assert.equal(owners.length, 1, `decoded inventory ${key} must contain exactly one owner`);
    assert.deepEqual(evidenceValue(owners[0]), producerReceipt.ownerRecord);
  }
  assert.equal(inventory.sources.filter((source) => source.id === producerReceipt.ownerRecord.sourceId).length, 1);
  assert.equal(fn.name, producerReceipt.ownerRecord.displayName);
  return true;
}

export async function admitCanonicalOwners({
  root,
  payload,
  producerReceipt,
  producerSha256,
  censusFile,
  probe = null,
}) {
  root = realpathSync(root);
  requireNonemptyAdmission(payload, { root, producerReceipt, producerSha256 });
  const before = sourceSnapshot(root);
  assert.deepEqual(before, producerReceipt.snapshot, "admission root differs from captured producer source");
  assert.equal(producerReceipt.sourcePath, "tests/issue-2865-standalone-async-await-unwrap.test.ts");
  assert.equal(sha256(readFileSync(join(root, producerReceipt.sourcePath))), producerReceipt.sourceFileSha256);
  const entries = Object.fromEntries(CANONICAL_ROOTS.map((path) => [path, pathToFileURL(join(root, path)).href]));
  const guard = `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync, realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { relative } from 'node:path';
    let data;
    export function initialize(value) { data = value; }
    function check(url, parent, phase) {
      if (url.startsWith('node:')) return;
      if (!url.startsWith('file:')) throw Error('forbidden canonical load: ' + url);
      const parsed = new URL(url);
      const path = relative(data.root, fileURLToPath(parsed));
      const allowedCanonicalPath = ${allowedCanonicalPath.toString()};
      const CANONICAL_ROOTS = data.roots;
      const allowed = !parsed.search && !parsed.hash && allowedCanonicalPath(path);
      appendFileSync(data.file, JSON.stringify({url,parent:parent??null,path,phase,allowed})+'\\n');
      if (!allowed) throw Error('forbidden canonical load: ' + url);
      if (phase === 'resolved' && relative(data.root, realpathSync(fileURLToPath(parsed))) !== path)
        throw Error('foreign canonical source symlink: ' + path);
    }
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('file:')) check(specifier, context.parentURL, 'requested');
      const result = await next(specifier, context);
      check(result.url, context.parentURL, 'resolved');
      return result;
    }
  `)}`;
  register(guard, { parentURL: import.meta.url, data: { root, roots: CANONICAL_ROOTS, file: censusFile } });
  const report = {
    schema: "semantic-provider-owner-admission-v1",
    root,
    ok: false,
    input: { owner: payload.owner, sourceSha256: payload.sourceSha256, wireSha256: payload.wireSha256 },
    producer: { root: producerReceipt.root, sha256: producerSha256, ownerRecord: producerReceipt.ownerRecord },
    entries,
    guardSha256: sha256(guard),
    population: { roots: 0, definitions: 0, capabilities: 0, states: 0, instructions: 0 },
    before,
    closureCertified: false,
    retirementCertified: false,
  };
  try {
    if (probe !== null) {
      const url = probeURL(root, probe);
      const plainNode = /[?#]/.test(probe);
      report.probe = { url, mode: plainNode ? "plain-node" : "tsx", guardSha256: sha256(guard), rejected: false };
      if (plainNode) {
        // Same established guard, but no tsx transform to erase URL suffixes.
        // Rejection must precede TS loading; a missing loader cannot count.
        const launch = { parentURL: import.meta.url, data: { root, roots: CANONICAL_ROOTS, file: censusFile } };
        const script = `import { register } from 'node:module'; register(${JSON.stringify(guard)}, ${JSON.stringify(launch)}); await import(${JSON.stringify(url)});`;
        report.probe.terminal = await new Promise((done) => {
          const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
            cwd: root,
            env: childEnvironment(root, "off"),
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "",
            error = null;
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", (value) => {
            error = evidenceValue(value);
          });
          child.on("close", (code, signal) =>
            done({ code, signal, error, stdout, stderr, guardSha256: sha256(guard) }),
          );
        });
        report.error = { kind: "plain-node-terminal", stderr: report.probe.terminal.stderr };
      } else await import(url);
      // Returning from this import is NOT a successful negative. The exact
      // denied census row and caught error are assessed below, with no sentinel.
    } else {
      const modules = {};
      for (const [path, url] of Object.entries(entries)) modules[path] = await import(url);
      report.population.roots = Object.keys(modules).length;
      assert.equal(report.population.roots, 12);
      const transport = await import(pathToFileURL(join(root, "tests/helpers/typed-program-transport.mjs")).href);
      const decoded = transport.decodeTypedPacket(payload.wire);
      assert.equal(transport.encodeTypedPacket(decoded), payload.wire);
      validateAdmissionInventory(decoded, producerReceipt);
      const { fn, policy } = decoded;
      const semantic = modules["src/ir/analysis/async-plan.ts"];
      const plan = semantic.createIrAsyncPlan(fn.asyncPlan);
      assert.deepEqual(semantic.verifyIrAsyncPlan(plan), []);
      report.population.states = plan.states.length;
      report.population.instructions = plan.states.reduce((count, state) => count + state.body.length, 0);
      assert(report.population.states > 1 && report.population.instructions > 0, "empty async plan/body");
      const catalog = modules["src/ir/core/intrinsics.ts"];
      const capabilities = modules["src/ir/runtime/host-capabilities.ts"];
      report.population.definitions = Object.keys(catalog.INTRINSIC_DEFINITIONS).length;
      report.population.capabilities = capabilities.RUNTIME_HOST_CAPABILITY_RECORDS.length;
      assert(report.population.definitions > 0 && report.population.capabilities > 0, "empty catalog");
      const manifestModule = modules["src/ir/runtime/manifest.ts"];
      const builder = new manifestModule.RuntimeManifestBuilder(policy);
      for (const intent of plan.runtimeIntents) builder.requestFeature(intent);
      const manifest = builder.freeze();
      const providers = manifest.providers.filter((provider) => plan.runtimeIntents.includes(provider.feature));
      assert.equal(providers.length, plan.runtimeIntents.length);
      assert(providers.length > 0);
      const attachment = modules["src/ir/runtime/async-attachment.ts"];
      // An admission control using a genuine source plan, not a physical compiler
      // witness: no backend projection or fabricated PreparedProgram is asserted.
      const runtime = attachment.createPreparedIrAsyncRuntime({
        kind: "standalone-native-wasmgc",
        plan,
        manifest,
        providers: Object.freeze(providers),
        backendRequirements: manifestModule.projectRuntimeBackendRequirements(providers),
        adapters: Object.freeze([]),
        states: plan.states,
      });
      const current = attachment.assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, plan, runtime);
      report.joins = {
        plan: current.plan === plan,
        manifest: current.manifest === manifest,
        providers: current.providers.map((provider) => manifest.providers.indexOf(provider)),
        sealedIdentity: attachment.sealPreparedIrAsyncRuntimeContainers(current) === current,
      };
      assert(
        report.joins.plan &&
          report.joins.manifest &&
          report.joins.sealedIdentity &&
          report.joins.providers.every((index) => index >= 0),
      );
      report.plan = semantic.serializeIrAsyncPlan(plan);
      report.planHash = semantic.hashIrAsyncPlan(plan);
      report.manifest = evidenceValue(manifest);
      report.ok = true;
    }
  } catch (error) {
    report.error = evidenceValue(error);
  }
  report.after = sourceSnapshot(root);
  assert.deepEqual(report.after, before);
  report.loads = readFileSync(censusFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const resolved = report.loads.filter((entry) => entry.phase === "resolved" && entry.allowed);
  if (probe !== null) {
    try {
      report.probe.rejected = validateGuardProbe(report, { root, probe });
    } catch (error) {
      report.probe ??= { rejected: false };
      report.probe.validationError = evidenceValue(error);
    }
  }
  if (report.ok)
    for (const path of CANONICAL_ROOTS)
      assert(
        resolved.some((entry) => entry.path === path),
        `missing loaded canonical root ${path}`,
      );
  return report;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, input, producerFile, producerSha256, output, censusFile, probe] = process.argv.slice(2);
  assert(
    root && input && producerFile && producerSha256 && output && censusFile,
    "ROOT SOURCE_PAYLOAD_JSON PRODUCER_JSON PINNED_PRODUCER_SHA256 REPORT_JSON CENSUS_JSONL [PROBE]",
  );
  writeFileSync(censusFile, "");
  const report = await admitCanonicalOwners({
    root,
    payload: JSON.parse(readFileSync(input, "utf8")),
    producerReceipt: JSON.parse(readFileSync(producerFile, "utf8")),
    producerSha256,
    censusFile,
    probe: probe ?? null,
  });
  writeFileSync(output, JSON.stringify(report, null, 2));
  process.exitCode = probe === undefined ? (report.ok ? 0 : 1) : report.probe?.rejected ? 1 : 2;
}
