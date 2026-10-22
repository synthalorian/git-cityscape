/**
 * Squarified treemap (Bruls, Huizing, van Wijk) plus a hierarchical directory layout.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(rowSum: number, rowMin: number, rowMax: number, side: number): number {
  const s2 = rowSum * rowSum;
  const side2 = side * side;
  return Math.max((side2 * rowMax) / s2, s2 / (side2 * rowMin));
}

/**
 * Lay out `values` inside `rect`. Returns one rect per input value, in input order. Values
 * <= 0 get an empty rect at the container origin.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const order = values
    .map((_, i) => i)
    .filter((i) => values[i] > 0 && Number.isFinite(values[i]))
    .sort((a, b) => values[b] - values[a] || a - b);
  const total = order.reduce((s, i) => s + values[i], 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

  const scale = (rect.w * rect.h) / total;
  let { x, y, w, h } = rect;
  let row: number[] = [];
  let rowSum = 0;
  let rowMin = Infinity;
  let rowMax = 0;

  const flush = () => {
    if (!row.length) return;
    if (w >= h) {
      // Column on the left.
      const colW = h > 0 ? rowSum / h : 0;
      let cy = y;
      for (const i of row) {
        const ih = colW > 0 ? (values[i] * scale) / colW : 0;
        out[i] = { x, y: cy, w: colW, h: ih };
        cy += ih;
      }
      x += colW;
      w = Math.max(0, w - colW);
    } else {
      // Row on top.
      const rowH = w > 0 ? rowSum / w : 0;
      let cx = x;
      for (const i of row) {
        const iw = rowH > 0 ? (values[i] * scale) / rowH : 0;
        out[i] = { x: cx, y, w: iw, h: rowH };
        cx += iw;
      }
      y += rowH;
      h = Math.max(0, h - rowH);
    }
    row = [];
    rowSum = 0;
    rowMin = Infinity;
    rowMax = 0;
  };

  for (const i of order) {
    const a = values[i] * scale;
    const side = Math.min(w, h);
    if (row.length) {
      const nSum = rowSum + a;
      const before = worst(rowSum, rowMin, rowMax, side);
      const after = worst(nSum, Math.min(rowMin, a), Math.max(rowMax, a), side);
      if (after > before) flush();
    }
    row.push(i);
    rowSum += a;
    rowMin = Math.min(rowMin, a);
    rowMax = Math.max(rowMax, a);
  }
  flush();
  return out;
}

export interface TreeNode {
  name: string;
  path: string;
  /** File index, or -1 for directories. */
  file: number;
  weight: number;
  children: TreeNode[];
}

/** Build a directory tree from paths; files with weight <= 0 are skipped. */
export function buildTree(paths: readonly string[], weights: ArrayLike<number>): TreeNode {
  const root: TreeNode = { name: '', path: '', file: -1, weight: 0, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (let f = 0; f < paths.length; f++) {
    const wgt = weights[f];
    if (!(wgt > 0)) continue;
    const parts = paths[f].split('/');
    let parent = root;
    let acc = '';
    for (let p = 0; p < parts.length - 1; p++) {
      acc = acc ? `${acc}/${parts[p]}` : parts[p];
      let d = dirs.get(acc);
      if (!d) {
        d = { name: parts[p], path: acc, file: -1, weight: 0, children: [] };
        dirs.set(acc, d);
        parent.children.push(d);
      }
      parent = d;
    }
    parent.children.push({ name: parts[parts.length - 1], path: paths[f], file: f, weight: wgt, children: [] });
  }
  const sum = (n: TreeNode): number => {
    if (n.file >= 0) return n.weight;
    n.weight = n.children.reduce((s, c) => s + sum(c), 0);
    return n.weight;
  };
  sum(root);
  // Collapse chains like src/main/java into a single district.
  const collapse = (n: TreeNode): void => {
    while (n !== root && n.children.length === 1 && n.children[0].file < 0) {
      const c = n.children[0];
      n.name = `${n.name}/${c.name}`;
      n.path = c.path;
      n.children = c.children;
    }
    n.children.forEach(collapse);
  };
  collapse(root);
  return root;
}

export interface District extends Rect {
  path: string;
  name: string;
  depth: number;
}

export interface CityLayout {
  width: number;
  height: number;
  /** Per file: x, y, w, h (all zero if the file is not laid out). */
  lots: Float32Array;
  /** Per file: number of enclosing districts. */
  depths: Uint8Array;
  districts: District[];
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Inset applied to each district, as a fraction of its smaller side. */
  padding?: number;
  /** Absolute maximum inset per district. */
  maxPadding?: number;
}

export function layoutCity(paths: readonly string[], weights: ArrayLike<number>, opts: LayoutOptions = {}): CityLayout {
  const width = opts.width ?? 100;
  const height = opts.height ?? 100;
  const padFrac = opts.padding ?? 0.025;
  const maxPad = opts.maxPadding ?? 1.2;
  const lots = new Float32Array(paths.length * 4);
  const depths = new Uint8Array(paths.length);
  const districts: District[] = [];
  const root = buildTree(paths, weights);

  const place = (node: TreeNode, r: Rect, depth: number): void => {
    if (node.file >= 0) {
      lots.set([r.x, r.y, r.w, r.h], node.file * 4);
      depths[node.file] = Math.min(255, depth);
      return;
    }
    let inner = r;
    if (node !== root) {
      districts.push({ ...r, path: node.path, name: node.name, depth });
      const pad = Math.min(maxPad, Math.min(r.w, r.h) * padFrac * 2);
      inner = { x: r.x + pad, y: r.y + pad, w: Math.max(0, r.w - 2 * pad), h: Math.max(0, r.h - 2 * pad) };
    }
    const rects = squarify(node.children.map((c) => c.weight), inner);
    node.children.forEach((c, i) => place(c, rects[i], node === root ? depth : depth + 1));
  };
  place(root, { x: 0, y: 0, w: width, h: height }, 0);
  return { width, height, lots, depths, districts };
}
