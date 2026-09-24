// ═══════════════════════════════════════════════
//  PERF OVERLAY — P key or ?stats=1. Frame time, FPS, draw calls, triangles
//  and GPU resource counts, refreshed twice a second. Also feeds the
//  dynamic-resolution governor through getFrameMs().
// ═══════════════════════════════════════════════
export function createStats(renderer, visible) {
  const node = document.createElement('div');
  node.id = 'perf';
  node.style.cssText = 'position:fixed;top:64px;right:12px;z-index:60;pointer-events:none;' +
    'font:11px/1.5 "Courier New",monospace;color:#bfe;background:rgba(5,10,18,.72);' +
    'border:1px solid rgba(0,229,255,.25);padding:6px 9px;white-space:pre;display:none';
  document.body.appendChild(node);

  let shown = !!visible, acc = 0, frames = 0, emaMs = 16.7;
  const extra = {};
  node.style.display = shown ? 'block' : 'none';

  return {
    frame(dt) {
      const ms = dt * 1000;
      emaMs += (ms - emaMs) * 0.08;
      acc += dt; frames++;
      if (!shown || acc < 0.5) { if (acc >= 0.5) { acc = 0; frames = 0; } return; }
      const i = renderer.info;
      const lines = [
        `FPS   ${(frames / acc).toFixed(0).padStart(4)}   ${emaMs.toFixed(1)} ms`,
        `DRAW  ${String(i.render.calls).padStart(4)}   TRIS ${(i.render.triangles / 1000).toFixed(0)}k`,
        `GEO   ${String(i.memory.geometries).padStart(4)}   TEX  ${i.memory.textures}`,
      ];
      for (const [k, v] of Object.entries(extra)) lines.push(`${k.padEnd(5)} ${v}`);
      node.textContent = lines.join('\n');
      acc = 0; frames = 0;
    },
    set(key, value) { extra[key] = value; },
    getFrameMs() { return emaMs; },
    toggle() { shown = !shown; node.style.display = shown ? 'block' : 'none'; },
  };
}
