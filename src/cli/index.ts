import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDemoHistory } from '../core/demo.js';
import type { History } from '../core/types.js';
import { extractHistory } from './extract.js';
import { withRepo } from './repo.js';
import { openBrowser, serveHistory } from './serve.js';

const HELP = `git-cityscape - explore Git history as a neon city

Usage:
  git-cityscape extract <path-or-git-url> [-o history.json] [options]
  git-cityscape serve   <path-or-git-url> [--port 4173] [options]
  git-cityscape demo    [-o demo.json] [--commits 700]

Extract options:
  -o, --output <file>   Output file (default: history.json, "-" for stdout)
  --max-commits <n>     Only keep the most recent n commits (earlier state becomes a baseline)
  --rev <revision>      Single revision (branch, tag or commit) to walk (default: HEAD)
  --blobless            Clone remotes with --filter=blob:none (smaller download, slower diffing)
  --pretty              Indent the JSON output
  -q, --quiet           No progress output

Serve options:
  -p, --port <n>        Port (default: 4173)
  --host <host>         Interface to bind (default: 127.0.0.1)
  --open                Open the browser
  --web-root <dir>      Serve a different web build

  -h, --help            Show help
  -v, --version         Show version
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['output', 'max-commits', 'rev', 'port', 'host', 'web-root', 'commits', 'seed']);
const ALIASES: Record<string, string> = { o: 'output', p: 'port', q: 'quiet', h: 'help', v: 'version' };

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      let name = a.replace(/^--?/, '');
      let value: string | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      name = ALIASES[name] ?? name;
      if (VALUE_FLAGS.has(name)) {
        value ??= argv[++i];
        if (value === undefined) throw new Error(`Missing value for --${name}`);
        flags.set(name, value);
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function intFlag(args: Args, name: string): number | undefined {
  const v = args.flags.get(name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} expects a non-negative integer`);
  return n;
}

function version(): string {
  try {
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json');
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function extractFromSpec(spec: string, args: Args): Promise<History> {
  const quiet = args.flags.has('quiet');
  const started = Date.now();
  if (args.flags.has('all-parents')) {
    throw new Error('--all-parents is no longer supported: history is replayed along first parents, with merges contributing their first-parent diff');
  }
  const rev = args.flags.get('rev') as string | undefined;
  const maxCommits = intFlag(args, 'max-commits');
  const history = await withRepo(spec, { blobless: args.flags.has('blobless'), quiet, rev }, (dir, name, signal) =>
    extractHistory(dir, {
      repo: name,
      rev,
      maxCommits,
      signal,
      onProgress: quiet ? undefined : (n) => process.stderr.write(`\r  ${n} commits...`),
    }),
  );
  if (!quiet) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(`\rExtracted ${history.commits.length} commits, ${history.files.length} paths, ${history.authors.length} authors in ${secs}s\n`);
  }
  return history;
}

async function writeJson(history: History, out: string, pretty: boolean): Promise<void> {
  const text = JSON.stringify(history, null, pretty ? 1 : undefined);
  if (out === '-') process.stdout.write(text + '\n');
  else await writeFile(out, text);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, spec] = args.positional;
  if (args.flags.has('version')) {
    console.log(version());
    return 0;
  }
  if (!cmd || args.flags.has('help') || cmd === 'help') {
    console.log(HELP);
    return cmd || args.flags.has('help') ? 0 : 1;
  }

  switch (cmd) {
    case 'extract': {
      if (!spec) throw new Error('extract: missing <path-or-git-url>');
      const history = await extractFromSpec(spec, args);
      const out = (args.flags.get('output') as string | undefined) ?? 'history.json';
      await writeJson(history, out, args.flags.has('pretty'));
      if (out !== '-' && !args.flags.has('quiet')) process.stderr.write(`Wrote ${out}\n`);
      return 0;
    }
    case 'serve': {
      if (!spec) throw new Error('serve: missing <path-or-git-url>');
      const history = await extractFromSpec(spec, args);
      const { url } = await serveHistory(history, {
        port: intFlag(args, 'port') ?? 4173,
        host: args.flags.get('host') as string | undefined,
        webRoot: args.flags.get('web-root') as string | undefined,
      });
      console.log(`git-cityscape serving ${history.repo} at ${url}`);
      console.log('Press Ctrl+C to stop.');
      if (args.flags.has('open')) openBrowser(url);
      await new Promise(() => {});
      return 0;
    }
    case 'demo': {
      const history = generateDemoHistory({ commits: intFlag(args, 'commits'), seed: intFlag(args, 'seed') });
      const out = (args.flags.get('output') as string | undefined) ?? 'demo.json';
      await writeJson(history, out, args.flags.has('pretty'));
      if (out !== '-') process.stderr.write(`Wrote ${out} (${history.commits.length} commits)\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`git-cityscape: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
