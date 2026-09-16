// MuseSpark standalone game shell — Astra plant + Muse intelligence + engineer UI.
// Modes: DRIVE | AI HOTLAP | AI RACE | HUMAN VS AI | RACECRAFT LAB | REPLAY | ENGINEER.
import * as THREE from 'three';
import { Track } from '../sim/track.js';
import { MuseSession } from './session.js';
import '../style.css';

const params = new URLSearchParams(location.search);
const track = new Track('harbor-ring');
const session = new MuseSession(track, { mode: params.get('mode') === 'hotlap' ? 'practice' : 'race', laps: Number(params.get('laps') ?? 3), field: Number(params.get('field') ?? 6), fastLine: false });
session.autopilot = params.get('drive') !== '1';

const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#world'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0e1418');
scene.fog = new THREE.Fog('#0e1418', 120, 900);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
scene.add(new THREE.HemisphereLight('#cfe8ff', '#1a201c', 0.9));
const sun = new THREE.DirectionalLight('#fff2dd', 1.6);
sun.position.set(120, 180, 60); sun.castShadow = true;
sun.shadow.camera.left = -260; sun.shadow.camera.right = 260; sun.shadow.camera.top = 260; sun.shadow.camera.bottom = -260;
scene.add(sun);

// Track ribbon (asphalt + kerbs + grass plane).
function ribbon(track, left, right, y, color, steps = 720) {
  const pos = [], idx = [];
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * track.length;
    for (const side of [left, right]) { const p = track.at(s, side); pos.push(p.x, y, p.z); }
  }
  for (let i = 0; i < steps; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
}
scene.add(ribbon(track, -track.halfWidth, track.halfWidth, 0, '#33373a'));
scene.add(ribbon(track, -track.halfWidth - 1.25, -track.halfWidth, 0.01, '#b33a2e'));
scene.add(ribbon(track, track.halfWidth, track.halfWidth + 1.25, 0.01, '#b33a2e'));
const grass = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: '#1d2b1f', roughness: 1 }));
grass.rotation.x = -Math.PI / 2; grass.position.y = -0.08; grass.receiveShadow = true;
scene.add(grass);

// Global optimum line (white) + selected trajectory (cyan) + finalists (dim).
function lineMesh(color, opacity = 0.95) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 512), 3));
  const m = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  m.frustumCulled = false; scene.add(m); return m;
}
const globalMesh = lineMesh('#ffffff', 0.55);
const selectedMesh = lineMesh('#35e0ff', 1);
const altMeshes = [lineMesh('#3a6a75', 0.5), lineMesh('#3a6a75', 0.5), lineMesh('#3a6a75', 0.5)];
function drawPoly(mesh, pts) {
  const attr = mesh.geometry.getAttribute('position');
  const n = Math.min(512, pts.length);
  for (let i = 0; i < 512; i++) {
    const p = pts[(i / 512 * n) | 0] ?? pts[pts.length - 1];
    attr.setXYZ(i, p.x, 0.25, p.z);
  }
  attr.needsUpdate = true;
}
{
  const pts = [];
  for (let s = 0; s < track.length; s += track.length / 400) { const p = session.line.at(s); pts.push({ x: p.x, z: p.z }); }
  drawPoly(globalMesh, pts);
}

// Cars as low-poly GT boxes + wheels.
const carMeshes = session.cars.map((c) => {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.4), new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.4, metalness: 0.3 }));
  body.position.y = 0.55; body.castShadow = true; g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 2.0), new THREE.MeshStandardMaterial({ color: '#10151a', roughness: 0.2, metalness: 0.6 }));
  cab.position.set(0, 1.0, -0.2); g.add(cab);
  scene.add(g); return g;
});

// HUD + Race Engineer panel.
const app = document.querySelector('#app');
app.innerHTML = `
<div id="hud">
  <div id="title">MUSESPARK RACING <span id="mode"></span></div>
  <div id="timing"></div>
  <div id="inputs"></div>
  <div id="ctrls">
    <button data-a="drive">DRIVE</button><button data-a="hotlap">AI HOTLAP</button>
    <button data-a="race">AI RACE</button><button data-a="lab">RACECRAFT LAB</button>
    <button data-a="eng">ENGINEER</button><button data-a="cam">CAMERA</button>
  </div>
</div>
<div id="engineer" hidden></div>
<style>
#hud{position:fixed;top:10px;left:10px;color:#e8f1f2;font:12px/1.5 monospace;background:rgba(10,16,18,.72);padding:10px 12px;border:1px solid #2a3a3e;border-radius:8px;max-width:360px}
#title{font-weight:800;letter-spacing:1px;color:#ff5a36}
#ctrls button{margin:3px 3px 0 0;background:#182528;color:#cfe;border:1px solid #2e4448;border-radius:5px;padding:3px 8px;cursor:pointer}
#engineer{position:fixed;top:10px;right:10px;width:380px;max-height:92vh;overflow:auto;color:#d8ecec;font:11px/1.55 monospace;background:rgba(8,14,16,.85);padding:10px 12px;border:1px solid #2a3a3e;border-radius:8px;white-space:pre-wrap}
</style>`;
const timingEl = app.querySelector('#timing'), inputsEl = app.querySelector('#inputs'), engEl = app.querySelector('#engineer'), modeEl = app.querySelector('#mode');
let focus = 0, camMode = 0, showEng = true;
app.querySelectorAll('button').forEach((b) => b.onclick = () => {
  const a = b.dataset.a;
  if (a === 'drive') { session.autopilot = false; session.mode = 'race'; }
  if (a === 'hotlap') { session.mode = 'practice'; session.autopilot = true; session.laps = 3; session.start({}); }
  if (a === 'race') { session.mode = 'race'; session.autopilot = true; session.field = 6; session.start({}); }
  if (a === 'lab') { session.mode = 'race'; session.autopilot = true; session.field = 3; session.start({}); }
  if (a === 'eng') { showEng = !showEng; }
  if (a === 'cam') { camMode = (camMode + 1) % 3; }
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyC') camMode = (camMode + 1) % 3;
  if (e.code === 'KeyB') showEng = !showEng;
  if (e.code === 'Tab') { focus = (focus + 1) % session.activeCars.length; e.preventDefault(); }
});
session.start({});
// Keyboard drive.
const keys = {};
addEventListener('keydown', (e) => keys[e.code] = true);
addEventListener('keyup', (e) => keys[e.code] = false);

let last = performance.now(), acc = 0;
const fwd = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min((now - last) / 1000, 0.12); last = now;
  acc += raw;
  let steps = 0;
  while (acc >= 1 / 120 && steps < 16) {
    const pc = session.autopilot ? null : { throttle: keys.ArrowUp || keys.KeyW ? 1 : 0, brake: keys.ArrowDown || keys.KeyS ? 1 : 0, steer: ((keys.ArrowLeft || keys.KeyA ? -1 : 0) + (keys.ArrowRight || keys.KeyD ? 1 : 0)) * 0.9 };
    session.step(1 / 120, pc);
    acc -= 1 / 120; steps++;
  }
  const cars = session.activeCars;
  cars.forEach((c, i) => { carMeshes[i].visible = true; carMeshes[i].position.set(c.x, 0, c.z); carMeshes[i].rotation.y = c.yaw; });
  carMeshes.forEach((m, i) => { if (i >= cars.length) m.visible = false; });
  const foc = cars[Math.min(focus, cars.length - 1)] ?? session.player;
  // Cameras: 0 chase, 1 top tactical, 2 trackside.
  fwd.set(Math.sin(foc.yaw), 0, Math.cos(foc.yaw));
  if (camMode === 0) {
    camera.position.set(foc.x - fwd.x * (7.6 + foc.speed * 0.024), 2.65, foc.z - fwd.z * (7.6 + foc.speed * 0.024));
    camera.lookAt(foc.x + fwd.x * 8, 0.7, foc.z + fwd.z * 8);
  } else if (camMode === 1) {
    camera.position.set(foc.x - fwd.x * 27, 65, foc.z - fwd.z * 27);
    camera.lookAt(foc.x + fwd.x * 27, 0, foc.z + fwd.z * 27);
  } else {
    const p = track.at(foc.s + 25, 23);
    camera.position.set(p.x, 6, p.z); camera.lookAt(foc.x, 0.65, foc.z);
  }
  // Overlays follow focus driver.
  const drv = session.drivers[foc.id];
  if (drv?.debug?.winner) {
    drawPoly(selectedMesh, drv.debug.winner.points);
    (drv.debug.finalists ?? []).slice(1, 4).forEach((f, i) => altMeshes[i] && drawPoly(altMeshes[i], f.points));
  }
  timingEl.textContent = `${session.phase.toUpperCase()} t=${session.time.toFixed(1)}s lap=${foc.race.lap} best=${foc.race.bestLap?.toFixed(3) ?? '-'} pos=${session.standings().indexOf(foc) + 1}/${cars.length} theo=${session.theoreticalLap.toFixed(2)}s`;
  inputsEl.textContent = `spd=${(foc.speed * 3.6).toFixed(0)}km/h thr=${foc.controls.throttle.toFixed(2)} brk=${foc.controls.brake.toFixed(2)} src=${drv?.brakeSource ?? '-'} state=${drv?.state ?? '-'}`;
  if (showEng && drv) {
    const m = drv.debug.maneuver ?? {};
    const stratMs = drv.debug.strategyMs ?? 0, trajMs = drv.debug.trajMs ?? 0;
    engEl.hidden = false;
    engEl.textContent =
`MUSE RACE ENGINEER — ${foc.name}
STRATEGY ${m.type ?? '-'} / ${m.flank ?? '-'} commit ${(m.commit ?? 0).toFixed(1)}s
${drv.debug.explanation ?? ''}
TURN IN/OUT q=${foc.lateral.toFixed(2)}m tgt=${drv.plan?.winner ? drv.plan.winner.apexQ.toFixed(2) : '-'}
GLOBAL ${session.theoreticalLap.toFixed(2)}s | REALIZED ${foc.race.bestLap?.toFixed(2) ?? '-'}s | GAP ${foc.race.bestLap ? (foc.race.bestLap - session.theoreticalLap).toFixed(2) + 's' : '-'}
BRAKING src=${drv.brakeSource} start=${drv.controller.brakeEvent?.startS.toFixed(0) ?? '-'} rel=${drv.controller.brakeEvent?.releaseS.toFixed(0) ?? '-'} apex=${drv.controller.brakeEvent?.apexS.toFixed(0) ?? '-'}
PHYSICS lat=${(foc.ay / 9.81).toFixed(2)}g long=${(foc.ax / 9.81).toFixed(2)}g slip=${(Math.atan2(foc.v, Math.max(4, foc.u)) * 57.3).toFixed(1)}deg yaw=${(foc.yawRate).toFixed(2)}
PACE tgt=${drv.targetSpeed.toFixed(1)}m/s debt=${drv.strategy.blockedDebt.toFixed(2)}s
ATTACK tgt=${m.targetId ?? '-'} pass=${((m.passP ?? 0) * 100).toFixed(0)}% risk=${m.risk ?? '-'}
DEFENSE ${drv.strategy.defense.plan} vs ${drv.strategy.defense.threatId ?? '-'}
BELIEFS ${(() => { const b = drv.beliefs.map.get(m.targetId); return b ? Object.entries(b.posterior).map(([k, v]) => k.slice(0, 4) + ' ' + (v * 100).toFixed(0)).join(' ') : 'clear air'; })()}
COMPUTE strat=${stratMs.toFixed(2)}ms traj=${trajMs.toFixed(2)}ms mpc=${drv.controller.ms.toFixed(2)}ms p95=${drv.debug.ms?.p95?.toFixed(2) ?? '-'} detail=${drv.debug.ms?.detail} cand=${drv.debug.ms?.screened}/${drv.debug.ms?.finalists}
SAFETY ${drv.debug.safety?.reason} activations=${drv.safety.activations}`;
  } else engEl.hidden = true;
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
