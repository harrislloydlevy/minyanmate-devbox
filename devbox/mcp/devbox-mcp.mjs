#!/usr/bin/env node
// devbox MCP server — exposes the workspace lifecycle and the ACP runner.
// Runs inside minyanmate-dev; OpenClaw reaches it over SSH stdio.
// stdout is JSON-RPC only. All logging goes to stderr.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";

const DEV_TASK = "/opt/devbox/bin/dev-task";
const TASKS = "/work/tasks";
const SERVER = { name: "devbox", version: "1.1.0" };
const DEFAULT_PROTOCOL = "2024-11-05";
const MAX_RUN_MS = 14 * 60 * 1000;
const FREE_PREFERENCE = [
  "opencode-go/iceman-contributor-free",
  "opencode/glm-5.3-flash-free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/beam-free",
];
const isFree = (v) => /free/i.test(v || "");

const tools = [
  {
    name: "task_new",
    description:
      "Create a git worktree and feature branch for one story, seed local state " +
      "(.env, data/dev.db, .opencode, AGENTS.md), write features/<id>-<slug>.md, " +
      "commit the spec, install dependencies and build the code graph. " +
      "Returns the absolute path of the worktree.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Story id, e.g. \"42\"." },
        slug: { type: "string", description: "Short kebab-case name, e.g. \"guest-view\"." },
        title: { type: "string", description: "Human title for logs and the spec header." },
        spec: { type: "string", description: "Full markdown for features/<id>-<slug>.md." },
        base: { type: "string", description: "Base ref (default origin/main)." },
        model: { type: "string", description: "Optional OpenCode model id. Omit to let OpenCode use its default; ACP reports the available ids from task_run." },
        graph: { type: "boolean", description: "Build graphify-out (default true)." },
        force: { type: "boolean", description: "Replace an existing spec / ignore a dirty worktree." },
      },
      required: ["id", "slug", "title", "spec"],
      additionalProperties: false,
    },
  },
  {
    name: "task_run",
    description:
      "Run an OpenCode ACP session inside an existing story worktree and return the " +
      "final assistant text. Blocking; up to 14 minutes. Use task_status afterwards " +
      "to confirm the branch state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Story id (worktree must exist)." },
        task: { type: "string", description: "The prompt / task for OpenCode." },
        model: { type: "string", description: "Optional model override, e.g. opencode-go/minimax-m3.1-flash-free." },
        timeout_seconds: { type: "number", description: "Wall clock limit (default 840, max 840)." },
      },
      required: ["id", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "task_done",
    description:
      "Remove a story worktree after its PR has merged. Refuses if the worktree has " +
      "uncommitted changes unless force is true. Keeps the branch.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Story id." },
        force: { type: "boolean", description: "Remove even with uncommitted changes." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description: "List all git worktrees attached to the devbox base repo.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "task_status",
    description:
      "Report one worktree: branch, head commit, dirty file count, spec path, graph presence.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Story id." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function runDevTask(args, stdinText) {
  return new Promise((resolve) => {
    const child = spawn(DEV_TASK, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      err += "\n[devbox] dev-task timed out after 15m";
    }, 15 * 60 * 1000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: err + "\n" + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
    if (stdinText !== undefined) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

// --- ACP client: drive `opencode acp` inside the worktree -------------------
function runAcp(cwd, promptText, opts = {}) {
  const timeoutMs = Math.min(Number(opts.timeoutSeconds || MAX_RUN_MS / 1000) * 1000, MAX_RUN_MS);
  return new Promise((resolve) => {
    const child = spawn("opencode", ["acp"], {
      cwd: "/home/node",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/node" },
    });

    let nextId = 1;
    const pending = new Map();
    let text = "";
    let sessionId = null;
    let stopReason = null;
    let usage = null;
    let activeModel = null;
    let availableModels = [];
    let error = null;
    let stderrTail = "";

    const sendMsg = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (e) {
        if (!error) error = "failed to write to ACP: " + e.message;
      }
    };

    const call = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        sendMsg({ jsonrpc: "2.0", id, method, params });
      });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "ACP error"));
        else res(msg.result);
        return;
      }
      if (msg.method === "session/update") {
        const u = msg.params?.update || {};
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          text += u.content.text;
        }
        return;
      }
      if (msg.method === "session/request_permission") {
        const options = msg.params?.options || [];
        const allow =
          options.find((o) => /allow/i.test(o.kind || "")) ||
          options.find((o) => /allow/i.test(o.name || "")) ||
          options[0];
        sendMsg({
          jsonrpc: "2.0",
          id: msg.id,
          result: allow
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
        return;
      }
      if (msg.method === "session/request_question" || msg.method === "elicitation/create") {
        if (!error) error = "agent requested input; not supported by task_run";
        sendMsg({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
    });

    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    const timer = setTimeout(() => {
      if (!error) error = `timeout after ${Math.round(timeoutMs / 1000)}s`;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      const ok = !error && stopReason === "end_turn";
      resolve({
        ok,
        session_id: sessionId,
        stop_reason: stopReason,
        model: activeModel,
        free: isFree(activeModel),
        models: availableModels,
        free_models: availableModels.filter(isFree),
        text: text.trim(),
        usage,
        error,
        stderr: error ? stderrTail : undefined,
      });
    };

    child.on("exit", finish);
    child.on("error", (e) => {
      if (!error) error = "failed to start opencode acp: " + e.message;
      finish();
    });

    (async () => {
      try {
        await call("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "devbox", version: "1.1.0" },
        });
        const s = await call("session/new", { cwd, mcpServers: [] });
        sessionId = s.sessionId;
        const modelOption = s.configOptions?.find((c) => c.id === "model");
        activeModel = modelOption?.currentValue || null;
        availableModels = (modelOption?.options || [])
          .map((o) => (typeof o === "string" ? o : o?.value))
          .filter(Boolean);

        // Free by default. Only switch when the session is on a paid model and
        // the caller did not request a specific one.
        let target = opts.model || null;
        if (!target && !isFree(activeModel)) {
          target =
            FREE_PREFERENCE.find((v) => availableModels.includes(v)) ||
            availableModels.find(isFree) ||
            null;
        }
        if (target && target !== activeModel) {
          try {
            await call("session/set_config_option", {
              sessionId,
              configId: "model",
              value: target,
            });
            activeModel = target;
          } catch (e) {
            console.error("[devbox] model switch failed:", e.message);
            if (!opts.model) {
              const fallback =
                FREE_PREFERENCE.find((v) => availableModels.includes(v)) ||
                availableModels.find(isFree);
              if (fallback && fallback !== activeModel) {
                try {
                  await call("session/set_config_option", {
                    sessionId,
                    configId: "model",
                    value: fallback,
                  });
                  activeModel = fallback;
                } catch (e2) {
                  console.error("[devbox] free fallback failed:", e2.message);
                }
              }
            }
          }
        }
        if (opts.model) {
          try {
            await call("session/set_config_option", {
              sessionId,
              configId: "model",
              value: opts.model,
            });
            activeModel = opts.model;
          } catch (e) {
            console.error("[devbox] model switch failed:", e.message);
          }
        }
        const r = await call("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        stopReason = r.stopReason;
        usage = r.usage || null;
      } catch (e) {
        if (!error) error = e.message;
      } finally {
        try {
          child.stdin.end();
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
        }, 1500);
      }
    })();
  });
}

async function callTool(name, args) {
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  switch (name) {
    case "task_new": {
      const argv = ["new", "--id", str(args.id), "--slug", str(args.slug), "--title", str(args.title)];
      if (args.base) argv.push("--base", str(args.base));
      if (args.model) argv.push("--model", str(args.model));
      if (args.graph === false) argv.push("--no-graph");
      if (args.force === true) argv.push("--force");
      return runDevTask(argv, str(args.spec));
    }
    case "task_run": {
      const id = str(args.id);
      const cwd = `${TASKS}/${id}`;
      if (!existsSync(cwd)) {
        return { code: 2, stdout: "", stderr: `no worktree at ${cwd}; call task_new first` };
      }
      let model = args.model ? str(args.model) : undefined;
      if (!model) {
        try {
          const cfg = JSON.parse(readFileSync(`${cwd}/opencode.json`, "utf8"));
          if (cfg.model) model = String(cfg.model);
        } catch {
          // no worktree config; fall back to the session default
        }
      }
      const result = await runAcp(cwd, str(args.task), {
        model,
        timeoutSeconds: args.timeout_seconds,
      });
      console.error(
        `[devbox] task_run ${id}: ${result.ok ? "ok" : "failed"} ` +
          `(${result.stop_reason || result.error})`
      );
      return { code: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2), stderr: "" };
    }
    case "task_done": {
      const argv = ["done", "--id", str(args.id)];
      if (args.force === true) argv.push("--force");
      return runDevTask(argv);
    }
    case "task_list":
      return runDevTask(["list"]);
    case "task_status":
      return runDevTask(["status", "--id", str(args.id)]);
    default:
      return { code: 2, stdout: "", stderr: `unknown tool: ${name}` };
  }
}

const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const msg = queue.shift();
    await handle(msg);
  }
  draining = false;
}

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const res = await callTool(name, args);
    const text = res.stdout.trim() || res.stderr.trim() || "(no output)";
    if (res.code === 0) {
      reply(id, { content: [{ type: "text", text }], isError: false });
    } else {
      reply(id, {
        content: [
          {
            type: "text",
            text: text + (res.stderr && res.stdout ? "\n--- stderr ---\n" + res.stderr.trim() : ""),
          },
        ],
        isError: true,
      });
      console.error(`[devbox] ${name} failed (exit ${res.code})`);
    }
    return;
  }
  if (id !== undefined && id !== null) replyError(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    console.error("[devbox] invalid JSON on stdin");
    return;
  }
  queue.push(msg);
  drain();
});
rl.on("close", () => {
  const finish = () => (queue.length || draining ? setTimeout(finish, 100) : process.exit(0));
  finish();
});

console.error("[devbox] MCP server ready");
