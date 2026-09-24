// ═══════════════════════════════════════════════
//  ENVIRONMENT — sky, sun, shadows, image-based light and haze, driven by a
//  preset (replaces the old flat-colour DAY/NIGHT themes).
//
//  Everything is in the photographed sky's own radiance units: the dome shows
//  the HDR sky, the PMREM of that sky lights every PBR material, the sun's
//  DirectionalLight carries exactly the energy measured in the sun cone, and
//  the fog colour is the sky's own horizon. Exposure (auto or static) maps
//  that to the display — so no light here is hand-tuned against another.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { SkyDome, loadSkyAssets } from './sky.js';
import { fogUniforms, setCSM } from './materials.js';

export const ENV_PRESETS = {
  midday: {
    label: '☀ MIDDAY', dir: 'assets/env/midday',
    sunAzimuthDeg: 50,           // world azimuth (atan2(z,x)) the sun is rotated to
    fogDensity: 0.00038, fogFalloff: 0.016, sunScatter: 0.03,
    evBias: 0.0, sensorGain: 0.0,
  },
  golden: {
    label: '🌅 GOLDEN HOUR', dir: 'assets/env/golden',
    sunAzimuthDeg: -35,
    fogDensity: 0.0006, fogFalloff: 0.013, sunScatter: 0.12,
    evBias: 0.25, sensorGain: 0.15,
  },
  overcast: {
    label: '☁ OVERCAST', dir: 'assets/env/overcast',
    sunAzimuthDeg: 0,
    fogDensity: 0.0011, fogFalloff: 0.012, sunScatter: 0.0,
    evBias: 0.1, sensorGain: 0.1,
  },
  night: {
    label: '🌙 NIGHT', dir: 'assets/env/night',
    sunAzimuthDeg: 140,
    fogDensity: 0.0009, fogFalloff: 0.02, sunScatter: 0.03,
    evBias: -3.3, sensorGain: 1.0, night: true,
  },
};

// Shadow cascades hug the camera: a racing course is ~120 m across and the
// camera sits a few metres off the grass, so almost all the shadow detail is
// needed in the first few metres — that is where the drone's own shadow and
// the grass at your feet are. The wide lens renders a wide frustum, so the
// first cascade has to be short to stay sharp (~1.5 cm texels).
const CSM_SPLITS = { 1: [1], 2: [0.06, 1], 3: [0.04, 0.2, 1] };
const SHADOW_FAR = { 1: 90, 2: 140, 3: 170 };

export class Environment {
  constructor({ renderer, scene, camera, tier }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tier = tier;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sky = new SkyDome();
    scene.add(this.sky.mesh);
    scene.fog = new THREE.FogExp2(0x8899aa, 0.0005);
    this.sunColor = new THREE.Color(1, 1, 1);
    this.sunIlluminance = 0;
    this.skyIlluminance = 1;
    this.presetName = null;
    this.preset = null;
    this.staticExposure = 1;
    this.cache = new Map();
    this.envMap = null;
    this.csm = null;
    this._buildCSM();
  }

  _buildCSM() {
    const t = this.tier;
    const n = Math.max(1, t.cascades || 1);
    if (this.csm) { this.csm.remove(); this.csm.dispose(); }
    const csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: n,
      maxFar: SHADOW_FAR[n],
      mode: 'custom',
      customSplitsCallback: (cascades, near, far, breaks) => { breaks.push(...CSM_SPLITS[n]); },
      shadowMapSize: t.shadowMap || 1024,
      lightDirection: this.sky.sunDir.clone().negate(),
      lightIntensity: this.sunIlluminance,
      lightNear: 1,
      lightFar: 900,
      lightMargin: 220,
    });
    csm.fade = n > 1;
    csm.lights.forEach((l, i) => {
      l.shadow.bias = -0.0001 * (i + 1);
      l.shadow.normalBias = 0.012 + 0.03 * i;
      l.shadow.radius = i === 0 ? 1 : 2;
    });
    this.csm = csm;
    setCSM(csm);
    this._applySunToLights();
  }

  _applySunToLights() {
    if (!this.csm) return;
    const castsShadow = !!this.tier.shadows && this.sunIlluminance > 0.05;
    this.csm.lightDirection.copy(this.sky.sunDir).negate();
    this.csm.lights.forEach(l => {
      l.color.copy(this.sunColor);
      l.intensity = this.sunIlluminance;
      l.castShadow = castsShadow;
    });
  }

  setTier(tier) {
    const prev = this.tier;
    this.tier = tier;
    if (prev.cascades !== tier.cascades || prev.shadowMap !== tier.shadowMap) this._buildCSM();
    else this._applySunToLights();
  }

  async load(name, res) {
    const key = name + '@' + res;
    if (!this.cache.has(key)) this.cache.set(key, loadSkyAssets(ENV_PRESETS[name].dir, res));
    return this.cache.get(key);
  }

  async setPreset(name) {
    const preset = ENV_PRESETS[name] || ENV_PRESETS.midday;
    const assets = await this.load(name, this.tier.skyRes || '2k');
    const meta = assets.meta;
    this.presetName = name;
    this.preset = preset;

    // Rotate the photographed sky so its sun lands at the preset's azimuth.
    const sunImg = new THREE.Vector3().fromArray(meta.sunDir);
    const rot = THREE.MathUtils.degToRad(preset.sunAzimuthDeg) - Math.atan2(sunImg.z, sunImg.x);
    // applyAxisAngle(+Y, a) turns azimuth atan2(z,x) by -a, hence the sign.
    this.sky.setAssets(assets, -rot);

    this.sunColor.fromArray(meta.sunColor);
    this.sunIlluminance = meta.sunIlluminance;
    this.skyIlluminance = meta.skyIlluminance;
    this._applySunToLights();

    // Haze: sky's own horizon radiance; forward-scatter tinted by the sun.
    const fog = this.scene.fog;
    fog.color.fromArray(meta.horizonColor);
    fog.density = preset.fogDensity;
    fogUniforms.uFogHeightFalloff.value = preset.fogFalloff;
    fogUniforms.uFogBaseHeight.value = 0;
    fogUniforms.uFogSunDir.value.copy(this.sky.sunDir);
    fogUniforms.uFogSunColor.value.copy(this.sunColor).multiplyScalar(meta.sunIlluminance * preset.sunScatter);
    this.sky.syncFog(fog);

    // Image-based lighting from the sun-less copy of the sky.
    const oldEnv = this.envMap;
    this.envMap = this.sky.buildEnvironment(this.pmrem);
    this.scene.environment = this.envMap;
    if (oldEnv) oldEnv.dispose();

    // Reference exposure: a mid-grey ground at the sky+sun illuminance, blended
    // with the horizon (an FPV frame is roughly half ground, half sky).
    const eGround = meta.skyIlluminance + meta.sunIlluminance * Math.max(meta.sunDir[1], 0);
    const groundL = 0.18 * eGround / Math.PI;
    const hz = meta.horizonColor;
    const skyL = 0.2126 * hz[0] + 0.7152 * hz[1] + 0.0722 * hz[2];
    const avgL = Math.sqrt(groundL * skyL);            // log-average of the two
    this.staticExposure = 0.18 / Math.max(avgL, 1e-5) * Math.pow(2, preset.evBias);
    return preset;
  }

  get sunDirection() { return this.sky.sunDir; }

  /** Call whenever the camera's fov/aspect changes. */
  updateFrustums() { this.csm?.updateFrustums(); }

  /** Per frame, before rendering. */
  update() {
    this.sky.follow(this.camera);
    this.csm?.update();
  }
}
