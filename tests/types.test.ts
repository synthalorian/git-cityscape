import { describe, expect, it } from 'vitest';
import { generateDemoHistory } from '../src/core/demo';
import { historyError, isHistory, type History } from '../src/core/types';

function valid(): History {
  return {
    version: 1,
    repo: 'r',
    generatedAt: '',
    authors: ['a'],
    files: ['x', 'y'],
    commits: [
      [1, 0, 'add', 'h0', [[0, 3, 0], [1, -1, -1]]],
      [2, 0, 'mv', 'h1', [[1, 0, 0, 0], [0, 0, 3, -1], [1, 4, 0, -2]]],
    ],
  };
}

describe('isHistory', () => {
  it('accepts valid histories, including generated demos', () => {
    expect(historyError(valid())).toBeNull();
    expect(isHistory(generateDemoHistory({ commits: 200 }))).toBe(true);
  });

  it.each<[string, (h: History) => unknown]>([
    ['out-of-range author', (h) => ((h.commits[0][1] = 5), h)],
    ['non-string message', (h) => (((h.commits[0] as unknown[])[2] = 3), h)],
    ['non-finite timestamp', (h) => ((h.commits[0][0] = Number.NaN), h)],
    ['malformed commit tuple', (h) => ((h.commits[0] as unknown[]).pop(), h)],
    ['out-of-range file', (h) => ((h.commits[0][4][0][0] = 9), h)],
    ['out-of-range rename source', (h) => ((h.commits[1][4][0][3] = 7), h)],
    ['malformed change', (h) => ((h.commits[0][4][0] = [0] as never), h)],
    ['negative line count', (h) => ((h.commits[0][4][0][1] = -3), h)],
    ['non-string author', (h) => ((h.authors as unknown[])[0] = 1, h)],
    ['non-string path', (h) => ((h.files as unknown[])[0] = null, h)],
    ['wrong version', (h) => ({ ...h, version: 2 })],
  ])('rejects %s', (_label, mutate) => {
    expect(isHistory(mutate(valid()))).toBe(false);
  });
});
