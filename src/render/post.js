// ═══════════════════════════════════════════════
//  POST STACK — a model of an FPV camera, not a "filter pile".
//
//   scene (HDR, MSAA) ─► N8AO ─► [motion blur + auto exposure]
//     ─► [bloom + AgX tone map + colour profile] ─► (SMAA)
//     ─► [lens: barrel distortion, lateral CA, vignette | analog feed]
//     ─► [sensor grain] ─► screen
//
//  • Motion blur reprojects depth with the previous frame's camera. The world
//    is static and only the camera moves, so this is exact — no per-object
//    velocity buffer needed. Strength follows a real shutter time (ND filter).
//  • Auto exposure meters log-average luminance (centre-weighted) on the GPU
//    and adapts over ~1 s, like the camera darkening when you pitch up at the
//    sky and opening up when you dive into shade.
//  • The lens renders a slightly wider frame and barrel-distorts it back, so
//    the edges show the stretched periphery of a real ~150° FPV lens.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, Effect, EffectAttribute, BlendFunction,
  BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, SMAAPreset,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

const HASH = /* glsl */`
float fpvHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`;

// ── Full-screen helper for the metering passes ──
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
const FS_VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
class FullScreen {
  constructor(fragmentShader, uniforms) {
    this.material = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(fsGeo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, target) { renderer.setRenderTarget(target); renderer.render(this.scene, this.camera); }
}
function rt(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
}

// ═══════════════════════════════════════════════
//  Motion blur + exposure (one convolution pass on the HDR image)
// ═══════════════════════════════════════════════
const CAMERA_FRAG = /* glsl */`
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform float uBlurScale;
uniform float uMaxBlur;
uniform sampler2D tAdapt;
uniform float uAuto;
uniform float uStaticExposure;
uniform float uEvScale;
uniform float uExpMin;
uniform float uExpMax;
${HASH}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
  vec3 col = inputColor.rgb;
#if MB_SAMPLES > 0
  vec4 view = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  view /= view.w;
  vec4 prev = uPrevViewProj * (uCamWorld * view);
  vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
  vec2 vel = (uv - prevUv) * uBlurScale;
  float len = length(vel * vec2(aspect, 1.0));
  if (len > uMaxBlur) vel *= uMaxBlur / len;
  if (len > 0.0005) {
    float j = fpvHash(uv * resolution + time) - 0.5;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < MB_SAMPLES; i++) {
      float t = (float(i) + 0.5 + j) / float(MB_SAMPLES) - 0.5;
      acc += min(texture2D(inputBuffer, uv + vel * t).rgb, vec3(30000.0));
    }
    col = acc / float(MB_SAMPLES);
  }
#endif
  float adaptLog = texture2D(tAdapt, vec2(0.5)).r;
  float autoExp = clamp(0.18 / exp2(adaptLog) * uEvScale, uExpMin, uExpMax);
  float exposure = mix(uStaticExposure, autoExp, uAuto);
  // A sensor clips: capping the exposed signal keeps the unclipped sun (~3e4)
  // from flooding the bloom chain with a frame-wide veil.
  col = min(col * exposure, vec3(48.0));
  if (any(isnan(col))) col = vec3(0.0);
  outputColor = vec4(col, 1.0);
}`;

const METER_FRAG = /* glsl */`
uniform sampler2D tInput;
varying vec2 vUv;
void main(){
  vec2 o = vec2(0.25 / 64.0);
  vec3 c = texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tInput, vUv + vec2(o.x, -o.y)).rgb
         + texture2D(tInput, vUv + vec2(-o.x, o.y)).rgb + texture2D(tInput, vUv + vec2(o.x, o.y)).rgb;
  float L = dot(min(c * 0.25, vec3(30000.0)), vec3(0.2126, 0.7152, 0.0722));
  vec2 d = (vUv - 0.5) * vec2(1.3, 1.0) * 2.0;
  float w = mix(1.0, 0.3, smoothstep(0.25, 1.1, length(d)));   // centre-weighted metering
  gl_FragColor = vec4(log2(max(L, 1e-5)) * w, w, 0.0, 1.0);
}`;
const REDUCE_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform int uBlock;
varying vec2 vUv;
void main(){
  ivec2 base = ivec2(gl_FragCoord.xy) * uBlock;
  vec2 s = vec2(0.0);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) s += texelFetch(tIn, base + ivec2(x, y), 0).rg;
  gl_FragColor = vec4(s, 0.0, 1.0);
}`;
const FINAL_FRAG = /* glsl */`
uniform sampler2D tIn;
varying vec2 vUv;
void main(){
  vec2 s = vec2(0.0);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) s += texelFetch(tIn, ivec2(x, y), 0).rg;
  gl_FragColor = vec4(s.x / max(s.y, 1e-5), 0.0, 0.0, 1.0);
}`;
const ADAPT_FRAG = /* glsl */`
uniform sampler2D tPrev;
uniform sampler2D tTarget;
uniform float uDt;
uniform float uUp;
uniform float uDown;
uniform float uInit;
varying vec2 vUv;
void main(){
  float target = texelFetch(tTarget, ivec2(0), 0).r;
  float prev = texelFetch(tPrev, ivec2(0), 0).r;
  float rate = target > prev ? uUp : uDown;
  float v = uInit > 0.5 ? target : prev + (target - prev) * (1.0 - exp(-uDt * rate));
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

class CameraEffect extends Effect {
  constructor(camera) {
    super('CameraEffect', CAMERA_FRAG, {
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SRC,
      defines: new Map([['MB_SAMPLES', '8']]),
      uniforms: new Map([
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uPrevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uBlurScale', new THREE.Uniform(0)],
        ['uMaxBlur', new THREE.Uniform(0.08)],
        ['tAdapt', new THREE.Uniform(null)],
        ['uAuto', new THREE.Uniform(1)],
        ['uStaticExposure', new THREE.Uniform(1)],
        ['uEvScale', new THREE.Uniform(1)],
        ['uExpMin', new THREE.Uniform(0)],
        ['uExpMax', new THREE.Uniform(1e6)],
      ]),
    });
    this.camera = camera;
    this.shutter = 1 / 240;
    this.prevViewProj = new THREE.Matrix4();
    this.resetHistory = true;
    // Metering chain: 64² log-luminance → 8² partial sums → 1² average → adapted (ping-pong)
    this.rtMeter = rt(64, 64); this.rtReduce = rt(8, 8); this.rtAvg = rt(1, 1);
    this.rtAdapt = [rt(1, 1), rt(1, 1)]; this.adaptIdx = 0;
    this.meter = new FullScreen(METER_FRAG, { tInput: { value: null } });
    this.reduce = new FullScreen(REDUCE_FRAG, { tIn: { value: this.rtMeter.texture }, uBlock: { value: 8 } });
    this.final = new FullScreen(FINAL_FRAG, { tIn: { value: this.rtReduce.texture } });
    this.adapt = new FullScreen(ADAPT_FRAG, {
      tPrev: { value: null }, tTarget: { value: this.rtAvg.texture },
      uDt: { value: 0 }, uUp: { value: 1.6 }, uDown: { value: 2.4 }, uInit: { value: 1 },
    });
    this.adaptInit = true;
  }

  get adaptTexture() { return this.rtAdapt[this.adaptIdx].texture; }

  setSamples(n) {
    const v = String(n | 0);
    if (this.defines.get('MB_SAMPLES') !== v) { this.defines.set('MB_SAMPLES', v); this.setChanged(); }
  }

  update(renderer, inputBuffer, dt) {
    const u = this.uniforms, cam = this.camera;
    u.get('uInvProj').value.copy(cam.projectionMatrixInverse);
    u.get('uCamWorld').value.copy(cam.matrixWorld);
    u.get('uPrevViewProj').value.copy(this.prevViewProj);
    u.get('uBlurScale').value = this.resetHistory ? 0 : THREE.MathUtils.clamp(this.shutter / Math.max(dt, 1 / 500), 0, 2.5);
    this.prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.resetHistory = false;

    // Meter the un-exposed HDR input and adapt toward it.
    this.meter.material.uniforms.tInput.value = inputBuffer.texture;
    this.meter.render(renderer, this.rtMeter);
    this.reduce.render(renderer, this.rtReduce);
    this.final.render(renderer, this.rtAvg);
    const prev = this.rtAdapt[this.adaptIdx], next = this.rtAdapt[1 - this.adaptIdx];
    const au = this.adapt.material.uniforms;
    au.tPrev.value = prev.texture; au.uDt.value = Math.min(dt, 0.1); au.uInit.value = this.adaptInit ? 1 : 0;
    this.adapt.render(renderer, next);
    this.adaptIdx = 1 - this.adaptIdx;
    this.adaptInit = false;
    u.get('tAdapt').value = next.texture;
  }

  dispose() {
    super.dispose();
    [this.rtMeter, this.rtReduce, this.rtAvg, ...this.rtAdapt].forEach(t => t.dispose());
  }
}

// ═══════════════════════════════════════════════
//  Colour profile (after tone mapping, in display space)
// ═══════════════════════════════════════════════
const GRADE_FRAG = /* glsl */`
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uWB;
uniform float uGammaG;
uniform float uSat;
uniform float uContrast;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = pow(max(inputColor.rgb * uWB, 0.0), vec3(1.0 / 2.2));
  c = (c - 0.45) * uContrast + 0.45;
  c = c * uGain + uLift * (1.0 - c);
  c = pow(max(c, 0.0), vec3(1.0 / uGammaG));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), inputColor.a);
}`;

export const COLOR_PROFILES = {
  digital: { label: 'DIGITAL HD', lift: [0, 0, 0.006], gain: [1.0, 1.0, 1.0], wb: [1.0, 1.0, 1.0], gamma: 1.0, sat: 1.22, contrast: 1.1 },
  action:  { label: 'ACTION CAM', lift: [-0.01, 0.0, 0.018], gain: [1.04, 1.0, 0.96], wb: [1.02, 1.0, 0.97], gamma: 1.02, sat: 1.32, contrast: 1.16 },
  flat:    { label: 'FLAT / LOG', lift: [0.05, 0.05, 0.055], gain: [0.95, 0.95, 0.95], wb: [1.0, 1.0, 1.0], gamma: 1.05, sat: 0.82, contrast: 0.82 },
};

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      uniforms: new Map([
        ['uLift', new THREE.Uniform(new THREE.Vector3())], ['uGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uWB', new THREE.Uniform(new THREE.Vector3(1, 1, 1))], ['uGammaG', new THREE.Uniform(1)],
        ['uSat', new THREE.Uniform(1)], ['uContrast', new THREE.Uniform(1)],
      ]),
    });
  }
  setProfile(p) {
    const u = this.uniforms;
    u.get('uLift').value.fromArray(p.lift); u.get('uGain').value.fromArray(p.gain); u.get('uWB').value.fromArray(p.wb);
    u.get('uGammaG').value = p.gamma; u.get('uSat').value = p.sat; u.get('uContrast').value = p.contrast;
  }
}

// ═══════════════════════════════════════════════
//  Lens: barrel distortion + lateral CA + vignette, or an analog feed
// ═══════════════════════════════════════════════
const LENS_FRAG = /* glsl */`
uniform float uK1;
uniform float uK2;
uniform float uScale;
uniform float uCA;
uniform float uVignette;
uniform float uSignal;
uniform float uFrame;
${HASH}
vec2 lensUv(vec2 uv, float k){
  vec2 ar = vec2(aspect, 1.0) * 2.0;
  vec2 p = (uv - 0.5) * ar;
  float r2 = dot(p, p);
  float f = (1.0 + uK1 * r2 + uK2 * r2 * r2) * k / uScale;
  return 0.5 + p * f / ar;
}
vec3 lensSample(vec2 uv){
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float r2 = dot(p, p) / (aspect * aspect + 1.0);
  return vec3(
    texture2D(inputBuffer, lensUv(uv, 1.0 + uCA * r2)).r,
    texture2D(inputBuffer, lensUv(uv, 1.0)).g,
    texture2D(inputBuffer, lensUv(uv, 1.0 - uCA * r2)).b);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 col;
#ifdef FEED_ANALOG
  // 480-line composite video: full-res luma, horizontally smeared chroma,
  // line jitter and noise that grow as the link weakens, breakup bands.
  float line = floor(uv.y * 480.0);
  float weak = 1.0 - uSignal;
  vec2 q = vec2(uv.x + (fpvHash(vec2(line, uFrame)) - 0.5) * weak * weak * 0.03, (line + 0.5) / 480.0);
  vec3 c0 = lensSample(q);
  vec3 cs = (lensSample(q + vec2(-3.0 / 720.0, 0.0)) + lensSample(q + vec2(3.0 / 720.0, 0.0))
           + lensSample(q + vec2(-6.0 / 720.0, 0.0)) + lensSample(q + vec2(6.0 / 720.0, 0.0))) * 0.25;
  vec3 g0 = pow(max(c0, 0.0), vec3(1.0 / 2.2)), gs = pow(max(cs, 0.0), vec3(1.0 / 2.2));
  float Y = dot(g0, vec3(0.299, 0.587, 0.114));
  float U = dot(gs, vec3(-0.147, -0.289, 0.436)) * 0.85, V = dot(gs, vec3(0.615, -0.515, -0.100)) * 0.85;
  vec3 g = vec3(Y + 1.140 * V, Y - 0.395 * U - 0.581 * V, Y + 2.032 * U);
  float n = fpvHash(floor(uv * vec2(720.0, 480.0)) + uFrame * 1.37) - 0.5;
  g += n * (0.03 + weak * weak * 0.45);
  g *= 0.93 + 0.07 * sin(uv.y * 480.0 * 3.14159);
  float band = step(fpvHash(vec2(floor(uv.y * 36.0), floor(uFrame * 0.5))), weak * weak * weak * weak * 0.8);
  g = mix(g, vec3(fpvHash(uv * 913.0 + uFrame)), band * 0.85);
  col = pow(clamp(g, 0.0, 1.0), vec3(2.2));
#else
  col = lensSample(uv);
#endif
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float rc = dot(p, p) / (aspect * aspect + 1.0);
  col *= 1.0 - uVignette * rc * rc * (3.0 - 2.0 * rc);
  outputColor = vec4(col, 1.0);
}`;

class LensEffect extends Effect {
  constructor() {
    super('LensEffect', LENS_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uK1', new THREE.Uniform(0)], ['uK2', new THREE.Uniform(0)], ['uScale', new THREE.Uniform(1)],
        ['uCA', new THREE.Uniform(0.004)], ['uVignette', new THREE.Uniform(0.35)],
        ['uSignal', new THREE.Uniform(1)], ['uFrame', new THREE.Uniform(0)],
      ]),
    });
  }
  setAnalog(on) {
    const has = this.defines.has('FEED_ANALOG');
    if (on && !has) { this.defines.set('FEED_ANALOG', '1'); this.setChanged(); }
    if (!on && has) { this.defines.delete('FEED_ANALOG'); this.setChanged(); }
  }
  update() { this.uniforms.get('uFrame').value = (this.uniforms.get('uFrame').value + 1) % 4096; }
}

// ═══════════════════════════════════════════════
//  Sensor grain — grows with the exposure gain the camera is applying
// ═══════════════════════════════════════════════
const SENSOR_FRAG = /* glsl */`
uniform sampler2D tAdapt;
uniform float uGrain;
uniform float uRefLog;
uniform float uAuto;
uniform float uFrame2;
${HASH}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  float gainEv = uAuto > 0.5 ? clamp(uRefLog - texture2D(tAdapt, vec2(0.5)).r, 0.0, 6.0) : 0.0;
  float amp = uGrain * (1.0 + gainEv * 0.6);
  vec2 px = floor(uv * resolution);
  float n = fpvHash(px + uFrame2 * 17.0) + fpvHash(px * 1.7 - uFrame2 * 5.0) - 1.0;
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += n * amp * (0.35 + 0.65 * sqrt(l));
  outputColor = vec4(pow(max(c, 0.0), vec3(2.2)), inputColor.a);
}`;

class SensorEffect extends Effect {
  constructor() {
    super('SensorEffect', SENSOR_FRAG, {
      uniforms: new Map([
        ['tAdapt', new THREE.Uniform(null)], ['uGrain', new THREE.Uniform(0.012)],
        ['uRefLog', new THREE.Uniform(0)], ['uAuto', new THREE.Uniform(1)], ['uFrame2', new THREE.Uniform(0)],
      ]),
    });
  }
  update() { this.uniforms.get('uFrame2').value = (this.uniforms.get('uFrame2').value + 1) % 4096; }
}

// ═══════════════════════════════════════════════
//  The stack
// ═══════════════════════════════════════════════
export const SHUTTERS = {
  off:  { label: 'OFF', time: 0 },
  nd0:  { label: 'NO ND (1/1000)', time: 1 / 1000 },
  nd8:  { label: 'ND8 (1/250)', time: 1 / 250 },
  nd16: { label: 'ND16 (1/120)', time: 1 / 120 },
};

const LENS = { k1: 0.055, k2: 0.004, ca: 0.0045 };

export class PostStack {
  constructor({ renderer, scene, camera, tier }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tier = tier;
    this.settings = { lens: 'wide', shutter: 'nd8', autoExposure: true, profile: 'digital', feed: 'digital' };
    this.baseGrain = 0.012;
    this.env = null;

    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: tier.msaa || 0 });
    this.composer = composer;
    composer.addPass(new RenderPass(scene, camera));

    this.ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
    this.ao.autosetGamma = false;
    Object.assign(this.ao.configuration, {
      gammaCorrection: false, aoRadius: 1.6, distanceFalloff: 0.6, intensity: 2.2,
      aoSamples: 12, denoiseSamples: 6, denoiseRadius: 8, halfRes: true, screenSpaceRadius: false,
    });
    composer.addPass(this.ao);

    this.cameraFx = new CameraEffect(camera);
    composer.addPass(new EffectPass(camera, this.cameraFx));

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.3, intensity: 0.4, radius: 0.6 });
    this.toneMap = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.grade = new GradeEffect();
    this.gradePass = new EffectPass(camera, this.bloom, this.toneMap, this.grade);
    composer.addPass(this.gradePass);

    this.smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
    composer.addPass(this.smaaPass);

    this.lens = new LensEffect();
    composer.addPass(new EffectPass(camera, this.lens));
    this.sensor = new SensorEffect();
    composer.addPass(new EffectPass(camera, this.sensor));

    this.setTier(tier);
    this.applySettings();
  }

  setTier(tier) {
    this.tier = tier;
    this.composer.multisampling = tier.msaa || 0;
    this.ao.enabled = tier.ao > 0;
    this.ao.configuration.halfRes = tier.ao < 2;
    this.bloom.intensity = tier.bloom ? 0.4 : 0;
    this.smaaPass.enabled = !!tier.smaa;
    this.applySettings();
  }

  /** Called after an environment preset has loaded. */
  setEnvironment(env) {
    this.env = env;
    const p = env.preset;
    const fx = this.cameraFx.uniforms;
    fx.get('uStaticExposure').value = env.staticExposure;
    fx.get('uEvScale').value = Math.pow(2, p.evBias);
    // Auto exposure may move ±2 EV around the preset's reference exposure.
    fx.get('uExpMin').value = env.staticExposure / 4;
    fx.get('uExpMax').value = env.staticExposure * 4;
    this.cameraFx.adaptInit = true;
    this.sensor.uniforms.get('uRefLog').value = Math.log2(0.18 / env.staticExposure);
    this.sensor.uniforms.get('uGrain').value = this.baseGrain * (1 + p.sensorGain * 2.5);
  }

  applySettings(s) {
    if (s) Object.assign(this.settings, s);
    const st = this.settings, tier = this.tier;
    const shutter = SHUTTERS[st.shutter] || SHUTTERS.nd8;
    const samples = shutter.time > 0 ? (tier.motionBlurSamples || 0) : 0;
    this.cameraFx.setSamples(samples);
    this.cameraFx.shutter = shutter.time;
    this.cameraFx.uniforms.get('uAuto').value = st.autoExposure ? 1 : 0;
    this.sensor.uniforms.get('uAuto').value = st.autoExposure ? 1 : 0;
    this.grade.setProfile(COLOR_PROFILES[st.profile] || COLOR_PROFILES.digital);
    const wide = st.lens === 'wide' && tier.lens;
    const lu = this.lens.uniforms;
    lu.get('uK1').value = wide ? LENS.k1 : 0;
    lu.get('uK2').value = wide ? LENS.k2 : 0;
    lu.get('uScale').value = this.lensScale();
    lu.get('uCA').value = tier.lens ? LENS.ca : 0;
    lu.get('uVignette').value = wide ? 0.38 : 0.22;
    this.lens.setAnalog(st.feed === 'analog');
  }

  /** Magnification the lens applies at the centre (corners map 1:1). */
  lensScale() {
    const wide = this.settings.lens === 'wide' && this.tier.lens;
    if (!wide) return 1;
    const a = innerWidth / innerHeight;
    const r2 = a * a + 1;
    return 1 + LENS.k1 * r2 + LENS.k2 * r2 * r2;
  }

  /** Camera FOV to render so the centre of the distorted image shows `fovDeg`. */
  renderFov(fovDeg) {
    const s = this.lensScale();
    this.lens.uniforms.get('uScale').value = s;
    const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * s;
    return Math.min(170, THREE.MathUtils.radToDeg(2 * Math.atan(t)));
  }

  setSignal(q) { this.lens.uniforms.get('uSignal').value = q; }

  /** Skip motion blur for one frame (respawn/teleport). */
  resetHistory() { this.cameraFx.resetHistory = true; }

  get adaptTexture() { return this.cameraFx.adaptTexture; }

  setSize(w, h) { this.composer.setSize(w, h); }

  render(dt) {
    this.sensor.uniforms.get('tAdapt').value = this.cameraFx.uniforms.get('tAdapt').value;
    this.composer.render(dt);
  }
}
