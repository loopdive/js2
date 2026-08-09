#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planPullRequestAction,
  readPullRequest,
  readPullRequestForBranch,
  scopePullRequestIssues,
  scopeSprintIssues,
} from "./symphony-pr-state.mjs";

const ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const DEFAULT_WORKFLOW = path.join(ROOT, "WORKFLOW.md");
const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;
const TERMINAL_DEFAULT = ["done", "wont-fix", "closed", "cancelled", "canceled", "duplicate"];
const ACTIVE_DEFAULT = ["ready"];
const DISPATCH_STATE_DIR = path.join(ROOT, ".codex", "dispatch");
const DISPATCH_MESSAGES_FILE = path.join(DISPATCH_STATE_DIR, "messages.jsonl");
const DISPATCH_CLAIMS_FILE = path.join(DISPATCH_STATE_DIR, "claims.json");

function parseArgs(argv) {
  const args = {
    workflow: DEFAULT_WORKFLOW,
    once: false,
    dryRun: false,
    resumeInProgress: false,
    sprint: null,
    max: null,
    status: false,
    json: false,
    noFetch: false,
    control: null,
    command: null,
    issue: null,
    value: null,
    reason: "",
    owner: "",
    from: "",
    to: "",
    body: "",
    limit: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--workflow") args.workflow = path.resolve(argv[++i]);
    else if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--resume-in-progress" || a === "--resume-claimed") args.resumeInProgress = true;
    else if (a === "--sprint") args.sprint = argv[++i];
    else if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--status") args.status = true;
    else if (a === "--json") args.json = true;
    else if (a === "--no-fetch") args.noFetch = true;
    else if (a === "--control") {
      let j = i + 1;
      while (argv[j] === "--") j++;
      args.control = argv[j];
      args.command = argv[j];
      i = j;
    } else if (a === "--issue") args.issue = argv[++i];
    else if (a === "--value") args.value = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--owner") args.owner = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--body") args.body = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (!a.startsWith("-") && !args.command) {
      args.command = a;
      args.control = a;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/symphony.mjs [options]

Options:
  --workflow PATH   Workflow contract path (default: WORKFLOW.md)
  --once            Run one poll/dispatch cycle and wait for launched workers
  --dry-run         Show dispatch plan without creating worktrees or agents
  --resume-in-progress
                  Treat stale in-progress sprint issues as dispatch candidates
  --sprint N        Override tracker.sprint
  --max N           Override agent.max_concurrent_agents
  --status          Print latest runtime state snapshot
  queue             Print claimable sprint tasks without launching agents
  claim             Claim one issue for a lead/teammate channel
  complete          Mark a broker claim completed
  release           Release a broker claim
  message           Append a channel message
  inbox             Read channel messages for an agent/lead
  --control ACTION  Queue daemon action: pause, resume, drain, stop, set-max, cancel, release
  --issue ID        Target issue for claim/complete/release/cancel
  --owner NAME      Owner for claim (for example claude-lead, codex-lead, alice)
  --from NAME       Message sender
  --to NAME         Message recipient
  --body TEXT       Message body
  --value VALUE     Value for set-max
  --reason TEXT     Optional operator reason for control log
  --json            Emit machine-readable status/dry-run output
  --no-fetch        Skip git fetch before creating a worktree
`);
}

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

function parseYamlBlock(lines, start, indent) {
  let i = skipBlank(lines, start);
  if (i >= lines.length || countIndent(lines[i]) < indent) return [{}, i];
  if (lines[i].slice(indent).startsWith("- ")) return parseYamlArray(lines, i, indent);
  return parseYamlObject(lines, i, indent);
}

function skipBlank(lines, i) {
  while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
  return i;
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

function parseYaml(yaml) {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const [value] = parseYamlBlock(lines, 0, 0);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("workflow_front_matter_not_a_map");
  }
  return value;
}

function loadWorkflow(file) {
  if (!existsSync(file)) throw new Error(`missing_workflow_file: ${file}`);
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---\n")) {
    return { file, config: {}, promptTemplate: text.trim() };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new Error("workflow_parse_error: missing closing front matter marker");
  const yaml = text.slice(4, end);
  const body = text
    .slice(end + 4)
    .replace(/^\n/, "")
    .trim();
  return { file, config: parseYaml(yaml), promptTemplate: body };
}

function get(obj, key, fallback = undefined) {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur;
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === "") return fallback;
  return [String(value)];
}

function normalizeState(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function resolveEnvValue(value, fallback = "") {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return process.env[value.slice(1)] ?? fallback;
  }
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? "");
}

function expandPath(value, base = ROOT) {
  let v = String(resolveEnvValue(value, "") || "");
  if (!v) return "";
  if (v.startsWith("~/")) v = path.join(os.homedir(), v.slice(2));
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(base, v);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sanitizeKey(s) {
  return String(s || "issue")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function continuationBranchName(issue, branchPrefix, mergeKey) {
  const prefix = String(branchPrefix || "symphony").replace(/\/+$/, "") || "symphony";
  const issueKey = sanitizeKey(issue.identifier || issue.id || "issue") || "issue";
  const mergeSegment = sanitizeKey(mergeKey || "merged") || "merged";
  return `${prefix}/${issueKey}-after-pr-${mergeSegment}`;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: text };
  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
}

function updateFrontmatterScalar(text, fields) {
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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function readScalarField(fm, key, fallback = "") {
  const value = fm[key];
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return fallback;
  return String(value);
}

function readArrayField(fm, key) {
  const value = fm[key];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function readPullRequestNumber(fm) {
  const raw = readScalarField(fm, "pr", "");
  const match = raw.match(/\/pull\/(\d+)/i) || raw.match(/#(\d+)/) || raw.match(/^\s*(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function walkIssueFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) continue;
    if (!ISSUE_FILE_RE.test(name)) continue;
    out.push(file);
  }
  return out;
}

function basenameIssueId(file) {
  return path.basename(file).match(/^(\d+[a-z]?)/i)?.[1] ?? path.basename(file, ".md");
}

function extractTitle(body, fm) {
  if (fm.title) return String(fm.title);
  const h = body.match(/^#\s+(.+)$/m);
  return h ? h[1].trim() : "Untitled";
}

function priorityRank(priority) {
  if (priority == null || priority === "") return 999;
  if (typeof priority === "number") return priority;
  const p = String(priority).toLowerCase();
  if (/^\d+$/.test(p)) return Number(p);
  return { critical: 1, high: 2, medium: 3, low: 4 }[p] ?? 999;
}

function loadMarkdownIssues(config) {
  const issuesDir = expandPath(get(config, "tracker.issues_dir", "plan/issues"));
  const terminal = new Set(asArray(get(config, "tracker.terminal_states"), TERMINAL_DEFAULT).map(normalizeState));
  const byId = new Map();
  for (const file of walkIssueFiles(issuesDir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseFrontmatter(text);
    } catch {
      continue;
    }
    const fm = parsed.data;
    const id = readScalarField(fm, "id", basenameIssueId(file));
    const state = normalizeState(readScalarField(fm, "status", "ready"));
    const sprint = readScalarField(fm, "sprint", "");
    const pullRequest = readPullRequestNumber(fm);
    const issue = {
      id,
      identifier: id,
      title: extractTitle(parsed.body, fm),
      description: parsed.body.trim() || null,
      priority: priorityRank(fm.priority),
      priority_raw: fm.priority ?? null,
      state,
      branch_name: readScalarField(fm, "branch", null),
      pull_request: pullRequest,
      pr: pullRequest,
      last_ci_retry_head: readScalarField(fm, "last_ci_retry_head", null),
      last_merged_pr: readScalarField(fm, "last_merged_pr", null),
      url: null,
      labels: [fm.area, fm.task_type, fm.language_feature, fm.goal].filter(Boolean).map((v) => String(v).toLowerCase()),
      blocked_by: readArrayField(fm, "depends_on").map((dep) => ({ id: dep, identifier: dep, state: null })),
      created_at: readScalarField(fm, "created", null),
      updated_at: readScalarField(fm, "updated", null),
      sprint,
      file,
      terminal: terminal.has(state),
    };
    byId.set(String(id), issue);
  }
  return [...byId.values()];
}

class MarkdownTracker {
  constructor(config, options = {}) {
    this.config = config;
    this.resumeInProgress = Boolean(options.resumeInProgress);
    this.activeStates = new Set(asArray(get(config, "tracker.active_states"), ACTIVE_DEFAULT).map(normalizeState));
    this.claimableStates = new Set(
      asArray(get(config, "tracker.claimable_states"), ACTIVE_DEFAULT).map(normalizeState),
    );
    this.terminalStates = new Set(
      asArray(get(config, "tracker.terminal_states"), TERMINAL_DEFAULT).map(normalizeState),
    );
  }

  allIssues() {
    const issues = loadMarkdownIssues(this.config);
    const sprint = get(this.config, "tracker.sprint", "latest");
    const selectedSprint = sprint === "latest" ? latestSprint(issues, this.terminalStates) : String(sprint);
    return issues.map((issue) => ({ ...issue, selected_sprint: selectedSprint }));
  }

  fetchCandidateIssues() {
    const issues = this.allIssues();
    const candidateStates = this.resumeInProgress
      ? new Set([...this.claimableStates, ...this.activeStates])
      : this.claimableStates;
    const scopedIssues = scopeSprintIssues(issues, {
      includeDependencies: Boolean(get(this.config, "tracker.include_dependencies", false)),
    });
    return scopedIssues
      .filter((issue) => candidateStates.has(issue.state))
      .filter((issue) => !activeDispatchClaim(issue.id))
      .filter((issue) => !this.isBlocked(issue, issues))
      .sort(compareIssues);
  }

  fetchIssueStatesByIds(ids) {
    const byId = new Map(this.allIssues().map((issue) => [String(issue.id), issue]));
    return ids.map((id) => byId.get(String(id))).filter(Boolean);
  }

  fetchIssuesByStates(states) {
    const wanted = new Set(states.map(normalizeState));
    return this.allIssues().filter((issue) => wanted.has(issue.state));
  }

  claimIssue(issue, lane) {
    const claimState = normalizeState(get(this.config, "tracker.claim_state", "in-progress"));
    return this.updateIssueStatusFile(issue, issue.file, claimState, {
      claimed_by: lane.name,
      claimed_at: new Date().toISOString(),
    });
  }

  claimIssueInWorkspace(issue, workspace, lane) {
    if (!issue.file || !workspace?.path) return null;
    const relativeIssuePath = path.relative(ROOT, issue.file);
    if (relativeIssuePath.startsWith("..") || path.isAbsolute(relativeIssuePath)) return null;
    const workspaceIssueFile = path.join(workspace.path, relativeIssuePath);
    if (!existsSync(workspaceIssueFile)) return null;
    const claimState = normalizeState(get(this.config, "tracker.claim_state", "in-progress"));
    return this.updateIssueStatusFile(issue, workspaceIssueFile, claimState, {
      claimed_by: lane.name,
      claimed_at: new Date().toISOString(),
      ...(issue.branch_name ? { branch: issue.branch_name } : {}),
      ...(issue.pull_request || issue.last_merged_pr
        ? {
            pr: issue.pull_request ?? null,
            ...(issue.last_merged_pr ? { last_merged_pr: issue.last_merged_pr } : {}),
          }
        : {}),
      ...(issue.last_ci_retry_head ? { last_ci_retry_head: issue.last_ci_retry_head } : {}),
    });
  }

  updateIssueStatusFile(issue, file, state, extraFields = {}) {
    if (!file) return null;
    const current = normalizeState(issue.state);
    const next = normalizeState(state);
    const text = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(text);
    const fileState = normalizeState(readScalarField(parsed.data, "status", current));
    const pendingFields = { status: next, ...extraFields };
    const changed = Object.entries(pendingFields).some(
      ([key, value]) => String(readScalarField(parsed.data, key, "")) !== String(value),
    );
    if (!changed && fileState === next) {
      issue.state = next;
      return { file, state: next, changed: false };
    }
    const updated = todayIsoDate();
    writeFileSync(
      file,
      updateFrontmatterScalar(text, {
        ...pendingFields,
        updated,
      }),
    );
    issue.state = next;
    issue.updated_at = updated;
    return { file, state: next, changed: true };
  }

  isBlocked(issue, issues) {
    if (!issue.blocked_by.length) return false;
    const byId = new Map(issues.map((i) => [String(i.id), i]));
    for (const blocker of issue.blocked_by) {
      const dep = byId.get(String(blocker.id ?? blocker.identifier));
      if (dep && !this.terminalStates.has(dep.state)) return true;
    }
    return false;
  }
}

function latestSprint(issues, terminalStates) {
  const nums = issues
    .filter((issue) => /^\d+$/.test(String(issue.sprint)))
    .filter((issue) => !terminalStates.has(issue.state))
    .map((issue) => Number(issue.sprint));
  if (nums.length === 0) return "";
  return String(Math.max(...nums));
}

function compareIssues(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ac = Date.parse(a.created_at || "") || 0;
  const bc = Date.parse(b.created_at || "") || 0;
  if (ac !== bc) return ac - bc;
  return String(a.identifier).localeCompare(String(b.identifier), undefined, { numeric: true });
}

function loadDispatchClaims() {
  try {
    return JSON.parse(readFileSync(DISPATCH_CLAIMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDispatchClaims(claims) {
  mkdirSync(DISPATCH_STATE_DIR, { recursive: true });
  writeFileSync(DISPATCH_CLAIMS_FILE, `${JSON.stringify(claims, null, 2)}\n`);
}

function activeDispatchClaim(issueId) {
  const claim = loadDispatchClaims()[String(issueId)];
  return claim && claim.status === "claimed" ? claim : null;
}

function appendDispatchMessage(message) {
  mkdirSync(DISPATCH_STATE_DIR, { recursive: true });
  appendFileSync(DISPATCH_MESSAGES_FILE, `${JSON.stringify(message)}\n`);
}

function releaseDispatchClaim(issueId, reason) {
  const claims = loadDispatchClaims();
  const key = String(issueId);
  claims[key] = {
    ...(claims[key] || { issue: key }),
    status: "released",
    reason,
    released_at: new Date().toISOString(),
  };
  saveDispatchClaims(claims);
}
class WorkspaceManager {
  constructor(config, logger, options) {
    this.config = config;
    this.logger = logger;
    this.options = options;
    this.root = expandPath(get(config, "workspace.root", path.join(os.tmpdir(), "symphony_workspaces")));
    this.kind = get(config, "workspace.kind", "git_worktree");
    this.baseRef = get(config, "workspace.base_ref", "origin/main");
    this.branchPrefix = get(config, "workspace.branch_prefix", "symphony");
    this.fetchBeforeCreate = Boolean(get(config, "workspace.fetch_before_create", true)) && !options.noFetch;
  }

  ensure(issue) {
    const key = sanitizeKey(issue.identifier);
    const workspacePath = path.join(this.root, key);
    const rootAbs = path.resolve(this.root);
    const workspaceAbs = path.resolve(workspacePath);
    if (!workspaceAbs.startsWith(`${rootAbs}${path.sep}`) && workspaceAbs !== rootAbs) {
      throw new Error(`workspace_outside_root: ${workspaceAbs}`);
    }
    const branch = issue.branch_name || `${this.branchPrefix}/${key}`;
    const createdNow = !existsSync(workspaceAbs);
    if (createdNow) {
      mkdirSync(rootAbs, { recursive: true });
      if (this.kind === "git_worktree") this.createGitWorktree(workspaceAbs, branch);
      else mkdirSync(workspaceAbs, { recursive: true });
      this.runHook("after_create", workspaceAbs, issue);
    } else if (this.kind === "git_worktree") {
      const actualBranch = this.git(["branch", "--show-current"], workspaceAbs);
      if (actualBranch !== branch) {
        this.switchGitWorktreeBranch(workspaceAbs, branch, actualBranch, issue);
      }
    }
    return { path: workspaceAbs, workspace_key: key, created_now: createdNow, branch };
  }

  createGitWorktree(workspacePath, branch) {
    if (this.fetchBeforeCreate) this.git(["fetch", "origin"], ROOT);
    const branchExists = this.gitOptional(["show-ref", "--verify", `refs/heads/${branch}`], ROOT);
    const remoteBranchExists = this.gitOptional(["show-ref", "--verify", `refs/remotes/origin/${branch}`], ROOT);
    if (branchExists) this.git(["worktree", "add", workspacePath, branch], ROOT);
    else if (remoteBranchExists) this.git(["worktree", "add", workspacePath, "-b", branch, `origin/${branch}`], ROOT);
    else this.git(["worktree", "add", workspacePath, "-b", branch, this.baseRef], ROOT);
  }

  switchGitWorktreeBranch(workspacePath, branch, previousBranch, issue) {
    const status = this.git(["status", "--porcelain"], workspacePath);
    if (status.trim()) {
      throw new Error(
        `workspace_branch_mismatch_dirty: expected ${branch}, found ${previousBranch || "detached"} with local changes`,
      );
    }
    if (this.fetchBeforeCreate) this.git(["fetch", "origin"], ROOT);
    const branchExists = this.gitOptional(["show-ref", "--verify", `refs/heads/${branch}`], ROOT);
    const remoteBranchExists = this.gitOptional(["show-ref", "--verify", `refs/remotes/origin/${branch}`], ROOT);
    if (branchExists) this.git(["switch", branch], workspacePath);
    else if (remoteBranchExists) this.git(["switch", "-c", branch, `origin/${branch}`], workspacePath);
    else this.git(["switch", "-c", branch, this.baseRef], workspacePath);
    const actualBranch = this.git(["branch", "--show-current"], workspacePath);
    if (actualBranch !== branch) {
      throw new Error(`workspace_branch_mismatch: expected ${branch}, found ${actualBranch || "detached"}`);
    }
    this.logger.event("workspace_branch_switched", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      from: previousBranch || null,
      branch,
    });
  }

  remove(issue) {
    const key = sanitizeKey(issue.identifier);
    const workspacePath = path.join(this.root, key);
    if (!existsSync(workspacePath)) return;
    this.runHook("before_remove", workspacePath, issue, { ignoreFailure: true });
    if (this.kind === "git_worktree") {
      this.git(["worktree", "remove", workspacePath], ROOT, { ignoreFailure: true });
    } else {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  }

  runHook(name, cwd, issue, options = {}) {
    const script = get(this.config, `hooks.${name}`, "");
    if (!script) return;
    const timeout = Number(get(this.config, "hooks.timeout_ms", 60000)) || 60000;
    const res = spawnSync("bash", ["-lc", script], {
      cwd,
      timeout,
      encoding: "utf8",
      env: { ...process.env, SYMPHONY_ISSUE_ID: issue.id, SYMPHONY_ISSUE_IDENTIFIER: issue.identifier },
    });
    if (res.status !== 0 && !options.ignoreFailure) {
      throw new Error(`hook_failed:${name}:${res.stderr || res.stdout || res.status}`);
    }
    if (res.status !== 0) {
      this.logger.event("hook_failed_ignored", { hook: name, issue_id: issue.id, error: res.stderr || res.stdout });
    }
  }

  git(args, cwd, options = {}) {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0 && !options.ignoreFailure) {
      throw new Error(`git_failed: git ${args.join(" ")}\n${res.stderr || res.stdout}`);
    }
    return res.stdout.trim();
  }

  gitOptional(args, cwd) {
    return spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;
  }
}

class Logger {
  constructor(config, dryRun) {
    this.root = expandPath(get(config, "logging.root", ".codex/symphony"));
    this.dryRun = dryRun;
    mkdirSync(this.root, { recursive: true });
    this.eventsFile = path.join(this.root, "events.jsonl");
    this.stateFile = path.join(this.root, "state.json");
    this.controlFile = path.join(this.root, "control.jsonl");
  }

  event(event, fields = {}) {
    const row = { event, timestamp: new Date().toISOString(), ...fields };
    appendFileSync(this.eventsFile, `${JSON.stringify(row)}\n`);
    if (!fields.quiet) {
      const label = fields.issue_identifier ? ` issue=${fields.issue_identifier}` : "";
      const detail = fields.reason
        ? ` reason=${fields.reason}`
        : fields.error
          ? ` error=${String(fields.error).slice(0, 160)}`
          : "";
      console.error(`[symphony] ${event}${label}${detail}`);
    }
  }

  writeState(state) {
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }
}

function writeControlCommand(workflow, options) {
  const loggerRoot = expandPath(get(workflow.config, "logging.root", ".codex/symphony"));
  mkdirSync(loggerRoot, { recursive: true });
  const controlFile = path.join(loggerRoot, "control.jsonl");
  const action = String(options.control || "").trim();
  if (!action) throw new Error("control_action_missing");
  const command = {
    id: String(Date.now()) + "-" + String(process.pid),
    action,
    issue: options.issue ? String(options.issue) : null,
    value: options.value ?? (Number.isFinite(options.max) ? options.max : null),
    reason: options.reason || "",
    created_at: new Date().toISOString(),
    operator: process.env.USER || process.env.USERNAME || "unknown",
  };
  appendFileSync(controlFile, JSON.stringify(command) + "\n");
  console.log(
    "queued symphony control: " +
      command.action +
      (command.issue ? " issue=" + command.issue : "") +
      (command.value != null ? " value=" + command.value : ""),
  );
}
function buildAgentLanes(config) {
  const configured = get(config, "agent.lanes", []);
  const lanes = Array.isArray(configured) ? configured : [];
  const fallbackCodex = get(config, "codex.command", "");
  return lanes
    .map((lane) => {
      const command = resolveEnvValue(lane.command, lane.kind === "codex" ? fallbackCodex : "");
      return {
        name: String(lane.name || lane.kind || "agent"),
        kind: String(lane.kind || "generic"),
        role: String(lane.role || "worker"),
        command: String(command || ""),
        promptMode: String(lane.prompt_mode || "argument"),
        recipient: String(lane.recipient || "claude-lead"),
        maxConcurrent: Number(lane.max_concurrent || get(config, "agent.max_concurrent_agents", 1)) || 1,
      };
    })
    .filter((lane) => lane.kind === "claude-channel" || lane.command.trim().length > 0);
}

function renderTemplate(template, context) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, expr) => {
    const value = get(context, expr, undefined);
    if (value === undefined) throw new Error(`template_render_error: unknown variable ${expr}`);
    return value == null ? "" : String(value);
  });
}

function issueForWorkspacePrompt(issue, workspace) {
  const renderedIssue = { ...issue };
  if (issue.file) {
    const rel = path.relative(ROOT, issue.file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      renderedIssue.file = path.join(workspace.path, rel);
    }
  }
  return renderedIssue;
}

class AgentRunner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  run({ issue, workspace, lane, prompt, attempt, onEvent, onDone }) {
    const cwd = workspace.path;
    if (path.resolve(process.cwd()) === ROOT) {
      // The service can run from root, but the agent subprocess must not.
    }
    if (path.resolve(cwd) === ROOT) throw new Error("invalid_workspace_cwd: refusing to run agent in repo root");
    const title = `${issue.identifier}: ${issue.title}`;
    const command = lane.promptMode === "stdin" ? lane.command : `${lane.command} ${shellQuote(prompt)}`;
    const logFile = path.join(path.dirname(workspace.path), `${workspace.workspace_key}.log`);
    this.logger.event("agent_launch", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      lane: lane.name,
      cwd,
      attempt,
    });
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
        SYMPHONY_ISSUE_FILE: issue.file,
        SYMPHONY_WORKSPACE: workspace.path,
        SYMPHONY_BRANCH: workspace.branch,
        SYMPHONY_AGENT_LANE: lane.name,
        SYMPHONY_ATTEMPT: String(attempt ?? ""),
      },
    });
    const session = {
      session_id: `${child.pid ?? "process"}-${Date.now()}`,
      thread_id: String(child.pid ?? ""),
      turn_id: String(Date.now()),
      codex_app_server_pid: child.pid ? String(child.pid) : null,
      last_codex_event: "process_started",
      last_codex_timestamp: new Date().toISOString(),
      last_codex_message: title,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: attempt ? attempt + 1 : 1,
    };
    if (lane.promptMode === "stdin") {
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on("data", (buf) => {
      appendFileSync(logFile, buf);
      this.ingestAgentOutput(buf, session, onEvent);
    });
    child.stderr.on("data", (buf) => {
      appendFileSync(logFile, buf);
      this.ingestAgentOutput(buf, session, onEvent);
    });
    child.on("error", (err) => {
      session.last_codex_event = "process_error";
      session.last_codex_timestamp = new Date().toISOString();
      onDone({ status: "failed", code: null, signal: null, session, logFile, error: err.message });
    });
    child.on("exit", (code, signal) => {
      const status = code === 0 ? "succeeded" : signal ? "cancelled" : "failed";
      session.last_codex_event = status;
      session.last_codex_timestamp = new Date().toISOString();
      onDone({ status, code, signal, session, logFile });
    });
    return { child, session, started_at: Date.now(), logFile };
  }

  ingestAgentOutput(buf, session, onEvent) {
    const text = String(buf);
    session.last_codex_timestamp = new Date().toISOString();
    session.last_codex_message = text.slice(-500);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        session.last_codex_event = obj.type || obj.event || session.last_codex_event;
        const usage = obj.usage || obj.total_token_usage || obj.token_usage;
        if (usage) {
          const input = Number(usage.input_tokens ?? usage.input ?? 0);
          const output = Number(usage.output_tokens ?? usage.output ?? 0);
          const total = Number(usage.total_tokens ?? usage.total ?? input + output);
          session.codex_input_tokens = Math.max(session.codex_input_tokens, input);
          session.codex_output_tokens = Math.max(session.codex_output_tokens, output);
          session.codex_total_tokens = Math.max(session.codex_total_tokens, total);
        }
        onEvent?.(obj, session);
      } catch {
        // Non-protocol JSON-like logs are diagnostics only.
      }
    }
  }
}

class Orchestrator {
  constructor(workflow, options) {
    this.workflow = workflow;
    this.config = workflow.config;
    this.options = options;
    if (options.sprint) this.config.tracker = { ...(this.config.tracker || {}), sprint: options.sprint };
    if (Number.isFinite(options.max))
      this.config.agent = { ...(this.config.agent || {}), max_concurrent_agents: options.max };
    this.logger = new Logger(this.config, options.dryRun);
    this.tracker = new MarkdownTracker(this.config, options);
    this.workspaceManager = new WorkspaceManager(this.config, this.logger, options);
    this.runner = new AgentRunner(this.config, this.logger);
    this.lanes = buildAgentLanes(this.config);
    this.running = new Map();
    this.claimed = new Set();
    this.retryAttempts = new Map();
    this.completed = new Set();
    this.pullRequestStates = new Map();
    this.handledFailedPrHeads = new Map();
    this.pullRequestRetryCounts = new Map();
    this.lastPullRequestPollAt = 0;
    this.codexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
    this.rateLimits = null;
    this.laneCursor = 0;
    this.startedAt = Date.now();
    this.paused = false;
    this.draining = false;
    this.stopping = false;
    this.shouldExit = false;
    this.suppressedRetries = new Set();
    this.controlFile = this.logger.controlFile;
    this.controlOffset = existsSync(this.controlFile) ? statSync(this.controlFile).size : 0;
  }

  processControls() {
    if (!existsSync(this.controlFile)) return;
    const size = statSync(this.controlFile).size;
    if (size <= this.controlOffset) return;
    const text = readFileSync(this.controlFile, "utf8").slice(this.controlOffset);
    this.controlOffset = size;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        this.applyControl(JSON.parse(line));
      } catch (err) {
        this.logger.event("control_ignored", { error: err.message });
      }
    }
  }

  applyControl(command) {
    const action = String(command.action || "")
      .trim()
      .toLowerCase();
    this.logger.event("control_received", {
      action,
      issue_id: command.issue || null,
      value: command.value ?? null,
      reason: command.reason || "",
    });
    if (action === "pause") {
      this.paused = true;
      return;
    }
    if (action === "resume") {
      if (this.stopping || this.shouldExit) {
        this.logger.event("control_ignored", { error: "resume ignored: daemon is stopping" });
        return;
      }
      this.paused = false;
      this.draining = false;
      this.stopping = false;
      return;
    }
    if (action === "drain") {
      this.draining = true;
      this.paused = false;
      return;
    }
    if (action === "stop") {
      this.stopping = true;
      this.draining = true;
      this.paused = false;
      for (const id of this.running.keys()) this.cancelRunning(id, "stop");
      return;
    }
    if (action === "set-max" || action === "set_max") {
      const next = Number(command.value);
      if (!Number.isFinite(next) || next < 0) throw new Error("invalid set-max value");
      this.config.agent = { ...(this.config.agent || {}), max_concurrent_agents: next };
      return;
    }
    if (action === "cancel") {
      if (!command.issue) throw new Error("cancel requires issue");
      this.cancelRunning(String(command.issue), command.reason || "operator cancel");
      return;
    }
    if (action === "release") {
      if (!command.issue) throw new Error("release requires issue");
      this.releaseIssue(String(command.issue), command.reason || "operator release");
      return;
    }
    throw new Error(`unknown control action: ${action}`);
  }

  cancelRunning(id, reason) {
    const key = String(id);
    const entry = this.running.get(key);
    this.suppressedRetries.add(key);
    if (!entry) {
      this.releaseIssue(key, reason);
      return;
    }
    entry.child.kill("SIGTERM");
    this.logger.event("run_cancelled_operator", {
      issue_id: key,
      issue_identifier: entry.issue.identifier,
      reason,
    });
  }

  releaseIssue(id, reason) {
    const key = String(id);
    const retry = this.retryAttempts.get(key);
    if (retry?.timer_handle) clearTimeout(retry.timer_handle);
    this.retryAttempts.delete(key);
    this.claimed.delete(key);
    this.suppressedRetries.add(key);
    this.logger.event("issue_released_operator", { issue_id: key, reason });
  }

  maxConcurrent() {
    return Number(get(this.config, "agent.max_concurrent_agents", 10)) || 10;
  }

  pollInterval() {
    return Number(get(this.config, "polling.interval_ms", 30000)) || 30000;
  }

  pullRequestPollInterval() {
    return Number(get(this.config, "pull_requests.poll_interval_ms", this.pollInterval())) || this.pollInterval();
  }

  discoverPullRequestForIssueBranch(issue) {
    if (!issue?.branch_name) return null;
    const repository = String(get(this.config, "pull_requests.repository", ""));
    const command = String(get(this.config, "pull_requests.command", "gh"));
    const timeoutMs = Number(get(this.config, "pull_requests.timeout_ms", 30000)) || 30000;
    try {
      return readPullRequestForBranch({
        branch: issue.branch_name,
        command,
        cwd: ROOT,
        repository,
        timeoutMs,
        excludeNumbers: [issue.last_merged_pr],
      });
    } catch (error) {
      this.logger.event("pull_request_poll_failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        pr: issue.pull_request,
        branch: issue.branch_name,
        error: error.message,
        quiet: true,
      });
      return null;
    }
  }

  validate() {
    const kind = get(this.config, "tracker.kind", "");
    if (kind !== "markdown") throw new Error(`unsupported_tracker_kind: ${kind || "(missing)"}`);
    if (!this.workflow.promptTemplate) throw new Error("template_parse_error: empty workflow prompt");
    if (this.lanes.length === 0 && !this.options.dryRun) {
      throw new Error(
        "missing_agent_command: configure agent.lanes[].command, SYMPHONY_CODEX_COMMAND, or a claude-channel lane",
      );
    }
  }

  async tick() {
    this.processControls();
    this.validate();
    this.reconcilePullRequests();
    this.reconcileRunning();
    if (this.stopping && this.running.size === 0) {
      this.shouldExit = true;
      this.writeState();
      return;
    }
    if (this.paused || this.draining || this.stopping) {
      this.writeState();
      return;
    }
    const candidates = this.tracker.fetchCandidateIssues();
    const planned = [];
    const slots = Math.max(this.maxConcurrent() - this.running.size, 0);
    for (const issue of candidates) {
      if (planned.length >= slots) break;
      if (this.claimed.has(String(issue.id))) continue;
      const lane = this.nextAvailableLane();
      if (!lane) break;
      planned.push({ issue, lane });
      if (!this.options.dryRun) this.dispatch(issue, lane);
    }
    if (this.options.dryRun) this.printDryRun(candidates, planned);
    this.writeState();
  }

  printDryRun(candidates, planned) {
    const payload = {
      sprint: candidates[0]?.selected_sprint ?? get(this.config, "tracker.sprint", "latest"),
      max_concurrent_agents: this.maxConcurrent(),
      mode: {
        paused: this.paused,
        draining: this.draining,
        stopping: this.stopping,
        should_exit: this.shouldExit,
        resume_in_progress: this.options.resumeInProgress,
      },
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        kind: lane.kind,
        role: lane.role,
        maxConcurrent: lane.maxConcurrent,
      })),
      candidates: candidates.map((issue) => ({
        id: issue.id,
        title: issue.title,
        state: issue.state,
        sprint: issue.sprint,
        priority: issue.priority_raw ?? issue.priority,
        file: path.relative(ROOT, issue.file),
      })),
      planned: planned.map(({ issue, lane }) => ({ issue: issue.id, lane: lane.name })),
    };
    if (this.options.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(
        `symphony dry-run: sprint ${payload.sprint}, ${payload.candidates.length} candidates, ${payload.planned.length} planned`,
      );
      for (const row of payload.planned) console.log(`  dispatch #${row.issue} -> ${row.lane}`);
      if (payload.lanes.length === 0)
        console.log("  no enabled lanes; set SYMPHONY_CODEX_COMMAND or SYMPHONY_CLAUDE_COMMAND");
    }
  }

  nextAvailableLane() {
    if (this.lanes.length === 0) return null;
    for (let n = 0; n < this.lanes.length; n++) {
      const idx = (this.laneCursor + n) % this.lanes.length;
      const lane = this.lanes[idx];
      const runningInLane = [...this.running.values()].filter((r) => r.lane.name === lane.name).length;
      if (runningInLane < lane.maxConcurrent) {
        this.laneCursor = (idx + 1) % this.lanes.length;
        return lane;
      }
    }
    return null;
  }

  dispatch(issue, lane, attempt = null) {
    const id = String(issue.id);
    this.claimed.add(id);
    let workspace = null;
    try {
      const claim = this.tracker.claimIssue(issue, lane);
      if (claim?.changed) {
        this.logger.event("issue_claimed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          lane: lane.name,
          state: claim.state,
          file: path.relative(ROOT, claim.file),
        });
      }
      if (lane.kind === "claude-channel") {
        this.dispatchClaudeChannel(issue, lane, attempt);
        return;
      }
      workspace = this.workspaceManager.ensure(issue);
      issue.branch_name = workspace.branch;
      this.tracker.updateIssueStatusFile(issue, issue.file, issue.state, { branch: workspace.branch });
      const workspaceClaim = this.tracker.claimIssueInWorkspace(issue, workspace, lane);
      if (workspaceClaim?.changed) {
        this.logger.event("workspace_issue_claimed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          lane: lane.name,
          state: workspaceClaim.state,
          file: path.relative(workspace.path, workspaceClaim.file),
        });
      }
      this.workspaceManager.runHook("before_run", workspace.path, issue);
      const promptIssue = issueForWorkspacePrompt(issue, workspace);
      const prompt = renderTemplate(this.workflow.promptTemplate, {
        issue: promptIssue,
        workspace,
        agent: lane,
        attempt: attempt ?? "",
      });
      const run = this.runner.run({
        issue,
        workspace,
        lane,
        prompt,
        attempt,
        onEvent: (event, session) => this.onAgentEvent(issue, event, session),
        onDone: (result) => this.onRunDone(issue, lane, workspace, result, attempt),
      });
      this.running.set(id, { issue, lane, workspace, ...run, attempt: attempt ?? 0 });
      this.writeState();
    } catch (err) {
      const message = err?.message || String(err);
      this.running.delete(id);
      if (workspace?.path) this.workspaceManager.runHook("after_run", workspace.path, issue, { ignoreFailure: true });
      this.logger.event("dispatch_failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        lane: lane.name,
        error: message,
      });
      const nextAttempt = (attempt ?? 0) + 1;
      const maxDelay = Number(get(this.config, "agent.max_retry_backoff_ms", 300000)) || 300000;
      const delay = Math.min(10000 * 2 ** Math.max(nextAttempt - 1, 0), maxDelay);
      this.scheduleRetry(issue, lane, "dispatch_failed", delay, nextAttempt);
      this.writeState();
    }
  }

  dispatchClaudeChannel(issue, lane, attempt = null) {
    const now = new Date().toISOString();
    const claims = loadDispatchClaims();
    claims[String(issue.id)] = {
      issue: String(issue.id),
      owner: lane.recipient || "claude-lead",
      lane: lane.name,
      status: "claimed",
      claimed_at: now,
      reason: "symphony claude-channel dispatch",
    };
    saveDispatchClaims(claims);
    const workspace = { path: "native Claude Code Team worktrees", branch: "native Claude Code Team branches" };
    const body = renderTemplate(this.workflow.promptTemplate, {
      issue,
      workspace,
      agent: lane,
      attempt: attempt ?? "",
    });
    appendDispatchMessage({
      id: `${Date.now()}-${process.pid}`,
      type: "symphony_issue_dispatch",
      from: "symphony",
      to: lane.recipient || "claude-lead",
      sprint: issue.sprint,
      issue: String(issue.id),
      lane: lane.name,
      body,
      created_at: now,
    });
    this.running.set(String(issue.id), {
      issue,
      lane,
      workspace,
      attempt: attempt ?? 0,
      started_at: Date.now(),
      child: { kill() {} },
      session: {
        session_id: `claude-channel-${issue.id}`,
        thread_id: "claude-channel",
        turn_id: String(Date.now()),
        last_codex_event: "channel_dispatched",
        last_codex_timestamp: now,
        last_codex_message: `dispatched #${issue.id} to ${lane.recipient || "claude-lead"}`,
        codex_input_tokens: 0,
        codex_output_tokens: 0,
        codex_total_tokens: 0,
        turn_count: 1,
      },
    });
    this.logger.event("channel_dispatch", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      lane: lane.name,
      recipient: lane.recipient || "claude-lead",
    });
    this.writeState();
  }
  onAgentEvent(issue, event, session) {
    if (event.rate_limits || event.rateLimits) this.rateLimits = event.rate_limits || event.rateLimits;
    const running = this.running.get(String(issue.id));
    if (!running) {
      this.logger.event("agent_event_untracked", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        event: event.type || event.event || "unknown",
        quiet: true,
      });
      return;
    }
    running.session = session;
    this.writeState();
  }

  onRunDone(issue, lane, workspace, result, attempt) {
    const id = String(issue.id);
    const running = this.running.get(id);
    if (running) {
      const elapsed = Math.max((Date.now() - running.started_at) / 1000, 0);
      this.codexTotals.seconds_running += elapsed;
      this.codexTotals.input_tokens += result.session.codex_input_tokens;
      this.codexTotals.output_tokens += result.session.codex_output_tokens;
      this.codexTotals.total_tokens += result.session.codex_total_tokens;
    }
    this.running.delete(id);
    this.claimed.delete(id);
    const retrySuppressed = this.stopping || this.draining || this.suppressedRetries.has(id);
    this.suppressedRetries.delete(id);
    this.workspaceManager.runHook("after_run", workspace.path, issue, { ignoreFailure: true });
    this.logger.event("agent_exit", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      lane: lane.name,
      status: result.status,
      code: result.code,
      signal: result.signal,
    });
    if (retrySuppressed) {
      this.logger.event("retry_suppressed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        reason: this.stopping ? "stopping" : this.draining ? "draining" : "operator control",
      });
    } else if (result.status === "succeeded") {
      const current = this.tracker.fetchIssueStatesByIds([id])[0];
      if (current?.pull_request && ["in-progress", "in-review"].includes(current.state)) {
        this.logger.event("agent_awaiting_pull_request", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          pr: current.pull_request,
        });
      } else if (current?.state === "in-progress" && !current.pull_request) {
        const discovered = this.discoverPullRequestForIssueBranch(current);
        if (discovered?.number) {
          current.pull_request = discovered.number;
          current.pr = discovered.number;
          if (discovered.headBranch) current.branch_name = discovered.headBranch;
          this.tracker.updateIssueStatusFile(current, current.file, current.state, {
            pr: discovered.number,
            ...(current.branch_name ? { branch: current.branch_name } : {}),
          });
          this.logger.event("pull_request_discovered", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            pr: discovered.number,
            branch: current.branch_name || null,
          });
        } else {
          this.tracker.updateIssueStatusFile(current, current.file, "ready", {
            ...(current.branch_name ? { branch: current.branch_name } : {}),
            pr: null,
          });
          this.completed.delete(id);
          this.logger.event("agent_missing_pull_request_requeued", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            branch: current.branch_name || null,
          });
        }
      } else {
        this.completed.add(id);
      }
      const maxTurns = Number(get(this.config, "agent.max_turns", 1)) || 1;
      if ((attempt ?? 0) + 1 < maxTurns) this.scheduleRetry(issue, lane, "continuation", 1000, (attempt ?? 0) + 1);
    } else {
      const nextAttempt = (attempt ?? 0) + 1;
      const maxDelay = Number(get(this.config, "agent.max_retry_backoff_ms", 300000)) || 300000;
      const delay = Math.min(10000 * 2 ** Math.max(nextAttempt - 1, 0), maxDelay);
      this.scheduleRetry(issue, lane, result.status, delay, nextAttempt);
    }
    this.writeState();
  }

  scheduleRetry(issue, lane, error, delayMs, attempt) {
    const id = String(issue.id);
    if (this.stopping || this.draining || this.suppressedRetries.has(id)) {
      this.claimed.delete(id);
      this.logger.event("retry_suppressed", {
        issue_id: id,
        issue_identifier: issue.identifier,
        reason: this.stopping ? "stopping" : this.draining ? "draining" : "operator control",
      });
      return;
    }
    this.claimed.add(id);
    const dueAtMs = Date.now() + delayMs;
    const timer = setTimeout(() => {
      this.retryAttempts.delete(id);
      if (this.paused) {
        this.scheduleRetry(issue, lane, "paused", 30000, attempt);
        return;
      }
      const current = this.tracker.fetchIssueStatesByIds([id])[0];
      if (
        !current ||
        !this.tracker.activeStates.has(current.state) ||
        this.tracker.isBlocked(current, this.tracker.allIssues())
      ) {
        this.claimed.delete(id);
        this.logger.event("retry_released", {
          issue_id: id,
          issue_identifier: issue.identifier,
          reason: "issue no longer eligible",
        });
        this.writeState();
        return;
      }
      if (this.running.size >= this.maxConcurrent()) {
        this.scheduleRetry(current, lane, "no available orchestrator slots", 30000, attempt);
        return;
      }
      this.dispatch(current, lane, attempt);
    }, delayMs);
    this.retryAttempts.set(id, {
      issue_id: id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: timer,
      error,
    });
    this.logger.event("retry_queued", {
      issue_id: id,
      issue_identifier: issue.identifier,
      attempt,
      due_at_ms: dueAtMs,
      reason: error,
    });
  }

  reconcileChannelDispatches() {
    const claims = loadDispatchClaims();
    for (const [id, entry] of [...this.running]) {
      if (entry.lane.kind !== "claude-channel") continue;
      const claim = claims[String(id)];
      if (!claim) continue;
      if (claim.status === "completed") {
        this.running.delete(id);
        this.claimed.delete(id);
        this.completed.add(id);
        this.logger.event("channel_dispatch_completed", {
          issue_id: id,
          issue_identifier: entry.issue.identifier,
          lane: entry.lane.name,
        });
      } else if (claim.status === "released") {
        this.running.delete(id);
        this.claimed.delete(id);
        this.logger.event("channel_dispatch_released", {
          issue_id: id,
          issue_identifier: entry.issue.identifier,
          lane: entry.lane.name,
          reason: claim.reason || "released",
        });
      }
    }
  }

  reconcilePullRequests() {
    if (this.options.dryRun || get(this.config, "pull_requests.enabled", true) === false) return;
    const now = Date.now();
    if (now - this.lastPullRequestPollAt < this.pullRequestPollInterval()) return;
    this.lastPullRequestPollAt = now;

    const reviewStates = asArray(get(this.config, "pull_requests.review_states"), ["in-review", "in-progress"]);
    const repository = String(get(this.config, "pull_requests.repository", ""));
    const command = String(get(this.config, "pull_requests.command", "gh"));
    const timeoutMs = Number(get(this.config, "pull_requests.timeout_ms", 30000)) || 30000;
    const wantedReviewStates = new Set(reviewStates.map(normalizeState));
    const issues = scopePullRequestIssues(this.tracker.allIssues(), {
      sprintOnly: Boolean(get(this.config, "pull_requests.sprint_only", false)),
      includeDependencies: Boolean(get(this.config, "pull_requests.include_dependencies", false)),
    }).filter((issue) => wantedReviewStates.has(issue.state));

    for (const issue of issues) {
      if (!issue.pull_request && !issue.branch_name) continue;
      const id = String(issue.id);
      let state;
      try {
        state = issue.pull_request
          ? readPullRequest({
              command,
              cwd: ROOT,
              number: issue.pull_request,
              repository,
              timeoutMs,
            })
          : this.discoverPullRequestForIssueBranch(issue);
      } catch (error) {
        this.logger.event("pull_request_poll_failed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          pr: issue.pull_request,
          error: error.message,
          quiet: true,
        });
        continue;
      }
      if (!state) continue;

      this.pullRequestStates.set(id, state);
      if (state.headBranch) issue.branch_name = state.headBranch;
      if (!issue.pull_request && state.number) {
        issue.pull_request = state.number;
        issue.pr = state.number;
        this.tracker.updateIssueStatusFile(issue, issue.file, issue.state, {
          pr: state.number,
          ...(issue.branch_name ? { branch: issue.branch_name } : {}),
        });
        this.logger.event("pull_request_discovered", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          pr: state.number,
          branch: issue.branch_name,
        });
      }
      const planned = planPullRequestAction(state, {
        handledFailureKey: this.handledFailedPrHeads.get(id) || issue.last_ci_retry_head,
        issueState: issue.state,
        lastMergedPr: issue.last_merged_pr,
        busy: this.running.has(id) || this.claimed.has(id) || this.retryAttempts.has(id),
        paused: this.paused || this.draining || this.stopping,
        hasCapacity: this.running.size < this.maxConcurrent(),
      });

      if (planned.action === "mark_done") {
        const completed = state.mergedAt ? state.mergedAt.slice(0, 10) : todayIsoDate();
        const update = this.tracker.updateIssueStatusFile(issue, issue.file, "done", { completed });
        const retry = this.retryAttempts.get(id);
        if (retry?.timer_handle) clearTimeout(retry.timer_handle);
        this.retryAttempts.delete(id);
        this.claimed.delete(id);
        this.completed.add(id);
        this.handledFailedPrHeads.delete(id);
        if (activeDispatchClaim(id)) releaseDispatchClaim(id, `PR #${issue.pull_request} merged`);
        if (update?.changed) {
          this.logger.event("pull_request_merged_issue_done", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            pr: issue.pull_request,
            completed,
          });
        }
        continue;
      }

      if (planned.action === "continue") {
        const mergedBranch = issue.branch_name;
        const branchPrefix = String(get(this.config, "workspace.branch_prefix", "symphony")).replace(/\/+$/, "");
        const continuationBranch = continuationBranchName(issue, branchPrefix, planned.mergeKey);
        const running = this.running.get(id);
        const retry = this.retryAttempts.get(id);
        if (retry?.timer_handle) clearTimeout(retry.timer_handle);
        this.retryAttempts.delete(id);
        this.pullRequestRetryCounts.delete(id);
        this.handledFailedPrHeads.delete(id);
        if (running && running.lane.kind !== "claude-channel") {
          this.suppressedRetries.add(id);
          running.child.kill("SIGTERM");
        } else if (running && activeDispatchClaim(id)) {
          releaseDispatchClaim(id, `PR #${state.number} merged; continuing issue`);
        }
        issue.last_merged_pr = planned.mergeKey;
        issue.last_ci_retry_head = null;
        issue.pull_request = null;
        issue.pr = null;
        issue.branch_name = continuationBranch;
        this.tracker.updateIssueStatusFile(issue, issue.file, "ready", {
          pr: null,
          branch: continuationBranch,
          last_ci_retry_head: null,
          last_merged_pr: planned.mergeKey,
        });
        if (!running) this.claimed.delete(id);
        this.completed.delete(id);
        this.logger.event("pull_request_merged_issue_requeued", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          pr: state.number,
          branch: continuationBranch,
          merged_branch: mergedBranch,
        });
        continue;
      }

      if (planned.action === "defer") {
        this.logger.event("pull_request_failure_deferred", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          pr: issue.pull_request,
          head_sha: state.headSha,
          quiet: true,
        });
        continue;
      }
      if (planned.action !== "requeue") continue;

      const lane = this.nextAvailableLane();
      if (!lane) continue;
      issue.last_ci_retry_head = planned.failureKey;
      this.tracker.updateIssueStatusFile(issue, issue.file, "in-progress", {
        ...(issue.branch_name ? { branch: issue.branch_name } : {}),
        last_ci_retry_head: planned.failureKey,
      });
      this.handledFailedPrHeads.set(id, planned.failureKey);
      const attempt = (this.pullRequestRetryCounts.get(id) ?? 0) + 1;
      this.pullRequestRetryCounts.set(id, attempt);
      this.logger.event("pull_request_ci_failed_requeued", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        pr: issue.pull_request,
        head_sha: state.headSha,
        failed_checks: state.failedChecks.join(", "),
        lane: lane.name,
      });
      this.dispatch(issue, lane, attempt);
    }
  }

  reconcileRunning() {
    this.reconcileChannelDispatches();
    const stallMs = Number(get(this.config, "codex.stall_timeout_ms", 300000)) || 0;
    const now = Date.now();
    for (const [id, entry] of [...this.running]) {
      if (stallMs > 0) {
        const last = Date.parse(entry.session?.last_codex_timestamp || "") || entry.started_at;
        if (now - last > stallMs) {
          if (entry.lane.kind === "claude-channel") {
            this.running.delete(id);
            this.claimed.delete(id);
            releaseDispatchClaim(id, "channel dispatch stalled");
          } else {
            entry.child.kill("SIGTERM");
          }
          this.logger.event("run_stalled", { issue_id: id, issue_identifier: entry.issue.identifier });
        }
      }
    }
    const current = new Map(
      this.tracker.fetchIssueStatesByIds([...this.running.keys()]).map((issue) => [String(issue.id), issue]),
    );
    for (const [id, entry] of [...this.running]) {
      const issue = current.get(id);
      if (!issue) continue;
      if (this.tracker.terminalStates.has(issue.state)) {
        this.suppressedRetries.add(id);
        if (entry.lane.kind === "claude-channel") {
          this.running.delete(id);
          this.claimed.delete(id);
          releaseDispatchClaim(id, `issue entered terminal state ${issue.state}`);
        } else {
          entry.child.kill("SIGTERM");
        }
        this.logger.event("workspace_preserved_terminal", {
          issue_id: id,
          issue_identifier: issue.identifier,
          workspace: entry.workspace.path,
        });
        this.logger.event("run_cancelled_terminal", {
          issue_id: id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
      } else if (!this.tracker.activeStates.has(issue.state)) {
        if (entry.lane.kind === "claude-channel") {
          this.running.delete(id);
          this.claimed.delete(id);
          releaseDispatchClaim(id, `issue became ineligible: ${issue.state}`);
        } else {
          entry.child.kill("SIGTERM");
        }
        this.logger.event("run_cancelled_ineligible", {
          issue_id: id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
      } else {
        entry.issue = issue;
      }
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      workflow: path.relative(ROOT, this.workflow.file),
      poll_interval_ms: this.pollInterval(),
      max_concurrent_agents: this.maxConcurrent(),
      running: [...this.running.values()].map((r) => ({
        issue_id: r.issue.id,
        issue_identifier: r.issue.identifier,
        title: r.issue.title,
        lane: r.lane.name,
        workspace_path: r.workspace.path,
        branch: r.workspace.branch,
        started_at: new Date(r.started_at).toISOString(),
        seconds_running: Math.round((now - r.started_at) / 1000),
        turn_count: r.session?.turn_count ?? 0,
        last_event: r.session?.last_codex_event ?? null,
      })),
      retrying: [...this.retryAttempts.values()].map((r) => ({
        issue_id: r.issue_id,
        identifier: r.identifier,
        attempt: r.attempt,
        due_at_ms: r.due_at_ms,
        error: r.error,
      })),
      claimed: [...this.claimed],
      completed: [...this.completed],
      pull_requests: Object.fromEntries(this.pullRequestStates),
      codex_totals: {
        ...this.codexTotals,
        seconds_running:
          this.codexTotals.seconds_running +
          [...this.running.values()].reduce((sum, r) => sum + Math.max((now - r.started_at) / 1000, 0), 0),
      },
      rate_limits: this.rateLimits,
    };
  }

  writeState() {
    this.logger.writeState(this.snapshot());
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflow = loadWorkflow(options.workflow);
  const loggerRoot = expandPath(get(workflow.config, "logging.root", ".codex/symphony"));
  if (options.control) {
    writeControlCommand(workflow, options);
    return;
  }
  if (options.status) {
    const stateFile = path.join(loggerRoot, "state.json");
    if (!existsSync(stateFile)) {
      console.error("symphony: no state snapshot found");
      process.exit(1);
    }
    const text = readFileSync(stateFile, "utf8");
    if (options.json) process.stdout.write(text);
    else console.log(text);
    return;
  }
  const orchestrator = new Orchestrator(workflow, options);
  orchestrator.validate();
  if (options.once || options.dryRun) {
    await orchestrator.tick();
    if (!options.dryRun) await waitUntilIdle(orchestrator);
    return;
  }
  await orchestrator.tick();
  if (orchestrator.shouldExit) return;
  setInterval(() => {
    orchestrator
      .tick()
      .then(() => {
        if (orchestrator.shouldExit) process.exit(0);
      })
      .catch((err) => orchestrator.logger.event("tick_failed", { error: err.message }));
  }, orchestrator.pollInterval());
}

function waitUntilIdle(orchestrator) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      orchestrator.writeState();
      if (orchestrator.running.size === 0 && orchestrator.retryAttempts.size === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

main().catch((err) => {
  console.error(`symphony: ${err.message}`);
  process.exit(1);
});
