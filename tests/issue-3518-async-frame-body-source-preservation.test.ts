// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
function exactly<T>(values: T[], label: string): T {
  assert.equal(values.length, 1, label);
  return values[0]!;
}

// One fresh process per explicit compiler root. This is public-source
// preservation, NOT whole-program async admission or physical acceptance.
// The complete public artifact is recorded; only its documented lazy
// importObject getter is represented by descriptor shape, never invoked.
const publicArmSource = String.raw`
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [rootArgument, arm] = process.argv.slice(1);
const root = realpathSync(rootArgument);
const hash = x => createHash("sha256").update(x).digest("hex");
const read = path => readFileSync(join(root, path), "utf8");
const urls = [];
const observe = event => console.log("FRAME_BODY_PROGRESS=" + JSON.stringify(event));
// Same idle-await contract as the existing source recorder: failure if all
// work disappears while an operation is unsettled, never a timer or kill.
async function awaitStep(promise, context) {
  observe({kind:"await-start",...context});
  let rejectIdle;
  const idle = new Promise((_,reject) => {rejectIdle=reject;});
  const onIdle = () => {const error=new Error("recorder await became idle: " + context.phase);error.code="ERR_RECORDER_UNSETTLED_AWAIT";error.context=context;rejectIdle(error);};
  process.once("beforeExit",onIdle);
  try {const value=await Promise.race([promise,idle]);observe({kind:"await-completed",...context});return value;}
  catch(error){observe({kind:"await-failed",...context,error:{name:error.name,message:error.message,code:error.code}});throw error;}
  finally{process.removeListener("beforeExit",onIdle);}
}
async function load(path) { const url = pathToFileURL(join(root, path)).href; urls.push(url); return awaitStep(import(url),{phase:"import",url}); }
function snapshot() {
  const rows = [];
  function walk(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path + "/" + entry.name;
      if (entry.isDirectory()) walk(file);
      else { assert(entry.isFile(), "unexpected source symlink " + file); rows.push([file, hash(readFileSync(join(root,file)))]); }
    }
  }
  walk("src"); assert(rows.length > 1000); return rows;
}
const before = snapshot();
if (arm === "baseline") {
  assert.equal(execFileSync("git", ["diff", "0194b64c246d2b5beab2db00af33a73498e2eb6e", "--", "src"], {cwd:root, encoding:"utf8"}), "");
  assert.equal(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], {cwd:root, encoding:"utf8"}), "");
}
const compiler = await load("src/index.ts");
const runtime = await load("src/runtime.ts");
const { evidenceValue } = await load("tests/helpers/semantic-provider-source-receipts.mjs");
const ts = (await load("node_modules/typescript/lib/typescript.js")).default;
function template(path, callName, needle, argument) {
  const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true), matches=[];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callName && node.arguments.length > 0 && ts.isNoSubstitutionTemplateLiteral(node.arguments[0]) && node.arguments[0].text.includes(needle) && (argument === undefined || (node.arguments.length > 1 && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === argument))) matches.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file); assert.equal(matches.length,1,"one grounded fixture " + path + ":" + needle); return matches[0];
}
const familyPath = "website/playground/examples/js/async.ts";
let family = read(familyPath);
for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"]) {
  assert.equal(family.split("async function " + name).length,2);
  family = family.replace("async function " + name,"export async function " + name);
}
const fixtures = [
  {id:"family",path:familyPath,source:family,target:"standalone",action:"family"},
  {id:"multi-await",path:"tests/issue-2906-async-multiawait.test.ts",call:"instantiateWasi",needle:"cap = a * 100 + b",target:"standalone",action:"cap",getter:"getCap",expected:4142},
  {id:"try-catch",path:"tests/issue-2906-3c-trycatch.test.ts",call:"driveCap",needle:'const x = await Promise.reject(new Error("boom"))',argument:"standalone",target:"standalone",action:"cap",getter:"getCap",expected:42},
  {id:"try-finally",path:"tests/issue-2906-gap3-tryfinally.test.ts",call:"instantiateWasi",needle:"ran = 99",target:"standalone",action:"cap",getter:"getRan",expected:99},
  {id:"late-import",path:"tests/issue-2710-late-bind.test.ts",call:"compileToWasm",needle:"async function fetchA()",target:"gc",action:"host",expected:130},
];
for (const fixture of fixtures) {
  if (!fixture.source) fixture.source = template(fixture.path,fixture.call,fixture.needle,fixture.argument);
  fixture.sourceFileSha256 = hash(read(fixture.path)); fixture.sourceSha256 = hash(fixture.source);
}
function dataResult(result) {
  const data = {};
  for (const key of Reflect.ownKeys(result)) {
    assert.equal(typeof key,"string");
    const d = Object.getOwnPropertyDescriptor(result,key);
    if (key === "importObject") {
      assert(!("value" in d) && typeof d.get === "function", "exact documented importObject accessor");
      data[key] = {lazyImportObject:true,enumerable:d.enumerable,configurable:d.configurable,hasSetter:!!d.set};
    } else { assert("value" in d,"unassessed result accessor " + key); data[key] = key === "binary" ? {$bytes:Buffer.from(d.value).toString("base64")} : d.value; }
  }
  return evidenceValue(data);
}
function functionAt(ex,name) { assert.equal(typeof ex[name],"function","missing executed export " + name); return ex[name]; }
async function instantiate(result, action) {
  const jobs=[],events=[];let ordinal=0;
  const imports=runtime.buildCompiledImports(result, {setTimeout(callback,delay,...args) {
    const id=ordinal++; events.push(["start",id,delay]);
    if ((action === "sequential-reject" || action === "parallel-reject") && id === 1) { events.push(["reject",id]); throw new Error("injected timer registration failure at 1"); }
    const fire=()=>{events.push(["fire",id]);callback(...args);}; jobs.push(fire);
    if(action === "non-i31" && id === 0)fire();
    return id+1;
  }});
  const instantiatedBinary=Buffer.from(result.binary).toString("base64");
  const {instance}=await awaitStep(WebAssembly.instantiate(result.binary,imports),{phase:"instantiate",action});
  imports.setInstance?.(instance);
  return {instance,ex:instance.exports,jobs,events,instantiatedBinary};
}
function vector(ex, ids) {
  const allocate=functionAt(ex,"__new_vec_f64"), set=functionAt(ex,"__vec_set_byte"), get=functionAt(ex,"__vec_get");
  const vec=allocate(ids.length); ids.forEach((v,i)=>set(vec,i,v)); ids.forEach((v,i)=>assert.equal(get(vec,i),v)); return vec;
}
async function executeFamily(result) {
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(x=>x.module+"."+x.name),["env.__timer_set_timeout"]);
  for(const owner of ["fetchUser","fetchAllSequential","fetchAllParallel","main"]) {
    const rows=result.irOutcomes.filter(x=>x.unitKind==="function"&&x.displayName===owner);assert.equal(rows.length,1);
    assert.equal(rows[0].kind,"emitted");assert.equal(rows[0].irBodyEmitted,true);assert.equal(rows[0].legacyBodyEmitted,false);
  }
  const values=[];
  for(const action of ["pending-70","non-i31","sequential","parallel-reverse","empty","sequential-reject","parallel-reject","undefined"]) {
    const h=await instantiate(result,action),ex=h.ex,state=functionAt(ex,"__promise_boundary_state"),value=functionAt(ex,"__promise_boundary_value");
    const drain=functionAt(ex,"__drain_microtasks");
    if(action==="non-i31") {
      assert.equal(typeof ex.__promise_boundary_observe,"undefined");
      const promise=runtime.wrapCompiledExports(result,h.instance).fetchUser(300000000);
      assert.equal(h.jobs.length,1);assert.deepEqual(h.events.map(x=>x[0]),["start","fire"]);
      const actual=await awaitStep(promise,{phase:"wrapped-non-i31",action});assert.equal(actual,3000000000);
      values.push({action,actual,events:h.events,instantiatedBinary:h.instantiatedBinary});continue;
    }
    if(action==="empty") {
      const empty=vector(ex,[]),sequential=functionAt(ex,"fetchAllSequential")(empty),parallel=functionAt(ex,"fetchAllParallel")(empty);
      // #4574: the no-await sequential path settles now; the parallel await
      // resumes only through the native microtask queue, even for Promise.all([]).
      const before=[state(sequential),state(parallel)];assert.deepEqual(before,[1,0]);assert.deepEqual([value(sequential),value(parallel)],[0,null]);assert.equal(h.jobs.length,0);
      drain();const actual=[value(sequential),value(parallel)];assert.deepEqual(actual,[0,0]);assert.deepEqual([state(sequential),state(parallel)],[1,1]);
      values.push({action,before,actual,events:h.events,instantiatedBinary:h.instantiatedBinary});continue;
    }
    const ids=[3,1,2];
    let promise;
    if(action==="pending-70") promise=functionAt(ex,"fetchUser")(7);
    else if(action==="undefined") promise=functionAt(ex,"main")();
    else promise=functionAt(ex,action.startsWith("sequential")?"fetchAllSequential":"fetchAllParallel")(vector(ex,ids));
    if(action==="parallel-reject")drain();
    const before=state(promise);assert.equal(before,action==="parallel-reject"?2:0);
    const timeline=[{state:before,jobs:h.jobs.length}];
    if(action==="pending-70") {assert.equal(h.jobs.length,1);h.jobs[0]();}
    else if(action==="undefined") {
      assert.equal(h.jobs.length,1);
      for(let i=0;i<5;i++){assert.equal(h.jobs.length,i+1);h.jobs[i]();timeline.push({state:state(promise),jobs:h.jobs.length});}
      assert.equal(h.jobs.length,10);
      for(let i=9;i>=5;i--)h.jobs[i]();
    } else if(action==="sequential") {
      for(let i=0;i<3;i++){assert.equal(h.jobs.length,i+1);h.jobs[i]();timeline.push({state:state(promise),jobs:h.jobs.length});}
    } else if(action==="sequential-reject") {assert.equal(h.jobs.length,1);h.jobs[0]();assert.equal(h.jobs.length,1);}
    else {assert.equal(h.jobs.length,action==="parallel-reject"?2:3);for(let i=h.jobs.length-1;i>=0;i--)h.jobs[i]();}
    drain();const after=state(promise),raw=value(promise);let actual;
    if(action.endsWith("reject")){assert.equal(after,2);assert.equal(raw,null);actual=null;}
    else {assert.equal(after,1);if(action==="undefined"){assert.equal(functionAt(ex,"__dynamic_boundary_tag")(raw),2);actual={$undefined:true};}else {actual=raw;assert.equal(actual,action==="pending-70"?70:60);}}
    const expectedStdout="async/await demo\nsequential sum = 150 (took ~0ms)\nparallel  sum = 150 (took ~0ms)\ndone\n";
    let stdout,postDeliveryStdout;
    if(action==="undefined") {
      const length=functionAt(ex,"__stdout_prepare")();stdout="";
      for(let i=0;i<length;i++)stdout+=String.fromCharCode(functionAt(ex,"__stdout_char")(i));
      assert.equal(stdout,expectedStdout);
    }
    // Repeated timer delivery cannot re-run a completed continuation.
    const completedJobs=[...h.jobs];for(const fire of completedJobs)fire();drain();assert.equal(h.jobs.length,completedJobs.length);assert.equal(state(promise),after);
    if(action!=="undefined")assert.equal(value(promise),actual);
    else {
      assert.equal(functionAt(ex,"__dynamic_boundary_tag")(value(promise)),2);
      const length=functionAt(ex,"__stdout_prepare")();postDeliveryStdout="";
      for(let i=0;i<length;i++)postDeliveryStdout+=String.fromCharCode(functionAt(ex,"__stdout_char")(i));
      assert.equal(postDeliveryStdout,expectedStdout);assert.equal(postDeliveryStdout,stdout);
    }
    values.push({action,before,after,actual,timeline,events:h.events,...(stdout===undefined?{}:{stdout,postDeliveryStdout}),instantiatedBinary:h.instantiatedBinary});
  }
  return values;
}
const rows=[];
for(const fixture of fixtures) {
  const row={id:fixture.id,fixture};rows.push(row);
  observe({kind:"row-start",id:fixture.id});
  try {
    const result=await awaitStep(compiler.compile(fixture.source,{fileName:"frame-body-"+fixture.id+".ts",target:fixture.target,experimentalIR:true,trackFallbacks:true,trackIrOutcomes:true,skipSemanticDiagnostics:true,emitWat:true,...(fixture.action==="family"?{hostBridge:"always"}:{})}),{phase:"compile",id:fixture.id});
    row.result=dataResult(result);row.binary=Buffer.from(result.binary).toString("base64");row.wat=result.wat;
    assert.equal(result.success,true,JSON.stringify(result.errors));assert.equal(WebAssembly.validate(result.binary),true);
    assert.equal(result.irPostClaimErrors?.length??0,0);
    row.imports=WebAssembly.Module.imports(new WebAssembly.Module(result.binary));row.exports=WebAssembly.Module.exports(new WebAssembly.Module(result.binary));
    if(fixture.action==="family") row.values=await executeFamily(result);
    else {
      const h=await instantiate(result,fixture.action);
      let actual,beforeValue;
      if(fixture.action==="host")actual=await awaitStep(runtime.wrapCompiledExports(result,h.instance).main(),{phase:"host-execution",id:fixture.id});
      else {beforeValue=functionAt(h.ex,"kick")();for(let i=0;i<8;i++)functionAt(h.ex,"__drain_microtasks")();actual=functionAt(h.ex,fixture.getter)();}
      assert.equal(actual,fixture.expected);row.values=[{actual,...(beforeValue===undefined?{}:{before:beforeValue}),instantiatedBinary:h.instantiatedBinary}];
    }
    row.kind="executed";
  } catch(error) {row.kind="failed";row.error={name:error.name,message:error.message,...(error.code===undefined?{}:{code:error.code}),...(error.context===undefined?{}:{context:error.context})};}
  observe({kind:"row-completed",id:fixture.id,verdict:row.kind});
}
assert.equal(rows.length,5);assert.deepEqual(snapshot(),before,"source changed during measurement");
console.log("FRAME_BODY_RECEIPT="+JSON.stringify({schema:"frame-body-source-preservation-v1",root,arm,urls,sourceFiles:before,fixtures,rows,closureCertified:false,physicalAcceptanceCertified:false,retirementCertified:false}));
`;

interface PublicArm {
  schema: string;
  root: string;
  arm: string;
  urls: string[];
  sourceFiles: [string, string][];
  fixtures: unknown[];
  rows: {
    id: string;
    kind: string;
    binary: string;
    wat: string;
    result: unknown;
    error?: unknown;
    values: { instantiatedBinary: string; action?: string }[];
  }[];
  closureCertified: boolean;
  physicalAcceptanceCertified: boolean;
  retirementCertified: boolean;
}
async function executeArm(compilerRoot: string, arm: "baseline" | "candidate", directory: string): Promise<PublicArm> {
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", publicArmSource, compilerRoot, arm],
    {
      cwd: compilerRoot,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const started = {
    arm,
    root: realpathSync(compilerRoot),
    pid: child.pid,
    node: process.execPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, `${arm}-started.json`), JSON.stringify(started, null, 2));
  console.log(`frame-body child ${arm}: pid=${child.pid}; root=${compilerRoot}; progress=${directory}`);
  let output = "",
    pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    appendFileSync(join(directory, `${arm}.log`), chunk);
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop()!;
    for (const line of lines)
      if (line.startsWith("FRAME_BODY_PROGRESS=")) {
        const progress = line.slice("FRAME_BODY_PROGRESS=".length);
        appendFileSync(join(directory, `${arm}-progress.jsonl`), progress + "\n");
        console.log(`${arm}: ${progress}`);
      }
  });
  child.stderr.on("data", (chunk: string) => appendFileSync(join(directory, `${arm}.stderr.log`), chunk));
  await new Promise<void>((resolveTerminal, rejectTerminal) => {
    child.once("error", (error) => {
      writeFileSync(join(directory, `${arm}-terminal.json`), JSON.stringify({ ...started, error: error.message }));
      rejectTerminal(error);
    });
    child.once("close", (code, signal) => {
      writeFileSync(
        join(directory, `${arm}-terminal.json`),
        JSON.stringify({ ...started, code, signal, completedAt: new Date().toISOString() }, null, 2),
      );
      if (code !== 0 || signal !== null)
        rejectTerminal(
          new Error(`${arm} child terminated code=${code} signal=${signal}; retained evidence ${directory}`),
        );
      else resolveTerminal();
    });
  });
  const lines = output.split("\n").filter((line) => line.startsWith("FRAME_BODY_RECEIPT="));
  const report = JSON.parse(exactly(lines, `${arm} terminal receipt`).slice("FRAME_BODY_RECEIPT=".length)) as PublicArm;
  writeFileSync(join(directory, `${arm}.json`), JSON.stringify(report, null, 2));
  return report;
}
function validateArm(report: PublicArm, expectedRoot: string): void {
  expect(report.schema).toBe("frame-body-source-preservation-v1");
  expect(report.root).toBe(realpathSync(expectedRoot));
  expect(report.urls.slice(0, 2)).toEqual([
    new URL(`file://${report.root}/src/index.ts`).href,
    new URL(`file://${report.root}/src/runtime.ts`).href,
  ]);
  expect(report.sourceFiles.length).toBeGreaterThan(1000);
  expect(report.rows.map((row) => row.id)).toEqual([
    "family",
    "multi-await",
    "try-catch",
    "try-finally",
    "late-import",
  ]);
  for (const row of report.rows) {
    expect(row.kind, JSON.stringify({ id: row.id, error: row.error })).toBe("executed");
    expect(Buffer.from(row.binary, "base64").length).toBeGreaterThan(8);
    expect(row.wat.length).toBeGreaterThan(0);
    expect(row.values).toHaveLength(row.id === "family" ? 8 : 1);
    if (row.id === "family")
      expect(row.values.map((value) => value.action)).toEqual([
        "pending-70",
        "non-i31",
        "sequential",
        "parallel-reverse",
        "empty",
        "sequential-reject",
        "parallel-reject",
        "undefined",
      ]);
    for (const value of row.values) expect(value.instantiatedBinary).toBe(row.binary);
  }
  expect(report.closureCertified).toBe(false);
  expect(report.physicalAcceptanceCertified).toBe(false);
  expect(report.retirementCertified).toBe(false);
}
describe("public-source preservation controls, not async physical acceptance", () => {
  it("executes five live fixtures and eight family scenarios against independent current-root oracles", async () => {
    const baseline = process.env.JS2WASM_FRAME_BODY_BASELINE_ROOT;
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(join(root, ".tmp", "frame-body-preservation-"));
    const after = await executeArm(root, "candidate", directory);
    validateArm(after, root);
    if (baseline !== undefined) {
      assert.notEqual(realpathSync(baseline), realpathSync(root), "baseline cannot be the candidate");
      // Explicit historical mode only. Serial children, no timeout/automatic kill.
      const before = await executeArm(baseline, "baseline", directory);
      validateArm(before, baseline);
      expect(after.fixtures).toEqual(before.fixtures);
      expect(after.rows).toEqual(before.rows);
      writeFileSync(
        join(directory, "verdict.json"),
        JSON.stringify({
          currentRootOracles: true,
          historicalPair: "passed",
          artifacts: 5,
          executionsPerRoot: 12,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        }),
      );
      console.log(
        `preservation-only: 5 paired artifacts / 12 executed rows per root; evidence ${directory}; physical acceptance NOT CERTIFIED`,
      );
    } else {
      writeFileSync(
        join(directory, "verdict.json"),
        JSON.stringify({
          currentRootOracles: true,
          historicalPair: "NOT_RUN",
          artifacts: 5,
          executions: 12,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        }),
      );
      console.log(
        `current-root only: 5 artifacts / 12 executed rows; historical pair NOT RUN (set JS2WASM_FRAME_BODY_BASELINE_ROOT explicitly); evidence ${directory}; physical acceptance NOT CERTIFIED`,
      );
    }
    // No paired test is skipped or counted: its verdict is explicitly NOT_RUN
    // unless the caller supplies the immutable historical compiler root.
  }, 0);
});
