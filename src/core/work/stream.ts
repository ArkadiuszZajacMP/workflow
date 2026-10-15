/** Events from `claude -p --output-format stream-json --verbose` lines that the app cares about. */
export type StreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null };

type RawContent = { type?: string; text?: string; name?: string; input?: unknown };
type RawLine = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: RawContent[] };
};

export function parseStreamLine(line: string): StreamEvent[] {
  if (!line.trim()) return [];
  let raw: RawLine;
  try {
    raw = JSON.parse(line) as RawLine;
  } catch {
    return [];
  }
  if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) return [{ type: 'session', sessionId: raw.session_id }];
  if (raw.type === 'result') {
    return [
      {
        type: 'result',
        ok: raw.subtype === 'success' && !raw.is_error,
        subtype: raw.subtype ?? 'unknown',
        text: raw.result ?? '',
        sessionId: raw.session_id ?? null,
      },
    ];
  }
  if (raw.type === 'assistant') {
    const events: StreamEvent[] = [];
    for (const part of raw.message?.content ?? []) {
      if (part.type === 'text' && part.text) events.push({ type: 'text', text: part.text });
      if (part.type === 'tool_use' && part.name) {
        events.push({ type: 'tool', name: part.name, summary: JSON.stringify(part.input ?? {}).slice(0, 160) });
      }
    }
    return events;
  }
  return [];
}

/** Human-readable tail of a run log for the dashboard. */
export function displayLines(lines: string[], limit = 30): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const event of parseStreamLine(line)) {
      if (event.type === 'text') out.push(`💬 ${event.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (event.type === 'tool') out.push(`🔧 ${event.name} ${event.summary}`);
      if (event.type === 'result') out.push(event.ok ? `✅ Finished (${event.subtype})` : `❌ Ended (${event.subtype})`);
    }
  }
  return out.slice(-limit);
}
