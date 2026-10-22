import { spawn, type ChildProcess } from 'node:child_process';
import {
  HistoryBuilder,
  LOG_FORMAT,
  LogStreamParser,
  parseZNumstat,
  type NumstatEntry,
  type RawCommit,
} from '../core/parser.js';
import type { History } from '../core/types.js';

export interface GitOptions {
  /** Aborting kills the running git process; the returned promise settles once it has exited. */
  signal?: AbortSignal;
}

export interface ExtractOptions extends GitOptions {
  /** Repository name stored in the output. */
  repo?: string;
  /** Single revision to walk (default HEAD). Ranges are rejected. */
  rev?: string;
  /** Keep only the most recent N commits (a baseline commit restores earlier state). */
  maxCommits?: number;
  onProgress?: (commits: number) => void;
}

function spawnGit(cwd: string, args: string[], signal: AbortSignal | undefined, stdin: 'ignore' | 'pipe' = 'ignore'): ChildProcess {
  return spawn('git', args, { cwd, stdio: [stdin, 'pipe', 'pipe'], signal });
}

/** Settles only after the child has exited, so cancellation never leaves git running. */
function completion(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = '';
    let failure: Error | null = null;
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      failure = e;
      // Spawn failures (e.g. git not installed) have no process to wait for.
      if (child.pid === undefined) reject(e);
    });
    child.on('close', (code, sig) => {
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`git ${what} failed (${code ?? sig}): ${err.trim()}`));
    });
  });
}

export async function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const child = spawnGit(cwd, args, opts.signal);
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => (out += d));
  await completion(child, args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]);
  return out;
}

/** Throws unless `rev` is syntactically a single revision (not a range, negation or option). */
export function assertSingleRevision(rev: string): void {
  if (!rev || rev.startsWith('-') || rev.startsWith('^') || rev.includes('..') || /\^[@!-]/.test(rev)) {
    throw new Error(`--rev expects a single revision, got "${rev}" (ranges are not supported; use --max-commits to limit history)`);
  }
}

async function verifyCommit(repoDir: string, rev: string, opts: GitOptions): Promise<string | null> {
  try {
    const out = (await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], opts)).trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out) ? out : null;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return null;
  }
}

/**
 * Resolve the revision to walk to a commit id. Returns null only for an unborn default branch
 * (a repository without commits); an invalid requested revision is an error.
 */
export async function resolveRevision(repoDir: string, rev: string | undefined, opts: GitOptions = {}): Promise<string | null> {
  if (rev !== undefined) {
    assertSingleRevision(rev);
    const id = await verifyCommit(repoDir, rev, opts);
    if (!id) throw new Error(`Unknown revision or not a commit: ${rev}`);
    return id;
  }
  const head = await verifyCommit(repoDir, 'HEAD', opts);
  if (head) return head;
  let ref = '';
  try {
    ref = (await runGit(repoDir, ['symbolic-ref', '--quiet', 'HEAD'], opts)).trim();
  } catch {
    // detached HEAD that does not resolve
  }
  if (ref) return null;
  throw new Error('HEAD does not point to a commit');
}

export function logArgs(rev: string, maxCommits?: number): string[] {
  const args = [
    '-c',
    'core.quotepath=off',
    'log',
    '--no-color',
    '--no-ext-diff',
    '--no-abbrev',
    '--raw',
    '--numstat',
    '-z',
    '-M',
    '--first-parent',
    '--diff-merges=first-parent',
    `--format=${LOG_FORMAT}`,
  ];
  if (maxCommits && maxCommits > 0) args.push(`--max-count=${Math.floor(maxCommits)}`);
  args.push(rev, '--');
  return args;
}

/** Stream `git log` and collect raw commits (newest first, as git emits them). */
async function streamLog(repoDir: string, rev: string, opts: ExtractOptions): Promise<RawCommit[]> {
  const commits: RawCommit[] = [];
  const parser = new LogStreamParser((c) => {
    commits.push(c);
    if (opts.onProgress && commits.length % 1000 === 0) opts.onProgress(commits.length);
  });
  const child = spawnGit(repoDir, logArgs(rev, opts.maxCommits), opts.signal);
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => parser.push(d));
  await completion(child, 'log');
  parser.end();
  return commits;
}

/** Snapshot of the tree just before `oldest`, expressed as a single synthetic commit. */
async function baselineCommit(repoDir: string, oldest: RawCommit, opts: GitOptions): Promise<RawCommit | null> {
  const parent = await verifyCommit(repoDir, `${oldest.hash}^1`, opts);
  if (!parent) return null;
  const emptyTree = (await runGit(repoDir, ['hash-object', '-t', 'tree', '/dev/null'], opts)).trim();
  const out = await runGit(
    repoDir,
    ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--numstat', '-z', '--no-renames', emptyTree, parent, '--'],
    opts,
  );
  return {
    hash: parent,
    ts: Math.max(0, oldest.ts - 1),
    authorName: '(history before window)',
    authorEmail: '',
    subject: 'Baseline: repository state before the extracted window',
    entries: parseZNumstat(out),
    deleted: [],
  };
}

/** Bytes git inspects when deciding whether content is binary. */
const BINARY_PROBE = 8000;

/**
 * Inspect blobs with `git cat-file --batch`: returns the text line count per blob, or null for
 * binary (or missing) blobs. Content is streamed, so memory does not grow with blob size.
 */
export async function inspectBlobs(repoDir: string, oids: string[], opts: GitOptions = {}): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!oids.length) return result;
  const child = spawnGit(repoDir, ['cat-file', '--batch'], opts.signal, 'pipe');
  let header = Buffer.alloc(0);
  let cur: { oid: string; left: number; seen: number; lines: number; binary: boolean; last: number } | null = null;
  let skipNewline = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    let pos = 0;
    while (pos < chunk.length) {
      if (skipNewline) {
        skipNewline = false;
        pos++;
        continue;
      }
      if (!cur) {
        const nl = chunk.indexOf(10, pos);
        if (nl < 0) {
          header = Buffer.concat([header, chunk.subarray(pos)]);
          return;
        }
        const line = Buffer.concat([header, chunk.subarray(pos, nl)]).toString('utf8');
        header = Buffer.alloc(0);
        pos = nl + 1;
        const [oid, type, size] = line.split(' ');
        if (type === undefined || size === undefined) {
          result.set(oid, null); // "<oid> missing"
          continue;
        }
        cur = { oid, left: Number(size), seen: 0, lines: 0, binary: type !== 'blob', last: 10 };
        if (cur.left === 0) {
          result.set(oid, cur.binary ? null : 0);
          cur = null;
          skipNewline = true;
        }
        continue;
      }
      const take = Math.min(cur.left, chunk.length - pos);
      const part = chunk.subarray(pos, pos + take);
      if (!cur.binary && cur.seen < BINARY_PROBE && part.subarray(0, BINARY_PROBE - cur.seen).includes(0)) cur.binary = true;
      if (!cur.binary) for (let i = 0; i < part.length; i++) if (part[i] === 10) cur.lines++;
      cur.seen += take;
      cur.last = part[part.length - 1];
      cur.left -= take;
      pos += take;
      if (cur.left === 0) {
        result.set(cur.oid, cur.binary ? null : cur.lines + (cur.last === 10 ? 0 : 1));
        cur = null;
        skipNewline = true;
      }
    }
  });
  child.stdin!.on('error', () => {}); // git exiting early surfaces through completion()
  child.stdin!.end(oids.join('\n') + '\n');
  await completion(child, 'cat-file');
  return result;
}

/**
 * Git reports a binary numstat whenever either side of a change is binary, so a binary file that
 * becomes text carries no line counts. For changes whose previous version git also reported as
 * binary, look at the new blob and record its absolute line count when it is text.
 */
async function resolveBinaryTransitions(repoDir: string, commits: RawCommit[], opts: GitOptions): Promise<void> {
  const reportedBinary = new Map<string, boolean>();
  const candidates: { entry: NumstatEntry; blob: string }[] = [];
  for (const c of commits) {
    const deleted = new Set(c.deleted);
    const dst = new Map((c.raw ?? []).map((r) => [r.path, r]));
    for (const e of c.entries) {
      const isBinary = e.added < 0;
      const wasBinary = reportedBinary.get(e.from ?? e.path) ?? false;
      if (e.from !== undefined) reportedBinary.delete(e.from);
      const r = dst.get(e.path);
      if (isBinary && wasBinary && e.from === undefined && r && !deleted.has(e.path) && r.dstMode.startsWith('100')) {
        candidates.push({ entry: e, blob: r.dstBlob });
      }
      reportedBinary.set(e.path, isBinary);
    }
    for (const d of deleted) reportedBinary.delete(d);
  }
  if (!candidates.length) return;
  const info = await inspectBlobs(repoDir, [...new Set(candidates.map((c) => c.blob))], opts);
  for (const { entry, blob } of candidates) {
    const lines = info.get(blob);
    if (lines !== undefined && lines !== null) entry.lines = lines;
  }
}

export async function extractHistory(repoDir: string, opts: ExtractOptions = {}): Promise<History> {
  const builder = new HistoryBuilder({ repo: opts.repo });
  const head = await resolveRevision(repoDir, opts.rev, opts);
  if (!head) return builder.build();
  const commits = await streamLog(repoDir, head, opts);
  commits.reverse();
  // A first-parent walk from a single revision only stops before the root when limited by
  // --max-commits (or in a shallow clone, where the parent is unavailable and no baseline exists).
  const base = commits.length ? await baselineCommit(repoDir, commits[0], opts) : null;
  if (base) {
    commits.unshift(base);
    builder.baseline = true;
  }
  await resolveBinaryTransitions(repoDir, commits, opts);
  for (const c of commits) builder.add(c);
  return builder.build();
}
