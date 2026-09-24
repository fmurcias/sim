#!/usr/bin/env python3
"""Repack an ambientCG (CC0) PBR set into two web textures per resolution.

  <name>_albedo_<res>.jpg  sRGB colour, with the AO map baked in at half
                           strength (micro-occlusion the renderer can't produce)
  <name>_nr_<res>.jpg      R,G = OpenGL tangent-space normal X,Y; B = roughness.
                           Normal Z is rebuilt in the shader. Saved 4:4:4 so
                           chroma subsampling can't smear the packed channels.

Fewer, smaller textures: one fetch less per layer in the terrain shader and
~1-1.5 MB per set instead of ~40 MB for the source zip.

Usage: prep_textures.py <ambientcg_dir> <asset_id> <out_dir> <out_name>
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFile

# Large optimized JPEGs overflow PIL's default encoder buffer.
ImageFile.MAXBLOCK = 1 << 25


def load(path, mode):
    return Image.open(path).convert(mode)


def main(src_dir, asset, out_dir, name):
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(src_dir, f'{asset}_2K-JPG')
    color = load(base + '_Color.jpg', 'RGB')
    normal = load(base + '_NormalGL.jpg', 'RGB')
    rough = load(base + '_Roughness.jpg', 'L')
    ao_path = base + '_AmbientOcclusion.jpg'
    ao = load(ao_path, 'L') if os.path.exists(ao_path) else None

    # Terrain tiles every 2-4 m, so 1K is already ~3 mm/texel — about one screen
    # pixel at FPV altitude. 2K only quadrupled the download.
    for res, tag in ((1024, '1k'),):
        c = np.asarray(color.resize((res, res), Image.LANCZOS)).astype(np.float32) / 255
        if ao is not None:
            a = np.asarray(ao.resize((res, res), Image.LANCZOS)).astype(np.float32) / 255
            c = c * (0.5 + 0.5 * a)[..., None]
        Image.fromarray((c * 255 + 0.5).astype(np.uint8)).save(
            os.path.join(out_dir, f'{name}_albedo_{tag}.jpg'), quality=86, optimize=True, progressive=True)

        n = np.asarray(normal.resize((res, res), Image.LANCZOS))
        r = np.asarray(rough.resize((res, res), Image.LANCZOS))
        nr = np.dstack([n[..., 0], n[..., 1], r])
        Image.fromarray(nr).save(os.path.join(out_dir, f'{name}_nr_{tag}.jpg'),
                                 quality=85, optimize=True, subsampling=0)
    print(name, 'done')


if __name__ == '__main__':
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
