// ═══════════════════════════════════════════════
//  GRASS — a GPU-placed field of blades around the camera.
//
//  Nothing is stored per blade: instance N maps to a world grid cell around
//  the camera, and everything about the blade (jitter, height, lean, colour)
//  is a hash of that WORLD cell, so blades stay put as the camera moves and
//  cells simply wrap from one edge of the patch to the other.
//
//  Blades sit on the rendered terrain (a groundAt() height texture), follow
//  the terrain's own masks (none on the pad, short and sparse on worn dirt),
//  take their colour from the grass texture underneath, sway in the wind,
//  glow when back-lit, and are flattened by the prop wash when the quad
//  hovers low — one of the strongest "you are really there" cues in FPV.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { register } from './materials.js';
import { vegUniforms } from './vegetation.js';
import { PAD } from './terrain.js';

const BLADES_PER_CLUMP = 4;
const SEGMENTS = 4;

function clumpGeometry() {
  const pos = [], idx = [];
  for (let b = 0; b < BLADES_PER_CLUMP; b++) {
    const base = pos.length / 3;
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      pos.push(-1, t, b, 1, t, b);
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Placeholder normals: the real ones are computed in the shader, but without
  // a normal attribute three forces FLAT_SHADED and ignores them.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

const GRASS_PARS = /* glsl */`
uniform vec3 uCamPos;
uniform float uRadius;
uniform float uInner;         // the far layer leaves the near layer's disc to it
uniform float uCell;
uniform float uSide;
uniform vec4 uDrone;          // xyz position, w = wash strength (0..1)
uniform sampler2D tHeight;
uniform float uHeightExtent;
uniform sampler2D tNoise;
uniform sampler2D tWear;
uniform float uWearExtent;
uniform vec3 uPad;
uniform sampler2D tGrassAlb;
uniform float uGrassScale;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying vec3 vGrassColor;
varying float vGrassT;
vec2 gHash2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float gHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float gPadSdf(vec2 p){
  vec2 q = abs(p) - (uPad.xy - uPad.z);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uPad.z;
}`;

// Everything is computed at the start of the vertex shader (beginnormal runs
// before begin_vertex), then handed to three's normal/position pipeline.
const GRASS_BLADE = /* glsl */`
int gid = gl_InstanceID;
int side = int(uSide);
vec2 local = vec2(float(gid % side), float(gid / side)) - uSide * 0.5;
vec2 camCell = floor(uCamPos.xz / uCell);
vec2 wcell = camCell + local;
vec2 h2 = gHash2(wcell);
float h3 = gHash(wcell + 17.31), h4 = gHash(wcell - 9.7);
vec2 root = (wcell + h2) * uCell;
float dCam = length(root - uCamPos.xz);

// Terrain masks — the same inputs the ground shader uses.
vec4 nz0 = texture2D(tNoise, root / 173.0);
vec4 nz1 = texture2D(tNoise, root / 41.0 + 0.19);
vec2 wuv = root / uWearExtent + 0.5;
float wear = texture2D(tWear, clamp(wuv, 0.0, 1.0)).r;
float dirt = smoothstep(0.66, 0.84, nz1.b * 0.7 + nz0.a * 0.45) * 0.45 + wear;
float padD = gPadSdf(root);
float dens = (1.0 - clamp(dirt, 0.0, 1.0) * 0.85) * smoothstep(0.2, 1.2, padD);
// Thin out with distance (fewer, slightly larger blades far away).
float farT = smoothstep(uRadius * 0.3, uRadius, dCam);
float keep = step(h3, dens * (1.0 - farT * 0.55)) * step(dCam, uRadius) * step(uInner * 0.75, dCam);
vec2 huv = root / uHeightExtent + 0.5;
keep *= step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
float groundY = texture2D(tHeight, huv).r;

// Blade shape
float bi = position.z;
float ang = (h4 + bi * 0.37) * 6.2831853;
vec2 bdir = vec2(cos(ang), sin(ang));
vec2 boff = vec2(cos(ang * 1.7 + bi), sin(ang * 1.7 + bi)) * 0.045 * bi;
float tall = mix(0.09, 0.3, fract(h3 * 7.13 + bi * 0.31)) * mix(0.45, 1.0, dens) * (1.0 + farT * 0.3);
// Fade in over the inner edge and out over the outer edge — no visible ring.
tall *= keep * (1.0 - smoothstep(uRadius * 0.72, uRadius, dCam))
      * (uInner > 0.0 ? smoothstep(uInner * 0.75, uInner * 1.1, dCam) : 1.0);
float width = mix(0.0045, 0.008, h4) * (1.0 + farT * 1.6 + uCell * 2.0);
float t = position.y;
vGrassT = t;

// Wind + prop wash
float gust = 0.55 + 0.45 * sin(uTime * 0.37 + dot(root, uWindDir) * 0.05);
float sway = (sin(uTime * 1.9 + dot(root, uWindDir) * 0.45 + h4 * 6.0) * 0.6
            + sin(uTime * 3.7 + root.x * 0.8 + h3 * 4.0) * 0.25) * gust * uWindStrength;
vec2 bend = bdir * (0.25 + h3 * 0.35) * tall + uWindDir * sway * 0.18 * tall;
vec2 toBlade = root - uDrone.xz;
float dd = length(toBlade);
float agl = max(uDrone.y - groundY, 0.0);
float wash = uDrone.w * exp(-dd * dd / 3.5) * (1.0 - smoothstep(0.4, 3.2, agl));
float flutter = sin(uTime * 23.0 + h4 * 40.0) * 0.25 + 0.75;
bend += (dd > 1e-3 ? toBlade / dd : bdir) * wash * tall * 1.6 * flutter;
float flat_ = clamp(length(bend) / max(tall, 1e-3), 0.0, 0.9);

vec3 bladePos = vec3(root.x + boff.x, groundY, root.y + boff.y);
bladePos.xz += bend * t * t;
bladePos.y += tall * t * (1.0 - flat_ * 0.55 * t);
vec2 across = vec2(-bdir.y, bdir.x);
bladePos.xz += across * position.x * width * (1.0 - t * 0.85);

// Normal leans up so a field shades like a soft carpet, not flat cards.
vec3 bladeNormal = normalize(mix(vec3(bdir.x, 0.0, bdir.y), vec3(0.0, 1.0, 0.0), 0.65));

// Colour from the ground's grass texture at the root, darker toward the base.
vec3 soil = texture2D(tGrassAlb, root / uGrassScale).rgb;
float tipHue = fract(h3 * 3.1);
vec3 tip = mix(soil * vec3(1.05, 1.12, 0.85), soil * vec3(1.25, 1.18, 0.7), tipHue * 0.5);
vGrassColor = mix(soil * 0.72, tip, t) * mix(0.88, 1.12, h4);
`;

export class Grass {
  /** layer: { radius, inner, clumps } — see QUALITY_TIERS.grass. */
  constructor({ layer, terrain, heightTex }) {
    this.layer = layer;
    const clumps = Math.max(1, layer.clumps | 0);
    this.side = Math.ceil(Math.sqrt(clumps));
    this.radius = layer.radius;
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uRadius: { value: this.radius },
      uInner: { value: layer.inner || 0 },
      uCell: { value: (this.radius * 2) / this.side },
      uSide: { value: this.side },
      uDrone: { value: new THREE.Vector4(0, -100, 0, 0) },
      tHeight: { value: heightTex.texture },
      uHeightExtent: { value: heightTex.extent },
      tNoise: terrain.uniforms.tNoise,
      tWear: terrain.uniforms.tWear,
      uWearExtent: terrain.uniforms.uWearExtent,
      uPad: { value: new THREE.Vector3(PAD.hx, PAD.hz, PAD.r) },
      tGrassAlb: terrain.uniforms.tAlb0,
      uGrassScale: { value: terrain.uniforms.uScales.value.x },
    };
    const geo = clumpGeometry();
    geo.instanceCount = this.side * this.side;
    const mat = new THREE.MeshStandardMaterial({
      name: 'Grass', color: 0xffffff, roughness: 0.78, metalness: 0, side: THREE.DoubleSide,
    });
    const uniforms = this.uniforms;
    register(mat, [{
      key: 'grass',
      fn: shader => {
        Object.assign(shader.uniforms, uniforms, vegUniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + GRASS_PARS)
          .replace('#include <beginnormal_vertex>', GRASS_BLADE + '\nvec3 objectNormal = bladeNormal;')
          .replace('#include <begin_vertex>', 'vec3 transformed = bladePos;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGrassColor;\nvarying float vGrassT;\nuniform vec3 uSunViewDir; uniform vec3 uSunRadiance;')
          .replace('#include <map_fragment>', 'diffuseColor.rgb *= vGrassColor;')
          // Keep the up-leaning normal on both faces (three would flip it on
          // back faces, turning half the blades black).
          .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;')
          // Blades are thin: light passing through them lights the tips when back-lit.
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            { vec3 Vv = normalize(vViewPosition);
              float back = pow(max(dot(-Vv, uSunViewDir), 0.0), 3.0);
              totalEmissiveRadiance += diffuseColor.rgb * uSunRadiance * back * 0.3 * vGrassT; }`);
      },
    }]);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'Grass';
    this.mesh.visible = clumps > 1;
  }

  /** Per frame: follow the camera; `wash` 0..1 from thrust. */
  update(camera, drone, wash) {
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uDrone.value.set(drone.x, drone.y, drone.z, wash);
  }
}
