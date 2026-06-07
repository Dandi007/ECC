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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- root / script resolution ----------

function repoRoot(): string {
  const env = process.env.ECC_PARITY_ROOT;
  if (env && env.trim()) return env.trim();
  // this file: <root>/parity/adapter/opencode/ecc-parity.ts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

const ROOT = repoRoot();
const RUN_WITH_FLAGS = path.join(ROOT, 'scripts', 'hooks', 'run-with-flags.js');

// Same hookId/script/profiles tuples as hooks/hooks.json registers for Claude Code.
const HOOK = {
  sessionStart: { id: 'session:start', script: 'scripts/hooks/session-start.js', profiles: 'minimal,standard,strict' },
  sessionEnd: { id: 'stop:session-end', script: 'scripts/hooks/session-end.js', profiles: 'minimal,standard,strict' },
  desktopNotify: { id: 'stop:desktop-notify', script: 'scripts/hooks/desktop-notify.js', profiles: 'standard,strict' },
  preCompact: { id: 'pre:compact', script: 'scripts/hooks/pre-compact.js', profiles: 'standard,strict' },
  metricsBridge: { id: 'post:ecc-metrics-bridge', script: 'scripts/hooks/ecc-metrics-bridge.js', profiles: 'minimal,standard,strict' },
  contextMonitor: { id: 'post:ecc-context-monitor', script: 'scripts/hooks/ecc-context-monitor.js', profiles: 'standard,strict' },
  postBashDispatcher: { id: 'post:bash:dispatcher', script: 'scripts/hooks/post-bash-dispatcher.js', profiles: 'minimal,standard,strict' }
} as const;

// contracts/_meta.yaml tool_name_map
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  todowrite: 'TodoWrite',
  task: 'Agent'
};

function ccToolName(ocTool: string): string {
  return TOOL_NAME_MAP[ocTool?.toLowerCase?.() ?? ''] ?? ocTool;
}

// OpenCode tool args use camelCase (filePath); CC hook consumers expect
// snake_case (file_path) — e.g. ecc-metrics-bridge files_modified extraction.
function ccToolInput(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = { ...(args ?? {}) };
  if ('filePath' in input && !('file_path' in input)) {
    input.file_path = input.filePath;
    delete input.filePath;
  }
  return input;
}

/**
 * Spawn a hook through run-with-flags with the payload as stdin.
 *
 * OpenCode may exit the instant a session-idle handler starts (e.g. `opencode
 * run`), killing piped stdin before the child reads it. So the payload goes
 * through a temp file opened as the child's stdin fd, and the child is
 * detached+unref'd — it survives parent death and completes its file effects
 * (this mirrors Claude Code, which always delivers complete stdin).
 *
 * `capture: true` keeps stdout piped and awaits completion — only for hooks
 * whose stdout matters (session-start additionalContext), which run while the
 * session is alive anyway.
 */
function runHook(
  hook: { id: string; script: string; profiles: string },
  payload: Record<string, unknown>,
  opts: { cwd?: string; capture?: boolean } = {}
): Promise<{ code: number | null; stdout: string }> {
  const payloadFile = path.join(os.tmpdir(), `ecc-parity-stdin-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf8');
  const stdinFd = fs.openSync(payloadFile, 'r');
  const common = {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT }
  };
  return new Promise(resolve => {
    try {
      if (opts.capture) {
        const child = spawn('node', [RUN_WITH_FLAGS, hook.id, hook.script, hook.profiles], {
          ...common,
          stdio: [stdinFd, 'pipe', 'ignore']
        });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.on('error', () => resolve({ code: -1, stdout }));
        child.on('close', code => {
          fs.closeSync(stdinFd);
          try {
            fs.unlinkSync(payloadFile);
          } catch {}
          resolve({ code, stdout });
        });
      } else {
        const child = spawn('node', [RUN_WITH_FLAGS, hook.id, hook.script, hook.profiles], {
          ...common,
          detached: true,
          stdio: [stdinFd, 'ignore', 'ignore']
        });
        child.unref();
        fs.closeSync(stdinFd);
        resolve({ code: 0, stdout: '' }); // fire-and-forget; effects are file-level
      }
    } catch (err) {
      resolve({ code: -1, stdout: '' });
    }
  });
}

// ---------- per-session state (in-memory; transcript synthesized on idle) ----------

interface SessionState {
  transcript: object[]; // CC-transcript-shaped JSONL entries (see stop-session-end.yaml notes)
  lastAssistantText: string;
  injection: string | null; // session-start additionalContext awaiting first user message
  injected: boolean;
  ended: boolean;
}

const sessions = new Map<string, SessionState>();

function state(sessionID: string): SessionState {
  let s = sessions.get(sessionID);
  if (!s) {
    s = { transcript: [], lastAssistantText: '', injection: null, injected: false, ended: false };
    sessions.set(sessionID, s);
  }
  return s;
}

// Transcript filename must end in a UUID like Claude Code transcripts do —
// session-end.js derives its session-file shortId from that UUID (issue #1494
// codepath). Derive a stable UUID from the OpenCode session id.
function sessionUuid(sessionID: string): string {
  const hex = createHash('md5').update(sessionID).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function writeTranscript(sessionID: string, s: SessionState): string {
  const file = path.join(os.tmpdir(), `${sessionUuid(sessionID)}.jsonl`);
  fs.writeFileSync(file, s.transcript.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

// SessionStart stdout protocol: plain text or {hookSpecificOutput:{additionalContext}}
function parseAdditionalContext(stdout: string): string | null {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' && ctx.trim() ? ctx : null;
  } catch {
    return raw; // plain-text additional context
  }
}

// ---------- plugin ----------

export const EccParity = async (ctx: { directory?: string }) => {
  const projectDir = ctx?.directory ?? process.cwd();

  async function onSessionCreated(sessionID: string) {
    const s = state(sessionID);
    const res = await runHook(
      HOOK.sessionStart,
      {
        session_id: sessionID,
        source: 'startup',
        cwd: projectDir,
        hook_event_name: 'SessionStart'
      },
      { cwd: projectDir, capture: true }
    );
    s.injection = parseAdditionalContext(res.stdout);
  }

  async function onSessionIdle(sessionID: string) {
    const s = state(sessionID);
    if (s.ended) return;
    s.ended = true;
    const transcriptPath = writeTranscript(sessionID, s);
    await Promise.all([
      runHook(
        HOOK.sessionEnd,
        {
          session_id: sessionID,
          transcript_path: transcriptPath,
          cwd: projectDir,
          hook_event_name: 'Stop'
        },
        { cwd: projectDir }
      ),
      runHook(
        HOOK.desktopNotify,
        {
          session_id: sessionID,
          last_assistant_message: s.lastAssistantText,
          hook_event_name: 'Stop'
        },
        { cwd: projectDir }
      )
    ]);
    s.ended = false; // session may resume; allow next idle to persist again
  }

  return {
    // lifecycle arrives ONLY on the generic event bus (spike-verified)
    event: async (input: { event?: { type?: string; properties?: any } }) => {
      const ev = input?.event;
      if (!ev?.type) return;
      const sessionID: string | undefined = ev.properties?.sessionID ?? ev.properties?.info?.id;
      if (ev.type === 'session.created' && sessionID) await onSessionCreated(sessionID);
      if (ev.type === 'session.idle' && sessionID) await onSessionIdle(sessionID);
      if (ev.type === 'message.part.updated') {
        const part = ev.properties?.part;
        if (part?.type === 'text' && part?.text && ev.properties?.delta === undefined) {
          const sid = part.sessionID;
          if (sid) state(sid).lastAssistantText = part.text;
        }
      }
    },

    'chat.message': async (_input: { sessionID?: string }, output: { message?: { id?: string; sessionID?: string; role?: string }; parts?: Array<{ type: string; text?: string; id?: string; sessionID?: string; messageID?: string }> }) => {
      const sid = output?.message?.sessionID;
      if (!sid || output?.message?.role !== 'user' || !Array.isArray(output?.parts)) return;
      const s = state(sid);
      // record user message into synthesized transcript (session-end consumes role/content)
      const text = output.parts
        .filter(p => p.type === 'text' && p.text)
        .map(p => p.text)
        .join('\n');
      if (text) s.transcript.push({ role: 'user', content: text });
      // session-start context injection: prepend once, before the first user message.
      // Official opencode (>=1.16) schema-validates user parts on save: a bare
      // {type,text} part dies with `Missing key ["id"]/["sessionID"]/["messageID"]`
      // and the whole prompt fails silently (no assistant turn, no title). So we
      // prepend into an existing text part (already carries valid keys); only if
      // no text part exists do we unshift a new part with all required keys set.
      if (s.injection && !s.injected) {
        s.injected = true;
        const ctx = `<ecc-context>\n${s.injection}\n</ecc-context>`;
        const firstText = output.parts.find(p => p.type === 'text' && typeof p.text === 'string');
        if (firstText) {
          firstText.text = `${ctx}\n\n${firstText.text}`;
        } else {
          output.parts.unshift({
            type: 'text',
            text: ctx,
            id: `prt_ecc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            sessionID: sid,
            messageID: output.message?.id,
          });
        }
      }
    },

    'tool.execute.after': async (input: { tool: string; sessionID: string; callID: string; args?: any }, output: { title?: string; output?: string; metadata?: any }) => {
      const toolName = ccToolName(input.tool);
      const toolInput = ccToolInput(input.args);
      const s = state(input.sessionID);
      s.transcript.push({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: toolName, input: toolInput }] }
      });
      const payload = {
        session_id: input.sessionID,
        hook_event_name: 'PostToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_output: output?.output ?? '',
        cwd: projectDir
      };
      await runHook(HOOK.metricsBridge, payload, { cwd: projectDir });
      await runHook(HOOK.contextMonitor, payload, { cwd: projectDir });
      if (toolName === 'Bash') await runHook(HOOK.postBashDispatcher, payload, { cwd: projectDir });
    },

    // hook key existence unverified on 1.16.2 (contracts: pre-compact.yaml); harmless if never called
    'experimental.session.compacting': async (input: { sessionID?: string }) => {
      await runHook(HOOK.preCompact, {
        session_id: input?.sessionID ?? '',
        trigger: 'auto',
        hook_event_name: 'PreCompact'
      });
    }
  };
};
