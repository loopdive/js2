// Diagnostic comparison, not an acceptance test. Every original JS expectation
// and compiler outcome is printed; matching failures do not count as correctness.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(process.argv[2]);
const { compile } = await import(pathToFileURL(resolve(root, "src/index.ts")).href);
const cases = [
  [
    "captured iteration binding",
    34,
    `
function* values(){yield 3;yield 4;}
let first=()=>-1;let second=()=>-1;
function* g(){let i=0;for(const x of values()){
if(i===0)first=()=>x;else second=()=>x;i++;yield 0;}}
export function test(){const it=g();it.next();it.next();
if(!it.next().done)return -1;return first()*10+second();}`,
  ],
  [
    "nested same-name bindings",
    373474,
    `
function* outerValues(){yield 3;yield 4;}
function* innerValues(){yield 7;}
function* g(){for(const x of outerValues()){yield x;
for(const x of innerValues())yield x;yield x;}}
export function test(){const it=g();let result=0;
for(let i=0;i<6;i++){const step=it.next();if(step.done)return -1;result=result*10+step.value;}
return it.next().done?result:-2;}`,
  ],
  [
    "sibling different representations",
    131429,
    `
function* numbers(){yield 3;yield 4;}function* words(){yield "q";}
function* g(){for(const x of numbers())yield typeof x==="number"?x+10:-1;
for(const x of words())yield typeof x==="string"&&x==="q"?29:-2;}
export function test(){const it=g();const a=it.next(),b=it.next(),c=it.next();
if(a.done||b.done||c.done||!it.next().done)return -3;
return a.value*10000+b.value*100+c.value;}`,
  ],
  [
    "unrelated nested parameter",
    34,
    `
function* values(){yield 3;yield 4;}
function* g(){function unrelated(x){return x+100;}for(const x of values())yield x;}
export function test(){const it=g();const a=it.next(),b=it.next();
return !a.done&&!b.done&&it.next().done?a.value*10+b.value:-1;}`,
  ],
];
for (const [name, expected, source] of cases) {
  const js = new Function(source.replace("export function test", "function test") + ";return test();")();
  if (js !== expected) throw new Error(`Invalid JS oracle for ${name}: ${js}`);
  for (const target of ["standalone", "wasi"]) {
    const row = { root, name, target, expected, js };
    try {
      const result = await compile(source, { fileName: "test.ts", target, skipSemanticDiagnostics: true });
      if (!result.success) {
        row.outcome = "compile-error";
        row.errors = result.errors;
      } else {
        const module = await WebAssembly.compile(result.binary);
        row.imports = WebAssembly.Module.imports(module);
        const instance = await WebAssembly.instantiate(module, {});
        row.outcome = "returned";
        row.actual = instance.exports.test();
        row.equal = Object.is(row.actual, js);
      }
    } catch (error) {
      row.outcome = "exception";
      row.error = String(error);
    }
    console.log(JSON.stringify(row));
  }
}
