/**
 * Deterministic synthetic history used for the bundled demo dataset.
 */
import { HistoryBuilder, type NumstatEntry, type RawCommit } from './parser.js';
import type { History } from './types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AUTHORS: [string, string][] = [
  ['Nova Vector', 'nova@neon.city'],
  ['Kai Laserwave', 'kai@neon.city'],
  ['Rio Chrome', 'rio@neon.city'],
  ['Juno Grid', 'juno@neon.city'],
  ['Max Outrun', 'max@neon.city'],
  ['Lux Palms', 'lux@neon.city'],
  ['Vera Arcade', 'vera@neon.city'],
];

const DIRS: [string, string[]][] = [
  ['src/core', ['ts']],
  ['src/render', ['ts', 'glsl']],
  ['src/render/shaders', ['glsl']],
  ['src/ui', ['ts', 'css']],
  ['src/ui/components', ['tsx', 'css']],
  ['src/net', ['ts']],
  ['server', ['go']],
  ['server/api', ['go']],
  ['scripts', ['sh', 'py']],
  ['docs', ['md']],
  ['assets/img', ['png', 'svg']],
  ['assets/audio', ['ogg']],
  ['tests', ['ts']],
  ['config', ['json', 'yml']],
];

const WORDS = ['grid', 'sun', 'neon', 'laser', 'drive', 'pulse', 'wave', 'tape', 'synth', 'chrome', 'night', 'arcade', 'vector', 'horizon', 'palm', 'glow', 'beam', 'city', 'retro', 'turbo'];
const VERBS = ['Add', 'Fix', 'Refactor', 'Tune', 'Improve', 'Rework', 'Polish', 'Speed up', 'Document', 'Clean up'];
const BINARY_EXT = new Set(['png', 'ogg']);

export interface DemoOptions {
  commits?: number;
  seed?: number;
  start?: number;
}

export function generateDemoHistory(opts: DemoOptions = {}): History {
  const rand = mulberry32(opts.seed ?? 0x5e7a);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const nCommits = opts.commits ?? 700;
  let ts = opts.start ?? 1_640_995_200; // 2022-01-01
  const builder = new HistoryBuilder({ repo: 'neon-drive (demo)' });
  const live = new Map<string, number>();
  const weights = AUTHORS.map((_, i) => 1 / (i + 1));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pickAuthor = () => {
    let r = rand() * wsum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return AUTHORS[i];
    }
    return AUTHORS[0];
  };
  const newPath = (): string => {
    const [dir, exts] = pick(DIRS);
    const name = `${pick(WORDS)}${rand() < 0.5 ? `-${pick(WORDS)}` : ''}`;
    return `${dir}/${name}.${pick(exts)}`;
  };

  for (let i = 0; i < nCommits; i++) {
    ts += Math.floor(1800 + rand() * 86400 * 1.6);
    const [name, email] = pickAuthor();
    const entries: NumstatEntry[] = [];
    const deleted: string[] = [];
    const touched = new Set<string>();
    const growthPhase = i < nCommits * 0.15;
    const nChanges = 1 + Math.floor(rand() * (growthPhase ? 6 : 4));
    let subject = '';

    for (let c = 0; c < nChanges; c++) {
      const roll = rand();
      const paths = [...live.keys()];
      if (paths.length < 6 || roll < (growthPhase ? 0.55 : 0.16)) {
        const p = newPath();
        if (live.has(p) || touched.has(p)) continue;
        const bin = BINARY_EXT.has(p.split('.').pop()!);
        const lines = bin ? 0 : Math.floor(20 + rand() * rand() * 600);
        entries.push(bin ? { added: -1, deleted: -1, path: p } : { added: lines, deleted: 0, path: p });
        live.set(p, lines);
        touched.add(p);
        subject ||= `Add ${p.split('/').pop()}`;
      } else if (roll < 0.2 && paths.length > 20) {
        const p = pick(paths);
        if (touched.has(p)) continue;
        const lines = live.get(p)!;
        const bin = BINARY_EXT.has(p.split('.').pop()!);
        entries.push(bin ? { added: -1, deleted: -1, path: p } : { added: 0, deleted: lines, path: p });
        deleted.push(p);
        live.delete(p);
        touched.add(p);
        subject ||= `Remove ${p.split('/').pop()}`;
      } else if (roll < 0.235) {
        const from = pick(paths);
        if (touched.has(from) || BINARY_EXT.has(from.split('.').pop()!)) continue;
        const ext = from.split('.').pop()!;
        const dir = DIRS.find(([, exts]) => exts.includes(ext))?.[0] ?? from.slice(0, from.lastIndexOf('/'));
        const to = `${dir}/${pick(WORDS)}-${pick(WORDS)}.${ext}`;
        if (live.has(to) || touched.has(to)) continue;
        const lines = live.get(from)!;
        const add = Math.floor(rand() * 10);
        const del = Math.min(lines, Math.floor(rand() * 10));
        entries.push({ added: add, deleted: del, path: to, from });
        live.delete(from);
        live.set(to, lines + add - del);
        touched.add(from).add(to);
        subject ||= `Move ${from.split('/').pop()} to ${to}`;
      } else {
        // Favor a hot set of files so some buildings become skyscrapers.
        const p = rand() < 0.45 ? paths[Math.floor(rand() * Math.min(12, paths.length))] : pick(paths);
        if (touched.has(p) || BINARY_EXT.has(p.split('.').pop()!)) continue;
        const lines = live.get(p)!;
        const add = Math.floor(rand() * rand() * 140) + 1;
        const del = Math.min(lines, Math.floor(rand() * add * 0.8));
        entries.push({ added: add, deleted: del, path: p });
        live.set(p, lines + add - del);
        touched.add(p);
        subject ||= `${pick(VERBS)} ${pick(WORDS)} ${pick(WORDS)} in ${p.split('/').pop()}`;
      }
    }
    if (!entries.length) continue;
    const hash = Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join('');
    const commit: RawCommit = { hash, ts, authorName: name, authorEmail: email, subject, entries, deleted };
    builder.add(commit);
  }
  const h = builder.build();
  h.generatedAt = new Date((ts + 3600) * 1000).toISOString();
  return h;
}
