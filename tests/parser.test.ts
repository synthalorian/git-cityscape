import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractHistory, runGit } from '../src/cli/extract';
import { withRepo } from '../src/cli/repo';
import { pathToFileURL } from 'node:url';
import {
  expandRenamePath,
  HistoryBuilder,
  LogStreamParser,
  parseLog,
  parseNumstatLine,
  parseZNumstat,
  unquotePath,
  type RawCommit,
} from '../src/core/parser';
import { Replayer } from '../src/core/replay';

const RS = '\x1e';
const US = '\x1f';

function header(hash: string, ts: number, name: string, email: string, subject: string): string {
  return `${RS}${hash}\0${ts}\0${name}\0${email}\0${subject}`;
}

describe('parseNumstatLine (text mode)', () => {
  it('parses a plain entry', () => {
    expect(parseNumstatLine('12\t3\tsrc/app.ts')).toEqual({ added: 12, deleted: 3, path: 'src/app.ts' });
  });

  it('marks binary files with -1', () => {
    expect(parseNumstatLine('-\t-\tassets/logo.png')).toEqual({ added: -1, deleted: -1, path: 'assets/logo.png' });
  });

  it('expands {old => new} renames inside a directory', () => {
    expect(parseNumstatLine('1\t2\tsrc/{core => lib}/util.ts')).toEqual({
      added: 1,
      deleted: 2,
      path: 'src/lib/util.ts',
      from: 'src/core/util.ts',
    });
  });

  it('expands renames with an empty side', () => {
    expect(expandRenamePath('{ => packages/web}/index.ts')).toEqual({ from: 'index.ts', to: 'packages/web/index.ts' });
    expect(expandRenamePath('src/{old => }/x.ts')).toEqual({ from: 'src/old/x.ts', to: 'src/x.ts' });
  });

  it('expands file-name renames', () => {
    expect(expandRenamePath('docs/{a.md => b.md}')).toEqual({ from: 'docs/a.md', to: 'docs/b.md' });
    expect(parseNumstatLine('0\t0\told.txt => new.txt')).toEqual({ added: 0, deleted: 0, path: 'new.txt', from: 'old.txt' });
  });

  it('returns null for non-numstat lines', () => {
    expect(parseNumstatLine(' create mode 100644 a.txt')).toBeNull();
    expect(parseNumstatLine('')).toBeNull();
    expect(expandRenamePath('plain/path.ts')).toBeNull();
  });

  it('unquotes C-style quoted paths', () => {
    expect(unquotePath('"tab\\there.txt"')).toBe('tab\there.txt');
    expect(unquotePath('"caf\\303\\251.md"')).toBe('café.md');
    expect(unquotePath('normal.txt')).toBe('normal.txt');
  });
});

const Z40 = '0'.repeat(40);
const B1 = '1'.repeat(40);
const B2 = '2'.repeat(40);

describe('-z log stream parsing', () => {
  const record =
    header('a'.repeat(40), 1700000000, 'Ada', 'ada@x.io', 'Rename & delete') +
    `\0\n:100644 000000 ${B1} ${Z40} D\0img.png\0` +
    `:100644 100644 ${B1} ${B1} R100\0src/a/x.ts\0src/a/y.ts\0` +
    `:100644 100644 ${B1} ${B2} M\0README.md\0` +
    '-\t-\timg.png\0' +
    '0\t0\t\0src/a/x.ts\0src/a/y.ts\0' +
    '5\t1\tREADME.md\0';

  it('parses header, raw entries, renames, binary and deletions', () => {
    const [c] = parseLog(record);
    expect(c.hash).toBe('a'.repeat(40));
    expect(c.ts).toBe(1700000000);
    expect(c.authorName).toBe('Ada');
    expect(c.authorEmail).toBe('ada@x.io');
    expect(c.subject).toBe('Rename & delete');
    expect(c.entries).toEqual([
      { added: -1, deleted: -1, path: 'img.png' },
      { added: 0, deleted: 0, path: 'src/a/y.ts', from: 'src/a/x.ts' },
      { added: 5, deleted: 1, path: 'README.md' },
    ]);
    expect(c.deleted).toEqual(['img.png']);
    expect(c.raw).toEqual([
      { status: 'D', srcMode: '100644', dstMode: '000000', srcBlob: B1, dstBlob: Z40, path: 'img.png' },
      { status: 'R', srcMode: '100644', dstMode: '100644', srcBlob: B1, dstBlob: B1, path: 'src/a/y.ts', from: 'src/a/x.ts' },
      { status: 'M', srcMode: '100644', dstMode: '100644', srcBlob: B1, dstBlob: B2, path: 'README.md' },
    ]);
  });

  it('keeps paths containing spaces, arrows and braces literally', () => {
    const r = header('b'.repeat(40), 1, 'B', 'b@x', 'odd') + '\0\n3\t0\tweird {a => b} name.txt\0';
    const [c] = parseLog(r);
    expect(c.entries).toEqual([{ added: 3, deleted: 0, path: 'weird {a => b} name.txt' }]);
  });

  it('does not treat record or unit separators in paths and subjects as framing', () => {
    const odd = `before${RS}${'c'.repeat(40)}after`;
    const r =
      header('b'.repeat(40), 1, `Na${US}me`, 'b@x', `sub${RS}ject${US}x`) +
      `\0\n:000000 100644 ${Z40} ${B1} A\0${odd}\0` +
      `:100644 100644 ${B1} ${B2} R090\0${RS}old\0new${RS}\0` +
      `3\t0\t${odd}\0` +
      `1\t1\t\0${RS}old\0new${RS}\0` +
      header('d'.repeat(40), 2, 'D', 'd@x', 'next') +
      '\0\n2\t0\tf\0';
    const commits = parseLog(r);
    expect(commits).toHaveLength(2);
    expect(commits[0].authorName).toBe(`Na${US}me`);
    expect(commits[0].subject).toBe(`sub${RS}ject${US}x`);
    expect(commits[0].entries).toEqual([
      { added: 3, deleted: 0, path: odd },
      { added: 1, deleted: 1, path: `new${RS}`, from: `${RS}old` },
    ]);
    expect(commits[0].raw!.map((e) => e.path)).toEqual([odd, `new${RS}`]);
    expect(commits[1].entries).toEqual([{ added: 2, deleted: 0, path: 'f' }]);
  });

  it('handles commits without file changes', () => {
    const r = header('c'.repeat(40), 2, 'C', 'c@x', 'empty') + '\0' + header('d'.repeat(40), 3, 'D', 'd@x', 'next') + '\0\n1\t0\tf\0';
    const commits = parseLog(r);
    expect(commits).toHaveLength(2);
    expect(commits[0].entries).toEqual([]);
    expect(commits[1].entries).toHaveLength(1);
  });

  it('produces identical results regardless of chunk boundaries', () => {
    const text = record + record.replace('a'.repeat(40), 'e'.repeat(40));
    const whole = parseLog(text);
    const chunked: RawCommit[] = [];
    const p = new LogStreamParser((c) => chunked.push(c));
    for (const ch of text) p.push(ch);
    p.end();
    expect(chunked).toEqual(whole);
    expect(whole).toHaveLength(2);
  });
});

describe('parseZNumstat', () => {
  it('parses plain, binary and rename entries', () => {
    expect(parseZNumstat('1\t2\ta\0-\t-\tb.png\0' + '0\t0\t\0old\0new\0')).toEqual([
      { added: 1, deleted: 2, path: 'a' },
      { added: -1, deleted: -1, path: 'b.png' },
      { added: 0, deleted: 0, path: 'new', from: 'old' },
    ]);
  });
});

describe('HistoryBuilder', () => {
  it('interns authors by email and encodes renames and deletions', () => {
    const b = new HistoryBuilder({ repo: 'demo' });
    b.add({ hash: '1'.repeat(40), ts: 1, authorName: 'Ann', authorEmail: 'ANN@x.io', subject: 'init', deleted: [], entries: [{ added: 10, deleted: 0, path: 'a.ts' }] });
    b.add({
      hash: '2'.repeat(40),
      ts: 2,
      authorName: 'Ann B.',
      authorEmail: 'ann@x.io',
      subject: 'mv',
      deleted: ['gone.bin'],
      entries: [
        { added: 1, deleted: 0, path: 'b.ts', from: 'a.ts' },
        { added: -1, deleted: -1, path: 'gone.bin' },
      ],
    });
    const h = b.build();
    expect(h.authors).toEqual(['Ann']);
    expect(h.files).toEqual(['a.ts', 'b.ts', 'gone.bin']);
    expect(h.commits[0]).toEqual([1, 0, 'init', '1111111111', [[0, 10, 0]]]);
    expect(h.commits[1][4]).toEqual([
      [1, 1, 0, 0],
      [2, -1, -1, -1],
    ]);
  });
});

describe('extractHistory against a real repository', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' },
    }).toString();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cityscape-test-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tess Ter');
    git('config', 'user.email', 'tess@example.com');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'src/core'), { recursive: true });
    writeFileSync(join(dir, 'src/core/util.ts'), 'a\nb\nc\nd\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    mkdirSync(join(dir, 'src/lib'));
    git('mv', 'src/core/util.ts', 'src/lib/util.ts');
    appendFileSync(join(dir, 'src/lib/util.ts'), 'e\n');
    git('rm', '-q', 'logo.png');
    git('add', '-A');
    git('commit', '-qm', 'move util, drop logo');
    git('checkout', '-qb', 'feature');
    appendFileSync(join(dir, 'README.md'), 'feature\nmore\n');
    git('commit', '-qam', 'feature work');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'main.txt'), 'x\n');
    git('add', 'main.txt');
    git('commit', '-qm', 'main work');
    git('merge', '-q', '--no-ff', '--no-edit', 'feature');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts first-parent history with renames, binary deletes and merge diffs', async () => {
    const h = await extractHistory(dir, { repo: 'fixture' });
    expect(h.repo).toBe('fixture');
    expect(h.authors).toEqual(['Tess Ter']);
    expect(h.commits.map((c) => c[2])).toEqual(['init', 'move util, drop logo', 'main work', "Merge branch 'feature'"]);
    const idx = (p: string) => h.files.indexOf(p);
    expect(h.commits[1][4]).toEqual(
      expect.arrayContaining([
        [idx('src/lib/util.ts'), 1, 0, idx('src/core/util.ts')],
        [idx('logo.png'), -1, -1, -1],
      ]),
    );
    // The merge commit carries the first-parent diff (feature branch changes).
    expect(h.commits[3][4]).toEqual([[idx('README.md'), 2, 0]]);

    const r = new Replayer(h);
    r.seek(h.commits.length - 1);
    expect(r.lines[idx('src/lib/util.ts')]).toBe(5);
    expect(r.exists[idx('src/core/util.ts')]).toBe(0);
    expect(r.exists[idx('logo.png')]).toBe(0);
    expect(r.lines[idx('README.md')]).toBe(3);
    expect(r.totals()).toEqual({ files: 3, lines: 9 });
  });

  it('adds a baseline commit when limiting the window', async () => {
    const h = await extractHistory(dir, { maxCommits: 2 });
    expect(h.baseline).toBe(true);
    expect(h.commits).toHaveLength(3);
    const r = new Replayer(h);
    r.seek(h.commits.length - 1);
    expect(r.lines[h.files.indexOf('src/lib/util.ts')]).toBe(5);
    expect(r.lines[h.files.indexOf('README.md')]).toBe(3);
  });

  it('walks a requested branch and rejects invalid revisions and ranges', async () => {
    const h = await extractHistory(dir, { rev: 'feature' });
    expect(h.commits.map((c) => c[2])).toEqual(['init', 'move util, drop logo', 'feature work']);
    await expect(extractHistory(dir, { rev: 'no-such-branch' })).rejects.toThrow(/Unknown revision/);
    await expect(extractHistory(dir, { rev: 'HEAD~2..HEAD' })).rejects.toThrow(/single revision/);
    await expect(extractHistory(dir, { rev: '^HEAD' })).rejects.toThrow(/single revision/);
    await expect(extractHistory(dir, { rev: '--output=/tmp/x' })).rejects.toThrow(/single revision/);
  });
});

describe('extractHistory edge cases', () => {
  const dirs: string[] = [];
  const env = { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' };
  function repo(): { dir: string; git: (...args: string[]) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'cityscape-edge-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tess Ter');
    git('config', 'user.email', 'tess@example.com');
    git('config', 'commit.gpgsign', 'false');
    return { dir, git };
  }
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('returns an empty history for a repository without commits', async () => {
    const { dir } = repo();
    const h = await extractHistory(dir);
    expect(h.commits).toEqual([]);
    await expect(extractHistory(dir, { rev: 'main' })).rejects.toThrow(/Unknown revision/);
  });

  it('records binary-to-text conversions with an absolute line count', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'data.bin'), Buffer.from([0, 1, 2, 0, 3]));
    git('add', '-A');
    git('commit', '-qm', 'binary');
    writeFileSync(join(dir, 'data.bin'), 'one\ntwo\nthree');
    git('commit', '-qam', 'now text');
    appendFileSync(join(dir, 'data.bin'), '\nfour\n');
    git('commit', '-qam', 'more text');
    const h = await extractHistory(dir);
    const f = h.files.indexOf('data.bin');
    expect(h.commits[1][4]).toEqual([[f, 3, 0, -2]]);
    const r = new Replayer(h);
    r.seek(0);
    expect(r.binary[f]).toBe(1);
    r.seek(1);
    expect(r.binary[f]).toBe(0);
    expect(r.lines[f]).toBe(3);
    r.seek(2);
    expect(r.lines[f]).toBe(4);
  });

  it('keeps emptied files, and handles subjects and paths containing separators', async () => {
    const { dir, git } = repo();
    const odd = `odd${RS}name${US}.txt`;
    writeFileSync(join(dir, odd), 'a\nb\n');
    writeFileSync(join(dir, 'x.txt'), 'a\nb\nc\n');
    git('add', '-A');
    git('commit', '-qm', `init ${RS} with ${US} separators`);
    writeFileSync(join(dir, 'x.txt'), '');
    git('commit', '-qam', 'empty x');
    const h = await extractHistory(dir);
    expect(h.files).toContain(odd);
    expect(h.commits[0][2]).toBe(`init ${RS} with ${US} separators`);
    const r = new Replayer(h);
    r.seek(1);
    expect(r.lines[h.files.indexOf(odd)]).toBe(2);
    expect(r.exists[h.files.indexOf('x.txt')]).toBe(1);
    expect(r.lines[h.files.indexOf('x.txt')]).toBe(0);
  });

  it('cancels running git processes through the abort signal', async () => {
    const { dir } = repo();
    const ac = new AbortController();
    ac.abort();
    await expect(runGit(dir, ['status'], { signal: ac.signal })).rejects.toThrow(/abort/i);
  });

  it('clones remote branches and tags when a revision is requested', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'side');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-qm', 'side work');
    git('tag', 'v1');
    git('checkout', '-q', 'main');
    git('branch', '-qD', 'side');
    const url = pathToFileURL(dir).href;
    const subjects = await withRepo(url, { quiet: true, rev: 'v1' }, async (d, _name, signal) => {
      const h = await extractHistory(d, { rev: 'v1', signal });
      return h.commits.map((c) => c[2]);
    });
    expect(subjects).toEqual(['init', 'side work']);
  });
});
