// ═══════════════════════════════════════════════
//  MATERIAL REGISTRY
//  Every material in the world goes through register(). Two things need to
//  touch the shaders of (almost) all materials:
//   • cascaded shadow maps (three's CSM addon), which installs its own
//     onBeforeCompile and must be re-applied if the cascade count changes;
//   • the height fog / aerial perspective, which replaces three's fog chunks.
//  A material can also carry extra named patches (wind sway, terrain
//  splatting…). They are chained into one onBeforeCompile and folded into
//  customProgramCacheKey — otherwise three would share one compiled program
//  between materials of the same type that were patched differently.
// ═══════════════════════════════════════════════
import * as THREE from 'three';

const registry = new Set();
let csm = null;

// Shared by reference: every patched shader points at these same objects, so
// writing .value once per frame updates all materials.
export const fogUniforms = {
  uFogHeightFalloff: { value: 0.06 },   // 1/m — how fast the haze thins with altitude
  uFogBaseHeight:    { value: 0.0 },    // m — altitude where density == fogDensity
  uFogSunDir:        { value: new THREE.Vector3(0, 1, 0) },
  uFogSunColor:      { value: new THREE.Color(0, 0, 0) },  // in-scatter tint toward the sun
};

// Height fog: optical depth of exponential-height fog integrated along the view
// ray (closed form), coloured toward the sun by a forward-scattering lobe.
// It reads three's own fogColor/fogDensity so scene.fog still drives it.
export const FOG_GLSL = /* glsl */`
float fpvFogAmount(vec3 ray, float camY){
  float dist = length(ray);
  float t = uFogHeightFalloff * ray.y;
  float integ = abs(t) > 1e-4 ? (1.0 - exp(-t)) / t : 1.0;
  float od = fogDensity * exp(-uFogHeightFalloff * (camY - uFogBaseHeight)) * dist * integ;
  return 1.0 - exp(-max(od, 0.0));
}
vec3 fpvFogColor(vec3 ray){
  vec3 dir = normalize(ray);
  float mu = max(dot(dir, uFogSunDir), 0.0);
  float lobe = pow(mu, 8.0) * 0.8 + pow(mu, 48.0) * 1.6;
  return fogColor + uFogSunColor * lobe;
}`;

function patchFog(shader) {
  Object.assign(shader.uniforms, fogUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>',
      '#ifdef USE_FOG\n varying vec3 vFogRay;\n#endif')
    .replace('#include <fog_vertex>',
      // Camera→vertex ray in world space. viewMatrix is a rigid transform, so its
      // rotation inverse is a transpose — no per-vertex matrix inverse needed.
      '#ifdef USE_FOG\n vFogRay = transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `#ifdef USE_FOG
 uniform vec3 fogColor; uniform float fogDensity; varying vec3 vFogRay;
 uniform float uFogHeightFalloff; uniform float uFogBaseHeight;
 uniform vec3 uFogSunDir; uniform vec3 uFogSunColor;
 ${FOG_GLSL}
#endif`)
    .replace('#include <fog_fragment>', `#ifdef USE_FOG
 gl_FragColor.rgb = mix(gl_FragColor.rgb, fpvFogColor(vFogRay), fpvFogAmount(vFogRay, cameraPosition.y));
#endif`);
}

function isLit(mat) {
  return mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial;
}

function applyPatches(mat) {
  const extra = mat.userData.fpvPatches || [];
  let csmHook = null;
  if (csm && isLit(mat)) { csm.setupMaterial(mat); csmHook = mat.onBeforeCompile; }
  else if (mat.defines) { delete mat.defines.USE_CSM; delete mat.defines.CSM_CASCADES; delete mat.defines.CSM_FADE; }
  mat.onBeforeCompile = (shader, renderer) => {
    if (csmHook) csmHook(shader, renderer);
    patchFog(shader);
    for (const p of extra) p.fn(shader, renderer);
  };
  const key = 'fpv|' + (csmHook ? 'csm' + csm.cascades + (csm.fade ? 'f' : '') : '-') + '|' + extra.map(p => p.key).join(',');
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}

/**
 * Register a material for shadows/fog, optionally with extra shader patches
 * ({key, fn(shader)}). Returns the material for chaining.
 */
export function register(mat, patches) {
  if (patches) mat.userData.fpvPatches = patches;
  registry.add(mat);
  applyPatches(mat);
  return mat;
}

export function unregister(mat) {
  registry.delete(mat);
  if (csm) csm.shaders.delete(mat);
}

/** Registers every material found under an object (e.g. a loaded glTF). */
export function registerTree(root) {
  root.traverse(o => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    mats.forEach(m => { if (!registry.has(m)) register(m); });
  });
}

/** Swap the cascade set (quality change) and re-patch everything. */
export function setCSM(next) {
  csm = next;
  registry.forEach(applyPatches);
}

// ── Disposal ──
// Geometries/materials/textures that outlive a world rebuild are flagged
// userData.shared and skipped. PBR materials hold many texture slots, so every
// texture-valued property is freed, not just .map.
export function isShared(o) { return !!(o && o.userData && o.userData.shared); }

export function markShared(...items) {
  items.forEach(i => { if (i) { if (!i.userData) i.userData = {}; i.userData.shared = true; } });
  return items[0];
}

export function disposeMaterial(m) {
  if (!m || isShared(m)) return;
  for (const k in m) {
    const v = m[k];
    if (v && v.isTexture && !isShared(v)) v.dispose();
  }
  unregister(m);
  m.dispose();
}

export function disposeObject(obj) {
  obj.traverse(o => {
    if (o.geometry && !isShared(o.geometry)) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    mats.forEach(disposeMaterial);
  });
}
