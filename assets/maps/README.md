# Captured maps (Gaussian splats)

Real places can be flown as photographic 3D scans. Each map is a Gaussian-splat
capture plus a few metadata fields, listed in [`maps.json`](maps.json). The
simulator shows a **Map** selector in *Settings → General* as soon as this list
is non-empty.

## 1. Capture

Walk (or fly a camera drone) slowly around the spot you want to race — a park,
a skate plaza, an abandoned building — keeping every surface in view from
several angles. Then turn the footage into a splat with any of:

- **Postshot** (desktop, Jawset), **Scaniverse** or **Polycam** (phone apps),
  **Luma**, or `nerfstudio` / `gsplat` if you prefer open-source training.

Clean up floaters and crop the scene in **SuperSplat** (browser-based,
PlayCanvas), set the scale so that 1 unit = 1 metre, and export as **`.spz`**
(smallest; `.sog`, `.ply`, `.splat` and `.ksplat` also load). Aim for 1–3 M
splats and 20–80 MB for desktop; phones cope with ~1 M.

Preview any capture without editing anything:

```
http://localhost:8000/index.html?splat=assets/maps/park/park.spz
```

Add `&splatRot=180,0,0&splatScale=1&splatPos=0,0,0` to fix orientation
(most trainers export Y-down, which is the default `180,0,0`), and
`&groundY=…` for the flat floor used until you have a collider.

## 2. Collider (recommended)

Splats have no surfaces to collide with, so each map can ship a low-poly
**collision proxy** (`.glb`): ground, walls, trunks, benches — a few thousand
triangles blocked out in Blender over the splat (import the splat's point
cloud or the trainer's mesh export as a reference). The ground under the drone
is found by a downward ray; anything else within the drone's radius is a crash
("obstacle"). Keep the proxy in the same coordinates as the splat.

## 3. Gate slots and spawn

Fly the preview, note positions you like (the `P` key shows a perf overlay;
`window.__fpv.drone.pos` in the console gives the position), and list them as
`gateSlots` in lap order. *Randomize* picks up to 12 of them, keeping their
order.

## 4. Register

```json
[
  {
    "id": "park",
    "name": "City park",
    "splat": "assets/maps/park/park.spz",
    "collider": "assets/maps/park/collider.glb",
    "transform": { "position": [0, 0, 0], "rotationDeg": [180, 0, 0], "scale": 1 },
    "sky": "midday",
    "spawn": { "position": [0, 1.5, 0], "yawDeg": 0 },
    "gateSlots": [
      { "position": [12, 4, -20], "yawDeg": 30 },
      { "position": [30, 3, -45], "yawDeg": 80 }
    ]
  }
]
```

`sky` picks the environment preset that lights the gates, so choose the one
closest to the light in your capture. Splats carry baked lighting, so the
procedural field (terrain, grass, trees, props) is hidden while a captured map
is active.

Large captures are not precached by the service worker; they are cached the
first time they are flown and then work offline.
