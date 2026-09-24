#!/usr/bin/env python3
"""Turn a Poly Haven equirectangular .hdr sky into web-sized assets.

A 4K Radiance .hdr is ~20 MB, far too heavy to ship. Instead each sky becomes:

  sky_4k.jpg / sky_2k.jpg  8-bit sRGB "base" image
  gain.png                 low-res log2 gain map (1024x512, 8-bit)
  meta.json                sun direction/colour/irradiance + decode constants

The runtime (src/render/sky.js) rebuilds scene-linear radiance per pixel as

  radiance = srgbToLinear(base) * exp2(gain * gainMaxLog2) / encodeScale

so the sun and bright cloud edges keep their full HDR range (for bloom, auto
exposure and image-based lighting) at ~1-2 MB per sky instead of ~20 MB.

The sun is also measured here: the energy inside a small cone around the
brightest point, above the surrounding sky level, becomes the DirectionalLight
(which casts shadows), and the runtime clamps that cone out of the IBL copy of
the sky so sunlight is not counted twice.

Direction convention (shared with the shader):
  u = atan2(d.z, d.x) / 2pi + 0.5      v_img = 0.5 - asin(d.y) / pi   (row 0 = zenith)

Usage: prep_sky.py <input.hdr> <out_dir>
"""
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image

SUN_CONE_DEG = 3.0           # sun + lens bloom region removed from the IBL copy
ANNULUS_DEG = (3.5, 7.0)     # surrounding sky used as the clamp level
GAIN_FACTOR = 4              # gain map is 4x smaller than the 4K base
BASE_PERCENTILE = 99.0       # this percentile of max-channel radiance maps to BASE_WHITE
BASE_WHITE = 0.92


def luminance(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def srgb_encode(lin):
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def directions(h, w):
    """Unit direction for each pixel centre, using the convention above."""
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    phi = (u - 0.5) * 2 * math.pi
    theta = (0.5 - v) * math.pi                      # elevation
    ct = np.cos(theta)[:, None]
    d = np.stack([ct * np.cos(phi)[None, :],
                  np.repeat(np.sin(theta)[:, None], w, 1),
                  ct * np.sin(phi)[None, :]], axis=-1)
    return d, theta


def main(src, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    bgr = cv2.imread(src, cv2.IMREAD_ANYDEPTH | cv2.IMREAD_COLOR)
    if bgr is None:
        sys.exit(f'cannot read {src}')
    hdr = np.ascontiguousarray(bgr[..., ::-1]).astype(np.float32)
    hdr = np.maximum(hdr, 0.0)
    if hdr.shape[1] != 4096:
        hdr = cv2.resize(hdr, (4096, 2048), interpolation=cv2.INTER_AREA)
    h, w = hdr.shape[:2]

    dirs, theta = directions(h, w)
    # Solid angle of each pixel: (2pi/w) * (pi/h) * cos(elevation)
    d_omega = (2 * math.pi / w) * (math.pi / h) * np.cos(theta)[:, None]

    lum = luminance(hdr)

    # ── Sun: brightest point of the (slightly blurred) upper hemisphere ──
    blurred = cv2.GaussianBlur(lum, (0, 0), 2.0)
    blurred[theta[:, None].repeat(w, 1) < math.radians(-2)] = 0
    sy, sx = np.unravel_index(np.argmax(blurred), blurred.shape)
    sun_dir = dirs[sy, sx] / np.linalg.norm(dirs[sy, sx])

    cos_ang = np.clip(dirs @ sun_dir, -1, 1)
    ang = np.degrees(np.arccos(cos_ang))
    cone = ang < SUN_CONE_DEG
    ring = (ang >= ANNULUS_DEG[0]) & (ang < ANNULUS_DEG[1])

    # Clamp level = bright end of the surrounding sky, per channel.
    ring_px = hdr[ring]
    ring_lum = luminance(ring_px)
    ref_idx = np.argsort(ring_lum)[int(len(ring_lum) * 0.95)]
    sun_clamp = ring_px[ref_idx]

    excess = np.maximum(hdr[cone] - sun_clamp[None, :], 0.0)
    sun_e_rgb = (excess * d_omega.repeat(w, 1)[cone][:, None]).sum(0)   # irradiance, normal to sun
    sun_e = float(luminance(sun_e_rgb))
    sun_color = (sun_e_rgb / max(sun_e, 1e-9)).tolist()

    # ── Sky irradiance on flat ground (sun cone clamped) ──
    clamped = hdr.copy()
    clamped[cone] = np.minimum(clamped[cone], sun_clamp[None, :])
    up = np.maximum(np.sin(theta), 0)[:, None]
    sky_e = float((luminance(clamped) * up * d_omega).sum())

    # Horizon band average (fog / aerial-perspective colour), sun cone excluded.
    band = (theta[:, None].repeat(w, 1) >= 0) & (theta[:, None].repeat(w, 1) < math.radians(6)) & ~cone
    horizon = (clamped[band] * d_omega.repeat(w, 1)[band][:, None]).sum(0) / d_omega.repeat(w, 1)[band].sum()
    zen = theta[:, None].repeat(w, 1) > math.radians(60)
    zenith = clamped[zen].mean(0)

    # ── Base + gain encoding ──
    maxc = hdr.max(-1)
    upper = theta[:, None].repeat(w, 1) > 0
    scale = BASE_WHITE / max(np.percentile(maxc[upper], BASE_PERCENTILE), 1e-6)
    g_full = np.log2(np.maximum(maxc * scale, 1.0))
    gh, gw = h // GAIN_FACTOR, w // GAIN_FACTOR
    g_low = g_full.reshape(gh, GAIN_FACTOR, gw, GAIN_FACTOR).max(axis=(1, 3))
    g_low = cv2.dilate(g_low, np.ones((3, 3), np.uint8))          # bilinear upsampling never undershoots
    g_max = max(float(g_low.max()), 1.0)
    q = np.ceil(g_low / g_max * 255).clip(0, 255).astype(np.uint8)
    Image.fromarray(q, 'L').save(os.path.join(out_dir, 'gain.png'), optimize=True)
    g_q = q.astype(np.float32) / 255 * g_max

    for size, name in ((4096, 'sky_4k.jpg'), (2048, 'sky_2k.jpg')):
        img = hdr if size == w else cv2.resize(hdr, (size, size // 2), interpolation=cv2.INTER_AREA)
        g_up = cv2.resize(g_q, (size, size // 2), interpolation=cv2.INTER_LINEAR)
        base = img * scale / np.exp2(g_up)[..., None]
        enc = (srgb_encode(base) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(enc, 'RGB').save(os.path.join(out_dir, name), quality=90, optimize=True,
                                         progressive=True, subsampling=0)

    meta = {
        'source': os.path.basename(src),
        'encodeScale': float(scale),
        'gainMaxLog2': g_max,
        'sunDir': [float(x) for x in sun_dir],
        'sunColor': sun_color,
        'sunIlluminance': sun_e,
        'sunConeDeg': SUN_CONE_DEG,
        'sunClamp': [float(x) for x in sun_clamp],
        'skyIlluminance': sky_e,
        'horizonColor': [float(x) for x in horizon],
        'zenithColor': [float(x) for x in zenith],
    }
    with open(os.path.join(out_dir, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    elev = math.degrees(math.asin(sun_dir[1]))
    print(f'{os.path.basename(src)}: sun elev {elev:.1f}deg  E_sun {sun_e:.2f}  E_sky {sky_e:.2f}  '
          f'ratio {sun_e * max(sun_dir[1], 0) / max(sky_e, 1e-9):.2f}  gain {g_max:.1f} stops')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
