/**
 * Pure configuration derivations for the Claude provider. These are the
 * provider-runtime implementations the runtime contract declares for the
 * executionPolicy / inference / mcpServers / memory capabilities — and the
 * exact functions the live query path consumes, so the contract's probe
 * exercises the real wiring, not a parallel description of it.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RuntimeInferenceInput } from '../provider-contracts/registry.js';
import { shimCwd } from './cwd-shim.js';
import type { McpServerConfig } from './types.js';

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - SendMessage: addresses Claude Code's own in-session subagents, which are
//   unrelated to NanoClaw agent groups — but the name reads as the obvious
//   way to message another agent, so an agent that just called
//   mcp__nanoclaw__create_agent reaches for it and gets "No agent named 'x'
//   is currently addressable". mcp__nanoclaw__send_message is the real
//   agent-to-agent path (it resolves the destination map in inbound.db).
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
export const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'SendMessage',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// Built-in tool allowlist for NanoClaw agent containers, passed to the SDK as
// its `tools` option (the base set of built-ins; MCP tools are not affected).
// Names are CC 2.1.280's: the subagent tool is still called `Task`; the native
// build has no Glob/Grep unless listed here; `Monitor` streams background Bash
// output. Deliberately absent: ListAgents (pairs with the blocked SendMessage),
// Workflow and PushNotification (no headless host surface). `TeamCreate` /
// `TeamDelete` / `TodoWrite` do not exist in every build; an unknown name is
// ignored by the CLI. SDK_DISALLOWED_TOOLS and the PreToolUse hook stay as
// defense in depth. NOTE: `allowedTools` is NOT a filter — under
// bypassPermissions it only pre-approves; it is kept for the MCP patterns.
export const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'Monitor',
];

/** The SDK `tools` option: built-ins only, derived from TOOL_ALLOWLIST. A fresh array per call. */
export function resolveClaudeBuiltinTools(): string[] {
  return [...TOOL_ALLOWLIST];
}

/**
 * Names of the skills actually installed for this agent: the entries of
 * `<config dir>/skills` (host-selected container skills symlinked in,
 * template-stamped dirs, agent-authored dirs). Passed as the SDK `skills`
 * option so Claude Code's own bundled skills are not offered. A missing or
 * unreadable directory yields [] (no skills at all).
 */
export function listInstalledSkills(configDir: string): string[] {
  const dir = path.join(configDir, 'skills');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => {
        if (name.startsWith('.')) return false;
        try {
          return fs.statSync(path.join(dir, name)).isDirectory(); // follows symlinks; a broken link is skipped
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
export function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

/**
 * Claude runs unrestricted inside the container: NanoClaw's container
 * isolation and the OneCLI allow-list are the security boundary, not the
 * SDK's own permission prompts. The disallowed builtins are policy too —
 * they are the SDK surfaces that would bypass nanoclaw's scheduling or hang
 * a headless session.
 *
 * `settings` rides the SDK's flag-level settings, which outrank the group's
 * own settings files, so it holds for every group, existing ones included.
 * Since 2.1.275 Claude Code syncs the skills and plugins enabled on the
 * signed-in claude.ai account into terminal sessions; the sync keys opt out,
 * so an agent gets the skills nanoclaw mounts, not the operator's own.
 */
export function resolveClaudeExecutionPolicy(): {
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  disallowedTools: string[];
  settings: { syncClaudeAiSkills: false; syncClaudeAiPlugins: false };
} {
  return {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // A copy: the contract value is deep-frozen on registration, and the
    // exported constant must stay a plain mutable array.
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
    settings: { syncClaudeAiSkills: false, syncClaudeAiPlugins: false },
  };
}

/**
 * Model and reasoning effort pass to the SDK verbatim; the SDK owns defaults.
 * `speed: 'fast'` maps to the SDK's `fastMode` settings key (the `/fast`
 * toggle); `standard` keeps the SDK default. Unknown values are ignored.
 */
export function resolveClaudeInference(
  input: RuntimeInferenceInput,
  _environment: NodeJS.ProcessEnv,
): { model?: string; effort?: string; settings?: { fastMode: boolean } } {
  return {
    model: input.model,
    effort: input.effort,
    ...(input.speed === 'fast' ? { settings: { fastMode: true } } : {}),
  };
}

/**
 * The SDK's stdio server config has no cwd field, so stdio servers with a
 * cwd are wrapped through the shell shim; the pre-approval list gains one pattern
 * per server (allowedTools pre-approves; it does not filter).
 */
export function resolveClaudeMcpServers(
  input: Record<string, McpServerConfig>,
  _environment: NodeJS.ProcessEnv,
): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const mcpServers = Object.fromEntries(Object.entries(input).map(([name, server]) => [name, shimCwd(server)]));
  return {
    mcpServers,
    allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(mcpServers).map(mcpAllowPattern)],
  };
}

/**
 * NanoClaw owns persistent memory across providers: the session hook injects
 * the shared memory tree, and the SDK's own auto-memory stays disabled so the
 * two never diverge. The hook itself is file-carried (settings.json); this is
 * the runtime half of the same capability.
 */
export function resolveClaudeMemoryRuntime(): { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } {
  return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}
