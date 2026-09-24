// ═══════════════════════════════════════════════
//  RACE GATES — padded fabric frames like real MultiGP / air gates:
//  a rounded-square tube with a checkered nylon sleeve (seams + wrinkle
//  normal map), an aluminium pole on a weighted base, a printed number
//  board, and an LED strip along the inner edge that shows the gate state.
//  The LEDs are emissive at HDR intensity, so bloom makes the next gate
//  glow in any light — this replaces the old per-gate PointLight and the
//  stacked additive "fake glow" boxes.
//  Collision is unchanged: the tube fits inside the old box envelope
//  (T_FRAME), so a hit still matches what the pilot sees.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { register, markShared } from './materials.js';

const CORNER_R = 0.32;

// Arc-length parameterised rounded square in the gate's local XY plane.
class RoundedSquareCurve extends THREE.Curve {
  constructor(half, r) {
    super();
    this.half = half; this.r = r;
    this.straight = 2 * (half - r);
    this.arc = Math.PI * r / 2;
    this.total = 4 * (this.straight + this.arc);
  }
  getPoint(t, target = new THREE.Vector3()) {
    const { half, r, straight, arc } = this;
    let s = (t % 1) * this.total;
    // Start at the middle of the right side going up (+Y), counter-clockwise.
    const seg = straight + arc;
    const side = Math.min(3, Math.floor(s / seg));
    s -= side * seg;
    let x, y;
    // Local frame for this side: along = direction of travel, out = outward normal.
    const dirs = [[0, 1], [-1, 0], [0, -1], [1, 0]];
    const outs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const [ax, ay] = dirs[side], [ox, oy] = outs[side];
    // Side midpoint sits at out*half; the straight runs from -straight/2 to +straight/2
    // (shifted so each side starts at its midpoint-minus-half-straight).
    const startOff = -straight / 2;
    if (s <= straight) {
      const a = startOff + s;
      x = ox * half + ax * a; y = oy * half + ay * a;
    } else {
      // Corner arc centred at out*(half-r) + along*(straight/2)
      const cx = ox * (half - r) + ax * (straight / 2), cy = oy * (half - r) + ay * (straight / 2);
      const th = (s - straight) / r;           // 0..pi/2
      x = cx + (ox * Math.cos(th) + ax * Math.sin(th)) * r;
      y = cy + (oy * Math.cos(th) + ay * Math.sin(th)) * r;
    }
    return target.set(x, y, 0);
  }
}

function canvasTexture(cv, srgb) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Checkered sleeve: 2×2 cells per tile, printed-nylon colours, stitched seams
// and faint dye/dirt variation so no two cells read as flat fills.
function makeFabricMaps() {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const cell = S / 2;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    ctx.fillStyle = (x + y) % 2 === 0 ? '#e8580f' : '#1b1b1d';
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
  for (let k = 0; k <= 2; k++) {
    ctx.beginPath(); ctx.moveTo(k * cell, 0); ctx.lineTo(k * cell, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, k * cell); ctx.lineTo(S, k * cell); ctx.stroke();
  }

  // Normal map from a height field: soft pillowing per cell (padded panels),
  // seam grooves and a few diagonal wrinkles.
  const N = 256;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = (x % (N / 2)) / (N / 2), cy = (y % (N / 2)) / (N / 2);
    const pillow = Math.sin(cx * Math.PI) * Math.sin(cy * Math.PI);
    const wr = Math.sin((x + y * 0.6) * 0.18) * 0.08 + Math.sin((x * 0.3 - y) * 0.11) * 0.05;
    h[y * N + x] = pillow * 0.9 + wr;
  }
  const ncv = document.createElement('canvas'); ncv.width = ncv.height = N;
  const nctx = ncv.getContext('2d');
  const nimg = nctx.createImageData(N, N);
  const k = 3.0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const hx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N];
    const hy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    let nx = -hx * k, ny = hy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4;
    nimg.data[i] = (nx * 0.5 + 0.5) * 255; nimg.data[i + 1] = (ny * 0.5 + 0.5) * 255;
    nimg.data[i + 2] = (nz * 0.5 + 0.5) * 255; nimg.data[i + 3] = 255;
  }
  nctx.putImageData(nimg, 0, 0);
  return { map: canvasTexture(cv, true), normalMap: canvasTexture(ncv, false) };
}

function makeNumberTexture(n) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 192;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#141416'; ctx.fillRect(0, 0, 256, 192);
  ctx.strokeStyle = '#e8580f'; ctx.lineWidth = 10; ctx.strokeRect(8, 8, 240, 176);
  ctx.fillStyle = '#f2f2f2';
  ctx.font = 'bold 132px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 104);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export const LED_STATES = {
  upcoming: { color: 0xff5a10, intensity: 1.5 },
  next:     { color: 0xffe21a, intensity: 60 },
  passed:   { color: 0x19ff5a, intensity: 6 },
};

export function createGateKit({ GATE_R, T_FRAME, POST_R }) {
  const frameCurve = new RoundedSquareCurve(GATE_R, CORNER_R);
  const ledCurve = new RoundedSquareCurve(GATE_R - T_FRAME * 0.42, CORNER_R * 0.6);
  const geoFrame = new THREE.TubeGeometry(frameCurve, 240, T_FRAME / 2, 18, true);
  const geoLed = new THREE.TubeGeometry(ledCurve, 240, 0.045, 8, true);
  const geoPole = new THREE.CylinderGeometry(POST_R, POST_R, 1, 14);
  const geoBase = new THREE.CylinderGeometry(0.55, 0.62, 0.07, 24);
  const geoBag = new THREE.CapsuleGeometry(0.16, 0.42, 4, 10);
  geoBag.rotateZ(Math.PI / 2);
  const geoBoard = new THREE.BoxGeometry(1.25, 0.94, 0.05);
  markShared(geoFrame, geoLed, geoPole, geoBase, geoBag, geoBoard);

  const fabric = makeFabricMaps();
  // ~0.5 m checks along the path, two around the tube.
  fabric.map.repeat.set(Math.round(frameCurve.total / 1.0), 1);
  fabric.normalMap.repeat.copy(fabric.map.repeat);
  const matFabric = register(new THREE.MeshStandardMaterial({
    name: 'GateFabric', map: fabric.map, normalMap: fabric.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.62, metalness: 0,
  }));
  const matPole = register(new THREE.MeshStandardMaterial({
    name: 'GatePole', color: 0xb9bec4, roughness: 0.32, metalness: 1.0,
  }));
  const matBase = register(new THREE.MeshStandardMaterial({
    name: 'GateBase', color: 0x2a2c2f, roughness: 0.55, metalness: 0.8,
  }));
  const matBag = register(new THREE.MeshStandardMaterial({
    name: 'Sandbag', color: 0x8a7a58, roughness: 0.95, metalness: 0,
  }));
  const ledMats = {};
  for (const [state, d] of Object.entries(LED_STATES)) {
    ledMats[state] = register(new THREE.MeshStandardMaterial({
      name: 'GateLED_' + state, color: 0x111111, roughness: 0.3,
      emissive: d.color, emissiveIntensity: d.intensity,
    }));
  }
  markShared(matFabric, matPole, matBase, matBag, fabric.map, fabric.normalMap, ...Object.values(ledMats));

  const boardMats = new Map();
  function boardMaterial(n) {
    let m = boardMats.get(n);
    if (!m) {
      const map = markShared(makeNumberTexture(n));
      m = markShared(register(new THREE.MeshStandardMaterial({ name: 'GateBoard', map, roughness: 0.7 })));
      boardMats.set(n, m);
    }
    return m;
  }

  /** Builds one gate group at the origin; the caller positions/rotates it. */
  function build(number, altitude, groundY) {
    const group = new THREE.Group();
    const frame = new THREE.Mesh(geoFrame, matFabric);
    frame.castShadow = frame.receiveShadow = true;
    group.add(frame);
    const led = new THREE.Mesh(geoLed, ledMats.upcoming);
    group.add(led);

    const board = new THREE.Mesh(geoBoard, boardMaterial(number));
    board.position.set(0, GATE_R + T_FRAME / 2 + 0.47 + 0.02, 0);
    board.castShadow = true;
    group.add(board);

    // Pole from the ground to the bottom of the frame.
    const poleLen = Math.max(0.1, altitude - groundY - GATE_R);
    const pole = new THREE.Mesh(geoPole, matPole);
    pole.scale.y = poleLen;
    pole.position.set(0, -GATE_R - poleLen / 2, 0);
    pole.castShadow = pole.receiveShadow = true;
    group.add(pole);

    const baseY = -(altitude - groundY);
    const base = new THREE.Mesh(geoBase, matBase);
    base.position.set(0, baseY + 0.035, 0);
    base.castShadow = base.receiveShadow = true;
    group.add(base);
    for (let k = 0; k < 2; k++) {
      const bag = new THREE.Mesh(geoBag, matBag);
      bag.position.set(0, baseY + 0.2, k ? 0.3 : -0.3);
      bag.rotation.y = (Math.random() - 0.5) * 0.4;
      bag.scale.set(1, 0.72, 1);
      bag.castShadow = bag.receiveShadow = true;
      group.add(bag);
    }
    return { group, led };
  }

  function setState(g, state) {
    g.led.material = ledMats[state] || ledMats.upcoming;
    g.state = state;
  }

  return { build, setState, ledMats };
}
