// Architect-Ant project page: interactive room / house comparison.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const fmt = (x, d = 1) => (x < 0 ? '−' : '') + Math.abs(x).toFixed(d);
const mb = (b) => (b / 2 ** 20).toFixed(b > 2 ** 20 * 10 ? 0 : 1) + ' MB';

const ICON = {
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h7M11 4v16"/></svg>',
  cut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M5 20V8l7-4 7 4v12"/><path d="M9 20v-6h6v6" stroke-dasharray="2 2"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
};

/* ------------------------------------------------------------------ theme */
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : darkMQ.matches; };
const canvasColor = () => (isDark() ? 0x141413 : 0xf2f2ef);
const themeHooks = new Set();
const posterOf = (x) => (isDark() && x.poster_dark ? x.poster_dark : x.poster);
function themeChanged() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? '#0c0c0b' : '#ffffff';
  for (const v of viewers) v.applyTheme();
  for (const f of themeHooks) f();
}

/* ------------------------------------------------------------------ loading */
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();

// Meshes carry their own role extras too (e.g. a door is an 'opening'); the
// outermost tagged ancestor is the export group that decides behaviour.
function roleOf(obj) {
  let role = 'furniture';
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.role) role = o.userData.role;
  return role;
}

function prepare(gltf) {
  // Runs once per file. glTF transmission is expensive and looks odd in a small
  // viewport, so glass becomes a light translucent standard material.
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const role = roleOf(o);
    o.castShadow = role === 'furniture';
    o.receiveShadow = true;
    const fix = (m) => {
      if ((m.transmission && m.transmission > 0) || /glass|glazing/i.test(m.name)) {
        const g = new THREE.MeshStandardMaterial({
          name: m.name, color: m.color ? m.color.clone().lerp(new THREE.Color(0xdfe8ea), 0.5) : 0xdfe8ea,
          roughness: 0.05, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
        });
        return g;
      }
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
  });
  return gltf;
}

// Keep a bounded number of parsed models; never evict one a viewer is showing.
const CACHE_LIMIT = 10;
function evict(keep) {
  const inUse = new Set([...viewers].map((v) => v.url));
  inUse.add(keep);
  for (const [url, p] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    if (inUse.has(url) || !p.done) continue;
    cache.delete(url);
    p.then((g) => g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [o.material].flat()) {
        for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
        m.dispose();
      }
    })).catch(() => {});
  }
}

function fetchModel(url, onProgress) {
  if (cache.has(url)) { const p = cache.get(url); cache.delete(url); cache.set(url, p); } // LRU touch
  if (!cache.has(url)) {
    const listeners = new Set();
    const p = new Promise((resolve, reject) => {
      loader.load(url, (g) => resolve(prepare(g)), (e) => listeners.forEach((f) => f(e)), reject);
    });
    p.listeners = listeners;
    p.then(() => { p.done = true; evict(url); }, () => cache.delete(url));
    cache.set(url, p);
  }
  const p = cache.get(url);
  if (onProgress) p.listeners.add(onProgress);
  return p.finally(() => onProgress && p.listeners.delete(onProgress));
}

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

/* ------------------------------------------------------------------ viewer */
const viewers = new Set();
let pmremTexture = null;

class Viewer {
  constructor(host, { kind = 'room' } = {}) {
    this.host = host;
    this.kind = kind;
    this.visible = true;
    this.dirty = true;
    this.cutaway = true;
    this.cutHeight = 1.35;
    this.token = 0;
    this.onCamera = null;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.localClippingEnabled = true;
    r.setClearColor(canvasColor(), 1);
    r.domElement.setAttribute('aria-label', 'Interactive 3D scene. Drag to orbit, scroll or pinch to zoom, right-drag to pan.');
    r.domElement.tabIndex = 0;
    host.prepend(r.domElement);

    const s = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(r);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    s.environmentIntensity = 0.55;
    s.add(new THREE.HemisphereLight(0xffffff, 0xd9d4ca, 1.1));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff3e4, 2.1));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 3;
    s.add(sun, sun.target);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 600);
    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    c.screenSpacePanning = true;
    c.maxPolarAngle = Math.PI * 0.495;
    c.zoomSpeed = 0.9;
    c.rotateSpeed = 0.75;
    c.addEventListener('change', () => {
      this.dirty = true;
      if (!this.syncing && this.onCamera) this.onCamera(this);
    });

    this.wallPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.cutHeight);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    new IntersectionObserver((es) => { this.visible = es[es.length - 1].isIntersecting; if (this.visible) this.dirty = true; }, { rootMargin: '120px' }).observe(host);
    viewers.add(this);
  }

  applyTheme() {
    this.renderer.setClearColor(canvasColor(), 1);
    this.dirty = true;
  }

  resize() {
    const w = this.host.clientWidth, hgt = this.host.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  async show(url, { onProgress, reframe = true, view = 'south' } = {}) {
    const token = ++this.token;
    const gltf = await fetchModel(url, onProgress);
    if (token !== this.token) return false;
    if (this.model) {
      this.scene.remove(this.model);
      for (const m of this.ownMaterials || []) m.dispose();
    }
    this.url = url;
    this.ownMaterials = [];
    const root = gltf.scene.clone(true);
    // per-instance wall materials: fading / clipping must not leak into the other panel
    this.walls = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const role = roleOf(o);
      if (role !== 'wall' && this.kind !== 'house') return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      for (const m of [o.material].flat()) {
        this.ownMaterials.push(m);
        m.userData.base = { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
        // houses: a plan cut through everything, so wall-mounted items never float above cut walls
        if (this.kind === 'house') {
          m.clippingPlanes = [this.wallPlane];
          m.clipShadows = true;
          if (role === 'wall') m.side = THREE.DoubleSide;
        }
      }
    });
    root.traverse((o) => {
      if (o.userData && o.userData.role === 'wall' && o.userData.wall) this.walls.push({ node: o });
    });
    this.scene.add(root);
    this.model = root;
    this.measure(root);
    this.placeSun();
    if (reframe || !this.framed) this.frame(view);
    this.view = view;
    this.dirty = true;
    return true;
  }

  measure(root) {
    root.updateMatrixWorld(true);
    const arch = new THREE.Box3();
    root.traverse((o) => {
      if (o.isMesh && roleOf(o) !== 'furniture') arch.expandByObject(o);
    });
    this.bounds = new THREE.Box3().setFromObject(root);
    this.arch = arch.isEmpty() ? this.bounds.clone() : arch;
    this.center = this.arch.getCenter(new THREE.Vector3());
    for (const w of this.walls) {
      const b = new THREE.Box3().setFromObject(w.node);
      const c = b.getCenter(new THREE.Vector3()).sub(this.center);
      const n = Math.abs(c.x) >= Math.abs(c.z) ? new THREE.Vector3(Math.sign(c.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(c.z));
      w.normal = n;
      w.dist = Math.abs(n.x ? c.x : c.z) - 0.2;
      w.faded = false;
    }
  }

  placeSun() {
    const size = this.bounds.getSize(new THREE.Vector3());
    const R = Math.max(size.x, size.z) * 0.75 + 2;
    this.sun.position.copy(this.center).add(new THREE.Vector3(-0.45 * R, 1.6 * R, 0.8 * R));
    this.sun.target.position.copy(this.center);
    const cam = this.sun.shadow.camera;
    const e = Math.max(size.x, size.z) * 0.75 + 0.5;
    Object.assign(cam, { left: -e, right: e, top: e, bottom: -e, near: 0.1, far: 5 * R });
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  frame(view = this.view || 'south', mode = 'default') {
    const size = this.arch.getSize(new THREE.Vector3());
    const target = this.center.clone();
    target.y = this.kind === 'house' ? 0.4 : 0.55;
    const el = THREE.MathUtils.degToRad(mode === 'top' ? 89.6 : this.kind === 'house' ? 57 : 50);
    const dir = view === 'east' ? new THREE.Vector3(Math.cos(el), Math.sin(el), 0) : new THREE.Vector3(0, Math.sin(el), Math.cos(el));
    if (mode === 'top') dir.set(0, 1, view === 'east' ? 0 : 0.0001).normalize();
    if (mode === 'top' && view === 'east') dir.set(0.0001, 1, 0).normalize();
    const radius = 0.5 * Math.hypot(size.x, size.z, this.kind === 'house' ? 0 : size.y * 0.6);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (mode === 'top' ? 0.9 : 0.96);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = dist * 3;
    this.camera.near = Math.max(0.02, dist / 200);
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.framed = true;
    this.dirty = true;
    if (this.onCamera && !this.syncing) this.onCamera(this);
  }

  copyCamera(from) {
    this.syncing = true;
    this.camera.position.copy(from.camera.position);
    this.controls.target.copy(from.controls.target);
    this.camera.near = from.camera.near; this.camera.far = from.camera.far;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = from.controls.minDistance;
    this.controls.maxDistance = from.controls.maxDistance;
    this.controls.update();
    this.syncing = false;
    this.framed = true;
    this.dirty = true;
  }

  applyWalls() {
    if (!this.model) return;
    if (this.kind === 'house') {
      this.wallPlane.constant = this.cutHeight;
      return;
    }
    const rel = this.camera.position.clone().sub(this.center);
    for (const w of this.walls) {
      const fade = this.cutaway && rel.dot(w.normal) > w.dist;
      if (fade === w.faded) continue;
      w.faded = fade;
      w.node.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of [o.material].flat()) {
          const b = m.userData.base;
          m.transparent = fade ? true : b.transparent;
          m.opacity = fade ? Math.min(b.opacity, 0.1) : b.opacity;
          m.depthWrite = fade ? false : b.depthWrite;
          m.needsUpdate = true;
        }
        o.renderOrder = fade ? 2 : 0;
      });
    }
  }

  tick() {
    if (!this.visible) return;
    const moved = this.controls.update();
    if (moved) this.dirty = true;
    if (!this.dirty) return;
    this.applyWalls();
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
}

function loop() {
  for (const v of viewers) v.tick();
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ panel UI */
function makePanel(slot, kind) {
  const select = h('select', { 'aria-label': `Method shown in panel ${slot}` });
  const meta = h('div', { class: 'panel-meta' });
  const posterImg = h('img', { alt: '' });
  const bar = h('i');
  const loaderEl = h('div', { class: 'loader' }, h('span', { class: 'lt' }, 'Loading'), h('span', { class: 'bar' }, bar));
  const poster = h('div', { class: 'poster' }, posterImg, loaderEl);
  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': `View controls ${slot}` });
  const hud = h('div', { class: 'hud' }, tools);
  const viewport = h('div', { class: 'viewport' }, poster, hud);
  const head = h('div', { class: 'panel-head' }, h('div', { class: 'picker' }, h('span', { class: 'slot' }, slot), select), meta);
  const el = h('div', { class: 'panel', 'data-slot': slot }, head, viewport);
  const tool = (name, label, onclick, pressed) => {
    const b = h('button', { class: 'tool', type: 'button', title: label, 'aria-label': label, html: ICON[name], onclick });
    if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
    tools.append(b);
    return b;
  };
  return { el, select, meta, poster, posterImg, bar, loaderEl, viewport, tools, hud, tool, head, slot, kind };
}

function setLoading(p, url, poster, bytes) {
  p.posterImg.src = poster;
  p.poster.classList.remove('hidden');
  p.loaderEl.style.display = '';
  p.bar.style.width = '0%';
  $('.lt', p.loaderEl).textContent = `Loading ${mb(bytes)}`;
}
function progressFor(p, bytes) {
  return (e) => { p.bar.style.width = `${Math.min(100, (100 * e.loaded) / (e.total || bytes || 1)).toFixed(0)}%`; };
}
function doneLoading(p) { p.poster.classList.add('hidden'); }
function failLoading(p, err) {
  console.error(err);
  $('.lt', p.loaderEl).textContent = '3D unavailable, showing the paper render';
  $('.bar', p.loaderEl).style.display = 'none';
  p.posterImg.style.opacity = 1;
  p.posterImg.style.filter = 'none';
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

/* ------------------------------------------------------------------ rooms */
function dslHTML(text) {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (t === 'FURNITURE' || t === 'END') return `<span class="kw">${t}</span>`;
    if (!t.startsWith('OBJ ')) return esc(line);
    return '<span class="kw">OBJ</span> ' + t.slice(4).split(/\s+/).map((tok) => {
      const i = tok.indexOf('=');
      if (i < 0) return esc(tok);
      const v = tok.slice(i + 1);
      return `<span class="at">${esc(tok.slice(0, i))}=</span>` + (/^-?[\d.]+$/.test(v) ? `<span class="nu">${v}</span>` : esc(v));
    }).join(' ');
  }).join('\n');
}

function initRooms(data, gl) {
  const root = $('#explorer');
  const tabs = $('#room-tabs');
  const stage = $('#room-stage');
  const strip = $('#room-strip');
  const state = { room: 0, A: 'oursv11b', B: 'scenesmith', focus: 'B', single: window.matchMedia('(max-width: 820px)').matches, sync: true };
  const panels = { A: makePanel('A', 'room'), B: makePanel('B', 'room') };
  stage.append(panels.A.el, panels.B.el);
  const viewers = {};
  let stale = false;

  const room = () => data.rooms[state.room];
  const method = (key) => room().methods.find((m) => m.key === key);
  const sel = data.selection;
  if (sel) {
    const names = { livingroom: 'living rooms', bedroom: 'bedrooms', kitchen: 'kitchens and dining rooms', bathroom: 'bathrooms' };
    const pools = Object.entries(sel.pools).map(([t, n]) => `${n} ${names[t] || t}`);
    $('#room-rule').textContent = `A showcase selection: for each type, ${sel.per_type} benchmark shells where Architect-Ant performs well ` +
      `(out of ${pools.slice(0, -1).join(', ')} and ${pools.slice(-1)}). ` +
      `Averages over all 109 shells are in the results below. Rooms from the paper figure are marked.`;
  }

  if (gl) {
    for (const s of ['A', 'B']) {
      const p = panels[s];
      const v = (viewers[s] = new Viewer(p.viewport, { kind: 'room' }));
      p.tool('reset', 'Reset view', () => v.frame(room().view));
      p.tool('top', 'Top view', () => v.frame(room().view, 'top'));
      p.tool('cut', 'Cut away walls facing the camera', () => {
        for (const w of Object.values(viewers)) { w.cutaway = !w.cutaway; w.dirty = true; }
        $$('.tool[title^="Cut away"]', root).forEach((b) => b.setAttribute('aria-pressed', String(v.cutaway)));
      }, true);
      if (s === 'A') {
        p.tool('sync', 'Link the two cameras', (e) => {
          state.sync = !state.sync;
          e.currentTarget.setAttribute('aria-pressed', String(state.sync));
          if (state.sync) viewers.B.copyCamera(viewers.A);
        }, true);
      }
      p.tool('full', 'Fullscreen', () => toggleFullscreen(p.el));
      v.onCamera = (src) => {
        if (!state.sync || state.single) return;
        const other = viewers[s === 'A' ? 'B' : 'A'];
        if (other && other.model) other.copyCamera(src);
      };
      p.el.addEventListener('pointerdown', () => setFocus(s));
    }
    const touch = window.matchMedia('(pointer: coarse)').matches;
    panels.A.hud.append(h('div', { class: 'hint' }, touch ? 'drag · pinch · two-finger pan' : 'drag · scroll · right-drag'));
  }

  function setFocus(s) {
    state.focus = s;
    for (const k of ['A', 'B']) panels[k].el.style.boxShadow = !state.single && k === s ? '0 0 0 1.5px var(--ink)' : '';
  }

  // four room types, each a dropdown of its rooms (ranked best-first by the build script)
  const types = [...new Set(data.rooms.map((r) => r.room))];
  const lastPick = {};
  const roomsOf = (t) => data.rooms.map((r, i) => [r, i]).filter(([r]) => r.room === t);
  const oursOf = (r) => r.methods.find((m) => m.key === 'oursv11b');
  const mixedKinds = (t) => new Set(roomsOf(t).map(([r]) => r.kind)).size > 1;
  const caret = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  let openMenu = null;
  const closeMenu = () => {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.btn.setAttribute('aria-expanded', 'false');
    openMenu = null;
  };
  document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function choose(i) {
    closeMenu();
    lastPick[data.rooms[i].room] = i;
    if (i === state.room) return;
    state.room = i;
    update();
  }

  function renderTabs() {
    const cur = room();
    tabs.replaceChildren(...types.map((t) => {
      const list = roomsOf(t);
      const active = cur.room === t;
      const btn = h('button', {
        class: 'tab', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-selected': String(active),
      }, list[0][0].label, h('span', { class: 'dim' }, active ? `${list.findIndex(([, i]) => i === state.room) + 1}/${list.length}` : `${list.length}`),
      h('span', { class: 'caret', html: caret }));
      const items = list.map(([r, i], k) => {
        const o = oursOf(r);
        return h('li', { role: 'option', tabindex: '-1', 'aria-selected': String(i === state.room), onclick: () => choose(i),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(i); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const all = $$('li', menu);
              all[(all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus();
            }
          } },
        h('img', { src: posterOf(o), alt: '', loading: 'lazy' }),
        h('div', { class: 'mi' },
          h('div', { class: 'mt' }, h('b', {}, `Room ${k + 1}`), ` · shell #${r.id}`, r.figure ? h('span', { class: 'figtag' }, 'paper figure') : null),
          h('div', { class: 'ms' }, `${mixedKinds(r.room) ? r.kind + ' · ' : ''}${r.interior_m[0]} × ${r.interior_m[1]} m · ${r.methods.length} methods · LRS ${fmt(o.metrics.lrs)}`)));
      });
      const menu = h('ul', { class: 'menu', role: 'listbox', 'aria-label': `${list[0][0].label} rooms`, hidden: true }, items);
      const wrap = h('div', { class: 'dd' }, btn, menu);
      btn.addEventListener('click', () => {
        if (openMenu && openMenu.menu === menu) { closeMenu(); return; }
        closeMenu();
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        openMenu = { menu, btn, wrap };
        // keep the menu inside the viewport (16 px gutter), anchored under its tab where possible
        const vw = document.documentElement.clientWidth, left = wrap.getBoundingClientRect().left;
        const x = Math.min(Math.max(16, left), vw - 16 - menu.offsetWidth);
        menu.style.left = `${x - left}px`;
        const sel = $('li[aria-selected="true"]', menu) || $('li', menu);
        sel.focus({ preventScroll: true });
      });
      btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); btn.click(); } });
      return wrap;
    }));
    // current room line with previous / next inside the type
    const list = roomsOf(cur.room);
    const k = list.findIndex(([, i]) => i === state.room);
    const step = (d) => choose(list[(k + d + list.length) % list.length][1]);
    $('#room-line').replaceChildren(
      h('button', { class: 'step', type: 'button', 'aria-label': 'Previous room', onclick: () => step(-1) }, '‹'),
      h('span', {}, h('b', {}, `${cur.label} ${k + 1} of ${list.length}`), mixedKinds(cur.room) ? ` · ${cur.kind}` : '', ` · shell #${cur.id} · ${cur.interior_m[0]} × ${cur.interior_m[1]} m`,
        cur.figure ? h('span', { class: 'figtag' }, 'paper figure') : null),
      h('button', { class: 'step', type: 'button', 'aria-label': 'Next room', onclick: () => step(1) }, '›'));
  }

  function renderPanel(s, reframe) {
    const p = panels[s];
    const m = method(state[s]);
    p.select.replaceChildren(...room().methods.map((x) => h('option', { value: x.key, selected: x.key === m.key }, x.name)));
    p.select.onchange = () => { assign(s, p.select.value); };
    const mt = m.metrics;
    const counted = m.shown_objects === mt.objects ? `${m.shown_objects} objects` : `${m.shown_objects} shown · ${mt.objects} evaluated`;
    p.meta.innerHTML = `LRS <b>${fmt(mt.lrs)}</b> · FUN+ <b>${mt.fun}%</b><br>${counted}`;
    if (!gl) { p.posterImg.src = posterOf(m); p.posterImg.style.opacity = 1; p.posterImg.style.filter = 'none'; p.loaderEl.style.display = 'none'; return; }
    setLoading(p, m.glb, posterOf(m), m.glb_bytes);
    const v = viewers[s];
    const other = viewers[s === 'A' ? 'B' : 'A'];
    // room change: reframe; method change: keep the camera where the reader left it
    v.show(m.glb, { onProgress: progressFor(p, m.glb_bytes), reframe, view: room().view })
      .then((ok) => {
        if (!ok) return;
        v.roomId = room().id;
        v.loadedKey = m.key;
        // align with the other panel if it already shows this room
        if (state.sync && !state.single && other.model && other.roomId === v.roomId) v.copyCamera(other);
        doneLoading(p);
      })
      .catch((e) => failLoading(p, e));
  }

  function renderStrip() {
    strip.replaceChildren(...room().methods.map((m) => {
      const slots = ['A', 'B'].filter((s) => state[s] === m.key && (s === 'A' || !state.single));
      return h('button', {
        class: `card${m.key === 'oursv11b' ? ' ours' : ''}`, type: 'button', 'aria-current': String(slots.length > 0),
        title: `${m.name}: ${m.desc}`, onclick: () => assign(state.single ? 'A' : state.focus, m.key),
      }, h('img', { src: posterOf(m), alt: `${m.name} render`, loading: 'lazy' }),
      h('div', { class: 'slots' }, slots.map((s) => h('span', {}, s))),
      h('div', { class: 'nm' }, m.name),
      h('div', { class: 'sc' }, `LRS ${fmt(m.metrics.lrs)} · ${m.metrics.objects} obj`));
    }));
  }

  function renderTable() {
    const r = room();
    const tbody = h('tbody');
    for (const m of r.methods) {
      const inA = state.A === m.key, inB = !state.single && state.B === m.key;
      const x = m.metrics;
      tbody.append(h('tr', { class: m.key === 'oursv11b' ? 'ours' : '', onclick: () => assign(state.single ? 'A' : state.focus, m.key) },
        h('td', {}, h('span', { class: `pill${inA ? '' : ' ghost'}` }, 'A'), h('span', { class: `pill${inB ? '' : ' ghost'}` }, 'B'), m.name),
        h('td', {}, String(x.objects)), h('td', {}, fmt(x.col)), h('td', {}, fmt(x.oob)), h('td', {}, `${x.fun}`), h('td', {}, fmt(x.lrs))));
    }
    $('#room-table').replaceChildren(h('table', { class: 'mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Method'), h('th', {}, 'Objects'), h('th', {}, 'COL+ % ↓'), h('th', {}, 'OOB % ↓'), h('th', {}, 'FUN+ % ↑'), h('th', {}, 'LRS ↑'))),
      tbody));
    const name = (k) => ({ ours: 'Architect-Ant', scenesmith: 'SceneSmith', tie: 'tie' }[k] || k);
    const pos = roomsOf(r.room).findIndex(([, i]) => i === state.room) + 1;
    $('#room-judges-title').textContent = `Judges' votes for the room shown above: ${r.label.toLowerCase()} ${pos}, shell #${r.id}`;
    $('#room-judges').replaceChildren(
      h('span', { class: 'judge' }, 'Claude Sonnet 5 → ', h('b', {}, name(r.judges.sonnet))),
      h('span', { class: 'judge' }, 'Kimi K3 → ', h('b', {}, name(r.judges.kimi))));
    const ours = r.methods.find((m) => m.key === 'oursv11b');
    $('#room-dsl-title').textContent = ours.dsl_label || 'What Architect-Ant wrote for this room';
    $('#room-dsl').innerHTML = dslHTML(ours.dsl);
  }

  function assign(s, key) {
    if (!method(key)) return;
    state[s] = key;
    renderPanel(s, false);
    renderStrip();
    renderTable();
  }

  function update() {
    const keys = room().methods.map((m) => m.key);
    if (!keys.includes(state.A)) state.A = 'oursv11b';
    if (!keys.includes(state.B) || state.B === state.A) state.B = keys.find((k) => k !== state.A && k === 'scenesmith') || keys.find((k) => k !== state.A);
    renderTabs();
    stage.classList.toggle('single', state.single);
    renderPanel('A', true);
    if (!state.single || !gl) renderPanel('B', true);
    else stale = true;
    renderStrip();
    renderTable();
    setFocus(state.focus);
  }

  $$('#room-mode button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.mode === 'single') === state.single));
    b.addEventListener('click', () => {
      const single = b.dataset.mode === 'single';
      if (single === state.single) return;
      state.single = single;
      $$('#room-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      stage.classList.toggle('single', single);
      if (!single && gl) {
        if (stale || viewers.B.roomId !== room().id) { stale = false; renderPanel('B', true); }
        else if (viewers.A.model) viewers.B.copyCamera(viewers.A);
      }
      renderStrip(); renderTable(); setFocus(state.focus);
    });
  });

  // arrow keys flip through methods in the focused panel
  root.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || e.target.tagName === 'SELECT') return;
    const keys = room().methods.map((m) => m.key);
    const s = state.single ? 'A' : state.focus;
    const i = keys.indexOf(state[s]);
    assign(s, keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]);
    e.preventDefault();
  });

  update();
  themeHooks.add(() => { renderTabs(); renderStrip(); });
}

/* ------------------------------------------------------------------ houses */
function initHouses(data, gl) {
  const tabs = $('#house-tabs');
  const stage = $('#house-stage');
  const panels = { A: makePanel('A', 'house'), B: makePanel('B', 'house') };
  stage.append(panels.A.el, panels.B.el);
  let current = 0;
  const viewers = {};
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    if (gl) {
      for (const s of ['A', 'B']) {
        const p = panels[s];
        const v = (viewers[s] = new Viewer(p.viewport, { kind: 'house' }));
        p.tool('reset', 'Reset view', () => v.frame('south'));
        p.tool('top', 'Top view', () => v.frame('south', 'top'));
        p.tool('full', 'Fullscreen', () => toggleFullscreen(p.el));
        const input = h('input', { type: 'range', min: '0.3', max: '2.8', step: '0.05', value: String(v.cutHeight), 'aria-label': 'Plan cut height' });
        const out = h('span', {}, `${v.cutHeight.toFixed(1)} m`);
        input.addEventListener('input', () => {
          v.cutHeight = +input.value;
          out.textContent = v.cutHeight >= 2.75 ? 'full' : `${v.cutHeight.toFixed(1)} m`;
          v.dirty = true;
        });
        p.hud.append(h('label', { class: 'range', title: 'Plan cut: hide everything above this height' }, 'cut', input, out));
      }
    }
    show(current);
  };

  function show(i) {
    current = i;
    const pair = data.houses[i];
    tabs.replaceChildren(...data.houses.map((x, j) => h('button', {
      class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(j === i), onclick: () => show(j),
    }, `(${x.id}) ${x.title.replace('Architect-Ant preferred over ', 'vs ').replace(' preferred over Architect-Ant', ' preferred')}`)));
    for (const s of ['A', 'B']) {
      const side = pair[s];
      const p = panels[s];
      p.select.replaceChildren(h('option', {}, `${side.name} · house ${side.house_index}`));
      p.select.disabled = true;
      p.select.style.backgroundImage = 'none';
      p.meta.replaceChildren(h('span', { class: `badge-win${pair.winner === s ? ' on' : ''}` }, pair.winner === s ? 'Preferred' : 'Not preferred'));
      if (!gl) { p.posterImg.src = side.poster; p.posterImg.style.opacity = 1; p.posterImg.style.filter = 'none'; p.loaderEl.style.display = 'none'; continue; }
      setLoading(p, side.glb, side.poster, side.glb_bytes);
      viewers[s].show(side.glb, { onProgress: progressFor(p, side.glb_bytes), reframe: true, view: 'south' })
        .then((ok) => ok && doneLoading(p)).catch((e) => failLoading(p, e));
    }
    const win = pair[pair.winner];
    $('#house-verdict').innerHTML = `<b>${pair.judge}</b> preferred <b>${pair.winner} (${win.name})</b> ${pair.reason}. ` +
      `The judge saw anonymous top-down renders; the two houses have different floor plans.`;
  }

  const sides = data.houses.flatMap((p) => [p.A, p.B]);
  const cap = Math.max(...sides.map((x) => x.max_tris || 0));
  const dec = sides.reduce((a, x) => a + (x.decimated_objects || 0), 0);
  if (cap) $('#house-cap-note').textContent = `For the web, every house object above ${cap.toLocaleString('en-US')} triangles is decimated, ` +
    `the same rule for all methods (${dec} objects across these ${sides.length} houses). Layouts and placements are unchanged.`;

  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) start(); }, { rootMargin: '400px' }).observe(stage);
}

/* ------------------------------------------------------------------ page chrome */
function initChrome() {
  // scroll-spy: the active entry is the last target whose top has passed 35% of the viewport
  const links = $$('.nav a.link');
  const targets = links.map((a) => [a, $(a.getAttribute('href'))]).filter(([, t]) => t);
  let queued = false;
  const spy = () => {
    queued = false;
    const line = window.innerHeight * 0.35;
    let current = null, parent = null;
    for (const [a, t] of targets) {
      if (t.getBoundingClientRect().top > line) break;
      current = a;
      if (!a.parentElement.classList.contains('sub')) parent = a;
    }
    links.forEach((a) => {
      a.classList.toggle('active', a === current);
      a.classList.toggle('within', a === parent && a !== current);
    });
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
  window.addEventListener('resize', spy);
  spy();
  const toggle = $('#theme-toggle');
  const syncToggle = () => {
    const d = isDark();
    toggle.setAttribute('aria-pressed', String(d));
    toggle.setAttribute('aria-label', d ? 'Switch to light theme' : 'Switch to dark theme');
    toggle.title = toggle.getAttribute('aria-label');
    $('.tl', toggle).textContent = d ? 'Light mode' : 'Dark mode';
  };
  if (toggle) {
    syncToggle();
    toggle.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('aa-theme', next); } catch { /* private mode: choice lasts for this page view */ }
      syncToggle();
      themeChanged();
    });
    darkMQ.addEventListener('change', () => { if (!document.documentElement.dataset.theme) { syncToggle(); themeChanged(); } });
  }
  themeChanged();
  const copy = $('#copy-bib');
  if (copy) copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#bibtex').textContent.trim()); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Select & copy'; }
    setTimeout(() => (copy.textContent = 'Copy'), 1600);
  });
}

async function main() {
  initChrome();
  const gl = webglOK();
  if (!gl) $$('.needs-webgl').forEach((el) => (el.hidden = false));
  const data = await (await fetch('assets/data/scenes.json')).json();
  initRooms(data, gl);
  initHouses(data, gl);
  if (gl) requestAnimationFrame(loop);
  window.__viewers = viewers; // for automated checks
}

export { Viewer, fetchModel };
if (document.getElementById('explorer')) main().catch((e) => {
  console.error(e);
  const n = $('#load-error');
  if (n) { n.hidden = false; }
});
