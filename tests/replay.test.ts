import { describe, expect, it } from 'vitest';
import { generateDemoHistory } from '../src/core/demo';
import { Replayer } from '../src/core/replay';
import { BINARY_LINES, type CommitTuple, type History } from '../src/core/types';

function hist(files: string[], commits: CommitTuple[], authors = ['a', 'b']): History {
  return { version: 1, repo: 't', generatedAt: '', authors, files, commits };
}

describe('Replayer', () => {
  const h = hist(
    ['a.ts', 'b.ts', 'c.png', 'lib/a.ts'],
    [
      [1, 0, 'add a, b, c', 'h0', [[0, 100, 0], [1, 10, 0], [2, -1, -1]]],
      [2, 1, 'edit a', 'h1', [[0, 20, 50]]],
      [3, 0, 'move a', 'h2', [[3, 5, 0, 0]]],
      [4, 1, 'delete b and c', 'h3', [[1, 0, 10, -1], [2, -1, -1, -1]]],
      [5, 1, 'edit moved', 'h4', [[3, 1, 1]]],
    ],
  );

  it('applies deltas, renames, binary files and deletions', () => {
    const r = new Replayer(h, { snapshotInterval: 2 });
    r.seek(0);
    expect(Array.from(r.lines)).toEqual([100, 10, BINARY_LINES, 0]);
    expect(Array.from(r.exists)).toEqual([1, 1, 1, 0]);
    expect(r.binary[2]).toBe(1);
    r.seek(1);
    expect(r.lines[0]).toBe(70);
    expect(r.lastAuthor[0]).toBe(1);
    r.seek(2);
    expect(r.lines[0]).toBe(0);
    expect(r.exists[0]).toBe(0);
    expect(r.lines[3]).toBe(75);
    expect(r.exists[3]).toBe(1);
    r.seek(3);
    expect(Array.from(r.exists)).toEqual([0, 0, 0, 1]);
    expect(r.totals()).toEqual({ files: 1, lines: 75 });
    r.seek(-1);
    expect(Array.from(r.lines)).toEqual([0, 0, 0, 0]);
    expect(r.index).toBe(-1);
  });

  it('tracks peaks, touches and history across renames', () => {
    const r = new Replayer(h);
    expect(Array.from(r.peakLines)).toEqual([100, 10, BINARY_LINES, 75]);
    expect(r.touches[3]).toEqual([2, 4]);
    r.seek(4);
    expect(r.historyOf(3)).toEqual([0, 1, 2, 4]);
    // lib/a.ts did not exist yet at commit 1.
    expect(r.historyOf(3, 1)).toEqual([]);
    expect(r.historyOf(3, 2)).toEqual([0, 1, 2]);
    expect(Object.fromEntries(r.authorsOf(3))).toEqual({ 0: 2, 1: 2 });
  });

  it('clamps out-of-range seeks', () => {
    const r = new Replayer(h);
    r.seek(1e9);
    expect(r.index).toBe(4);
    r.seek(-50);
    expect(r.index).toBe(-1);
  });

  it('never drops below zero lines', () => {
    const r = new Replayer(hist(['x'], [[1, 0, 'm', 'h', [[0, 1, 5]]]]));
    r.seek(0);
    expect(r.lines[0]).toBe(0);
  });

  it('keeps a file that is emptied without a delete flag', () => {
    const r = new Replayer(hist(['x'], [[1, 0, 'add', 'h', [[0, 3, 0]]], [2, 0, 'empty', 'h2', [[0, 0, 3]]]]));
    r.seek(1);
    expect(r.exists[0]).toBe(1);
    expect(r.lines[0]).toBe(0);
    expect(r.totals()).toEqual({ files: 1, lines: 0 });
  });

  it('marks always-empty files as existing', () => {
    const r = new Replayer(hist(['.gitkeep', 'gone'], [[1, 0, 'add', 'h', [[0, 0, 0]]]]));
    expect(Array.from(r.everExists)).toEqual([1, 0]);
    expect(r.peakLines[0]).toBe(0);
  });

  it('reads rename sources from the state before the commit', () => {
    // Swap a (3 lines) and b (7 lines).
    const swap = new Replayer(
      hist(['a', 'b'], [
        [1, 0, 'add', 'h0', [[0, 3, 0], [1, 7, 0]]],
        [2, 0, 'swap', 'h1', [[1, 0, 0, 0], [0, 0, 0, 1]]],
      ]),
    );
    swap.seek(1);
    expect(Array.from(swap.lines)).toEqual([7, 3]);
    expect(Array.from(swap.exists)).toEqual([1, 1]);

    // Rename a -> b and create a replacement a, with the creation listed first.
    const replace = new Replayer(
      hist(['a', 'b'], [
        [1, 0, 'add', 'h0', [[0, 3, 0]]],
        [2, 0, 'mv+new', 'h1', [[0, 7, 0], [1, 0, 0, 0]]],
      ]),
    );
    replace.seek(1);
    expect(Array.from(replace.lines)).toEqual([7, 3]);
    expect(Array.from(replace.exists)).toEqual([1, 1]);
  });

  it('applies rewritten (binary to text) content as an absolute line count', () => {
    const r = new Replayer(hist(['d'], [[1, 0, 'bin', 'h0', [[0, -1, -1]]], [2, 0, 'text', 'h1', [[0, 12, 0, -2]]], [3, 0, 'edit', 'h2', [[0, 1, 0]]]]));
    r.seek(1);
    expect(r.binary[0]).toBe(0);
    expect(r.lines[0]).toBe(12);
    r.seek(2);
    expect(r.lines[0]).toBe(13);
  });

  it('bounds rename history to the rename and to the current incarnation', () => {
    const r = new Replayer(
      hist(
        ['a', 'b'],
        [
          [1, 0, 'add a', 'h0', [[0, 5, 0]]],
          [2, 0, 'a -> b', 'h1', [[1, 0, 0, 0]]],
          [3, 1, 'new a', 'h2', [[0, 2, 0]]],
          [4, 1, 'edit new a', 'h3', [[0, 1, 0]]],
          [5, 0, 'delete b', 'h4', [[1, 0, 5, -1]]],
          [6, 1, 'recreate b', 'h5', [[1, 4, 0]]],
        ],
      ),
    );
    r.seek(4);
    expect(r.historyOf(1)).toEqual([0, 1, 4]);
    expect(Object.fromEntries(r.authorsOf(1))).toEqual({ 0: 3 });
    expect(r.historyOf(0)).toEqual([2, 3]);
    r.seek(5);
    expect(r.historyOf(1)).toEqual([5]);
    expect(r.historyOf(1, 3)).toEqual([0, 1]);
  });

  it('random seeks with snapshots match a linear replay', () => {
    const demo = generateDemoHistory({ commits: 400, seed: 7 });
    const linear = new Replayer(demo, { snapshotInterval: 1_000_000 });
    const expected: { lines: number[]; exists: number[]; author: number[]; touched: number[] }[] = [];
    for (let i = -1; i < demo.commits.length; i++) {
      linear.seek(i);
      expected.push({
        lines: Array.from(linear.lines),
        exists: Array.from(linear.exists),
        author: Array.from(linear.lastAuthor),
        touched: Array.from(linear.lastTouched),
      });
    }
    const fast = new Replayer(demo, { snapshotInterval: 17 });
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 150; k++) {
      const target = Math.floor(rand() * (demo.commits.length + 1)) - 1;
      fast.seek(target);
      const e = expected[target + 1];
      expect(Array.from(fast.lines)).toEqual(e.lines);
      expect(Array.from(fast.exists)).toEqual(e.exists);
      expect(Array.from(fast.lastAuthor)).toEqual(e.author);
      expect(Array.from(fast.lastTouched)).toEqual(e.touched);
    }
  });

  it('handles an empty history', () => {
    const r = new Replayer(hist([], []));
    r.seek(10);
    expect(r.index).toBe(-1);
    expect(r.totals()).toEqual({ files: 0, lines: 0 });
  });
});

describe('demo history', () => {
  it('is deterministic and never produces negative line counts', () => {
    const a = generateDemoHistory({ commits: 300 });
    const b = generateDemoHistory({ commits: 300 });
    expect(a).toEqual(b);
    const r = new Replayer(a);
    for (let i = 0; i < a.commits.length; i++) {
      r.seek(i);
      for (const v of r.lines) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
