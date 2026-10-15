import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLogTail } from './log-tail';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-tail-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readLogTail', () => {
  it('returns every line of a small file', () => {
    const file = join(dir, 'a.log');
    writeFileSync(file, 'one\ntwo\nthree');
    expect(readLogTail(file)).toEqual(['one', 'two', 'three']);
  });

  it('reads only the window and drops the partial first line', () => {
    const file = join(dir, 'b.log');
    writeFileSync(file, 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n');
    // window of 15 bytes starts inside "bbbbbbbbbb"
    expect(readLogTail(file, 15)).toEqual(['cccccccccc', '']);
  });

  it('returns no lines for a missing file', () => {
    expect(readLogTail(join(dir, 'missing.log'))).toEqual([]);
  });
});
