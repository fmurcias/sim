// Per-tier render cost (draw calls + triangles per frame, all passes included)
// from a fixed viewpoint over the course.
//   node tools/shot.mjs --test tools/cost-report.js
const F = window.__fpv;
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const out = [];
for (const q of ['low', 'medium', 'high', 'ultra']) {
  await F.setQuality(q);
  F.setPose(0, 3, 20, 0, -5, 0);
  for (let k = 0; k < 4; k++) await frame();
  const r = F.renderer.info.render, px = F.renderer.getDrawingBufferSize(new F.THREE.Vector2());
  out.push({ name: `${q.padEnd(6)} ${String(r.calls).padStart(4)} draw calls · ${(r.triangles / 1e6).toFixed(2)} M tris · ${px.x}×${px.y} px`, ok: true });
}
return { results: out };
