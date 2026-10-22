import { Replayer } from '../../src/core/replay';
import { layoutCity, type CityLayout } from '../../src/core/treemap';
import type { History } from '../../src/core/types';

export type ColorMode = 'ext' | 'author';
export type HeightMode = 'linear' | 'sqrt' | 'log';

export const NEON = [
  '#ff2a6d', '#05d9e8', '#d300c5', '#ff9e00', '#01ffc3', '#7b61ff', '#f9f871', '#ff6ec7',
  '#00b3ff', '#b967ff', '#ff7b54', '#3dfc8c', '#e0aaff', '#ffd23f', '#4cc9f0', '#f72585',
];
const OTHER = '#8a7fb8';

export const CITY_SIZE = 100;
// Keep even the largest file in proportion to the city's footprint.
export const MAX_HEIGHT = CITY_SIZE * 0.25;
export const MIN_HEIGHT = 0.25;

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const SPECIAL_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'gemfile', 'rakefile', 'procfile']);

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return SPECIAL_NAMES.has(base.toLowerCase()) ? base.toLowerCase() : '(none)';
  return base.slice(dot + 1).toLowerCase();
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface LegendEntry {
  label: string;
  color: string;
  count: number;
  key: number | string;
}

/**
 * Shared state for both views: replay engine, stable layout and color tables.
 */
export class CityModel {
  readonly replayer: Replayer;
  readonly layout: CityLayout;
  readonly exts: string[];
  readonly extColors = new Map<string, string>();
  readonly extLegend: LegendEntry[];
  readonly authorColors: string[];
  readonly authorLegend: LegendEntry[];
  readonly maxPeak: number;
  /** Files that have a lot in the layout. */
  readonly placed: number[];

  colorMode: ColorMode = 'ext';
  heightMode: HeightMode = 'sqrt';
  /** Commits over which the "recently changed" glow decays. */
  glowDecay = 6;
  selected = -1;
  /** Bumped whenever the replay index or display options change. */
  version = 0;

  private readonly rgbExt: Float32Array;
  private readonly rgbAuthor: Float32Array;

  constructor(readonly history: History) {
    const t0 = performance.now();
    this.replayer = new Replayer(history, { snapshotInterval: Math.max(50, Math.min(500, Math.ceil(history.commits.length / 60))) });
    const peaks = this.replayer.peakLines;
    let maxPeak = 1;
    for (let f = 0; f < peaks.length; f++) if (peaks[f] > maxPeak) maxPeak = peaks[f];
    this.maxPeak = maxPeak;
    // Lots are sized by sqrt(peak lines) so the layout stays stable while history plays. Files
    // that exist but are always empty (e.g. .gitkeep) get the lot of a one-line file.
    const ever = this.replayer.everExists;
    const weights = Float32Array.from(peaks, (p, f) => (p > 0 ? Math.sqrt(p) : ever[f] ? 1 : 0));
    this.layout = layoutCity(history.files, weights, { width: CITY_SIZE, height: CITY_SIZE });
    this.placed = [];
    for (let f = 0; f < history.files.length; f++) if (weights[f] > 0) this.placed.push(f);

    // Extensions ranked by number of files.
    this.exts = history.files.map(extOf);
    const extCount = new Map<string, number>();
    for (const f of this.placed) extCount.set(this.exts[f], (extCount.get(this.exts[f]) ?? 0) + 1);
    const rankedExt = [...extCount.entries()].sort((a, b) => b[1] - a[1]);
    rankedExt.forEach(([ext], i) => this.extColors.set(ext, i < NEON.length ? NEON[i] : NEON[hashString(ext) % NEON.length]));
    this.extLegend = rankedExt.map(([ext, count]) => ({ label: `.${ext}`, color: this.extColors.get(ext)!, count, key: ext }));

    // Authors ranked by commit count.
    const commitsBy = new Array<number>(history.authors.length).fill(0);
    for (const c of history.commits) commitsBy[c[1]]++;
    const rankedAuthors = commitsBy.map((n, i) => [i, n]).sort((a, b) => b[1] - a[1]);
    this.authorColors = new Array<string>(history.authors.length).fill(OTHER);
    rankedAuthors.forEach(([a], rank) => (this.authorColors[a] = rank < NEON.length ? NEON[rank] : OTHER));
    this.authorLegend = rankedAuthors.map(([a, n]) => ({ label: history.authors[a], color: this.authorColors[a], count: n, key: a }));

    this.rgbExt = new Float32Array(history.files.length * 3);
    history.files.forEach((_, f) => this.rgbExt.set(hexToRgb(this.extColors.get(this.exts[f]) ?? OTHER), f * 3));
    this.rgbAuthor = new Float32Array(history.authors.length * 3 + 3);
    this.authorColors.forEach((c, a) => this.rgbAuthor.set(hexToRgb(c), a * 3));
    this.rgbAuthor.set(hexToRgb(OTHER), history.authors.length * 3);

    console.info(`[cityscape] model built in ${(performance.now() - t0).toFixed(0)} ms (${history.commits.length} commits, ${history.files.length} files)`);
  }

  get index(): number {
    return this.replayer.index;
  }

  seek(i: number): void {
    const before = this.replayer.index;
    this.replayer.seek(i);
    if (this.replayer.index !== before) this.version++;
  }

  setColorMode(m: ColorMode): void {
    this.colorMode = m;
    this.version++;
  }

  setHeightMode(m: HeightMode): void {
    this.heightMode = m;
    this.version++;
  }

  /** Building height for a line count (existing empty files keep the minimum height). */
  height(lines: number): number {
    if (lines <= 0) return MIN_HEIGHT;
    const r =
      this.heightMode === 'linear'
        ? lines / this.maxPeak
        : this.heightMode === 'sqrt'
          ? Math.sqrt(lines / this.maxPeak)
          : Math.log1p(lines) / Math.log1p(this.maxPeak);
    return MIN_HEIGHT + Math.min(1, Math.max(0, r)) * (MAX_HEIGHT - MIN_HEIGHT);
  }

  /** Writes the RGB color of `file` into `out` at `offset`. */
  color(file: number, out: Float32Array | number[], offset: number): void {
    let src: Float32Array;
    let o: number;
    if (this.colorMode === 'ext') {
      src = this.rgbExt;
      o = file * 3;
    } else {
      src = this.rgbAuthor;
      const a = this.replayer.lastAuthor[file];
      o = (a >= 0 ? a : this.history.authors.length) * 3;
    }
    out[offset] = src[o];
    out[offset + 1] = src[o + 1];
    out[offset + 2] = src[o + 2];
  }

  /** Panel order is chronological even when merge/replay order is not. */
  recentCommits(file: number, limit = 12): number[] {
    return [...this.replayer.historyOf(file)]
      .sort((a, b) => this.history.commits[b][0] - this.history.commits[a][0] || b - a)
      .slice(0, limit);
  }

  /** Recency glow in [0, 1]: 1 for files changed in the current commit. */
  recency(file: number): number {
    const t = this.replayer.lastTouched[file];
    if (t < 0 || !this.replayer.exists[file]) return 0;
    const age = this.replayer.index - t;
    if (age < 0) return 0;
    return Math.exp(-age / Math.max(1, this.glowDecay));
  }

  fileAt(x: number, y: number): number {
    const lots = this.layout.lots;
    for (const f of this.placed) {
      if (!this.replayer.exists[f]) continue;
      const o = f * 4;
      if (x >= lots[o] && y >= lots[o + 1] && x <= lots[o] + lots[o + 2] && y <= lots[o + 1] + lots[o + 3]) return f;
    }
    return -1;
  }
}
