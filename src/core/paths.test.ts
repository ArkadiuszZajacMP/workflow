import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from './paths';

describe('expandHome', () => {
  it('expands a leading ~ and leaves other paths alone', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.claude/skills')).toBe(path.join(homedir(), '.claude/skills'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('rel/~/x')).toBe('rel/~/x');
  });
});
