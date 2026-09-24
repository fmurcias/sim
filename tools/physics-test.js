// Physics / collision regression tests, run in the page by:
//   node tools/shot.mjs --test tools/physics-test.js
// Uses the deterministic stepper exposed on window.__fpv.test.
const F = window.__fpv, T = F.test, THREE = F.THREE, d = F.drone;
const results = [];
const check = (name, ok, info) => results.push({ name, ok: !!ok, info });
const place = (x, y, z, yaw = 0) => { T.reset(); F.setPose(x, y, z, yaw, 0, 0); };

// 1. Climb: 80% throttle for 2 s from the pad gains altitude and doesn't crash.
place(0, F.terrain.groundAt(0, 0) + 1.5, 0);
T.inp.throttle = 0.8; T.inp.pitch = T.inp.roll = T.inp.yaw = 0;
const y0 = d.pos.y; T.step(240);
check('climb at 80% throttle', d.pos.y > y0 + 3 && !T.crash, `Δy=${(d.pos.y - y0).toFixed(2)} m`);

// 2. Free fall from 30 m onto the terrain crashes with cause "ground".
place(40, F.terrain.groundAt(40, -40) + 30, -40);
T.inp.throttle = 0; T.step(400);
check('free fall → ground crash', T.crash === 'ground', `crash=${T.crash}`);

// 3. Gentle landing on a slope settles on the surface without crashing.
{
  // Find a sloped spot inside the grass area.
  let best = null;
  for (let x = -150; x <= 150; x += 7) for (let z = -150; z <= 150; z += 7) {
    const s = Math.abs(F.terrain.groundAt(x + 1, z) - F.terrain.groundAt(x - 1, z)) / 2;
    if (Math.hypot(x, z) > 60 && (!best || s > best.s)) best = { x, z, s };
  }
  place(best.x, F.terrain.groundAt(best.x, best.z) + 0.6, best.z);
  T.inp.throttle = 0; T.step(360);
  const gap = d.pos.y - F.terrain.groundAt(d.pos.x, d.pos.z);
  check('settle on slope (no crash)', !T.crash && Math.abs(gap - 0.12) < 0.02, `slope=${best.s.toFixed(3)} gap=${gap.toFixed(3)} crash=${T.crash}`);
}

// 4. Flying through the centre of gate 1 advances the gate counter.
{
  const g = F.gates[0];
  const n = new THREE.Vector3(g.sn, 0, g.cs);            // gate normal (local +Z)
  place(g.pos.x - n.x * 3, g.pos.y, g.pos.z - n.z * 3);
  d.vel.copy(n).multiplyScalar(12);
  T.inp.throttle = 0.5; T.step(60);
  check('pass gate 1 → next gate 2', T.nextGate === 1 && !T.crash, `nextGate=${T.nextGate} crash=${T.crash}`);
}

// 5. Touching a gate's top bar crashes with cause "gate".
{
  const g = F.gates[3];
  place(g.pos.x, g.pos.y + 3 + 0.1, g.pos.z);
  T.step(1);
  check('gate bar → gate crash', T.crash === 'gate', `crash=${T.crash}`);
}

// 6. Gate pole (now standing on terrain) crashes too.
{
  const g = F.gates[5];
  place(g.pos.x, (g.groundY + g.pos.y - 3) / 2, g.pos.z);
  T.step(1);
  check('gate pole → gate crash', T.crash === 'gate', `crash=${T.crash}`);
}

// 7. Tree trunk crashes with cause "tree".
{
  const t = F.vegetation.trees.find(t => t.col && t.col.trunkTop > 2);
  place(t.x + t.col.trunkR * 0.5, t.y + 1.0, t.z);
  T.step(1);
  check('tree trunk → tree crash', T.crash === 'tree', `crash=${T.crash}`);
}

// 8. Tree crown crashes with cause "tree".
{
  const t = F.vegetation.trees.find(t => t.col && t.col.canopyR > 1.5);
  place(t.col.cx, t.y + (t.col.canopyBot + t.col.canopyTop) / 2, t.col.cz);
  T.step(1);
  check('tree crown → tree crash', T.crash === 'tree', `crash=${T.crash}`);
}

// 9. A traffic cone at a pad corner is an obstacle.
{
  const c = T.props.colliders.find(c => c.type === 'cyl' && c.r < 0.2);
  place(c.x, c.y0 + 0.3, c.z);
  T.step(1);
  check('cone → obstacle crash', T.crash === 'obstacle', `crash=${T.crash}`);
}

// 10. Open air far from everything: no false positives over 1 s of hover.
place(0, 20, -60);
T.inp.throttle = 0.5; T.step(120);
check('open air → no crash', !T.crash, `crash=${T.crash}`);

// 11. Respawn lands at RESPAWN_ALT above the local ground, facing the gate.
{
  place(40, F.terrain.groundAt(40, -40) + 30, -40);
  T.inp.throttle = 0;
  let steps = 0;
  while (!T.crash && steps < 1200) { T.step(1); steps++; }   // fall until the crash…
  while (T.crash && steps < 2400) { T.step(1); steps++; }    // …then until the respawn
  const gap = d.pos.y - F.terrain.groundAt(d.pos.x, d.pos.z);
  check('respawn above local ground', !T.crash && Math.abs(gap - 1.5) < 0.2, `gap=${gap.toFixed(2)} crash=${T.crash}`);
}

T.inp.throttle = 0;
return { results };
