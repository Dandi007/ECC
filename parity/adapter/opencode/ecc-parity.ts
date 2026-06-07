/**
 * ECC Parity Adapter for OpenCode (ecc.parity.v1)
 *
 * Thin event adapter: maps OpenCode events to Claude Code hook semantics and
 * spawns the SAME scripts/hooks/*.js through the SAME run-with-flags.js gate
 * (ECC_HOOK_PROFILE / ECC_DISABLED_HOOKS) that Claude Code uses. There is only
 * ONE hook implementation; this file owns zero hook logic.
 *
 * Verified event surface (official opencode 1.16.2, 2026-06-07 spike):
 *   - lifecycle events (session.created/idle, file.edited, ...) do NOT fire as
 *     plugin hook keys — they only arrive via the generic `event` handler.
 *   - real hook keys: tool.execute.before/after, chat.message, chat.params,
 *     shell.env, experimental.session.compacting (unverified), permission.ask.
 *
 * Contracts: parity/contracts/*.yaml
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// ---------- root / script resolution ----------

function repoRoot(): string {
  const env = process.env.ECC_PARITY_ROOT
  if (env && env.trim()) return env.trim()
  // this file: <root>/parity/adapter/opencode/ecc-parity.ts
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "..", "..", "..")
}

const ROOT = repoRoot()
const RUN_WITH_FLAGS = path.join(ROOT, "scripts", "hooks", "run-with-flags.js")

// Same hookId/script/profiles tuples as hooks/hooks.json registers for Claude Code.
const HOOK = {
  sessionStart: { id: "session:start", script: "scripts/hooks/session-start.js", profiles: "minimal,standard,strict" },
  sessionEnd: { id: "stop:session-end", script: "scripts/hooks/session-end.js", profiles: "minimal,standard,strict" },
  desktopNotify: { id: "stop:desktop-notify", script: "scripts/hooks/desktop-notify.js", profiles: "standard,strict" },
  preCompact: { id: "pre:compact", script: "scripts/hooks/pre-compact.js", profiles: "standard,strict" },
  metricsBridge: { id: "post:ecc-metrics-bridge", script: "scripts/hooks/ecc-metrics-bridge.js", profiles: "minimal,standard,strict" },
  contextMonitor: { id: "post:ecc-context-monitor", script: "scripts/hooks/ecc-context-monitor.js", profiles: "standard,strict" },
  postBashDispatcher: { id: "post:bash:dispatcher", script: "scripts/hooks/post-bash-dispatcher.js", profiles: "minimal,standard,strict" },
} as const

// contracts/_meta.yaml tool_name_map
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  todowrite: "TodoWrite",
  task: "Agent",
}

function ccToolName(ocTool: string): string {
  return TOOL_NAME_MAP[ocTool?.toLowerCase?.() ?? ""] ?? ocTool
}

function runHook(
  hook: { id: string; script: string; profiles: string },
  stdinPayload: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn("node", [RUN_WITH_FLAGS, hook.id, hook.script, hook.profiles], {
        cwd: ROOT,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) })
      return
    }
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", err => resolve({ code: -1, stdout, stderr: String(err) }))
    child.on("close", code => resolve({ code, stdout, stderr }))
    child.stdin.write(JSON.stringify(stdinPayload))
    child.stdin.end()
  })
}

// ---------- per-session state (in-memory; transcript synthesized on idle) ----------

interface SessionState {
  transcript: object[] // CC-transcript-shaped JSONL entries (see stop-session-end.yaml notes)
  lastAssistantText: string
  injection: string | null // session-start additionalContext awaiting first user message
  injected: boolean
  ended: boolean
}

const sessions = new Map<string, SessionState>()

function state(sessionID: string): SessionState {
  let s = sessions.get(sessionID)
  if (!s) {
    s = { transcript: [], lastAssistantText: "", injection: null, injected: false, ended: false }
    sessions.set(sessionID, s)
  }
  return s
}

function writeTranscript(sessionID: string, s: SessionState): string {
  const file = path.join(os.tmpdir(), `ecc-parity-transcript-${sessionID}.jsonl`)
  fs.writeFileSync(file, s.transcript.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8")
  return file
}

// SessionStart stdout protocol: plain text or {hookSpecificOutput:{additionalContext}}
function parseAdditionalContext(stdout: string): string | null {
  const raw = stdout.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const ctx = parsed?.hookSpecificOutput?.additionalContext
    return typeof ctx === "string" && ctx.trim() ? ctx : null
  } catch {
    return raw // plain-text additional context
  }
}

// ---------- plugin ----------

export const EccParity = async (ctx: { directory?: string }) => {
  const projectDir = ctx?.directory ?? process.cwd()

  async function onSessionCreated(sessionID: string) {
    const s = state(sessionID)
    const res = await runHook(HOOK.sessionStart, {
      session_id: sessionID,
      source: "startup",
      cwd: projectDir,
      hook_event_name: "SessionStart",
    })
    s.injection = parseAdditionalContext(res.stdout)
  }

  async function onSessionIdle(sessionID: string) {
    const s = state(sessionID)
    if (s.ended) return
    s.ended = true
    const transcriptPath = writeTranscript(sessionID, s)
    await runHook(HOOK.sessionEnd, {
      session_id: sessionID,
      transcript_path: transcriptPath,
      cwd: projectDir,
      hook_event_name: "Stop",
    })
    await runHook(HOOK.desktopNotify, {
      session_id: sessionID,
      last_assistant_message: s.lastAssistantText,
      hook_event_name: "Stop",
    })
    s.ended = false // session may resume; allow next idle to persist again
  }

  return {
    // lifecycle arrives ONLY on the generic event bus (spike-verified)
    event: async (input: { event?: { type?: string; properties?: any } }) => {
      const ev = input?.event
      if (!ev?.type) return
      const sessionID: string | undefined = ev.properties?.sessionID ?? ev.properties?.info?.id
      if (ev.type === "session.created" && sessionID) await onSessionCreated(sessionID)
      if (ev.type === "session.idle" && sessionID) await onSessionIdle(sessionID)
      if (ev.type === "message.part.updated") {
        const part = ev.properties?.part
        if (part?.type === "text" && part?.text && ev.properties?.delta === undefined) {
          const sid = part.sessionID
          if (sid) state(sid).lastAssistantText = part.text
        }
      }
    },

    "chat.message": async (
      _input: { sessionID?: string },
      output: { message?: { sessionID?: string; role?: string }; parts?: Array<{ type: string; text?: string }> },
    ) => {
      const sid = output?.message?.sessionID
      if (!sid || output?.message?.role !== "user" || !Array.isArray(output?.parts)) return
      const s = state(sid)
      // record user message into synthesized transcript (session-end consumes role/content)
      const text = output.parts.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n")
      if (text) s.transcript.push({ role: "user", content: text })
      // session-start context injection: prepend once, before the first user message
      if (s.injection && !s.injected) {
        s.injected = true
        output.parts.unshift({ type: "text", text: `<ecc-context>\n${s.injection}\n</ecc-context>` })
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args?: any },
      output: { title?: string; output?: string; metadata?: any },
    ) => {
      const toolName = ccToolName(input.tool)
      const s = state(input.sessionID)
      s.transcript.push({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: toolName, input: input.args ?? {} }] },
      })
      const payload = {
        session_id: input.sessionID,
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_input: input.args ?? {},
        tool_output: output?.output ?? "",
        cwd: projectDir,
      }
      await runHook(HOOK.metricsBridge, payload)
      await runHook(HOOK.contextMonitor, payload)
      if (toolName === "Bash") await runHook(HOOK.postBashDispatcher, payload)
    },

    // hook key existence unverified on 1.16.2 (contracts: pre-compact.yaml); harmless if never called
    "experimental.session.compacting": async (input: { sessionID?: string }) => {
      await runHook(HOOK.preCompact, {
        session_id: input?.sessionID ?? "",
        trigger: "auto",
        hook_event_name: "PreCompact",
      })
    },
  }
}
