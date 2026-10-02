// (#6731) Native generator shapes tailwindcss's standalone bundle (lib.mjs) uses,
// lowered by the Wasm-native state machine with no host imports: `break` /
// `continue` / labelled jumps and `return` out of yielding loops (closing a
// for-of's iterator), `switch` with a yielding case, binding-pattern for-of
// heads, yields in a discarded `if`-condition operand, self-contained nested
// generator declarations, block-scoped `let` shadowing across suspensions, and
// a generator name re-declared in two functions. Before this slice every row
// except the control was refused with the #680 diagnostic, leaked host imports,
// or failed at compile time; the fixtures are tailwindcss 4.3.3 generators
// verbatim (`ii`, `Tt`, `Bl`, `ti`) or reductions of them.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-6731.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  const errors = result.errors.filter((e) => e.severity === "error");
  if (!result.success || errors.length > 0) {
    throw new Error(`Compile failed:\n${errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports as Record<string, Function>;
  exports.__module_init?.();
  return exports.test!();
}

describe("#6731 native generators — tailwindcss standalone shapes", () => {
  it("tailwindcss `ii`: `break` out of a yielding `for (;;)`, `&&`-guarded yields", async () => {
    const source = [
      'function*ii(e,i){i(e)&&(yield[e,null]);let r=e.lastIndexOf("-");for(;r>0;){let t=e.slice(0,r);if(i(t)){let n=[t,e.slice(r+1)];if(n[1]===""||n[0]==="@"&&i("@")&&e[r]==="-")break;yield n}r=e.lastIndexOf("-",r-1)}e[0]==="@"&&i("@")&&(yield["@",e.slice(1)])}',
      'export function test(){let s="";for(const p of ii("bg-red-500",m=>m==="bg"||m==="bg-red"||m==="bg-red-500"))s+=p[0]+"|"+(p[1]===null?"N":p[1])+";";for(const p of ii("@container-x",m=>m==="@"||m==="@container"))s+=p[0]+"|"+(p[1]===null?"N":p[1])+";";let x0=0;for(let q=0;q<s.length;q++)x0=(x0*31+s.charCodeAt(q))%1000003;return x0}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(201856);
  });

  it("tailwindcss `Tt`: a nested self-contained generator declaration, `yield*` in an `&&` operand", async () => {
    const source = [
      'function*Tt(e){function*i(r,t=null){yield[r,t],r.kind==="compound"&&(yield*i(r.variant,r))}yield*i(e,null)}',
      'export function test(){let s="";for(const [v,p] of Tt({kind:"compound",variant:{kind:"compound",variant:{kind:"static",root:"x"}}}))s+=v.kind+(p?p.kind:"N")+";";let x0=0;for(let q=0;q<s.length;q++)x0=(x0*31+s.charCodeAt(q))%1000003;return x0}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(694830);
  });

  it("tailwindcss `Bl`: `for (let [r, t] of map)` binding-pattern head over a Map", async () => {
    const source = [
      'var Fl=new Map([["order-none","order-0"],["break-words","wrap-break-word"],["overflow-ellipsis","text-ellipsis"]]),Wl=new Map([[/^(-)?start-(.*?)$/,"$1inset-s-$2"],[/^(-)?end-(.*?)$/,"$1inset-e-$2"]]);',
      "function*Bl(e){let i=Fl.get(e);i&&(yield i);for(let[r,t]of Wl){let n=e.replace(r,t);n!==e&&(yield n)}}",
      'export function test(){let s="";for(const x of Bl("order-none"))s+=x+";";for(const x of Bl("-start-4"))s+=x+";";for(const x of Bl("end-2"))s+=x+";";let x0=0;for(let q=0;q<s.length;q++)x0=(x0*31+s.charCodeAt(q))%1000003;return x0}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(232833);
  });

  it("tailwindcss `ti`: continue / return / nested-loop break in a pattern-head for-of, shadowed `let`s", async () => {
    const source = [
      "var Qr=95,Xr=97,ei=122,Ln=58,er=/^[a-z0-9.%-]+$/;",
      "function z(e,s){return e.split(s)}",
      'function Qt(d){return {kind:"named",value:d}}',
      "function Ce(x){return x}",
      'function ye(x){return x!==""}',
      'function*ii(e,i){i(e)&&(yield[e,null]);let r=e.lastIndexOf("-");for(;r>0;){let t=e.slice(0,r);if(i(t)){let n=[t,e.slice(r+1)];if(n[1]===""||n[0]==="@"&&i("@")&&e[r]==="-")break;yield n}r=e.lastIndexOf("-",r-1)}e[0]==="@"&&i("@")&&(yield["@",e.slice(1)])}',
      'function*ti(e,i){let r=z(e,":");if(i.theme.prefix){if(r.length===1||r[0]!==i.theme.prefix)return null;r.shift()}let t=r.pop(),n=[];for(let m=r.length-1;m>=0;--m){let u=i.parseVariant(r[m]);if(u===null)return;n.push(u)}let s=!1;t[t.length-1]==="!"?(s=!0,t=t.slice(0,-1)):t[0]==="!"&&(s=!0,t=t.slice(1)),i.utilities.has(t,"static")&&!t.includes("[")&&(yield{kind:"static",root:t,variants:n,important:s,raw:e});let[l,d=null,f]=z(t,"/");if(f)return;let c=d===null?null:Qt(d);if(d!==null&&c===null)return;if(l[0]==="["){if(l[l.length-1]!=="]")return;let m=l.charCodeAt(1);if(m!==Qr&&!(m>=Xr&&m<=ei))return;l=l.slice(1,-1);let u=l.indexOf(":");if(u===-1||u===0||u===l.length-1)return;let v=l.slice(0,u),h=Ce(l.slice(u+1));if(!ye(h))return;yield{kind:"arbitrary",property:v,value:h,modifier:c,variants:n,important:s,raw:e};return}let p;if(l[l.length-1]==="]"){let m=l.indexOf("-[");if(m===-1)return;let u=l.slice(0,m);if(!i.utilities.has(u,"functional"))return;let v=l.slice(m+1);p=[[u,v]]}else if(l[l.length-1]===")"){let m=l.indexOf("-(");if(m===-1)return;let u=l.slice(0,m);if(!i.utilities.has(u,"functional"))return;let v=l.slice(m+2,-1),h=z(v,":"),k=null;if(h.length===2&&(k=h[0],v=h[1]),v[0]!=="-"||v[1]!=="-"||!ye(v))return;p=[[u,k===null?`[var(${v})]`:`[${k}:var(${v})]`]]}else p=ii(l,m=>i.utilities.has(m,"functional"));for(let[m,u]of p){let v={kind:"functional",root:m,modifier:c,value:null,variants:n,important:s,raw:e};if(u===null){yield v;continue}{let h=u.indexOf("[");if(h!==-1){if(u[u.length-1]!=="]")return;let y=Ce(u.slice(h+1,-1));if(!ye(y))continue;let S=null;for(let x=0;x<y.length;x++){let b=y.charCodeAt(x);if(b===Ln){S=y.slice(0,x),y=y.slice(x+1);break}if(!(b===Qr||b>=Xr&&b<=ei))break}if(y.length===0||y.trim().length===0||S==="")continue;v.value={kind:"arbitrary",dataType:S||null,value:y}}else{let y=d===null||v.modifier?.kind==="arbitrary"?null:`${u}/${d}`;if(!er.test(u))continue;v.value={kind:"named",value:u,fraction:y}}}yield v}}',
      'function pr(c){let s=c.kind+":"+(c.root||c.property||"")+":"+(c.important?"!":"")+":"+c.variants.length;if(c.value)s+=":"+(c.value.kind||"s")+"="+(typeof c.value==="string"?c.value:c.value.value)+"/"+(c.value.fraction||c.value.dataType||"");if(c.modifier)s+="/m="+c.modifier.value;return s}',
      'export function test(){const util={has(n,k){return k==="static"?n==="flex"||n==="bg-red":n==="bg"||n==="text"||n==="w"}};const ds={theme:{prefix:null},utilities:util,parseVariant(v){return v==="bad"?null:{kind:"static",root:v}}};let s="";for(const c of ["flex","hover:!flex","bg-red-500","bg-red-500/50","[color:red]","bg-[#fff]","bg-[color:red]","text-(--x)","bad:flex","w-1/2/3","bg-red"])for(const x of ti(c,ds))s+=pr(x)+";";let x0=0;for(let q=0;q<s.length;q++)x0=(x0*31+s.charCodeAt(q))%1000003;return x0}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(181500);
  });

  it("`switch` with a yielding case inside nested for-of (tailwindcss `Gi` shape)", async () => {
    const source = [
      'function*Gi(e,i){for(let r of e)for(let t of i.parseCandidate(r))switch(t.kind){case"arbitrary":break;case"static":case"functional":yield t.root;break;default:}}',
      'export function test(){const ds={parseCandidate(r){return r==="x"?[{kind:"arbitrary",root:"A"}]:[{kind:"static",root:r},{kind:"o",root:"O"}]}};let s="";for(const x of Gi(["x","y"],ds))s+=x+";";return s==="y;"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`switch` fall-through, a default in the middle, number and string selectors", async () => {
    const source = [
      'function*g(k){for(const x of k)switch(x){case 1:yield "one";case 2:yield "two";break;case "s":yield "str";default:yield "d";case 9:yield "nine"}}',
      'export function test(){let s="";for(const x of g([1,2,"s",9,7]))s+=x+",";return s==="one,two,two,str,d,nine,nine,d,nine,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`if (A, yield B, C && (yield D), E)` runs the discarded operands first (tailwindcss `Ii`)", async () => {
    const source = [
      'function*g(i,r){if(r.add(i),yield "a",i.length>1&&(yield "b"),i.includes("/")){yield "c"}yield "d"}',
      'export function test(){let s="";for(const x of g("1/2",new Set))s+=x+";";for(const x of g("1",new Set))s+=x+";";return s==="a;b;c;d;a;d;"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("recursive `yield*` with arguments inside a for-of body, early `return`", async () => {
    const source = [
      "function*g(d,r){yield d;if(d>2)return;for(let s of [d+1,d+2])yield*g(s,r)}",
      'export function test(){let s="";for(const x of g(1,0))s+=x+";";return s==="1;2;3;4;3;"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("an `any[]` local (`Array.from(set)`) survives a suspension", async () => {
    const source = [
      'function*Ii(i,r){if(r.has(i))return;r.add(i);yield 1;let n=Array.from(new Set(i.split(" ")));for(let q of n)yield*Ii(q,r)}',
      'export function test(){let c=0;for(const x of Ii("1 2",new Set))c++;return c}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(3);
  });

  it("`break` closes the loop's iterator (IteratorClose, \u00a714.7.5.7)", async () => {
    const source = [
      'function mk(log){let i=0;return {[Symbol.iterator](){return this},next(){i++;return {value:i,done:i>5}},return(){log.push("R");return {done:true}}}}',
      "function*g(it){for(const x of it){if(x===3)break;yield x}yield 99}",
      'export function test(){const log=[];let s="";for(const v of g(mk(log)))s+=v+",";s+=log.join("");return s==="1,2,99,R"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`return` from a for-of body closes the iterator after evaluating the value", async () => {
    const source = [
      'function mk(log){let i=0;return {[Symbol.iterator](){return this},next(){i++;return {value:i,done:i>5}},return(){log.push("R");return {done:true}}}}',
      "function*g(it){for(const x of it){if(x===3)return 7;yield x}yield 99}",
      'export function test(){const log=[];let s="";const G=g(mk(log));let r=G.next();while(!r.done){s+=r.value+",";r=G.next()}s+=r.value+log.join("");return s==="1,2,7R"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`continue` over a typed native-generator subject keeps the loop running", async () => {
    const source = [
      "function*inner(){yield 1;yield 2;yield 3}",
      "function*g(){for(const x of inner()){if(x===2)continue;yield x}}",
      'export function test(){let s="";for(const v of g())s+=v+",";return s==="1,3,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("labelled `continue outer` / `break outer` across nested for-of", async () => {
    const source = [
      "function*g(a){outer:for(const r of a){for(const c of r){if(c===0)continue outer;if(c<0)break outer;yield c}yield 100}yield 7}",
      'export function test(){let s="";for(const v of g([[1,2],[3,0,4],[5],[6,-1,8],[9]]))s+=v+",";return s==="1,2,100,3,5,100,6,7,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`continue` / `break` through a yield-free `finally` replay it", async () => {
    const source = [
      'function*g(a){const log=[];for(const x of a){try{if(x===2)continue;if(x===4)break;yield x}finally{log.push("f"+x)}}yield log.join("")}',
      'export function test(){let s="";for(const v of g([1,2,3,4,5]))s+=v+",";return s==="1,3,f1f2f3f4,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`for (const [k, v] of map)` + `continue` (const pattern bindings initialise)", async () => {
    const source = [
      'function*g(m){for(const [k,v] of m){if(v===null)continue;yield k+"="+v}}',
      'export function test(){let s="";for(const v of g(new Map([["a",1],["b",null],["c",3]])))s+=v+",";return s==="a=1,c=3,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("`for (const {k, v = 5} of list)` object pattern head with a default", async () => {
    const source = [
      "function*g(o){for(const {k,v=5} of o){yield k+v}}",
      'export function test(){let s="";for(const v of g([{k:"a",v:1},{k:"b"}]))s+=v+",";return s==="a1,b5,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("labelled block `break blk` over a yield", async () => {
    const source = [
      "function*g(k){blk:{yield 1;if(k)break blk;yield 2}yield 3}",
      'export function test(){let s="";for(const v of g(true))s+=v+",";for(const v of g(false))s+=v+",";return s==="1,3,1,2,3,"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("block-scoped `let` shadows keep their own frame slots", async () => {
    const source = [
      'function*g(a){let m=a.length;if(m>1){let m=a+"!";yield m}for(let m=0;m<2;m++){yield m}yield m}',
      'export function test(){let s="";for(const x of g("ab"))s+=x+";";return s==="ab!;0;1;2;"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("pattern-head for-of with shadowed `let`s of different types (`ti` excerpt)", async () => {
    const source = [
      'function*g(p){for(let[m,u]of p){let v={m,u};if(u===null){yield v;continue}{let h=u.indexOf("[");if(h!==-1){if(u[u.length-1]!=="]")return;yield h}else{let y=u+"/";yield y}}yield v}}',
      'export function test(){let s="";for(const x of g([["a",null],["b","x[1]"],["c","z"]]))s+=(typeof x==="object"?x.m:x)+";";return s==="a;1;b;z/;c;"?1:2+s.length}',
    ].join("\n");
    expect(await runStandalone(source)).toBe(1);
  });

  it("the same generator name nested in two functions (factory identity)", async () => {
    const source = [
      "function o1(a){let c=0;for(const x of f(2))c+=x;return c;function*f(k){yield a;yield k}}",
      "function o2(a){let c=0;for(const x of f(3))c+=x;return c;function*f(k){yield k;yield a}}",
      "export function test(){return o1(5)*100+o2(7)}",
    ].join("\n");
    expect(await runStandalone(source)).toBe(710);
  });

  it("control: a plain yielding `while` loop (lowered before this slice)", async () => {
    const source = [
      "function*g(n){let i=0;while(i<9){i++;yield i}}",
      "export function test(){let s=0;for(const v of g(3))s=s*10+v;return s}",
    ].join("\n");
    expect(await runStandalone(source)).toBe(123456789);
  });
});
