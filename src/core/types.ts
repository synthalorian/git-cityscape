/**
 * Compact history format produced by `git-cityscape extract` and consumed by the web app.
 *
 * A change tuple is `[fileIdx, added, deleted]` with an optional 4th element:
 *   - `from >= 0`  : the file was renamed from `files[from]` in this commit
 *   - `from === -1`: the file was deleted in this commit
 *   - `from === -2`: the file's content was replaced by text with exactly `added` lines
 *                    (used when a binary file becomes text, where git reports no line counts)
 * `added === -1 && deleted === -1` marks a binary file (line counts unknown).
 */
export type Change =
  | [file: number, added: number, deleted: number]
  | [file: number, added: number, deleted: number, from: number];

/** `[unixSeconds, authorIdx, subject, shortHash, changes]` */
export type CommitTuple = [ts: number, author: number, msg: string, hash: string, changes: Change[]];

export interface History {
  version: 1;
  repo: string;
  generatedAt: string;
  /** True when the history window does not start at the root commit and commit 0 is a synthetic baseline. */
  baseline?: boolean;
  authors: string[];
  files: string[];
  commits: CommitTuple[];
}

export const DELETED = -1;
export const REWRITTEN = -2;
export const BINARY = -1;
/** Nominal "line count" given to binary files so they still appear as small buildings. */
export const BINARY_LINES = 8;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function changeError(ch: unknown, nFiles: number): string | null {
  if (!Array.isArray(ch) || (ch.length !== 3 && ch.length !== 4)) return 'change is not a 3- or 4-element array';
  const [file, added, deleted, from] = ch as unknown[];
  if (!isInt(file) || file < 0 || file >= nFiles) return `file index ${String(file)} out of range`;
  if (!isInt(added) || !isInt(deleted)) return 'line counts must be integers';
  const binary = added === BINARY && deleted === BINARY;
  if (!binary && (added < 0 || deleted < 0)) return 'line counts must be >= 0 (or both -1 for binary)';
  if (ch.length === 4) {
    if (!isInt(from) || from < REWRITTEN || from >= nFiles) return `rename source ${String(from)} out of range`;
    if (from === REWRITTEN && binary) return 'rewritten file must have a line count';
  }
  return null;
}

/** Describe the first structural problem in `value`, or return null when it is a valid history. */
export function historyError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object';
  const h = value as Partial<History>;
  if (h.version !== 1) return 'unsupported version';
  if (typeof h.repo !== 'string') return 'repo must be a string';
  if (!Array.isArray(h.authors) || !h.authors.every((a) => typeof a === 'string')) return 'authors must be an array of strings';
  if (!Array.isArray(h.files) || !h.files.every((f) => typeof f === 'string')) return 'files must be an array of strings';
  if (!Array.isArray(h.commits)) return 'commits must be an array';
  const nAuthors = h.authors.length;
  const nFiles = h.files.length;
  for (let i = 0; i < h.commits.length; i++) {
    const c = h.commits[i] as unknown;
    const bad = (why: string) => `commit ${i}: ${why}`;
    if (!Array.isArray(c) || c.length !== 5) return bad('not a 5-element array');
    const [ts, author, msg, hash, changes] = c as unknown[];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return bad('timestamp must be a finite number');
    if (!isInt(author) || author < 0 || author >= nAuthors) return bad(`author index ${String(author)} out of range`);
    if (typeof msg !== 'string' || typeof hash !== 'string') return bad('message and hash must be strings');
    if (!Array.isArray(changes)) return bad('changes must be an array');
    for (const ch of changes) {
      const err = changeError(ch, nFiles);
      if (err) return bad(err);
    }
  }
  return null;
}

export function isHistory(value: unknown): value is History {
  return historyError(value) === null;
}
