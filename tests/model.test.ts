import { describe, expect, it, vi } from 'vitest';
import type { History } from '../src/core/types';
import { CITY_SIZE, CityModel, MAX_HEIGHT, MIN_HEIGHT } from '../web/src/model';

describe('CityModel', () => {
  it('defaults to sqrt so ordinary files remain visible beside a large history file', () => {
    const m = new CityModel({
      version: 1, repo: 'express', generatedAt: '', authors: ['a'],
      files: ['History.md', 'index.js'],
      commits: [[1, 0, 'init', 'h0', [[0, 10000, 0], [1, 100, 0]]]],
    });
    expect(m.heightMode).toBe('sqrt');
    const ordinaryHeight = m.height(100);
    expect(m.height(10000)).toBe(MAX_HEIGHT);
    expect(MAX_HEIGHT).toBeLessThanOrEqual(CITY_SIZE / 4);
    m.setHeightMode('linear');
    expect(ordinaryHeight).toBeGreaterThan(m.height(100) * 4);
    for (const mode of ['linear', 'sqrt', 'log'] as const) {
      m.setHeightMode(mode);
      expect(m.height(1000000)).toBe(MAX_HEIGHT);
      expect(m.height(10000)).toBe(MAX_HEIGHT);
      expect(m.height(100)).toBeGreaterThan(m.height(1));
      expect(m.height(0)).toBe(MIN_HEIGHT);
    }
  });

  it('lists recent file commits by timestamp before limiting, without changing replay order', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const h: History = {
      version: 1, repo: 'r', generatedAt: '', authors: ['a'], files: ['app.ts'],
      commits: Array.from({ length: 15 }, (_, i) => [
        i === 0 ? 100 : i, 0, `commit ${i}`, `h${i}`, [[0, 1, 0]],
      ]),
    };
    const m = new CityModel(h);
    m.seek(14);
    const replayOrder = m.replayer.historyOf(0);
    expect(m.recentCommits(0)).toEqual([0, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(m.replayer.historyOf(0)).toEqual(replayOrder);
    m.seek(2);
    expect(m.recentCommits(0)).toEqual([0, 2, 1]);
  });

  it('gives files that exist but are always empty a lot and a visible height', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const h: History = {
      version: 1,
      repo: 'r',
      generatedAt: '',
      authors: ['a'],
      files: ['src/app.ts', 'assets/.gitkeep', 'never'],
      commits: [[1, 0, 'init', 'h0', [[0, 40, 0], [1, 0, 0]]]],
    };
    const m = new CityModel(h);
    expect(m.placed).toEqual([0, 1]);
    const lots = m.layout.lots;
    expect(lots[1 * 4 + 2] * lots[1 * 4 + 3]).toBeGreaterThan(0);
    m.seek(0);
    expect(m.height(m.replayer.lines[1])).toBe(MIN_HEIGHT);
  });
});
