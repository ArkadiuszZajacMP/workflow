import { describe, expect, it } from 'vitest';
import { runProcess } from './process';

const node = process.execPath;

describe('runProcess', () => {
  it('streams stdout lines, captures stderr and exit code, and passes env and stdin', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      node,
      ['-e', 'process.stdin.on("data",d=>{console.log("a");console.log(process.env.SECRET+":"+d);console.error("warn");process.exit(3)})'],
      { env: { SECRET: 's3' }, stdin: 'in', onLine: (l) => lines.push(l) },
    );
    expect(lines).toEqual(['a', 's3:in']);
    expect(result).toMatchObject({ exitCode: 3, stderr: 'warn\n', timedOut: false, aborted: false });
  });

  it('kills on timeout and on abort', async () => {
    const slow = ['-e', 'setTimeout(()=>{},60000)'];
    await expect(runProcess(node, slow, { timeoutMs: 100 })).resolves.toMatchObject({ timedOut: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(runProcess(node, slow, { signal: controller.signal })).resolves.toMatchObject({ aborted: true });
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const lines: string[] = [];
    const script =
      'const b=Buffer.from("zażółć 🎉\\n");let i=0;const t=setInterval(()=>{if(i>=b.length){clearInterval(t);return}process.stdout.write(b.subarray(i,++i))},5)';
    const result = await runProcess(node, ['-e', script], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['zażółć 🎉']);
    expect(result.stdout).toBe('zażółć 🎉\n');
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const stubborn = ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'];
    const started = Date.now();
    await expect(runProcess(node, stubborn, { timeoutMs: 100, killGraceMs: 200 })).resolves.toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('resolves when a timeout is followed by an abort', async () => {
    const stubborn = ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await runProcess(node, stubborn, { timeoutMs: 100, killGraceMs: 300, signal: controller.signal });
    expect(result).toMatchObject({ timedOut: true, aborted: true });
  });

  it('rejects with a TransientError when the command cannot start', async () => {
    await expect(runProcess('/nonexistent/binary', [])).rejects.toThrow(/Could not start/);
  });
});
