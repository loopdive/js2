import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseYaml, parseFrontmatter, updateFrontmatterScalar } from "./yaml.mjs";
import { get, asArray, normalizeState, expandPath, resolveEnvValue, todayIsoDate } from "./util.mjs";

export const TERMINAL_DEFAULT = ["done", "wont-fix", "closed", "cancelled", "canceled", "duplicate"];
export const ACTIVE_DEFAULT = ["ready"];
const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;

export function loadWorkflow(file) {
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

export function loadMarkdownIssues(config, root) {
  const issuesDir = expandPath(get(config, "tracker.issues_dir", "plan/issues"), root);
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
    const issue = {
      id,
      identifier: id,
      title: extractTitle(parsed.body, fm),
      description: parsed.body.trim() || null,
      priority: priorityRank(fm.priority),
      priority_raw: fm.priority ?? null,
      state,
      branch_name: null,
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

export function latestSprint(issues, terminalStates) {
  const nums = issues
    .filter((issue) => /^\d+$/.test(String(issue.sprint)))
    .filter((issue) => !terminalStates.has(issue.state))
    .map((issue) => Number(issue.sprint));
  if (nums.length === 0) return "";
  return String(Math.max(...nums));
}

export function compareIssues(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ac = Date.parse(a.created_at || "") || 0;
  const bc = Date.parse(b.created_at || "") || 0;
  if (ac !== bc) return ac - bc;
  return String(a.identifier).localeCompare(String(b.identifier), undefined, { numeric: true });
}

export class MarkdownTracker {
  constructor(config, options = {}, root) {
    this.config = config;
    this.root = root;
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
    const issues = loadMarkdownIssues(this.config, this.root);
    const sprint = get(this.config, "tracker.sprint", "latest");
    const selectedSprint = sprint === "latest" ? latestSprint(issues, this.terminalStates) : String(sprint);
    return issues.map((issue) => ({ ...issue, selected_sprint: selectedSprint }));
  }

  fetchCandidateIssues(isActiveDispatchClaim) {
    const issues = this.allIssues();
    const sprint = issues[0]?.selected_sprint ?? "latest";
    const candidateStates = this.resumeInProgress
      ? new Set([...this.claimableStates, ...this.activeStates])
      : this.claimableStates;
    return issues
      .filter((issue) => String(issue.sprint) === String(sprint))
      .filter((issue) => candidateStates.has(issue.state))
      .filter((issue) => !isActiveDispatchClaim?.(issue.id))
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
    const relativeIssuePath = path.relative(this.root, issue.file);
    if (relativeIssuePath.startsWith("..") || path.isAbsolute(relativeIssuePath)) return null;
    const workspaceIssueFile = path.join(workspace.path, relativeIssuePath);
    if (!existsSync(workspaceIssueFile)) return null;
    const claimState = normalizeState(get(this.config, "tracker.claim_state", "in-progress"));
    return this.updateIssueStatusFile(issue, workspaceIssueFile, claimState, {
      claimed_by: lane.name,
      claimed_at: new Date().toISOString(),
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

export function renderTemplate(template, context) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, expr) => {
    const value = get(context, expr, undefined);
    if (value === undefined) throw new Error(`template_render_error: unknown variable ${expr}`);
    return value == null ? "" : String(value);
  });
}

export function issueForWorkspacePrompt(issue, workspace, root) {
  const renderedIssue = { ...issue };
  if (issue.file) {
    const rel = path.relative(root, issue.file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      renderedIssue.file = path.join(workspace.path, rel);
    }
  }
  return renderedIssue;
}

export function buildAgentLanes(config) {
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
