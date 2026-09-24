// ═══════════════════════════════════════════════
//  TERRAIN — a flying field instead of an infinite flat plane.
//
//  • One mesh, one index-regular grid whose vertices are warped outward:
//    ~3 m spacing across the course, growing smoothly to 3.5 km at the edge,
//    so gentle field relief, rolling hills and a hazy ridge line on the
//    horizon all come from the same seamless surface.
//  • groundAt(x,z) interpolates the SAME triangles the GPU draws, so the
//    drone lands exactly on what the pilot sees.
//  • Shading splats four ambientCG (CC0) PBR sets — lush grass, patchy
//    meadow, dirt, asphalt pad — with two-scale anti-tiling, macro colour
//    variation, and a worn racing line generated from the gate layout.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { register, markShared } from './materials.js';

// ── Noise (CPU) ──
function makePerm(seed) {
  const p = new Uint8Array(512);
  const a = new Uint8Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
}
const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function perlin(perm, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = xi & 255, Y = yi & 255;
  const g = (ix, iy, dx, dy) => { const h = GRAD[perm[ix + perm[iy]] & 7]; return h[0] * dx + h[1] * dy; };
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const n00 = g(X, Y, xf, yf), n10 = g(X + 1, Y, xf - 1, yf);
  const n01 = g(X, Y + 1, xf, yf - 1), n11 = g(X + 1, Y + 1, xf - 1, yf - 1);
  return (n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v;
}
function fbm(perm, x, y, oct) {
  let a = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { a += perlin(perm, x * f, y * f) * amp; f *= 2.03; amp *= 0.5; }
  return a;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Launch pad (asphalt) — a rounded rectangle along Z through the origin.
export const PAD = { hx: 4, hz: 26, r: 1.5 };
function padSdf(x, z) {
  const qx = Math.abs(x) - (PAD.hx - PAD.r), qz = Math.abs(z) - (PAD.hz - PAD.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - PAD.r;
}

// ── Grid warp: index space u∈[-1,1] → world metres ──
const A0 = 0.6, R0 = 360, R1 = 3500, P = 3;
const K0 = R0 / A0, C = (R1 - R0 - K0 * (1 - A0)) / Math.pow(1 - A0, P);
function warp(u) {
  const a = Math.abs(u);
  const r = a <= A0 ? a * K0 : R0 + K0 * (a - A0) + C * Math.pow(a - A0, P);
  return Math.sign(u) * r;
}
function unwarp(x) {
  const r = Math.abs(x);
  if (r <= R0) return Math.sign(x) * r / K0;
  let a = A0 + (r - R0) / K0;                       // Newton from the linear guess
  for (let i = 0; i < 6; i++) {
    const t = a - A0;
    const f = R0 + K0 * t + C * Math.pow(t, P) - r;
    const df = K0 + P * C * Math.pow(t, P - 1);
    a -= f / df;
  }
  return Math.sign(x) * Math.min(a, 1);
}

// ── GPU noise texture: 4 independent tileable fbm channels ──
function makeNoiseTexture() {
  const N = 256, data = new Uint8Array(N * N * 4);
  const perms = [11, 23, 37, 59].map(makePerm);
  for (let c = 0; c < 4; c++) {
    const perm = perms[c], period = [8, 16, 12, 24][c];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // Tileable: lattice coordinates wrap at `period` via modulo in the perm lookup.
      let v = 0, amp = 0.5, f = period;
      for (let o = 0; o < 4; o++) {
        const px = x / N * f, py = y / N * f;
        const xi = Math.floor(px), yi = Math.floor(py);
        const xf = px - xi, yf = py - yi;
        const w = (ix, iy) => perm[(((ix % f) + f) % f) + perm[(((iy % f) + f) % f)]] / 255;
        const u = xf * xf * (3 - 2 * xf), t = yf * yf * (3 - 2 * yf);
        const a = w(xi, yi), b = w(xi + 1, yi), d = w(xi, yi + 1), e = w(xi + 1, yi + 1);
        v += ((a + (b - a) * u) + ((d + (e - d) * u) - (a + (b - a) * u)) * t) * amp;
        amp *= 0.5; f *= 2;
      }
      data[(y * N + x) * 4 + c] = Math.min(255, Math.max(0, v / 0.9375 * 255));
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}

// ── Splat shader patch ──
const LAYERS = ['grass', 'meadow', 'dirt', 'asphalt'];
const WEAR_SIZE = 256, WEAR_EXTENT = 200;   // wear mask covers 200×200 m around the origin
const LAND_SIZE = 512, LAND_EXTENT = 3200;  // land-cover map (forest density) over the whole valley

const TERRAIN_VERT_PARS = `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;`;
const TERRAIN_VERT = `
vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`;

const TERRAIN_FRAG_PARS = `
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
uniform sampler2D tAlb0; uniform sampler2D tAlb1; uniform sampler2D tAlb2; uniform sampler2D tAlb3;
uniform sampler2D tNr0; uniform sampler2D tNr1; uniform sampler2D tNr2; uniform sampler2D tNr3;
uniform sampler2D tNoise;
uniform sampler2D tWear;
uniform sampler2D tLand;
uniform float uLandExtent;
uniform vec4 uScales;
uniform vec3 uPad;          // half-x, half-z, corner radius
uniform float uWearExtent;
struct TLayer { vec3 alb; vec3 n; float rough; float h; };
float tPadSdf(vec2 p){
  vec2 q = abs(p) - (uPad.xy - uPad.z);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uPad.z;
}
mat2 tRot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
// Explicit gradients: layers are sampled inside branches (skipped where their
// weight is zero), where implicit derivatives — and so mip selection — are undefined.
TLayer tSample(sampler2D alb, sampler2D nr, vec2 wp, vec2 dx, vec2 dy, float scale, float mixN){
  vec2 uv1 = wp / scale;
  vec4 a1 = textureGrad(alb, uv1, dx / scale, dy / scale), n1 = textureGrad(nr, uv1, dx / scale, dy / scale);
  TLayer L;
#ifdef TERRAIN_ANTITILE
  mat2 R = tRot(0.83); float s2 = scale * 2.71;
  vec2 uv2 = R * wp / s2 + 0.37;
  vec4 a2 = textureGrad(alb, uv2, R * dx / s2, R * dy / s2), n2 = textureGrad(nr, uv2, R * dx / s2, R * dy / s2);
  float m = smoothstep(0.3, 0.7, mixN);
  a1 = mix(a1, a2, m); n1 = mix(n1, n2, m);
#endif
  L.alb = a1.rgb;
  vec2 nxy = n1.rg * 2.0 - 1.0;
  L.n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
  L.rough = n1.b;
  L.h = dot(a1.rgb, vec3(0.3333));
  return L;
}`;

const TERRAIN_MAP_FRAG = `
vec2 twp = vTerrainPos.xz;
vec2 tdx = dFdx(twp), tdy = dFdy(twp);
vec4 nz0 = texture2D(tNoise, twp / 173.0);
vec4 nz1 = texture2D(tNoise, twp / 41.0 + 0.19);
vec4 nz2 = texture2D(tNoise, twp / 613.0 + 0.61);
float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
vec2 wuv = twp / uWearExtent + 0.5;
float wear = texture2D(tWear, clamp(wuv, 0.0, 1.0)).r * step(0.0, wuv.x) * step(wuv.x, 1.0) * step(0.0, wuv.y) * step(wuv.y, 1.0);
float padD = tPadSdf(twp);
float forest = texture2D(tLand, twp / uLandExtent + 0.5).r;
float camDist = length(vTerrainPos - cameraPosition);

float wGrass = 1.0;
float wMeadow = smoothstep(0.55, 0.78, nz0.r * 0.65 + nz2.g * 0.55 - 0.08) * 0.8;
float wDirt = smoothstep(0.66, 0.84, nz1.b * 0.7 + nz0.a * 0.45) * 0.45 + wear + smoothstep(0.25, 0.5, slope)
            + forest * 0.55;                                   // leaf litter under the woods
wDirt += (1.0 - smoothstep(0.0, 2.2, padD)) * 0.8;      // scuffed verge round the pad
float wAsph = 1.0 - smoothstep(-0.05, 0.05, padD);

TLayer lg = tSample(tAlb0, tNr0, twp, tdx, tdy, uScales.x, nz1.r);
TLayer lm; lm.alb = vec3(0.0); lm.n = vec3(0.0, 0.0, 1.0); lm.rough = 1.0; lm.h = 0.0;
TLayer ld = lm; TLayer la = lm;
if (wMeadow > 0.002) lm = tSample(tAlb1, tNr1, twp, tdx, tdy, uScales.y, nz1.g);
if (wDirt > 0.002) ld = tSample(tAlb2, tNr2, twp, tdx, tdy, uScales.z, nz1.a);
if (wAsph > 0.002) la = tSample(tAlb3, tNr3, twp, tdx, tdy, uScales.w, 0.0);

// Height-aware blending: the higher texel "wins" near a transition, which
// breaks up the soft noise edge into grass tufts poking through dirt.
float bG = wGrass * (1.0 - clamp(wMeadow + wDirt, 0.0, 1.0)) + 1e-3;
float bM = wMeadow * (1.0 - clamp(wDirt, 0.0, 1.0));
float bD = clamp(wDirt, 0.0, 1.0);
bG *= 0.6 + lg.h; bM *= 0.6 + lm.h; bD *= 0.6 + ld.h * 1.4;
float bs = bG + bM + bD;
bG /= bs; bM /= bs; bD /= bs;
vec3 tAlb = lg.alb * bG + lm.alb * bM + ld.alb * bD;
vec3 tN = lg.n * bG + lm.n * bM + ld.n * bD;
float tRough = lg.rough * bG + lm.rough * bM + ld.rough * bD;

// Painted lines on the pad: edges and a dashed centre line.
if (wAsph > 0.002) {
  float edge = step(abs(abs(twp.x) - (uPad.x - 0.35)), 0.06) * step(abs(twp.y), uPad.y - 0.8);
  float dash = step(abs(twp.x), 0.06) * step(0.5, fract(twp.y / 3.0)) * step(abs(twp.y), uPad.y - 2.0);
  float startLine = step(abs(twp.y + uPad.y * 0.55), 0.12) * step(abs(twp.x), uPad.x - 0.6);
  float paint = max(max(edge, dash), startLine) * (0.75 + 0.25 * nz1.r);
  la.alb = mix(la.alb, vec3(0.78), paint);
  la.rough = mix(la.rough, 0.55, paint);
  tAlb = mix(tAlb, la.alb, wAsph);
  tN = mix(tN, la.n, wAsph);
  tRough = mix(tRough, la.rough, wAsph);
}

// Macro variation: slow brightness/hue drift so the field never reads as one tile.
float macro = nz2.r * 0.7 + nz0.g * 0.3;
tAlb *= mix(0.8, 1.08, macro);
tAlb = mix(tAlb, tAlb * vec3(0.86, 1.02, 0.8), smoothstep(0.35, 0.75, nz0.b) * (1.0 - wAsph) * 0.5);   // lusher patches
tAlb = mix(tAlb, tAlb * vec3(1.1, 1.03, 0.8), smoothstep(0.62, 0.9, nz2.b) * (1.0 - wAsph) * 0.35);  // dry patches
// Woods seen from afar: individual trees shrink below a pixel, so the canopy
// colour takes over the ground (forest impostors cover the middle distance).
float canopy = forest * smoothstep(160.0, 650.0, camDist);
tAlb = mix(tAlb, vec3(0.085, 0.12, 0.055) * mix(0.75, 1.3, nz1.g), canopy);
tRough = mix(tRough, 0.95, canopy);
// Grass and soil are rough and self-shadowing; a clamp keeps the grazing sky
// reflection (which read as a silvery sheen looking into the sun) in check.
tRough = max(tRough, mix(0.72, 0.35, wAsph));
diffuseColor.rgb *= tAlb;`;

const TERRAIN_ROUGH_FRAG = `
float roughnessFactor = clamp(roughness * tRough, 0.04, 1.0);`;

const TERRAIN_NORMAL_FRAG = `
{
  vec3 Nw = normalize(vTerrainNormal);
  vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
  vec3 Bw = cross(Tw, Nw);
  vec3 tn = normalize(tN * vec3(1.0, 1.0, 1.4));
  vec3 nw = normalize(Tw * tn.x + Bw * tn.y + Nw * tn.z);
  normal = normalize(mat3(viewMatrix) * nw);
}`;

export class Terrain {
  constructor({ segments = 400, seed = 1337 }) {
    this.N = segments;
    this.perm = makePerm(seed);
    this.perm2 = makePerm(seed * 7 + 3);
    const N = this.N, V = N + 1;

    // Axis coordinates (world metres) — shared by X and Z.
    this.axis = new Float64Array(V);
    for (let i = 0; i < V; i++) this.axis[i] = warp(i / N * 2 - 1);

    this.heights = new Float32Array(V * V);
    const pos = new Float32Array(V * V * 3);
    const nrm = new Float32Array(V * V * 3);
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const x = this.axis[i], z = this.axis[j];
      const h = this.heightAt(x, z);
      const k = j * V + i;
      this.heights[k] = h;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
    }
    // Normals from the height grid itself (central differences on the real,
    // non-uniform spacing) — consistent with the triangles, and 5× cheaper
    // than re-evaluating the noise around every vertex.
    const H = this.heights, ax = this.axis;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, N), j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, N);
      const sx = (H[j * V + i1] - H[j * V + i0]) / (ax[i1] - ax[i0]);
      const sz = (H[j1 * V + i] - H[j0 * V + i]) / (ax[j1] - ax[j0]);
      const l = Math.hypot(sx, 1, sz), k = (j * V + i) * 3;
      nrm[k] = -sx / l; nrm[k + 1] = 1 / l; nrm[k + 2] = -sz / l;
    }
    // Cell (i,j): a=(i,j) b=(i+1,j) c=(i,j+1) d=(i+1,j+1); triangles (a,c,b) and (b,c,d).
    const idx = new Uint32Array(N * N * 6);
    let t = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    this.noise = makeNoiseTexture();
    this.wear = new THREE.DataTexture(new Uint8Array(WEAR_SIZE * WEAR_SIZE), WEAR_SIZE, WEAR_SIZE, THREE.RedFormat);
    this.wear.magFilter = this.wear.minFilter = THREE.LinearFilter;
    this.wear.needsUpdate = true;

    this.perm3 = makePerm(seed * 13 + 5);
    this.landcover = this._buildLandcover();
    const uniforms = {
      tNoise: { value: this.noise }, tWear: { value: this.wear },
      tLand: { value: this.landcover }, uLandExtent: { value: LAND_EXTENT },
      uScales: { value: new THREE.Vector4(2.4, 3.1, 2.7, 3.6) },
      uPad: { value: new THREE.Vector3(PAD.hx, PAD.hz, PAD.r) },
      uWearExtent: { value: WEAR_EXTENT },
    };
    // Textures arrive asynchronously (setTextures); a neutral 1×1 stands in.
    const blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
    LAYERS.forEach((name, i) => {
      uniforms['tAlb' + i] = { value: blank };
      uniforms['tNr' + i] = { value: blank };
    });
    this.uniforms = uniforms;
    const antiTile = segments >= 300;
    const mat = new THREE.MeshStandardMaterial({ name: 'Terrain', color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.8 });
    register(mat, [{
      key: 'terrain' + (antiTile ? 'AT' : ''),
      fn: shader => {
        Object.assign(shader.uniforms, uniforms);
        if (antiTile) shader.defines = Object.assign(shader.defines || {}, { TERRAIN_ANTITILE: 1 });
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + TERRAIN_VERT_PARS)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + TERRAIN_VERT);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + TERRAIN_FRAG_PARS)
          .replace('#include <map_fragment>', TERRAIN_MAP_FRAG)
          .replace('#include <roughnessmap_fragment>', TERRAIN_ROUGH_FRAG)
          .replace('#include <normal_fragment_maps>', TERRAIN_NORMAL_FRAG);
      },
    }]);
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'Terrain';
    markShared(geo, mat);
  }

  /**
   * Forest density 0..1 at (x,z). The course stays open; woods start ~150 m
   * out. Shared by the terrain shader (distant canopy colour) and the tree
   * scatter (render/vegetation.js), so they always agree.
   */
  forestAt(x, z) {
    const r = Math.hypot(x, z);
    let f = fbm(this.perm3, x / 190 + 1.7, z / 190 - 4.2, 4) * 2.4 + 0.08;
    f = smooth(0.0, 0.32, f);
    return f * smooth(135, 240, r);
  }

  _buildLandcover() {
    const S = LAND_SIZE, data = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const wx = ((x + 0.5) / S - 0.5) * LAND_EXTENT, wz = ((y + 0.5) / S - 0.5) * LAND_EXTENT;
      data[y * S + x] = this.forestAt(wx, wz) * 255;
    }
    const t = new THREE.DataTexture(data, S, S, THREE.RedFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Height field for GPU-placed geometry (grass): groundAt() sampled on a
   * regular grid, so bilinear lookups sit on the rendered triangles to ~cm.
   */
  makeHeightTexture(extent = 420, size = 512) {
    const data = new Uint16Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const wx = ((x + 0.5) / size - 0.5) * extent, wz = ((y + 0.5) / size - 0.5) * extent;
      data[y * size + x] = THREE.DataUtils.toHalfFloat(this.groundAt(wx, wz));
    }
    const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return { texture: t, extent };
  }

  setTextures(textures) {
    this.textures = textures;
    LAYERS.forEach((name, i) => {
      this.uniforms['tAlb' + i].value = textures[name].albedo;
      this.uniforms['tNr' + i].value = textures[name].nr;
    });
  }

  /** Analytic height (m). Used to build the mesh and to place objects. */
  heightAt(x, z) {
    const r = Math.hypot(x, z);
    let h = fbm(this.perm, x / 48, z / 48, 3) * 0.9;                                   // field relief ±~0.4 m
    h += fbm(this.perm2, x / 270 + 5.3, z / 270 - 2.1, 4) * 26 * smooth(100, 420, r);   // rolling hills
    const rid = 1 - Math.abs(fbm(this.perm2, x / 1100 - 3.1, z / 1100 + 7.7, 4) * 2);   // ridge line
    h += (rid * rid * 190 + 25) * smooth(700, 1900, r);
    const pad = 1 - smooth(0, 7, padSdf(x, z));
    return h * (1 - pad);
  }

  /** 0 on lush grass … 1 on asphalt / trampled dirt (how much dust the prop wash lifts). */
  bareAt(x, z) {
    if (padSdf(x, z) < 0.5) return 1;
    const S = WEAR_SIZE, u = Math.floor((x / WEAR_EXTENT + 0.5) * S), v = Math.floor((z / WEAR_EXTENT + 0.5) * S);
    const w = (u >= 0 && v >= 0 && u < S && v < S) ? this.wear.image.data[v * S + u] / 255 : 0;
    return 0.15 + 0.85 * w;
  }

  /** Exact surface height of the rendered triangles at (x,z). */
  groundAt(x, z) {
    const N = this.N, V = N + 1, ax = this.axis;
    const gi = (unwarp(x) + 1) / 2 * N, gj = (unwarp(z) + 1) / 2 * N;
    let i = Math.floor(gi), j = Math.floor(gj);
    if (i < 0 || j < 0 || i >= N || j >= N) return this.heightAt(x, z);
    const fx = (x - ax[i]) / (ax[i + 1] - ax[i]), fz = (z - ax[j]) / (ax[j + 1] - ax[j]);
    const h = this.heights;
    const ha = h[j * V + i], hb = h[j * V + i + 1], hc = h[(j + 1) * V + i], hd = h[(j + 1) * V + i + 1];
    if (fx + fz <= 1) return ha + (hb - ha) * fx + (hc - ha) * fz;
    return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  /**
   * Paint the worn racing line: segments between consecutive gates plus a
   * trampled patch at each gate base and the pilots' spot behind the pad.
   */
  setWear(gatePositions) {
    const S = WEAR_SIZE, E = WEAR_EXTENT, buf = new Float32Array(S * S);
    const toPx = v => (v / E + 0.5) * S;
    const stamp = (cx, cz, radius, strength) => {
      const px = toPx(cx), pz = toPx(cz), rp = radius / E * S;
      for (let y = Math.max(0, Math.floor(pz - rp)); y <= Math.min(S - 1, Math.ceil(pz + rp)); y++)
        for (let x = Math.max(0, Math.floor(px - rp)); x <= Math.min(S - 1, Math.ceil(px + rp)); x++) {
          const d = Math.hypot(x - px, y - pz) / rp;
          if (d < 1) { const k = y * S + x; buf[k] = Math.max(buf[k], strength * (1 - d * d)); }
        }
    };
    const n = gatePositions.length;
    for (let g = 0; g < n; g++) {
      const a = gatePositions[g], b = gatePositions[(g + 1) % n];
      stamp(a.x, a.z, 2.6, 0.95);
      const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.ceil(len / 1.5);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        // Slight wobble so the line isn't ruler-straight.
        const off = Math.sin(t * Math.PI * 2 + g) * 1.2;
        const nx = -(b.z - a.z) / (len || 1), nz = (b.x - a.x) / (len || 1);
        stamp(a.x + (b.x - a.x) * t + nx * off, a.z + (b.z - a.z) * t + nz * off, 2.2, 0.28);
      }
    }
    stamp(0, PAD.hz + 5, 5, 0.9);          // pilots' tent area at the end of the pad
    const data = this.wear.image.data;
    for (let k = 0; k < S * S; k++) data[k] = Math.min(255, buf[k] * 255);
    this.wear.needsUpdate = true;
  }
}

/** Loads the four packed ambientCG sets (albedo + normal/roughness). */
export async function loadTerrainTextures(renderer, res = '1k') {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const load = (url, srgb) => new Promise((resolve, reject) => loader.load(url, t => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    markShared(t);
    resolve(t);
  }, undefined, reject));
  const out = {};
  await Promise.all(LAYERS.map(async name => {
    const [albedo, nr] = await Promise.all([
      load(`assets/textures/${name}_albedo_${res}.jpg`, true),
      load(`assets/textures/${name}_nr_${res}.jpg`, false),
    ]);
    out[name] = { albedo, nr };
  }));
  return out;
}
