import { describe, expect, it } from 'vitest';
import { displayTitle, formatAge } from './format';

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    expect(formatAge(0, 45_000)).toBe('45s');
    expect(formatAge(0, 5 * 60_000)).toBe('5m');
    expect(formatAge(0, 3 * 3_600_000)).toBe('3h');
    expect(formatAge(0, 2 * 86_400_000)).toBe('2d');
    expect(formatAge(10, 0)).toBe('0s');
  });
});

describe('displayTitle', () => {
  it('falls back to the Linear identifier, then the Slack channel', () => {
    expect(displayTitle({ title: 'Export fails', linearIdentifier: null, slackChannel: null })).toBe('Export fails');
    expect(displayTitle({ title: '', linearIdentifier: 'ENG-1', slackChannel: null })).toBe('ENG-1');
    expect(displayTitle({ title: '', linearIdentifier: null, slackChannel: 'C1' })).toBe('Slack thread in C1');
    expect(displayTitle({ title: '', linearIdentifier: null, slackChannel: null })).toBe('Untitled');
  });
});
