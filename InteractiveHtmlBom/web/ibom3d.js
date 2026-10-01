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
import { RoomEnvironment } from 'three-roomenv';

const HIGHLIGHT = 0xff00ff;
const HIGHLIGHT_INTENSITY = 0.6;
// An unplaced part, shown only while its BOM row is selected. At 0.5 opacity with the full
// highlight emissive it rendered as a near-solid red block and read as a bug rather than a
// preview -- especially on a grouped row like U5/U6/U7/U9, where four appear at once. Keep it
// clearly see-through and let the shape, not the colour, carry the information.
// Follow the 2D view's own CSS variable rather than hardcoding, so the dot matches the canvas
// and tracks dark mode for free -- render.js reads the same property.
const PIN1_COLOR_VAR = '--pin1-outline-color';
const PIN1_COLOR_FALLBACK = 0xffb629;
const PIN1_RADIUS_MM = 0.55;
const DNP_COLOR = 0xe00000;
const DNP_TINT = 0.75;       // how far a populated DNP part's colours are pulled toward DNP_COLOR
const DNP_LIFT_MM = 0.05;    // clears the silkscreen, which sits ~25 um above the mask
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
// KiCad exports EVERY component material as metalness 1 -- all 7608 meshes on this board. A full
// metal has no diffuse response, so with only lights and no environment to reflect it can only
// render dark: a pure-white connector housing measured RGB ~120, i.e. grey. Image-based lighting
// gives those metals something to reflect, which is the actual fix; raising light intensities
// would not have helped, since a metal barely responds to a light at all.
const ENV_INTENSITY = 0.62;
const KEY_INTENSITY = 0.7;   // one soft directional, kept purely so shapes still read
// "Dim board on select". Implemented by turning the LIGHTS down rather than by recolouring
// materials: the highlight is emissive, and emissive is added independently of scene lighting, so
// the selected parts keep glowing while everything else goes dark. Two lines, against cloning and
// restoring ~36 materials across 7608 meshes.
// The slider runs 0..100; DIM_FLOOR is the light scale at 100 %, and 0 % leaves the scene alone.
const DIM_FLOOR = 0.10;
// The selected part's diffuse darkens with everything else, so without this it reads as a muddy
// dark part with a red tinge instead of a clean red one.
const HIGHLIGHT_EMISSIVE_DIM = 1.1;
// Tone mapping matters here, and NOT for the usual cinematic reasons. Without it, values above
// 1.0 simply clip: a white part rendered a flat 255 across its whole face and lost all shape.
// Khronos PBR Neutral rolls the highlights off while holding colours where they are -- it exists
// for product visualisation, which is exactly this. ACES would work too but shifts hue.
const TONE_EXPOSURE = 0.75;
const MASK_COLOR = 0x11512c;
const MASK_OPACITY = 0.8;    // translucent, so the copper underneath reads through
const COPPER_COLOR = 0xc4913c;   // retuned darker/warmer once IBL raised the overall exposure
// KiCad exports copper as metalness 1 / roughness 0.4. A fully metallic surface has NO diffuse
// term, so with no environment map to reflect it is black except where a light happens to catch
// it -- gold from straight above, near-black from an angle. Drop it to a matte dielectric so the
// colour is the colour, whatever the view.
const COPPER_METALNESS = 0.0;
const COPPER_ROUGHNESS = 0.7;

var scene, camera, renderer, controls, root, keyLight;
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

/* "3D zoom on select", 0..100. Read straight off `settings` on every use rather than mirrored
 * into a module variable: initDefaults() restores it at window.onload while the GLB loads
 * asynchronously, so a cached copy is a race. This module already reads highlightpin1,
 * markWhenChecked and checkboxStoredRefs the same way. */
function zoomFraction() {
  if (typeof settings !== "undefined" && settings.zoom3d !== undefined) {
    return settings.zoom3d / 100;
  }
  return 0;                  // matches the default in util.js; only reached if settings is absent
}

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
var silkMeshes = [];       // board-level flat faces beyond the mask, i.e. silkscreen
var maskMeshes = new Set();

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
/* Pick out the substrate / mask / copper planes on ONE side of the board.
 *
 * The full-board planes are the substrate face and the mask; copper is the busiest plane between
 * them. The only thing that differs per side is which of the two full-board planes is the mask:
 * it is the OUTERMOST one, so the highest at the front and the lowest at the back.
 */
function identifySide(flats, maxArea, front) {
  const fullBoard = [...new Set(flats.filter(f => f.area > maxArea * 0.9).map(f => f.k))]
    .sort((x, y) => x - y);
  if (fullBoard.length < 2) return null;
  const mask = front ? fullBoard[fullBoard.length - 1] : fullBoard[0];
  const substrate = front ? fullBoard[0] : fullBoard[fullBoard.length - 1];
  const lo = Math.min(mask, substrate), hi = Math.max(mask, substrate);
  const counts = new Map();
  for (const f of flats) {
    if (f.k <= lo || f.k >= hi) continue;
    counts.set(f.k, (counts.get(f.k) || 0) + 1);
  }
  var copper = null;
  for (const [k, n] of counts) {
    if (copper === null || n > counts.get(copper)) copper = k;
  }
  return { substrate: substrate, mask: mask, copper: copper };
}

/* Tint the soldermask and copper so they are distinguishable, on BOTH faces.
 *
 * Identify them by AREA, not by mesh count or height rank. Measured on this board:
 *
 *     y (mm)   meshes   largest mesh        what it is
 *      1.510        1   0.0119 m2 = board   top soldermask, ONE mesh with holes at the pads
 *      1.500      582   small               top copper
 *      1.460      500   0.0119 m2 = board   substrate, top face
 *      0.000       84   0.0119 m2 = board   substrate, bottom face
 *     -0.040      166   small               bottom copper
 *     -0.050        1   0.0119 m2 = board   bottom soldermask
 *
 * Ranking planes from the top put the green on the silkscreen text, and a "more than 20 meshes"
 * filter threw the soldermask away entirely -- it is a single mesh. The back was simply skipped
 * for a while, which left the bottom mask and copper in KiCad's greys and reading as absent.
 */
function tintBoardLayers(root) {
  const mid = (boardTopY + boardBottomY) / 2;
  var maxArea = 0;
  const flats = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const y = meshPlaneY(o);
    if (y === null) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const area = (bb.max.x - bb.min.x) * (bb.max.z - bb.min.z);
    if (area > maxArea) maxArea = area;
    flats.push({ mesh: o, k: PLANE_KEY(y), y: y, area: area });
  });
  if (!flats.length) return null;

  const sides = {
    front: identifySide(flats.filter(f => f.y >= mid), maxArea, true),
    back: identifySide(flats.filter(f => f.y < mid), maxArea, false),
  };
  const masks = new Set(), coppers = new Set();
  for (const name in sides) {
    const s = sides[name];
    if (!s) continue;
    masks.add(s.mask);
    if (s.copper !== null) coppers.add(s.copper);
  }
  if (!masks.size) return null;

  /* Silkscreen is the BOARD-LEVEL flat face beyond the mask on either side.
   *
   * The board-level test is load-bearing, not cosmetic: "beyond the front mask" on its own means
   * y > 1.510 mm, which is every component on the board. Excluding footprintMeshes is what makes
   * this the silkscreen rather than the whole assembly. */
  silkMeshes = [];
  for (const f of flats) {
    if (footprintMeshes.has(f.mesh)) continue;
    const beyondFront = sides.front && f.k > sides.front.mask;
    const beyondBack = sides.back && f.k < sides.back.mask;
    if (beyondFront || beyondBack) silkMeshes.push(f.mesh);
  }

  const cache = new Map();
  for (const f of flats) {
    const isMask = masks.has(f.k), isCopper = coppers.has(f.k);
    if (isMask) maskMeshes.add(f.mesh);
    if (!isMask && !isCopper) continue;
    const col = isMask ? MASK_COLOR : COPPER_COLOR;
    const key = f.mesh.material.uuid + ':' + col;
    var mat = cache.get(key);
    if (!mat) {
      mat = f.mesh.material.clone();
      if (col !== null) mat.color = new THREE.Color(col);
      if (isCopper && mat.metalness !== undefined) {
        mat.metalness = COPPER_METALNESS;
        mat.roughness = COPPER_ROUGHNESS;
      }
      if (isMask) {
        // KiCad exports the mask as a blended material, which GLTFLoader loads with depthWrite off.
        mat.transparent = true;
        mat.opacity = MASK_OPACITY;
        mat.depthWrite = true;
      }
      cache.set(key, mat);
    }
    f.mesh.material = mat;
  }
  const mm = (k) => (k === null || k === undefined) ? 'none' : (k / 1000).toFixed(3);
  return sides.front || sides.back
    ? { front: sides.front, back: sides.back, mm: mm }
    : null;
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
/* Make every board-level material except the mask opaque.
 *
 * KiCad exports any layer colour with alpha < 1 (silkscreen with no stackup colour is 0.9, the
 * substrate 0.98) as a blended material that writes no depth, so it neither hides what is behind
 * it nor sorts stably: the far side's silkscreen shows through and text flickers on rotation. */
function solidifyBoard(root) {
  const cache = new Map();
  var n = 0;
  root.traverse((o) => {
    if (!o.isMesh || footprintMeshes.has(o) || maskMeshes.has(o) || !o.material.transparent) return;
    n++;
    var mat = cache.get(o.material.uuid);
    if (!mat) {
      mat = o.material.clone();
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      cache.set(o.material.uuid, mat);
    }
    o.material = mat;
  });
  return n;
}

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

/* The existing Silkscreen checkbox governs the 3D view as well as the 2D canvas.
 *
 * `settings` is read on every call rather than cached: initDefaults() restores the setting at
 * window.onload while the GLB loads asynchronously, so a cached copy is a race -- the same reason
 * zoomFraction() and dimFraction() read it lazily. */
function applySilkscreen() {
  const show = (typeof settings === "undefined") || settings.renderSilkscreen !== false;
  for (const m of silkMeshes) m.visible = show;
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

var dnpRefs = null;
function isDnp(ref) {
  if (!dnpRefs) {
    dnpRefs = new Set((pcbdata.bom.dnp || []).map(i => pcbdata.footprints[i].ref));
  }
  return dnpRefs.has(ref);
}

var dnpTinted = new Map();   // mesh -> original material, for DNP parts marked placed
var dnpTintCache = new Map();

function setDnpTint(node, on) {
  node.traverse((o) => {
    if (!o.isMesh) return;
    if (on && !dnpTinted.has(o)) {
      dnpTinted.set(o, o.material);
      var mat = dnpTintCache.get(o.material.uuid);
      if (!mat) {
        mat = o.material.clone();
        mat.color.lerp(new THREE.Color(DNP_COLOR), DNP_TINT);
        dnpTintCache.set(o.material.uuid, mat);
      }
      o.material = mat;
    } else if (!on && dnpTinted.has(o)) {
      o.material = dnpTinted.get(o);
      dnpTinted.delete(o);
    }
  });
}

function applyPlacedFilter() {
  if (!ready) return;
  // Drop the highlight first: savedState records visibility as it was when the highlight was
  // applied, so changing visibility underneath it would be reverted on the next clear.
  const active = lastRefs;
  clearHighlight();
  for (const fp of pcbdata.footprints) {
    const dnp = isDnp(fp.ref), placed = isPlaced(fp.ref);
    const show = dnp ? placed : (!placedOnly || placed);
    // Hide the whole node. Pads and silkscreen are board-level, so they stay put.
    for (const node of nodesFor(fp.ref)) {
      node.visible = show;
      if (dnp) setDnpTint(node, placed);
    }
  }
  if (active && active.length) highlight3D(active);
  else { updatePin1(lastRefs); render(); }
}

function setPlacedOnly(on) {
  placedOnly = !!on;
  applyPlacedFilter();
}

var dnpGroup = null;

/* `settings` is read lazily for the same reason as applySilkscreen(). */
function applyDnpMarkers() {
  if (dnpGroup) {
    dnpGroup.visible = (typeof settings === "undefined") || settings.renderDnpMarkers !== false;
  }
}

/* A red cross over each DNP footprint's bounding box, on the board face it mounts to. */
function buildDnpCrosses() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: DNP_COLOR });
  for (const i of (pcbdata.bom.dnp || [])) {
    const fp = pcbdata.footprints[i], bb = fp.bbox;
    const a = THREE.MathUtils.degToRad(-bb.angle), c = Math.cos(a), s = Math.sin(a);
    const corner = (u, v) => {
      const x = bb.relpos[0] + u * bb.size[0], y = bb.relpos[1] + v * bb.size[1];
      return [bb.pos[0] + x * c - y * s, bb.pos[1] + x * s + y * c];
    };
    const y = (fp.layer === 'B') ? boardBottomY - DNP_LIFT_MM * 0.001
                                 : boardTopY + DNP_LIFT_MM * 0.001;
    const width = Math.max(Math.min(...bb.size) * 0.25, 0.3) * 0.001;
    for (const [p, q] of [[corner(0, 0), corner(1, 1)], [corner(1, 0), corner(0, 1)]]) {
      const from = toModel(p, y), to = toModel(q, y);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(from.distanceTo(to), 1e-5, width), mat);
      bar.position.addVectors(from, to).multiplyScalar(0.5);
      bar.rotation.y = Math.atan2(-(to.z - from.z), to.x - from.x);
      group.add(bar);
    }
  }
  return group;
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

/* Move the camera toward a fit on `box`, travelling a fraction `t` of the way there.
 *
 * t comes from the "3D zoom on select" slider unless a caller overrides it. The fraction is
 * RELATIVE to wherever the camera currently is, which is what makes t = 0 mean "do not move at
 * all" rather than "frame the whole board". The trade that buys: selecting the same row twice at
 * 50 % lands 75 % of the way in, since each move starts from the last one.
 *
 * The MIN_FIT_FRACTION clamp stays inside the target distance, so t = 1 is bit-for-bit the
 * behaviour that existed before the slider.
 */
/* Dim everything but the selection, while a selection exists. 0 = off, 1 = fully dimmed. */
function dimFraction() {
  if (typeof settings === "undefined" || settings.dim3d === undefined) return 0;
  if (!lastRefs.length) return 0;
  return Math.min(Math.max(settings.dim3d, 0), 100) / 100;
}

function applyDim() {
  if (!scene) return;
  const f = THREE.MathUtils.lerp(1, DIM_FLOOR, dimFraction());
  scene.environmentIntensity = ENV_INTENSITY * f;
  if (keyLight) keyLight.intensity = KEY_INTENSITY * f;
  // Pin-1 dots are MeshBasicMaterial and therefore unlit, so they stay bright on the dimmed
  // board. Deliberate -- they are a marker, not scenery.
}

function frame(box, immediate, t) {
  if (t === undefined) t = zoomFraction();
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, boardRadius * MIN_FIT_FRACTION);
  const fit = radius * FIT_MARGIN / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  if (dir.lengthSq() < 1e-9) dir.set(0.4, 1, 0.7).normalize();
  const dist = THREE.MathUtils.lerp(camera.position.distanceTo(controls.target), fit, t);
  controls.target.lerp(sphere.center, t);
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  setDepthRange(dist);
  controls.update();
  if (immediate) render();          // at t = 0 nothing moved, but the highlight still must draw
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
/* `noFrame` re-applies the highlight without touching the camera. Toggling the dim setting has to
 * rebuild the highlight materials -- the emissive level is baked in at highlight time -- but must
 * not move the view, which at a non-zero zoom setting would creep in on every toggle. */
function highlight3D(refs, noFrame) {
  if (!ready) return;
  lastRefs = refs;
  clearHighlight();
  const box = new THREE.Box3();
  var hit = 0, dnp = 0, missing = 0;
  for (const ref of refs) {
    const nodes = nodesFor(ref);
    if (isDnp(ref) && !isPlaced(ref)) dnp++;
    else if (!nodes.length) missing++;
    if (!nodes.length) continue;       // no 3D model for this part -- legitimate, skip it
    hit++;
    // With the placed filter on, an unplaced part is hidden. Selecting it reveals it -- fully
    // opaque, exactly as a placed part would look: an assembler needs to see the shape of the
    // thing they are about to fit before they can tick it off.
    //
    // It used to be revealed as a translucent ghost, which rendered as a see-through tangle of
    // red edges. The culprit was depthWrite = false, needed for the transparency but which also
    // stops the part's own faces occluding EACH OTHER, so every back face and interior surface
    // showed through the front. No opacity value fixes that; the geometry is self-overlapping and
    // unsorted. Opaque is both correct and simpler.
    const reveal = placedOnly && !isPlaced(ref) && !isDnp(ref);
    for (const node of nodes) {
      savedState.set(node, { material: null, visible: node.visible });
      if (reveal) node.visible = true;
      node.traverse((o) => {
        if (!o.isMesh) return;
        savedState.set(o, { material: o.material, visible: o.visible });
        const m = o.material.clone();
        // Ramp the emissive with the dim, or the selection darkens along with everything else and
        // reads as a muddy dark part with a red tinge rather than a clean red one.
        const d = dimFraction();
        m.emissive = new THREE.Color(HIGHLIGHT);
        m.emissiveIntensity = THREE.MathUtils.lerp(HIGHLIGHT_INTENSITY, HIGHLIGHT_EMISSIVE_DIM, d);
        o.material = m;
      });
      box.expandByObject(node);
    }
  }
  if (!noFrame) {
    if (hit && !box.isEmpty()) frame(box);
    else if (!refs.length) frame(boardFrame().box);
  }
  updatePin1(refs);
  applyDim();
  render();
  const note = document.getElementById("board3d-missing");
  if (note) {
    const notes = [];
    if (dnp) notes.push(dnp + " selected part(s) are DNP and not placed, so not shown");
    if (missing) notes.push(missing + " selected part(s) have no 3D model");
    note.textContent = notes.join("; ");
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
  renderer.toneMapping = THREE.NeutralToneMapping || THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
  el.appendChild(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = ENV_INTENSITY;
  pmrem.dispose();                       // one-time GPU pass; nothing to keep afterwards
  keyLight = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  keyLight.position.set(1, 2, 1.5);
  scene.add(keyLight);

  controls = new OrbitControls(camera, renderer.domElement);
  // No damping: the board stops the instant you let go. Damping is also the only thing that
  // needs a per-frame update(), so without it the 'change' event alone drives rendering and the
  // page runs no animation loop at all.
  controls.enableDamping = false;
  controls.addEventListener('change', render);

  // Double-click anywhere in the 3D view clears the selection. No raycast: any double-click
  // means "get me out of this", whether it lands on a part or on bare board. OrbitControls binds
  // no dblclick of its own, and a double-click involves no drag, so nothing conflicts.
  renderer.domElement.addEventListener('dblclick', () => {
    if (typeof clearHighlightedFootprints === "function" && lastRefs.length) {
      clearHighlightedFootprints();
      drawHighlights();
    }
  });

  new GLTFLoader().load(glbDataUri, (gltf) => {
    root = gltf.scene;
    scene.add(root);
    root.updateWorldMatrix(true, true);

    indexNodes(root);
    findBoardFaces(root);
    indexFootprintMeshes();
    const tinted = tintBoardLayers(root);
    const solidified = solidifyBoard(root);
    const biased = biasArtwork(root);
    console.log('ibom3d: board ' + (boardBottomY * 1000).toFixed(3) + ' .. '
      + (boardTopY * 1000).toFixed(3) + ' mm, ' + biased + ' artwork faces, '
      + footprintMeshes.size + ' component meshes, ' + silkMeshes.length + ' silkscreen faces, '
      + solidified + ' made opaque'
      + (tinted
          ? ', tinted front mask@' + tinted.mm(tinted.front && tinted.front.mask)
            + ' copper@' + tinted.mm(tinted.front && tinted.front.copper)
            + ', back mask@' + tinted.mm(tinted.back && tinted.back.mask)
            + ' copper@' + tinted.mm(tinted.back && tinted.back.copper)
          : ', not tinted'));

    xform = solveTransform();
    if (xform) {
      console.log('ibom3d: board->model fit from ' + xform.n + ' footprints, median residual '
        + (xform.med * 1000).toFixed(3) + ' mm, ' + xform.outliers + ' outliers');
      pin1Group = new THREE.Group();
      scene.add(pin1Group);
      dnpGroup = buildDnpCrosses();
      scene.add(dnpGroup);
      applyDnpMarkers();
    } else {
      console.warn('ibom3d: could not fit board->model transform; pin 1 markers disabled');
    }

    const f = boardFrame();
    boardRadius = f.box.getBoundingSphere(new THREE.Sphere()).radius;
    camera.position.set(f.center.x, f.center.y + f.size.length() * 0.5,
                        f.center.z + f.size.length() * 0.5);
    controls.target.copy(f.center);
    applySilkscreen();      // the checkbox was very likely restored before this module existed
    ready = true;
    window.__ibom3dReady = true;
    resize3D();
    frame(f.box, true, 1);
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
window.setSilkscreen3d = () => { applySilkscreen(); render(); };
window.setDnpMarkers3d = () => { applyDnpMarkers(); render(); };
window.applyDim3d = () => { highlight3D(lastRefs, true); };
window.updatePin1 = () => { updatePin1(lastRefs); render(); };
window.has3D = true;
window.addEventListener('resize', () => { if (pendingResize) resize3D(); });
