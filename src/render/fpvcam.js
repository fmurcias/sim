// ═══════════════════════════════════════════════
//  CAMERA SHAKE — visual only (never touches physics).
//  • motor vibration: fine jitter that grows with thrust, like a soft-mounted
//    FPV camera on a real quad;
//  • propwash: a low-frequency wobble when the quad descends through its own
//    wash while spooling back up.
//  Amount 0 disables it entirely (motion-sickness option).
// ═══════════════════════════════════════════════
import * as THREE from 'three';

const D2R = Math.PI / 180;

export function createCameraShake() {
  let t = 0, wash = 0;
  const e = new THREE.Euler(), q = new THREE.Quaternion();
  return {
    apply(camQuat, dt, thrust, vel, amount) {
      t += dt;
      if (amount <= 0) return;
      const hf = (0.04 + 0.22 * thrust) * amount;                    // degrees
      const vp = (Math.sin(t * 83.1) * 0.6 + Math.sin(t * 127.3 + 1.3) * 0.4) * hf;
      const vy = (Math.sin(t * 97.7 + 0.7) * 0.5 + Math.sin(t * 151.9) * 0.5) * hf * 0.6;
      const target = THREE.MathUtils.clamp((-vel.y - 2.5) / 4, 0, 1) * THREE.MathUtils.clamp(thrust * 1.6, 0, 1);
      wash += (target - wash) * Math.min(1, dt * 5);
      const pw = wash * amount * 1.4;
      const wp = (Math.sin(t * 23.0) * 0.6 + Math.sin(t * 37.0 + 2.0) * 0.4) * pw;
      const wr = (Math.sin(t * 19.0 + 1.0) * 0.6 + Math.sin(t * 31.0) * 0.4) * pw;
      e.set((vp + wp) * D2R, vy * D2R, wr * D2R, 'YXZ');
      camQuat.multiply(q.setFromEuler(e));
    },
  };
}
