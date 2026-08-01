import { describe, test, expect } from 'bun:test';
import { parseCueArg, formatTriggerSpec, CueArgError } from '../src/core/cue-arg.js';

/** Parsing of the CLI's `--cue` arguments (story S5-04). */

describe('parseCueArg — valid forms', () => {
  test('time: accepts an ISO date or datetime', () => {
    expect(parseCueArg('time:2026-12-01')).toEqual({
      kind: 'time',
      at: '2026-12-01T00:00:00.000Z',
    });
    // An ISO time contains ':' — splitting must not truncate it.
    expect(parseCueArg('time:2026-12-01T09:30:00Z')).toEqual({
      kind: 'time',
      at: '2026-12-01T09:30:00.000Z',
    });
  });

  test('cron: keeps the expression as is', () => {
    expect(parseCueArg('cron:0 9 * * 1')).toEqual({ kind: 'time', cron: '0 9 * * 1' });
  });

  test('event: the three variants', () => {
    expect(parseCueArg('event:file_open:src/auth/service.ts')).toEqual({
      kind: 'event',
      type: 'file_open',
      path: 'src/auth/service.ts',
    });
    expect(parseCueArg('event:branch_switch:feature/x')).toEqual({
      kind: 'event',
      type: 'branch_switch',
      branch: 'feature/x',
    });
    expect(parseCueArg('event:error_pattern:SQLITE_(BUSY|LOCKED)')).toEqual({
      kind: 'event',
      type: 'error_pattern',
      pattern: 'SQLITE_(BUSY|LOCKED)',
    });
  });

  test('an error pattern may contain colons', () => {
    expect(parseCueArg('event:error_pattern:Error: ENOENT')).toEqual({
      kind: 'event',
      type: 'error_pattern',
      pattern: 'Error: ENOENT',
    });
  });

  test('a Windows path survives parsing', () => {
    expect(parseCueArg('event:file_open:D:\\projet\\src\\a.ts')).toEqual({
      kind: 'event',
      type: 'file_open',
      path: 'D:\\projet\\src\\a.ts',
    });
  });
});

describe('parseCueArg — rejected forms', () => {
  test('unknown prefix', () => {
    expect(() => parseCueArg('magie:demain')).toThrow(CueArgError);
  });

  test('missing values', () => {
    expect(() => parseCueArg('')).toThrow(/empty/);
    expect(() => parseCueArg('time:')).toThrow(/ISO/);
    expect(() => parseCueArg('cron:')).toThrow(/expression/);
    expect(() => parseCueArg('event:file_open')).toThrow(/value/);
    expect(() => parseCueArg('event:file_open:')).toThrow(/value/);
  });

  test('invalid date and event type', () => {
    expect(() => parseCueArg('time:tomorrow morning')).toThrow(/invalid/);
    expect(() => parseCueArg('event:telepathy:x')).toThrow(/unknown/);
  });
});

describe('formatTriggerSpec', () => {
  test('round-trips with parseCueArg', () => {
    const args = [
      'cron:0 9 * * 1',
      'event:file_open:src/a.ts',
      'event:branch_switch:main',
      'event:error_pattern:SQLITE_BUSY',
    ];

    for (const arg of args) {
      expect(formatTriggerSpec(parseCueArg(arg))).toBe(arg);
    }
  });

  test('a date is rendered normalised as ISO', () => {
    expect(formatTriggerSpec(parseCueArg('time:2026-12-01'))).toBe('time:2026-12-01T00:00:00.000Z');
  });
});
