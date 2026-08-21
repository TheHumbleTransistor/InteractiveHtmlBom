/* 3D board view.
 *
 * Glue only. three.js does the rendering, GLTFLoader the parsing and OrbitControls the
 * interaction; all three are vendored unmodified under web/three/.
 *
 * The whole feature rests on one property of KiCad's GLB export: every footprint becomes a
 * scene node NAMED FOR ITS REFERENCE DESIGNATOR. So a BOM row maps to geometry by name, with
 * no coordinate transform and no lookup table to keep in sync.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three-gltfloader';
import { OrbitControls } from 'three-orbitcontrols';

const HIGHLIGHT = 0xff3b30;
const HIGHLIGHT_INTENSITY = 0.6;
const FIT_MARGIN = 1.6;      // 1.0 = bounding sphere exactly fills the vertical FOV
// Never close in past this fraction of the whole board's radius. Without it a 0805 fills the
// screen and you lose all sense of WHERE on the board you are looking, which is most of the
// value of a 3D view next to a BOM.
const MIN_FIT_FRACTION = 0.30;

var scene, camera, renderer, controls, root;
var boardRadius = 0;
var nodesByRef = {};         // refdes -> Object3D
var savedMaterials = new Map();
var ready = false;
var pendingResize = false;

function boardFrame() {
  // KiCad exports GLB in METRES. Everything here works in model units, so nothing needs
  // converting -- but the number surprises you if you ever print a coordinate.
  const box = new THREE.Box3().setFromObject(root);
  return { box: box, center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

function frame(box, immediate) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, boardRadius * MIN_FIT_FRACTION);
  const dist = radius * FIT_MARGIN / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  if (dir.lengthSq() < 1e-9) dir.set(0.4, 1, 0.7).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.update();
  if (immediate) render();
}

function render() {
  if (ready) renderer.render(scene, camera);
}

function clearHighlight() {
  for (const [mesh, mat] of savedMaterials) mesh.material = mat;
  savedMaterials.clear();
}

/* Called from render.js drawHighlights(), so every selection path reaches it for free. */
function highlight3D(refs) {
  if (!ready) return;
  clearHighlight();
  const box = new THREE.Box3();
  var hit = 0;
  for (const ref of refs) {
    const node = nodesByRef[ref];
    if (!node) continue;               // no 3D model for this part -- legitimate, skip it
    hit++;
    node.traverse((o) => {
      if (!o.isMesh) return;
      savedMaterials.set(o, o.material);
      const m = o.material.clone();
      m.emissive = new THREE.Color(HIGHLIGHT);
      m.emissiveIntensity = HIGHLIGHT_INTENSITY;
      o.material = m;
    });
    box.expandByObject(node);
  }
  if (hit && !box.isEmpty()) frame(box);
  else if (!refs.length) frame(boardFrame().box);
  render();
  const note = document.getElementById("board3d-missing");
  if (note) {
    const missing = refs.length - hit;
    note.textContent = missing ? missing + " selected part(s) have no 3D model" : "";
  }
}

function resize3D() {
  const el = document.getElementById("canvas3d");
  if (!el || !renderer) return;
  if (!el.clientWidth || !el.clientHeight) { pendingResize = true; return; }
  pendingResize = false;
  renderer.setSize(el.clientWidth, el.clientHeight);
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
  render();
}

function init3D(glbDataUri) {
  const el = document.getElementById("canvas3d");
  if (!el || !glbDataUri) return;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  el.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(1, 2, 1.5);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7); fill.position.set(-1.2, -0.6, 0.5);
  scene.add(key, fill);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.addEventListener('change', render);

  new GLTFLoader().load(glbDataUri, (gltf) => {
    root = gltf.scene;
    scene.add(root);
    root.traverse((o) => { if (o.name && !(o.name in nodesByRef)) nodesByRef[o.name] = o; });

    const f = boardFrame();
    boardRadius = f.box.getBoundingSphere(new THREE.Sphere()).radius;
    // Look down at the board from the front, tilted, rather than dead-on.
    camera.position.set(f.center.x, f.center.y + f.size.length() * 0.5, f.center.z + f.size.length() * 0.5);
    controls.target.copy(f.center);
    ready = true;
    window.__ibom3dReady = true;
    resize3D();
    frame(f.box, true);
    (function loop() { requestAnimationFrame(loop); if (controls.update()) render(); })();
    if (typeof highlightedFootprints !== "undefined") drawHighlights();
  }, undefined, (e) => {
    el.innerHTML = '<div class="board3d-error">3D model failed to load: ' + e + '</div>';
  });
}

window.init3D = init3D;
window.highlight3D = highlight3D;
window.resize3D = resize3D;
window.has3D = true;
window.addEventListener('resize', () => { if (pendingResize) resize3D(); });
