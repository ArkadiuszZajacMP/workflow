import { describe, expect, it } from 'vitest';
import { ActionError } from '@/core/errors';
import { knownRepoKeys, loadCurrentRepoMap } from './current';

describe('current repo map', () => {
  it('reports a missing map as an ActionError and an empty key list', () => {
    const before = process.env.WORKFLOW_CONFIG;
    process.env.WORKFLOW_CONFIG = '/nonexistent/workflow.config.yaml';
    try {
      expect(() => loadCurrentRepoMap()).toThrow(ActionError);
      expect(knownRepoKeys()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.WORKFLOW_CONFIG;
      else process.env.WORKFLOW_CONFIG = before;
    }
  });
});
