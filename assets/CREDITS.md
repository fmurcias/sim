# Asset credits

Everything in `assets/` is CC0 (public domain) unless noted; credit is given
anyway because these projects make a browser simulator like this possible.

| Asset | Source | License | Used for |
|---|---|---|---|
| `kloofendal_48d_partly_cloudy_puresky` | [Poly Haven](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) (Greg Zaal, Jarod Guest) | CC0 | `env/midday` |
| `table_mountain_2_puresky` | [Poly Haven](https://polyhaven.com/a/table_mountain_2_puresky) | CC0 | `env/golden` |
| `kloofendal_overcast_puresky` | [Poly Haven](https://polyhaven.com/a/kloofendal_overcast_puresky) | CC0 | `env/overcast` |
| `kloppenheim_02_puresky` | [Poly Haven](https://polyhaven.com/a/kloppenheim_02_puresky) | CC0 | `env/night` |
| Grass004 | [ambientCG](https://ambientcg.com/view?id=Grass004) | CC0 | `textures/grass_*` |
| Ground037 | [ambientCG](https://ambientcg.com/view?id=Ground037) | CC0 | `textures/meadow_*` |
| Ground003 | [ambientCG](https://ambientcg.com/view?id=Ground003) | CC0 | `textures/dirt_*` |
| Asphalt031 | [ambientCG](https://ambientcg.com/view?id=Asphalt031) | CC0 | `textures/asphalt_*` |

The skies were converted with [`tools/prep_sky.py`](../tools/prep_sky.py) and
the ground sets with [`tools/prep_textures.py`](../tools/prep_textures.py).

## Libraries (loaded from jsDelivr, pinned in `index.html`)

| Library | License |
|---|---|
| [three.js](https://threejs.org) r184 | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) 6.39 (pmndrs) | Zlib |
| [N8AO](https://github.com/N8python/n8ao) 2.0 | CC0 |
| [ez-tree](https://github.com/dgreenheck/ez-tree) 1.1 (Daniel Greenheck) — procedural trees and their bark/leaf textures | MIT |
| [Spark](https://sparkjs.dev) 2.2 (World Labs) — Gaussian-splat maps | MIT |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) 0.9 — splat-map collision | MIT |
