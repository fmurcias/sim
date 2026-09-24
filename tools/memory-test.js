// GPU-resource leak check: rebuild the world 20× (R with randomize on) and
// require geometry/texture counts to stay flat.
//   node tools/shot.mjs --test tools/memory-test.js
const F = window.__fpv, info = F.renderer.info.memory;
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const pressR = () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r' }));
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r' }));
};
pressR(); await frame(); await frame();
const before = { g: info.geometries, t: info.textures };
for (let i = 0; i < 20; i++) { pressR(); await frame(); }
await frame(); await frame();
const after = { g: info.geometries, t: info.textures };
return { results: [
  { name: 'geometries stable after 20 rebuilds', ok: after.g <= before.g, info: `${before.g} → ${after.g}` },
  { name: 'textures stable after 20 rebuilds', ok: after.t <= before.t, info: `${before.t} → ${after.t}` },
] };
