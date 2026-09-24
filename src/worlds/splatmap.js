// ═══════════════════════════════════════════════
//  CAPTURED MAPS — real places as 3D Gaussian splats (Spark, MIT).
//
//  A map is described in assets/maps/maps.json:
//  {
//    "id": "park", "name": "City park",
//    "splat": "assets/maps/park/park.spz",          // .spz / .sog / .ply / .splat / .ksplat
//    "collider": "assets/maps/park/collider.glb",   // optional low-poly proxy (ground, walls, trees)
//    "transform": { "position": [0,0,0], "rotationDeg": [180,0,0], "scale": 1 },
//    "sky": "midday",                                // env preset lighting the gates
//    "spawn": { "position": [0,1.5,0], "yawDeg": 0 },
//    "groundY": 0,                                   // flat fallback when there is no collider
//    "gateSlots": [ { "position": [12,4,-20], "yawDeg": 30 }, ... ]
//  }
//
//  The splat has baked lighting, so the rest of the procedural field (terrain,
//  grass, trees, props) is hidden while a captured map is active; the race
//  gates, drone and camera model stay. Collision uses the proxy mesh through
//  three-mesh-bvh: a downward ray for the ground, closest-point for obstacles.
//
//  Spark and three-mesh-bvh are imported lazily — the field never pays for them.
// ═══════════════════════════════════════════════
import * as THREE from 'three';

const D2R = Math.PI / 180;

export async function loadMapIndex(url = 'assets/maps/maps.json') {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter(m => m && m.id && m.splat) : [];
  } catch { return []; }
}

export async function loadSplatMap(def, { renderer, scene, onProgress }) {
  const { SplatMesh, SparkRenderer } = await import('@sparkjsdev/spark');
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const splat = new SplatMesh({
    url: def.splat,
    onProgress: onProgress ? (e => e && e.total && onProgress(e.loaded / e.total)) : undefined,
  });
  const tr = def.transform || {};
  if (tr.position) splat.position.fromArray(tr.position);
  if (tr.rotationDeg) splat.rotation.set(tr.rotationDeg[0] * D2R, tr.rotationDeg[1] * D2R, tr.rotationDeg[2] * D2R);
  if (tr.scale) splat.scale.setScalar(tr.scale);
  scene.add(splat);
  await splat.initialized;

  // ── Collision proxy ──
  let proxy = null, bvhMesh = null;
  if (def.collider) {
    const [{ GLTFLoader }, bvh] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three-mesh-bvh'),
    ]);
    const gltf = await new GLTFLoader().loadAsync(def.collider);
    proxy = gltf.scene;
    if (tr.position) proxy.position.fromArray(tr.position);
    if (tr.rotationDeg) proxy.rotation.copy(splat.rotation);
    if (tr.scale) proxy.scale.setScalar(tr.scale);
    proxy.updateMatrixWorld(true);
    // Merge every proxy mesh into one world-space geometry with a BVH.
    const geos = [];
    proxy.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      geos.push(g.index ? g.toNonIndexed() : g);
    });
    const count = geos.reduce((n, g) => n + g.attributes.position.count, 0);
    const pos = new Float32Array(count * 3);
    let off = 0;
    for (const g of geos) { pos.set(g.attributes.position.array, off); off += g.attributes.position.array.length; g.dispose(); }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.boundsTree = new bvh.MeshBVH(merged);
    bvhMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    bvhMesh.raycast = bvh.acceleratedRaycast;
  }

  const flatY = def.groundY ?? 0;
  const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
  const down = new THREE.Vector3(0, -1, 0), origin = new THREE.Vector3();
  const hit = { point: new THREE.Vector3(), distance: 0 };
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let lastX = NaN, lastZ = NaN, lastY = flatY;

  return {
    id: def.id,
    name: def.name || def.id,
    sky: def.sky || null,
    spawn: def.spawn || null,
    gateSlots: Array.isArray(def.gateSlots) ? def.gateSlots : null,

    /** Highest proxy surface below 200 m at (x,z) — or the flat fallback. */
    groundAt(x, z) {
      if (!bvhMesh) return flatY;
      if (x === lastX && z === lastZ) return lastY;       // physics asks twice per step
      origin.set(x, 200, z);
      ray.set(origin, down);
      const hits = ray.intersectObject(bvhMesh, false);
      lastX = x; lastZ = z; lastY = hits.length ? hits[0].point.y : flatY;
      return lastY;
    },

    /** Sphere vs proxy (walls, trunks, furniture…). */
    collide(p, r) {
      if (!bvhMesh) return false;
      const bvhTree = bvhMesh.geometry.boundsTree;
      const res = bvhTree.closestPointToPoint(p, target, 0, r);
      // Ignore the floor under the drone — ground contact is handled separately.
      return !!res && res.distance < r && res.point.y > p.y - r * 0.5;
    },

    dispose() {
      scene.remove(splat, spark);
      splat.dispose?.();
      spark.dispose?.();
      if (bvhMesh) { bvhMesh.geometry.dispose(); bvhMesh.material.dispose(); }
    },
  };
}
