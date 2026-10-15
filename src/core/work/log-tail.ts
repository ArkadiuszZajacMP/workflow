import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const LOG_TAIL_BYTES = 256 * 1024;

/** Reads the last `maxBytes` of a log as lines. Missing or unreadable files yield no lines. */
export function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
