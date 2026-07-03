import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { get, expandPath, shellQuote, sanitizeKey } from "./util.mjs";
import { MarkdownTracker, renderTemplate, issueForWorkspacePrompt, buildAgentLanes } from "./workflow.mjs";
import {
  loadDispatchClaims,
  saveDispatchClaims,
  activeDispatchClaim,
  releaseDispatchClaim,
  appendDispatchMessage,
} from "./dispatch-state.mjs";

export class WorkspaceManager {
  constructor(config, logger, options, root) {
    this.config = config;
    this.logger = logger;
    this.options = options;
    this.root = root;
    this.rootDir = expandPath(get(config, "workspace.root", path.join(os.tmpdir(), "symphony_workspaces")), root);
    this.kind = get(config, "workspace.kind", "git_worktree");
    this.baseRef = get(config, "workspace.base_ref", "origin/main");
    this.branchPrefix = get(config, "workspace.branch_prefix", "symphony");
    this.fetchBeforeCreate = Boolean(get(config, "workspace.fetch_before_create", true)) && !options.noFetch;
  }

  ensure(issue) {
    const key = sanitizeKey(issue.identifier);
    const workspacePath = path.join(this.rootDir, key);
    const rootAbs = path.resolve(this.rootDir);
    const workspaceAbs = path.resolve(workspacePath);
    if (!workspaceAbs.startsWith(`${rootAbs}${path.sep}`) && workspaceAbs !== rootAbs) {
      throw new Error(`workspace_outside_root: ${workspaceAbs}`);
    }
    const branch = `${this.branchPrefix}/${key}`;
    const createdNow = !existsSync(workspaceAbs);
    if (createdNow) {
      mkdirSync(rootAbs, { recursive: true });
      if (this.kind === "git_worktree") this.createGitWorktree(workspaceAbs, branch);
      else mkdirSync(workspaceAbs, { recursive: true });
      this.runHook("after_create", workspaceAbs, issue);
    }
    return { path: workspaceAbs, workspace_key: key, created_now: createdNow, branch };
  }

  createGitWorktree(workspacePath, branch) {
    if (this.fetchBeforeCreate) this.git(["fetch", "origin"], this.root);
    const branchExists = this.gitOptional(["show-ref", "--verify", `refs/heads/${branch}`], this.root);
    if (branchExists) this.git(["worktree", "add", workspacePath, branch], this.root);
    else this.git(["worktree", "add", workspacePath, "-b", branch, this.baseRef], this.root);
  }

  remove(issue) {
    const key = sanitizeKey(issue.identifier);
    const workspacePath = path.join(this.rootDir, key);
    if (!existsSync(workspacePath)) return;
    this.runHook("before_remove", workspacePath, issue, { ignoreFailure: true });
    if (this.kind === "git_worktree") {
      this.git(["worktree", "remove", workspacePath], this.root, { ignoreFailure: true });
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

export class Logger {
  constructor(config, root) {
    this.root = expandPath(get(config, "logging.root", ".codex/symphony"), root);
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

export function writeControlCommand(workflow, options, root) {
  const loggerRoot = expandPath(get(workflow.config, "logging.root", ".codex/symphony"), root);
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

export class AgentRunner {
  run({ root, issue, workspace, lane, prompt, attempt, onEvent, onDone }) {
    const cwd = workspace.path;
    if (path.resolve(cwd) === path.resolve(root))
      throw new Error("invalid_workspace_cwd: refusing to run agent in repo root");
    const title = `${issue.identifier}: ${issue.title}`;
    const command = lane.promptMode === "stdin" ? lane.command : `${lane.command} ${shellQuote(prompt)}`;
    const logFile = path.join(path.dirname(workspace.path), `${workspace.workspace_key}.log`);
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

export class Orchestrator {
  constructor(workflow, options, root) {
    this.workflow = workflow;
    this.config = workflow.config;
    this.options = options;
    this.root = root;
    if (options.sprint) this.config.tracker = { ...(this.config.tracker || {}), sprint: options.sprint };
    if (Number.isFinite(options.max))
      this.config.agent = { ...(this.config.agent || {}), max_concurrent_agents: options.max };
    this.logger = new Logger(this.config, root);
    this.tracker = new MarkdownTracker(this.config, options, root);
    this.workspaceManager = new WorkspaceManager(this.config, this.logger, options, root);
    this.runner = new AgentRunner();
    this.lanes = buildAgentLanes(this.config);
    this.running = new Map();
    this.claimed = new Set();
    this.retryAttempts = new Map();
    this.completed = new Set();
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
    this.reconcileRunning();
    this.validate();
    if (this.stopping && this.running.size === 0) {
      this.shouldExit = true;
      this.writeState();
      return;
    }
    if (this.paused || this.draining || this.stopping) {
      this.writeState();
      return;
    }
    const candidates = this.tracker.fetchCandidateIssues((id) => activeDispatchClaim(this.root, id));
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
        file: path.relative(this.root, issue.file),
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
          file: path.relative(this.root, claim.file),
        });
      }
      if (lane.kind === "claude-channel") {
        this.dispatchClaudeChannel(issue, lane, attempt);
        return;
      }
      workspace = this.workspaceManager.ensure(issue);
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
      const promptIssue = issueForWorkspacePrompt(issue, workspace, this.root);
      const prompt = renderTemplate(this.workflow.promptTemplate, {
        issue: promptIssue,
        workspace,
        agent: lane,
        attempt: attempt ?? "",
      });
      const run = this.runner.run({
        root: this.root,
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
    const claims = loadDispatchClaims(this.root);
    claims[String(issue.id)] = {
      issue: String(issue.id),
      owner: lane.recipient || "claude-lead",
      lane: lane.name,
      status: "claimed",
      claimed_at: now,
      reason: "symphony claude-channel dispatch",
    };
    saveDispatchClaims(this.root, claims);
    const workspace = { path: "native Claude Code Team worktrees", branch: "native Claude Code Team branches" };
    const body = renderTemplate(this.workflow.promptTemplate, {
      issue,
      workspace,
      agent: lane,
      attempt: attempt ?? "",
    });
    appendDispatchMessage(this.root, {
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
      this.completed.add(id);
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
    const claims = loadDispatchClaims(this.root);
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
            releaseDispatchClaim(this.root, id, "channel dispatch stalled");
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
        if (entry.lane.kind === "claude-channel") {
          this.running.delete(id);
          this.claimed.delete(id);
          releaseDispatchClaim(this.root, id, `issue entered terminal state ${issue.state}`);
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
          releaseDispatchClaim(this.root, id, `issue became ineligible: ${issue.state}`);
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
      workflow: path.relative(this.root, this.workflow.file),
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
