import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertSingleRevision, runGit } from './extract.js';

export function isRemoteSpec(spec: string): boolean {
  if (existsSync(spec)) return false;
  return /^(https?|git|ssh|file):\/\//i.test(spec) || /^[\w.-]+@[\w.-]+:/.test(spec);
}

export function repoNameFromSpec(spec: string): string {
  const cleaned = spec.replace(/[#?].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return cleaned.split(/[/:\\]/).pop() || 'repository';
}

export interface OpenRepoOptions {
  /** Use a blobless partial clone (git fetches blobs lazily while diffing; slower for large histories). */
  blobless?: boolean;
  quiet?: boolean;
  /**
   * Revision that will be extracted. When set, remote clones fetch all branches and tags (and the
   * revision itself if still missing) instead of only the default branch.
   */
  rev?: string;
}

/**
 * Run `fn` with a local git directory for `spec`. Remote URLs are bare-cloned into a temp
 * directory that is removed afterwards. On SIGINT/SIGTERM the abort signal passed to `fn` (and
 * used for cloning) is triggered; running git processes are terminated and awaited before the
 * temp directory is removed and the process exits with status 130.
 */
export async function withRepo<T>(
  spec: string,
  opts: OpenRepoOptions,
  fn: (dir: string, name: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (opts.rev !== undefined) assertSingleRevision(opts.rev);
  const controller = new AbortController();
  const { signal } = controller;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let tmp: string | null = null;
  try {
    if (!isRemoteSpec(spec)) {
      const dir = resolve(spec);
      if (!existsSync(dir)) throw new Error(`Path not found: ${spec}`);
      try {
        await runGit(dir, ['rev-parse', '--git-dir'], { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new Error(`Not a git repository: ${spec}`);
      }
      let name = basename(dir);
      try {
        const top = (await runGit(dir, ['rev-parse', '--show-toplevel'], { signal })).trim();
        if (top) name = basename(top);
      } catch (err) {
        if (signal.aborted) throw err;
        // bare repository: keep directory name
        name = name.replace(/\.git$/, '');
      }
      return await fn(dir, name, signal);
    }

    tmp = await mkdtemp(join(tmpdir(), 'git-cityscape-'));
    const target = join(tmp, 'repo.git');
    const args = ['clone', '--bare', '--quiet'];
    // Without an explicit revision only the default branch is needed.
    if (opts.rev === undefined) args.push('--single-branch', '--no-tags');
    if (opts.blobless) args.push('--filter=blob:none');
    args.push('--', spec, target);
    if (!opts.quiet) process.stderr.write(`Cloning ${spec}${opts.blobless ? ' (blobless)' : ''}...\n`);
    await runGit(tmp, args, { signal });
    if (opts.rev !== undefined) {
      await runGit(target, ['fetch', '--quiet', '--tags', 'origin'], { signal });
      try {
        await runGit(target, ['rev-parse', '--verify', '--quiet', `${opts.rev}^{commit}`], { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        // Not reachable from branches or tags (e.g. a commit id or a ref like refs/pull/1/head).
        await runGit(target, ['fetch', '--quiet', 'origin', opts.rev], { signal }).catch((e: unknown) => {
          if (signal.aborted) throw e;
        });
      }
    }
    return await fn(target, repoNameFromSpec(spec), signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (tmp) await rm(tmp, { recursive: true, force: true });
    if (interrupted) process.exit(130);
  }
}
