/**
 * Incremental replay of a compact history with periodic snapshots for fast random seeking.
 *
 * State after "seeking to commit i" reflects commits 0..i applied (i = -1 means empty).
 */
import { BINARY_LINES, DELETED, REWRITTEN, type History } from './types.js';

interface Snapshot {
  lines: Int32Array;
  exists: Uint8Array;
  binary: Uint8Array;
  lastAuthor: Int32Array;
  lastTouched: Int32Array;
}

export interface ReplayOptions {
  /** Take a snapshot every N commits (default 200). */
  snapshotInterval?: number;
}

export class Replayer {
  readonly history: History;
  readonly nFiles: number;
  readonly nCommits: number;
  readonly snapshotInterval: number;

  /** Current line count per file (binary files get BINARY_LINES). */
  readonly lines: Int32Array;
  /** 1 if the file exists at the current commit. */
  readonly exists: Uint8Array;
  readonly binary: Uint8Array;
  /** Author index of the last commit that touched the file, -1 if never. */
  readonly lastAuthor: Int32Array;
  /** Commit index of the last change to the file, -1 if never. */
  readonly lastTouched: Int32Array;

  /** Maximum line count each file ever reaches (used for stable layout). */
  readonly peakLines: Int32Array;
  /** 1 if the file exists at some point in the history (even if always empty). */
  readonly everExists: Uint8Array;
  /** Commit indices touching each file, ascending. */
  readonly touches: number[][];
  /** For each file, the files it was renamed from and the commit index of each rename. */
  readonly renamedFrom: Map<number, { from: number; at: number }[]> = new Map();
  /**
   * For each file, ascending commit indices at which a new incarnation of the path may begin:
   * `i + 1` after a deletion in commit `i`, `i` when the file was renamed away in commit `i`.
   */
  private readonly incarnations: number[][];

  private applied = 0;
  private readonly snapshots: Snapshot[] = [];

  constructor(history: History, opts: ReplayOptions = {}) {
    this.history = history;
    this.nFiles = history.files.length;
    this.nCommits = history.commits.length;
    this.snapshotInterval = Math.max(1, opts.snapshotInterval ?? 200);
    this.lines = new Int32Array(this.nFiles);
    this.exists = new Uint8Array(this.nFiles);
    this.binary = new Uint8Array(this.nFiles);
    this.lastAuthor = new Int32Array(this.nFiles).fill(-1);
    this.lastTouched = new Int32Array(this.nFiles).fill(-1);
    this.peakLines = new Int32Array(this.nFiles);
    this.everExists = new Uint8Array(this.nFiles);
    this.touches = Array.from({ length: this.nFiles }, () => []);
    this.incarnations = Array.from({ length: this.nFiles }, () => []);

    // Full pass: record snapshots, peaks and per-file touch lists, then rewind.
    for (let i = 0; i < this.nCommits; i++) {
      if (i % this.snapshotInterval === 0) this.snapshots.push(this.capture());
      this.apply(i);
      for (const ch of history.commits[i][4]) {
        const f = ch[0];
        this.touches[f].push(i);
        if (this.exists[f]) this.everExists[f] = 1;
        if (this.lines[f] > this.peakLines[f]) this.peakLines[f] = this.lines[f];
        const from = ch[3];
        if (from === DELETED) this.incarnations[f].push(i + 1);
        if (from !== undefined && from >= 0 && from !== f) {
          this.incarnations[from].push(i);
          const list = this.renamedFrom.get(f);
          if (list) list.push({ from, at: i });
          else this.renamedFrom.set(f, [{ from, at: i }]);
        }
      }
    }
    this.restore(0);
  }

  /** Index of the last applied commit (-1 when nothing is applied). */
  get index(): number {
    return this.applied - 1;
  }

  private capture(): Snapshot {
    return {
      lines: this.lines.slice(),
      exists: this.exists.slice(),
      binary: this.binary.slice(),
      lastAuthor: this.lastAuthor.slice(),
      lastTouched: this.lastTouched.slice(),
    };
  }

  private restore(k: number): void {
    const s = this.snapshots[k];
    if (s) {
      this.lines.set(s.lines);
      this.exists.set(s.exists);
      this.binary.set(s.binary);
      this.lastAuthor.set(s.lastAuthor);
      this.lastTouched.set(s.lastTouched);
    } else {
      this.lines.fill(0);
      this.exists.fill(0);
      this.binary.fill(0);
      this.lastAuthor.fill(-1);
      this.lastTouched.fill(-1);
    }
    this.applied = k * this.snapshotInterval;
  }

  private apply(i: number): void {
    const [, author, , , changes] = this.history.commits[i];
    const { lines, exists, binary, lastAuthor, lastTouched } = this;

    // Rename sources are read from the pre-commit state before any change of this commit is
    // applied, so swaps and "rename a -> b, then create a new a" resolve correctly.
    let sources: Map<number, { lines: number; binary: boolean }> | null = null;
    for (let k = 0; k < changes.length; k++) {
      const from = changes[k][3];
      if (from !== undefined && from >= 0 && from !== changes[k][0]) {
        sources ??= new Map();
        sources.set(k, { lines: lines[from], binary: binary[from] === 1 });
      }
    }
    if (sources) {
      for (const k of sources.keys()) {
        const from = changes[k][3]!;
        lines[from] = 0;
        exists[from] = 0;
        binary[from] = 0;
      }
    }

    for (let k = 0; k < changes.length; k++) {
      const ch = changes[k];
      const f = ch[0];
      const added = ch[1];
      const deleted = ch[2];
      const from = ch[3];
      const isBinary = added < 0 || deleted < 0;

      if (from === DELETED) {
        lines[f] = 0;
        exists[f] = 0;
        binary[f] = 0;
      } else if (from === REWRITTEN) {
        lines[f] = Math.max(0, added);
        binary[f] = 0;
        exists[f] = 1;
      } else {
        const src = sources?.get(k);
        const base = src ? src.lines : exists[f] ? lines[f] : 0;
        const wasBinary = src ? src.binary : binary[f] === 1;
        if (isBinary) {
          binary[f] = 1;
          lines[f] = Math.max(base, BINARY_LINES);
        } else {
          // A file that was binary and now has a numstat is text again.
          binary[f] = 0;
          lines[f] = Math.max(0, (wasBinary ? 0 : base) + added - deleted);
        }
        // Only an explicit deletion removes a file: git keeps tracking emptied files.
        exists[f] = 1;
      }
      lastAuthor[f] = author;
      lastTouched[f] = i;
    }
    this.applied = i + 1;
  }

  /** Move to the state after commit `target` (clamped to [-1, nCommits-1]). */
  seek(target: number): void {
    const t = Math.max(-1, Math.min(this.nCommits - 1, Math.floor(target)));
    const want = t + 1;
    const k = Math.min(Math.floor(want / this.snapshotInterval), this.snapshots.length - 1);
    const snapAt = Math.max(0, k) * this.snapshotInterval;
    if (this.applied > want || this.applied < snapAt) this.restore(Math.max(0, k));
    while (this.applied < want) this.apply(this.applied);
  }

  /**
   * Commit indices that touched `file` up to `upTo` inclusive, restricted to the incarnation of
   * the path that is current at `upTo` and following renames backwards only to the commit at
   * which each rename happened (so later, unrelated occupants of an old path are excluded).
   */
  historyOf(file: number, upTo = this.index): number[] {
    const out = new Set<number>();
    const stack: [file: number, bound: number][] = [[file, upTo]];
    while (stack.length) {
      const [f, bound] = stack.pop()!;
      const t = this.touches[f];
      let hi = t.length - 1;
      while (hi >= 0 && t[hi] > bound) hi--;
      if (hi < 0) continue;
      const last = t[hi];
      let start = 0;
      for (const s of this.incarnations[f]) {
        if (s > last) break;
        start = s;
      }
      for (let j = hi; j >= 0 && t[j] >= start; j--) out.add(t[j]);
      for (const edge of this.renamedFrom.get(f) ?? []) {
        if (edge.at >= start && edge.at <= bound) stack.push([edge.from, edge.at - 1]);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Commit counts per author for a file up to the current commit. */
  authorsOf(file: number, upTo = this.index): Map<number, number> {
    const counts = new Map<number, number>();
    for (const c of this.historyOf(file, upTo)) {
      const a = this.history.commits[c][1];
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return counts;
  }

  /** Total lines and number of existing files at the current commit. */
  totals(): { files: number; lines: number } {
    let files = 0;
    let lines = 0;
    for (let f = 0; f < this.nFiles; f++) {
      if (this.exists[f]) {
        files++;
        if (!this.binary[f]) lines += this.lines[f];
      }
    }
    return { files, lines };
  }
}
