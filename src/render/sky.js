// ═══════════════════════════════════════════════
//  SKY — photographed HDR sky (Poly Haven, CC0) rebuilt from a compact
//  8-bit base JPEG + log2 gain map (see tools/prep_sky.py).
//
//  The same dome shader is used twice:
//   • as the visible background, with the real sun disk at full HDR
//     radiance (it drives bloom and auto exposure) and horizon haze that
//     matches the height fog on the terrain;
//   • rendered once into a cubemap → PMREM for image-based lighting, with
//     the sun cone clamped out, because direct sunlight is supplied by the
//     shadow-casting DirectionalLight instead (no double counting).
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { fogUniforms, FOG_GLSL } from './materials.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D uBase;
uniform sampler2D uGain;
uniform float uGainMax;
uniform float uInvScale;
uniform float uRot;
uniform float uRemoveSun;
uniform float uSunCos;
uniform vec3 uSunDirImg;
uniform vec3 uSunClamp;
uniform float uIntensity;
uniform float uHaze;          // 0 for the IBL copy, 1 for the visible sky
uniform float uHazeDist;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBaseHeight;
uniform vec3 uFogSunDir;
uniform vec3 uFogSunColor;
varying vec3 vDir;
${FOG_GLSL}
void main(){
  vec3 d = normalize(vDir);
  // World → image space: undo the preset's azimuth rotation.
  float c = cos(uRot), s = sin(uRot);
  vec3 di = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
  vec2 uv = vec2(atan(di.z, di.x) * 0.15915494 + 0.5, asin(clamp(di.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  vec3 base = texture2D(uBase, uv).rgb;
  float g = texture2D(uGain, uv).r;
  vec3 L = base * exp2(g * uGainMax) * uInvScale;
  if (uRemoveSun > 0.5 && dot(di, uSunDirImg) > uSunCos) L = min(L, uSunClamp);
  // The ground half of a "pure sky" HDRI is a blurred mirror; nothing should
  // ever see it (terrain covers it), but fade to the horizon colour to be safe.
  L = mix(L, fogColor, smoothstep(0.0, -0.08, d.y) * uHaze);
  L *= uIntensity;
  // Horizon haze: same height-fog integral as the terrain, at a far distance.
  if (uHaze > 0.0) {
    vec3 ray = d * uHazeDist;
    L = mix(L, fpvFogColor(ray), fpvFogAmount(ray, cameraPosition.y) * uHaze);
  }
  // HalfFloat buffers overflow at 65504; the unclipped sun can exceed that.
  gl_FragColor = vec4(min(L, vec3(30000.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    name: 'SkyDome',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBase: { value: null }, uGain: { value: null },
      uGainMax: { value: 1 }, uInvScale: { value: 1 }, uRot: { value: 0 },
      uRemoveSun: { value: 0 }, uSunCos: { value: 1 },
      uSunDirImg: { value: new THREE.Vector3(0, 1, 0) }, uSunClamp: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
      uIntensity: { value: 1 }, uHaze: { value: 1 }, uHazeDist: { value: 1500 },
      fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 },
      ...fogUniforms,
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

const texLoader = new THREE.TextureLoader();

function loadTexture(url, srgb) {
  return new Promise((resolve, reject) => {
    texLoader.load(url, t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // No mipmaps: the equirect seam (atan wrap) would pick the smallest mip
      // along a one-pixel line, and at 4K the sky is never minified on screen.
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      resolve(t);
    }, undefined, reject);
  });
}

/**
 * Loads one sky preset folder (meta.json + base + gain).
 * @returns {Promise<{meta, base: THREE.Texture, gain: THREE.Texture}>}
 */
export async function loadSkyAssets(dir, res) {
  const meta = await (await fetch(`${dir}/meta.json`)).json();
  const [base, gain] = await Promise.all([
    loadTexture(`${dir}/sky_${res}.jpg`, true),
    loadTexture(`${dir}/gain.png`, false),
  ]);
  return { meta, base, gain };
}

export class SkyDome {
  constructor() {
    this.material = makeSkyMaterial();
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(500);   // anywhere inside the camera far plane works (depth test is off)
    this.mesh.name = 'SkyDome';
    // The IBL copy lives in its own scene, rendered only when the preset changes.
    this.iblMaterial = makeSkyMaterial();
    this.iblMaterial.uniforms.uHaze.value = 0;
    this.iblMaterial.uniforms.uRemoveSun.value = 1;
    this.iblScene = new THREE.Scene();
    const iblMesh = new THREE.Mesh(this.mesh.geometry, this.iblMaterial);
    iblMesh.scale.setScalar(50);
    this.iblScene.add(iblMesh);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.assets = null;
  }

  /** Point both materials at a loaded sky; rotation is in radians about +Y. */
  setAssets(assets, rotation) {
    const { meta, base, gain } = assets;
    if (this.assets && this.assets !== assets) { this.assets.base.dispose(); this.assets.gain.dispose(); }
    this.assets = assets;
    const sunImg = new THREE.Vector3().fromArray(meta.sunDir).normalize();
    this.sunDir.copy(sunImg).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
    for (const m of [this.material, this.iblMaterial]) {
      const u = m.uniforms;
      u.uBase.value = base; u.uGain.value = gain;
      u.uGainMax.value = meta.gainMaxLog2;
      u.uInvScale.value = 1 / meta.encodeScale;
      u.uRot.value = rotation;
      u.uSunDirImg.value.copy(sunImg);
      u.uSunCos.value = Math.cos(THREE.MathUtils.degToRad(meta.sunConeDeg));
      u.uSunClamp.value.fromArray(meta.sunClamp);
    }
  }

  /** Mirror scene.fog into the dome so the horizon haze matches the terrain. */
  syncFog(fog) {
    const u = this.material.uniforms;
    u.fogColor.value.copy(fog.color);
    u.fogDensity.value = fog.density;
    this.iblMaterial.uniforms.fogColor.value.copy(fog.color);
  }

  follow(camera) { this.mesh.position.copy(camera.position); }

  /** Pre-filtered environment for PBR lighting (sun removed). */
  buildEnvironment(pmrem) {
    return pmrem.fromScene(this.iblScene, 0, 0.1, 100).texture;
  }
}
