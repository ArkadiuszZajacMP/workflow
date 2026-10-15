import { describe, expect, it } from 'vitest';
import { displayLines, parseStreamLine } from './stream';

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });
const assistant = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Reading the parser' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/work/core/src/main.ts' } },
    ],
  },
});
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', session_id: 's-1' });
const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's-1' });

describe('parseStreamLine', () => {
  it('extracts session, text, tool calls and results', () => {
    expect(parseStreamLine(init)).toEqual([{ type: 'session', sessionId: 's-1' }]);
    expect(parseStreamLine(assistant)).toEqual([
      { type: 'text', text: 'Reading the parser' },
      { type: 'tool', name: 'Read', summary: '{"file_path":"/work/core/src/main.ts"}' },
    ]);
    expect(parseStreamLine(result)).toEqual([{ type: 'result', ok: true, subtype: 'success', text: '{"ok":true}', sessionId: 's-1' }]);
    expect(parseStreamLine(failed)).toEqual([{ type: 'result', ok: false, subtype: 'error_max_turns', text: '', sessionId: 's-1' }]);
  });

  it('ignores blank, non-JSON and unknown lines', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'user' }))).toEqual([]);
  });
});

describe('displayLines', () => {
  it('renders the last N text and tool lines', () => {
    expect(displayLines([init, assistant, result], 2)).toEqual([
      '🔧 Read {"file_path":"/work/core/src/main.ts"}',
      '✅ Finished (success)',
    ]);
  });
});
