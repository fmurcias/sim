// ═══════════════════════════════════════════════
//  TREES — procedural species (ez-tree, MIT) instead of cone-on-a-stick.
//
//  • A handful of seeded variants (oak, ash, aspen, pine, bushes) are grown
//    once at load, re-materialed with registered PBR materials (cascaded
//    shadows, height fog, wind sway, back-lit leaf translucency) and drawn
//    instanced.
//  • Each variant is also baked into an impostor atlas (albedo + normals):
//    trees beyond LOD distance — and the thousands in the surrounding woods —
//    are lit, shadow-casting camera-facing cards.
//  • Colliders (trunk + canopy cylinders) are measured from each variant's
//    real geometry and scaled per instance; a spatial hash keeps the crash
//    test to the few trees near the drone.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { register, markShared } from './materials.js';

// The ez-tree presets are sparse (bare-looking pines, thin crowns); leaf
// counts/sizes are raised so the crowns read as healthy summer trees.
const VARIANTS = [
  { preset: 'Oak Medium',   seed: 1107, height: 12.5, leaf: 'oak',   collide: true, leafCount: 1.6, leafSize: 1.15 },
  { preset: 'Oak Medium',   seed: 2293, height: 11.0, leaf: 'oak',   collide: true, leafCount: 1.6, leafSize: 1.15 },
  { preset: 'Ash Medium',   seed: 3341, height: 13.5, leaf: 'ash',   collide: true, leafCount: 2.0, leafSize: 1.3 },
  { preset: 'Aspen Medium', seed: 4127, height: 14.5, leaf: 'aspen', collide: true, leafCount: 3.2, leafSize: 1.35, tint: 0xb4dc8c },
  { preset: 'Pine Medium',  seed: 5051, height: 16.0, leaf: 'pine',  collide: true, leafCount: 3.5, leafSize: 1.7 },
  { preset: 'Pine Medium',  seed: 6173, height: 13.0, leaf: 'pine',  collide: true, leafCount: 3.5, leafSize: 1.7 },
  { preset: 'Bush 1',       seed: 7019, height: 1.7,  leaf: 'bush',  collide: false },
  { preset: 'Bush 2',       seed: 8111, height: 1.3,  leaf: 'bush',  collide: false },
];
const TREE_VARIANTS = [0, 1, 2, 3, 4, 5];      // indices used for full-size trees
const BUSH_VARIANTS = [6, 7];

const CELL_W = 256, CELL_H = 512;              // impostor atlas cell (px)

// Shared, per-frame uniforms for everything that moves in the wind or glows
// when back-lit.
export const vegUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uWindStrength: { value: 1.0 },
  uSunViewDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunRadiance: { value: new THREE.Color(0, 0, 0) },
};

const WIND_PARS = `
uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;`;
function windChunk(flutter, heightRef) {
  return `
{
#ifdef USE_INSTANCING
  vec3 iOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 iOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif
  float hN = clamp(transformed.y / ${heightRef.toFixed(1)}, 0.0, 1.4);
  float ph = dot(iOrigin.xz, vec2(0.131, 0.173));
  float gust = 0.6 + 0.4 * sin(uTime * 0.31 + ph * 0.2);
  float sway = (sin(uTime * 1.25 + ph) * 0.6 + sin(uTime * 2.07 + ph * 1.7) * 0.3) * gust;
  transformed.xz += uWindDir * sway * uWindStrength * hN * hN * 0.28;
  ${flutter ? `float fl = sin(uTime * 7.3 + dot(transformed, vec3(3.1, 2.3, 4.7)) + ph) * 0.035 * uWindStrength * hN;
  transformed += vec3(fl, fl * 0.5, -fl);` : ''}
}`;
}

// Back-lit translucency: leaves (and grass) glow when the sun shines through
// them toward the camera — the single most "photographic" foliage cue.
const TRANS_PARS = `
uniform vec3 uSunViewDir; uniform vec3 uSunRadiance;`;
const TRANS_FRAG = (k) => `
#include <emissivemap_fragment>
{
  vec3 Vv = normalize(vViewPosition);
  float back = pow(max(dot(-Vv, uSunViewDir), 0.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSunRadiance * back * ${k.toFixed(3)};
}`;

function foliagePatch(key, { wind, flutter, heightRef, trans }) {
  return {
    key,
    fn: shader => {
      Object.assign(shader.uniforms, vegUniforms);
      if (wind) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + WIND_PARS)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + windChunk(flutter, heightRef));
      }
      if (trans) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + TRANS_PARS)
          .replace('#include <emissivemap_fragment>', TRANS_FRAG(trans));
      }
    },
  };
}

// Depth material for shadow casting from alpha-tested, wind-swayed foliage.
function foliageDepthMaterial(map, heightRef, flutter) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5 });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, vegUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + windChunk(flutter, heightRef));
  };
  m.customProgramCacheKey = () => 'folDepth' + heightRef + flutter;
  return m;
}

// ── Impostor (billboard) shader patches ──
// The card turns about its vertical axis to face whoever is rendering it —
// the player's camera in the colour pass, the sun's shadow camera in the
// depth pass (so the shadow is the crown's silhouette as seen from the sun).
const BILLBOARD_PARS = `
attribute float aCell;
uniform float uCells;
vec3 bbFacing(vec3 origin){
  vec3 d = cameraPosition - origin; d.y = 0.0;
  return length(d) > 1e-4 ? normalize(d) : vec3(0.0, 0.0, 1.0);
}`;
const BILLBOARD_BEGIN = `
#include <begin_vertex>
vec3 bbOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
vec3 bbToCam = bbFacing(bbOrigin);
vec3 bbRight = vec3(bbToCam.z, 0.0, -bbToCam.x);
float bbW = length(instanceMatrix[0].xyz), bbH = length(instanceMatrix[1].xyz);
vec3 bbWorld = bbOrigin + bbRight * transformed.x * bbW + vec3(0.0, transformed.y * bbH, 0.0);`;
const BILLBOARD_PROJECT = `
vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);
gl_Position = projectionMatrix * mvPosition;`;
const BILLBOARD_WORLDPOS = `
vec4 worldPosition = vec4(bbWorld, 1.0);`;
const BILLBOARD_UV = `
#include <uv_vertex>
#ifdef USE_MAP
vMapUv.x = (aCell + vMapUv.x) / uCells;
#endif
#ifdef USE_NORMALMAP
vNormalMapUv.x = (aCell + vNormalMapUv.x) / uCells;
#endif`;
const BILLBOARD_NORMAL = `
vec3 transformedNormal = (viewMatrix * vec4(bbFacing((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz), 0.0)).xyz;
#ifdef FLIP_SIDED
transformedNormal = -transformedNormal;
#endif`;

function billboardPatch(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + BILLBOARD_PARS)
    .replace('#include <uv_vertex>', BILLBOARD_UV)
    .replace('#include <begin_vertex>', BILLBOARD_BEGIN)
    .replace('#include <project_vertex>', BILLBOARD_PROJECT)
    .replace('#include <worldpos_vertex>', BILLBOARD_WORLDPOS)
    .replace('#include <defaultnormal_vertex>', BILLBOARD_NORMAL);
}

function waitForTextures(textures) {
  return new Promise(resolve => {
    const check = () => textures.every(t => t && t.image && (t.image.width || t.image.naturalWidth)) ? resolve() : setTimeout(check, 30);
    check();
  });
}

function unpremultiplied(tex) {
  const t = tex.clone();
  t.premultiplyAlpha = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return markShared(t);
}

// Horizontal-distance percentile helper for collider fitting.
function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

export class Vegetation {
  constructor({ renderer, scene, tier }) {
    this.renderer = renderer;
    this.scene = scene;
    this.tier = tier;
    this.variants = [];
    this.trees = [];          // {v, x, y, z, s, rot, col}
    this.forest = [];         // static far trees (same shape as trees)
    this.hash = new Map();
    this.visible = true;
    this.fullMeshes = [];
    this.lodTimer = 0;
    this.lodFull = tier.treeDetail >= 2 ? 70 : 42;
    this.maxFull = tier.treeDetail >= 2 ? 60 : 30;
    this.ready = null;
  }

  async init() {
    const t0 = performance.now();
    // Grow the variants.
    const trees = VARIANTS.map(def => {
      const t = new Tree();
      t.loadPreset(def.preset);
      t.options.seed = def.seed;
      if (def.leafCount) t.options.leaves.count = Math.round(t.options.leaves.count * def.leafCount);
      if (def.leafSize) t.options.leaves.size *= def.leafSize;
      if (def.tint) t.options.leaves.tint = def.tint;
      t.generate();
      return t;
    });
    const srcTex = [];
    trees.forEach(t => {
      const b = t.branchesMesh.material, l = t.leavesMesh.material;
      [b.map, b.normalMap, b.aoMap, l.map].forEach(x => x && srcTex.push(x));
    });
    await waitForTextures(srcTex);

    const leafMats = new Map(), barkMats = new Map();
    trees.forEach((t, i) => {
      const def = VARIANTS[i];
      const bg = t.branchesMesh.geometry, lg = t.leavesMesh.geometry;
      bg.computeBoundingBox(); lg.computeBoundingBox();
      const box = new THREE.Box3().union(bg.boundingBox).union(lg.boundingBox);
      const k = def.height / Math.max(0.01, box.max.y - box.min.y);
      const shift = -box.min.y;
      for (const g of [bg, lg]) { g.translate(0, shift, 0); g.scale(k, k, k); g.computeBoundingSphere(); g.computeBoundingBox(); }
      markShared(bg, lg);

      // Collider fit from the real geometry.
      const bp = bg.attributes.position, lp = lg.attributes.position;
      const trunkR = [], leafR = [], leafY = [];
      for (let n = 0; n < bp.count; n++) if (bp.getY(n) < def.height * 0.12) trunkR.push(Math.hypot(bp.getX(n), bp.getZ(n)));
      let cx = 0, cz = 0;
      for (let n = 0; n < lp.count; n++) { cx += lp.getX(n); cz += lp.getZ(n); leafY.push(lp.getY(n)); }
      cx /= Math.max(1, lp.count); cz /= Math.max(1, lp.count);
      for (let n = 0; n < lp.count; n++) leafR.push(Math.hypot(lp.getX(n) - cx, lp.getZ(n) - cz));
      const col = {
        trunkR: THREE.MathUtils.clamp(percentile(trunkR, 0.9), 0.12, 0.7),
        canopyR: percentile(leafR, 0.8),
        canopyBot: percentile(leafY, 0.08),
        canopyTop: percentile(leafY, 0.98),
        cx, cz,
      };
      const radius = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * k;

      const bSrc = t.branchesMesh.material, lSrc = t.leavesMesh.material;
      const barkKey = bSrc.map ? bSrc.map.uuid : 'plain';
      if (!barkMats.has(barkKey)) {
        const m = new THREE.MeshStandardMaterial({
          name: 'Bark', map: bSrc.map, normalMap: bSrc.normalMap, aoMap: bSrc.aoMap,
          color: bSrc.color, roughness: 0.92, metalness: 0,
        });
        register(m, [foliagePatch('bark', { wind: true, flutter: false, heightRef: 12, trans: 0 })]);
        markShared(m);
        barkMats.set(barkKey, m);
      }
      const leafKey = lSrc.map ? lSrc.map.uuid : def.leaf;
      if (!leafMats.has(leafKey)) {
        const map = unpremultiplied(lSrc.map);
        const m = new THREE.MeshStandardMaterial({
          name: 'Leaves', map, color: lSrc.color, side: THREE.DoubleSide, alphaTest: 0.5,
          alphaToCoverage: (this.tier.msaa || 0) > 0, roughness: 0.72, metalness: 0,
        });
        register(m, [foliagePatch('leaves', { wind: true, flutter: true, heightRef: 12, trans: 0.22 })]);
        markShared(m);
        leafMats.set(leafKey, { mat: m, depth: markShared(foliageDepthMaterial(map, 12, true)) });
      }
      const leaf = leafMats.get(leafKey);
      this.variants.push({
        def, bark: barkMats.get(barkKey), leaf: leaf.mat, leafDepth: leaf.depth,
        branchGeo: bg, leafGeo: lg, col, radius, height: def.height,
        tris: (bg.index.count + lg.index.count) / 3,
      });
      t.branchesMesh.material.dispose(); t.leavesMesh.material.dispose();
    });

    this._bakeImpostors();
    this._buildMeshes();
    this.initMs = performance.now() - t0;
    return this;
  }

  // ── Impostor atlas bake ──
  _bakeImpostors() {
    const r = this.renderer, V = this.variants.length;
    const W = CELL_W * V, H = CELL_H;
    const albedoRT = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace });
    albedoRT.texture.generateMipmaps = true;
    albedoRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const normalRT = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true });
    normalRT.texture.generateMipmaps = true;
    normalRT.texture.minFilter = THREE.LinearMipmapLinearFilter;

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const prevTarget = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    const normalMat = (map, canopyCenter, isLeaf) => new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uCenter: { value: canopyCenter }, uLeaf: { value: isLeaf ? 1 : 0 } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 uCenter; uniform float uLeaf; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main(){ if (texture2D(map, vUv).a < 0.5) discard;
          vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
          // Leaves: blend toward a canopy-sphere normal so the far card shades like a crown, not flat cards.
          vec3 sph = normalize((viewMatrix * vec4(normalize(vW - uCenter), 0.0)).xyz);
          n = normalize(mix(n, sph, uLeaf * 0.6));
          gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }`,
      side: THREE.DoubleSide,
    });
    const albedoMat = (map, color, canopyCenter, R, isLeaf) => new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uColor: { value: new THREE.Color(color) }, uCenter: { value: canopyCenter }, uR: { value: R }, uLeaf: { value: isLeaf ? 1 : 0 } },
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 uColor; uniform vec3 uCenter; uniform float uR; uniform float uLeaf; varying vec2 vUv; varying vec3 vW;
        void main(){ vec4 t = texture2D(map, vUv); if (t.a < 0.5) discard;
          // Baked crown occlusion: leaves deep inside the canopy are darker.
          float ao = mix(1.0, mix(0.45, 1.0, smoothstep(0.0, uR, length(vW - uCenter))), uLeaf);
          gl_FragColor = vec4(t.rgb * uColor * ao, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
    });

    const bakeMats = [];
    this.variants.forEach((v, i) => {
      const c = v.col;
      const center = new THREE.Vector3(c.cx, (c.canopyBot + c.canopyTop) / 2, c.cz);
      const R = Math.max(c.canopyR, 0.5);
      const bark = v.bark, leafMap = v.leaf.map;
      const meshesAlb = [
        new THREE.Mesh(v.branchGeo, albedoMat(bark.map || leafMap, bark.color, center, R, false)),
        new THREE.Mesh(v.leafGeo, albedoMat(leafMap, v.leaf.color, center, R, true)),
      ];
      const meshesNrm = [
        new THREE.Mesh(v.branchGeo, normalMat(bark.map || leafMap, center, false)),
        new THREE.Mesh(v.leafGeo, normalMat(leafMap, center, true)),
      ];
      bakeMats.push(...meshesAlb.map(m => m.material), ...meshesNrm.map(m => m.material));
      const half = v.radius * 1.02;
      cam.left = -half; cam.right = half; cam.top = v.height * 1.02; cam.bottom = 0;
      cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0); cam.position.y = 0;
      cam.updateProjectionMatrix();
      v.card = { w: half * 2, h: v.height * 1.02 };

      // Transparent texels keep a foliage/flat-normal colour so mipmaps don't
      // bleed black halos around the cards.
      const clearAlb = new THREE.Color(0x2e3a22);
      const clearNrm = new THREE.Color().setRGB(0.5, 0.5, 1.0, THREE.LinearSRGBColorSpace);
      for (const [rt, meshes, clear, alpha] of [[albedoRT, meshesAlb, clearAlb, 0], [normalRT, meshesNrm, clearNrm, 0]]) {
        scene.clear(); meshes.forEach(m => scene.add(m));
        rt.viewport.set(i * CELL_W, 0, CELL_W, CELL_H);
        rt.scissor.set(i * CELL_W, 0, CELL_W, CELL_H);
        rt.scissorTest = true;
        r.setRenderTarget(rt);
        r.setClearColor(clear, alpha);
        r.clear();
        r.render(scene, cam);
      }
    });
    albedoRT.scissorTest = normalRT.scissorTest = false;
    albedoRT.viewport.set(0, 0, W, H); normalRT.viewport.set(0, 0, W, H);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.toneMapping = prevTone;
    bakeMats.forEach(m => m.dispose());

    this.albedoRT = albedoRT; this.normalRT = normalRT;
    const cells = { uCells: { value: V } };
    const mat = new THREE.MeshStandardMaterial({
      name: 'Impostor', map: albedoRT.texture, normalMap: normalRT.texture, alphaTest: 0.5,
      alphaToCoverage: (this.tier.msaa || 0) > 0, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
    });
    register(mat, [{ key: 'impostor', fn: sh => billboardPatch(sh, cells) },
      foliagePatch('impTrans', { wind: false, trans: 0.15 })]);
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: albedoRT.texture, alphaTest: 0.5 });
    depth.onBeforeCompile = sh => billboardPatch(sh, cells);
    depth.customProgramCacheKey = () => 'impDepth';
    this.impostorMat = markShared(mat);
    this.impostorDepth = markShared(depth);
  }

  _buildMeshes() {
    // Full-detail instanced meshes per variant (filled by the LOD pass).
    this.variants.forEach(v => {
      const bark = new THREE.InstancedMesh(v.branchGeo, v.bark, this.maxFull);
      const leaves = new THREE.InstancedMesh(v.leafGeo, v.leaf, this.maxFull);
      leaves.customDepthMaterial = v.leafDepth;
      for (const m of [bark, leaves]) {
        m.count = 0; m.castShadow = true; m.receiveShadow = true;
        m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(m);
      }
      v.full = { bark, leaves };
    });
    // One impostor mesh for everything else (course trees far away + woods).
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    markShared(quad);
    this.impostorGeo = quad;
    this.impostorCap = 0;
    this._ensureImpostorCapacity(1024);
  }

  _ensureImpostorCapacity(n) {
    if (n <= this.impostorCap) return;
    const cap = Math.max(n, this.impostorCap * 2);
    if (this.impostors) { this.scene.remove(this.impostors); this.impostors.dispose(); }
    const geo = this.impostorGeo.clone();
    const cell = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    cell.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', cell);
    const m = new THREE.InstancedMesh(geo, this.impostorMat, cap);
    m.customDepthMaterial = this.impostorDepth;
    m.castShadow = true; m.receiveShadow = true;
    m.frustumCulled = false; m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.visible = this.visible;
    this.scene.add(m);
    this.impostors = m;
    this.impostorCap = cap;
  }

  // ── Placement ──
  _addTree(list, vi, x, y, z, s, rot) {
    const v = this.variants[vi];
    const t = { v: vi, x, y, z, s, rot, col: null };
    if (v.def.collide) {
      const c = v.col, cs = Math.cos(rot), sn = Math.sin(rot);
      t.col = {
        trunkR: c.trunkR * s, trunkTop: c.canopyBot * s,
        canopyR: c.canopyR * s * 0.85, canopyBot: c.canopyBot * s, canopyTop: c.canopyTop * s,
        cx: x + (c.cx * cs + c.cz * sn) * s, cz: z + (-c.cx * sn + c.cz * cs) * s,
      };
    }
    list.push(t);
    return t;
  }

  _rehash() {
    this.hash.clear();
    const add = t => {
      if (!t.col) return;
      const key = Math.floor(t.x / 16) + ',' + Math.floor(t.z / 16);
      let b = this.hash.get(key); if (!b) this.hash.set(key, b = []); b.push(t);
    };
    this.trees.forEach(add); this.forest.forEach(add);
  }

  /** Trees and bushes scattered around the course (reshuffled with the world). */
  scatterCourse(rng, terrain, gates, { count = 90, bushes = 70, minFromGate = 7, minFromSpawn = 6 } = {}) {
    this.trees = [];
    let placed = 0, attempts = 0;
    while (placed < count && attempts < 4000) {
      attempts++;
      const a = rng() * Math.PI * 2, r = rng() * 175;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.hypot(x, z) < minFromSpawn || (Math.abs(x) < 7 && Math.abs(z) < 30)) continue;
      if (gates.some(g => Math.hypot(x - g.pos.x, z - g.pos.z) < minFromGate)) continue;
      const vi = TREE_VARIANTS[Math.floor(rng() * TREE_VARIANTS.length)];
      const s = 0.75 + rng() * 0.5;
      this._addTree(this.trees, vi, x, terrain.groundAt(x, z), z, s, rng() * Math.PI * 2);
      placed++;
    }
    for (let b = 0, tries = 0; b < bushes && tries < 3000; tries++) {
      const a = rng() * Math.PI * 2, r = 12 + rng() * 170;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (gates.some(g => Math.hypot(x - g.pos.x, z - g.pos.z) < 5) || (Math.abs(x) < 7 && Math.abs(z) < 30)) continue;
      const vi = BUSH_VARIANTS[Math.floor(rng() * BUSH_VARIANTS.length)];
      this._addTree(this.trees, vi, x, terrain.groundAt(x, z), z, 0.7 + rng() * 0.8, rng() * Math.PI * 2);
      b++;
    }
    this._rehash();
    this.lodTimer = 0;
  }

  /** The surrounding woods, from the terrain's land-cover map (fixed per terrain). */
  scatterForest(terrain, count) {
    this.forest = [];
    let s = 0x9e3779b9;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    let tries = 0;
    while (this.forest.length < count && tries < count * 40) {
      tries++;
      // Denser sampling near the course, where cards are actually resolvable.
      const r = 135 + Math.pow(rnd(), 1.7) * 1250;
      const a = rnd() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const f = terrain.forestAt(x, z);
      if (rnd() > f * f * 1.25) continue;
      const vi = TREE_VARIANTS[Math.floor(rnd() * TREE_VARIANTS.length)];
      this._addTree(this.forest, vi, x, terrain.groundAt(x, z) - 0.2, z, 0.85 + rnd() * 0.55, rnd() * Math.PI * 2);
    }
    this._rehash();
    this.lodTimer = 0;
  }

  setVisible(v) {
    this.visible = v;
    this.variants.forEach(x => { x.full.bark.visible = x.full.leaves.visible = v; });
    if (this.impostors) this.impostors.visible = v;
  }

  // ── Per frame ──
  update(camera, dt, sun) {
    vegUniforms.uTime.value += dt;
    if (sun) {
      vegUniforms.uSunViewDir.value.copy(sun.dir).transformDirection(camera.matrixWorldInverse);
      vegUniforms.uSunRadiance.value.copy(sun.color).multiplyScalar(sun.illuminance / Math.PI);
    }
    this.lodTimer -= dt;
    if (this.lodTimer > 0 || !this.visible) return;
    this.lodTimer = 0.2;
    this._updateLod(camera.position);
  }

  _updateLod(p) {
    const lod2 = this.lodFull * this.lodFull;
    const full = this.variants.map(() => []);
    const all = this.trees.length + this.forest.length;
    this._ensureImpostorCapacity(all);
    const im = this.impostors, cell = im.geometry.attributes.aCell;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    let nImp = 0, nFull = 0;
    const consider = (t) => {
      const dx = t.x - p.x, dz = t.z - p.z, d2 = dx * dx + dz * dz;
      const v = this.variants[t.v];
      if (d2 < lod2 && full[t.v].length < this.maxFull) { full[t.v].push(t); nFull++; return; }
      // Far bushes are sub-pixel — skip them entirely.
      if (!v.def.collide && d2 > 90 * 90) return;
      pos.set(t.x, t.y, t.z); scl.set(v.card.w * t.s, v.card.h * t.s, 1);
      im.setMatrixAt(nImp, mat.compose(pos, q.identity(), scl));
      cell.array[nImp] = t.v;
      nImp++;
    };
    this.trees.forEach(consider);
    this.forest.forEach(consider);
    im.count = nImp;
    im.instanceMatrix.needsUpdate = true;
    cell.needsUpdate = true;
    this.variants.forEach((v, i) => {
      const list = full[i];
      list.forEach((t, k) => {
        pos.set(t.x, t.y, t.z); q.setFromAxisAngle(Y, t.rot); scl.setScalar(t.s);
        mat.compose(pos, q, scl);
        v.full.bark.setMatrixAt(k, mat); v.full.leaves.setMatrixAt(k, mat);
      });
      v.full.bark.count = v.full.leaves.count = list.length;
      v.full.bark.instanceMatrix.needsUpdate = v.full.leaves.instanceMatrix.needsUpdate = true;
    });
    this.stats = { full: nFull, impostors: nImp };
  }

  // ── Collision ──
  /** Returns true if a sphere of radius r at p touches a trunk or canopy. */
  collide(p, r) {
    if (!this.visible) return false;
    const ci = Math.floor(p.x / 16), cj = Math.floor(p.z / 16);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const bucket = this.hash.get((ci + a) + ',' + (cj + b));
      if (!bucket) continue;
      for (const t of bucket) {
        const c = t.col, y = p.y - t.y;
        // Trunk: vertical cylinder from the ground to the crown.
        let dx = p.x - t.x, dz = p.z - t.z;
        let rad = Math.hypot(dx, dz), dy = y < 0 ? -y : (y > c.trunkTop ? y - c.trunkTop : 0);
        if (Math.hypot(Math.max(rad - c.trunkR, 0), dy) < r) return true;
        // Crown: vertical cylinder around the leaf mass.
        dx = p.x - c.cx; dz = p.z - c.cz;
        rad = Math.hypot(dx, dz); dy = y < c.canopyBot ? c.canopyBot - y : (y > c.canopyTop ? y - c.canopyTop : 0);
        if (Math.hypot(Math.max(rad - c.canopyR, 0), dy) < r) return true;
      }
    }
    return false;
  }

  /** Number of crowns crossed by the segment a→b (analog video link). */
  canopiesCrossed(a, b) {
    if (!this.visible) return 0;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d2 = dx * dx + dz * dz;
    if (d2 < 1) return 0;
    let n = 0;
    for (const t of this.trees) {
      if (!t.col) continue;
      const c = t.col;
      const s = THREE.MathUtils.clamp(((c.cx - a.x) * dx + (c.cz - a.z) * dz) / d2, 0, 1);
      const ex = a.x + dx * s - c.cx, ez = a.z + dz * s - c.cz, ey = a.y + dy * s - t.y;
      if (ex * ex + ez * ez < c.canopyR * c.canopyR && ey < c.canopyTop && ey > 0) n++;
    }
    return n;
  }
}
