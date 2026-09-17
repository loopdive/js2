// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Standalone public-source preservation only. Not a prepared-consumer witness.
// No WAT positional type classification, source instrumentation, or host fallback.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CompileResult } from "../src/index.js";
const instrument=fileURLToPath(import.meta.url);
const instrumentRoot=resolve(dirname(instrument),"..");
const fixturePath=join(dirname(instrument),"fixtures/3518-promise-resolution-public-pair.json");
const BASE="2b9cb408c18446361fcf9837045067d1fd97c642";
const SOURCE_HASHES={
  "src/codegen/async-scheduler.ts":"159c7eba9ed415784307a460aa8617fd31a65850b621966d1e3f22fedc4d1723",
  "src/codegen/closed-method-dispatch.ts":"9379464bd8386f5b203bdfc2d21d4dbb2a9584529b9a8cac53441f5124e02dfc",
  "src/runtime/wasmgc/promise/resolution-bodies.ts":"a68e90829a719de5a83898e0df10eee61aed10cc1f6355391f7212bc9e52fe91",
  "src/runtime/wasmgc/promise/thenable-bodies.ts":"9a802504e895b011a9e3b7a2a5cf975046fd679a1a14ce5af37ca410f88ff3ec",
};

// Receipt primitives reused from issue-3518-promise-settlement-source-preservation.test.ts.
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

const controls = {
  JS2WASM_IR_GVN: "0",
  JS2WASM_IR_OWNERSHIP: "0",
  JS2WASM_IR_ESCAPE: "0",
  IR_VERIFY_ALLOC: "0",
  JS2WASM_IR_VERIFY_DOMINANCE_NAIVE: "0",
  JS2WASM_IR_INLINE: "0",
};

function envFor(root: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key))
      Reflect.deleteProperty(env, key);
  return {
    ...env,
    ...controls,
    NODE_OPTIONS: "--max-old-space-size=2048",
    TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
    TSX_DISABLE_CACHE: "1",
  };
}

function launch() {
  return {
    argv: process.execArgv,
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key))
        .sort(),
    ),
  };
}

function tree(root: string, directory: string): [string, string][] {
  const result: [string, string][] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...tree(root, path));
    else if (entry.isFile()) result.push([path, sha(readFileSync(join(root, path)))]);
  }
  return result;
}

function snapshot(root: string) {
  const files = tree(root, "src");
  return {
    root,
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "src"], {
      encoding: "utf8",
    }),
    files,
    sha256: sha(JSON.stringify(files)),
  };
}

function runtime(root: string) {
  const req = createRequire(join(root, "package.json"));
  const tsx = dirname(req.resolve("tsx/package.json"));
  const esbuild = dirname(req.resolve("esbuild/package.json"));
  const binaryPackage = dirname(
    createRequire(join(esbuild, "package.json")).resolve(`@esbuild/${process.platform}-${process.arch}/package.json`),
  );
  return {
    node: process.version,
    versions: process.versions,
    exec: realpathSync(process.execPath),
    execSha256: sha(readFileSync(process.execPath)),
    tsx: tree(tsx, "dist"),
    tsxPackage: sha(readFileSync(join(tsx, "package.json"))),
    esbuild: tree(esbuild, "lib"),
    esbuildPackage: sha(readFileSync(join(esbuild, "package.json"))),
    binary: tree(binaryPackage, "bin"),
    typescript: sha(readFileSync(req.resolve("typescript"))),
    config: sha(read(root, "tsconfig.json")),
    instrument: sha(readFileSync(instrument)),
  };
}

function data(value: unknown): unknown {
  const seen = new Map<object, number>();
  function visit(v: any): any {
    if (v === undefined) return { $undefined: true };
    if (typeof v === "number" && !Number.isFinite(v)) return { $number: String(v) };
    if (typeof v === "bigint") return { $bigint: String(v) };
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return { $ref: seen.get(v) };
    seen.set(v, seen.size);
    if (v instanceof Error)
      return Object.fromEntries(
        [...new Set(["name", "message", "stack", "cause", ...Object.getOwnPropertyNames(v)])].map((k) => [
          k,
          visit((v as Error & Record<string, unknown>)[k]),
        ]),
      );
    if (Array.isArray(v)) return v.map(visit);
    if (v instanceof Map) return { $map: [...v].map(([k, w]) => [visit(k), visit(w)]) };
    if (v instanceof Set) return { $set: [...v].map(visit) };
    return Object.fromEntries(Object.keys(v).map((k) => [k, visit(v[k])]));
  }
  return visit(value);
}

async function settle<T>(promise: Promise<T>, phase: string): Promise<T> {
  let rejectIdle!: (error: Error) => void;
  const idle = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const onIdle = () => {
    const error = Object.assign(new Error("unsettled recorder await: " + phase), {
      code: "ERR_RECORDER_UNSETTLED_AWAIT",
      phase,
    });
    rejectIdle(error);
  };
  process.once("beforeExit", onIdle);
  try {
    return await Promise.race([promise, idle]);
  } finally {
    process.removeListener("beforeExit", onIdle);
  }
}

function artifact(result: CompileResult) {
  const bytes = result.binary;
  const module = new WebAssembly.Module(bytes);
  return {
    binary: Buffer.from(bytes).toString("base64"),
    wat: result.wat,
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
    resourceOrder: result.wat
      .split("\n")
      .filter((line) => /^ {2}\((?:type|import|global|func|export|elem|data)\b/.test(line)),
    units: data({
      compiled: result.irCompiledFuncs,
      outcomes: result.irOutcomes,
      postClaimErrors: result.irPostClaimErrors,
    }),
    stringPool: data(result.stringPool),
  };
}

const FIXTURE_SHA="fb38fbd8180ba54b029b5ec8034929b301d9ab5831f4879385aaebcb417fa0b8";
assert.equal(sha(readFileSync(fixturePath)),FIXTURE_SHA,"fixed recipe receipt");
const fixtureFile=JSON.parse(readFileSync(fixturePath,"utf8"));
assert.equal(fixtureFile.schema,"promise-resolution-public-fixtures-v1");
assert.equal(fixtureFile.base,BASE);
assert.equal(fixtureFile.recipes.length,12);
const matrix=fixtureFile.recipes.flatMap((recipe:any)=>[false,true].map(experimentalIR=>({
  ...recipe,id:recipe.id+(experimentalIR?"-ir":"-legacy"),
  options:{target:"standalone",nativeStrings:true,experimentalIR,emitWat:true,
    skipSemanticDiagnostics:false,trackFallbacks:true,trackIrOutcomes:true,
    fileName:"promise-resolution-"+recipe.id+".ts",...recipe.options},
})));
assert.equal(matrix.length,24);
assert.equal(new Set(matrix.map((x:any)=>x.id)).size,24);
const plannedActions=matrix.reduce((n:number,f:any)=>n+f.actions.length,0)*4;
assert.equal(plannedActions,184);

function argumentsOf(argv:string[]) {
  const values:Record<string,string>={};
  for(let i=0;i<argv.length;i+=2) {
    assert(["--baseline","--candidate","--output","--arm"].includes(argv[i]),"unknown option");
    assert(argv[i+1] && !argv[i+1].startsWith("--"),"missing option value");
    assert.equal(values[argv[i]],undefined,"duplicate option");
    values[argv[i]]=argv[i+1];
  }
  assert(values["--baseline"] && values["--candidate"] && values["--output"],"required explicit roots/output");
  const baseline=realpathSync(values["--baseline"]),candidate=realpathSync(values["--candidate"]);
  assert.notEqual(baseline,candidate);
  const output=resolve(values["--output"]);
  assert(output.startsWith(join(instrumentRoot,".tmp/")),"writes restricted to instrument worktree scratch");
  const arm=values["--arm"];
  assert(arm===undefined || arm==="baseline" || arm==="candidate");
  return {roots:{baseline,candidate},output,arm:arm as "baseline"|"candidate"|undefined};
}
function preflight(roots:{baseline:string;candidate:string}) {
  for(const root of Object.values(roots))assert.equal(execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),BASE);
  assert.equal(execFileSync("git",["-C",roots.baseline,"status","--porcelain","--untracked-files=all"],{encoding:"utf8"}),"","baseline must remain clean");
  for(const [path,hash] of Object.entries(SOURCE_HASHES))assert.equal(sha(readFileSync(join(roots.candidate,path))),hash,path);
  const baseline=snapshot(roots.baseline),candidate=snapshot(roots.candidate);
  const old=new Map(baseline.files),now=new Map(candidate.files);
  const changed=[...new Set([...old.keys(),...now.keys()])].filter(p=>old.get(p)!==now.get(p)).sort();
  assert.deepEqual(changed,Object.keys(SOURCE_HASHES).sort(),"exact four production paths, no unrelated seeded source");
  return {baseline,candidate,changed};
}
function observation(value:any) { return data(value); }
async function measure(api:any,fixture:any) {
  const row:any={id:fixture.id,fixture,compilations:[],executions:[],kind:"pending",expectedOK:false};
  let phase="compile";
  try {
    const result=await settle(api.compile(fixture.source,fixture.options),"compile:"+fixture.id);
    const compilation:any={source:fixture.source,options:fixture.options,success:result.success,
      errors:data(result.errors),artifact:{binary:Buffer.from(result.binary).toString("base64"),wat:result.wat}};
    row.compilations.push(compilation);
    if(!result.success){row.kind="refused";row.phase=phase;return row;}
    phase="artifact";
    compilation.artifact=artifact(result);
    compilation.artifact.completeResourceOrder=result.wat.split("\n").filter((line:string)=>
      /^\s+\((?:rec|type|import|global|func|tag|table|memory|export|elem|data)(?:\s|\))/.test(line));
    assert(result.binary.length>8 && result.wat.length>0);
    assert.deepEqual(compilation.artifact.imports,[],"no host/WASI/synthetic fallback");
    assert.deepEqual(result.imports,[],"declared imports");
    // Each repetition starts a fresh real module instance: old fixtures contain
    // module-local result cells and must not inherit the first repetition's state.
    for(let repetition=0;repetition<2;repetition++) {
      phase="instantiate";
      const bytes=Buffer.from(result.binary),input=bytes.toString("base64");
      assert.equal(input,compilation.artifact.binary);
      const execution:any={repetition,instantiationInputBinary:input,instantiatedBinary:null,actions:[]};
      row.executions.push(execution);
      const {instance}=await settle(WebAssembly.instantiate(bytes,{}),"instantiate:"+fixture.id);
      execution.instantiatedBinary=input;
      phase="execute";
      for(let ordinal=0;ordinal<fixture.actions.length;ordinal++) {
        const action=fixture.actions[ordinal],fn=instance.exports[action.export];
        assert.equal(typeof fn,"function","required real export "+action.export);
        const actual=observation((fn as Function)(...action.args));
        // Retain every later trace observation even if this value is wrong.
        execution.actions.push({ordinal,export:action.export,args:action.args,value:actual});
      }
    }
    row.kind="executed";row.phase="completed";
    row.expectedOK=row.executions.every((e:any)=>e.actions.every((a:any,i:number)=>
      JSON.stringify(a.value)===JSON.stringify(fixture.actions[i].expected)));
  } catch(error) {row.kind="threw";row.phase=phase;row.error=data(error);}
  return row;
}
async function arm(config:ReturnType<typeof argumentsOf>) {
  const label=config.arm!,root=config.roots[label],output=join(config.output,label+".json");
  assert.equal(process.cwd(),root);
  assert.equal(process.env.TSX_TSCONFIG_PATH,join(root,"tsconfig.json"));
  assert.equal(process.env.TSX_DISABLE_CACHE,"1");
  assert.equal(process.env.ESBUILD_BINARY_PATH,undefined);
  for(const [key,value] of Object.entries(controls))assert.equal(process.env[key],value);
  const expected=preflight(config.roots),before=snapshot(root),identity=runtime(root);
  const urls={compile:pathToFileURL(join(root,"src/index.ts")).href};
  const api=await settle(import(urls.compile),"selected-public-root");
  const rows=[];
  for(const fixture of matrix) {
    appendFileSync(output+".progress.jsonl",JSON.stringify({stage:"start",id:fixture.id})+"\n");
    const row=await measure(api,fixture);rows.push(row);
    appendFileSync(output+".progress.jsonl",JSON.stringify({stage:"completed",row})+"\n");
  }
  const after=snapshot(root);assert.deepEqual(after,before);
  assert.deepEqual(preflight(config.roots),expected);
  assert.deepEqual(runtime(root),identity);assert.equal(sha(readFileSync(fixturePath)),FIXTURE_SHA);
  writeFileSync(output,JSON.stringify({schema:"promise-resolution-public-v1",
    provenance:{label,before,after,identity,urls,launch:launch(),fixtureSha256:FIXTURE_SHA,matrixSha256:sha(JSON.stringify(matrix))},rows},null,2));
}
function environmentReceipt(env:NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([key])=>
    /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key)).sort());
}
async function child(config:ReturnType<typeof argumentsOf>,label:"baseline"|"candidate") {
  const root=config.roots[label],output=join(config.output,label+".json");
  const loader=createRequire(join(root,"package.json")).resolve("tsx/esm");
  const args=["--import",loader,instrument,"--baseline",config.roots.baseline,
    "--candidate",config.roots.candidate,"--output",config.output,"--arm",label];
  const env=envFor(root),launchReceipt={root,label,exec:process.execPath,args,env:environmentReceipt(env),output};
  const launchFile=join(config.output,label+".launch.json");
  writeFileSync(launchFile,JSON.stringify(launchReceipt,null,2));
  const stdout=openSync(join(config.output,label+".stdout.log"),"wx"),stderr=openSync(join(config.output,label+".stderr.log"),"wx");
  let terminal:any;
  try {
    terminal=await new Promise(resolveTerminal=>{
      const processChild=spawn(process.execPath,args,{cwd:root,env,stdio:["ignore",stdout,stderr]});
      console.log(JSON.stringify({stage:"child-start",label,pid:processChild.pid,output}));
      let error:any=null;
      processChild.once("error",e=>{error=data(e)});
      processChild.once("close",(code,signal)=>resolveTerminal({code,signal,error,pid:processChild.pid}));
    });
  } finally {closeSync(stdout);closeSync(stderr);}
  let reportSha256:string|null=null;try{reportSha256=sha(readFileSync(output))}catch{}
  const receipt={...terminal,root,label,output,reportSha256,launchSha256:sha(readFileSync(launchFile))};
  writeFileSync(join(config.output,label+".terminal.json"),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({stage:"child-terminal",...receipt}));
  return receipt;
}
function differences(a:any,b:any,path="$",out:any[]=[]):any[] {
  if(Object.is(a,b))return out;
  if(!a || !b || typeof a!=="object" || typeof b!=="object" || Array.isArray(a)!==Array.isArray(b)) {
    out.push({path,baseline:a,candidate:b});return out;
  }
  for(const key of new Set([...Object.keys(a),...Object.keys(b)]))differences(a[key],b[key],path+"."+key,out);
  return out;
}
function validate(report:any,label:"baseline"|"candidate",expected:any,roots:{baseline:string;candidate:string}) {
  const p=report.provenance,root=roots[label],gaps:any[]=[];
  assert.equal(report.schema,"promise-resolution-public-v1");assert.equal(p.label,label);
  assert.deepEqual(p.before,expected[label]);assert.deepEqual(p.after,p.before);
  assert.deepEqual(p.identity,runtime(root));assert.equal(p.fixtureSha256,FIXTURE_SHA);
  assert.equal(p.matrixSha256,sha(JSON.stringify(matrix)));
  assert.deepEqual(p.urls,{compile:pathToFileURL(join(root,"src/index.ts")).href});
  assert.deepEqual(p.launch.env,environmentReceipt(envFor(root)));
  assert.deepEqual(p.launch.argv,["--import",createRequire(join(root,"package.json")).resolve("tsx/esm")]);
  assert.equal(report.rows.length,24);
  let observations=0,instances=0,executed=0;
  for(let i=0;i<matrix.length;i++){
    const row=report.rows[i],fixture=matrix[i];assert.equal(row.id,fixture.id);assert.deepEqual(row.fixture,fixture);
    if(row.kind!=="executed"){gaps.push({id:row.id,kind:row.kind,phase:row.phase});continue;}
    executed++;
    assert.equal(row.compilations.length,1);
    const c=row.compilations[0],e=c.artifact;
    assert.equal(c.source,fixture.source);assert.deepEqual(c.options,fixture.options);assert.equal(c.success,true);
    const mod=new WebAssembly.Module(Buffer.from(e.binary,"base64"));
    assert.deepEqual(e.imports,WebAssembly.Module.imports(mod));assert.deepEqual(e.imports,[]);
    assert.deepEqual(e.exports,WebAssembly.Module.exports(mod));assert(e.wat.length>0);
    assert.equal(row.executions.length,2);
    let expectedOK=true;
    for(let rep=0;rep<2;rep++){
      const execution=row.executions[rep];assert.equal(execution.repetition,rep);
      assert.equal(execution.instantiationInputBinary,e.binary);assert.equal(execution.instantiatedBinary,e.binary);
      instances++;
      assert.equal(execution.actions.length,fixture.actions.length);
      for(let n=0;n<fixture.actions.length;n++){
        const a=execution.actions[n],wanted=fixture.actions[n];
        assert.equal(a.ordinal,n);assert.equal(a.export,wanted.export);assert.deepEqual(a.args,wanted.args);
        observations++;
        if(differences(a.value,wanted.expected).length) {
          expectedOK=false;gaps.push({id:row.id,repetition:rep,export:a.export,ordinal:n,actual:a.value,expected:wanted.expected});
        }
      }
    }
    assert.equal(row.expectedOK,expectedOK,"independently recomputed expectation verdict");
  }
  return {executed,requiredRows:24,instances,observations,gaps,ok:gaps.length===0};
}
async function pair(config:ReturnType<typeof argumentsOf>) {
  const expected=preflight(config.roots);
  mkdirSync(config.output,{recursive:false});
  writeFileSync(join(config.output,"expected.json"),JSON.stringify({roots:config.roots,expected,matrix,fixtureSha256:FIXTURE_SHA,harnessSha256:sha(readFileSync(instrument)),identity:runtime(config.roots.baseline)},null,2));
  const terminals=[];
  for(const label of ["baseline","candidate"] as const)terminals.push(await child(config,label));
  for(const t of terminals){assert.equal(t.code,0);assert.equal(t.signal,null);assert.equal(t.error,null);assert.equal(t.reportSha256,sha(readFileSync(t.output)));}
  const a=JSON.parse(readFileSync(terminals[0].output,"utf8")),b=JSON.parse(readFileSync(terminals[1].output,"utf8"));
  const baseline=validate(a,"baseline",expected,config.roots),candidate=validate(b,"candidate",expected,config.roots);
  const rawDifferences=differences(a.rows,b.rows);
  const preservationOK=rawDifferences.length===0,semanticOK=baseline.ok&&candidate.ok;
  const negatives:any[]=[];
  const mustReject=(name:string,operation:()=>unknown)=>{assert.throws(operation);negatives.push({name,rejected:true});};
  const clone=(mutate:(x:any)=>void)=>{const x=structuredClone(b);mutate(x);return x;};
  mustReject("drop-row",()=>validate(clone(x=>x.rows.pop()),"candidate",expected,config.roots));
  mustReject("wrong-root",()=>validate(a,"candidate",expected,config.roots));
  mustReject("changed-provenance",()=>validate(clone(x=>x.provenance.identity.node="stale"),"candidate",expected,config.roots));
  const index=b.rows.findIndex((r:any)=>r.kind==="executed");assert(index>=0,"nonempty comparator positive");
  mustReject("changed-instantiation-byte",()=>validate(clone(x=>x.rows[index].executions[0].instantiatedBinary+="AA"),"candidate",expected,config.roots));
  const wrong=clone(x=>{x.rows[index].executions[0].actions[0].value={$wrong:true};x.rows[index].expectedOK=false;});
  assert.equal(validate(wrong,"candidate",expected,config.roots).ok,false);
  assert(differences(a.rows,wrong.rows).length>0);negatives.push({name:"wrong-value-cannot-pass-semantic-acceptance",rejected:true});
  const changed=clone(x=>x.rows[index].compilations[0].errors.push({message:"changed outcome"}));
  assert(differences(a.rows,changed.rows).length>0);negatives.push({name:"changed-outcome-not-equal",rejected:true});
  const comparison={schema:"promise-resolution-public-pair-v1",preservationOK,semanticOK,
    acceptanceOK:preservationOK&&semanticOK,denominator:{pairs:24,rows:48,instances:96,exportObservations:184},
    baseline,candidate,rawDifferences,negativeControls:negatives,terminals};
  writeFileSync(join(config.output,"comparison.json"),JSON.stringify(comparison,null,2));
  assert.deepEqual(preflight(config.roots),expected);
  console.log(JSON.stringify({stage:"comparison",preservationOK,semanticOK,baseline,candidate,rawDifferenceCount:rawDifferences.length}));
  if(!comparison.acceptanceOK)process.exitCode=1;
}
const config=argumentsOf(process.argv.slice(2));
try{if(config.arm)await arm(config);else await pair(config);}
catch(error){
  if(config.arm)writeFileSync(join(config.output,config.arm+".fatal.json"),JSON.stringify(data(error),null,2));
  console.error(error);process.exitCode=1;
}
