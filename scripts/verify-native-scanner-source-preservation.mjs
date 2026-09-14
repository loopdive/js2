// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Import-safe proofs and explicit three-arm CLI. Never refreshes a golden baseline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
const sha = (value) => createHash("sha256").update(value).digest("hex");
// This is the sole environment constructor. Never mutates the caller's map.
export function scannerChildEnvironment(root, parent = process.env) {
  const env = { ...parent };
  delete env.ESBUILD_BINARY_PATH;
  env.TSX_TSCONFIG_PATH = join(realpathSync(root), "tsconfig.json");
  env.TSX_DISABLE_CACHE = "1";
  env.NODE_OPTIONS = "--max-old-space-size=2048";
  env.VITEST_FORK_MAX_OLD_SPACE_SIZE = "2048";
  env.VITEST_MAX_FORKS = "1";
  return env;
}
// Does not import/execute tsx or esbuild. Package-native binaries only; no
// downloaded executable, JavaScript launcher or WASM fallback is admissible.
export function scannerRuntimeIdentity(root, env = process.env, expected) {
  root = realpathSync(root);
  assert(!Object.hasOwn(env, "ESBUILD_BINARY_PATH"), "surviving ESBUILD_BINARY_PATH override");
  assert.equal(env.TSX_TSCONFIG_PATH, join(root, "tsconfig.json"), "effective tsconfig override");
  assert.equal(env.TSX_DISABLE_CACHE, "1", "effective tsx cache override");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=2048", "effective NODE_OPTIONS differs");
  const requireRoot = createRequire(join(root, "package.json"));
  const tsxPackage = realpathSync(requireRoot.resolve("tsx/package.json"));
  const tsxRoot = dirname(tsxPackage);
  const requireTsx = createRequire(tsxPackage);
  const esbuildPackage = realpathSync(requireTsx.resolve("esbuild/package.json"));
  const requireEsbuild = createRequire(esbuildPackage);
  const platformPackage = "@esbuild/" + process.platform + "-" + process.arch;
  const nativePlatforms = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "linux-arm",
    "linux-ia32",
    "linux-mips64el",
    "linux-ppc64",
    "linux-riscv64",
    "linux-s390x",
    "linux-loong64",
    "win32-x64",
    "win32-arm64",
    "win32-ia32",
    "freebsd-x64",
    "freebsd-arm64",
    "netbsd-x64",
    "netbsd-arm64",
    "openbsd-x64",
    "openbsd-arm64",
    "sunos-x64",
    "aix-ppc64",
    "android-arm64",
  ]);
  assert(nativePlatforms.has(process.platform + "-" + process.arch), "unknown/WASM esbuild platform");
  const nativePackage = realpathSync(requireEsbuild.resolve(platformPackage + "/package.json"));
  const nativeRoot = dirname(nativePackage);
  const nativeExecutable = realpathSync(
    requireEsbuild.resolve(platformPackage + (process.platform === "win32" ? "/esbuild.exe" : "/bin/esbuild")),
  );
  assert.equal(
    nativeExecutable,
    join(nativeRoot, process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"),
    "downloaded/foreign native executable",
  );
  const executableBytes = readFileSync(nativeExecutable);
  const magic = executableBytes.subarray(0, 4).toString("hex");
  assert(
    ["7f454c46", "cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(magic) ||
      magic.startsWith("4d5a"),
    "unknown/WASM native executable",
  );
  const esbuildManifest = JSON.parse(readFileSync(esbuildPackage, "utf8"));
  const nativeManifest = JSON.parse(readFileSync(nativePackage, "utf8"));
  assert.equal(nativeManifest.name, platformPackage);
  assert.equal(nativeManifest.version, esbuildManifest.version, "native executable package version differs");
  assert.equal(
    esbuildManifest.optionalDependencies?.[platformPackage],
    nativeManifest.version,
    "native executable dependency differs",
  );
  const paths = {},
    content = { node: process.version, platform: process.platform, arch: process.arch, files: {} };
  function record(key, path) {
    paths[key] = realpathSync(path);
    content.files[key] = sha(readFileSync(paths[key]));
  }
  record("proofHarness", fileURLToPath(import.meta.url));
  record("nodeExecutable", process.execPath);
  record("tsxPackage", tsxPackage);
  function walk(dir, relative = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? relative + "/" + entry.name : entry.name,
        path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else {
        assert(entry.isFile(), "unexpected tsx loader symlink");
        record("tsx/dist/" + rel, path);
      }
    }
  }
  walk(join(tsxRoot, "dist"));
  const tsxManifest = JSON.parse(readFileSync(tsxPackage, "utf8"));
  const esmEntry = tsxManifest.exports?.["./esm/api"]?.import?.default;
  assert.equal(esmEntry, "./dist/esm/api/index.mjs", "unknown tsx ESM loader entry");
  record("tsxEntry", join(tsxRoot, esmEntry));
  record("esbuildPackage", esbuildPackage);
  record("esbuildMain", requireTsx.resolve("esbuild"));
  record("nativePackage", nativePackage);
  record("nativeExecutable", nativeExecutable);
  record("typescriptPackage", requireRoot.resolve("typescript/package.json"));
  record("tsconfig", join(root, "tsconfig.json"));
  const identity = { root, paths, content };
  if (expected !== undefined)
    assert.deepEqual(identity, expected, "runtime identity differs (including native executable)");
  return identity;
}
export function projectScanner(source, url, expectedUrl, sha) {
  const pin = {
    inputHash: "ce232ad6182bf57b9e690f48bbd2605fde3f46b9600a85804834364895b98f52",
    outputHash: "81ed63dd9f767c7290acca3331c33ecda7957146f86b39fe521ec1aea64a8e7d",
    deltas: [
      { start: 398, text: "  C_LC_E,\n" },
      { start: 408, text: "  C_UC_E,\n" },
      {
        start: 7291,
        text: '    // StringToNumber requires exponent digits, unlike parseFloat\'s prefix grammar.\n    // Read the last consumed character: L_C may instead hold unconsumed lookahead.\n    // The mantissa\'s no-digit rejection guarantees L_I - 1 is a valid index.\n    { op: "local.get", index: L_DATA },\n    { op: "local.get", index: L_I },\n    { op: "i32.const", value: 1 },\n    { op: "i32.sub" },\n    { op: "array.get_u", typeIdx: strDataTypeIdx },\n    { op: "local.set", index: L_C },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_LC_E },\n    { op: "i32.eq" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_UC_E },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_PLUS },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    { op: "local.get", index: L_C },\n    { op: "i32.const", value: C_MINUS },\n    { op: "i32.eq" },\n    { op: "i32.or" },\n    {\n      op: "if",\n      blockType: { kind: "empty" },\n      then: [{ op: "f64.const", value: NaN }, { op: "return" }],\n    },\n',
      },
    ],
  };
  if (url !== expectedUrl || !expectedUrl.endsWith("/src/runtime/wasmgc/values/string-number-bodies.ts"))
    throw Error("wrong projection target/root");
  if (sha(source) !== pin.inputHash) throw Error("projection input hash differs");
  for (const delta of pin.deltas) {
    if (source.indexOf(delta.text) !== delta.start || source.lastIndexOf(delta.text) !== delta.start)
      throw Error("missing/duplicate/misplaced semantic delta");
    if (source.slice(delta.start, delta.start + delta.text.length) !== delta.text) throw Error("altered semantic span");
  }
  let text = source;
  for (const delta of [...pin.deltas].sort((a, b) => b.start - a.start))
    text = text.slice(0, delta.start) + text.slice(delta.start + delta.text.length);
  if (sha(text) !== pin.outputHash) throw Error("projection output hash differs");
  return { text, evidence: { url, inputHash: pin.inputHash, outputHash: pin.outputHash, deltas: pin.deltas } };
}
export function projectDecoder(source, url, expectedUrl, sha) {
  const pin = {
    inputHash: "119976d2b5c593dc05b22ed82df454537d3b0bed9395e9ae47ef7dbac64bb748",
    outputHash: "bced4ba015efad207b0e2fbce7f3dfb7da4a0782f9fbc5c8625bea45133f9ac6",
    deltas: [
      {
        start: 1184,
        text: '    // b is the absolute byte offset; local 2 becomes the exclusive byte end.\n    { op: "local.get", index: 0 },\n    { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 2 },\n    { op: "local.tee", index: 5 },\n    { op: "local.get", index: 2 },\n    { op: "i32.add" },\n    { op: "local.set", index: 2 }, // end = off + byteLen\n',
        replacement: '    { op: "i32.const", value: 0 },\n    { op: "local.set", index: 5 }, // b = 0\n',
      },
      {
        start: 1763,
        text: "            // if b >= end break",
        replacement: "            // if b >= byteLen break",
      },
    ],
  };
  if (url !== expectedUrl || !expectedUrl.endsWith("/src/runtime/wasmgc/values/string-utf8-decode-bodies.ts"))
    throw Error("wrong decoder projection target/root");
  if (sha(source) !== pin.inputHash) throw Error("decoder projection input hash differs");
  for (const d of pin.deltas)
    if (source.indexOf(d.text) !== d.start || source.lastIndexOf(d.text) !== d.start)
      throw Error("missing/duplicate/misplaced decoder delta");
  let text = source;
  for (const d of [...pin.deltas].reverse())
    text = text.slice(0, d.start) + d.replacement + text.slice(d.start + d.text.length);
  if (sha(text) !== pin.outputHash) throw Error("decoder projection output hash differs");
  return { text, evidence: { url, ...pin } };
}
export function projectCopyTreeUtf8(source, url, expectedUrl, sha) {
  // Fixed reviewed semantic-delta inverse; the output is the original full-file receipt.
  const pin = {
    inputHash: "012223f8fe1feeee7c175f9e09e0c5461234bf47ba3998aa5f9dbfa51cc5c639",
    outputHash: "f40b6b18f92c8bbba588efc72bd075a1e93c2cfe3fbe4939f3019fe6825a5bdf",
    deltas: [
      {
        start: 4672,
        text: '  utf8Decoder: StringFlattenResources["utf8Decoder"],\n',
        replacement: "",
      },
      {
        start: 4769,
        text: '  const utf8Indices = utf8Decoder.kind === "present" ? [layout.utf8StrTypeIdx, layout.utf8StrDataTypeIdx] : [];\n  for (const index of utf8Indices)\n    if (!Number.isSafeInteger(index) || index < 0)\n      throw new Error("native string copy tree: decoder requires UTF8 layout");\n',
        replacement: "",
      },
      {
        start: 9282,
        text: '                    // Normalize UTF8 at every descent, including popped right children.\n                    ...(utf8Decoder.kind === "present"\n                      ? ([\n                          { op: "local.get", index: CUR },\n                          { op: "ref.as_non_null" },\n                          { op: "ref.test", typeIdx: layout.utf8StrTypeIdx },\n                          {\n                            op: "if",\n                            blockType: { kind: "empty" },\n                            then: [\n                              { op: "local.get", index: CUR },\n                              { op: "ref.as_non_null" },\n                              { op: "ref.cast", typeIdx: layout.utf8StrTypeIdx },\n                              { op: "call", funcIdx: utf8Decoder.handle },\n                              { op: "local.set", index: CUR },\n                            ],\n                          },\n                        ] satisfies Instr[])\n                      : []),\n',
        replacement: "",
      },
    ],
    region: {
      name: "buildStringCopyTreeDefinition",
      start: 4566,
      header:
        'export function buildStringCopyTreeDefinition(\n  layout: NativeStringLayout,\n  worklistTypeIndex: number,\n  utf8Decoder: StringFlattenResources["utf8Decoder"],\n): { locals: LocalDef[]; body: Instr[] } {\n',
    },
  };
  if (url !== expectedUrl || !expectedUrl.endsWith("/src/runtime/wasmgc/values/string-flatten-bodies.ts"))
    throw Error("wrong copy-tree projection target/root");
  if (sha(source) !== pin.inputHash) throw Error("copy-tree projection input hash differs");
  if (
    source.indexOf(pin.region.header) !== pin.region.start ||
    source.lastIndexOf(pin.region.header) !== pin.region.start
  )
    throw Error("changed copy-tree region/header");
  for (const d of pin.deltas)
    if (source.indexOf(d.text) !== d.start || source.lastIndexOf(d.text) !== d.start)
      throw Error("missing/duplicate/misplaced copy-tree delta");
  let text = source;
  for (const d of [...pin.deltas].sort((a, b) => b.start - a.start))
    text = text.slice(0, d.start) + d.replacement + text.slice(d.start + d.text.length);
  if (sha(text) !== pin.outputHash) throw Error("copy-tree projection output hash differs");
  return { text, evidence: { url, ...pin } };
}

export function projectFlattenAdapterStaging(source, url, expectedUrl, sha) {
  // Fixed reviewed semantic-delta inverse; the output is the original full-file receipt.
  const pin = {
    inputHash: "45407b5fd4be2c0d1a6912b23db8b34510f6accdee0ced9a4bcee92d376a40d1",
    outputHash: "00668dc5edcba527d6c8d2bc5638a909f55a5894115d4c30aa1f7b03a50cc9d2",
    deltas: [
      {
        start: 1096,
        text: 'import type { WasmFunction } from "../wasm/model/module-records.js";\n',
        replacement: "",
      },
      {
        start: 1239,
        text: "  type StringFlattenResources,\n",
        replacement: "",
      },
      {
        start: 2438,
        text: '  let copyTreeFunction: WasmFunction;\n  let copyTreeWorklistType: number;\n  let utf8Decoder: StringFlattenResources["utf8Decoder"] = { kind: "absent" };\n',
        replacement: "",
      },
      {
        start: 4533,
        text: '    // Reserve the actual function object in its historical slot. It is pending,\n    // not executable, until the optional decoder has been registered below.\n    copyTreeWorklistType = wlArrTypeIdx;\n    copyTreeFunction = {\n      name: "__str_copy_tree",\n      typeIdx,\n      locals: [],\n      body: [],\n      exported: false,\n    };\n    pushDefinedFunc(ctx, funcIdx, copyTreeFunction);',
        replacement:
          '    const definition = buildStringCopyTreeDefinition(ctx, wlArrTypeIdx);\n\n    pushDefinedFunc(ctx, funcIdx, {\n      name: "__str_copy_tree",\n      typeIdx,\n      locals: definition.locals,\n      body: definition.body,\n      exported: false,\n    });',
      },
      {
        start: 6133,
        text: '    utf8Decoder = { kind: "present", handle: funcIdx };\n',
        replacement: "",
      },
      {
        start: 6194,
        text: "  // Fill the same pushed object once, using only the decoder minted above.\n  // A decoder construction failure propagates before any completion is claimed.\n  const copyTreeDefinition = buildStringCopyTreeDefinition(ctx, copyTreeWorklistType, utf8Decoder);\n  copyTreeFunction.locals = copyTreeDefinition.locals;\n  copyTreeFunction.body = copyTreeDefinition.body;\n\n",
        replacement: "",
      },
      {
        start: 7566,
        text: '    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;\n',
        replacement:
          '    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;\n    // #1588 PR-B part 2: present iff --utf8-storage is on.\n    const utf8ToFlatIdx = ctx.nativeStrHelpers.get("__str_utf8_to_flat");\n',
      },
      {
        start: 8041,
        text: "      utf8Decoder,\n",
        replacement:
          '      utf8Decoder:\n        ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined\n          ? { kind: "present", handle: utf8ToFlatIdx }\n          : { kind: "absent" },\n',
      },
    ],
    region: {
      name: "emitStrFlattenHelpers",
      start: 2250,
      header: "export function emitStrFlattenHelpers(shared: NativeStrShared): void {\n",
    },
  };
  if (url !== expectedUrl || !expectedUrl.endsWith("/src/codegen/native-strings-core.ts"))
    throw Error("wrong flatten adapter projection target/root");
  if (sha(source) !== pin.inputHash) throw Error("flatten adapter projection input hash differs");
  if (
    source.indexOf(pin.region.header) !== pin.region.start ||
    source.lastIndexOf(pin.region.header) !== pin.region.start
  )
    throw Error("changed flatten adapter region/header");
  for (const d of pin.deltas)
    if (source.indexOf(d.text) !== d.start || source.lastIndexOf(d.text) !== d.start)
      throw Error("missing/duplicate/misplaced flatten adapter delta");
  let text = source;
  for (const d of [...pin.deltas].sort((a, b) => b.start - a.start))
    text = text.slice(0, d.start) + d.replacement + text.slice(d.start + d.text.length);
  if (sha(text) !== pin.outputHash) throw Error("flatten adapter projection output hash differs");
  return { text, evidence: { url, ...pin } };
}

export function scannerProjectionTargets(root) {
  return Object.fromEntries(
    [
      ["src/runtime/wasmgc/values/string-number-bodies.ts", "scanner"],
      ["src/runtime/wasmgc/values/string-utf8-decode-bodies.ts", "decoder"],
      ["src/runtime/wasmgc/values/string-flatten-bodies.ts", "copyTree"],
      ["src/codegen/native-strings-core.ts", "adapter"],
    ].map(([path, kind]) => [pathToFileURL(join(root, path)).href, kind]),
  );
}
// Exact URL membership is the sole authorization. Suffix comparison below can
// only deny alternate roots/routes/query instances, never authorize a load.
export function scannerProjectionTarget(url, targets) {
  if (Object.hasOwn(targets, url)) return targets[url];
  const parsed = new URL(url);
  for (const expected of Object.keys(targets)) {
    const path = new URL(expected).pathname;
    const relative = path.slice(path.lastIndexOf("/src/"));
    if (parsed.pathname.endsWith(relative)) throw Error("wrong projection target/root " + url);
  }
  return null;
}
export function requireScannerBaselineSource(rows) {
  // Independently checked against every blob in the fixed a6cc source tree.
  assert.equal(rows.length, 1337, "baseline source population differs");
  assert.equal(
    sha(JSON.stringify(rows)),
    "5dbae41d235c490b58f107fcc70ef54dc353544be3bccd63d92b5be706429df5",
    "baseline source census differs",
  );
}
const loaderSource = String.raw`
import { createHash } from "node:crypto";
let state, transformations=0, loads=0, perTarget={}, evidence=[];
const sha=s=>createHash("sha256").update(s).digest("hex");
export function initialize(data){state=data;state.port.on("message",message=>{if(message==="receipt")state.port.postMessage({transformations,loads,perTarget,evidence});});state.port.unref();}
export async function load(url,context,next){
  const kind=SELECT_TARGET(url,state.targets);
  const result=await next(url,context);
  if(kind===null)return result;
  loads++;
  perTarget[url]=(perTarget[url]??0)+1;
  if(perTarget[url]!==1)throw Error("duplicate canonical load/transformation");
  const source=typeof result.source==="string"?result.source:Buffer.from(result.source).toString("utf8");
  if(state.arm!=="projection")return result;
  const projectors={scanner:PROJECT_SCANNER,decoder:PROJECT_DECODER,copyTree:PROJECT_COPY_TREE,adapter:PROJECT_ADAPTER};
  const projected=projectors[kind](source,url,url,sha);
  transformations++;evidence.push(projected.evidence);
  return {...result,source:projected.text};
}
`;
const childSource = String.raw`
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
const [rootArgument, arm, loaderArgument, harnessUrl, identityArgument] = process.argv.slice(1), root = realpathSync(rootArgument);
const {scannerRuntimeIdentity,scannerProjectionTargets,requireScannerBaselineSource,requireTargetLoads,requireTransformCount} = await import(harnessUrl);
const expectedIdentity=JSON.parse(Buffer.from(identityArgument,"base64").toString("utf8"));
const runtimeBefore=scannerRuntimeIdentity(root,process.env,expectedIdentity);
const sha = value => createHash("sha256").update(value).digest("hex");
const read = path => readFileSync(join(root,path),"utf8");
const pins = {
  "tests/issue-3570.test.ts":"ad408ed7ba9f0ee0f431284f895f8efe9095491643788cb21518107697e70f9c",
  "tests/issue-2654.test.ts":"ef8ab89aa5f20769c8948ded619c60ec7cf62c466f68345fb2daf44cf4a38e93",
  "tests/issue-1184.test.ts":"31766bc76c409ac7e5c81211e9c205f5d0b7d8d64885737c265d6f36e29bbf6d",
};
for(const [path,hash] of Object.entries(pins))assert.equal(sha(read(path)),hash,"fixture changed: "+path);
const head=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
if(arm==="baseline"){
  assert.equal(head,"a6cc59a2cdfad5141d75faadf1530a9de63bebd7");
  assert.equal(execFileSync("git",["diff","HEAD","--","src",...Object.keys(pins)],{cwd:root,encoding:"utf8"}),"");
  assert.equal(execFileSync("git",["ls-files","--others","--exclude-standard","--","src"],{cwd:root,encoding:"utf8"}),"");
}
function snapshot(){const rows=[];function walk(dir){for(const entry of readdirSync(join(root,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=dir+"/"+entry.name;if(entry.isDirectory())walk(path);else{assert(entry.isFile(),"unexpected source symlink "+path);rows.push([path,sha(readFileSync(join(root,path)))]);}}}walk("src");assert(rows.length>1000);return rows;}
const sourceBefore=snapshot(),urls=[];
if(arm==="baseline")requireScannerBaselineSource(sourceBefore);
// Register the raw-source hook FIRST. The identical tsx loader in every arm
// then calls through it before performing its normal TypeScript transform.
const loaderText=Buffer.from(loaderArgument,"base64").toString("utf8");
const {port1,port2}=new MessageChannel();port1.unref();
const targets=scannerProjectionTargets(root);
register("data:text/javascript;base64,"+Buffer.from(loaderText).toString("base64"),{parentURL:import.meta.url,data:{root,arm,targets,port:port2},transferList:[port2]});
const {register:registerTsx}=await import(pathToFileURL(runtimeBefore.paths.tsxEntry).href);
registerTsx({tsconfig:join(root,"tsconfig.json")});
const runtimeLoader={...runtimeBefore,content:{...runtimeBefore.content,loaderHash:sha(loaderText)}};
const progress=event=>console.log("SCANNER_PROGRESS="+JSON.stringify(event));
async function awaitStep(promise,context){
  let rejectIdle;const idle=new Promise((_,reject)=>{rejectIdle=reject;});
  const onIdle=()=>rejectIdle(Object.assign(new Error("unsettled recorder await"),{code:"ERR_RECORDER_UNSETTLED_AWAIT",context}));
  process.once("beforeExit",onIdle);progress({phase:"await",...context});
  try{return await Promise.race([promise,idle]);}finally{process.removeListener("beforeExit",onIdle);}
}
async function load(path){const url=pathToFileURL(join(root,path)).href;urls.push(url);return awaitStep(import(url),{phase:"import",url});}
const ts=(await load("node_modules/typescript/lib/typescript.js")).default;
const compiler=await load("src/index.ts"),runtime=await load("src/runtime.ts");
const parsed=Object.fromEntries(Object.keys(pins).map(path=>[path,ts.createSourceFile(path,read(path),ts.ScriptTarget.Latest,true)]));
function collect(sf,predicate){const found=[];function visit(node){if(predicate(node))found.push(node);ts.forEachChild(node,visit);}visit(sf);return found;}
function one(rows,label){assert.equal(rows.length,1,label);return rows[0];}
function callNamed(node,name){return ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===name;}
function template(node,expr){
  if(ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  assert(ts.isTemplateExpression(node));let result=node.head.text;
  for(const span of node.templateSpans){
    if(ts.isIdentifier(span.expression)&&span.expression.text==="expr")result+=expr;
    else if(ts.isCallExpression(span.expression)&&span.expression.expression.getText()==="JSON.stringify"&&span.expression.arguments.length===1&&span.expression.arguments[0].getText()==="expr")result+=JSON.stringify(expr);
    else throw Error("unsupported source template operand "+span.expression.getText());
    result+=span.literal.text;
  }return result;
}
const fixtures=[];
function add(group,source,options,expr,args=[],expected,approximate=false){fixtures.push({id:group+":"+fixtures.filter(f=>f.group===group).length,group,source,options,expr,args,expected,approximate});}
function numberExpected(expr){
  const sf=ts.createSourceFile("expr.ts",expr,ts.ScriptTarget.Latest,true);
  const call=one(collect(sf,n=>ts.isCallExpression(n)),"one numeric source call");
  const name=call.expression.getText(sf);assert(["Number","parseFloat","parseInt"].includes(name));
  assert(ts.isStringLiteral(call.arguments[0]));const input=call.arguments[0].text;
  const radix=call.arguments[1]===undefined?undefined:Number(call.arguments[1].getText(sf));
  return name==="Number"?Number(input):name==="parseFloat"?Number.parseFloat(input):Number.parseInt(input,radix);
}
// Extract the real num() source template and all 17 literal callsites.
{
  const sf=parsed["tests/issue-3570.test.ts"];
  const num=one(collect(sf,n=>ts.isVariableDeclaration(n)&&n.name.getText(sf)==="num"),"num helper");
  assert(ts.isArrowFunction(num.initializer));
  const calls=collect(sf,n=>callNamed(n,"num"));assert.equal(calls.length,17);
  for(const call of calls){assert(ts.isStringLiteral(call.arguments[0]));const input=call.arguments[0].text;add("3570",template(num.initializer.body,input),{target:"standalone"},"Number("+JSON.stringify(input)+")",[],Number(input));}
}
// Retain all 16 precision strings × both original parser callers, plus the
// eleven directly written runF64 controls (including two WASI controls).
{
  const sf=parsed["tests/issue-2654.test.ts"];
  const fn=one(collect(sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text==="runF64"),"runF64 helper");
  const compile=one(collect(fn,n=>callNamed(n,"compile")),"runF64 compile template");
  const inputs=one(collect(sf,n=>ts.isVariableDeclaration(n)&&n.name.getText(sf)==="PRECISION_INPUTS"),"precision input array");
  assert(ts.isArrayLiteralExpression(inputs.initializer));assert.equal(inputs.initializer.elements.length,16);
  const calls=collect(sf,n=>callNamed(n,"runF64"));assert.equal(calls.length,13);
  for(const call of calls){
    assert(ts.isStringLiteral(call.arguments[1]));const target=call.arguments[1].text;assert(["standalone","wasi"].includes(target));
    const argument=call.arguments[0];
    const expressions=ts.isNoSubstitutionTemplateLiteral(argument)?[argument.text]:inputs.initializer.elements.map(input=>{
      assert(ts.isStringLiteral(input));assert(ts.isTemplateExpression(argument));
      let expr=argument.head.text;for(const span of argument.templateSpans){assert(ts.isIdentifier(span.expression)&&span.expression.text==="input");expr+=input.text+span.literal.text;}return expr;
    });
    for(const expr of expressions)add("2654",template(compile.arguments[0],expr),{fileName:"test.ts",target},expr,[],numberExpected(expr),expr==='parseFloat("1e300")');
  }
  assert.equal(fixtures.filter(f=>f.group==="2654").length,43);
}
// Use the four literal src declarations verbatim, preserving original JS/WASI
// options and the actual 5000-iteration hash caller.
{
  const sf=parsed["tests/issue-1184.test.ts"];
  const sources=collect(sf,n=>ts.isVariableDeclaration(n)&&n.name.getText(sf)==="src");assert.equal(sources.length,4);
  let hash=0;for(let i=0;i<5000;i++)hash=(hash*31+120)|0;
  const expected=[2940,9000,65000,hash];
  sources.forEach((node,i)=>{assert(ts.isNoSubstitutionTemplateLiteral(node.initializer));add("1184",node.initializer.text,{fileName:"t.js",allowJs:true,target:"wasi",optimize:0},undefined,i===3?[5000]:[],expected[i]);});
}
assert.equal(fixtures.length,64);assert.equal(new Set(fixtures.map(f=>f.id)).size,64);
// Separate, explicitly added semantic probes; never folded into the original64.
const numHelper=one(collect(parsed["tests/issue-3570.test.ts"],n=>ts.isVariableDeclaration(n)&&n.name.getText()==="num"),"semantic num helper");
const malformed=["1e","1e+"].map((input,i)=>({id:"malformed:"+i,group:"malformed",source:template(numHelper.initializer.body,input),options:{target:"standalone"},args:[],expected:arm==="candidate"?NaN:1,approximate:false}));
const encode=value=>Number.isNaN(value)?{number:"NaN"}:Object.is(value,-0)?{number:"-0"}:value===Infinity?{number:"Infinity"}:value===-Infinity?{number:"-Infinity"}:{number:value};
// Complete serialized resource declarations in original WAT order, including
// every function body. Strings/comments cannot change parenthesis depth.
function declarations(wat){const rows=[];let depth=0,start=-1,string=false,escape=false,line=false,comment=0;
  for(let i=0;i<wat.length;i++){const c=wat[i],n=wat[i+1];
    if(line){if(c==='\n')line=false;continue;}
    if(comment){if(c==='('&&n===';'){comment++;i++;}else if(c===';'&&n===')'){comment--;i++;}continue;}
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c===';'&&n===';'){line=true;i++;continue;}if(c==='('&&n===';'){comment++;i++;continue;}if(c==='"'){string=true;continue;}
    if(c==='('){depth++;if(depth===2)start=i;}else if(c===')'){if(depth===2){assert(start>=0);rows.push(wat.slice(start,i+1));start=-1;}depth--;assert(depth>=0);}
  }assert.equal(depth,0);assert(!string&&!comment);assert(rows.length>0);return rows;
}
const rows=[];
for(const fixture of [...fixtures,...malformed]){
  const row={id:fixture.id,group:fixture.group,sourceSha256:sha(fixture.source),options:{...fixture.options,emitWat:true},expected:encode(fixture.expected),values:[]};rows.push(row);progress({phase:"row-start",id:row.id});
  try{
    const result=await awaitStep(compiler.compile(fixture.source,row.options),{phase:"compile",id:row.id});
    row.success=result.success;row.errors=result.errors;assert(result.success,JSON.stringify(result.errors));assert(result.binary?.length>8);assert.equal(typeof result.wat,"string");assert(result.wat.length>0);
    row.binary=Buffer.from(result.binary).toString("base64");row.wat=result.wat;row.serializedResourceOrder=declarations(result.wat);
    const compiled=new WebAssembly.Module(result.binary);row.imports=WebAssembly.Module.imports(compiled);row.exports=WebAssembly.Module.exports(compiled);
    const imports=fixture.group==="2654"?runtime.buildImports(result.imports,undefined,result.stringPool,{}):{};
    const instance=new WebAssembly.Instance(compiled,imports);const entry=instance.exports[fixture.group==="1184"?"run":"test"];assert.equal(typeof entry,"function");
    row.expectedPass=[];row.elapsedMs=[];
    for(let repeat=0;repeat<2;repeat++){const start=performance.now(),value=entry(...fixture.args);row.elapsedMs.push(performance.now()-start);row.values.push(encode(value));row.expectedPass.push(fixture.approximate?Number.isFinite(value)&&Math.abs(value-fixture.expected)/fixture.expected<1e-15:Object.is(value,fixture.expected));}
    row.kind="executed";
  }catch(error){row.kind="failed";row.error={name:error.name,message:error.message,code:error.code};}
  progress({phase:"row-completed",id:row.id,kind:row.kind});
}
assert.deepEqual(snapshot(),sourceBefore,"compiler source changed during arm");
scannerRuntimeIdentity(root,process.env,runtimeBefore);
port1.ref();const projection=await awaitStep(new Promise(resolve=>{port1.once("message",resolve);port1.postMessage("receipt");}),{phase:"loader-receipt"});port1.close();
requireTransformCount(projection.transformations,arm);
requireTargetLoads(projection.perTarget,root,arm);
assert.equal(projection.loads,arm==="baseline"?1:4,"missing/duplicate scanner load");
console.log("SCANNER_RECEIPT="+JSON.stringify({schema:"native-scanner-public-source-pair-v5",arm,root,head,urls,runtimeLoader,projection,sourceFiles:sourceBefore,fixturePins:pins,fixtures:fixtures.map(f=>({...f,expected:encode(f.expected)})),semanticFixtures:malformed.map(f=>({id:f.id,source:f.source,options:f.options})),rows,physicalAcceptanceCertified:false}));
`;
const expectedIds = [
  ...Array.from({ length: 17 }, (_, i) => "3570:" + i),
  ...Array.from({ length: 43 }, (_, i) => "2654:" + i),
  ...Array.from({ length: 4 }, (_, i) => "1184:" + i),
  "malformed:0",
  "malformed:1",
];
export function requireTerminal(terminal, receiptCount) {
  if (terminal.code !== 0 || terminal.signal !== null || receiptCount !== 1)
    throw Error("unadmitted child terminal/receipt");
}
export function requirePopulation(ids) {
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw Error("missing/duplicate/reordered source row");
}
export function requireTransformCount(count, arm) {
  if (!["baseline", "candidate", "projection"].includes(arm) || count !== (arm === "projection" ? 4 : 0))
    throw Error("missing/duplicate/unexpected transformation");
}
export function requireTargetLoads(actual, root, arm) {
  assert(["baseline", "candidate", "projection"].includes(arm), "unknown scanner arm");
  const expected = Object.fromEntries(
    Object.entries(scannerProjectionTargets(root))
      .filter(([, kind]) => arm !== "baseline" || kind === "adapter")
      .map(([url]) => [url, 1]),
  );
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort()))
    throw Error("missing/duplicate/foreign target load");
}
async function runArm(root, arm, directory) {
  const loader = loaderSource
    .replace("PROJECT_SCANNER", `(${projectScanner.toString()})`)
    .replace("PROJECT_DECODER", `(${projectDecoder.toString()})`)
    .replace("PROJECT_COPY_TREE", `(${projectCopyTreeUtf8.toString()})`)
    .replace("PROJECT_ADAPTER", `(${projectFlattenAdapterStaging.toString()})`)
    .replace("SELECT_TARGET", `(${scannerProjectionTarget.toString()})`);
  const env = scannerChildEnvironment(root);
  const runtimeBefore = scannerRuntimeIdentity(root, env);
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=2048",
      "--input-type=module",
      "-e",
      childSource,
      root,
      arm,
      Buffer.from(loader).toString("base64"),
      import.meta.url,
      Buffer.from(JSON.stringify(runtimeBefore)).toString("base64"),
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  console.log(`scanner pair ${arm}: pid=${child.pid}; root=${root}; artifacts=${directory}`);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    appendFileSync(join(directory, arm + ".stdout.txt"), chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    appendFileSync(join(directory, arm + ".stderr.txt"), chunk);
  });
  const terminal = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  writeFileSync(join(directory, arm + ".stdout.txt"), stdout);
  writeFileSync(join(directory, arm + ".stderr.txt"), stderr);
  writeFileSync(
    join(directory, arm + ".terminal.json"),
    JSON.stringify({ root, pid: child.pid, ...terminal }, null, 2),
  );
  const receipts = stdout.split("\n").filter((line) => line.startsWith("SCANNER_RECEIPT="));
  requireTerminal(terminal, receipts.length);
  scannerRuntimeIdentity(root, env, runtimeBefore);
  const receipt = JSON.parse(receipts[0].slice("SCANNER_RECEIPT=".length));
  writeFileSync(join(directory, arm + ".json"), JSON.stringify(receipt, null, 2));
  assert.equal(receipt.schema, "native-scanner-public-source-pair-v5");
  assert.equal(receipt.root, root);
  assert.equal(receipt.arm, arm);
  assert.deepEqual(
    receipt.runtimeLoader,
    { ...runtimeBefore, content: { ...runtimeBefore.content, loaderHash: sha(loader) } },
    "parent/child runtime identity differs",
  );
  requirePopulation(receipt.rows.map((row) => row.id));
  assert.equal(receipt.fixtures.length, 64);
  assert.equal(receipt.semanticFixtures.length, 2);
  requireTransformCount(receipt.projection.transformations, arm);
  requireTargetLoads(receipt.projection.perTarget, root, arm);
  assert.equal(receipt.projection.loads, arm === "baseline" ? 1 : 4);
  if (arm === "baseline") requireScannerBaselineSource(receipt.sourceFiles);
  if (arm === "projection") {
    const projectors = {
      scanner: projectScanner,
      decoder: projectDecoder,
      copyTree: projectCopyTreeUtf8,
      adapter: projectFlattenAdapterStaging,
    };
    const expectedEvidence = Object.entries(scannerProjectionTargets(root)).map(
      ([url, kind]) => projectors[kind](readFileSync(new URL(url), "utf8"), url, url, sha).evidence,
    );
    assert.deepEqual(
      [...receipt.projection.evidence].sort((a, b) => a.url.localeCompare(b.url)),
      expectedEvidence.sort((a, b) => a.url.localeCompare(b.url)),
    );
    assert.equal(receipt.projection.evidence.length, 4);
  } else assert.deepEqual(receipt.projection.evidence, []);
  return receipt;
}
export async function runNativeScannerSourcePreservation({
  baselineRoot: baselineArgument,
  candidateRoot: candidateArgument,
  outputDirectory,
}) {
  assert(
    baselineArgument && candidateArgument && isAbsolute(baselineArgument) && isAbsolute(candidateArgument),
    "explicit absolute baseline and candidate roots required",
  );
  if (outputDirectory) {
    assert(isAbsolute(outputDirectory), "absolute output directory required");
    mkdirSync(outputDirectory, { recursive: true });
  }
  const baseline = realpathSync(baselineArgument),
    candidate = realpathSync(candidateArgument);
  assert.notEqual(baseline, candidate, "distinct real roots required");
  const parent = join(candidate, ".tmp");
  mkdirSync(parent, { recursive: true });
  const directory = outputDirectory
    ? realpathSync(outputDirectory)
    : mkdtempSync(join(parent, "native-scanner-source-pair-"));
  const before = await runArm(baseline, "baseline", directory),
    after = await runArm(candidate, "candidate", directory),
    projection = await runArm(candidate, "projection", directory);
  assert.equal(before.root, baseline);
  assert.equal(after.root, candidate);
  assert.deepEqual(before.fixtures, after.fixtures);
  assert.deepEqual(before.fixtures, projection.fixtures);
  assert.deepEqual(before.semanticFixtures, after.semanticFixtures);
  assert.deepEqual(before.semanticFixtures, projection.semanticFixtures);
  assert.deepEqual(before.runtimeLoader.content, after.runtimeLoader.content);
  assert.deepEqual(before.runtimeLoader.content, projection.runtimeLoader.content);
  assert.deepEqual(after.sourceFiles, projection.sourceFiles);
  const differences = [];
  for (let i = 0; i < 66; i++) {
    const a = before.rows[i],
      b = projection.rows[i],
      c = after.rows[i];
    for (const field of ["id", "binary", "wat", "serializedResourceOrder", "values"])
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) differences.push({ id: a.id, field });
    for (const [arm, row] of [
      ["baseline", a],
      ["projection", b],
      ["candidate", c],
    ]) {
      if (
        row.kind !== "executed" ||
        !row.binary ||
        !row.wat ||
        !row.serializedResourceOrder?.length ||
        row.values.length !== 2 ||
        row.expectedPass?.length !== 2 ||
        row.expectedPass.some((pass) => !pass)
      )
        differences.push({
          id: row.id,
          arm,
          kind: row.kind,
          error: row.error,
          values: row.values,
          expectedPass: row.expectedPass,
        });
      if (row.group === "1184" && row.id === "1184:3" && row.elapsedMs?.some((ms) => ms >= 5000))
        differences.push({ id: row.id, arm, timingFailure: row.elapsedMs });
    }
    if (i >= 64) {
      if (JSON.stringify(a.values) !== JSON.stringify([{ number: 1 }, { number: 1 }]))
        differences.push({ id: a.id, arm: "baseline", malformed: a.values });
      if (JSON.stringify(c.values) !== JSON.stringify([{ number: "NaN" }, { number: "NaN" }]))
        differences.push({ id: c.id, arm: "candidate", malformed: c.values });
    }
  }
  writeFileSync(
    join(directory, "comparison.json"),
    JSON.stringify(
      {
        baseline,
        candidate,
        originalScenarioCount: 64,
        addedSemanticProbes: 2,
        executionsPerArm: 132,
        byteParity: "baseline vs candidate-preservation projection only",
        actualCandidate: "independent semantics; bytes/WAT retained, no baseline parity claim",
        differences,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    differences,
    [],
    `full receipts retained in ${directory}; equal wrong results are not semantic acceptance`,
  );
  return { directory, originalScenarioCount: 64, addedSemanticProbes: 2, arms: 3, rowsPerArm: 66 };
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2),
      options = {};
    const names = {
      "--baseline-root": "baselineRoot",
      "--candidate-root": "candidateRoot",
      "--output-directory": "outputDirectory",
    };
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i]];
      assert(
        name && args[i + 1] && !Object.hasOwn(options, name),
        "usage: --baseline-root ABS --candidate-root ABS [--output-directory ABS]",
      );
      options[name] = args[i + 1];
    }
    console.log(JSON.stringify(await runNativeScannerSourcePreservation(options)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
