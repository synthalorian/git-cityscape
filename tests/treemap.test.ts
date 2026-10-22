import { describe, expect, it } from 'vitest';
import { buildTree, layoutCity, squarify, type Rect } from '../src/core/treemap';

// Lots are stored in a Float32Array.
const EPS = 1e-4;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

function inside(r: Rect, c: Rect): boolean {
  return r.x >= c.x - EPS && r.y >= c.y - EPS && r.x + r.w <= c.x + c.w + EPS && r.y + r.h <= c.y + c.h + EPS;
}

describe('squarify', () => {
  const container = { x: 10, y: 20, w: 600, h: 400 };
  const values = [6, 6, 4, 3, 2, 2, 1];

  it('produces areas proportional to values and fills the container', () => {
    const rects = squarify(values, container);
    const total = values.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => expect(r.w * r.h).toBeCloseTo((values[i] / total) * container.w * container.h, 6));
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(container.w * container.h, 6);
  });

  it('keeps rectangles inside the container without overlaps', () => {
    const rects = squarify(values, container);
    for (const r of rects) expect(inside(r, container)).toBe(true);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
  });

  it('returns rects in input order regardless of sorting', () => {
    const rects = squarify([1, 9], { x: 0, y: 0, w: 10, h: 10 });
    expect(rects[0].w * rects[0].h).toBeCloseTo(10);
    expect(rects[1].w * rects[1].h).toBeCloseTo(90);
  });

  it('matches the classic Bruls et al. example', () => {
    // 6x4 rectangle with values 6,6,4,3,2,2,1: first column holds the two 6s.
    const rects = squarify(values, { x: 0, y: 0, w: 6, h: 4 });
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(rects[1]).toEqual({ x: 0, y: 2, w: 3, h: 2 });
  });

  it('keeps aspect ratios reasonable for many items', () => {
    const many = Array.from({ length: 500 }, (_, i) => 1 + ((i * 7919) % 97));
    const rects = squarify(many, { x: 0, y: 0, w: 1000, h: 1000 });
    const ratios = rects.map((r) => Math.max(r.w / r.h, r.h / r.w));
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(avg).toBeLessThan(2.5);
  });

  it('gives empty rects to zero, negative or NaN values', () => {
    const rects = squarify([0, 5, -1, Number.NaN], { x: 1, y: 1, w: 10, h: 10 });
    expect(rects[0].w * rects[0].h).toBe(0);
    expect(rects[2].w * rects[2].h).toBe(0);
    expect(rects[3].w * rects[3].h).toBe(0);
    expect(rects[1]).toEqual({ x: 1, y: 1, w: 10, h: 10 });
  });

  it('handles empty input and degenerate containers', () => {
    expect(squarify([], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 }).every((r) => r.w * r.h === 0)).toBe(true);
  });
});

describe('buildTree', () => {
  it('sums weights and collapses single-directory chains', () => {
    const root = buildTree(['src/main/java/A.java', 'src/main/java/B.java', 'README.md', 'skip.txt'], [3, 2, 1, 0]);
    expect(root.weight).toBe(6);
    const names = root.children.map((c) => c.name).sort();
    expect(names).toEqual(['README.md', 'src/main/java']);
    const dir = root.children.find((c) => c.file < 0)!;
    expect(dir.weight).toBe(5);
    expect(dir.path).toBe('src/main/java');
    expect(dir.children.map((c) => c.file).sort()).toEqual([0, 1]);
  });
});

describe('layoutCity', () => {
  const paths = [
    'README.md',
    'src/index.ts',
    'src/core/a.ts',
    'src/core/b.ts',
    'src/ui/button.tsx',
    'src/ui/theme.css',
    'docs/guide.md',
    'tests/a.test.ts',
    'deleted/never.txt',
  ];
  const weights = [4, 10, 30, 12, 8, 3, 6, 9, 0];
  const layout = layoutCity(paths, weights, { width: 100, height: 100 });
  const lot = (f: number): Rect => ({ x: layout.lots[f * 4], y: layout.lots[f * 4 + 1], w: layout.lots[f * 4 + 2], h: layout.lots[f * 4 + 3] });

  it('places every weighted file inside the city without overlaps', () => {
    const city = { x: 0, y: 0, w: 100, h: 100 };
    const placed = paths.map((_, f) => f).filter((f) => weights[f] > 0);
    for (const f of placed) {
      expect(lot(f).w * lot(f).h).toBeGreaterThan(0);
      expect(inside(lot(f), city)).toBe(true);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(lot(placed[i]), lot(placed[j]))).toBe(false);
    expect(lot(8).w * lot(8).h).toBe(0);
  });

  it('nests files inside their district rectangles', () => {
    const byPath = new Map(layout.districts.map((d) => [d.path, d]));
    expect([...byPath.keys()].sort()).toEqual(['docs', 'src', 'src/core', 'src/ui', 'tests']);
    expect(inside(byPath.get('src/core')!, byPath.get('src')!)).toBe(true);
    expect(inside(lot(2), byPath.get('src/core')!)).toBe(true);
    expect(inside(lot(4), byPath.get('src/ui')!)).toBe(true);
    expect(byPath.get('src')!.depth).toBe(0);
    expect(byPath.get('src/ui')!.depth).toBe(1);
  });

  it('records district depth per file', () => {
    expect(layout.depths[0]).toBe(0); // README.md at root
    expect(layout.depths[1]).toBe(1); // src/index.ts
    expect(layout.depths[2]).toBe(2); // src/core/a.ts
  });

  it('gives bigger files bigger lots within a district', () => {
    expect(lot(2).w * lot(2).h).toBeGreaterThan(lot(3).w * lot(3).h);
  });
});
