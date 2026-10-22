/**
 * Parsers for `git log --raw --numstat -z` output.
 *
 * The extractor runs:
 *   git log --format=%x1e%H%x00%at%x00%aN%x00%aE%x00%s --raw --numstat -z ...
 *
 * With `-z` every field of interest is NUL-terminated, so the output is consumed as a stream of
 * NUL-delimited tokens by a small state machine:
 *   - a commit starts with a token `\x1e<hash>` followed by four header tokens (timestamp, author
 *     name, author email, subject);
 *   - raw entries are `:<srcMode> <dstMode> <srcBlob> <dstBlob> <status>` followed by one path
 *     token (two for renames/copies);
 *   - numstat entries are `added\tdeleted\tpath`, or `added\tdeleted\t` followed by the old and
 *     new path tokens for renames.
 * Path tokens are consumed by position and never inspected for separators, so filenames and
 * subjects may contain any byte except NUL (including the 0x1e marker).
 *
 * A text-mode helper (`parseNumstatLine`) handles the non `-z` `dir/{old => new}/file` syntax.
 */
import { BINARY, DELETED, REWRITTEN, type Change, type History } from './types.js';

export const RECORD_SEP = '\x1e';
export const LOG_FORMAT = '%x1e%H%x00%at%x00%aN%x00%aE%x00%s';
const HEADER_FIELDS = 4;

export interface NumstatEntry {
  /** -1 for binary files */
  added: number;
  /** -1 for binary files */
  deleted: number;
  path: string;
  /** Previous path when the entry is a rename/copy. */
  from?: string;
  /**
   * Absolute text line count of the new content, set by the extractor when git reports a binary
   * numstat but the destination is text (binary-to-text conversion).
   */
  lines?: number;
}

export interface RawEntry {
  /** Status letter (`A`, `M`, `D`, `R`, `C`, `T`, ...), without the similarity score. */
  status: string;
  srcMode: string;
  dstMode: string;
  srcBlob: string;
  dstBlob: string;
  path: string;
  from?: string;
}

export interface RawCommit {
  hash: string;
  ts: number;
  authorName: string;
  authorEmail: string;
  subject: string;
  entries: NumstatEntry[];
  /** Paths reported as deleted (raw status `D`). */
  deleted: string[];
  /** Raw diff entries (absent for synthetic commits). */
  raw?: RawEntry[];
}

function parseCount(s: string): number {
  if (s === '-') return BINARY;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Undo git's C-style path quoting (`"a\tb"`), used when core.quotePath applies (text mode only). */
export function unquotePath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = body[++i];
    if (n >= '0' && n <= '7') {
      const oct = body.slice(i, i + 3);
      bytes.push(Number.parseInt(oct, 8));
      i += 2;
      continue;
    }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
    bytes.push(...enc.encode(map[n] ?? n));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function normalizeJoined(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Expand git's rename notation into `{ from, to }`.
 *   `src/{a => b}/x.ts`  -> src/a/x.ts, src/b/x.ts
 *   `{ => lib}/x.ts`     -> x.ts, lib/x.ts
 *   `old.txt => new.txt` -> old.txt, new.txt
 * Returns null if the path is not a rename.
 */
export function expandRenamePath(path: string): { from: string; to: string } | null {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/s.exec(path);
  if (brace) {
    const [, pre, a, b, post] = brace;
    return { from: normalizeJoined(pre + a + post), to: normalizeJoined(pre + b + post) };
  }
  const idx = path.indexOf(' => ');
  if (idx >= 0 && path.indexOf(' => ', idx + 1) < 0) {
    return { from: unquotePath(path.slice(0, idx)), to: unquotePath(path.slice(idx + 4)) };
  }
  return null;
}

/** Parse a single text-mode numstat line (`added\tdeleted\tpath`). */
export function parseNumstatLine(line: string): NumstatEntry | null {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(line);
  if (!m) return null;
  const added = parseCount(m[1]);
  const deleted = parseCount(m[2]);
  const rename = expandRenamePath(m[3]);
  if (rename) return { added, deleted, path: rename.to, from: rename.from };
  return { added, deleted, path: unquotePath(m[3]) };
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;
const RAW_RE = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/;

type Pending =
  | { kind: 'numstat'; added: number; deleted: number; paths: string[] }
  | { kind: 'raw'; entry: Omit<RawEntry, 'path' | 'from'>; need: number; paths: string[] };

/**
 * Incremental parser: feed it stdout chunks as they arrive. Memory stays bounded by the size
 * of a single commit record.
 */
export class LogStreamParser {
  private buf = '';
  private current: RawCommit | null = null;
  /** Header tokens still expected for `current`. */
  private headerLeft = 0;
  private header: string[] = [];
  private pending: Pending | null = null;

  constructor(private readonly onCommit: (c: RawCommit) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let start = 0;
    let nul = this.buf.indexOf('\0', start);
    while (nul >= 0) {
      this.token(this.buf.slice(start, nul));
      start = nul + 1;
      nul = this.buf.indexOf('\0', start);
    }
    this.buf = this.buf.slice(start);
  }

  end(): void {
    if (this.buf) this.token(this.buf);
    this.buf = '';
    this.flush();
  }

  private flush(): void {
    const c = this.current;
    this.current = null;
    this.pending = null;
    this.headerLeft = 0;
    if (c) this.onCommit(c);
  }

  private token(tok: string): void {
    const c = this.current;
    if (c && this.headerLeft > 0) {
      this.header.push(tok);
      if (--this.headerLeft === 0) {
        const [ts, name, email, subject] = this.header;
        c.ts = Number.parseInt(ts, 10) || 0;
        c.authorName = name;
        c.authorEmail = email;
        c.subject = subject;
      }
      return;
    }
    const p = this.pending;
    if (c && p) {
      p.paths.push(tok);
      if (p.kind === 'numstat' && p.paths.length === 2) {
        c.entries.push({ added: p.added, deleted: p.deleted, from: p.paths[0], path: p.paths[1] });
        this.pending = null;
      } else if (p.kind === 'raw' && p.paths.length === p.need) {
        const entry: RawEntry = { ...p.entry, path: p.paths[p.need - 1] };
        if (p.need === 2) entry.from = p.paths[0];
        c.raw!.push(entry);
        if (entry.status === 'D') c.deleted.push(entry.path);
        this.pending = null;
      }
      return;
    }
    const t = tok.replace(/^\n+/, '');
    if (t.startsWith(RECORD_SEP)) {
      this.flush();
      this.current = { hash: t.slice(1).trim(), ts: 0, authorName: '', authorEmail: '', subject: '', entries: [], deleted: [], raw: [] };
      this.header = [];
      this.headerLeft = HEADER_FIELDS;
      return;
    }
    if (!c) return;
    const raw = RAW_RE.exec(t);
    if (raw) {
      const status = raw[5];
      const entry = { srcMode: raw[1], dstMode: raw[2], srcBlob: raw[3], dstBlob: raw[4], status };
      this.pending = { kind: 'raw', entry, need: status === 'R' || status === 'C' ? 2 : 1, paths: [] };
      return;
    }
    const m = NUMSTAT_RE.exec(t);
    if (!m) return;
    const added = parseCount(m[1]);
    const deleted = parseCount(m[2]);
    // An empty path means a rename/copy: the next two tokens are the old and new paths.
    if (m[3] === '') this.pending = { kind: 'numstat', added, deleted, paths: [] };
    else c.entries.push({ added, deleted, path: m[3] });
  }
}

/** Parse a complete `git log --raw --numstat -z` output string in one go. */
export function parseLog(output: string): RawCommit[] {
  const out: RawCommit[] = [];
  const p = new LogStreamParser((c) => out.push(c));
  p.push(output);
  p.end();
  return out;
}

/** Parse NUL-delimited numstat output (`git diff --numstat -z`). */
export function parseZNumstat(body: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const tokens = body.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = NUMSTAT_RE.exec(tokens[i].replace(/^\n+/, ''));
    if (!m) continue;
    const added = parseCount(m[1]);
    const deleted = parseCount(m[2]);
    if (m[3] === '') {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 2;
      if (from !== undefined && to !== undefined) entries.push({ added, deleted, path: to, from });
    } else {
      entries.push({ added, deleted, path: m[3] });
    }
  }
  return entries;
}

export interface BuilderOptions {
  repo?: string;
  /** Maximum subject length kept in the output. */
  maxMessage?: number;
  /** Length of abbreviated hashes. */
  hashLength?: number;
}

/**
 * Interns authors and paths and converts raw commits (oldest first) into the compact format.
 */
export class HistoryBuilder {
  private readonly authorIdx = new Map<string, number>();
  private readonly fileIdx = new Map<string, number>();
  readonly authors: string[] = [];
  readonly files: string[] = [];
  readonly commits: History['commits'] = [];
  baseline = false;

  constructor(private readonly opts: BuilderOptions = {}) {}

  private author(name: string, email: string): number {
    const key = (email || name).trim().toLowerCase();
    let idx = this.authorIdx.get(key);
    if (idx === undefined) {
      idx = this.authors.length;
      this.authors.push(name.trim() || email.trim() || 'unknown');
      this.authorIdx.set(key, idx);
    }
    return idx;
  }

  file(path: string): number {
    let idx = this.fileIdx.get(path);
    if (idx === undefined) {
      idx = this.files.length;
      this.files.push(path);
      this.fileIdx.set(path, idx);
    }
    return idx;
  }

  add(c: RawCommit): void {
    const deleted = new Set(c.deleted);
    const changes: Change[] = [];
    for (const e of c.entries) {
      const idx = this.file(e.path);
      if (e.from !== undefined && e.from !== e.path) {
        changes.push([idx, e.added, e.deleted, this.file(e.from)]);
      } else if (deleted.has(e.path)) {
        changes.push([idx, e.added, e.deleted, DELETED]);
      } else if (e.lines !== undefined) {
        changes.push([idx, e.lines, 0, REWRITTEN]);
      } else {
        changes.push([idx, e.added, e.deleted]);
      }
    }
    const maxMsg = this.opts.maxMessage ?? 200;
    const subject = c.subject.length > maxMsg ? `${c.subject.slice(0, maxMsg - 1)}…` : c.subject;
    this.commits.push([c.ts, this.author(c.authorName, c.authorEmail), subject, c.hash.slice(0, this.opts.hashLength ?? 10), changes]);
  }

  build(): History {
    return {
      version: 1,
      repo: this.opts.repo ?? 'repository',
      generatedAt: new Date().toISOString(),
      ...(this.baseline ? { baseline: true } : {}),
      authors: this.authors,
      files: this.files,
      commits: this.commits,
    };
  }
}
