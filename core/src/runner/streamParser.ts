/**
 * Parses NDJSON events from `claude -p --verbose --output-format stream-json`.
 *
 * Event types (from spike on 2026-11-21):
 *   system/init           — session started; has tools, mcp_servers, model, permissionMode, session_id
 *   system/hook_started   — PreToolUse / PostToolUse / other hook fired
 *   system/hook_response  — hook output
 *   assistant             — assistant turn; message.content has text/tool_use blocks; message.usage
 *   user                  — tool_result or injected user message
 *   result                — final event with authoritative usage, total_cost_usd, duration_ms
 */

export type ClaudeEventType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'result';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  costUsd: number;
}

export interface ClaudeInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  cwd: string;
  permissionMode: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  uuid: string;
}

export interface ClaudeHookEvent {
  type: 'system';
  subtype: 'hook_started' | 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
  output?: string;
  exit_code?: number;
  outcome?: string;
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    model: string;
    stop_reason: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      output_tokens_details?: { thinking_tokens: number };
    };
  };
  session_id: string;
  uuid: string;
  timestamp: string;
  error?: string;
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  session_id: string;
  result: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens_details?: { thinking_tokens: number };
    service_tier: string;
  };
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  is_error: boolean;
  /** Present when the run was started with a JSON schema. */
  structured_output?: unknown;
  uuid: string;
}

export type ClaudeEvent =
  | ClaudeInitEvent
  | ClaudeHookEvent
  | ClaudeAssistantEvent
  | ClaudeResultEvent
  | Record<string, unknown>; // catch-all for unknown events

/** Parse a single NDJSON line from claude stdout. Returns null for blank lines. */
export function parseLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeEvent;
  } catch {
    // Not JSON (startup text before first event)
    return null;
  }
}

/** Extract usage snapshot from an assistant or result event. */
export function extractUsage(event: ClaudeEvent): UsageSnapshot | null {
  const e = event as Record<string, unknown>;

  if (e['type'] === 'assistant') {
    const ae = event as ClaudeAssistantEvent;
    const u = ae.message?.usage;
    if (!u) return null;
    return {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
      costUsd: 0, // cost only available in result event
    };
  }

  if (e['type'] === 'result') {
    const re = event as ClaudeResultEvent;
    const u = re.usage;
    if (!u) return null;
    return {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
      costUsd: re.total_cost_usd ?? 0,
    };
  }

  return null;
}
