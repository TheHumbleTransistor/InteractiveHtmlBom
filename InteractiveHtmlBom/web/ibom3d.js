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
// An unplaced part, shown only while its BOM row is selected. At 0.5 opacity with the full
// highlight emissive it rendered as a near-solid red block and read as a bug rather than a
// preview -- especially on a grouped row like U5/U6/U7/U9, where four appear at once. Keep it
// clearly see-through and let the shape, not the colour, carry the information.
const GHOST_OPACITY = 0.6;
const GHOST_EMISSIVE = 0.45;
// Follow the 2D view's own CSS variable rather than hardcoding, so the dot matches the canvas
// and tracks dark mode for free -- render.js reads the same property.
const PIN1_COLOR_VAR = '--pin1-outline-color';
const PIN1_COLOR_FALLBACK = 0xffb629;
const PIN1_RADIUS_MM = 0.55;
const FIT_MARGIN = 1.6;      // 1.0 = bounding sphere exactly fills the vertical FOV
// Never close in past this fraction of the whole board's radius. Without it a 0805 fills the
// screen and you lose all sense of WHERE on the board you are looking, which is most of the
// value of a 3D view next to a BOM.
const MIN_FIT_FRACTION = 0.30;
const FLAT_EPS = 1e-5;       // a face thinner than 10 um is a flat overlay, not a solid
// KiCad honours the stackup for silkscreen (this board declares white silk and exports #f5f5f5)
// but gives copper a flat #808080, which is nobody's idea of copper. The mask is recoloured too:
// a green board is what reads as "a PCB" on screen, whatever the stackup says the real one is.
// Set MASK_COLOR to null to keep the exported colour instead.
const MASK_COLOR = 0x1d7a44;
const MASK_OPACITY = 0.8;    // translucent, so the copper underneath reads through
const COPPER_COLOR = 0xe8c98a;
// KiCad exports copper as metalness 1 / roughness 0.4. A fully metallic surface has NO diffuse
// term, so with no environment map to reflect it is black except where a light happens to catch
// it -- gold from straight above, near-black from an angle. Drop it to a matte dielectric so the
// colour is the colour, whatever the view.
const COPPER_METALNESS = 0.0;
const COPPER_ROUGHNESS = 0.7;

var scene, camera, renderer, controls, root;
var nodesByRef = {};         // refdes -> [Object3D]; a refdes can own more than one node
var savedState = new Map();  // mesh -> {material, visible} while highlighted
var ready = false;
var pendingResize = false;
var boardRadius = 0;
var boardTopY = 0, boardBottomY = 0;
var pin1Group = null;
var xform = null;            // solved board-mm -> model-units mapping, see solveTransform()
var placedOnly = false;
var lastRefs = [];

function nodesFor(ref) {
  return nodesByRef[ref] || [];
}

/* Map refdes -> nodes.
 *
 * Driven from pcbdata's reference list rather than from every named node in the scene, because
 * the GLB also names internal nodes (`=>[0:1:1:7]`, `NAUO3`, `3DMODEL_...`) that would otherwise
 * pollute the map. And a refdes can own MORE THAN ONE node: glTF names must be unique, so KiCad
 * suffixes duplicates, and this board's fuse holder appears as both `F1` and `F1_1`. Taking only
 * the first left half of it un-highlighted, and put the rest outside the footprint set -- which
 * in turn blew the artwork band out from 1.5 mm to 17.7 mm.
 */
function indexNodes(root) {
  const refs = new Set(pcbdata.footprints.map(f => f.ref));
  root.traverse((o) => {
    if (!o.name) return;
    var ref = null;
    if (refs.has(o.name)) ref = o.name;
    else {
      const m = /^(.*)_\d+$/.exec(o.name);
      if (m && refs.has(m[1])) ref = m[1];
    }
    if (!ref) return;
    (nodesByRef[ref] = nodesByRef[ref] || []).push(o);
  });
}

const PLANE_KEY = (y) => Math.round(y * 1e6);

function meshPlaneY(mesh) {
  if (!mesh.geometry) return null;
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  return (bb.max.y - bb.min.y < FLAT_EPS) ? bb.max.y : null;
}

/* Locate the two board faces.
 *
 * NOT by looking for a substrate solid -- KiCad exports the board as flat faces too, so this
 * board yields four full-size planes (-0.05, 0, 1.46, 1.51 mm) of identical area and picking
 * "the largest" returns whichever came first, once reporting a top BELOW the bottom. Take every
 * plane that spans essentially the whole board and use the extremes.
 */
function findBoardFaces(root) {
  const planes = [];
  var maxArea = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const area = (bb.max.x - bb.min.x) * (bb.max.z - bb.min.z);
    planes.push({ area: area, min: bb.min.y, max: bb.max.y });
    if (area > maxArea) maxArea = area;
  });
  var lo = Infinity, hi = -Infinity;
  for (const pl of planes) {
    if (pl.area < maxArea * 0.9) continue;
    lo = Math.min(lo, pl.min);
    hi = Math.max(hi, pl.max);
  }
  if (lo <= hi) { boardBottomY = lo; boardTopY = hi; }
}

/* What counts as board artwork -- measured, not assumed.
 *
 * Everything under a footprint node is COMPONENT geometry; copper, soldermask, silkscreen and
 * the substrate are all board-level. Counted on this board:
 *
 *     plane (mm)   under footprints   board-level
 *     1.545               371              0        component bottom faces
 *     1.535                 0           1153        silkscreen
 *     1.510                 0              1        soldermask
 *     1.500                 0            582        copper pads
 *     1.460                 0            500        substrate
 *
 * That single table removes a whole class of bug. Earlier versions tried to split each footprint
 * into "artwork" and "body" by height, on the belief that pads were children of the footprint
 * node. They are not. Every height-based rule tried instead caught component geometry -- a
 * +/-0.2 mm window took TSSOP leads at 1.58-1.70 mm, and "a plane shared by most footprints"
 * took the 1.545 mm bottom faces, which is true of every SMD's underside. Hiding a part left a
 * flat cross-section of it welded to the board.
 *
 * So: hide the whole footprint node. Pads and silkscreen survive because they were never inside
 * it.
 */
var footprintMeshes = new Set();

function indexFootprintMeshes() {
  footprintMeshes.clear();
  for (const ref in nodesByRef) {
    for (const node of nodesByRef[ref]) {
      node.traverse((o) => { if (o.isMesh) footprintMeshes.add(o); });
    }
  }
}

function isArtwork(mesh) {
  return !footprintMeshes.has(mesh) && meshPlaneY(mesh) !== null;
}

/* Tint the soldermask and copper so they are distinguishable.
 *
 * Identify them by AREA, not by mesh count or height rank. Measured on this board:
 *
 *     y (mm)   meshes   largest mesh        what it is
 *     1.535      1153   small               silkscreen glyphs
 *     1.510         1   0.0119 m2 = board   soldermask, ONE mesh with holes at the pads
 *     1.500       582   small               copper pads
 *     1.460       500   0.0119 m2 = board   substrate
 *
 * Ranking planes from the top put the green on the silkscreen text, and a "more than 20 meshes"
 * filter threw the soldermask away entirely -- it is a single mesh. So: the front full-board
 * planes are the substrate and the mask, lowest and highest of them respectively, and copper is
 * the busiest plane between the two.
 */
function tintBoardLayers(root) {
  const mid = (boardTopY + boardBottomY) / 2;
  var maxArea = 0;
  const flats = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const y = meshPlaneY(o);
    if (y === null || y < mid) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const area = (bb.max.x - bb.min.x) * (bb.max.z - bb.min.z);
    if (area > maxArea) maxArea = area;
    flats.push({ mesh: o, k: PLANE_KEY(y), area: area });
  });
  if (!flats.length) return null;

  const fullBoard = [...new Set(flats.filter(f => f.area > maxArea * 0.9).map(f => f.k))]
    .sort((x, y) => x - y);
  if (fullBoard.length < 2) return null;
  const substrate = fullBoard[0];
  const mask = fullBoard[fullBoard.length - 1];

  const counts = new Map();
  for (const f of flats) {
    if (f.k <= substrate || f.k >= mask) continue;
    counts.set(f.k, (counts.get(f.k) || 0) + 1);
  }
  var copper = null;
  for (const [k, n] of counts) {
    if (copper === null || n > counts.get(copper)) copper = k;
  }

  const tint = new Map([[mask, MASK_COLOR]]);
  if (copper !== null) tint.set(copper, COPPER_COLOR);
  const cache = new Map();
  for (const f of flats) {
    if (!tint.has(f.k)) continue;
    const col = tint.get(f.k);
    const key = f.mesh.material.uuid + ':' + col;
    var mat = cache.get(key);
    if (!mat) {
      mat = f.mesh.material.clone();
      if (col !== null) mat.color = new THREE.Color(col);
      if (f.k === copper && mat.metalness !== undefined) {
        mat.metalness = COPPER_METALNESS;
        mat.roughness = COPPER_ROUGHNESS;
      }
      if (f.k === mask) {
        // depthWrite stays ON: the mask must still occlude anything genuinely behind it, and
        // three.js draws transparent materials after the opaque pass, so copper and substrate
        // are already in the buffer to blend against.
        mat.transparent = true;
        mat.opacity = MASK_OPACITY;
      }
      cache.set(key, mat);
    }
    f.mesh.material = mat;
  }
  return { mask: mask / 1000, copper: copper === null ? NaN : copper / 1000 };
}

/* A gentle depth bias for board artwork.
 *
 * NOTE the real cure for the stippling was the depth RANGE, not this -- see setDepthRange().
 * The layers are 1.460 / 1.500 / 1.535 / 1.545 mm here, so nothing is coplanar; the old far/near
 * ratio of 10000 simply could not resolve the 10 um silk-to-mask gap. This stays as a cheap
 * guard for boards where faces genuinely do coincide, and is deliberately a flat -1 rather than
 * a ranked value, because large offsets make artwork bleed through component edges at grazing
 * angles.
 */
function biasArtwork(root) {
  const cache = new Map();
  var n = 0;
  root.traverse((o) => {
    if (!o.isMesh || !isArtwork(o)) return;
    n++;
    var mat = cache.get(o.material.uuid);
    if (!mat) {
      mat = o.material.clone();
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
      cache.set(o.material.uuid, mat);
    }
    o.material = mat;
  });
  return n;
}

function boardFrame() {
  // KiCad exports GLB in METRES. Everything here works in model units, so nothing needs
  // converting -- but the number surprises you if you ever print a coordinate.
  const box = new THREE.Box3().setFromObject(root);
  return { box: box, center: box.getCenter(new THREE.Vector3()),
           size: box.getSize(new THREE.Vector3()) };
}

/* Solve the board(mm) -> model mapping instead of assuming one.
 *
 * Measured on KiCad 10 it is the identity: board x,y in mm maps to model x,z in metres, no
 * offset and no sign flip. Solving it anyway costs ~15 lines and means a future KiCad that
 * changes the convention degrades to "no pin-1 dots" instead of dots in the wrong place.
 *
 * Judge the fit on the MEDIAN residual, not the worst. A footprint whose 3D model carries its
 * own `(offset ...)` -- J5 is 7 mm out on this project's board -- is a legitimate outlier, so a
 * worst-case test rejects a perfectly good transform.
 */
function solveTransform() {
  const samples = [];
  for (const fp of pcbdata.footprints) {
    const nodes = nodesFor(fp.ref);
    if (!nodes.length || !fp.bbox || !fp.bbox.pos) continue;
    samples.push({ mm: fp.bbox.pos, m: nodes[0].getWorldPosition(new THREE.Vector3()) });
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
  // Drop the highlight first: savedState records visibility as it was when the highlight was
  // applied, so changing visibility underneath it would be reverted on the next clear.
  const active = lastRefs;
  clearHighlight();
  for (const fp of pcbdata.footprints) {
    const show = !placedOnly || isPlaced(fp.ref);
    // Hide the whole node. Pads and silkscreen are board-level, so they stay put.
    for (const node of nodesFor(fp.ref)) node.visible = show;
  }
  if (active && active.length) highlight3D(active);
  else { updatePin1(lastRefs); render(); }
}

function setPlacedOnly(on) {
  placedOnly = !!on;
  applyPlacedFilter();
}

/* Pin-1 dots, honouring iBOM's existing highlight_pin1 setting -- no new control. */
function updatePin1(refs) {
  if (!pin1Group) return;
  pin1Group.clear();
  const mode = settings.highlightpin1;
  if (!xform || mode == "none") return;
  const wanted = (mode == "all") ? null : new Set(refs || []);
  const r = PIN1_RADIUS_MM * 0.001;
  const geom = new THREE.SphereGeometry(r, 12, 8);
  const css = getComputedStyle(document.documentElement)
    .getPropertyValue(PIN1_COLOR_VAR).trim();
  const mat = new THREE.MeshBasicMaterial(
    { color: css ? new THREE.Color(css) : new THREE.Color(PIN1_COLOR_FALLBACK) });
  for (const fp of pcbdata.footprints) {
    if (wanted && !wanted.has(fp.ref)) continue;
    // Deliberately NOT skipped when the placed filter hides the part: the dot marks the LAND
    // PATTERN, which is still on screen, and an unfitted part is exactly when you need to know
    // which end pin 1 is.
    // Sit the dot on the BOARD FACE, not on the footprint node's origin. The origin is skewed
    // by any z offset the 3D model carries -- J5's is 3.85 mm, which left its dot hovering in
    // mid-air -- and the dot belongs on the land pattern anyway, where it stays visible once the
    // part itself is hidden.
    const y = (fp.layer === 'B') ? boardBottomY : boardTopY;
    for (const pad of (fp.pads || [])) {
      if (!pad.pin1) continue;
      const dot = new THREE.Mesh(geom, mat);
      dot.position.copy(toModel(pad.pos, y + (fp.layer === 'B' ? -r : r)));
      pin1Group.add(dot);
    }
  }
}

/* Keep the depth range tight around what is actually on screen.
 *
 * Copper, soldermask and silkscreen sit within ~20 um of each other and of the board. A
 * perspective depth buffer concentrates precision near the near plane, so a far/near ratio of
 * 10000 (the old dist/1000 .. dist*10) left 17.9 um per depth step out at the board -- not
 * enough to resolve a 10 um gap, so it stippled. At dist*0.02 .. dist*4 it is 0.89 um.
 * Recomputed on every render because OrbitControls changes the distance without going through
 * frame().
 */
function setDepthRange(dist) {
  const near = Math.max(dist * 0.02, 1e-5);
  const far = dist * 4 + boardRadius * 4;
  if (camera.near !== near || camera.far !== far) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function frame(box, immediate) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, boardRadius * MIN_FIT_FRACTION);
  const dist = radius * FIT_MARGIN / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  if (dir.lengthSq() < 1e-9) dir.set(0.4, 1, 0.7).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  setDepthRange(dist);
  controls.update();
  if (immediate) render();
}

function render() {
  if (!ready) return;
  setDepthRange(camera.position.distanceTo(controls.target));
  renderer.render(scene, camera);
}

function clearHighlight() {
  for (const [obj, prev] of savedState) {
    if (prev.material) obj.material = prev.material;
    obj.visible = prev.visible;
  }
  savedState.clear();
}

/* Called from render.js drawHighlights(), so every selection path reaches it for free. */
function highlight3D(refs) {
  if (!ready) return;
  lastRefs = refs;
  clearHighlight();
  const box = new THREE.Box3();
  var hit = 0;
  for (const ref of refs) {
    const nodes = nodesFor(ref);
    if (!nodes.length) continue;       // no 3D model for this part -- legitimate, skip it
    hit++;
    // If the placed filter is hiding this part, show it as a translucent ghost for as long as
    // it stays selected: an assembler needs to see the shape of the thing they are about to
    // fit, and where it goes, before they can tick it off.
    const ghost = placedOnly && !isPlaced(ref);
    for (const node of nodes) {
      savedState.set(node, { material: null, visible: node.visible });
      if (ghost) node.visible = true;
      node.traverse((o) => {
        if (!o.isMesh) return;
        savedState.set(o, { material: o.material, visible: o.visible });
        const m = o.material.clone();
        m.emissive = new THREE.Color(HIGHLIGHT);
        m.emissiveIntensity = HIGHLIGHT_INTENSITY;
        if (ghost) {
          m.transparent = true;
          m.opacity = GHOST_OPACITY;
          m.depthWrite = false;
          m.emissiveIntensity = GHOST_EMISSIVE;
        }
        o.material = m;
      });
      box.expandByObject(node);
    }
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
  // needs a per-frame update(), so without it the 'change' event alone drives rendering and the
  // page runs no animation loop at all.
  controls.enableDamping = false;
  controls.addEventListener('change', render);

  new GLTFLoader().load(glbDataUri, (gltf) => {
    root = gltf.scene;
    scene.add(root);
    root.updateWorldMatrix(true, true);

    indexNodes(root);
    findBoardFaces(root);
    indexFootprintMeshes();
    const tinted = tintBoardLayers(root);
    const biased = biasArtwork(root);
    console.log('ibom3d: board ' + (boardBottomY * 1000).toFixed(3) + ' .. '
      + (boardTopY * 1000).toFixed(3) + ' mm, ' + biased + ' artwork faces, '
      + footprintMeshes.size + ' component meshes'
      + (tinted ? ', tinted mask@' + tinted.mask.toFixed(3)
                + ' copper@' + tinted.copper.toFixed(3) : ', not tinted'));

    xform = solveTransform();
    if (xform) {
      console.log('ibom3d: board->model fit from ' + xform.n + ' footprints, median residual '
        + (xform.med * 1000).toFixed(3) + ' mm, ' + xform.outliers + ' outliers');
      pin1Group = new THREE.Group();
      scene.add(pin1Group);
    } else {
      console.warn('ibom3d: could not fit board->model transform; pin 1 markers disabled');
    }

    const f = boardFrame();
    boardRadius = f.box.getBoundingSphere(new THREE.Sphere()).radius;
    camera.position.set(f.center.x, f.center.y + f.size.length() * 0.5,
                        f.center.z + f.size.length() * 0.5);
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
window.updatePin1 = () => { updatePin1(lastRefs); render(); };
window.has3D = true;
window.addEventListener('resize', () => { if (pendingResize) resize3D(); });
