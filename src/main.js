// FPV Sim — main module. Game logic (input, physics, lap timing, HUD,
// settings) lives here unchanged from the single-file version; everything
// that draws the world lives in src/render/*.
import * as THREE from 'three';
import { QUALITY_TIERS, createRenderer, DEFAULT_QUALITY } from './render/renderer.js';
import { Environment, ENV_PRESETS } from './render/environment.js';
import { disposeObject } from './render/materials.js';
import { createGateKit } from './render/gates.js';
import { Terrain, loadTerrainTextures } from './render/terrain.js';
import { Vegetation } from './render/vegetation.js';
import { Grass } from './render/grass.js';
import { Props, Dust, Floodlights, createDroneShadow } from './render/props.js';
import { loadMapIndex, loadSplatMap } from './worlds/splatmap.js';
import { createStats } from './ui/stats.js';
import { PostStack } from './render/post.js';
import { createCameraShake } from './render/fpvcam.js';

// ═══════════════════════════════════════════════
//  STORAGE — every persisted setting goes through here. localStorage
//  throws in private-mode Safari and when cookies are blocked, so all
//  access is guarded once, in one place, instead of at each call site.
// ═══════════════════════════════════════════════
const KEYS={
  map:'fpv_map', phy:'fpv_phy', theme:'fpv_theme', trees:'fpv_show_trees_',
  randomize:'fpv_world_randomize', hudOverlay:'fpv_hud_overlay',
  collideGates:'fpv_collide_gates', collideTrees:'fpv_collide_trees',
  flightMode:'fpv_flight_mode', ctrlAdv:'fpv_ui_controller_adv', phyAdv:'fpv_ui_physics_adv',
  hints:'fpv_ui_hints',
  bestLap:'fpv_best_lap', quality:'fpv_quality', touchMode:'fpv_touch_mode',
  camTilt:'fpv_cam_tilt', fov:'fpv_fov', camera:'fpv_camera', worldMap:'fpv_world_map',
};

const store={
  get(key,fallback=null){
    try{ const v=localStorage.getItem(key); return v===null?fallback:v; }catch(e){ return fallback; }
  },
  set(key,value){
    try{ localStorage.setItem(key,String(value)); return true; }catch(e){ return false; }
  },
  remove(key){ try{ localStorage.removeItem(key); }catch(e){} },
  getBool(key,fallback){ const v=store.get(key); return v===null?fallback:v==='1'; },
  setBool(key,value){ return store.set(key, value?'1':'0'); },
  getNum(key,fallback){ const v=parseFloat(store.get(key)); return Number.isFinite(v)?v:fallback; },
  getJSON(key,fallback=null){
    const v=store.get(key);
    if(v===null) return fallback;
    try{ return JSON.parse(v); }catch(e){ return fallback; }
  },
  setJSON(key,value){
    try{ return store.set(key, JSON.stringify(value)); }catch(e){ return false; }
  },
};

// ═══════════════════════════════════════════════
//  MAPPING — persistent config
// ═══════════════════════════════════════════════
const CHANNELS = [
  { key:'throttle', label:'THROTTLE',       desc:'Vertical thrust',    stick:'Left stick ↑↓', bipolar:false },
  { key:'yaw',      label:'YAW',            desc:'Rotate on Z axis',   stick:'Left stick ←→', bipolar:true  },
  { key:'roll',     label:'ROLL',           desc:'Tilt sideways',      stick:'Right stick ←→', bipolar:true  },
  { key:'pitch',    label:'PITCH',          desc:'Tilt forward',       stick:'Right stick ↑↓', bipolar:true  },
];

const DEFAULT_MAP = {
  throttle:{ axis:1, invert:true  },
  yaw:     { axis:0, invert:false },
  roll:    { axis:2, invert:false },
  pitch:   { axis:3, invert:true  },
  deadband: 0.05,
};

const axisMap = Object.assign(JSON.parse(JSON.stringify(DEFAULT_MAP)), store.getJSON(KEYS.map, {}));
function saveMap(){ store.setJSON(KEYS.map, axisMap); }

// ═══════════════════════════════════════════════
//  PHYSICS — mutable config + presets
// ═══════════════════════════════════════════════
const G=9.81, MASS=0.5;
const GATE_R=3, N_GATES=12; // gate ring radius — 20% bigger than the original 2.5
// Camera tilt/FOV are exposed as settings, so they persist like every other setting.
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
let camTiltDeg = clamp(store.getNum(KEYS.camTilt,20), 0, 90);
let fovDeg     = clamp(store.getNum(KEYS.fov,85), 50, 120);

const PHY_KEYS = ['hoverPct','rateDeg','yawDeg','omegaR','linDrag','angDrag','idleThrottle','hoverStick'];

const PHY_PRESETS = {
  // hoverPct: % throttle needed to hover → TWR = 1/hoverPct
  // linDrag: air resistance (quads are small/fast, real drag is very low ~0.03-0.08)
  // High linDrag = "underwater" feeling: kills all momentum
  // hoverStick: % of stick travel where hover occurs (throttle curve, decoupled from TWR)
  beginner:  { hoverPct:0.28, rateDeg:280,  yawDeg:140, omegaR:10, linDrag:0.10, angDrag:0.88, idleThrottle:0.12, hoverStick:0.5 },
  racing:    { hoverPct:0.18, rateDeg:700,  yawDeg:350, omegaR:25, linDrag:0.04, angDrag:0.92, idleThrottle:0.07, hoverStick:0.5 },
  freestyle: { hoverPct:0.22, rateDeg:550,  yawDeg:260, omegaR:20, linDrag:0.05, angDrag:0.91, idleThrottle:0.08, hoverStick:0.5 },
  cinematic: { hoverPct:0.28, rateDeg:160,  yawDeg: 80, omegaR: 8, linDrag:0.08, angDrag:0.86, idleThrottle:0.14, hoverStick:0.5 },
};

// Default config (not a preset — matches none exactly, tuned for a punchy but controllable feel)
const PHY_DEFAULT = { hoverPct:0.19, rateDeg:620, yawDeg:400, omegaR:41, linDrag:0.14, angDrag:0.90, idleThrottle:0.01, hoverStick:0.5 };

// Load saved physics or fall back to the tuned default
const phy = Object.assign({}, PHY_DEFAULT);
(function loadPhy(){
  const saved = store.getJSON(KEYS.phy);
  if(!saved) return;
  PHY_KEYS.forEach(k=>{ if(typeof saved[k]==='number') phy[k]=saved[k]; });
})();

function savePhy(label){
  const toSave = {};
  PHY_KEYS.forEach(k=>toSave[k]=phy[k]);
  toSave._label = label || detectPresetName() || 'custom';
  toSave._ts = Date.now();
  return store.setJSON(KEYS.phy, toSave) ? toSave._ts : null;
}

function detectPresetName(){
  for(const [name,p] of Object.entries(PHY_PRESETS)){
    if(PHY_KEYS.every(k=>Math.abs((p[k]||0)-(phy[k]||0))<0.001)) return name;
  }
  return null;
}

function resetPhy(){
  store.remove(KEYS.phy);
  Object.assign(phy, PHY_DEFAULT);
  recomputePhyDerived();
  syncPhyUI();
  const preset=detectPresetName();
  if(preset) markPreset(preset);
  else { document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active')); updatePresetDesc(null); }
  showSaveToast('CONFIG RESET', '#ffb830');
}

// ── Derived physics values ──
// These are pure functions of the slider values but were being recomputed on
// every physics step (throttleP() alone ran two Math.log calls). With the fixed
// timestep below running up to 8 steps per frame that adds up, so they are
// cached here and refreshed whenever a slider, preset or reset changes `phy`.
const derived={ maxThr:0, throttleP:1, ratePitch:0, rateRoll:0, rateYaw:0 };
function recomputePhyDerived(){
  derived.maxThr = MASS*G/phy.hoverPct;
  const y0 = clamp((phy.hoverPct-phy.idleThrottle)/(1-phy.idleThrottle),1e-4,1-1e-4);
  derived.throttleP = Math.log(y0)/Math.log(phy.hoverStick);
  derived.ratePitch = derived.rateRoll = phy.rateDeg*Math.PI/180;
  derived.rateYaw   = phy.yawDeg*Math.PI/180;
}

// ═══════════════════════════════════════════════
//  DOM CACHE — every element touched from the render loop is resolved
//  once here. updateHUD alone used to run seven getElementById calls per
//  frame, plus two more for the ADI readouts.
// ═══════════════════════════════════════════════
const el={};
'spd alt thrp tilt-deg fov-disp thr-fill gnum gtot lapnum gpname adi adi-roll adi-pitch \
fpv-hud crash-flash crash-banner crash-meter-fill crash-title toast help splash btn-start \
lap-time lap-best lap-delta best-lap-disp map-modal map-card save-status save-ts wiz-status \
wiz-btn no-gp db-slider db-disp axes-grid ch-body ap-grid preset-desc sound-btn fullscreen-btn \
cfg-tilt-slider cfg-tilt-disp cfg-fov-slider cfg-fov-disp touch-controls tstick-l tstick-r \
tknob-l tknob-r quality-select quality-note touch-select theme-select reset-btn save-btn \
close-btn map-btn randomize-btn clear-best-btn reset-btn-hud'
  .split(/\s+/).forEach(id=>{
    // camelCase alias so `el.thrFill` reads better than el['thr-fill']
    const node=document.getElementById(id);
    el[id]=node;
    el[id.replace(/-(\w)/g,(_,c)=>c.toUpperCase())]=node;
  });

// ═══════════════════════════════════════════════
//  DEBUG / REPRODUCIBILITY URL PARAMS
//  ?seed=N      deterministic world layout (screenshots, bug reports)
//  ?env=NAME    force an environment preset      ?q=TIER  force a quality tier
//  ?autostart=1 skip the splash once loaded       ?stats=1 show the perf overlay
// ═══════════════════════════════════════════════
const URLP=new URLSearchParams(location.search);

// First visit downloads ~10-25 MB (sky, ground textures, libraries); show the
// count on the FLY button until everything is in.
THREE.DefaultLoadingManager.onProgress=(url,loaded,total)=>{
  if(el.btnStart.disabled) el.btnStart.textContent=`LOADING… ${loaded}/${total}`;
};

// Seeded PRNG (mulberry32). World layout draws from this instead of
// Math.random, so a seed reproduces the exact same gates and trees.
function mulberry32(a){
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
let worldSeed=URLP.has('seed') ? (parseInt(URLP.get('seed'),10)>>>0) : (Math.random()*2**32)>>>0;
let rng=mulberry32(worldSeed);
function reseedWorld(seed){
  worldSeed=(seed===undefined ? (Math.random()*2**32) : seed)>>>0;
  rng=mulberry32(worldSeed);
}

// ═══════════════════════════════════════════════
//  RENDERING
//  The scene is lit by a photographed HDR sky (image-based light + a
//  measured sun), shadowed by camera-following cascades, hazed by height fog,
//  and — above LOW — finished by a camera-model post stack (render/post.js).
// ═══════════════════════════════════════════════
const isCoarsePointer = window.matchMedia && matchMedia('(pointer: coarse)').matches;
let quality = URLP.get('q') || store.get(KEYS.quality) || DEFAULT_QUALITY;
if(!QUALITY_TIERS[quality]) quality=DEFAULT_QUALITY;

const renderer=createRenderer();
document.body.appendChild(renderer.domElement);
const stats=createStats(renderer, URLP.has('stats'));
let debugFreeze=URLP.has('freeze');   // hold the drone still (screenshots)

const scene=new THREE.Scene();
// far reaches the ridge line on the horizon (render/terrain.js); near stays
// below the closest the drone can get to a gate bar (DRONE_R).
const cam=new THREE.PerspectiveCamera(fovDeg,innerWidth/innerHeight,.1,4000);
const Q_TILT=new THREE.Quaternion();
const _TILT_AXIS=new THREE.Vector3(1,0,0);

// The post stack is created once the environment exists (see render/post.js).
let post=null;

const env=new Environment({renderer, scene, camera:cam, tier:QUALITY_TIERS[quality]});

// Environment preset (was the DAY/NIGHT theme). Old saved values map across.
let theme=URLP.get('env') || store.get(KEYS.theme,'midday');
if(theme==='day') theme='midday';
if(theme==='night-neon') theme='night';
if(!ENV_PRESETS[theme]) theme='midday';

// Terrain — the flying field (render/terrain.js). The height mesh is built
// synchronously because gate placement and physics need groundAt() right
// away; its textures stream in (FLY waits for them).
const terrain=new Terrain({segments:QUALITY_TIERS[quality].terrainSegments});
scene.add(terrain.mesh);

// The world the drone flies in: the procedural field, or a captured
// Gaussian-splat map (src/worlds/splatmap.js). Physics, respawn and gate
// placement ask groundAt(), never the terrain directly.
let world=null;
function groundAt(x,z){ return world ? world.groundAt(x,z) : terrain.groundAt(x,z); }
const terrainReady=loadTerrainTextures(renderer).then(t=>terrain.setTextures(t));
const terrainHeightTex=terrain.makeHeightTexture(420,512);

// Grass — GPU-placed blades around the camera (render/grass.js): a dense
// near layer and a sparser far one. Density is per tier, so a quality change
// rebuilds them.
let grassLayers=[], grassTier=null;
function buildGrass(q){
  if(grassTier===q.grass) return;
  grassLayers.forEach(g=>{ scene.remove(g.mesh); g.mesh.geometry.dispose(); });
  grassLayers=q.grass.map(layer=>new Grass({layer, terrain, heightTex:terrainHeightTex}));
  grassLayers.forEach(g=>{ if(world) g.mesh.visible=false; scene.add(g.mesh); });
  grassTier=q.grass;
}
buildGrass(QUALITY_TIERS[quality]);

// Trees — procedural species with impostor LODs and the surrounding woods
// (render/vegetation.js). Growing the variants is async; the course scatter
// runs once they exist and again on every world rebuild.
const N_TREES=90, N_BUSHES=70;
const vegetation=new Vegetation({renderer, scene, tier:QUALITY_TIERS[quality]});
let vegetationReady=false;
const vegReady=vegetation.init().then(()=>{
  vegetation.scatterForest(terrain, QUALITY_TIERS[quality].forest);
  vegetationReady=true;
  buildTrees();
});

// Every preset shows trees by default now (the old NIGHT theme hid them to
// keep the neon readable); each preset still remembers the player's choice.
function loadShowTreesFor(name){ return store.getBool(KEYS.trees+name, true); }
let showTrees=loadShowTreesFor(theme);
function applyTreeVisibility(){ vegetation.setVisible(showTrees && !world); }

// Trees are kept clear of gates, but allowed close to the spawn/pad area.
function buildTrees(){
  if(!vegetationReady) return;
  vegetation.scatterCourse(rng, terrain, gates, {count:N_TREES, bushes:N_BUSHES});
  applyTreeVisibility();
}

// Pilots' area, the drone's own shadow and prop-wash dust (render/props.js).
const props=new Props({scene, terrain});
const floodlights=new Floodlights({scene, terrain});
const droneShadow=createDroneShadow();
scene.add(droneShadow);
const dust=new Dust({scene});
const _dustLight=new THREE.Color();

// Circuit — square MultiGP-style racing gates (visuals in render/gates.js)
const gates=[];
const T_FRAME=0.48;                     // bar cross-section (thick frame border)
const BAR_LEN=2*GATE_R+T_FRAME;
const POST_R=0.09;
const gateKit=createGateKit({GATE_R, T_FRAME, POST_R});

// Gate states are shown by the LED strip: 'next' (bright yellow),
// 'upcoming' (dim orange) or 'passed' (green).
function setGateState(g,state){ gateKit.setState(g,state); }

let nextGate=0;

// A captured map's authored gate slots: "randomize" picks a subset (up to
// N_GATES) and keeps them in authored order, so the lap still flows.
function slotLayout(slots){
  const pick=slots.map((s,i)=>({s,i,k:rng()})).sort((a,b)=>a.k-b.k).slice(0,Math.min(N_GATES,slots.length));
  return pick.sort((a,b)=>a.i-b.i).map(({s})=>({px:s.position[0], pz:s.position[2],
    pyAGL:null, py:s.position[1], ry:(s.yawDeg||0)*Math.PI/180}));
}

function buildCircuit(){
  gates.forEach(g=>{ scene.remove(g.group); disposeObject(g.group); }); gates.length=0;
  const layout=[];
  if(world && world.gateSlots && world.gateSlots.length){
    layout.push(...slotLayout(world.gateSlots));
  } else {
    let angle=0;
    for(let i=0;i<N_GATES;i++){
      angle+=(Math.PI*2/N_GATES)*(0.7+rng()*0.6);
      const r=21.6+rng()*31.2; // placement radius — 20% wider than the original 18–44 range
      const px=Math.cos(angle)*r+(rng()-.5)*12;
      const pz=Math.sin(angle)*r+(rng()-.5)*12;
      const pyAGL=3.6+rng()*9.6; // altitude above the local ground — 20% taller than the original range
      const ry=angle+Math.PI/2+(rng()-.5)*0.45;
      layout.push({px,pz,pyAGL,py:null,ry});
    }
  }
  for(let i=0;i<layout.length;i++){
    const {px,pz,pyAGL,ry}=layout[i];
    const groundY=groundAt(px,pz);
    const py=layout[i].py ?? groundY+pyAGL;
    const {group,led}=gateKit.build(i+1, py, groundY);
    group.position.set(px,py,pz); group.rotation.y=ry; scene.add(group);
    // cos/sin of the gate yaw are needed for every collision test; caching them
    // here keeps two trig calls per gate out of the physics step.
    const g={group,led,groundY,pos:new THREE.Vector3(px,py,pz), cs:Math.cos(ry), sn:Math.sin(ry)};
    setGateState(g, i===nextGate%layout.length ? 'next' : 'upcoming');
    gates.push(g);
  }
  el.gtot.textContent=gates.length;
  if(!world){ terrain.setWear(gates.map(g=>g.pos)); buildTrees(); }
  // The gate/lap readout is refreshed by initHUDState() once the lap-timer
  // state below has been declared.
}
buildCircuit();

// ── Camera model settings (lens, shutter, exposure, profile, feed, shake) ──
const CAM_DEFAULTS={lens:'wide', shutter:'nd8', autoExposure:true, profile:'digital', feed:'digital', shake:0.35};
const camSettings=Object.assign({}, CAM_DEFAULTS, store.getJSON(KEYS.camera, {}));
function saveCamSettings(){ store.setJSON(KEYS.camera, camSettings); }
const cameraShake=createCameraShake();

// Analog video link: quality falls with range from the pilot standing at the
// launch pad, and each tree canopy crossing the line of sight knocks it down
// further. Sampled at 10 Hz and smoothed, like RSSI.
const PILOT_POS=new THREE.Vector3(0,1.6,6);
let linkQ=1, linkTarget=1, linkTimer=0;
function linkQuality(dt){
  linkTimer-=dt;
  if(linkTimer<=0){
    linkTimer=0.1;
    const dx=drone.pos.x-PILOT_POS.x, dy=drone.pos.y-PILOT_POS.y, dz=drone.pos.z-PILOT_POS.z;
    const d2=dx*dx+dz*dz, d=Math.sqrt(d2+dy*dy);
    let q=1-THREE.MathUtils.smoothstep(d,110,420);
    if(!world && showTrees && d2>1) q*=Math.pow(0.75, vegetation.canopiesCrossed(PILOT_POS, drone.pos));
    linkTarget=q;
  }
  linkQ+=(linkTarget-linkQ)*Math.min(1,dt*5);
  return linkQ;
}

// The post stack is only built for tiers that use it (LOW never allocates it).
function ensurePost(q){
  if(!q.post || post) return;
  post=new PostStack({renderer, scene, camera:cam, tier:q});
  post.applySettings(camSettings);
  if(env.preset) post.setEnvironment(env);
}

// ── Quality ──
function applyQuality(name){
  const q=QUALITY_TIERS[name]||QUALITY_TIERS.high;
  ensurePost(q);
  renderer.setPixelRatio(Math.min(devicePixelRatio,q.pixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  env.setTier(q);
  buildGrass(q);
  // LOW renders straight to the screen, so three tone-maps in the materials;
  // every other tier tone-maps (with auto exposure) in the post stack.
  renderer.toneMapping = q.post ? THREE.NoToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = q.post ? 1 : env.staticExposure;
  if(post){ post.setTier(q); post.setSize(innerWidth, innerHeight); }
  applyCameraFov();
}
applyQuality(quality);

// ── Camera FOV ──
// The lens model renders a slightly wider frame and distorts it back, so the
// camera FOV is derived from the player's FOV rather than equal to it.
function applyCameraFov(){
  cam.fov = post ? post.renderFov(fovDeg) : fovDeg;
  cam.updateProjectionMatrix();
  env.updateFrustums();
}

// ── Environment preset switching ──
let envReady=null;
function applyEnvironment(name){
  envReady=env.setPreset(name).then(()=>{
    floodlights.set(!!env.preset.night);
    renderer.toneMappingExposure=QUALITY_TIERS[quality].post ? 1 : env.staticExposure;
    if(post) post.setEnvironment(env);
  });
  return envReady;
}
applyEnvironment(theme);

// ═══════════════════════════════════════════════
//  DRONE STATE
// ═══════════════════════════════════════════════
const drone={
  pos:new THREE.Vector3(0,1.5,0),
  vel:new THREE.Vector3(),
  quat:new THREE.Quaternion(),
  omega:new THREE.Vector3(),
  thr:0, // current effective thrust (with motor spool-up delay)
};
let crashState=null; // {t, cause} while the drone is crashed/falling after a collision
const CRASH_RESPAWN_T=1.8;

let collideGates=store.getBool(KEYS.collideGates,true);
let collideTrees=store.getBool(KEYS.collideTrees,true);

// Every respawn (crash recovery or a plain reset) that doesn't specify a position
// lands here. 1.5m keeps the worst case (zero thrust — the idle=0% slider extreme)
// under the ~8.5 m/s HARD_IMPACT_VY crash threshold, so a stationary drone settles
// instead of re-crashing: idle thrust (phy.idleThrottle) is deliberately too weak
// to hold altitude — "armed but not flying", not "hovering" — so any respawn point
// meaningfully higher than this free-falls into another ground-impact crash if the
// pilot isn't already on the throttle within about a second.
const RESPAWN_ALT=1.5;

// ── Respawn vs. restart ──
// These used to be one function, so any crash silently threw away the whole run.
// respawnDrone() only restores flyable state; resetRun() is the explicit restart
// bound to R and the HUD button.
function respawnDrone(pos, quat){
  drone.vel.set(0,0,0); drone.omega.set(0,0,0);
  drone.thr=phy.idleThrottle;
  crashState=null;
  inp.throttle=0;
  const sp=world && world.spawn;
  if(pos) drone.pos.copy(pos);
  else if(sp) drone.pos.fromArray(sp.position);
  else drone.pos.set(0,groundAt(0,0)+RESPAWN_ALT,0);
  if(quat) drone.quat.copy(quat);
  else if(sp) drone.quat.setFromAxisAngle(_AXIS_Y_WORLD,(sp.yawDeg||0)*Math.PI/180);
  else drone.quat.identity();
  hideCrashBanner();
  if(post) post.resetHistory();
}

// Put the drone back just short of the gate it was heading for, facing it, so
// clipping gate 11 of 12 costs a few seconds instead of the entire lap. See
// RESPAWN_ALT above for why this uses a fixed low altitude, not the gate's own
// (gates sit 3.6-13.2m up — see buildCircuit — and respawning there caused a
// crash → respawn → free-fall → crash loop for anyone not immediately on the stick,
// since the target gate hadn't advanced and every respawn repeated identically).
const _respawnPos=new THREE.Vector3(), _respawnQuat=new THREE.Quaternion(),
      _AXIS_Y_WORLD=new THREE.Vector3(0,1,0);
function respawnAtCurrentGate(){
  if(!gates.length){ respawnDrone(); return; }
  const g=gates[nextGate%gates.length];
  // 9 m back along the gate's own facing axis (local -Z), clear of the frame.
  _respawnPos.set(g.sn*9, 0, g.cs*9).add(g.pos);
  _respawnPos.y=groundAt(_respawnPos.x,_respawnPos.z)+RESPAWN_ALT;
  const yaw=Math.atan2(g.pos.x-_respawnPos.x, g.pos.z-_respawnPos.z)+Math.PI;
  _respawnQuat.setFromAxisAngle(_AXIS_Y_WORLD, yaw);
  respawnDrone(_respawnPos,_respawnQuat);
}

function resetRun(){
  respawnDrone();
  leftStick.reset();   // drop the latched virtual throttle back to zero
  nextGate=0;
  gates.forEach((g,i)=>setGateState(g,i===0?'next':'upcoming'));
  resetLapTimer();
  updateGateHUD();
}

function flashCrash(){
  const node=el.crashFlash;
  if(!node) return;
  node.classList.add('show');
  setTimeout(()=>node.classList.remove('show'),120);
}

const CRASH_LABELS={gate:'💥 GATE COLLISION', tree:'💥 TREE COLLISION', ground:'💥 GROUND IMPACT', obstacle:'💥 OBSTACLE HIT'};
function showCrashBanner(cause){
  el.crashTitle.textContent=CRASH_LABELS[cause]||CRASH_LABELS.ground;
  el.crashBanner.classList.add('show');
}
function hideCrashBanner(){
  el.crashBanner.classList.remove('show');
  el.crashMeterFill.style.width='0%';
}

function triggerCrash(cause){
  if(crashState) return;
  crashState={t:0, cause};
  drone.omega.set((Math.random()-.5)*16,(Math.random()-.5)*16,(Math.random()-.5)*16);
  lapDirty=true; updateLapDirtyUI();
  if(cause==='ground') dust.burst(drone.pos.x, groundAt(drone.pos.x,drone.pos.z), drone.pos.z);
  showCrashBanner(cause);
  flashCrash();
  playCrashThud();
}

// ═══════════════════════════════════════════════
//  WORLD GENERATION — randomize-on-reset toggle
// ═══════════════════════════════════════════════
let randomizeOnReset=store.getBool(KEYS.randomize,true);

// ═══════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════
const keys={};
const PREVENT_KEYS=new Set(['Space','ShiftLeft','ShiftRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);

// Which device most recently produced real input. A gamepad that is merely
// plugged in no longer blanks the keyboard, and touching a virtual stick
// takes over from either.
let inputSource='keyboard';

document.addEventListener('keydown',e=>{
  if(e.repeat) return;
  keys[e.code]=true;
  inputSource='keyboard';
  if(PREVENT_KEYS.has(e.code)) e.preventDefault();
  if(e.code==='Escape' && settingsOpen){ closeSettings(); return; }
  // Flight hotkeys must not fire through the settings modal — pressing R there
  // used to silently reset the run and reshuffle the world behind the dialog.
  if(settingsOpen) return;
  if(e.code==='KeyR'){ resetRun(); if(randomizeOnReset) buildCircuit(); }
  if(e.code==='KeyM') toggleSettings();
  if(e.key==='?') showHelp();
  if(e.code==='KeyP') stats.toggle();
});
document.addEventListener('keyup',e=>{ keys[e.code]=false; });

// A key held while the window loses focus never receives its keyup, which used
// to leave the throttle pinned on return.
function releaseAllKeys(){ for(const k in keys) keys[k]=false; }
window.addEventListener('blur',releaseAllKeys);
document.addEventListener('visibilitychange',()=>{ if(document.hidden) releaseAllKeys(); });

const inp={throttle:0,roll:0,pitch:0,yaw:0};

function applyDeadband(v,d){
  if(Math.abs(v)<d) return 0;
  return (v-Math.sign(v)*d)/(1-d);
}

function readAxisValue(axes, cfg, bipolar){
  if(cfg.axis<0||cfg.axis>=axes.length) return 0;
  let v=axes[cfg.axis];
  if(cfg.invert) v=-v;
  if(bipolar){
    return clamp(applyDeadband(v, axisMap.deadband),-1,1);
  } else {
    v=(v+1)/2;
    const d2=axisMap.deadband/2;
    if(v<d2) return 0;
    return clamp((v-d2)/(1-d2),0,1);
  }
}

// Gamepad axes at the moment of connection. A pad only claims control once one
// of its axes has moved appreciably from that resting state, so a plugged-in but
// untouched controller doesn't make the keyboard look broken.
let gpBaseline=null, gpIndex=-1;
const GP_WAKE_THRESHOLD=0.25;

function pollGamepad(){
  const pads=navigator.getGamepads();
  let gp=gpIndex>=0?pads[gpIndex]:null;
  if(!gp){
    gpIndex=-1;
    for(let i=0;i<pads.length;i++) if(pads[i]){ gp=pads[i]; gpIndex=i; break; }
    if(gp) gpBaseline=Array.from(gp.axes);
  }
  if(!gp) return null;
  if(!gpBaseline || gpBaseline.length!==gp.axes.length) gpBaseline=Array.from(gp.axes);
  for(let i=0;i<gp.axes.length;i++){
    if(Math.abs(gp.axes[i]-gpBaseline[i])>GP_WAKE_THRESHOLD){ inputSource='gamepad'; break; }
  }
  return gp;
}

function readInput(dt){
  const gp=pollGamepad();

  if(inputSource==='gamepad' && gp){
    const ax=gp.axes;
    inp.throttle=readAxisValue(ax, axisMap.throttle, false);
    inp.yaw     =readAxisValue(ax, axisMap.yaw,      true);
    inp.roll    =readAxisValue(ax, axisMap.roll,     true);
    inp.pitch   =readAxisValue(ax, axisMap.pitch,    true);
  } else if(inputSource==='touch'){
    inp.throttle=touchInput.throttle;
    inp.yaw     =touchInput.yaw;
    inp.roll    =touchInput.roll;
    inp.pitch   =touchInput.pitch;
  } else {
    // Keyboard — cumulative throttle
    if(keys['Space'])    inp.throttle=Math.min(inp.throttle+dt*1.2,1);
    if(keys['ShiftLeft']||keys['ShiftRight']) inp.throttle=Math.max(inp.throttle-dt*1.2,0);

    // Roll and Pitch — letter keys only (← → freed for FOV)
    inp.roll =clamp((keys['KeyD']?1:0)-(keys['KeyA']?1:0),-1,1);
    inp.pitch=clamp((keys['KeyW']?1:0)-(keys['KeyS']?1:0),-1,1);
    inp.yaw  =clamp((keys['KeyE']?1:0)-(keys['KeyQ']?1:0),-1,1);
  }

  // Camera tilt (↑ ↓) and FOV (← →) stay on the keyboard in every mode
  if(keys['ArrowUp'])   { camTiltDeg=Math.min(camTiltDeg+dt*30, 90); queueViewSave(); }
  if(keys['ArrowDown']) { camTiltDeg=Math.max(camTiltDeg-dt*30,  0); queueViewSave(); }
  if(keys['ArrowLeft'])  { fovDeg=Math.max(fovDeg-dt*28, 50); applyCameraFov(); queueViewSave(); }
  if(keys['ArrowRight']) { fovDeg=Math.min(fovDeg+dt*28,120); applyCameraFov(); queueViewSave(); }
}

// Camera tilt/FOV change continuously while a key is held; persist once the
// player lets go rather than writing to localStorage every frame.
let viewSaveTimer=null;
function queueViewSave(){
  clearTimeout(viewSaveTimer);
  viewSaveTimer=setTimeout(()=>{
    store.set(KEYS.camTilt, Math.round(camTiltDeg));
    store.set(KEYS.fov, Math.round(fovDeg));
  },400);
}

// ═══════════════════════════════════════════════
//  TOUCH CONTROLS — two virtual sticks in the Mode 2 layout.
//  Left is throttle + yaw and the throttle axis is self-latching (it stays where
//  released, like a real throttle); right is pitch + roll and springs to centre.
// ═══════════════════════════════════════════════
const touchInput={throttle:0,yaw:0,roll:0,pitch:0};

function initStick(stickEl, knobEl, opts){
  let pointerId=null, cx=0, cy=0;
  // Deflection is stored normalized in [-1,1] rather than pixels, so the latched
  // throttle survives both a release and the smaller mobile stick size.
  let nx=0, ny=opts.latchY?1:0;

  // Travel is read from the live layout — the stick shrinks under the mobile
  // media query, and a hardcoded pixel radius would overflow its base there.
  const travel=()=>Math.max(1, (stickEl.offsetWidth-knobEl.offsetWidth)/2);

  const draw=()=>{
    const t=travel();
    knobEl.style.transform=`translate(${nx*t}px,${ny*t}px)`;
  };
  // Screen Y grows downward; sticks read "up" as positive.
  const apply=()=>opts.onMove(nx,-ny);

  const move=e=>{
    if(pointerId===null || e.pointerId!==pointerId) return;
    const t=travel();
    let dx=(e.clientX-cx)/t, dy=(e.clientY-cy)/t;
    const dist=Math.hypot(dx,dy);
    if(dist>1){ dx/=dist; dy/=dist; }   // clamp to the circular gate
    nx=dx; ny=dy;
    draw(); apply();
    e.preventDefault();
  };

  const end=e=>{
    if(pointerId===null || e.pointerId!==pointerId) return;
    stickEl.releasePointerCapture?.(pointerId);
    pointerId=null;
    nx=0;                     // yaw/roll always recentre
    if(!opts.latchY) ny=0;    // pitch recentres; throttle holds where it was left
    draw(); apply();
  };

  stickEl.addEventListener('pointerdown',e=>{
    if(pointerId!==null) return;
    pointerId=e.pointerId;
    const r=stickEl.getBoundingClientRect();
    cx=r.left+r.width/2; cy=r.top+r.height/2;
    stickEl.setPointerCapture?.(e.pointerId);
    inputSource='touch';
    move(e);
    e.preventDefault();
  });
  stickEl.addEventListener('pointermove',move);
  stickEl.addEventListener('pointerup',end);
  stickEl.addEventListener('pointercancel',end);

  apply();
  return {
    redraw:draw,
    reset(){ nx=0; ny=opts.latchY?1:0; draw(); apply(); },
  };
}

// Left stick: vertical = throttle mapped from [-1,1] to [0,1], horizontal = yaw.
const leftStick=initStick(el.tstickL, el.tknobL, {
  latchY:true,
  onMove:(x,y)=>{ touchInput.yaw=x; touchInput.throttle=clamp((y+1)/2,0,1); },
});
// Right stick: self-centering pitch/roll, same sign convention as the keyboard.
const rightStick=initStick(el.tstickR, el.tknobR, {
  latchY:false,
  onMove:(x,y)=>{ touchInput.roll=x; touchInput.pitch=y; },
});

let touchMode=store.get(KEYS.touchMode,'auto');
if(!['auto','on','off'].includes(touchMode)) touchMode='auto';
function sticksVisible(){ return touchMode==='on' || (touchMode==='auto' && isCoarsePointer); }
function applyTouchMode(){
  const on=sticksVisible();
  el.touchControls.classList.toggle('on',on);
  document.body.classList.toggle('sticks',on);
  document.body.classList.toggle('touch',on||isCoarsePointer);
  if(!on && inputSource==='touch') inputSource='keyboard';
  // Knob travel is measured from layout, which is only meaningful once the
  // overlay is displayed — and it changes across the mobile breakpoint.
  if(on){ leftStick.redraw(); rightStick.redraw(); }
}

// ═══════════════════════════════════════════════
//  PHYSICS (Acro)
//  — idle throttle: armed motors generate minimum
//    thrust even at 0% throttle
// ═══════════════════════════════════════════════
const _up=new THREE.Vector3(),_frc=new THREE.Vector3(),_dq=new THREE.Quaternion(),
      _omegaAxis=new THREE.Vector3();

// Balanced-mode scratch objects (module-level, reused every frame — avoids per-frame allocation)
const _AXIS_X=new THREE.Vector3(1,0,0), _AXIS_Y=new THREE.Vector3(0,1,0), _AXIS_Z=new THREE.Vector3(0,0,1);
const _qYaw=new THREE.Quaternion(), _qPitch=new THREE.Quaternion(), _qRoll=new THREE.Quaternion();
const _qTarget=new THREE.Quaternion(), _qErr=new THREE.Quaternion();
const _fwdXZ=new THREE.Vector3();

// Realism constants that don't depend on sliders (to avoid complicating the UI)
const MOTOR_SPOOL_T=0.10;     // s — motor spool-up/down time (ESC + propeller inertia)
const YAW_SNAP_FACTOR=0.55;   // yaw accelerates slower than roll/pitch (weaker reaction torque)
const QUAD_DRAG_RATIO=0.15;   // portion of drag proportional to v² (in addition to linear)
const GROUND_EFFECT_ALT=0.6, GROUND_EFFECT_BOOST=0.22; // air cushion near the ground
const HARD_IMPACT_VY=8.5;     // m/s of vertical impact velocity that triggers a crash
const DRONE_R=0.15;           // approximate drone radius for collisions
const ANGLE_MAX=45*Math.PI/180;  // Balanced mode: max commanded bank/pitch angle
const ANGLE_P_GAIN=8;            // Balanced mode: rad/s commanded per rad of angle error

// flightMode: 'acro' (rate control, no self-level) or 'balanced' (self-leveling, angle control)
let flightMode = store.get(KEYS.flightMode)==='balanced' ? 'balanced' : 'acro';

// Balanced mode: builds a target attitude (current heading + targetPitch/targetRoll) and returns the
// body-frame rotation (x,z components) needed to get there, via a quaternion attitude error — NOT two
// independent scalar angle readings, which would cross-couple roll and pitch whenever both are nonzero.
function balancedError(targetPitch, targetRoll){
  // Heading of the drone: the yaw that maps the reference forward (0,0,-1) onto the current
  // forward. Rotating (0,0,-1) about +Y by yaw gives (-sin yaw, 0, -cos yaw), so the heading is
  // atan2(-fwd.x, -fwd.z) — with the sign flipped the target frame ends up mirrored about the
  // world axes and roll/pitch cross-couple with heading (at 45° of yaw, pitch commands roll).
  _fwdXZ.set(0,0,-1).applyQuaternion(drone.quat);
  let yaw;
  if(_fwdXZ.x*_fwdXZ.x+_fwdXZ.z*_fwdXZ.z > 1e-6){
    yaw=Math.atan2(-_fwdXZ.x,-_fwdXZ.z);
  } else {
    // Nose straight up/down: forward has no horizontal component, so take the heading from the
    // body right axis instead — rotating (1,0,0) about +Y by yaw gives (cos yaw, 0, -sin yaw).
    _fwdXZ.set(1,0,0).applyQuaternion(drone.quat);
    yaw=Math.atan2(-_fwdXZ.z,_fwdXZ.x);
  }
  _qYaw.setFromAxisAngle(_AXIS_Y, yaw);
  _qPitch.setFromAxisAngle(_AXIS_X, targetPitch);
  _qRoll.setFromAxisAngle(_AXIS_Z, targetRoll);
  _qTarget.copy(_qYaw).multiply(_qPitch).multiply(_qRoll);

  // Body-frame rotation current->target (conjugate is the inverse for a unit quaternion)
  _qErr.set(-drone.quat.x,-drone.quat.y,-drone.quat.z,drone.quat.w).multiply(_qTarget);
  if(_qErr.w<0){ _qErr.x=-_qErr.x; _qErr.y=-_qErr.y; _qErr.z=-_qErr.z; _qErr.w=-_qErr.w; } // shortest path
  const angle=2*Math.acos(clamp(_qErr.w,-1,1));
  const s=Math.sqrt(Math.max(0,1-_qErr.w*_qErr.w));
  return s>1e-6 ? { x:(_qErr.x/s)*angle, z:(_qErr.z/s)*angle } : { x:0, z:0 };
}

function physics(dt){
  _up.set(0,1,0).applyQuaternion(drone.quat);

  // Effective thrust: minimum idle + remaining range controlled by the pilot,
  // shaped by a non-linear curve so hover sits at hoverStick regardless of TWR.
  // Armed motors never drop below idle in normal flight, but cut out on a crash.
  // Actual thrust takes a moment to reach the target (motor spool-up/down).
  const targetThr = crashState ? 0 : phy.idleThrottle + (1-phy.idleThrottle)*Math.pow(inp.throttle,derived.throttleP);
  drone.thr += (targetThr-drone.thr)*clamp(dt/MOTOR_SPOOL_T,0,1);

  // Ground effect: near the ground, recirculated air adds extra thrust
  const alt=drone.pos.y-groundAt(drone.pos.x,drone.pos.z)-.12;
  const groundEffect = alt<GROUND_EFFECT_ALT ? 1+GROUND_EFFECT_BOOST*(1-alt/GROUND_EFFECT_ALT) : 1;

  _frc.copy(_up).multiplyScalar(drone.thr*derived.maxThr*groundEffect);
  _frc.y-=G*MASS;
  _frc.addScaledVector(drone.vel,-phy.linDrag*MASS);
  const spd=drone.vel.length();
  if(spd>0.01) _frc.addScaledVector(drone.vel,-phy.linDrag*QUAD_DRAG_RATIO*MASS*spd);
  drone.vel.addScaledVector(_frc.divideScalar(MASS),dt);
  drone.pos.addScaledVector(drone.vel,dt);

  const floorY=groundAt(drone.pos.x,drone.pos.z)+.12;
  if(drone.pos.y<floorY){
    if(!crashState && drone.vel.y<-HARD_IMPACT_VY) triggerCrash('ground');
    drone.pos.y=floorY;
    if(drone.vel.y<0) drone.vel.y*=-.04;
    drone.vel.x*=.88; drone.vel.z*=.88;
  }

  let tx,tz;
  if(crashState){
    tx=0; tz=0;
  } else if(flightMode==='balanced'){
    // Angle mode: stick commands a target bank/pitch angle; self-levels back to 0 when centered.
    const targetPitch=-inp.pitch*ANGLE_MAX;
    const targetRoll =-inp.roll*ANGLE_MAX;
    const err=balancedError(targetPitch, targetRoll);
    tx=clamp(ANGLE_P_GAIN*err.x, -derived.ratePitch, derived.ratePitch);
    tz=clamp(ANGLE_P_GAIN*err.z, -derived.rateRoll,  derived.rateRoll);
  } else {
    tx=-inp.pitch*derived.ratePitch;
    tz=-inp.roll*derived.rateRoll;
  }
  const ty=crashState?0:-inp.yaw*derived.rateYaw;
  const t=clamp(phy.omegaR*dt,0,1);
  const tY=clamp(phy.omegaR*YAW_SNAP_FACTOR*dt,0,1);
  drone.omega.x+=(tx-drone.omega.x)*t;
  drone.omega.y+=(ty-drone.omega.y)*tY;
  drone.omega.z+=(tz-drone.omega.z)*t;
  drone.omega.multiplyScalar(Math.pow(phy.angDrag,dt));
  const len=drone.omega.length();
  if(len>1e-5){
    _omegaAxis.copy(drone.omega).multiplyScalar(1/len); // scratch vector — .clone() here allocated every step
    _dq.setFromAxisAngle(_omegaAxis,len*dt);
    drone.quat.multiply(_dq).normalize();
  }

  if(!crashState){ checkGateCrash(); checkTreeCrash(); checkPropCrash(); checkGates(); }
}

// ═══════════════════════════════════════════════
//  GATE COLLISION (crash if you touch the frame bars or pole,
//  instead of passing through the center opening)
// ═══════════════════════════════════════════════
// Scratch object — gateLocal runs several times per gate per physics substep and
// used to allocate a fresh result each call.
const _gl={lx:0,ly:0,lz:0};
function gateLocal(g,pos){
  const dx=pos.x-g.pos.x, dz=pos.z-g.pos.z;
  _gl.lx=dx*g.cs-dz*g.sn; _gl.ly=pos.y-g.pos.y; _gl.lz=dx*g.sn+dz*g.cs;
  return _gl;
}

function distToBox(px,py,pz,hx,hy,hz){
  const dx=Math.max(Math.abs(px)-hx,0), dy=Math.max(Math.abs(py)-hy,0), dz=Math.max(Math.abs(pz)-hz,0);
  return Math.hypot(dx,dy,dz);
}

// Anything further out than this in XZ cannot touch the frame; the pole is
// handled by the same bound since it sits directly under the gate centre.
const GATE_BROAD_R=BAR_LEN/2+DRONE_R+0.5;
const GATE_BROAD_R2=GATE_BROAD_R*GATE_BROAD_R;

function checkGateCrash(){
  if(!collideGates) return;
  const halfT=T_FRAME/2, halfLen=BAR_LEN/2;
  for(const g of gates){
    // Cheap squared-distance reject, mirroring checkTreeCrash — this skipped
    // five box/capsule tests per gate that could never hit.
    const ddx=drone.pos.x-g.pos.x, ddz=drone.pos.z-g.pos.z;
    if(ddx*ddx+ddz*ddz>GATE_BROAD_R2) continue;
    const L=gateLocal(g,drone.pos);
    // Frame bars (top/bottom/left/right)
    if(distToBox(L.lx, L.ly-GATE_R, L.lz, halfLen,halfT,halfT)<DRONE_R){ triggerCrash('gate'); return; }
    if(distToBox(L.lx, L.ly+GATE_R, L.lz, halfLen,halfT,halfT)<DRONE_R){ triggerCrash('gate'); return; }
    if(distToBox(L.lx+GATE_R, L.ly, L.lz, halfT,halfLen,halfT)<DRONE_R){ triggerCrash('gate'); return; }
    if(distToBox(L.lx-GATE_R, L.ly, L.lz, halfT,halfLen,halfT)<DRONE_R){ triggerCrash('gate'); return; }
    // Support pole
    const poleLen=g.pos.y-g.groundY-GATE_R, poleHalf=poleLen/2, poleCy=-GATE_R-poleHalf;
    const radial=Math.hypot(L.lx,L.lz);
    const dy=Math.max(Math.abs(L.ly-poleCy)-poleHalf,0);
    if(Math.hypot(Math.max(radial-POST_R,0),dy)<DRONE_R){ triggerCrash('gate'); return; }
  }
}

// ═══════════════════════════════════════════════
//  TREE COLLISION — trunk + crown as two stacked vertical cylinders per tree,
//  fitted to each species' real geometry (render/vegetation.js); a spatial
//  hash limits the test to the trees around the drone.
// ═══════════════════════════════════════════════
function checkTreeCrash(){
  if(world || !collideTrees || !showTrees) return;
  if(vegetation.collide(drone.pos, DRONE_R)) triggerCrash('tree');
}

// Tents, flags, cones and the safety net always collide, like the ground.
function checkPropCrash(){
  if(world){ if(world.collide(drone.pos, DRONE_R)) triggerCrash('obstacle'); return; }
  if(props.collide(drone.pos, DRONE_R) || floodlights.collide(drone.pos, DRONE_R)) triggerCrash('obstacle');
}

// ═══════════════════════════════════════════════
//  GATES + LAP TIMING
// ═══════════════════════════════════════════════
let lapStartMs=null;     // null until the first gate of a lap is crossed
let lapDirty=false;      // a crash happened this lap — it can't set a best
let lapNumber=1;
let bestLapMs=store.getNum(KEYS.bestLap,0)||null;
let lastSplitDeltaMs=null;
let bestSplits=null;     // per-gate splits of the current best lap, for the live delta
let currentSplits=[];
let lapHoldUntil=0;      // freeze the readout until this timestamp so a finish is readable
const LAP_HOLD_MS=1800;

function formatLap(ms){
  if(ms===null||ms===undefined) return '--:--.---';
  const m=Math.floor(ms/60000);
  const s=Math.floor(ms/1000)%60;
  const f=Math.floor(ms)%1000;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(f).padStart(3,'0')}`;
}
function formatDelta(ms){
  const sign=ms<0?'-':'+';
  const a=Math.abs(ms);
  return `${sign}${(a/1000).toFixed(2)}s`;
}

function resetLapTimer(){
  lapStartMs=null; lapDirty=false; lapNumber=1;
  currentSplits=[]; lastSplitDeltaMs=null; lapHoldUntil=0;
  lastHud.lap=el.lapTime.textContent=formatLap(null);
  el.lapDelta.textContent='';
  el.lapDelta.className='';
  updateLapDirtyUI();
  updateBestLapUI();
}

function updateLapDirtyUI(){ el.lapTime.classList.toggle('dirty',lapDirty); }

function updateBestLapUI(){
  el.lapBest.textContent='BEST '+formatLap(bestLapMs);
  el.bestLapDisp.textContent=bestLapMs?formatLap(bestLapMs):'—';
}

function updateGateHUD(){
  const n=gates.length||N_GATES;
  el.gnum.textContent=(nextGate%n)+1;
  el.lapnum.textContent=lapNumber;
}

function completeLap(nowMs){
  const lapMs=nowMs-lapStartMs;
  lastHud.lap=el.lapTime.textContent=formatLap(lapMs);
  lapHoldUntil=nowMs+LAP_HOLD_MS;
  el.lapTime.classList.remove('flash');
  void el.lapTime.offsetWidth;          // restart the CSS animation
  el.lapTime.classList.add('flash');

  if(lapDirty){
    showSaveToast('LAP '+formatLap(lapMs)+' (CRASHED — NOT COUNTED)','#ff4d4d');
  } else if(bestLapMs===null || lapMs<bestLapMs){
    const improved=bestLapMs!==null;
    bestLapMs=lapMs; bestSplits=currentSplits.slice();
    store.set(KEYS.bestLap,Math.round(lapMs));
    updateBestLapUI();
    showSaveToast((improved?'★ NEW BEST ':'★ FIRST LAP ')+formatLap(lapMs),'#3ddc84');
  } else {
    showSaveToast('LAP '+formatLap(lapMs)+'  '+formatDelta(lapMs-bestLapMs),'#00e5ff');
  }

  lapNumber++;
  lapDirty=false; updateLapDirtyUI();
  currentSplits=[];
  lapStartMs=nowMs;   // next lap starts the instant this one ends
}

function checkGates(){
  if(!gates.length || crashState) return;
  const n=gates.length;
  const g=gates[nextGate%n];
  const L=gateLocal(g,drone.pos);
  const innerHalf=GATE_R-T_FRAME/2;
  if(Math.abs(L.lx)<innerHalf && Math.abs(L.ly)<innerHalf && Math.abs(L.lz)<1.0){
    const passedIdx=nextGate%n;
    setGateState(g,'passed');
    nextGate++;
    const now=performance.now();

    // A lap runs gate 1 → gate 1, so crossing gate 1 either arms the clock
    // (first ever pass) or closes the lap that started there.
    if(passedIdx===0){
      if(lapStartMs===null) lapStartMs=now;
      else completeLap(now);
    } else if(lapStartMs!==null){
      const split=now-lapStartMs;
      currentSplits.push(split);
      if(bestSplits && bestSplits.length>=currentSplits.length){
        lastSplitDeltaMs=split-bestSplits[currentSplits.length-1];
        el.lapDelta.textContent=formatDelta(lastSplitDeltaMs);
        el.lapDelta.className=lastSplitDeltaMs<0?'ahead':'behind';
      }
    }

    // The counter used to run past its own total ("GATE 15 / 12") because it
    // tracked raw passes; it now wraps with the lap.
    updateGateHUD();
    setGateState(gates[nextGate%n],'next');
  }
}

// ═══════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
//  ATTITUDE INDICATOR (ADI)
// ═══════════════════════════════════════════════
const adiCanvas = el.adi;
const adiCtx    = adiCanvas.getContext('2d');
const ADI_SIZE=82, ADI_CX=41, ADI_CY=41, ADI_R=38;

// The instrument used to be a fixed 82×82 bitmap drawn at 1×, so it was visibly
// soft on HiDPI screens while the FPV overlay beside it was sharp. Same backing-
// store trick as resizeFpvHud().
function resizeADI(){
  const dpr=Math.min(window.devicePixelRatio||1,2);
  adiCanvas.width =Math.round(ADI_SIZE*dpr);
  adiCanvas.height=Math.round(ADI_SIZE*dpr);
  adiCtx.setTransform(dpr,0,0,dpr,0,0);   // keep drawing in CSS pixels
  adiLastRoll=adiLastPitch=NaN;           // force a redraw at the new scale
}

// Sky/ground gradients are fixed in the rotated instrument space, so they are
// built once instead of twice per frame.
const ADI_SKY_GRAD=(()=>{
  const g=adiCtx.createLinearGradient(0,-ADI_R,0,0);
  g.addColorStop(0,'#0d3a5c'); g.addColorStop(1,'#1a6a9a'); return g;
})();
const ADI_GND_GRAD=(()=>{
  const g=adiCtx.createLinearGradient(0,0,0,ADI_R*2);
  g.addColorStop(0,'#6b3c14'); g.addColorStop(1,'#3a1f08'); return g;
})();

// Redraw only when the needle actually moved — below half a degree the result is
// pixel-identical, so at rest the instrument costs nothing.
let adiLastRoll=NaN, adiLastPitch=NaN;
const ADI_EPS=0.5*Math.PI/180;

resizeADI();

// Reusable vectors for angle extraction
const _adiUp    = new THREE.Vector3();
const _adiFwd   = new THREE.Vector3();
const _adiRight = new THREE.Vector3();

function drawADI(rollRad, pitchRad){
  if(Math.abs(rollRad-adiLastRoll)<ADI_EPS && Math.abs(pitchRad-adiLastPitch)<ADI_EPS) return;
  adiLastRoll=rollRad; adiLastPitch=pitchRad;

  const ctx=adiCtx;
  const cx=ADI_CX, cy=ADI_CY, r=ADI_R;
  ctx.clearRect(0,0,ADI_SIZE,ADI_SIZE);

  ctx.save();
  // Circular clip
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();

  // ── Rotate canvas by roll, shift by pitch ──
  // The instrument face is fixed to the airframe, so the horizon backdrop turns opposite
  // the bank: a right bank leaves the sky on the pilot's left.
  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(-rollRad);

  const pitchPx = pitchRad * (r / (Math.PI*0.5)); // 38px per 90°

  // Sky and ground. The gradients are defined around y=0 and the whole horizon
  // is translated by the pitch offset, so they stay reusable across frames.
  ctx.translate(0,pitchPx);
  ctx.fillStyle=ADI_SKY_GRAD;
  ctx.fillRect(-r,-r*2,r*2,r*2);
  ctx.fillStyle=ADI_GND_GRAD;
  ctx.fillRect(-r,0,r*2,r*2);
  ctx.translate(0,-pitchPx);

  // Horizon line
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(-r,pitchPx); ctx.lineTo(r,pitchPx); ctx.stroke();

  // Pitch ladder: small ticks every 10°
  ctx.strokeStyle='rgba(255,255,255,.55)'; ctx.lineWidth=1;
  ctx.font='8px Courier New'; ctx.fillStyle='rgba(255,255,255,.55)'; ctx.textAlign='center';
  for(let deg=-60; deg<=60; deg+=10){
    if(deg===0) continue;
    const py=pitchPx - deg*(r/(90));
    if(Math.abs(py)>r) continue;
    const w=(Math.abs(deg)%30===0)?14:9;
    ctx.beginPath(); ctx.moveTo(-w,py); ctx.lineTo(w,py); ctx.stroke();
    if(Math.abs(deg)%30===0) ctx.fillText(Math.abs(deg),w+8,py+3);
  }

  ctx.restore(); // undo roll+pitch

  // ── Fixed aircraft reference (always horizontal) ──
  ctx.strokeStyle='#00e5ff'; ctx.lineWidth=2;
  // Left wing
  ctx.beginPath(); ctx.moveTo(cx-r+6,cy); ctx.lineTo(cx-10,cy);
  ctx.lineTo(cx-10,cy+5); ctx.stroke();
  // Right wing
  ctx.beginPath(); ctx.moveTo(cx+r-6,cy); ctx.lineTo(cx+10,cy);
  ctx.lineTo(cx+10,cy+5); ctx.stroke();
  // Center dot
  ctx.beginPath(); ctx.arc(cx,cy,2.5,0,Math.PI*2);
  ctx.fillStyle='#00e5ff'; ctx.fill();

  ctx.restore(); // undo clip

  // ── Outer bezel ──
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.strokeStyle='rgba(0,229,255,.35)'; ctx.lineWidth=1.5; ctx.stroke();

  // ── Roll scale marks on bezel ──
  const marks=[{a:-90,l:7},{a:-60,l:5},{a:-45,l:5},{a:-30,l:5},
               {a: 30,l:5},{a: 45,l:5},{a: 60,l:5},{a: 90,l:7}];
  ctx.strokeStyle='rgba(0,229,255,.5)'; ctx.lineWidth=1;
  for(const m of marks){
    const rad=(m.a-90)*Math.PI/180;
    const x1=cx+Math.cos(rad)*r, y1=cy+Math.sin(rad)*r;
    const x2=cx+Math.cos(rad)*(r-m.l), y2=cy+Math.sin(rad)*(r-m.l);
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  }

  // ── Roll pointer triangle (moves with roll) ──
  ctx.save();
  ctx.translate(cx,cy); ctx.rotate(-rollRad);
  ctx.beginPath();
  ctx.moveTo(0,-(r-2));
  ctx.lineTo(-4,-(r-10));
  ctx.lineTo( 4,-(r-10));
  ctx.closePath();
  ctx.fillStyle='#00e5ff'; ctx.fill();
  ctx.restore();
}

// ═══════════════════════════════════════════════
//  FPV ATTITUDE OVERLAY — a horizon bar across the
//  centre of the view that tilts with roll and slides
//  with pitch, plus two vertical gauges (left = pitch,
//  right = roll) with a dot sliding along each.
// ═══════════════════════════════════════════════
const fpvCanvas=el.fpvHud;
const fpvCtx=fpvCanvas.getContext('2d');
const HUD_C='rgba(255,255,255,';

let fpvHudOn=store.getBool(KEYS.hudOverlay,true);

// This is a full-viewport canvas cleared and repainted every frame for a handful
// of thin lines, so it is capped below the renderer's ratio — the strokes are
// 1–2px and gain nothing from 2× backing store.
const FPV_MAX_DPR=1.5;
function resizeFpvHud(){
  const dpr=Math.min(window.devicePixelRatio||1,FPV_MAX_DPR);
  fpvCanvas.width =Math.round(innerWidth *dpr);
  fpvCanvas.height=Math.round(innerHeight*dpr);
  fpvCanvas.style.width =innerWidth +'px';
  fpvCanvas.style.height=innerHeight+'px';
  fpvCtx.setTransform(dpr,0,0,dpr,0,0);   // draw in CSS pixels
}
resizeFpvHud();

// One vertical gauge: rail + ticks + a dot at `val`, clamped to ±range degrees.
function drawFpvRail(x,cy,halfH,label,val,range){
  const ctx=fpvCtx;
  ctx.lineWidth=1;
  ctx.strokeStyle=HUD_C+'.25)';
  ctx.beginPath(); ctx.moveTo(x,cy-halfH); ctx.lineTo(x,cy+halfH); ctx.stroke();

  for(let i=-3;i<=3;i++){
    const ty=cy-(i/3)*halfH, w=i===0?7:4;
    ctx.strokeStyle=HUD_C+(i===0?'.5)':'.22)');
    ctx.beginPath(); ctx.moveTo(x-w,ty); ctx.lineTo(x+w,ty); ctx.stroke();
  }

  const dy=cy-(clamp(val,-range,range)/range)*halfH;
  // A dark halo ring reads the same as shadowBlur against any background but
  // skips the per-frame blur pass.
  ctx.beginPath(); ctx.arc(x,dy,5.5,0,Math.PI*2);
  ctx.fillStyle='rgba(0,0,0,.35)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x,dy,4,0,Math.PI*2);
  ctx.fillStyle=HUD_C+'.95)'; ctx.fill();

  ctx.textAlign='center';
  ctx.fillStyle=HUD_C+'.9)';
  ctx.fillText((val>0?'+':'')+Math.round(val)+'°', x, dy-15);
  ctx.fillStyle=HUD_C+'.4)';
  ctx.fillText(label, x, cy+halfH+15);
}

function drawFpvHud(rollRad,pitchRad){
  // The early-out used to sit *after* the clear, so a disabled overlay still paid
  // for a full-viewport clearRect on every frame.
  if(!fpvHudOn) return;
  const ctx=fpvCtx, W=innerWidth, H=innerHeight;
  ctx.clearRect(0,0,W,H);

  const cx=W/2, cy=H/2;
  const half   =Math.min(W*.20,240);   // half-length of the horizon bar
  const railX  =Math.min(W*.30,300);   // gauge distance from centre
  const railH  =Math.min(H*.30,220);   // gauge half-height

  // Bar position reflects the drone's own body pitch only — NOT the camera tilt. The FPV
  // camera is tilted up independently (to compensate for nose-down forward flight), so it
  // deliberately disagrees with the drone's attitude; this bar is a flight instrument that
  // must keep showing true drone attitude regardless of where the camera happens to point.
  const camAng=clamp(pitchRad, -1.5, 1.5);
  const horizonY=Math.tan(camAng)*(H/2)/Math.tan(fovDeg*Math.PI/360);

  ctx.lineCap='round';
  ctx.textBaseline='middle';
  ctx.font='11px "Courier New",monospace';

  // ── Horizon bar: banking right tilts the world the other way on screen ──
  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(-rollRad);
  ctx.translate(0, clamp(horizonY,-railH,railH));
  const gap=26;
  const barPath=()=>{
    ctx.beginPath();
    ctx.moveTo(-half,0); ctx.lineTo(-gap,0); ctx.lineTo(-gap,9);
    ctx.moveTo( half,0); ctx.lineTo( gap,0); ctx.lineTo( gap,9);
    ctx.stroke();
  };
  // Dark underlay instead of shadowBlur — same legibility over bright sky,
  // without a blur pass every frame.
  ctx.strokeStyle='rgba(0,0,0,.4)'; ctx.lineWidth=4; barPath();
  ctx.strokeStyle=HUD_C+'.85)';     ctx.lineWidth=2; barPath();
  ctx.restore();

  // ── Vertical gauges ──
  drawFpvRail(cx-railX, cy, railH, 'PITCH', pitchRad*180/Math.PI,  90);
  drawFpvRail(cx+railX, cy, railH, 'ROLL',  rollRad *180/Math.PI, 180);
}

// ═══════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════
// Every telemetry field is written at 60fps but only changes when its *rounded*
// display value does, so each is compared against the last painted value first.
// Assigning textContent unconditionally invalidated layout on every frame.
const lastHud={spd:'',alt:'',thrp:'',tilt:'',fov:'',thrH:'',roll:'',pitch:'',lap:''};
function setText(node,key,value){
  if(lastHud[key]===value) return;
  lastHud[key]=value; node.textContent=value;
}

function updateHUD(){
  setText(el.spd,'spd',drone.vel.length().toFixed(1));
  setText(el.alt,'alt',Math.max(0,drone.pos.y-groundAt(drone.pos.x,drone.pos.z)-.12).toFixed(1));
  setText(el.thrp,'thrp',String(Math.round(inp.throttle*100)));
  setText(el.tiltDeg,'tilt',String(Math.round(camTiltDeg)));
  setText(el.fovDisp,'fov',String(Math.round(fovDeg)));

  const thrH=(Math.round(inp.throttle*100))+'%';
  if(lastHud.thrH!==thrH){ lastHud.thrH=thrH; el.thrFill.style.height=thrH; }

  // Extract roll and pitch from drone quaternion. Roll is the bank about the drone's own
  // forward axis, so it comes from the body up/right vectors — reading world X off the up
  // vector alone would only be right while flying due north.
  _adiUp.set(0,1,0).applyQuaternion(drone.quat);
  _adiFwd.set(0,0,-1).applyQuaternion(drone.quat);
  _adiRight.set(1,0,0).applyQuaternion(drone.quat);
  const rollRad  = Math.atan2(-_adiRight.y, _adiUp.y);      // + = right bank
  const pitchRad = Math.asin(clamp(_adiFwd.y,-1,1));        // + = nose up
  drawADI(rollRad, pitchRad);
  drawFpvHud(rollRad, pitchRad);
  const rollDeg=Math.round(rollRad*180/Math.PI);
  const pitchDeg=Math.round(pitchRad*180/Math.PI);
  setText(el.adiRoll,'roll','R '+(rollDeg>0?'+':'')+rollDeg+'°');
  setText(el.adiPitch,'pitch','P '+(pitchDeg>0?'+':'')+pitchDeg+'°');

  // Running lap clock. It keeps counting through a crash — the respawn delay is
  // the penalty. While a completed time is being held on screen the clock stays
  // frozen so the finish is actually readable before the next lap starts.
  const now=performance.now();
  if(lapStartMs!==null && now>=lapHoldUntil){
    setText(el.lapTime,'lap',formatLap(now-lapStartMs));
  }
}

// ═══════════════════════════════════════════════
//  SETTINGS UI
// ═══════════════════════════════════════════════
let settingsOpen=false;
let detectState=null;
let wizQueue=null;
let lastFocused=null;

function getGamepad(){ for(const g of navigator.getGamepads()) if(g) return g; return null; }
function toggleSettings(){ settingsOpen?closeSettings():openSettings(); }

function openSettings(){
  settingsOpen=true;
  lastFocused=document.activeElement;
  el.mapModal.classList.add('open');
  refreshSettingsUI();
  showHelp();                        // the modal is also where the keybinds live
  releaseAllKeys();                  // don't carry a held throttle into the dialog
  el.closeBtn?.focus();
}

function closeSettings(){
  settingsOpen=false; detectState=null; wizQueue=null;
  el.mapModal.classList.remove('open');
  el.wizStatus.textContent='';
  document.querySelectorAll('.det-btn').forEach(b=>{b.textContent='DETECT';b.classList.remove('active','ok');});
  el.wizBtn.disabled=false;
  resetConfirmState();
  saveMap();
  lastFocused?.focus?.();
}

// Keep Tab inside the dialog while it's open — otherwise focus walks onto the
// HUD buttons behind the backdrop.
const FOCUSABLE='button:not([disabled]),select,input,[tabindex]:not([tabindex="-1"])';
document.addEventListener('keydown',e=>{
  if(!settingsOpen || e.key!=='Tab') return;
  const nodes=[...el.mapCard.querySelectorAll(FOCUSABLE)].filter(n=>n.offsetParent!==null);
  if(!nodes.length) return;
  const first=nodes[0], last=nodes[nodes.length-1];
  if(e.shiftKey && document.activeElement===first){ last.focus(); e.preventDefault(); }
  else if(!e.shiftKey && document.activeElement===last){ first.focus(); e.preventDefault(); }
},true);

// ── Axes monitor ─────────────────────────────
function axisChannelLabel(idx){
  for(const ch of CHANNELS){
    if(axisMap[ch.key].axis===idx){
      const short={throttle:'THROTTLE',yaw:'YAW',roll:'ROLL',pitch:'PITCH'};
      return short[ch.key]||ch.key;
    }
  }
  return '';
}

function buildAxesGrid(numAxes){
  const grid=document.getElementById('axes-grid');
  while(grid.children.length>numAxes) grid.removeChild(grid.lastChild);
  for(let i=grid.children.length;i<numAxes;i++){
    const row=document.createElement('div');
    row.className='ax-row'; row.dataset.i=i;
    row.innerHTML=`<span class="ax-lbl">AXIS ${i}</span>
      <div class="bw"><div class="bc"></div><div class="bv" id="ab${i}"></div></div>
      <span class="ax-num" id="an${i}">0.00</span>
      <span class="ax-badge" id="albl${i}"></span>`;
    grid.appendChild(row);
  }
  for(let i=0;i<numAxes;i++){
    const badge=document.getElementById('albl'+i);
    if(!badge) continue;
    const lbl=axisChannelLabel(i);
    badge.textContent=lbl;
    badge.classList.toggle('vis', lbl!=='');
  }
}

// ── Channel table ─────────────────────────────
function buildChannelTable(numAxes){
  const tbody=document.getElementById('ch-body');
  tbody.innerHTML='';
  for(const ch of CHANNELS){
    const cfg=axisMap[ch.key];
    const isLeft=(ch.key==='throttle'||ch.key==='yaw');
    let opts='';
    for(let i=0;i<numAxes;i++) opts+=`<option value="${i}"${cfg.axis===i?' selected':''}>AXIS ${i}</option>`;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>
        <div class="ch-info">
          <span class="ch-name">${ch.label}</span>
          <span class="ch-sub">${ch.desc}</span>
          <span class="ch-tag${isLeft?' left':''}">${ch.stick}</span>
        </div>
      </td>
      <td><select id="sel-${ch.key}">${opts}</select></td>
      <td style="text-align:center"><input type="checkbox" class="inv-chk" id="inv-${ch.key}"${cfg.invert?' checked':''}></td>
      <td style="padding-right:10px">
        <div class="chbw"><div class="chbc"></div><div class="chbv" id="chb-${ch.key}"></div></div>
      </td>
      <td><button class="det-btn" data-ch="${ch.key}">DETECT</button></td>`;
    tbody.appendChild(tr);

    tr.querySelector(`#sel-${ch.key}`).addEventListener('change',e=>{
      axisMap[ch.key].axis=parseInt(e.target.value); saveMap();
      buildAxesGrid(document.getElementById('axes-grid').children.length);
    });
    tr.querySelector(`#inv-${ch.key}`).addEventListener('change',e=>{
      axisMap[ch.key].invert=e.target.checked; saveMap();
    });
    tr.querySelector('.det-btn').addEventListener('click',e=>startDetect(e.target.dataset.ch));
  }
}

function refreshSettingsUI(){
  const gp=getGamepad();
  const n=gp?Math.max(gp.axes.length,4):8;
  buildAxesGrid(n);
  buildChannelTable(n);
  el.dbSlider.value=Math.round(axisMap.deadband*100);
  el.dbDisp.textContent=Math.round(axisMap.deadband*100)+'%';
  el.noGp.style.display=gp?'none':'block';
  el.cfgTiltSlider.value=Math.round(camTiltDeg);
  el.cfgTiltDisp.textContent=Math.round(camTiltDeg)+'°';
  el.cfgFovSlider.value=Math.round(fovDeg);
  el.cfgFovDisp.textContent=Math.round(fovDeg)+'°';
  updateBestLapUI();
}

el.cfgTiltSlider.addEventListener('input',e=>{
  camTiltDeg=parseFloat(e.target.value);
  el.cfgTiltDisp.textContent=Math.round(camTiltDeg)+'°';
  queueViewSave();
});
el.cfgFovSlider.addEventListener('input',e=>{
  fovDeg=parseFloat(e.target.value);
  applyCameraFov();
  el.cfgFovDisp.textContent=Math.round(fovDeg)+'°';
  queueViewSave();
});

// ── Live bars (every frame while the settings dialog is open) ──
function updateSettingsLive(){
  const gp=getGamepad();
  if(!gp) return;
  const ax=gp.axes;

  for(let i=0;i<ax.length;i++){
    const v=ax[i];
    const bar=document.getElementById('ab'+i);
    const num=document.getElementById('an'+i);
    if(!bar) continue;
    if(v>=0){ bar.style.left='50%'; bar.style.width=(v*50)+'%'; }
    else     { bar.style.left=((1+v)*50)+'%'; bar.style.width=(-v*50)+'%'; }
    if(num) num.textContent=v.toFixed(2);
  }

  for(const ch of CHANNELS){
    const bar=document.getElementById('chb-'+ch.key);
    if(!bar) continue;
    const cfg=axisMap[ch.key];
    if(cfg.axis<0||cfg.axis>=ax.length) continue;
    let v=ax[cfg.axis]; if(cfg.invert) v=-v;
    if(ch.bipolar){
      if(v>=0){ bar.style.left='50%'; bar.style.width=(v*50)+'%'; }
      else     { bar.style.left=((1+v)*50)+'%'; bar.style.width=(-v*50)+'%'; }
    } else {
      const pct=((v+1)/2*100).toFixed(1);
      bar.style.left='0'; bar.style.width=pct+'%';
    }
  }

  if(detectState){
    const elapsed=Date.now()-detectState.startMs;
    const remaining=Math.max(0,Math.ceil((detectState.durationMs-elapsed)/1000));
    const btn=document.querySelector(`.det-btn[data-ch="${detectState.channel}"]`);
    if(btn) btn.textContent=remaining>0?remaining+'...':'OK';
    for(let i=0;i<ax.length;i++){
      const abs=Math.abs(ax[i]);
      if(!detectState.peaks[i]) detectState.peaks[i]={max:0,sign:0};
      if(abs>detectState.peaks[i].max){
        detectState.peaks[i].max=abs;
        detectState.peaks[i].sign=Math.sign(ax[i]);
      }
    }
    if(elapsed>=detectState.durationMs) finishDetect();
  }
}

// ── Single-channel detect ─────────────────────
function startDetect(chKey){
  if(!getGamepad()){
    document.getElementById('wiz-status').textContent='Connect a controller first.';
    return;
  }
  if(detectState) finishDetect(true);
  detectState={channel:chKey, startMs:Date.now(), durationMs:2500, peaks:{}};
  const btn=document.querySelector(`.det-btn[data-ch="${chKey}"]`);
  if(btn){ btn.classList.add('active'); btn.textContent='3...'; }
  const ch=CHANNELS.find(c=>c.key===chKey);
  setWizStatus(`Move the ${ch.label} stick (${ch.stick}) to full deflection...`);
}

function finishDetect(cancelled=false){
  if(!detectState) return;
  const {channel,peaks}=detectState;
  detectState=null;
  const btn=document.querySelector(`.det-btn[data-ch="${channel}"]`);
  if(btn) btn.classList.remove('active');

  if(!cancelled){
    let bestIdx=-1, bestPeak=0.2;
    for(const [k,v] of Object.entries(peaks)){
      if(v.max>bestPeak){ bestPeak=v.max; bestIdx=parseInt(k); }
    }
    if(bestIdx>=0){
      const sign=peaks[bestIdx].sign;
      const ch=CHANNELS.find(c=>c.key===channel);
      const invert=sign<0;
      axisMap[channel].axis=bestIdx;
      axisMap[channel].invert=invert;
      saveMap();
      const sel=document.getElementById('sel-'+channel);
      if(sel) sel.value=bestIdx;
      const inv=document.getElementById('inv-'+channel);
      if(inv) inv.checked=invert;
      if(btn){ btn.textContent='✓'; btn.classList.add('ok'); }
      setTimeout(()=>{ if(btn){btn.textContent='DETECT';btn.classList.remove('ok');} },1800);
      setWizStatus(`✓ ${ch.label} → AXIS ${bestIdx}${invert?' · inverted':''}`);
    } else {
      if(btn) btn.textContent='DETECT';
      setWizStatus('No movement detected. Try again.');
    }
  } else {
    if(btn) btn.textContent='DETECT';
  }

  if(!cancelled && wizQueue && wizQueue.length>0){
    const next=wizQueue.shift();
    setTimeout(()=>startDetect(next), 700);
  } else if(wizQueue && wizQueue.length===0){
    wizQueue=null;
    document.getElementById('wiz-btn').disabled=false;
    setWizStatus('✓ Mapping complete. Let\'s fly!');
  }
}

function startWizard(){
  if(!getGamepad()){ setWizStatus('Connect a controller first.'); return; }
  document.getElementById('wiz-btn').disabled=true;
  wizQueue=CHANNELS.slice(1).map(c=>c.key);
  setWizStatus('');
  startDetect(CHANNELS[0].key);
}

function setWizStatus(msg){ document.getElementById('wiz-status').textContent=msg; }

// ── Deadband slider ───────────────────────────
document.getElementById('db-slider').addEventListener('input',e=>{
  const pct=parseInt(e.target.value);
  axisMap.deadband=pct/100;
  document.getElementById('db-disp').textContent=pct+'%';
  saveMap();
});

// ── Tabs ──────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(b=>{
      b.classList.remove('active'); b.setAttribute('aria-selected','false');
    });
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active'); btn.setAttribute('aria-selected','true');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
  });
});

// ── Physics sliders ───────────────────────────
function syncPhyUI(){
  document.getElementById('ph-hover').value=Math.round(phy.hoverPct*100);
  document.getElementById('pv-hover').textContent='×'+(1/phy.hoverPct).toFixed(1);
  document.getElementById('ph-hoverstick').value=Math.round(phy.hoverStick*100);
  document.getElementById('pv-hoverstick').textContent=Math.round(phy.hoverStick*100)+'%';
  document.getElementById('ph-idle').value=Math.round(phy.idleThrottle*100);
  document.getElementById('pv-idle').textContent=Math.round(phy.idleThrottle*100)+'%';
  document.getElementById('ph-drag').value=Math.round(phy.linDrag*100);
  document.getElementById('pv-drag').textContent=phy.linDrag.toFixed(2);
  document.getElementById('ph-rate').value=phy.rateDeg;
  document.getElementById('pv-rate').textContent=phy.rateDeg+'°/s';
  document.getElementById('ph-yaw').value=phy.yawDeg;
  document.getElementById('pv-yaw').textContent=phy.yawDeg+'°/s';
  document.getElementById('ph-snap').value=phy.omegaR;
  document.getElementById('pv-snap').textContent=phy.omegaR;
  document.getElementById('ph-adrag').value=Math.round(phy.angDrag*100);
  document.getElementById('pv-adrag').textContent=phy.angDrag.toFixed(2);
}

const PRESET_DESC={
  beginner:'Smooth, stable flight — moderate thrust and slow turns. Ideal for learning.',
  racing:'The classic racing balance — agile but controllable.',
  freestyle:'Maximum angular agility for flips and acrobatic tricks.',
  cinematic:'Slow, smooth movements — for relaxed camera shots.',
};
function updatePresetDesc(name){
  el.presetDesc.textContent='► '+(name&&PRESET_DESC[name] ? PRESET_DESC[name] : 'Custom configuration (manually adjusted).');
}

function markPreset(name){
  document.querySelectorAll('.preset-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.preset===name);
  });
  updatePresetDesc(name);
}

function applyPreset(name){
  if(!PHY_PRESETS[name]) return;
  Object.assign(phy, PHY_PRESETS[name]);
  recomputePhyDerived();
  syncPhyUI(); markPreset(name);
  updateAnalysis(); queuePhySave();
}

document.querySelectorAll('.preset-btn').forEach(btn=>{
  btn.addEventListener('click',()=>applyPreset(btn.dataset.preset));
});

const sliderDefs=[
  { id:'ph-hover', key:'hoverPct',     scale:0.01, disp:(v)=>'×'+(1/v).toFixed(1), dispId:'pv-hover' },
  { id:'ph-hoverstick', key:'hoverStick', scale:0.01, disp:(v)=>Math.round(v*100)+'%', dispId:'pv-hoverstick' },
  { id:'ph-idle',  key:'idleThrottle', scale:0.01, disp:(v)=>Math.round(v*100)+'%', dispId:'pv-idle'  },
  { id:'ph-drag',  key:'linDrag',      scale:0.01, disp:(v)=>v.toFixed(2),           dispId:'pv-drag'  },
  { id:'ph-rate',  key:'rateDeg',      scale:1,    disp:(v)=>v+'°/s',                dispId:'pv-rate'  },
  { id:'ph-yaw',   key:'yawDeg',       scale:1,    disp:(v)=>v+'°/s',                dispId:'pv-yaw'   },
  { id:'ph-snap',  key:'omegaR',       scale:1,    disp:(v)=>v,                      dispId:'pv-snap'  },
  { id:'ph-adrag', key:'angDrag',      scale:0.01, disp:(v)=>v.toFixed(2),           dispId:'pv-adrag' },
];

sliderDefs.forEach(def=>{
  const slider=document.getElementById(def.id);
  const disp=document.getElementById(def.dispId);
  if(!slider) return;
  slider.addEventListener('input',()=>{
    phy[def.key]=parseFloat(slider.value)*def.scale;
    recomputePhyDerived();
    disp.textContent=def.disp(phy[def.key]);
    document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active'));
    updatePresetDesc(null);
    queuePhySave();
    updateAnalysis();
  });
});

// ── Toast ────────────────────────────────────
let toastTimer=null;
function showSaveToast(msg, color){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.borderColor=color||'rgba(0,229,255,.4)';
  t.style.color=color||'#00e5ff';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'), 2200);
}

// ── Save status ──────────────────────────────
// Physics used to be the only setting that needed an explicit SAVE, while every
// other control wrote through immediately — so tuning the handling, flying, and
// reloading silently threw the tuning away. Physics now autosaves like the rest;
// SAVE remains as an explicit "commit now" that stamps the time.
function markSaving(){
  el.saveStatus.textContent='● SAVING…';
  el.saveStatus.style.color='var(--warn)';
}
function markSaved(ts){
  const d=new Date(ts);
  const hm=d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
  el.saveStatus.textContent='✓ AUTOSAVED';
  el.saveStatus.style.color='var(--ok)';
  el.saveTs.textContent='last saved: '+hm;
}
function initSaveStatus(){
  const p=store.getJSON(KEYS.phy);
  if(!p){ el.saveStatus.textContent='AUTOSAVED'; el.saveStatus.style.color='var(--fg-faint)'; return; }
  if(p._ts) markSaved(p._ts);
}

let phySaveTimer=null;
function queuePhySave(){
  markSaving();
  clearTimeout(phySaveTimer);
  phySaveTimer=setTimeout(()=>{
    const ts=savePhy();
    if(ts) markSaved(ts);
    else { el.saveStatus.textContent='⚠ SAVE UNAVAILABLE'; el.saveStatus.style.color='var(--danger)'; }
  },500);
}

// ── Analysis panel ───────────────────────────
// The panel used to be torn down and rebuilt via innerHTML on every `input`
// event — a full parse plus reflow for each pixel of slider drag. The six cards
// and the note are created once here; updateAnalysis() then only writes text and
// bar widths.
const AP_SPECS=[
  { key:'twr',   label:'TWR (thrust-to-weight)', tip:'Thrust-to-weight ratio. ×2 minimum to climb, ×4-6 = real racing quad.' },
  { key:'acc',   label:'Max net acceleration',   tip:'Net vertical acceleration at full throttle. Real: 25-50 m/s².' },
  { key:'drag',  label:'Linear drag',            tip:'Air resistance. >0.4 = sense of weight. <0.05 = flying in a vacuum.' },
  { key:'term',  label:'Approx. terminal velocity', tip:'Maximum speed in free fall. Limits how fast you need to react.' },
  { key:'rate',  label:'Roll/pitch rates',       tip:'<300 = easy. 400-600 = freestyle. 700+ = aggressive racing.' },
  { key:'snap',  label:'Snap (motor response)',  tip:'How fast the motors respond. >35 = snappy and direct.' },
];
const apNodes={};
let apNote=null;
(function buildAnalysisPanel(){
  const grid=el.apGrid;
  grid.innerHTML='';
  for(const spec of AP_SPECS){
    const div=document.createElement('div');
    div.className='ap-item';
    div.innerHTML=`<strong>${spec.label}</strong><span class="ap-value"></span>
      <div class="ap-bar-wrap"><div class="ap-bar"></div></div>
      <span class="ap-tip">${spec.tip}</span>`;
    grid.appendChild(div);
    apNodes[spec.key]={ value:div.querySelector('.ap-value'), bar:div.querySelector('.ap-bar') };
  }
  apNote=document.createElement('div');
  apNote.className='ap-note';
  grid.appendChild(apNote);
})();

function setAnalysisItem(key,text,barPct,color){
  const n=apNodes[key];
  if(n.value.textContent!==text) n.value.textContent=text;
  const w=Math.max(0,Math.min(100,barPct))+'%';
  if(n.bar.style.width!==w) n.bar.style.width=w;
  if(n.bar.style.background!==color) n.bar.style.background=color;
}

function updateAnalysis(){
  const twr=(1/phy.hoverPct).toFixed(1);
  const maxAcc=((1/phy.hoverPct - 1)*9.81).toFixed(1);  // net upward accel at full thr
  // Terminal velocity with linear + quadratic drag: k1*v + k2*v² = g
  const k1=phy.linDrag, k2=phy.linDrag*QUAD_DRAG_RATIO;
  const termVel=(k2>1e-6 ? (-k1+Math.sqrt(k1*k1+4*k2*9.81))/(2*k2) : 9.81/(k1+0.001)).toFixed(1);
  const dragPct=Math.round(phy.linDrag*100/0.6*100);  // relative 0-100
  const ratePct=Math.round(phy.rateDeg/1200*100);
  const snapPct=Math.round(phy.omegaR/50*100);
  const angPct=Math.round((1-phy.angDrag)*100/0.3*100);

  // Qualitative description
  let notes=[];
  if(phy.hoverPct<0.20) notes.push('Explosive thrust — aggressive dive recovery.');
  else if(phy.hoverPct<0.26) notes.push('Balanced thrust — good punch without being uncontrollable.');
  else notes.push('Gentle thrust — easier to control, ideal for learning.');
  if(phy.linDrag>0.30) notes.push('High drag: a sense of weight and speed in the air.');
  else if(phy.linDrag<0.06) notes.push('Minimal drag: free speed but can feel unrealistic.');
  else notes.push('Moderate drag: smoothly slows high-speed maneuvers.');

  const CYAN='#00e5ff', AMBER='#ffb830';
  setAnalysisItem('twr',  '×'+twr,             Math.round((1/phy.hoverPct-1)/6*100), CYAN);
  setAnalysisItem('acc',  maxAcc+' m/s²',      Math.round(parseFloat(maxAcc)/50*100), CYAN);
  setAnalysisItem('drag', phy.linDrag.toFixed(2), dragPct, phy.linDrag>0.35?AMBER:CYAN);
  setAnalysisItem('term', '~'+termVel+' m/s',  Math.round(parseFloat(termVel)/80*100), CYAN);
  setAnalysisItem('rate', phy.rateDeg+'°/s',   ratePct, CYAN);
  setAnalysisItem('snap', String(phy.omegaR),  snapPct, CYAN);

  const noteText='▶ '+notes.join(' · ');
  if(apNote.textContent!==noteText) apNote.textContent=noteText;
}

// ── Preset & save buttons ────────────────────
recomputePhyDerived();
syncPhyUI();
updateAnalysis();
initSaveStatus();

// Mark loaded preset if matches
(function(){
  const preset=detectPresetName();
  if(preset) markPreset(preset);
  else { document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active')); updatePresetDesc(null); }
})();

// ── Progressive disclosure: collapse advanced settings by default ──
function setupAdvToggle(btnId, bodyId, storeKey, label){
  const btn=document.getElementById(btnId), body=document.getElementById(bodyId);
  if(!btn||!body) return;
  let open=store.getBool(storeKey,false);
  const apply=()=>{
    btn.classList.toggle('open',open);
    body.classList.toggle('open',open);
    btn.setAttribute('aria-expanded',String(open));
    btn.textContent=(open?'▾ ':'▸ ')+label;
  };
  apply();
  btn.addEventListener('click',()=>{
    open=!open;
    store.setBool(storeKey,open);
    apply();
  });
}
setupAdvToggle('controller-adv-toggle','controller-adv-body',KEYS.ctrlAdv,'MANUAL / ADVANCED SETTINGS');
setupAdvToggle('physics-adv-toggle','physics-adv-body',KEYS.phyAdv,'ADVANCED SETTINGS (sliders)');

// ── Section explainers behind ⓘ buttons ──
// The "► …" paragraphs used to sit open under every section, which made the
// panel long and pushed the actual controls off-screen. They are collapsed by
// default now; whichever ones you open stay open across sessions, held as a
// single comma-separated key rather than one key per section.
(function setupInfoButtons(){
  const openIds=new Set(store.get(KEYS.hints,'').split(',').filter(Boolean));
  const buttons=[...document.querySelectorAll('.info-btn')];

  const persist=()=>store.set(KEYS.hints,[...openIds].join(','));

  buttons.forEach(btn=>{
    const hint=document.getElementById(btn.dataset.hint);
    if(!hint) return;
    const apply=open=>{
      hint.classList.toggle('open',open);
      btn.classList.toggle('open',open);
      btn.setAttribute('aria-expanded',String(open));
    };
    apply(openIds.has(btn.dataset.hint));
    btn.addEventListener('click',()=>{
      const open=!openIds.has(btn.dataset.hint);
      if(open) openIds.add(btn.dataset.hint); else openIds.delete(btn.dataset.hint);
      apply(open);
      persist();
    });
  });
})();

// ── Small checkbox helper — every GENERAL toggle writes through immediately ──
function bindToggle(id, initial, onChange){
  const node=document.getElementById(id);
  node.checked=initial;
  node.addEventListener('change',()=>onChange(node.checked));
  return node;
}

// ── World generation tab ─────────────────────
const randomizeBtn=el.randomizeBtn;
const randomizeToggle=bindToggle('randomize-toggle',randomizeOnReset,v=>{
  randomizeOnReset=v;
  store.setBool(KEYS.randomize,v);
  syncRandomizeUI();
});
function syncRandomizeUI(){
  randomizeToggle.checked=randomizeOnReset;
  randomizeBtn.style.display=randomizeOnReset?'none':'inline-block';
}
syncRandomizeUI();
randomizeBtn.addEventListener('click',()=>{
  buildCircuit();
  resetRun();
  showSaveToast('✓ WORLD RANDOMIZED');
});

// ── FPV attitude HUD toggle ──────────────────
bindToggle('fpvhud-toggle',fpvHudOn,v=>{
  fpvHudOn=v;
  store.setBool(KEYS.hudOverlay,v);
  if(!fpvHudOn) fpvCtx.clearRect(0,0,innerWidth,innerHeight);
});

// ── Graphics quality ─────────────────────────
el.qualitySelect.value=quality;
el.qualitySelect.addEventListener('change',()=>{
  quality=el.qualitySelect.value;
  store.set(KEYS.quality,quality);
  applyQuality(quality);
  // Sky resolution and texture sets are chosen per tier at load time.
  applyEnvironment(theme);
  syncCamNote();
  el.qualityNote.textContent='';
  showSaveToast('✓ QUALITY: '+quality.toUpperCase());
});

// ── Camera model ─────────────────────────────
function applyCamSettings(){
  saveCamSettings();
  if(post) post.applySettings(camSettings);
  applyCameraFov();
  syncCamNote();
}
function syncCamNote(){
  const n=document.getElementById('cam-note');
  if(n) n.textContent=QUALITY_TIERS[quality].post ? '' : 'Graphics quality is LOW — camera effects are off.';
}
[['cam-lens','lens'],['cam-shutter','shutter'],['cam-profile','profile'],['cam-feed','feed']].forEach(([id,key])=>{
  const node=document.getElementById(id);
  node.value=camSettings[key];
  node.addEventListener('change',()=>{ camSettings[key]=node.value; applyCamSettings(); });
});
bindToggle('cam-autoexp',camSettings.autoExposure,v=>{ camSettings.autoExposure=v; applyCamSettings(); });
{
  const slider=document.getElementById('cam-shake'), disp=document.getElementById('cam-shake-disp');
  slider.value=Math.round(camSettings.shake*100); disp.textContent=slider.value+'%';
  slider.addEventListener('input',()=>{ camSettings.shake=slider.value/100; disp.textContent=slider.value+'%'; saveCamSettings(); });
}
syncCamNote();

// ── Touch controls ───────────────────────────
el.touchSelect.value=touchMode;
el.touchSelect.addEventListener('change',()=>{
  touchMode=el.touchSelect.value;
  store.set(KEYS.touchMode,touchMode);
  applyTouchMode();
});
applyTouchMode();

// ── Lap records ──────────────────────────────
el.clearBestBtn.addEventListener('click',()=>{
  bestLapMs=null; bestSplits=null;
  store.remove(KEYS.bestLap);
  updateBestLapUI();
  el.lapDelta.textContent=''; el.lapDelta.className='';
  showSaveToast('✓ BEST LAP CLEARED');
});
updateBestLapUI();

// ── Collision toggles ─────────────────────────
bindToggle('collide-gates-toggle',collideGates,v=>{
  collideGates=v; store.setBool(KEYS.collideGates,v);
});
bindToggle('collide-trees-toggle',collideTrees,v=>{
  collideTrees=v; store.setBool(KEYS.collideTrees,v);
});

// ── Scenery toggles ───────────────────────────
const showTreesToggle=bindToggle('show-trees-toggle',showTrees,v=>{
  showTrees=v;
  applyTreeVisibility();
  store.setBool(KEYS.trees+theme,v);
});

// ── Theme select ───────────────────────────────
el.themeSelect.value=theme;
el.themeSelect.addEventListener('change',()=>{
  theme=el.themeSelect.value;
  store.set(KEYS.theme,theme);
  showTrees=loadShowTreesFor(theme);
  showTreesToggle.checked=showTrees;
  applyTreeVisibility();
  applyEnvironment(theme);
});

el.mapBtn.addEventListener('click',openSettings);
el.closeBtn.addEventListener('click',closeSettings);
el.wizBtn.addEventListener('click',startWizard);
el.mapModal.addEventListener('click',e=>{ if(e.target===el.mapModal) closeSettings(); });

el.saveBtn.addEventListener('click',()=>{
  clearTimeout(phySaveTimer);
  const ts=savePhy();
  saveMap();
  if(ts){
    markSaved(ts);
    showSaveToast('✓ CONFIG SAVED');
  } else {
    showSaveToast('⚠ SAVE UNAVAILABLE','#ffb830');
  }
});

// Two-step confirm on the button itself — the old blocking confirm() dialog was
// the only piece of browser chrome left in an otherwise self-contained UI.
let resetConfirmTimer=null;
function resetConfirmState(){
  clearTimeout(resetConfirmTimer);
  el.resetBtn.classList.remove('confirming');
  el.resetBtn.textContent='↺ RESET';
}
el.resetBtn.addEventListener('click',()=>{
  if(!el.resetBtn.classList.contains('confirming')){
    el.resetBtn.classList.add('confirming');
    el.resetBtn.textContent='↺ CONFIRM?';
    resetConfirmTimer=setTimeout(resetConfirmState,3500);
    return;
  }
  resetConfirmState();
  resetPhy();
  updateAnalysis();
  initSaveStatus();
});

// ═══════════════════════════════════════════════
//  ENGINE SOUND — Web Audio, varies with throttle %
// ═══════════════════════════════════════════════
let soundEnabled=true;
let audioCtx=null, motorOsc1=null, motorOsc2=null, motorGain=null, motorFilter=null, noiseGain=null;

function initAudio(){
  if(audioCtx) return;
  try{
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();

    motorGain=audioCtx.createGain(); motorGain.gain.value=0;
    motorFilter=audioCtx.createBiquadFilter();
    motorFilter.type='lowpass'; motorFilter.frequency.value=1500;

    // Two slightly detuned oscillators mimic the buzz of 4 motors
    motorOsc1=audioCtx.createOscillator(); motorOsc1.type='sawtooth'; motorOsc1.frequency.value=90;
    motorOsc2=audioCtx.createOscillator(); motorOsc2.type='sawtooth'; motorOsc2.frequency.value=91.5;
    const merge=audioCtx.createGain(); merge.gain.value=0.5;
    motorOsc1.connect(merge); motorOsc2.connect(merge);
    merge.connect(motorFilter); motorFilter.connect(motorGain); motorGain.connect(audioCtx.destination);
    motorOsc1.start(); motorOsc2.start();

    // Airflow / propeller noise
    const bufSize=Math.floor(audioCtx.sampleRate*2);
    const buf=audioCtx.createBuffer(1,bufSize,audioCtx.sampleRate);
    const data=buf.getChannelData(0);
    for(let i=0;i<bufSize;i++) data[i]=Math.random()*2-1;
    const noiseSrc=audioCtx.createBufferSource(); noiseSrc.buffer=buf; noiseSrc.loop=true;
    const noiseFilter=audioCtx.createBiquadFilter();
    noiseFilter.type='bandpass'; noiseFilter.frequency.value=2200; noiseFilter.Q.value=0.5;
    noiseGain=audioCtx.createGain(); noiseGain.gain.value=0;
    noiseSrc.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(audioCtx.destination);
    noiseSrc.start();
  }catch(e){ audioCtx=null; }
}

// thrNorm: current effective thrust (drone.thr), 0..~1 — already includes motor spool-up delay
function updateMotorSound(thrNorm){
  if(!audioCtx) return;
  if(audioCtx.state==='suspended') audioCtx.resume();
  const t=audioCtx.currentTime;
  const mute=!soundEnabled;
  const freq=85+thrNorm*270;
  motorOsc1.frequency.setTargetAtTime(freq,t,0.05);
  motorOsc2.frequency.setTargetAtTime(freq*1.014,t,0.05);
  motorFilter.frequency.setTargetAtTime(1200+thrNorm*5200,t,0.08);
  motorGain.gain.setTargetAtTime(mute?0:0.03+thrNorm*0.15,t,0.06);
  noiseGain.gain.setTargetAtTime(mute?0:0.008+thrNorm*0.045,t,0.08);
}

function playCrashThud(){
  if(!audioCtx || !soundEnabled) return;
  const dur=0.35;
  const buf=audioCtx.createBuffer(1,Math.floor(audioCtx.sampleRate*dur),audioCtx.sampleRate);
  const data=buf.getChannelData(0);
  for(let i=0;i<data.length;i++){
    const decay=Math.pow(1-i/data.length,3);
    data[i]=(Math.random()*2-1)*decay;
  }
  const src=audioCtx.createBufferSource(); src.buffer=buf;
  const filt=audioCtx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=350;
  const g=audioCtx.createGain(); g.gain.value=0.9;
  src.connect(filt); filt.connect(g); g.connect(audioCtx.destination);
  src.start();
}

el.soundBtn.addEventListener('click',()=>{
  soundEnabled=!soundEnabled;
  el.soundBtn.textContent=soundEnabled?'🔊':'🔇';
});

// ═══════════════════════════════════════════════
//  FULLSCREEN
// ═══════════════════════════════════════════════
function isFullscreen(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function toggleFullscreen(){
  const root=document.documentElement;
  if(!isFullscreen()){
    const req=root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
    if(req){ const p=req.call(root); if(p && p.catch) p.catch(()=>{}); }
  } else {
    const exit=document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if(exit) exit.call(document);
  }
}
el.fullscreenBtn.addEventListener('click',toggleFullscreen);
['fullscreenchange','webkitfullscreenchange'].forEach(evt=>{
  document.addEventListener(evt,()=>{
    el.fullscreenBtn.textContent=isFullscreen()?'⤡':'⤢';
    // Fullscreen changes the viewport without always firing `resize` first.
    resizeFpvHud();
  });
});

// ═══════════════════════════════════════════════
//  FLIGHT MODE (Acro / Balanced) — click the badge to switch
// ═══════════════════════════════════════════════
const modeBadge=document.querySelector('.mode-badge');
function updateModeBadge(){
  modeBadge.textContent = flightMode==='balanced' ? 'BALANCED MODE' : 'ACRO MODE';
}
function toggleFlightMode(){
  flightMode = flightMode==='balanced' ? 'acro' : 'balanced';
  store.set(KEYS.flightMode, flightMode);
  updateModeBadge();
  showSaveToast(flightMode==='balanced'?'BALANCED (SELF-LEVELING)':'ACRO (RATE MODE)');
}
modeBadge.addEventListener('click',toggleFlightMode);
updateModeBadge();

// Touch-only HUD shortcut for R, which doesn't exist on a phone. Mode switching
// stays on the mode badge itself — it relocates to bottom-center on touch.
el.resetBtnHud.addEventListener('click',()=>{
  resetRun();
  if(randomizeOnReset) buildCircuit();
});

// buildCircuit() runs before the lap-timer state is declared, so the first paint
// of the gate/lap/best readouts happens here instead.
function initHUDState(){
  updateGateHUD();
  updateBestLapUI();
}
initHUDState();

// ═══════════════════════════════════════════════
//  KEYBIND HINT — useful on the first flight, clutter after that
// ═══════════════════════════════════════════════
let helpFadeTimer=null;
function scheduleHelpFade(){
  clearTimeout(helpFadeTimer);
  helpFadeTimer=setTimeout(()=>el.help.classList.add('faded'), 15000);
}
function showHelp(){
  el.help.classList.remove('faded');
  scheduleHelpFade();
}

// ═══════════════════════════════════════════════
//  MAIN LOOP — fixed-timestep physics
//
//  The simulation used to integrate once per rendered frame with dt clamped to
//  32ms. Two things went wrong with that: at 30fps and 40 m/s the drone moved
//  1.28m per step, so it could pass straight through a 0.48m gate bar (and
//  straddle the 2m gate-detection slab, silently voiding a clean pass); and
//  below ~31fps the clamp made the whole sim run in slow motion.
//
//  Physics now advances in fixed 1/120s steps regardless of frame rate, with
//  leftover time carried in an accumulator. Collision tests live inside
//  physics(), so they are sampled at the substep rate too.
// ═══════════════════════════════════════════════
const FIXED_DT=1/120;
const MAX_SUBSTEPS=8;   // ~67ms of catch-up; beyond that time is dropped rather
                        // than spiralling after a tab switch or a long stall
let last=performance.now(), running=false, accumulator=0;

function loop(){
  if(!running) return;
  requestAnimationFrame(loop);
  const now=performance.now();
  const frameDt=Math.min((now-last)/1000, 0.25); last=now;

  readInput(frameDt);

  if(!settingsOpen){
    accumulator+=frameDt;
    if(debugFreeze) accumulator=0;
    let steps=0;
    while(accumulator>=FIXED_DT && steps<MAX_SUBSTEPS){
      physics(FIXED_DT);
      if(crashState){
        crashState.t+=FIXED_DT;
        if(crashState.t>CRASH_RESPAWN_T) respawnAtCurrentGate();
      }
      accumulator-=FIXED_DT; steps++;
    }
    if(steps===MAX_SUBSTEPS) accumulator=0;   // give up on the backlog

    if(crashState){
      el.crashMeterFill.style.width=Math.min(100,crashState.t/CRASH_RESPAWN_T*100)+'%';
    }

    cam.position.copy(drone.pos);
    Q_TILT.setFromAxisAngle(_TILT_AXIS, camTiltDeg*Math.PI/180);
    cam.quaternion.copy(drone.quat).multiply(Q_TILT);
    cameraShake.apply(cam.quaternion, frameDt, crashState?0:drone.thr, drone.vel, camSettings.shake);
    if(post && camSettings.feed==='analog') post.setSignal(linkQuality(frameDt));
    updateHUD();
    updateMotorSound(drone.thr);
  } else {
    updateSettingsLive();
  }

  renderFrame(frameDt);
}

const _sun={dir:null, color:null, illuminance:0};
// Dynamic resolution (MEDIUM/HIGH): when frames run long the render scale
// steps down (the HUD is DOM, so it stays sharp); it creeps back up when
// there is headroom. Re-checked every 1.5 s so it never oscillates per frame.
let resScale=1, resTimer=0;
function governResolution(dt){
  const q=QUALITY_TIERS[quality];
  if(!q.dynamicRes || debugFreeze) return;
  resTimer+=dt;
  if(resTimer<1.5) return;
  resTimer=0;
  const ms=stats.getFrameMs(), budget=1000/58;
  let next=resScale;
  if(ms>budget*1.12) next=Math.max(q.dynamicRes[0], resScale-0.1);
  else if(ms<budget*0.8) next=Math.min(q.dynamicRes[1], resScale+0.05);
  if(Math.abs(next-resScale)<0.01) return;
  resScale=next;
  renderer.setPixelRatio(Math.min(devicePixelRatio,q.pixelRatio)*resScale);
  renderer.setSize(innerWidth,innerHeight);
  if(post) post.setSize(innerWidth,innerHeight);
  stats.set('RES', Math.round(resScale*100)+'%');
}

function renderFrame(dt){
  renderer.info.reset();
  governResolution(dt);
  env.update();
  // Prop wash only while armed and flying; it scales with thrust.
  const wash=crashState ? 0 : Math.min(1, drone.thr * 1.5);
  for(const g of grassLayers) g.update(cam, drone.pos, wash);
  droneShadow.position.copy(drone.pos); droneShadow.quaternion.copy(drone.quat);
  // Dust is lit like a mid-grey surface under the current sky + sun.
  const eG=env.skyIlluminance+env.sunIlluminance*Math.max(env.sunDirection.y,0);
  dust.setLight(_dustLight.setRGB(0.5,0.45,0.38).multiplyScalar(eG/Math.PI));
  const gy=groundAt(drone.pos.x,drone.pos.z);
  dust.update(dt, drone.pos, gy, world ? 0 : wash, terrain.bareAt(drone.pos.x,drone.pos.z));
  if(vegetationReady){
    _sun.dir=env.sunDirection; _sun.color=env.sunColor; _sun.illuminance=env.sunIlluminance;
    vegetation.update(cam, dt, _sun);
    if(vegetation.stats) stats.set('TREES', vegetation.stats.full+' full · '+vegetation.stats.impostors+' cards');
  }
  if(post && QUALITY_TIERS[quality].post) post.render(dt);
  else renderer.render(scene,cam);
  stats.frame(dt);
}

// ═══════════════════════════════════════════════
//  RESIZE + GAMEPAD EVENTS
// ═══════════════════════════════════════════════
let resizeTimer=null;
window.addEventListener('resize',()=>{
  cam.aspect=innerWidth/innerHeight;
  applyCameraFov();
  renderer.setSize(innerWidth,innerHeight);
  if(post) post.setSize(innerWidth,innerHeight);
  // Reallocating the full-screen HUD backing store is expensive, so it trails
  // the drag rather than firing on every resize event.
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{ resizeFpvHud(); resizeADI(); applyTouchMode(); },120);
});
window.addEventListener('gamepadconnected',e=>{
  el.gpname.textContent=e.gamepad.id.slice(0,26);
  gpBaseline=null; gpIndex=-1;   // re-baseline so the new pad must move to take over
  if(settingsOpen) refreshSettingsUI();
});
window.addEventListener('gamepaddisconnected',()=>{
  el.gpname.textContent='NO CONTROLLER';
  gpBaseline=null; gpIndex=-1;
  if(inputSource==='gamepad') inputSource='keyboard';
  if(settingsOpen) el.noGp.style.display='block';
});

// ═══════════════════════════════════════════════
//  PWA — installable + offline via sw.js. Registration itself needs no error
//  UI: if it fails (unsupported browser, blocked, served over plain HTTP) the
//  game still runs identically, it just won't be installable or work offline.
// ═══════════════════════════════════════════════
if('serviceWorker' in navigator && !URLP.has('nosw')){
  const registerSW=()=>navigator.serviceWorker.register('sw.js').catch(()=>{});
  // This module can finish after `load` has already fired (it awaits assets).
  if(document.readyState==='complete') registerSW(); else window.addEventListener('load',registerSW);
}

// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
el.btnStart.addEventListener('click',()=>{
  if(el.btnStart.disabled) return;
  el.splash.classList.add('hiding');
  setTimeout(()=>{ el.splash.style.display='none'; },400);
  initAudio();
  running=true; last=performance.now(); accumulator=0;
  scheduleHelpFade();
  loop();
});

// ═══════════════════════════════════════════════
//  CAPTURED MAPS — listed in assets/maps/maps.json (see src/worlds/splatmap.js).
//  ?splat=<url> previews any capture on a flat floor without authoring it;
//  ?splatRot=180,0,0 &splatScale=1 &splatPos=0,0,0 fix up its orientation.
// ═══════════════════════════════════════════════
let mapList=[], mapId='field';
const mapRow=document.getElementById('map-row'), mapSelect=document.getElementById('map-select');

function applyFieldVisibility(field){
  terrain.mesh.visible=field;
  grassLayers.forEach(g=>{ g.mesh.visible=field; });
  applyTreeVisibility();
  props.group.visible=field;
  floodlights.group.visible=field;
  dust.points.visible=field;
}

async function setMap(id){
  const def=mapList.find(m=>m.id===id);
  if(world){ world.dispose(); world=null; }
  if(def){
    showSaveToast('LOADING '+String(def.name||def.id).toUpperCase()+'…');
    try{ world=await loadSplatMap(def,{renderer,scene}); }
    catch(e){ console.error(e); showSaveToast('⚠ MAP FAILED TO LOAD','#ffb830'); world=null; }
  }
  mapId=world ? id : 'field';
  applyFieldVisibility(!world);
  if(world && world.sky && world.sky!==theme && ENV_PRESETS[world.sky]){
    theme=world.sky; el.themeSelect.value=theme; applyEnvironment(theme);
  }
  buildCircuit(); resetRun();
  if(id!=='preview') store.set(KEYS.worldMap, mapId);
  mapSelect.value=mapId;
  if(world) showSaveToast('✓ '+world.name.toUpperCase());
}

const mapsReady=loadMapIndex().then(list=>{
  mapList=list;
  const preview=URLP.get('splat');
  if(preview){
    const nums=k=>(URLP.get(k)||'').split(',').filter(Boolean).map(Number);
    mapList.push({ id:'preview', name:'Preview capture', splat:preview, sky:URLP.get('env')||'midday',
      groundY:+(URLP.get('groundY')||0),
      transform:{ rotationDeg: nums('splatRot').length===3 ? nums('splatRot') : [180,0,0],
                  scale:+(URLP.get('splatScale')||1),
                  position: nums('splatPos').length===3 ? nums('splatPos') : [0,0,0] } });
  }
  if(!mapList.length) return;
  mapSelect.innerHTML='<option value="field">FIELD (procedural)</option>'+
    mapList.map(m=>`<option value="${m.id}">${String(m.name||m.id).replace(/</g,'&lt;')}</option>`).join('');
  mapRow.style.display='';
  mapSelect.addEventListener('change',()=>setMap(mapSelect.value));
  const want=preview ? 'preview' : (URLP.get('map') || store.get(KEYS.worldMap));
  if(want && want!=='field' && mapList.some(m=>m.id===want)) return setMap(want);
});

// ── Debug hooks (used by tools/shot.mjs for reproducible screenshots) ──
window.__fpv={
  ready:false, THREE, renderer, scene, cam, env, drone, gates, vegetation, terrain, droneShadow,
  get post(){ return post; },
  setPose(x,y,z,yawDeg=0,pitchDeg=0,rollDeg=0){
    drone.pos.set(x,y,z); drone.vel.set(0,0,0); drone.omega.set(0,0,0);
    drone.quat.setFromEuler(new THREE.Euler(pitchDeg*Math.PI/180, yawDeg*Math.PI/180, rollDeg*Math.PI/180,'YXZ'));
  },
  freeze(v=true){ debugFreeze=v; },
  // Deterministic physics stepping for tools/physics-test (input set directly).
  test:{
    inp,
    step(n=1){
      for(let i=0;i<n;i++){
        physics(FIXED_DT);
        if(crashState){ crashState.t+=FIXED_DT; if(crashState.t>CRASH_RESPAWN_T) respawnAtCurrentGate(); }
      }
    },
    get crash(){ return crashState ? crashState.cause : null; },
    get nextGate(){ return nextGate; },
    reset(){ respawnDrone(); crashState=null; nextGate=0; },
    props, floodlights,
  },
  setEnv(name){ theme=name; return applyEnvironment(name); },
  setMap(id){ return setMap(id); },
  get world(){ return world; },
  setQuality(name){ quality=name; applyQuality(name); return applyEnvironment(theme); },
};

// Assets (sky, textures) load asynchronously; FLY stays disabled until the
// first environment is ready so the first frame is never an unlit scene.
Promise.all([envReady, terrainReady, vegReady, mapsReady]).then(()=>{
  el.btnStart.disabled=false;
  el.btnStart.textContent='▶ FLY';
  el.loadBar?.classList.add('done');
  if(URLP.has('autostart')) el.btnStart.click();
  window.__fpv.ready=true;
}).catch(err=>{
  console.error(err);
  el.btnStart.textContent='⚠ ASSETS FAILED — RELOAD';
});

