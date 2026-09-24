// ═══════════════════════════════════════════════
//  RENDERER + QUALITY TIERS
//  One tier drives resolution, anti-aliasing, shadows, post effects and
//  vegetation density together. MSAA now lives in the post-processing
//  render target instead of the WebGL context, so changing tier no longer
//  needs a reload for anti-aliasing.
// ═══════════════════════════════════════════════
import * as THREE from 'three';

export const QUALITY_TIERS = {
  low: {
    label: 'LOW', pixelRatio: 1, dynamicRes: null,
    post: false, msaa: 0, smaa: false,
    shadows: false, cascades: 1, shadowMap: 1024,
    ao: 0, motionBlurSamples: 0, bloom: false, lens: false,
    grass: [], treeDetail: 0, skyRes: '2k', texRes: '1k', terrainSegments: 200, forest: 700,
  },
  medium: {
    label: 'MEDIUM', pixelRatio: 1, dynamicRes: [0.7, 1.0],
    post: true, msaa: 0, smaa: true,
    shadows: true, cascades: 1, shadowMap: 1024,
    ao: 0, motionBlurSamples: 6, bloom: true, lens: true,
    grass: [{ radius: 7, inner: 0, clumps: 7000 }, { radius: 18, inner: 6, clumps: 4000 }], treeDetail: 1, skyRes: '2k', texRes: '1k', terrainSegments: 256, forest: 1800,
  },
  high: {
    label: 'HIGH', pixelRatio: 1.5, dynamicRes: [0.75, 1.0],
    post: true, msaa: 4, smaa: false,
    shadows: true, cascades: 2, shadowMap: 2048,
    ao: 1, motionBlurSamples: 8, bloom: true, lens: true,
    grass: [{ radius: 9, inner: 0, clumps: 20000 }, { radius: 30, inner: 8, clumps: 12000 }], treeDetail: 2, skyRes: '4k', texRes: '1k', terrainSegments: 400, forest: 4000,
  },
  ultra: {
    label: 'ULTRA', pixelRatio: 2, dynamicRes: null,
    post: true, msaa: 4, smaa: false,
    shadows: true, cascades: 3, shadowMap: 2048,
    ao: 2, motionBlurSamples: 12, bloom: true, lens: true,
    grass: [{ radius: 11, inner: 0, clumps: 32000 }, { radius: 40, inner: 10, clumps: 20000 }], treeDetail: 2, skyRes: '4k', texRes: '1k', terrainSegments: 400, forest: 6500,
  },
};

// LOW is the default everywhere: it runs on anything, and it is still the
// photographed sky, textured field and real trees. Players opt up.
export const DEFAULT_QUALITY = 'low';

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,            // MSAA/SMAA are handled by the composer
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;   // the post stack tone-maps; LOW sets its own
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(innerWidth, innerHeight);
  // The post stack issues several render() calls per frame; count the whole
  // frame (shadow + scene + post passes) instead of just the last call.
  renderer.info.autoReset = false;
  return renderer;
}
