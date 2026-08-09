// Static census of the test262 verifyProperty population (exact, no sampling).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.env.VP_TEST262_ROOT ?? join(import.meta.dirname, "..", "..", "..", "test262", "test");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith(".js")) yield p;
  }
}

function topLevelCommas(s) {
  const out = [];
  let depth = 0;
  let str = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === "\\") i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) out.push(i);
  }
  return out;
}

function balancedArgs(src, openIdx) {
  let depth = 1;
  let str = null;
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === "\\") i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

const stats = {
  files_total: 0,
  files_fixture: 0,
  files_include_propertyHelper: 0,
  files_call_verifyProperty: 0,
  files_call_verifyCallableProperty: 0,
  files_call_verifyPrimordial: 0,
  files_call_any_verify: 0,
  files_call_deprecated_only: 0,
  callsites_verifyProperty: 0,
  callsites_desc_objlit: 0,
  callsites_desc_undefined: 0,
  callsites_desc_ident_or_other: 0,
  callsites_desc_objlit_with_checkable_field: 0,
  callsites_desc_objlit_accessor_only: 0,
  callsites_desc_objlit_empty: 0,
  files_desc_objlit_with_checkable_field: 0,
};

const filesWithVP = [];

for (const p of walk(ROOT)) {
  stats.files_total++;
  if (process.env.VERBOSE) process.stderr.write(`${stats.files_total} ${p}\n`);
  const rel = relative(ROOT, p);
  if (rel.includes("_FIXTURE")) {
    stats.files_fixture++;
    continue;
  }
  const src = readFileSync(p, "utf8");
  if (/includes:\s*\[[^\]]*propertyHelper\.js/.test(src)) stats.files_include_propertyHelper++;

  const hasVP = /\bverifyProperty\s*\(/.test(src);
  const hasVCP = /\bverifyCallableProperty\s*\(/.test(src);
  const hasVPrim = /\bverifyPrimordial(Callable)?Property\s*\(/.test(src);
  const hasDep = /\bverify(EqualTo|Writable|NotWritable|Enumerable|NotEnumerable|Configurable|NotConfigurable)\s*\(/.test(src);
  if (hasVP) stats.files_call_verifyProperty++;
  if (hasVCP) stats.files_call_verifyCallableProperty++;
  if (hasVPrim) stats.files_call_verifyPrimordial++;
  if (hasVP || hasVCP || hasVPrim) stats.files_call_any_verify++;
  else if (hasDep) stats.files_call_deprecated_only++;
  if (!hasVP) continue;

  let fileHasCheckable = false;
  const re = /\bverifyProperty\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const args = balancedArgs(src, openIdx);
    if (args === null) continue;
    stats.callsites_verifyProperty++;
    const commas = topLevelCommas(args);
    if (commas.length < 2) {
      stats.callsites_desc_ident_or_other++;
      continue;
    }
    const third = args.slice(commas[1] + 1, commas.length >= 3 ? commas[2] : args.length).trim();
    if (third.startsWith("{")) {
      stats.callsites_desc_objlit++;
      const inner = third.slice(1, third.lastIndexOf("}"));
      const keys = new Set();
      for (const km of inner.matchAll(/(^|[,{\s])(["']?)(value|writable|enumerable|configurable|get|set)\2\s*:/g)) {
        keys.add(km[3]);
      }
      const checkable = ["value", "writable", "enumerable", "configurable"].some((k) => keys.has(k));
      if (inner.trim() === "") stats.callsites_desc_objlit_empty++;
      else if (checkable) {
        stats.callsites_desc_objlit_with_checkable_field++;
        fileHasCheckable = true;
      } else stats.callsites_desc_objlit_accessor_only++;
    } else if (third === "undefined") {
      stats.callsites_desc_undefined++;
    } else {
      stats.callsites_desc_ident_or_other++;
    }
  }
  if (fileHasCheckable) stats.files_desc_objlit_with_checkable_field++;
  filesWithVP.push(rel);
}

console.log(JSON.stringify(stats, null, 2));
writeFileSync(join(import.meta.dirname, "vp-files.txt"), filesWithVP.join("\n") + "\n");
console.log("wrote vp-files.txt:", filesWithVP.length);
