// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Trusted parent for one frozen instrument. Never derive approval from its output.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";
import { pathToFileURL } from "node:url";

const APPROVAL_COMMIT = "0d2dfddb4b1145097210f5398e535e550f945f82";
const TEST = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts";
const RUNNER = "scripts/hooks/run-linear-append-provenance.mjs";
const EDITABLE = [
  RUNNER,
  "scripts/hooks/changed-root-tests.sh",
  "plan/issues/6915-linear-owned-ascii-append-copy-kernel.md",
];
const PATHS = {
  runtime: "src/codegen-linear/runtime.ts",
  consumer: "src/ir/backend/frozen-body-consumer.ts",
  integration: "src/ir/backend/linear-integration.ts",
  testSha256: TEST,
  fixture: "website/public/benchmarks/competitive/programs/string-hash.js",
};
const PINS = {
  runtime: "2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f",
  consumer: "262d9866247af2e2fa18a6f8dbdf9d4a07c37c6ae188eb491a312949e6c60404",
  integration: "8bcc7d6507cb6abd1c4333e43fe5fef015f6649dd788221778aa61e6911c1571",
  sourceTree: "953f74f80cf2f8085b8e1c93489fcdd357929b37",
  testSha256: "c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d",
  fixture: "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c",
};
// Independently frozen from the published approval checkpoint. CI's shallow
// checkout need not contain that historical commit; only actual HEAD is read.
const CONFIG_PINS = {
  "package.json": "bc084f6c2a17667e42d0c985330cbe064715984a7007201a5635c1622b10c395",
  "pnpm-lock.yaml": "6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac",
  "pnpm-workspace.yaml": "330c51e55c49a5455bbaabd7170cbe364fda10987988feded9d9c0dba50ded7a",
  "scripts/test262-concurrency.mjs": "27bc9df5949a55b54d6e504491b10f91f3d1f12e427bd6a841ba5c11fec8a785",
  "tsconfig.json": "c520c3a1d8da732e73833cb53571f93609d0c899f6bcf638d752cb91b8c1fa79",
  "tsconfig.ts7.json": "e739b6bbafbc3026dd7769692798bb6a01b5b9efe3149038756d80ab57cfb1e2",
  "vite.config.lib.ts": "a658cb99507555a3a15527375590f76940311cf4ee6bca825ab687b6594956e4",
  "vite.config.ts": "ee7bde0f2f83452c8e31915562ab01d7be640b80e818f23874430a1966d9fd11",
  "vitest.config.ts": "2c4e2e3a237278e39d6235aa3e200c5e9e0718315a4f89d5bf3c8ce910b1c53f",
};
const ARGV = [
  "exec",
  "vitest",
  "run",
  TEST,
  "--pool=forks",
  "--poolOptions.forks.singleFork=true",
  "--no-file-parallelism",
  "--reporter=default",
  "--reporter=json",
  "--outputFile=.tmp/6915-ci/observations.json",
];
const COMMAND = ["pnpm", ...ARGV].join(" ");
const FLAGS = {
  linearIr: "1",
  nodeOptions: null,
  execArgv: ["--max-old-space-size=4096", "--expose-gc", "--conditions", "node", "--conditions", "development"],
};
// Reviewed population, not parsed/learned from the executable test.
const IDS = [
  "Runtime01",
  "Runtime02",
  "Runtime03",
  "Runtime04",
  "Runtime05",
  "Runtime06",
  "Runtime07",
  "Runtime08",
  "Runtime09",
  "Runtime10",
  "Runtime11",
  "Runtime12",
  "Runtime13",
  "Runtime14",
  "Runtime15",
  "Runtime16",
  "Runtime17",
  "Runtime18",
  "Runtime19",
  "Runtime20",
  "Runtime21",
  "Runtime22",
  "Source01",
  "Source02",
  "Source03",
  "Source04",
  "Import01",
  "Import02",
  "Negative01",
  "Negative02",
  "Negative03",
  "Negative04",
  "Negative05",
  "Negative06",
  "Negative07",
  "Negative08",
];
const TIMEOUT_MS = 600_000;
const NEGATIVE_MUTATIONS = [
  "result/payload",
  "owner identity",
  "consumer completion",
  "helper binding",
  "heap delta",
  "header bytes",
  "untouched memory",
  "import binding",
];
const OUTPUT_CAP = 256 * 1024 * 1024;
const MAX_NODES = 250_000,
  MAX_FIELDS = 2_000_000,
  MAX_BYTES = 64 * 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const check = (ok, message) => assert.ok(ok, `6915 parent: ${message}`);
function detachErrors(root) {
  const seen = new Map(),
    descriptors = [];
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const intrinsic = (prototype, key, value) =>
    Reflect.apply(Object.getOwnPropertyDescriptor(prototype, key).get, value, []);
  const detach = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    check(seen.size < MAX_NODES, "runner error graph cap");
    const special =
      value instanceof Map || value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    const detached = !special && Array.isArray(value) ? [] : Object.create(null);
    seen.set(value, detached);
    const properties = [];
    descriptors.push({
      object: detached,
      kind:
        value instanceof AggregateError
          ? "aggregate-error"
          : value instanceof Error
            ? "error"
            : special
              ? "collection-or-buffer"
              : "object",
      properties,
    });
    if (value instanceof Map) {
      detached.kind = "map";
      detached.entries = [...Map.prototype.entries.call(value)].map(([key, item]) => [detach(key), detach(item)]);
    } else if (value instanceof Set) {
      detached.kind = "set";
      detached.values = [...Set.prototype.values.call(value)].map(detach);
    } else if (value instanceof ArrayBuffer) {
      detached.kind = "array-buffer";
      detached.bytesBase64 = Buffer.from(new Uint8Array(value)).toString("base64");
    } else if (ArrayBuffer.isView(value)) {
      check(value instanceof DataView || value instanceof Uint8Array, "unsupported runner diagnostic view type");
      // Fixed built-in brand access only; never use an observed own getter or
      // look up/invoke an observed constructor. Retain shared backing identity.
      const prototype = value instanceof DataView ? DataView.prototype : typedPrototype;
      const buffer = intrinsic(prototype, "buffer", value),
        offset = intrinsic(prototype, "byteOffset", value),
        length = intrinsic(prototype, "byteLength", value);
      detached.kind = value instanceof DataView ? "data-view" : "typed-array";
      detached.viewType = value instanceof DataView ? "DataView" : Buffer.isBuffer(value) ? "Buffer" : "Uint8Array";
      detached.buffer = detach(buffer);
      detached.byteOffset = offset;
      detached.byteLength = length;
      detached.bytesBase64 = Buffer.from(buffer, offset, length).toString("base64");
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      check(typeof key === "string", "unsupported runner error symbol key");
      const data = descriptor && "value" in descriptor;
      const captured = {
        key,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        ...(data
          ? { writable: descriptor.writable, value: detach(descriptor.value) }
          : {
              accessor: true,
              getterPresent: typeof descriptor.get === "function",
              setterPresent: typeof descriptor.set === "function",
            }),
      };
      properties.push(captured);
      // Custom collection/view properties live in the descriptor sidecar to
      // avoid clobbering their plain structural fields. No accessor is invoked.
      if (!special)
        Object.defineProperty(detached, key, {
          value: data ? captured.value : { unsupportedAccessor: true },
          enumerable: !(Array.isArray(value) && key === "length"),
          writable: true,
          configurable: !(Array.isArray(value) && key === "length"),
        });
    }
    return detached;
  };
  return { root: detach(root), descriptors };
}
function exactKeys(value, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "6915 parent: exact fields");
}
function integer(value, max, message) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= max, message);
}
function list(value, max = MAX_FIELDS) {
  check(Array.isArray(value) && value.length <= max, "collection cap/type");
}
function git(...args) {
  return execFileSync("git", args, { maxBuffer: OUTPUT_CAP });
}
function gitText(...args) {
  return git(...args)
    .toString("utf8")
    .trim();
}
function regular(path) {
  // Reject symlinks in each repository/artifact-relative component, not just the leaf.
  let current = path;
  while (current !== dirname(current)) {
    if (existsSync(current)) check(!lstatSync(current).isSymbolicLink(), `symlink: ${current}`);
    current = dirname(current);
  }
  check(lstatSync(path).isFile(), `not a regular file: ${path}`);
}

function buildExpectedProvenance(head) {
  check(/^[a-f0-9]{40}$/.test(head), "checkout HEAD shape");
  return { ...PINS, head, command: COMMAND, effectiveFlags: structuredClone(FLAGS) };
}
function assertIdentity(head, env, local) {
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    check(env.GITHUB_ACTIONS === "true", "unsupported CI identity");
    check(["pull_request", "merge_group"].includes(env.GITHUB_EVENT_NAME), "unknown CI checkout event");
    check(env.GITHUB_SHA === head, "CI checkout HEAD differs from GITHUB_SHA");
    check(local === undefined, "local approval cannot override CI");
  } else {
    check(local !== undefined, "explicit local parent manifest required");
    assert.deepEqual(
      local,
      buildExpectedProvenance(head),
      "local manifest differs from approved pins/HEAD/command/flags",
    );
  }
}
function readApprovedCheckout() {
  const root = realpathSync(gitText("rev-parse", "--show-toplevel"));
  check(realpathSync(process.cwd()) === root, "invoke from repository root");
  check(process.execArgv.length === 0, "unexpected runner profiling/diagnostic argv");
  for (const name of [
    "NODE_V8_COVERAGE",
    "TEST262_TARGET",
    "TEST262_RESULT_PREFIX",
    "VITE_NODE_OPTIONS",
    "VITEST_COVERAGE",
  ])
    check(!process.env[name], `unsupported inherited ${name}`);
  check(
    !/inspect|prof|trace|require|import|loader|conditions/i.test(process.env.NODE_OPTIONS ?? ""),
    "inherited profiling/diagnostic NODE_OPTIONS",
  );
  const head = gitText("rev-parse", "HEAD");
  let local;
  if (process.env.JS2WASM_APPEND_PARENT_MANIFEST !== undefined) {
    const path = process.env.JS2WASM_APPEND_PARENT_MANIFEST;
    check(isAbsolute(path), "local parent manifest must be an absolute path");
    regular(path);
    local = JSON.parse(readFileSync(path, "utf8"));
  }
  assertIdentity(head, process.env, local);
  return { root, head, expected: buildExpectedProvenance(head), local: local !== undefined };
}
function assertFrozenInputs(checkout) {
  const { root, head, expected, local } = checkout;
  check(gitText("rev-parse", "HEAD") === head, "HEAD drift");
  check(gitText("rev-parse", "HEAD:src") === expected.sourceTree, "unapproved source tree");
  check(
    gitText("status", "--porcelain", "--untracked-files=all", "--", "src", TEST, PATHS.fixture) === "",
    "dirty source/test/fixture",
  );
  const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all").toString("utf8");
  for (const entry of status.split("\0").filter(Boolean)) {
    check(!entry.slice(0, 2).includes("R") && !entry.slice(0, 2).includes("C"), "rename/copy in execution checkout");
    check(local && EDITABLE.includes(entry.slice(3)), `unapproved checkout edit: ${entry.slice(3)}`);
  }
  const files = {};
  const verify = (path, approvedHash) => {
    const absolute = join(root, path);
    regular(absolute);
    const bytes = readFileSync(absolute),
      committed = git("show", `${head}:${path}`);
    check(bytes.equals(committed), `worktree/git-object mismatch: ${path}`);
    const hash = sha256(bytes);
    if (approvedHash !== undefined) check(hash === approvedHash, `unapproved pin: ${path}`);
    files[path] = hash;
  };
  for (const [key, path] of Object.entries(PATHS)) verify(path, expected[key]);
  // Complete source population is the approved tree, with no symlink or dirty input.
  const entries = git("ls-tree", "-r", "HEAD", "--", "src").toString("utf8").trim().split("\n");
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
    check(match, `unsupported source entry: ${entry}`);
    verify(match[2]);
  }
  const configPaths = (ref) =>
    git("ls-tree", "-r", "--name-only", ref)
      .toString("utf8")
      .trim()
      .split("\n")
      .filter((path) =>
        /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|(?:vitest|vite|tsconfig)[^/]*\.(?:ts|js|mjs|json)|scripts\/test262-concurrency\.mjs)$/.test(
          path,
        ),
      );
  const configs = Object.keys(CONFIG_PINS);
  assert.deepEqual(configPaths(head), configs, "unapproved execution config population");
  check(configs.includes("vitest.config.ts") && configs.includes("pnpm-lock.yaml"), "missing execution config custody");
  for (const path of configs) verify(path, CONFIG_PINS[path]);
  for (const path of EDITABLE) {
    if (existsSync(join(root, path))) {
      regular(join(root, path));
      files[path] = sha256(readFileSync(join(root, path)));
    }
  }
  return {
    head,
    sourceTree: expected.sourceTree,
    branch: gitText("branch", "--show-current"),
    node: process.version,
    v8: process.versions.v8,
    files,
  };
}

// Inert data decoder: never install or call captured getters, functions or prototypes.
// Original descriptors/prototype labels stay in the accompanying raw graph archive.
export function decodeGraph(graph) {
  exactKeys(graph, ["root", "nodes"]);
  list(graph.nodes, MAX_NODES);
  let fieldCount = 0,
    byteCount = 0,
    textBytes = 0;
  const edges = graph.nodes.map(() => []);
  const countText = (text) => {
    check(typeof text === "string", "text type");
    textBytes += Buffer.byteLength(text);
    check(textBytes <= MAX_BYTES, "graph text cap");
  };
  const atom = (value, owner) => {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      countText(value);
      return;
    }
    if (typeof value === "number") {
      check(Number.isFinite(value) && !Object.is(value, -0), "untagged special number");
      return;
    }
    check(value !== null && typeof value === "object", "invalid scalar");
    if (Object.hasOwn(value, "ref")) {
      exactKeys(value, ["ref"]);
      integer(value.ref, graph.nodes.length - 1, "dangling reference");
      if (owner !== undefined) edges[owner].push(value.ref);
      return;
    }
    if (value.tag === "undefined") {
      exactKeys(value, ["tag"]);
      return;
    }
    if (value.tag === "bigint") {
      exactKeys(value, ["tag", "decimal"]);
      countText(value.decimal);
      check(
        /^(0|-?[1-9][0-9]*)$/.test(value.decimal) && BigInt(value.decimal).toString() === value.decimal,
        "noncanonical bigint",
      );
      return;
    }
    exactKeys(value, ["tag", "value"]);
    check(
      value.tag === "number" && ["nan", "+infinity", "-infinity", "-0"].includes(value.value),
      "unknown scalar tag",
    );
  };
  const values = [];
  const bytes = (node) => {
    integer(node.byteLength, MAX_BYTES, "buffer cap");
    countText(node.bytesBase64);
    const data = Buffer.from(node.bytesBase64, "base64");
    check(
      data.length === node.byteLength && data.toString("base64") === node.bytesBase64,
      "lost/noncanonical buffer bytes",
    );
    byteCount += data.length;
    check(byteCount <= MAX_BYTES, "graph byte cap");
    return data;
  };
  const common = ["id", "kind", "prototype", "properties"];
  atom(graph.root);
  for (const [index, node] of graph.nodes.entries()) {
    check(node.id === index, "duplicate/noncanonical node ID");
    countText(node.prototype);
    list(node.properties);
    const keys = new Set();
    for (const property of node.properties) {
      exactKeys(
        property,
        property.descriptor === "data"
          ? ["key", "value", "descriptor", "enumerable", "configurable", "writable"]
          : ["key", "value", "descriptor", "getter", "setter", "enumerable", "configurable"],
      );
      countText(property.key);
      check(!keys.has(property.key), "duplicate property");
      keys.add(property.key);
      check(++fieldCount <= MAX_FIELDS, "graph field cap");
      if (property.descriptor === "data")
        check(
          [property.enumerable, property.configurable, property.writable].every((x) => typeof x === "boolean"),
          "descriptor flags",
        );
      else
        check(
          property.descriptor === "native-error-stack" &&
            node.kind === "error" &&
            property.key === "stack" &&
            property.getter === "fresh-native-error-getter" &&
            property.setter === "fresh-native-error-setter" &&
            property.enumerable === false &&
            property.configurable === true &&
            typeof property.value === "string",
          "unsupported accessor marker",
        );
      atom(property.value, index);
    }
    if (["object", "array", "error"].includes(node.kind)) {
      exactKeys(node, common);
      if (node.kind === "array") {
        const length = node.properties.find((property) => property.key === "length");
        check(
          length?.descriptor === "data" && length.enumerable === false && length.configurable === false,
          "explicit array length descriptor",
        );
        integer(length.value, MAX_FIELDS, "array length");
        for (const property of node.properties) {
          if (/^(0|[1-9][0-9]*)$/.test(property.key) && Number(property.key) < 0xffff_ffff)
            check(Number(property.key) < length.value, "array indexed property beyond length");
        }
      }
      values.push(node.kind === "array" ? [] : Object.create(null));
    } else if (node.kind === "map" || node.kind === "set") {
      const collection = node.kind === "map" ? node.entries : node.values;
      exactKeys(node, [...common, "size", node.kind === "map" ? "entries" : "values"]);
      list(collection);
      integer(node.size, MAX_FIELDS, "collection size");
      check(collection.length === node.size, "lost collection entries");
      fieldCount += collection.length * (node.kind === "map" ? 2 : 1);
      check(fieldCount <= MAX_FIELDS, "graph field cap");
      const encodedKeys = new Set();
      for (const item of collection) {
        if (node.kind === "map") {
          list(item, 2);
          check(item.length === 2, "map pair");
          atom(item[0], index);
          atom(item[1], index);
        } else atom(item, index);
        const key = JSON.stringify(node.kind === "map" ? item[0] : item);
        check(!encodedKeys.has(key), "duplicate collection entry");
        encodedKeys.add(key);
      }
      values.push(node.kind === "map" ? new Map() : new Set());
    } else if (node.kind === "array-buffer") {
      exactKeys(node, [...common, "byteLength", "bytesBase64"]);
      const data = bytes(node);
      values.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else {
      check(["typed-array", "data-view"].includes(node.kind), "unknown graph node");
      exactKeys(node, [...common, "byteLength", "byteOffset", "buffer", "bytesBase64"]);
      bytes(node);
      integer(node.byteOffset, MAX_BYTES, "view offset");
      atom(node.buffer, index);
      check(
        node.buffer !== null && typeof node.buffer === "object" && Object.hasOwn(node.buffer, "ref"),
        "view buffer reference",
      );
      values.push(null);
    }
  }
  const constructors = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  for (const node of graph.nodes)
    if (node.kind === "typed-array" || node.kind === "data-view") {
      const bufferNode = graph.nodes[node.buffer.ref],
        buffer = values[node.buffer.ref];
      check(
        bufferNode.kind === "array-buffer" && node.byteOffset + node.byteLength <= bufferNode.byteLength,
        "view outside backing",
      );
      check(
        Buffer.from(buffer, node.byteOffset, node.byteLength).toString("base64") === node.bytesBase64,
        "view/backing disagreement",
      );
      if (node.kind === "data-view") {
        check(node.prototype === "DataView", "view prototype");
        values[node.id] = new DataView(buffer, node.byteOffset, node.byteLength);
      } else {
        check(Object.hasOwn(constructors, node.prototype), "unsupported typed-array prototype");
        const ctor = constructors[node.prototype];
        check(
          node.byteOffset % ctor.BYTES_PER_ELEMENT === 0 && node.byteLength % ctor.BYTES_PER_ELEMENT === 0,
          "misaligned typed view",
        );
        values[node.id] = new ctor(buffer, node.byteOffset, node.byteLength / ctor.BYTES_PER_ELEMENT);
      }
    }
  const decode = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (Object.hasOwn(value, "ref")) return values[value.ref];
    if (value.tag === "bigint") return BigInt(value.decimal);
    if (value.tag === "undefined") return undefined;
    return { nan: NaN, "+infinity": Infinity, "-infinity": -Infinity, "-0": -0 }[value.value];
  };
  for (const node of graph.nodes) {
    const value = values[node.id];
    if (node.kind === "map") {
      for (const [key, item] of node.entries) value.set(decode(key), decode(item));
      check(value.size === node.size, "decoded duplicate map keys");
    }
    if (node.kind === "set") {
      for (const item of node.values) value.add(decode(item));
      check(value.size === node.size, "decoded duplicate set values");
    }
    // Length must be installed last for frozen arrays, after every indexed field.
    for (const property of [...node.properties].sort((a, b) => (a.key === "length") - (b.key === "length"))) {
      const data = decode(property.value);
      Object.defineProperty(value, property.key, {
        value: data,
        enumerable: property.enumerable,
        configurable: property.configurable,
        writable: property.descriptor === "data" ? property.writable : false,
      });
    }
  }
  // Indexed own properties on a typed array write through into its backing
  // store. Recheck every buffer AND view after all property hydration.
  for (const node of graph.nodes) {
    if (node.kind === "array-buffer")
      check(
        Buffer.from(values[node.id]).toString("base64") === node.bytesBase64,
        "hydrated backing buffer disagreement",
      );
    if (node.kind === "typed-array" || node.kind === "data-view")
      check(
        Buffer.from(values[node.buffer.ref], node.byteOffset, node.byteLength).toString("base64") === node.bytesBase64,
        "hydrated view/backing disagreement",
      );
  }
  const reached = new Set(),
    pending = graph.root && typeof graph.root === "object" && Object.hasOwn(graph.root, "ref") ? [graph.root.ref] : [];
  while (pending.length) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...edges[id]);
  }
  check(reached.size === graph.nodes.length, "orphaned graph node");
  return decode(graph.root);
}

export function validateAppendReceipt(records, reporter, expected) {
  check(records.length === 38, "expected exactly 38 complete records");
  const [provenance, ...rest] = records,
    completion = rest.pop();
  exactKeys(provenance, [
    "kind",
    "schema",
    "issue",
    "head",
    "sourceTree",
    "baseline",
    "baselineSourceTree",
    "sourceDirty",
    "testSha256",
    "fixtureSha256",
    "productionHashes",
    "options",
    "node",
    "v8",
    "execArgv",
    "argv",
    "nodeOptions",
    "linearIrFlag",
    "command",
    "ids",
    "expectedObservations",
  ]);
  check(
    provenance.kind === "provenance" &&
      provenance.schema === "6915-append-baseline-v2" &&
      provenance.issue === 6915 &&
      provenance.expectedObservations === 36,
    "provenance schema",
  );
  for (const [field, wanted] of Object.entries(expected)) {
    if (["runtime", "consumer", "integration"].includes(field))
      check(provenance.productionHashes[field] === wanted, `provenance ${field}`);
    else if (field === "fixture") check(provenance.fixtureSha256 === wanted, "provenance fixture");
    else if (field !== "effectiveFlags") check(provenance[field] === wanted, `provenance ${field}`);
  }
  exactKeys(provenance.productionHashes, ["runtime", "consumer", "integration"]);
  check(
    provenance.sourceDirty === "" &&
      provenance.baseline === "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438" &&
      provenance.baselineSourceTree === "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8",
    "source/historical provenance",
  );
  check(provenance.linearIrFlag === "1" && provenance.nodeOptions === null, "effective environment");
  assert.deepEqual(provenance.execArgv, FLAGS.execArgv, "unexpected worker argv");
  check(provenance.node === process.version && provenance.v8 === process.versions.v8, "worker toolchain mismatch");
  exactKeys(provenance.options, ["target", "allocator", "fileName"]);
  check(
    provenance.options.target === "linear" &&
      provenance.options.allocator === "bump" &&
      provenance.options.fileName === PATHS.fixture,
    "source options",
  );
  list(provenance.argv, 256);
  check(
    provenance.argv.every((item) => typeof item === "string"),
    "worker argv type",
  );
  assert.deepEqual(provenance.ids, IDS, "reviewed provenance IDs");
  const observed = [];
  for (const record of rest) {
    exactKeys(record, ["kind", "id", "passed", "evidence", "action", "schema", "emission"]);
    check(
      record.kind === "observation" && IDS.includes(record.id) && !observed.includes(record.id),
      "unexpected/duplicate observation ID",
    );
    check(record.passed === true, `failed observation ${record.id}`);
    for (const name of ["action", "schema", "emission"]) {
      exactKeys(record[name], ["status"]);
      check(record[name].status === "passed", `${record.id} ${name} failed`);
    }
    validateWitness(record.evidence, record.id);
    observed.push(record.id);
  }
  assert.deepEqual(observed, IDS, "missing/reordered observation population");
  exactKeys(completion, [
    "kind",
    "ids",
    "duplicates",
    "missing",
    "unexpected",
    "failures",
    "actionFailures",
    "schemaFailures",
    "emissionFailures",
    "cleanupErrors",
    "passed",
    "expectedObservations",
  ]);
  check(
    completion.kind === "completion" && completion.passed === true && completion.expectedObservations === 36,
    "completion status",
  );
  assert.deepEqual(completion.ids, observed, "completion population");
  for (const name of [
    "duplicates",
    "missing",
    "unexpected",
    "failures",
    "actionFailures",
    "schemaFailures",
    "emissionFailures",
    "cleanupErrors",
  ])
    assert.deepEqual(completion[name], [], `completion ${name}`);
  check(reporter.success === true, "reporter success");
  for (const [name, count] of Object.entries({
    numTotalTests: 36,
    numPassedTests: 36,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
  }))
    check(reporter[name] === count, `reporter ${name}`);
  list(reporter.testResults, 1);
  check(reporter.testResults.length === 1, "reporter file count");
  integer(reporter.numTotalTestSuites, 100, "reporter suite population");
  check(
    reporter.numTotalTestSuites > 0 && reporter.numPassedTestSuites === reporter.numTotalTestSuites,
    "reporter passing suites",
  );
  const result = reporter.testResults[0];
  check(
    resolve(result.name) === resolve(TEST) && result.status === "passed" && result.message === "",
    "reporter suite/error",
  );
  list(result.assertionResults, 36);
  check(result.assertionResults.length === 36, "reporter assertion population");
  check(new Set(result.assertionResults.map((item) => item.fullName)).size === 36, "reporter duplicate assertions");
  const reportedIds = result.assertionResults.map((item) => {
    check(typeof item.title === "string", "reporter title");
    const match = /^(Runtime\d{2}|Source\d{2}|Import\d{2}|Negative\d{2}): /.exec(item.title);
    check(match && IDS.includes(match[1]), "reporter missing/replaced observation ID");
    check(item.fullName === `#6915 independently owned append baseline ${item.title}`, "reporter title/fullName join");
    return match[1];
  });
  assert.deepEqual(reportedIds, IDS, "reporter/observation ID population");
  for (const item of result.assertionResults) {
    check(item.status === "passed", "reporter skipped/failed assertion");
    assert.deepEqual(item.failureMessages, [], "reporter failure text");
  }
  // Vitest's JSON reporter has no unhandled-error count: strict exit0 is required
  // separately, never replaced by reporter.success (which ignores that channel).
  for (const key of ["errors", "unhandledErrors"])
    if (Object.hasOwn(reporter, key)) assert.deepEqual(reporter[key], [], `reporter ${key}`);
}
// Retained witness shape/binary/byte custody only; semantic assertion authority
// stays in the independently pinned test, not a second compiler/test implementation.
export function validateWitness(proof, id, corrupted = false) {
  check(proof !== null && typeof proof === "object", "missing full evidence");
  if (id.startsWith("Negative") && !corrupted) {
    exactKeys(proof, ["stage", "mutation", "original", "corrupted", "rejected", "rejection"]);
    check(
      proof.stage === "negative" &&
        proof.rejected === true &&
        typeof proof.mutation === "string" &&
        typeof proof.rejection === "string" &&
        proof.rejection.length > 0,
      "negative rejection witness",
    );
    const index = Number(id.slice("Negative".length)) - 1;
    check(proof.mutation === NEGATIVE_MUTATIONS[index], "reviewed negative mutation identity");
    const kind = index >= 1 && index <= 3 ? "source" : "runtime";
    check(proof.original?.kind === kind && proof.corrupted?.kind === kind, "negative cohort witness kind");
    validateWitness(proof.original, "retained-original");
    validateWitness(proof.corrupted, "retained-corrupted", true);
    return;
  }
  const runtime = proof.kind === "runtime";
  check(runtime || proof.kind === "source", "incomplete positive evidence");
  if (id.startsWith("Source")) check(!runtime, "source cohort witness kind");
  if (id.startsWith("Runtime") || id.startsWith("Import")) check(runtime, "runtime/import cohort witness kind");
  if (id.startsWith("Import")) check(proof.imported === true, "import cohort custody");
  if (id.startsWith("Runtime")) check(proof.imported === false, "runtime cohort custody");
  exactKeys(
    proof,
    runtime
      ? ["kind", "module", "artifact", "binding", "construction", "transitions", "hostCalls", "imported"]
      : [
          "kind",
          "source",
          "sourceSha256",
          "options",
          "input",
          "expected",
          "native",
          "actual",
          "module",
          "artifact",
          "binding",
          "report",
          "receipt",
          "registrationModules",
          "logical",
          "physical",
          "ownerUnitId",
          "callIndices",
          "appendExecutionAuthority",
        ],
  );
  exactKeys(proof.artifact, ["binaryBase64", "sha256", "byteLength", "valid"]);
  const binary = Buffer.from(proof.artifact.binaryBase64, "base64");
  check(
    binary.length > 8 &&
      binary.length === proof.artifact.byteLength &&
      binary.toString("base64") === proof.artifact.binaryBase64 &&
      sha256(binary) === proof.artifact.sha256 &&
      proof.artifact.valid === true,
    "complete binary witness",
  );
  check(proof.module !== null && typeof proof.module === "object", "module witness");
  exactKeys(proof.binding, ["index", "imports", "helper", "mallocIndex"]);
  check(
    proof.binding.helper !== null &&
      typeof proof.binding.helper === "object" &&
      Array.isArray(proof.binding.helper.body),
    "full kernel body witness",
  );
  if (!corrupted) {
    list(proof.module.imports);
    list(proof.module.functions);
    const imports = proof.module.imports.filter((item) => item.desc.kind === "func").length;
    integer(proof.binding.index, MAX_NODES, "defined helper index");
    check(
      proof.binding.imports === imports &&
        proof.binding.index >= imports &&
        proof.module.functions[proof.binding.index - imports] === proof.binding.helper,
      "module defined-helper index join",
    );
    check(proof.binding.helper.name === "__linear_ir_str_append_ascii", "actual append helper identity");
  }
  if (runtime) {
    list(proof.construction, 128);
    check(proof.construction.length > 0, "construction population");
    for (const entry of proof.construction)
      exactKeys(entry, ["kind", "bytes", "rawPointer", "canonicalPointer", "pointer", "seedEmptyPointer"]);
    list(proof.transitions, 33);
    check(proof.transitions.length === (id === "Runtime22" ? 33 : 1), "runtime transition population");
    for (const step of proof.transitions) {
      exactKeys(step, [
        "before",
        "after",
        "left",
        "right",
        "result",
        "heapDelta",
        "inferredAllocations",
        "allocationCountAuthority",
      ]);
      for (const state of [step.before, step.after]) {
        exactKeys(state, ["memoryBase64", "byteLength", "heap"]);
        const memory = Buffer.from(state.memoryBase64, "base64");
        check(
          memory.length === state.byteLength && memory.length > 0 && memory.toString("base64") === state.memoryBase64,
          "complete memory witness",
        );
      }
      for (const carrier of [step.left, step.right, step.result]) {
        exactKeys(carrier, ["pointer", "header", "capacity", "length", "payload"]);
        check(
          Array.isArray(carrier.header) &&
            carrier.header.length === 12 &&
            Array.isArray(carrier.payload) &&
            carrier.payload.length === carrier.length,
          "full carrier header/payload",
        );
      }
    }
  } else {
    check(typeof proof.source === "string" && sha256(proof.source) === proof.sourceSha256, "complete source witness");
    // Corruption controls deliberately break one authentic join; retain them,
    // but never require their corrupted identity/value to pass positive semantics.
    if (!corrupted) {
      check(
        proof.receipt.completed === true && proof.receipt.backend === "linear" && proof.receipt.failure === undefined,
        "completed Linear consumer receipt",
      );
      check(
        proof.registrationModules.includes(proof.module) && proof.receipt.moduleSession === proof.module,
        "actual source module join",
      );
      check(
        proof.report.frozenBodyBatch === proof.receipt.batch && proof.report.irModule === proof.receipt.batch.module,
        "actual source batch join",
      );
      check(
        proof.report.funcs instanceof Map &&
          proof.report.funcs.get(proof.ownerUnitId) === proof.physical &&
          proof.module.functions.includes(proof.physical),
        "actual owner/physical body join",
      );
      check(
        proof.logical.name === "run" &&
          proof.logical.unitId === proof.ownerUnitId &&
          proof.receipt.batch.module.functions.includes(proof.logical),
        "logical run owner join",
      );
      const outputs = proof.receipt.outputs.filter((output) => output.ownerUnitId === proof.ownerUnitId);
      check(
        outputs.length === 1 && outputs[0].func === proof.logical && outputs[0].body === proof.physical.body,
        "consumed output/physical body join",
      );
      check(
        proof.receipt.batch.owners.some(
          (owner) => owner.ownerUnitId === proof.ownerUnitId && owner.legacyName === "run" && owner.outcome === "built",
        ),
        "batch built owner join",
      );
      assert.deepEqual(proof.report.compiled, ["run"]);
      assert.deepEqual(proof.report.rejected, []);
      check(
        proof.report.ownerEvidence.some(
          (owner) =>
            owner.ownerUnitId === proof.ownerUnitId && owner.legacyName === "run" && owner.outcome === "compiled",
        ),
        "compiled run owner join",
      );
      const calls = [],
        pending = [proof.physical.body],
        seen = new Set();
      while (pending.length) {
        const item = pending.pop();
        if (item === null || typeof item !== "object" || seen.has(item)) continue;
        seen.add(item);
        if (item.op === "call") {
          integer(item.funcIdx, Number.MAX_SAFE_INTEGER, "physical call handle");
          // Observe the frozen module's existing live/stable handle custody;
          // no lowering, layout mutation or resolver imports occur here.
          const index =
            item.funcIdx < 2 ** 21
              ? item.funcIdx
              : proof.binding.imports + proof.module.funcOrdinalToPosition[item.funcIdx - 2 ** 21];
          integer(index, proof.module.functions.length + proof.binding.imports - 1, "physical call index");
          calls.push(index);
        }
        pending.push(...Object.values(item).reverse());
      }
      assert.deepEqual(proof.callIndices, calls, "physical callIndices/body join");
      check(calls.includes(proof.binding.index), "actual append call binding");
      check(
        proof.appendExecutionAuthority === "physical-call-binding-not-dynamic-counter",
        "append execution authority",
      );
    }
  }
}
export function readRecords(stdout, stderr) {
  const records = [],
    envelopes = [],
    diagnostics = [],
    errors = [];
  for (const stream of [stdout, stderr]) {
    const lines = stream.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes('"schema":"6915-')) continue;
      try {
        check(index < lines.length - 1, "unterminated evidence line");
        check(line.startsWith("{"), "prefixed/truncated evidence envelope");
        const envelope = JSON.parse(line);
        if (envelope.schema === "6915-incomplete-evidence-v1") {
          exactKeys(envelope, [
            "schema",
            "issue",
            "kind",
            "id",
            "passed",
            "actionFailure",
            "schemaFailure",
            "emissionFailure",
          ]);
          check(
            envelope.issue === 6915 && envelope.kind === "diagnostic" && envelope.passed === false,
            "diagnostic format",
          );
          diagnostics.push(envelope);
          continue;
        }
        exactKeys(envelope, ["schema", "issue", "kind", "id", "graph"]);
        check(envelope.schema === "6915-evidence-graph-v1" && envelope.issue === 6915, "unknown evidence envelope");
        const record = decodeGraph(envelope.graph);
        check(
          record.kind === envelope.kind && envelope.id === (record.kind === "observation" ? record.id : null),
          "envelope/record disagreement",
        );
        envelopes.push(envelope);
        records.push(record);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (diagnostics.length) errors.push(new Error("6915 parent: failed diagnostic/incomplete evidence"));
  return { records, envelopes, diagnostics, errors };
}

async function runAppendQualification() {
  const checkout = readApprovedCheckout();
  const directory = join(checkout.root, ".tmp/6915-ci");
  for (const path of [join(checkout.root, ".tmp"), directory]) {
    if (!existsSync(path)) mkdirSync(path);
    check(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "artifact directory/symlink");
  }
  const lock = join(directory, "runner.lock"),
    lockFd = openSync(lock, "wx");
  let archive;
  try {
    archive = mkdtempSync(join(directory, "run-"));
  } catch (primary) {
    const failures = [primary];
    try {
      closeSync(lockFd);
    } catch (error) {
      failures.push(error);
    }
    try {
      unlinkSync(lock);
    } catch (error) {
      failures.push(error);
    }
    throw new AggregateError(failures, "6915 artifact setup failed", { cause: primary });
  }
  const save = (name, value) => writeFileSync(join(archive, name), value);
  const json = (name, value) => save(name, JSON.stringify(value, null, 2) + "\n");
  const errors = [],
    receipt = { code: null, signal: null, killed: false, bytes: 0, elapsedMs: 0, spawnError: null, failures: [] };
  let before;
  const fds = [];
  try {
    json("expected.json", checkout.expected);
    json("command.json", { executable: "pnpm", argv: ARGV, timeoutMs: TIMEOUT_MS, outputCap: OUTPUT_CAP });
    before = assertFrozenInputs(checkout);
    json("before.json", before);
    const reportPath = join(directory, "observations.json");
    if (existsSync(reportPath)) {
      regular(reportPath);
      renameSync(reportPath, join(archive, "previous-reporter.json"));
    }
    const env = {
      ...process.env,
      JS2WASM_LINEAR_IR: "1",
      VITEST_FORK_MAX_OLD_SPACE_SIZE: "4096",
      NODE_ENV: "test",
      JS2WASM_APPEND_TEST_COMMAND: COMMAND,
      JS2WASM_APPEND_EXPECTED_PROVENANCE: JSON.stringify(checkout.expected),
    };
    delete env.NODE_OPTIONS;
    delete env.JS2WASM_APPEND_PARENT_MANIFEST;
    for (const name of ["stdout.log", "stderr.log"]) fds.push(openSync(join(archive, name), "wx"));
    const start = Date.now();
    let killed = false,
      bytes = 0,
      spawnError;
    const child = spawn("pnpm", ARGV, {
      cwd: checkout.root,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => {
      killed = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") spawnError = error;
      }
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    const interrupted = () => stop();
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    for (const [index, stream] of [child.stdout, child.stderr].entries())
      stream.on("data", (chunk) => {
        try {
          bytes += chunk.length;
          let offset = 0;
          while (offset < chunk.length) {
            const written = writeSync(fds[index], chunk, offset, chunk.length - offset);
            check(written > 0, "raw output write stalled");
            offset += written;
          }
          if (bytes > OUTPUT_CAP) stop();
        } catch (error) {
          errors.push(error);
          stop();
        }
      });
    child.on("error", (error) => {
      spawnError = error;
    });
    const exit = await new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
    clearTimeout(timer);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    Object.assign(receipt, exit, {
      killed,
      bytes,
      elapsedMs: Date.now() - start,
      spawnError: spawnError?.stack ?? null,
    });
    try {
      check(
        exit.code === 0 && exit.signal === null && !killed && spawnError === undefined,
        "strict child exit/timeout/output cap",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      if (existsSync(reportPath)) {
        regular(reportPath);
        save("reporter.json", readFileSync(reportPath));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      const stdout = readFileSync(join(archive, "stdout.log"), "utf8"),
        stderr = readFileSync(join(archive, "stderr.log"), "utf8");
      const { records, envelopes, diagnostics, errors: decodeErrors } = readRecords(stdout, stderr);
      save("graphs.ndjson", envelopes.map((row) => JSON.stringify(row)).join("\n") + "\n");
      save("decoded.v8", serialize(records));
      json("diagnostics.json", diagnostics);
      if (decodeErrors.length) throw new AggregateError(decodeErrors, "evidence decoding failed");
      check(existsSync(reportPath), "missing JSON reporter");
      validateAppendReceipt(records, JSON.parse(readFileSync(reportPath, "utf8")), checkout.expected);
    } catch (error) {
      errors.push(error);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      const after = assertFrozenInputs(checkout);
      json("after.json", after);
      if (before !== undefined) assert.deepEqual(after, before, "post-run custody drift");
    } catch (error) {
      errors.push(error);
      try {
        json("after-failure.json", { error: error.stack });
      } catch (writeError) {
        errors.push(writeError);
      }
    }
    for (const fd of [...fds, lockFd])
      try {
        closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    try {
      unlinkSync(lock);
    } catch (error) {
      errors.push(error);
    }
  }
  console.log(`6915 parent: evidence retained at ${archive}`);
  // Native Error serialization is lossy. Serialize only detached plain data,
  // with aggregate members/causes/custom fields and descriptor/reference custody.
  // Raw child graphs remain authoritative. Unevaluated accessor markers are
  // explicitly incomplete parent diagnostics, not captured getter results.
  try {
    save("runner-errors.v8", serialize(detachErrors(errors)));
  } catch (error) {
    errors.push(error);
  }
  receipt.failures = errors.map((error) => error.stack);
  try {
    json("receipt.json", receipt);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "6915 parent qualification failed", { cause: errors[0] });
}

function selfTest() {
  let passed = 0;
  const good = (action) => {
    action();
    passed++;
  };
  const bad = (action) => {
    assert.throws(action);
    passed++;
  };
  const expected = buildExpectedProvenance(APPROVAL_COMMIT);
  good(() => assertIdentity(APPROVAL_COMMIT, {}, expected));
  good(() =>
    assertIdentity(APPROVAL_COMMIT, {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: APPROVAL_COMMIT,
    }),
  );
  bad(() => assertIdentity(APPROVAL_COMMIT, {}));
  bad(() => assertIdentity(APPROVAL_COMMIT, {}, { ...expected, runtime: "0".repeat(64) }));
  bad(() =>
    assertIdentity(APPROVAL_COMMIT, {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: APPROVAL_COMMIT,
    }),
  );
  bad(() =>
    assertIdentity(APPROVAL_COMMIT, {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: "0".repeat(40),
    }),
  );
  const prop = (key, value) => ({
    key,
    value,
    descriptor: "data",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const graph = {
    root: { ref: 0 },
    nodes: [
      {
        id: 0,
        kind: "object",
        prototype: "Object",
        properties: [
          prop("self", { ref: 0 }),
          prop("map", { ref: 1 }),
          prop("view", { ref: 3 }),
          prop("buffer", { ref: 2 }),
          prop("undef", { tag: "undefined" }),
          prop("big", { tag: "bigint", decimal: "12345678901234567890" }),
          prop("nan", { tag: "number", value: "nan" }),
          prop("minusZero", { tag: "number", value: "-0" }),
          prop("error", { ref: 4 }),
        ],
      },
      { id: 1, kind: "map", prototype: "FrozenMap", properties: [], size: 1, entries: [[{ ref: 0 }, { ref: 0 }]] },
      { id: 2, kind: "array-buffer", prototype: "ArrayBuffer", properties: [], byteLength: 3, bytesBase64: "AQID" },
      {
        id: 3,
        kind: "typed-array",
        prototype: "Uint8Array",
        properties: [],
        byteOffset: 1,
        byteLength: 2,
        bytesBase64: "AgM=",
        buffer: { ref: 2 },
      },
      {
        id: 4,
        kind: "error",
        prototype: "Error",
        properties: [
          prop("message", "full error"),
          prop("cause", { ref: 0 }),
          {
            key: "stack",
            value: "full native stack",
            descriptor: "native-error-stack",
            getter: "fresh-native-error-getter",
            setter: "fresh-native-error-setter",
            enumerable: false,
            configurable: true,
          },
        ],
      },
    ],
  };
  good(() => {
    const value = decodeGraph(graph);
    assert.equal(value.self, value);
    assert.equal(value.map.get(value), value);
    assert.equal(value.view.buffer, value.buffer);
    assert.equal(value.error.cause, value);
    assert.equal(value.error.stack, "full native stack");
    assert.equal(Object.getOwnPropertyDescriptor(value.error, "stack").get, undefined);
    check(Number.isNaN(value.nan) && Object.is(value.minusZero, -0), "scalar preservation");
    assert.equal(value.big, 12345678901234567890n);
  });
  for (const mutate of [
    (g) => {
      g.nodes[0].properties[0].value.ref = 99;
    },
    (g) => {
      g.nodes[1].id = 0;
    },
    (g) => {
      g.nodes[1].entries = [];
    },
    (g) => {
      g.nodes[3].bytesBase64 = "BAU=";
    },
    (g) => {
      g.nodes[4].properties[2].getter = "arbitrary-getter";
    },
    (g) => {
      g.nodes.push({ id: 5, kind: "object", prototype: "Object", properties: [] });
    },
    (g) => {
      g.nodes[0].properties.push(g.nodes[0].properties[0]);
    },
    (g) => {
      g.nodes[3].prototype = "CapturedArbitraryConstructor";
    },
    (g) => {
      g.nodes[4].properties[2].configurable = false;
    },
    (g) => {
      g.nodes[3].properties.push(prop("0", 99));
    },
  ])
    bad(() => {
      const copy = structuredClone(graph);
      mutate(copy);
      decodeGraph(copy);
    });
  bad(() => validateAppendReceipt([], {}, expected));
  const sparse = {
    root: { ref: 0 },
    nodes: [
      {
        id: 0,
        kind: "array",
        prototype: "Array",
        properties: [
          prop("2", { ref: 1 }),
          { key: "length", value: 3, descriptor: "data", enumerable: false, configurable: false, writable: false },
        ],
      },
      { id: 1, kind: "object", prototype: "Object", properties: [] },
    ],
  };
  good(() => {
    const value = decodeGraph(sparse);
    assert.equal(value.length, 3);
    assert.equal(0 in value, false);
    assert.equal(typeof value[2], "object");
  });
  bad(() => {
    const copy = structuredClone(sparse);
    copy.nodes[0].properties[1].value = 0;
    decodeGraph(copy);
  });
  // Synthetic parser witnesses exercise receipt gates only, never runtime proof.
  const binary = Buffer.from("synthetic-parser-witness");
  const proof = {
    kind: "runtime",
    module: { imports: [], functions: [] },
    artifact: {
      binaryBase64: binary.toString("base64"),
      sha256: sha256(binary),
      byteLength: binary.length,
      valid: true,
    },
    binding: { index: 0, imports: 0, mallocIndex: 0, helper: { name: "__linear_ir_str_append_ascii", body: [] } },
    construction: [{ kind: "C", bytes: [], rawPointer: 0, canonicalPointer: 0, pointer: 0, seedEmptyPointer: null }],
    transitions: [
      {
        before: { memoryBase64: "AA==", byteLength: 1, heap: 0 },
        after: { memoryBase64: "AA==", byteLength: 1, heap: 0 },
        left: { pointer: 0, header: Array(12).fill(0), capacity: 0, length: 0, payload: [] },
        right: { pointer: 0, header: Array(12).fill(0), capacity: 0, length: 0, payload: [] },
        result: { pointer: 0, header: Array(12).fill(0), capacity: 0, length: 0, payload: [] },
        heapDelta: 0,
        inferredAllocations: 0,
        allocationCountAuthority: "installed-single-growth-malloc-call",
      },
    ],
    hostCalls: { unrelated: 0, namesake: 0 },
    imported: false,
  };
  proof.module.functions.push(proof.binding.helper);
  const syntheticSource = (artifact) => {
    const helper = { name: "__linear_ir_str_append_ascii", body: [] };
    const physical = { body: [{ op: "call", funcIdx: 0 }] };
    const module = { imports: [], functions: [helper, physical] };
    const logical = { name: "run", unitId: "owner" };
    const batch = {
      module: { functions: [logical] },
      owners: [{ ownerUnitId: "owner", legacyName: "run", outcome: "built" }],
    };
    return {
      kind: "source",
      source: "synthetic",
      sourceSha256: sha256("synthetic"),
      options: {},
      input: 0,
      expected: 0,
      native: 0,
      actual: 0,
      module,
      artifact,
      binding: { index: 0, imports: 0, mallocIndex: 0, helper },
      report: {
        compiled: ["run"],
        rejected: [],
        ownerEvidence: [{ ownerUnitId: "owner", legacyName: "run", outcome: "compiled" }],
        frozenBodyBatch: batch,
        irModule: batch.module,
        funcs: new Map([["owner", physical]]),
      },
      receipt: {
        batch,
        moduleSession: module,
        backend: "linear",
        completed: true,
        outputs: [{ ownerUnitId: "owner", func: logical, body: physical.body }],
      },
      registrationModules: [module],
      logical,
      physical,
      ownerUnitId: "owner",
      callIndices: [0],
      appendExecutionAuthority: "physical-call-binding-not-dynamic-counter",
    };
  };
  const records = [
    {
      kind: "provenance",
      schema: "6915-append-baseline-v2",
      issue: 6915,
      head: expected.head,
      sourceTree: expected.sourceTree,
      baseline: "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438",
      baselineSourceTree: "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8",
      sourceDirty: "",
      testSha256: expected.testSha256,
      fixtureSha256: expected.fixture,
      productionHashes: { runtime: expected.runtime, consumer: expected.consumer, integration: expected.integration },
      options: { target: "linear", allocator: "bump", fileName: PATHS.fixture },
      node: process.version,
      v8: process.versions.v8,
      execArgv: FLAGS.execArgv,
      argv: [],
      nodeOptions: null,
      linearIrFlag: "1",
      command: COMMAND,
      ids: IDS,
      expectedObservations: 36,
    },
    ...IDS.map((id) => {
      let evidence = structuredClone(proof);
      if (id.startsWith("Source") || ["Negative02", "Negative03", "Negative04"].includes(id))
        evidence = syntheticSource(evidence.artifact);
      if (id.startsWith("Import")) evidence.imported = true;
      if (id === "Runtime22")
        evidence.transitions = Array.from({ length: 33 }, () => structuredClone(proof.transitions[0]));
      return {
        kind: "observation",
        id,
        passed: true,
        evidence: id.startsWith("Negative")
          ? {
              stage: "negative",
              mutation: NEGATIVE_MUTATIONS[Number(id.slice("Negative".length)) - 1],
              original: evidence,
              corrupted: structuredClone(evidence),
              rejected: true,
              rejection: "synthetic rejected",
            }
          : evidence,
        action: { status: "passed" },
        schema: { status: "passed" },
        emission: { status: "passed" },
      };
    }),
    {
      kind: "completion",
      ids: IDS,
      duplicates: [],
      missing: [],
      unexpected: [],
      failures: [],
      actionFailures: [],
      schemaFailures: [],
      emissionFailures: [],
      cleanupErrors: [],
      passed: true,
      expectedObservations: 36,
    },
  ];
  const reporter = {
    success: true,
    numTotalTests: 36,
    numPassedTests: 36,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        name: resolve(TEST),
        status: "passed",
        message: "",
        assertionResults: IDS.map((id) => ({
          title: `${id}: synthetic`,
          fullName: `#6915 independently owned append baseline ${id}: synthetic`,
          status: "passed",
          failureMessages: [],
        })),
      },
    ],
  };
  good(() => validateAppendReceipt(records, reporter, expected));
  for (const mutate of [
    (r) => r.pop(),
    (r) => {
      r[2].id = r[1].id;
    },
    (r) => {
      r[0].head = "0".repeat(40);
    },
    (r) => {
      r[0].productionHashes.runtime = "0".repeat(64);
    },
    (r) => {
      r[0].sourceDirty = " M src/file.ts";
    },
    (r) => {
      r[0].execArgv[0] = "--max-old-space-size=1024";
    },
    (r) => {
      r[0].nodeOptions = "--inspect";
    },
    (r) => {
      r[0].command += " --dangerouslyIgnoreUnhandledErrors";
    },
    (r) => {
      r[1].passed = false;
    },
    (r) => {
      r[1].action = { status: "failed", error: { message: "retained" } };
    },
    (r) => {
      r[1].evidence.artifact.binaryBase64 = "";
    },
    (r) => {
      r[1].evidence.transitions[0].before.memoryBase64 = "";
    },
    (r) => {
      r[22].evidence.transitions.pop();
    },
    (r) => {
      r[29].evidence.corrupted = null;
    },
    (r) => {
      r[37].cleanupErrors = ["cleanup failure"];
    },
    (r) => {
      r[37].ids.pop();
    },
    (r) => {
      r[22].evidence = r[23].evidence;
    },
    (r) => {
      r[30].evidence.mutation = r[29].evidence.mutation;
    },
    (r) => {
      r[23].evidence.receipt.completed = false;
    },
    (r) => {
      r[23].evidence.receipt.outputs[0].body = [];
    },
    (r) => {
      r[23].evidence.binding.index++;
    },
    (r) => {
      r[23].evidence.callIndices[0]++;
    },
  ])
    bad(() => {
      const copy = structuredClone(records);
      mutate(copy);
      validateAppendReceipt(copy, reporter, expected);
    });
  for (const mutate of [
    (r) => {
      r.numPassedTests = 35;
    },
    (r) => {
      r.numPendingTests = 1;
    },
    (r) => {
      r.numTodoTests = 1;
    },
    (r) => {
      r.success = false;
    },
    (r) => {
      r.testResults[0].assertionResults[0].failureMessages = ["unhandled error"];
    },
    (r) => {
      r.testResults[0].name = "foreign.test.ts";
    },
    (r) => {
      r.unhandledErrors = ["fatal"];
    },
    (r) => {
      r.testResults[0].assertionResults[0].title = "Runtime99: replaced";
      r.testResults[0].assertionResults[0].fullName = "#6915 independently owned append baseline Runtime99: replaced";
    },
  ])
    bad(() => {
      const copy = structuredClone(reporter);
      mutate(copy);
      validateAppendReceipt(records, copy, expected);
    });
  good(() => {
    const error = new AggregateError([new Error("primary")], "aggregate", { cause: new Error("cause") });
    const detached = detachErrors(error).root;
    assert.equal(detached.errors[0].message, "primary");
    assert.equal(detached.cause.message, "cause");
  });
  good(() => {
    const inner = new Error("inner"),
      outer = new AggregateError([inner], "outer", { cause: inner });
    const backing = new ArrayBuffer(3),
      view = new Uint8Array(backing, 1, 2);
    view.set([2, 3]);
    inner.details = {
      undefinedValue: undefined,
      backing,
      view,
      map: new Map([[inner, outer]]),
      set: new Set([inner]),
      self: inner,
    };
    let getterCalls = 0;
    Object.defineProperty(inner, "untouchedGetter", {
      get() {
        getterCalls++;
        return "must not execute";
      },
      configurable: true,
    });
    const lossy = deserialize(serialize(outer));
    assert.equal(lossy.errors, undefined);
    assert.equal(lossy.cause.details, undefined);
    const restored = deserialize(serialize(detachErrors(outer)));
    const recovered = restored.root.cause;
    assert.equal(restored.root.errors[0], recovered);
    assert.equal(recovered.details.self, recovered);
    assert.equal(recovered.details.map.entries[0][0], recovered);
    assert.equal(recovered.details.map.entries[0][1], restored.root);
    assert.equal(recovered.details.set.values[0], recovered);
    assert.equal(recovered.details.view.buffer, recovered.details.backing);
    assert.equal(recovered.details.view.bytesBase64, "AgM=");
    assert.equal(recovered.details.undefinedValue, undefined);
    assert.equal(getterCalls, 0);
    assert.equal(
      restored.descriptors
        .find((entry) => entry.object === recovered)
        .properties.find((entry) => entry.key === "untouchedGetter").getterPresent,
      true,
    );
  });
  good(() => {
    const parsed = readRecords(
      '{"schema":"6915-incomplete-evidence-v1","issue":6915,"kind":"diagnostic","id":null,"passed":false,"actionFailure":"full","schemaFailure":null,"emissionFailure":null}\n',
      "",
    );
    assert.equal(parsed.diagnostics.length, 1);
    assert.equal(parsed.errors.length, 1);
  });
  console.log(`6915 parent self-test: ${passed} controls passed (no compiler/test execution)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  try {
    if (process.argv.length === 3 && process.argv[2] === "--self-test") selfTest();
    else {
      check(process.argv.length === 2, "usage: node scripts/hooks/run-linear-append-provenance.mjs [--self-test]");
      await runAppendQualification();
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
