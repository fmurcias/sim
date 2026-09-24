// ═══════════════════════════════════════════════
//  PROPS & PRESENCE — the things that make a field read as a real race day.
//
//  • The drone's own shadow: an invisible quad (never drawn to the screen,
//    only into the shadow maps). Seeing it chase you across the grass is one
//    of the strongest altitude/speed cues in real FPV footage.
//  • A pilots' area at the end of the pad: pop-up tents, feather flags that
//    ripple in the wind, traffic cones and a safety net — all with colliders.
//  • Prop-wash dust kicked up over the pad and bare dirt when flying low.
// ═══════════════════════════════════════════════
import * as THREE from 'three';
import { register, markShared } from './materials.js';
import { vegUniforms } from './vegetation.js';
import { PAD } from './terrain.js';

// ── Drone shadow caster ──
export function createDroneShadow() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const add = (geo, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
    g.add(m);
  };
  add(new THREE.BoxGeometry(0.075, 0.035, 0.16), 0, 0, 0);                      // stack
  const arm = new THREE.BoxGeometry(0.018, 0.012, 0.2);
  add(arm, 0, 0, 0, Math.PI / 4); add(arm, 0, 0, 0, -Math.PI / 4);                 // X frame
  const disc = new THREE.CylinderGeometry(0.063, 0.063, 0.004, 20);             // prop discs
  for (const [x, z] of [[0.085, 0.085], [-0.085, 0.085], [0.085, -0.085], [-0.085, -0.085]]) add(disc, x, 0.018, z);
  add(new THREE.BoxGeometry(0.03, 0.03, 0.03), 0, 0.02, -0.07);                // camera
  g.name = 'DroneShadow';
  return g;
}

// ── Materials / textures made on a canvas ──
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return markShared(t);
}

function flagTexture(colorA, colorB, text) {
  return canvasTex(128, 512, (c, w, h) => {
    c.fillStyle = colorA; c.fillRect(0, 0, w, h);
    c.fillStyle = colorB; c.fillRect(0, h * 0.62, w, h * 0.38);
    c.fillStyle = '#ffffff';
    c.save(); c.translate(w * 0.62, h * 0.08); c.rotate(Math.PI / 2);
    c.font = 'bold 64px Arial, Helvetica, sans-serif'; c.fillText(text, 0, 0);
    c.restore();
  });
}

function netTexture() {
  const t = canvasTex(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(20,20,20,1)'; c.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      c.beginPath(); c.moveTo(i * w / 4, 0); c.lineTo(i * w / 4, h); c.stroke();
      c.beginPath(); c.moveTo(0, i * h / 4); c.lineTo(w, i * h / 4); c.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Feather flags flutter: travelling wave along the cloth, pinned at the pole.
const FLAG_WAVE = `
{
  float u = uv.x;                                   // 0 at the pole, 1 at the free edge
  float ph = modelMatrix[3].x * 0.37 + modelMatrix[3].z * 0.23;
  float wave = sin(uTime * 5.5 - u * 7.0 + ph + position.y * 1.3) * 0.5 + sin(uTime * 8.3 - u * 11.0 + ph) * 0.2;
  transformed.z += wave * u * u * 0.22 * (0.6 + 0.4 * uWindStrength);
}`;

export class Props {
  constructor({ scene, terrain }) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'Props';
    this.colliders = [];     // {type:'box', cx,cy,cz, hx,hy,hz, cs,sn} | {type:'cyl', x,z,r,y0,y1}
    scene.add(this.group);

    const fabricBlue = register(new THREE.MeshStandardMaterial({ color: 0x1f4f9a, roughness: 0.75, side: THREE.DoubleSide }));
    const fabricWhite = register(new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.75, side: THREE.DoubleSide }));
    const metal = register(new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 1 }));
    const darkMetal = register(new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.5, metalness: 0.8 }));
    const coneMat = register(new THREE.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.55 }));
    const coneBand = register(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3, metalness: 0.1 }));
    const netMat = register(new THREE.MeshStandardMaterial({
      map: netTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff,
    }));
    netMat.map.repeat.set(24, 2);
    markShared(fabricBlue, fabricWhite, metal, darkMetal, coneMat, coneBand, netMat);

    const baseY = (x, z) => terrain.groundAt(x, z);
    const endZ = PAD.hz + 4;     // pilots' area just past the end of the pad

    // Pop-up tents
    const tentAt = (x, z, ry, roofMat) => {
      const g = new THREE.Group();
      const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 2.1, 8);
      for (const [lx, lz] of [[-1.45, -1.45], [1.45, -1.45], [-1.45, 1.45], [1.45, 1.45]]) {
        const leg = new THREE.Mesh(legGeo, metal); leg.position.set(lx, 1.05, lz); leg.castShadow = true; g.add(leg);
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.15, 0.7, 4, 1, true), roofMat);
      roof.rotation.y = Math.PI / 4; roof.position.y = 2.45; roof.castShadow = roof.receiveShadow = true; g.add(roof);
      const valance = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.22, 4, 1, true), roofMat);
      valance.rotation.y = Math.PI / 4; valance.position.y = 2.0; valance.castShadow = true; g.add(valance);
      const table = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.7), fabricWhite);
      table.position.set(0, 0.74, -0.6); table.castShadow = table.receiveShadow = true; g.add(table);
      g.position.set(x, baseY(x, z), z); g.rotation.y = ry;
      this.group.add(g);
      this._box(x, g.position.y + 1.4, z, 1.55, 1.4, 1.55, ry);
    };
    tentAt(-6, endZ + 3.5, 0.05, fabricBlue);
    tentAt(0.5, endZ + 4.5, -0.04, fabricWhite);
    tentAt(7, endZ + 3.2, 0.1, fabricBlue);

    // Safety net behind the pilots
    const netLen = 26;
    const net = new THREE.Mesh(new THREE.PlaneGeometry(netLen, 2.2), netMat);
    net.position.set(0.5, baseY(0.5, endZ - 1) + 1.1, endZ - 1);
    net.castShadow = true;
    this.group.add(net);
    const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.3, 8);
    for (let i = 0; i <= 6; i++) {
      const x = 0.5 - netLen / 2 + i * netLen / 6;
      const p = new THREE.Mesh(postGeo, darkMetal); p.position.set(x, baseY(x, endZ - 1) + 1.15, endZ - 1); p.castShadow = true;
      this.group.add(p);
    }
    this._box(0.5, net.position.y, endZ - 1, netLen / 2, 1.1, 0.05, 0);

    // Feather flags along the pad
    const flagGeo = (() => {
      // Feather/teardrop banner: a curved-top strip, 0.7 m wide, 3 m tall.
      const g = new THREE.PlaneGeometry(0.7, 3.0, 8, 16);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + 0.35, y = p.getY(i) + 1.5;         // x: 0 at the pole
        const top = 3.0 - 0.9 * Math.pow(x / 0.7, 2.0);           // sloped, rounded top
        p.setXYZ(i, x, (y / 3.0) * top, 0);
      }
      g.computeVertexNormals();
      return markShared(g);
    })();
    const flagMats = [
      flagTexture('#ff5a14', '#141414', 'FPV'), flagTexture('#f2f2f2', '#1f4f9a', 'RACE'), flagTexture('#141414', '#ff5a14', 'FPV'),
    ].map(map => {
      const m = new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.65 });
      register(m, [{ key: 'flag', fn: sh => {
        Object.assign(sh.uniforms, vegUniforms);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWindStrength;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FLAG_WAVE);
      } }]);
      return markShared(m);
    });
    const flagPole = new THREE.CylinderGeometry(0.02, 0.025, 3.6, 8);
    let fi = 0;
    // Kept to the ends of the pad so they frame the start without crowding the spawn view.
    for (const side of [-1, 1]) for (const z of [-PAD.hz + 4, PAD.hz - 16, PAD.hz - 3]) {
      const x = side * (PAD.hx + 1.8);
      const y = baseY(x, z);
      const pole = new THREE.Mesh(flagPole, darkMetal); pole.position.set(x, y + 1.8, z); pole.castShadow = true;
      const cloth = new THREE.Mesh(flagGeo, flagMats[fi++ % flagMats.length]);
      cloth.position.set(x, y + 0.55, z); cloth.rotation.y = side > 0 ? Math.PI : 0;
      cloth.castShadow = true; cloth.receiveShadow = true;
      this.group.add(pole, cloth);
      this.colliders.push({ type: 'cyl', x, z, r: 0.35, y0: y, y1: y + 3.6 });
    }

    // Cones at the pad corners and the start line
    const coneGeo = new THREE.ConeGeometry(0.16, 0.5, 20, 1, true);
    const bandGeo = new THREE.CylinderGeometry(0.075, 0.105, 0.09, 20, 1, true);
    const baseGeo = new THREE.BoxGeometry(0.36, 0.03, 0.36);
    for (const [x, z] of [[-PAD.hx, -PAD.hz], [PAD.hx, -PAD.hz], [-PAD.hx, PAD.hz], [PAD.hx, PAD.hz],
                          [-PAD.hx - 0.5, -PAD.hz * 0.55], [PAD.hx + 0.5, -PAD.hz * 0.55]]) {
      const y = baseY(x, z);
      const cone = new THREE.Mesh(coneGeo, coneMat); cone.position.set(x, y + 0.27, z); cone.castShadow = true;
      const band = new THREE.Mesh(bandGeo, coneBand); band.position.set(x, y + 0.33, z);
      const base = new THREE.Mesh(baseGeo, darkMetal); base.position.set(x, y + 0.015, z); base.castShadow = base.receiveShadow = true;
      this.group.add(cone, band, base);
      this.colliders.push({ type: 'cyl', x, z, r: 0.16, y0: y, y1: y + 0.52 });
    }
    this.group.traverse(o => { if (o.isMesh && o.receiveShadow === false && o.material !== netMat) o.receiveShadow = true; });
  }

  _box(cx, cy, cz, hx, hy, hz, ry) {
    this.colliders.push({ type: 'box', cx, cy, cz, hx, hy, hz, cs: Math.cos(ry), sn: Math.sin(ry) });
  }

  /** True if a sphere at p (radius r) touches any prop. */
  collide(p, r) {
    for (const c of this.colliders) {
      if (c.type === 'cyl') {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        const dy = p.y < c.y0 ? c.y0 - p.y : (p.y > c.y1 ? p.y - c.y1 : 0);
        if (Math.hypot(Math.max(d - c.r, 0), dy) < r) return true;
      } else {
        const dx = p.x - c.cx, dz = p.z - c.cz;
        const lx = dx * c.cs - dz * c.sn, lz = dx * c.sn + dz * c.cs, ly = p.y - c.cy;
        const ex = Math.max(Math.abs(lx) - c.hx, 0), ey = Math.max(Math.abs(ly) - c.hy, 0), ez = Math.max(Math.abs(lz) - c.hz, 0);
        if (Math.hypot(ex, ey, ez) < r) return true;
      }
    }
    return false;
  }
}

// ── Prop-wash dust ──
const DUST_MAX = 420;
export class Dust {
  constructor({ scene }) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(DUST_MAX * 3);
    this.alpha = new Float32Array(DUST_MAX);
    this.vel = new Float32Array(DUST_MAX * 3);
    this.life = new Float32Array(DUST_MAX);
    this.size = new Float32Array(DUST_MAX);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = { uColor: { value: new THREE.Color(0.55, 0.5, 0.42) }, uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute float aAlpha; attribute float aSize; uniform float uScale; varying float vA;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.05); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          gl_FragColor = vec4(uColor, vA * (1.0 - r) * (1.0 - r)); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.next = 0;
    this.acc = 0;
  }

  /** Dust colour follows the scene light so it never glows at night. */
  setLight(color) { this.uniforms.uColor.value.copy(color); }

  emit(x, y, z, vx, vy, vz, size) {
    const i = this.next; this.next = (this.next + 1) % DUST_MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 1; this.size[i] = size;
  }

  /** bareness: 0 on lush grass .. 1 on asphalt/dirt; wash: 0..1 thrust factor. */
  update(dt, drone, groundY, wash, bareness) {
    const agl = drone.y - groundY;
    const strength = wash * bareness * Math.max(0, 1 - agl / 2.2);
    this.acc += strength * 260 * dt;
    while (this.acc > 1) {
      this.acc -= 1;
      const a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.6;
      const sp = 1.5 + Math.random() * 3.5;
      this.emit(drone.x + Math.cos(a) * r, groundY + 0.05, drone.z + Math.sin(a) * r,
        Math.cos(a) * sp, 0.4 + Math.random() * 1.2, Math.sin(a) * sp, 0.12 + Math.random() * 0.25);
    }
    for (let i = 0; i < DUST_MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt * 0.55;
      const k = Math.exp(-dt * 1.6);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - dt * 0.25;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += dt * 0.35;
      this.alpha[i] = Math.max(0, this.life[i]) * 0.35;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.aAlpha.needsUpdate = g.attributes.aSize.needsUpdate = true;
  }

  /** A puff on a ground crash. */
  burst(x, y, z) {
    for (let n = 0; n < 60; n++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 4;
      this.emit(x, y + 0.1, z, Math.cos(a) * sp, 0.5 + Math.random() * 2.5, Math.sin(a) * sp, 0.15 + Math.random() * 0.3);
    }
  }
}

// ── Night floodlights ──
// Four towers around the course. Spot lights (no shadows — too costly for four
// big lights) plus emissive lamp heads that bloom. Enabled only for the night
// preset; toggling light visibility recompiles lit materials once.
export class Floodlights {
  constructor({ scene, terrain }) {
    this.group = new THREE.Group();
    this.group.name = 'Floodlights';
    this.lights = [];
    this.colliders = [];
    const poleMat = register(new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.45, metalness: 1 }));
    const headMat = register(new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.4, metalness: 0.6 }));
    this.lampMat = register(new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xfff1d6, emissiveIntensity: 0, roughness: 0.2,
    }));
    markShared(poleMat, headMat, this.lampMat);
    const H = 15;
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.2, H, 12);
    const headGeo = new THREE.BoxGeometry(2.4, 1.1, 0.35);
    const lampGeo = new THREE.PlaneGeometry(2.1, 0.85);
    for (const deg of [40, 130, 220, 310]) {
      const a = THREE.MathUtils.degToRad(deg), R = 78;
      const x = Math.cos(a) * R, z = Math.sin(a) * R, y = terrain.groundAt(x, z);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, y + H / 2, z); pole.castShadow = true; pole.receiveShadow = true;
      const head = new THREE.Group();
      head.position.set(x, y + H, z);
      head.lookAt(0, 0, 0);
      head.rotateX(0.25);
      const box = new THREE.Mesh(headGeo, headMat); box.castShadow = true;
      const lamp = new THREE.Mesh(lampGeo, this.lampMat); lamp.position.z = 0.18;
      head.add(box, lamp);
      const spot = new THREE.SpotLight(0xfff1d6, 0, 260, THREE.MathUtils.degToRad(38), 0.55, 2);
      spot.position.set(x, y + H, z);
      spot.target.position.set(x * 0.15, 0, z * 0.15);
      spot.castShadow = false;
      spot.visible = false;
      this.group.add(pole, head, spot, spot.target);
      this.lights.push(spot);
      this.colliders.push({ type: 'cyl', x, z, r: 0.25, y0: y, y1: y + H + 0.6 });
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** candela: lamp intensity; 0 turns the towers off (and hides them). */
  set(on, candela = 36000) {
    this.group.visible = true;              // towers stand in every preset
    this.lights.forEach(l => { l.visible = on; l.intensity = on ? candela : 0; });
    this.lampMat.emissiveIntensity = on ? 900 : 0;
  }

  collide(p, r) {
    for (const c of this.colliders) {
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      const dy = p.y < c.y0 ? c.y0 - p.y : (p.y > c.y1 ? p.y - c.y1 : 0);
      if (Math.hypot(Math.max(d - c.r, 0), dy) < r) return true;
    }
    return false;
  }
}
