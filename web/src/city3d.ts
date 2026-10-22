import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CITY_SIZE, type CityModel, type ColorMode } from './model';

const PLATE = 0.22;
const HALF = CITY_SIZE / 2;

export interface CityCallbacks {
  onSelect(file: number): void;
  onHover(file: number, clientX: number, clientY: number): void;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 top = vec3(0.01, 0.0, 0.04);
  vec3 mid = vec3(0.09, 0.0, 0.20);
  vec3 horizon = vec3(0.55, 0.05, 0.42);
  vec3 col = mix(mid, top, smoothstep(0.08, 0.6, y));
  col = mix(horizon, col, smoothstep(-0.01, 0.16, y));
  col = mix(col, vec3(0.03, 0.0, 0.08), smoothstep(0.0, -0.08, y));

  // Retro striped sun on the horizon.
  vec3 sunDir = normalize(vec3(-0.62, 0.07, -0.78));
  float ang = acos(clamp(dot(d, sunDir), -1.0, 1.0));
  float radius = 0.17;
  if (ang < radius && y > -0.01) {
    float t = clamp((y - (sunDir.y - radius)) / (2.0 * radius), 0.0, 1.0);
    vec3 sun = mix(vec3(0.95, 0.08, 0.45), vec3(1.05, 0.78, 0.18), t);
    float below = sunDir.y - y;
    float stripe = 1.0;
    if (below > 0.0) {
      float freq = 34.0;
      float w = 0.18 + below * 2.6;
      stripe = step(w, fract(below * freq - uTime * 0.25));
    }
    float edge = smoothstep(radius, radius - 0.006, ang);
    col = mix(col, sun, edge * stripe);
  }
  // Faint stars.
  vec2 g = floor(d.xz / max(0.2, d.y + 0.25) * 180.0);
  float star = fract(sin(dot(g, vec2(12.9898, 78.233))) * 43758.5453);
  col += vec3(0.8, 0.8, 1.0) * step(0.997, star) * smoothstep(0.25, 0.6, y) * 0.8;
  gl_FragColor = vec4(col, 1.0);
}`;

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GRID_FRAG = /* glsl */ `
varying vec3 vWorld;
uniform float uTime;
float gridLine(vec2 p, float spacing) {
  vec2 c = p / spacing;
  vec2 fw = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  // Fade out lines once cells get smaller than a few pixels (avoids moire haze).
  return line * (1.0 - smoothstep(0.08, 0.35, max(fw.x, fw.y)));
}
void main() {
  vec2 p = vWorld.xz;
  float dist = length(p);
  float major = gridLine(p + vec2(0.0, uTime * 2.0), 8.0);
  float minor = gridLine(p, 2.0) * 0.18;
  float fade = 1.0 - smoothstep(60.0, 620.0, dist);
  vec3 base = vec3(0.02, 0.0, 0.05);
  vec3 lineCol = mix(vec3(1.0, 0.16, 0.75), vec3(0.1, 0.85, 1.0), smoothstep(80.0, 400.0, dist));
  vec3 col = base + lineCol * (major * 1.1 + minor) * fade;
  float horizonFade = smoothstep(900.0, 500.0, dist);
  gl_FragColor = vec4(col, horizonFade);
}`;

export class City3D {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cityGroup = new THREE.Group();
  private readonly selection: THREE.LineSegments;

  private model: CityModel | null = null;
  private buildings: THREE.InstancedMesh | null = null;
  private glowAttr: THREE.InstancedBufferAttribute | null = null;
  private targetH = new Float32Array(0);
  private targetS = new Float32Array(0);
  private curH = new Float32Array(0);
  private curS = new Float32Array(0);
  private instanceIndex = new Int32Array(0);
  /** Author whose color each instance currently shows (author color mode). */
  private shownAuthor = new Int32Array(0);
  private shownColorMode: ColorMode | null = null;
  private lastVersion = -1;
  private boundsDirty = true;
  private focusTarget: THREE.Vector3 | null = null;
  private visible = true;
  private pointerDown: { x: number; y: number } | null = null;
  private hoverPending: { x: number; y: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: CityCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.FogExp2(0x1a0233, 0.0052);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    this.camera.position.set(70, 40, 88);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 420;
    this.controls.target.set(0, 4, 0);
    this.controls.autoRotateSpeed = 0.6;

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 48, 24),
      new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, uniforms: { uTime: { value: 0 } } }),
    );
    this.sky.renderOrder = -2;
    this.scene.add(this.sky);

    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.ShaderMaterial({ vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: true, uniforms: { uTime: { value: 0 } } }),
    );
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = -0.02;
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);

    this.scene.add(new THREE.HemisphereLight(0x7a5cff, 0x2a0040, 0.7));
    const key = new THREE.DirectionalLight(0xff7ad9, 1.1);
    key.position.set(-60, 90, -120);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x29e6ff, 0.6);
    fill.position.set(80, 50, 90);
    this.scene.add(fill);
    this.scene.add(this.cityGroup);

    this.selection = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
      new THREE.LineBasicMaterial({ color: 0x29d9ed }),
    );
    this.selection.visible = false;
    this.scene.add(this.selection);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only a faint halo around bright accents; ordinary facades stay below threshold.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.18, 0.0, 1.5);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      const d = this.pointerDown;
      this.pointerDown = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) this.cb.onSelect(this.pick(e.clientX, e.clientY));
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) this.hoverPending = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerleave', () => this.cb.onHover(-1, 0, 0));
    el.addEventListener('dblclick', (e) => {
      const f = this.pick(e.clientX, e.clientY);
      if (f >= 0) this.focus(f);
    });

    this.resize();
  }

  get autoRotate(): boolean {
    return this.controls.autoRotate;
  }

  set autoRotate(v: boolean) {
    this.controls.autoRotate = v;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.renderer.domElement.style.display = v ? 'block' : 'none';
    if (v) {
      this.resize();
      // Updates are suspended while hidden: resynchronize with the model on the next frame.
      this.lastVersion = -1;
    }
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  setModel(model: CityModel): void {
    this.model = model;
    this.clearCity();
    const { layout, placed } = model;
    const n = placed.length;

    // District plates and neon outlines.
    const plateGeo = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.2, emissive: 0x12001f });
    const plates = new THREE.InstancedMesh(plateGeo, plateMat, Math.max(1, layout.districts.length));
    plates.count = layout.districts.length;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const outline: number[] = [];
    const outlineCol: number[] = [];
    const cyan = new THREE.Color(0x05d9e8);
    const magenta = new THREE.Color(0xff2a6d);
    layout.districts.forEach((d, i) => {
      const y0 = d.depth * PLATE;
      m.makeScale(d.w, PLATE, d.h).setPosition(d.x - HALF, y0, d.y - HALF);
      plates.setMatrixAt(i, m);
      col.setHSL(0.76 - Math.min(d.depth, 6) * 0.025, 0.55, 0.06 + Math.min(d.depth, 6) * 0.025);
      plates.setColorAt(i, col);
      const y = y0 + PLATE + 0.01;
      const x0 = d.x - HALF;
      const z0 = d.y - HALF;
      const x1 = x0 + d.w;
      const z1 = z0 + d.h;
      outline.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
      const c = cyan.clone().lerp(magenta, Math.min(1, d.depth / 4)).multiplyScalar(d.depth === 0 ? 1.6 : 0.9 / (1 + d.depth * 0.25));
      for (let k = 0; k < 8; k++) outlineCol.push(c.r, c.g, c.b);
    });
    plates.instanceMatrix.needsUpdate = true;
    this.cityGroup.add(plates);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
    lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(outlineCol, 3));
    this.cityGroup.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })));

    // Base slab under the whole city.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(CITY_SIZE + 3, 0.3, CITY_SIZE + 3),
      new THREE.MeshStandardMaterial({ color: 0x0c0018, emissive: 0x16002a, roughness: 0.6 }),
    );
    slab.position.y = -0.16;
    this.cityGroup.add(slab);

    // Buildings: one instance per file that ever exists.
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const glow = new Float32Array(Math.max(1, n));
    this.glowAttr = new THREE.InstancedBufferAttribute(glow, 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.glowAttr);
    const mat = createBuildingMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    mesh.count = n;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    (mesh.instanceMatrix.array as Float32Array).fill(0);
    this.buildings = mesh;
    this.cityGroup.add(mesh);

    this.targetH = new Float32Array(n);
    this.targetS = new Float32Array(n);
    this.curH = new Float32Array(n);
    this.curS = new Float32Array(n);
    this.instanceIndex = new Int32Array(model.history.files.length).fill(-1);
    placed.forEach((f, i) => (this.instanceIndex[f] = i));
    this.shownAuthor = new Int32Array(n).fill(-2);
    this.shownColorMode = null;
    this.lastVersion = -1;
    this.selection.visible = false;
  }

  private clearCity(): void {
    for (const child of [...this.cityGroup.children]) {
      this.cityGroup.remove(child);
      const obj = child as THREE.Mesh;
      obj.geometry?.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
    this.buildings = null;
  }

  private syncTargets(): void {
    const model = this.model!;
    const mesh = this.buildings!;
    const { placed, replayer } = model;
    for (let i = 0; i < placed.length; i++) {
      const f = placed[i];
      if (replayer.exists[f]) {
        const lines = replayer.lines[f];
        this.targetH[i] = model.height(lines);
        const peak = replayer.peakLines[f] || 1;
        this.targetS[i] = Math.min(1, Math.max(0.35, Math.sqrt(lines / peak)));
      } else {
        this.targetH[i] = 0;
        this.targetS[i] = 0;
      }
    }

    // Colors only change with the color mode, or per file with its last author in author mode.
    const attr = mesh.instanceColor!;
    const colors = attr.array as Float32Array;
    const all = model.colorMode !== this.shownColorMode;
    if (!all && model.colorMode === 'ext') return;
    this.shownColorMode = model.colorMode;
    let lo = Infinity;
    let hi = -1;
    for (let i = 0; i < placed.length; i++) {
      const f = placed[i];
      if (!all) {
        const a = replayer.lastAuthor[f];
        if (a === this.shownAuthor[i]) continue;
        this.shownAuthor[i] = a;
      } else this.shownAuthor[i] = replayer.lastAuthor[f];
      model.color(f, colors, i * 3);
      // Palette colors are sRGB; the renderer works in linear space.
      for (let c = i * 3; c < i * 3 + 3; c++) colors[c] = srgbToLinear(colors[c]);
      if (i < lo) lo = i;
      hi = i;
    }
    if (hi >= 0) {
      attr.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
      attr.needsUpdate = true;
    }
  }

  /** Per-frame update: animate building sizes toward targets and refresh glow. */
  update(dt: number, time: number): void {
    const model = this.model;
    const mesh = this.buildings;
    // While the 2D view is shown, skip all per-file work and GPU uploads.
    if (this.visible && model && mesh && this.glowAttr) {
      if (model.version !== this.lastVersion) {
        this.lastVersion = model.version;
        this.syncTargets();
      }
      const { lots, depths } = model.layout;
      const placed = model.placed;
      const k = Math.min(1, dt * 9);
      const arr = mesh.instanceMatrix.array as Float32Array;
      const glow = this.glowAttr.array as Float32Array;
      let movedLo = Infinity;
      let movedHi = -1;
      let glowLo = Infinity;
      let glowHi = -1;
      for (let i = 0; i < placed.length; i++) {
        const f = placed[i];
        let h = this.curH[i];
        let s = this.curS[i];
        const dh = this.targetH[i] - h;
        const ds = this.targetS[i] - s;
        if (Math.abs(dh) > 1e-3 || Math.abs(ds) > 1e-3) {
          h = Math.abs(dh) < 0.01 ? this.targetH[i] : h + dh * k;
          s = Math.abs(ds) < 0.005 ? this.targetS[i] : s + ds * k;
          this.curH[i] = h;
          this.curS[i] = s;
          const o = f * 4;
          const lw = lots[o + 2];
          const lh = lots[o + 3];
          const gap = Math.min(0.14 * Math.min(lw, lh), 0.32);
          const bw = Math.max(0, lw - 2 * gap) * s;
          const bd = Math.max(0, lh - 2 * gap) * s;
          const e = i * 16;
          arr[e] = bw;
          arr[e + 5] = h;
          arr[e + 10] = bd;
          arr[e + 12] = lots[o] + lw / 2 - HALF;
          arr[e + 13] = depths[f] * PLATE;
          arr[e + 14] = lots[o + 1] + lh / 2 - HALF;
          arr[e + 15] = 1;
          if (i < movedLo) movedLo = i;
          movedHi = i;
        }
        const r = model.recency(f);
        let g = r > 0.01 ? r * (0.75 + 0.25 * Math.sin(time * 6 + i * 0.7)) : 0;
        if (f === model.selected) g = Math.max(g, 0.55 + 0.25 * Math.sin(time * 4));
        if (glow[i] !== g) {
          glow[i] = g;
          if (i < glowLo) glowLo = i;
          glowHi = i;
        }
      }
      if (movedHi >= 0) {
        mesh.instanceMatrix.addUpdateRange(movedLo * 16, (movedHi - movedLo + 1) * 16);
        mesh.instanceMatrix.needsUpdate = true;
        this.boundsDirty = true;
      }
      if (glowHi >= 0) {
        this.glowAttr.addUpdateRange(glowLo, glowHi - glowLo + 1);
        this.glowAttr.needsUpdate = true;
      }
      this.updateSelection();
    }

    if (this.hoverPending) {
      const { x, y } = this.hoverPending;
      this.hoverPending = null;
      this.cb.onHover(this.pick(x, y), x, y);
    }

    if (!this.visible) return;
    if (this.focusTarget) {
      this.controls.target.lerp(this.focusTarget, Math.min(1, dt * 4));
      if (this.controls.target.distanceTo(this.focusTarget) < 0.05) this.focusTarget = null;
    }
    this.controls.update(dt);
    this.sky.position.copy(this.camera.position);
    this.sky.material.uniforms.uTime.value = time;
    this.grid.material.uniforms.uTime.value = time;
    this.composer.render(dt);
  }

  private instanceOf(file: number): number {
    return file >= 0 && file < this.instanceIndex.length ? this.instanceIndex[file] : -1;
  }

  private updateSelection(): void {
    const model = this.model!;
    const i = model.selected >= 0 ? this.instanceOf(model.selected) : -1;
    if (i < 0 || this.curH[i] <= 0) {
      this.selection.visible = false;
      return;
    }
    const arr = this.buildings!.instanceMatrix.array as Float32Array;
    const e = i * 16;
    this.selection.visible = true;
    this.selection.scale.set(arr[e] + 0.03, arr[e + 5] + 0.03, arr[e + 10] + 0.03);
    this.selection.position.set(arr[e + 12], arr[e + 13], arr[e + 14]);
  }

  pick(clientX: number, clientY: number): number {
    const mesh = this.buildings;
    if (!mesh || !this.model) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    if (this.boundsDirty) {
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      this.boundsDirty = false;
    }
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    for (const h of hits) {
      if (h.instanceId === undefined) continue;
      const f = this.model.placed[h.instanceId];
      if (this.model.replayer.exists[f]) return f;
    }
    return -1;
  }

  /** Smoothly orbit around a file's building. */
  focus(file: number): void {
    const model = this.model;
    if (!model) return;
    const o = file * 4;
    const { lots, depths } = model.layout;
    const lines = model.replayer.lines[file];
    this.focusTarget = new THREE.Vector3(
      lots[o] + lots[o + 2] / 2 - HALF,
      depths[file] * PLATE + model.height(lines) * 0.5,
      lots[o + 1] + lots[o + 3] / 2 - HALF,
    );
  }

  resetView(): void {
    this.camera.position.set(70, 40, 88);
    this.focusTarget = new THREE.Vector3(0, 4, 0);
  }

  dispose(): void {
    this.clearCity();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.15 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aGlow;
varying float vGlow;
varying vec3 vCityPos;
varying vec3 vLocalPos;
varying vec3 vObjNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vGlow = aGlow;
vObjNormal = normal;
vLocalPos = position - vec3(0.0, 0.5, 0.0);
vCityPos = (instanceMatrix * vec4(position, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vGlow;
varying vec3 vCityPos;
varying vec3 vLocalPos;
varying vec3 vObjNormal;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 baseCol = vColor.rgb;
  float side = 1.0 - abs(vObjNormal.y);
  // Anti-aliased window bands on the facades, fading out where they would alias.
  float fy = vCityPos.y * 1.4;
  float fw = fwidth(fy);
  float band = smoothstep(0.5 - fw, 0.5 + fw, fract(fy)) * (1.0 - smoothstep(0.2, 0.6, fw));
  float windows = band * side;
  float roof = 1.0 - side;
  // Use the two coordinates along each face to draw thin, anti-aliased neon edges.
  vec3 edgeDistance = 0.5 - abs(vLocalPos);
  vec3 edgeWidth = max(fwidth(vLocalPos) * 1.25, vec3(0.001));
  vec3 edgeMask = 1.0 - smoothstep(vec3(0.0), edgeWidth, edgeDistance);
  float edge = abs(vObjNormal.x) * max(edgeMask.y, edgeMask.z)
    + abs(vObjNormal.y) * max(edgeMask.x, edgeMask.z)
    + abs(vObjNormal.z) * max(edgeMask.x, edgeMask.y);
  // Facades stay below bloom's HDR threshold; roofs retain a soft colored glow.
  totalEmissiveRadiance += baseCol * (0.025 + windows * 0.12 + roof * 0.45);
  // Recency/selection brighten accents without turning entire facades into floodlights.
  float pulse = clamp(vGlow, 0.0, 1.0);
  totalEmissiveRadiance += baseCol * (edge * (2.5 + pulse * 1.5) + roof * pulse * 0.2);
}`,
      );
  };
  return mat;
}
