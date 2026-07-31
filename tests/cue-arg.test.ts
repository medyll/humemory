import { describe, test, expect } from 'bun:test';
import { parseCueArg, formatTriggerSpec, CueArgError } from '../src/core/cue-arg.js';

/** Parsing des `--cue` de la CLI (story S5-04). */

describe('parseCueArg — formes valides', () => {
  test('time: accepte une date ou un datetime ISO', () => {
    expect(parseCueArg('time:2026-12-01')).toEqual({
      kind: 'time',
      at: '2026-12-01T00:00:00.000Z',
    });
    // Une heure ISO contient des ':' — le découpage ne doit pas la tronquer.
    expect(parseCueArg('time:2026-12-01T09:30:00Z')).toEqual({
      kind: 'time',
      at: '2026-12-01T09:30:00.000Z',
    });
  });

  test('cron: garde l\'expression telle quelle', () => {
    expect(parseCueArg('cron:0 9 * * 1')).toEqual({ kind: 'time', cron: '0 9 * * 1' });
  });

  test('event: les trois variantes', () => {
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

  test('un motif d\'erreur peut contenir des deux-points', () => {
    expect(parseCueArg('event:error_pattern:Error: ENOENT')).toEqual({
      kind: 'event',
      type: 'error_pattern',
      pattern: 'Error: ENOENT',
    });
  });

  test('un chemin Windows survit au parsing', () => {
    expect(parseCueArg('event:file_open:D:\\projet\\src\\a.ts')).toEqual({
      kind: 'event',
      type: 'file_open',
      path: 'D:\\projet\\src\\a.ts',
    });
  });
});

describe('parseCueArg — formes rejetées', () => {
  test('préfixe inconnu', () => {
    expect(() => parseCueArg('magie:demain')).toThrow(CueArgError);
  });

  test('valeurs manquantes', () => {
    expect(() => parseCueArg('')).toThrow(/vide/);
    expect(() => parseCueArg('time:')).toThrow(/ISO/);
    expect(() => parseCueArg('cron:')).toThrow(/expression/);
    expect(() => parseCueArg('event:file_open')).toThrow(/valeur/);
    expect(() => parseCueArg('event:file_open:')).toThrow(/valeur/);
  });

  test('date et type d\'event invalides', () => {
    expect(() => parseCueArg('time:demain matin')).toThrow(/invalide/);
    expect(() => parseCueArg('event:telepathie:x')).toThrow(/inconnu/);
  });
});

describe('formatTriggerSpec', () => {
  test('fait l\'aller-retour avec parseCueArg', () => {
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

  test('une date est rendue normalisée en ISO', () => {
    expect(formatTriggerSpec(parseCueArg('time:2026-12-01'))).toBe('time:2026-12-01T00:00:00.000Z');
  });
});
