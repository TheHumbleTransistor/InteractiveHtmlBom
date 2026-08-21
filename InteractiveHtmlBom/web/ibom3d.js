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
const PIN1_COLOR = 0x2f7bff;
const PIN1_RADIUS_MM = 0.55;

var scene, camera, renderer, controls, root;
var boardRadius = 0;
var pin1Group = null;
var xform = null;            // solved board-mm -> model-units mapping, see solveTransform()
var placedOnly = false;
var lastRefs = [];
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

/* Solve the board(mm) -> model mapping instead of assuming one.
 *
 * Measured on KiCad 10 it is the identity: board x,y in mm maps to model x,z in metres, no
 * offset and no sign flip. Solving it anyway costs ~15 lines and means a future KiCad that
 * changes the convention degrades to "no pin-1 dots" instead of putting dots in the wrong place.
 *
 * Judge the fit on the MEDIAN residual, not the worst. A footprint whose 3D model carries its
 * own `(offset ...)` -- J5 is 7 mm out on this project's board -- is a legitimate outlier, so
 * a worst-case test rejects a perfectly good transform.
 */
function solveTransform() {
  const samples = [];
  for (const fp of pcbdata.footprints) {
    const node = nodesByRef[fp.ref];
    if (!node || !fp.bbox || !fp.bbox.pos) continue;
    samples.push({ mm: fp.bbox.pos, m: node.getWorldPosition(new THREE.Vector3()) });
  }
  if (samples.length < 8) return null;
  const median = (a) => { const v = a.slice().sort((x, y) => x - y); return v[v.length >> 1]; };
  var best = null;
  for (const zsign of [1, -1]) {
    const ox = median(samples.map(s => s.m.x - s.mm[0] * 0.001));
    const oz = median(samples.map(s => s.m.z - zsign * s.mm[1] * 0.001));
    const res = samples.map(s => Math.hypot(
      s.m.x - (s.mm[0] * 0.001 + ox), s.m.z - (zsign * s.mm[1] * 0.001 + oz)));
    const med = median(res);
    if (!best || med < best.med) {
      best = { zsign: zsign, ox: ox, oz: oz, med: med, n: samples.length,
               outliers: res.filter(r => r > 0.001).length };
    }
  }
  return best.med < 0.0005 ? best : null;    // 0.5 mm median over the whole board
}

function toModel(mm, y) {
  return new THREE.Vector3(mm[0] * 0.001 + xform.ox, y, xform.zsign * mm[1] * 0.001 + xform.oz);
}

/* Pin-1 dots, honouring iBOM's existing highlight_pin1 setting -- no new control. */
function updatePin1(refs) {
  if (!pin1Group) return;
  pin1Group.clear();
  const mode = settings.highlightpin1;
  if (!xform || mode == "none") { render(); return; }
  const wanted = (mode == "all") ? null : new Set(refs);
  const r = PIN1_RADIUS_MM * 0.001;
  const geom = new THREE.SphereGeometry(r, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color: PIN1_COLOR });
  for (const fp of pcbdata.footprints) {
    if (wanted && !wanted.has(fp.ref)) continue;
    if (placedOnly && !isPlaced(fp.ref)) continue;
    const node = nodesByRef[fp.ref];
    // Sit the dot on the board face this footprint is on. Taking the node's own height rather
    // than one global value keeps back-side parts correct without a special case.
    const y = node ? node.getWorldPosition(new THREE.Vector3()).y : 0;
    for (const pad of (fp.pads || [])) {
      if (!pad.pin1) continue;
      const dot = new THREE.Mesh(geom, mat);
      dot.position.copy(toModel(pad.pos, y + (fp.layer === 'B' ? -r : r)));
      pin1Group.add(dot);
    }
  }
  render();
}

/* "Only show placed parts": ride iBOM's own checkbox bookkeeping. */
function isPlaced(ref) {
  const name = settings.markWhenChecked || "Placed";
  const stored = settings.checkboxStoredRefs[name];
  if (!stored) return false;
  if (!isPlaced._cache || isPlaced._for !== stored) {
    isPlaced._for = stored;
    isPlaced._cache = new Set(stored.split(",")
      .map(i => (pcbdata.footprints[parseInt(i, 10)] || {}).ref).filter(Boolean));
  }
  return isPlaced._cache.has(ref);
}

function applyPlacedFilter() {
  if (!ready) return;
  for (const fp of pcbdata.footprints) {
    const node = nodesByRef[fp.ref];
    if (node) node.visible = !placedOnly || isPlaced(fp.ref);
  }
  updatePin1(lastRefs);
  render();
}

function setPlacedOnly(on) {
  placedOnly = !!on;
  applyPlacedFilter();
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
  lastRefs = refs;
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
  updatePin1(refs);
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
  // No damping: the board stops the instant you let go. Damping is also the only thing that
  // needs a per-frame update(), so without it the 'change' event alone drives rendering and
  // the page runs no animation loop at all.
  controls.enableDamping = false;
  controls.addEventListener('change', render);

  new GLTFLoader().load(glbDataUri, (gltf) => {
    root = gltf.scene;
    scene.add(root);
    root.traverse((o) => { if (o.name && !(o.name in nodesByRef)) nodesByRef[o.name] = o; });

    xform = solveTransform();
    if (xform) {
      console.log('ibom3d: board->model fit from %d footprints, median residual %.3f mm, %d outliers',
                  xform.n, xform.med * 1000, xform.outliers);
      pin1Group = new THREE.Group();
      scene.add(pin1Group);
    } else {
      console.warn('ibom3d: could not fit board->model transform; pin 1 markers disabled');
    }
    const f = boardFrame();
    boardRadius = f.box.getBoundingSphere(new THREE.Sphere()).radius;
    // Look down at the board from the front, tilted, rather than dead-on.
    camera.position.set(f.center.x, f.center.y + f.size.length() * 0.5, f.center.z + f.size.length() * 0.5);
    controls.target.copy(f.center);
    ready = true;
    window.__ibom3dReady = true;
    resize3D();
    frame(f.box, true);
    applyPlacedFilter();
    if (typeof EventHandler !== "undefined") {
      // iBOM's own extension point, so nothing in their checkbox code needs patching.
      EventHandler.registerCallback(IBOM_EVENT_TYPES.CHECKBOX_CHANGE_EVENT, applyPlacedFilter);
    }
    if (typeof highlightedFootprints !== "undefined") drawHighlights();
  }, undefined, (e) => {
    el.innerHTML = '<div class="board3d-error">3D model failed to load: ' + e + '</div>';
  });
}

window.__ibom3d = { get camera() { return camera; }, get controls() { return controls; },
                    get scene() { return scene; }, get nodes() { return nodesByRef; },
                    get xform() { return xform; } };
window.init3D = init3D;
window.highlight3D = highlight3D;
window.resize3D = resize3D;
window.setPlacedOnly = setPlacedOnly;
window.updatePin1 = () => updatePin1(lastRefs);
window.has3D = true;
window.addEventListener('resize', () => { if (pendingResize) resize3D(); });
