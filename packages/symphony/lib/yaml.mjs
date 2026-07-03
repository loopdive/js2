// Minimal YAML subset parser — supports the front-matter shapes Symphony's
// workflow contract and markdown issue trackers actually use: nested maps,
// inline/block arrays, `|` block scalars, and scalar coercion (bool/number/
// null/quoted string). Not a general YAML implementation.

function countIndent(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") return "";
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArray(inner).map(parseScalar);
  }
  return value;
}

function splitInlineArray(s) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === '"' || ch === "'") && s[i - 1] !== "\\") {
      quote = quote === ch ? null : (quote ?? ch);
      cur += ch;
      continue;
    }
    if (ch === "," && !quote) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function skipBlank(lines, i) {
  while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
  return i;
}

function parseYamlBlock(lines, start, indent) {
  let i = skipBlank(lines, start);
  if (i >= lines.length || countIndent(lines[i]) < indent) return [{}, i];
  if (lines[i].slice(indent).startsWith("- ")) return parseYamlArray(lines, i, indent);
  return parseYamlObject(lines, i, indent);
}

function parseYamlObject(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = lines[i];
    const ind = countIndent(line);
    if (ind < indent) break;
    if (ind > indent) break;
    const trimmed = line.slice(indent);
    if (trimmed.startsWith("- ")) break;
    const m = trimmed.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!m) throw new Error(`workflow_parse_error: unsupported YAML line: ${line}`);
    const key = m[1].trim();
    const rest = (m[2] ?? "").trimEnd();
    if (rest === "|") {
      const block = [];
      i++;
      while (i < lines.length) {
        if (/^\s*$/.test(lines[i])) {
          block.push("");
          i++;
          continue;
        }
        const childIndent = countIndent(lines[i]);
        if (childIndent <= indent) break;
        block.push(lines[i].slice(Math.min(childIndent, indent + 2)));
        i++;
      }
      obj[key] = block.join("\n").replace(/\n+$/, "");
    } else if (rest === "") {
      const [value, next] = parseYamlBlock(lines, i + 1, indent + 2);
      obj[key] = value;
      i = next;
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return [obj, i];
}

function parseYamlArray(lines, start, indent) {
  const arr = [];
  let i = start;
  while (i < lines.length) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = lines[i];
    const ind = countIndent(line);
    if (ind < indent) break;
    if (ind !== indent || !line.slice(indent).startsWith("- ")) break;
    const rest = line.slice(indent + 2).trimEnd();
    if (rest === "") {
      const [value, next] = parseYamlBlock(lines, i + 1, indent + 2);
      arr.push(value);
      i = next;
      continue;
    }
    const kv = rest.match(/^([^:]+):(?:\s*(.*))?$/);
    if (kv) {
      const item = {};
      item[kv[1].trim()] = kv[2] === "" ? "" : parseScalar(kv[2] ?? "");
      const [tail, next] = parseYamlObject(lines, i + 1, indent + 2);
      arr.push({ ...item, ...tail });
      i = next;
      continue;
    }
    arr.push(parseScalar(rest));
    i++;
  }
  return [arr, i];
}

export function parseYaml(yaml) {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const [value] = parseYamlBlock(lines, 0, 0);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("workflow_front_matter_not_a_map");
  }
  return value;
}

export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: text };
  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
}

export function updateFrontmatterScalar(text, fields) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("missing_frontmatter");
  const frontmatter = match[1].split("\n");
  const remaining = new Map(Object.entries(fields).map(([key, value]) => [key, String(value)]));
  const lines = frontmatter.map((line) => {
    const idx = line.indexOf(":");
    if (idx < 0) return line;
    const key = line.slice(0, idx).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}: ${value}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}
