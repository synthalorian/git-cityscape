import { CITY_SIZE, MAX_HEIGHT, type CityModel } from './model';

export interface TreemapCallbacks {
  onSelect(file: number): void;
  onHover(file: number, clientX: number, clientY: number): void;
}

/**
 * Flat canvas rendering of the same stable layout: brightness encodes size, glow encodes recency.
 */
export class Treemap2D {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private model: CityModel | null = null;
  private visible = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private dpr = 1;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: TreemapCallbacks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'treemap-canvas';
    this.canvas.style.display = 'none';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoom = Math.min(40, Math.max(0.5, this.zoom * factor));
      // Keep the point under the cursor fixed.
      const [nx, ny] = this.toWorld(e.clientX, e.clientY);
      this.panX += (nx - wx) * this.scale();
      this.panY += (ny - wy) * this.scale();
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        this.panX = this.drag.px + dx;
        this.panY = this.drag.py + dy;
      } else if (this.model) {
        const [x, y] = this.toWorld(e.clientX, e.clientY);
        this.cb.onHover(this.model.fileAt(x, y), e.clientX, e.clientY);
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved && this.model) {
        const [x, y] = this.toWorld(e.clientX, e.clientY);
        this.cb.onSelect(this.model.fileAt(x, y));
      }
    });
    this.canvas.addEventListener('pointerleave', () => this.cb.onHover(-1, 0, 0));
    this.canvas.addEventListener('dblclick', () => this.resetView());
  }

  setModel(model: CityModel): void {
    this.model = model;
    this.resetView();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
    if (v) this.resize();
  }

  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /** Pixels per world unit (CSS pixels). */
  private scale(): number {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    return (Math.min(w, h - 140) / CITY_SIZE) * 0.9 * this.zoom;
  }

  private origin(): [number, number] {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const s = this.scale();
    return [w / 2 - (CITY_SIZE * s) / 2 + this.panX, (h - 90) / 2 - (CITY_SIZE * s) / 2 + this.panY + 10];
  }

  private toWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const [ox, oy] = this.origin();
    const s = this.scale();
    return [(clientX - rect.left - ox) / s, (clientY - rect.top - oy) / s];
  }

  render(time: number): void {
    const model = this.model;
    if (!this.visible || !model) return;
    const { ctx } = this;
    const W = this.canvas.width / this.dpr;
    const H = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#07001a');
    bg.addColorStop(0.65, '#1b0336');
    bg.addColorStop(1, '#3a0647');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const s = this.scale();
    const [ox, oy] = this.origin();
    const { lots, districts } = model.layout;
    const { replayer } = model;

    // Districts.
    for (const d of districts) {
      const x = ox + d.x * s;
      const y = oy + d.y * s;
      const w = d.w * s;
      const h = d.h * s;
      if (w < 1.5 || h < 1.5 || x > W || y > H || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = `rgba(${40 + d.depth * 8}, ${4 + d.depth * 2}, ${70 + d.depth * 10}, 0.55)`;
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = d.depth === 0 ? 1.6 : 1;
      ctx.strokeStyle = d.depth === 0 ? 'rgba(5, 217, 232, 0.9)' : `rgba(255, 42, 160, ${Math.max(0.25, 0.7 - d.depth * 0.12)})`;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    // Files.
    const rgb = [0, 0, 0];
    const glowing: number[] = [];
    for (const f of model.placed) {
      if (!replayer.exists[f]) continue;
      const o = f * 4;
      const gap = Math.min(0.12 * Math.min(lots[o + 2], lots[o + 3]), 0.25);
      const x = ox + (lots[o] + gap) * s;
      const y = oy + (lots[o + 1] + gap) * s;
      const w = (lots[o + 2] - 2 * gap) * s;
      const h = (lots[o + 3] - 2 * gap) * s;
      if (x > W || y > H || x + w < 0 || y + h < 0) continue;
      model.color(f, rgb, 0);
      const t = Math.min(1, model.height(replayer.lines[f]) / MAX_HEIGHT);
      const k = 0.35 + 0.65 * Math.sqrt(t);
      ctx.fillStyle = `rgb(${(rgb[0] * 255 * k) | 0}, ${(rgb[1] * 255 * k) | 0}, ${(rgb[2] * 255 * k) | 0})`;
      ctx.fillRect(x, y, Math.max(0.6, w), Math.max(0.6, h));
      if (model.recency(f) > 0.05 || f === model.selected) glowing.push(f);
    }

    // Recently changed files glow.
    ctx.save();
    for (const f of glowing) {
      const o = f * 4;
      const r = f === model.selected ? 1 : model.recency(f) * (0.75 + 0.25 * Math.sin(time * 6 + f));
      model.color(f, rgb, 0);
      const col = `rgba(${(rgb[0] * 255) | 0}, ${(rgb[1] * 255) | 0}, ${(rgb[2] * 255) | 0}, ${Math.min(1, r)})`;
      ctx.shadowColor = col;
      ctx.shadowBlur = 6 + 18 * r;
      ctx.strokeStyle = f === model.selected ? '#ffffff' : col;
      ctx.lineWidth = f === model.selected ? 2 : 1.5;
      ctx.strokeRect(ox + lots[o] * s, oy + lots[o + 1] * s, lots[o + 2] * s, lots[o + 3] * s);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * r})`;
      ctx.fillRect(ox + lots[o] * s, oy + lots[o + 1] * s, lots[o + 2] * s, lots[o + 3] * s);
    }
    ctx.restore();

    // District labels on large enough districts.
    ctx.font = '600 11px "Orbitron", "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const placedLabels: [number, number, number, number][] = [];
    for (const d of districts) {
      const w = d.w * s;
      const h = d.h * s;
      if (w < 60 || h < 22 || d.depth > 2) continue;
      const x = ox + d.x * s;
      const y = oy + d.y * s;
      const label = d.name.length * 7 > w - 8 ? `${d.name.slice(0, Math.max(1, Math.floor((w - 8) / 7) - 1))}…` : d.name;
      const lw = Math.min(w - 4, label.length * 7 + 8);
      const box: [number, number, number, number] = [x + 2, y + 2, lw, 15];
      // Nested districts often share a corner with their parent: skip colliding labels.
      if (placedLabels.some(([bx, by, bw, bh]) => box[0] < bx + bw && bx < box[0] + box[2] && box[1] < by + bh && by < box[1] + box[3])) continue;
      placedLabels.push(box);
      ctx.fillStyle = 'rgba(7, 0, 26, 0.65)';
      ctx.fillRect(box[0], box[1], box[2], box[3]);
      ctx.fillStyle = d.depth === 0 ? '#7df9ff' : '#ff9ad5';
      ctx.fillText(label, x + 6, y + 4);
    }
  }
}
