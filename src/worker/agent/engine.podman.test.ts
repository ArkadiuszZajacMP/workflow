import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PodmanEngine } from './engine';

const engine = new PodmanEngine('podman');
const name = `wf-podman-test-${process.pid}`;
const image = 'workflow-agent:latest';

describe('PodmanEngine (real podman)', () => {
  afterAll(async () => {
    await engine.remove(name);
  });

  it('builds the image if needed, runs claude in a fresh workspace and removes it', async () => {
    if (!(await engine.imageExists(image))) await engine.buildImage(image, path.resolve('containers/agent'));
    await expect(engine.ensureContainer(name, image)).resolves.toEqual({ created: true });
    const version = await engine.exec({ container: name, workdir: '/work', args: ['claude', '--version'] });
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/Claude Code/);
    const whoami = await engine.exec({ container: name, args: ['sh', '-c', 'id -u && echo $HOME && touch /work/ok && ls /work'] });
    expect(whoami.stdout.split('\n')[0]).toBe('1000');
    expect(whoami.stdout).toContain('/home/node');
    expect(whoami.stdout).toContain('ok');
  });
});
