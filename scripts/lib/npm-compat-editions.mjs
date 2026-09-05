// Syntax evidence from the exact pinned npm archive. This is deliberately not
// a claim about built-in APIs, external dependencies, or engine compatibility.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupAcorn } from "../../tests/dogfood/setup-acorn.mjs";

export const SYNTAX_EDITIONS = [3, 5, ...Array.from({ length: 11 }, (_, index) => 2015 + index)];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOGFOOD = join(ROOT, "tests/dogfood");
let parser;
async function getParser() {
  parser ??= import(pathToFileURL(setupAcorn().entryModulePath).href);
  return parser;
}

export async function sourceSyntaxEdition(source, sourceType = "script") {
  const { parse } = await getParser();
  for (const edition of SYNTAX_EDITIONS) {
    if (sourceType === "module" && edition < 2015) continue;
    try {
      parse(source, { ecmaVersion: edition, sourceType });
      return edition;
    } catch {
      // An unsupported syntax stays unknown, never silently becomes latest ES.
    }
  }
  return null;
}

export async function measurePackageSyntax(pkg) {
  const base = { edition: null, scope: "published-javascript", files: 0, parser: "acorn@8.16.0" };
  let temporary;
  try {
    const catalog = JSON.parse(readFileSync(join(DOGFOOD, "npm-compat-catalog.json"), "utf8"));
    let pin = catalog.find((entry) => entry.name === pkg.name && entry.version === pkg.version);
    if (!pin) pin = JSON.parse(readFileSync(join(DOGFOOD, `${pkg.name}-pin.json`), "utf8"));
    if (pin.version !== pkg.version) throw new Error("No matching package pin");
    const archive = resolve(DOGFOOD, pin.tarball);
    if (createHash("sha1").update(readFileSync(archive)).digest("hex") !== pin.shasum) {
      throw new Error("Pinned tarball checksum mismatch");
    }
    mkdirSync(join(ROOT, ".tmp"), { recursive: true });
    temporary = mkdtempSync(join(ROOT, ".tmp/npm-editions-"));
    execFileSync("tar", ["-xzf", archive, "-C", temporary], { stdio: "pipe" });
    let edition = 3;
    let unknown = null;
    const walk = async (directory, moduleType = false) => {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) moduleType = JSON.parse(readFileSync(manifest, "utf8")).type === "module";
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!/^(?:tests?|__tests__|fixtures?|__fixtures__|node_modules)$/i.test(entry.name))
            await walk(path, moduleType);
        } else if (
          entry.isFile() &&
          /\.(?:js|mjs|cjs)$/.test(entry.name) &&
          !/\.(?:test|spec)\.[cm]?js$/.test(entry.name)
        ) {
          base.files++;
          const source = readFileSync(path, "utf8");
          const isModule = entry.name.endsWith(".mjs") || (entry.name.endsWith(".js") && moduleType);
          let required = await sourceSyntaxEdition(source, isModule ? "module" : "script");
          if (required == null && !entry.name.endsWith(".cjs")) required = await sourceSyntaxEdition(source, "module");
          if (required == null) unknown ??= path.slice(temporary.length + 1);
          else edition = Math.max(edition, required);
        }
      }
    };
    await walk(join(temporary, "package"));
    if (unknown) return { ...base, reason: `Syntax could not be classified in ${unknown}` };
    if (!base.files) return { ...base, reason: "No published JavaScript files found" };
    return { ...base, edition, tarballShasum: pin.shasum };
  } catch (error) {
    return { ...base, reason: error.message };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
