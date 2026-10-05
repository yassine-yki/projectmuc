import { cleanDxfText, roomNumberFromText } from "./dxf-identification.js";
import { EQUIPMENT_LABELS, EQUIPMENT_RECORDS, equipmentIsDefined, equipmentRecord } from "./equipment-data.js";
import { ROOMS_BY_FLOOR } from "./project-data.js";

const UNDEFINED_COLOR = "#ff003c";
const EXECUTIVE_COLOR = "#555c58";
let projectDefinition = null;
let selectedFloor = "r2";
let selectedEquipment = "headboard";
let selectedRoom = null;
let selectedCategory = "all";
let selectedTip = null;
let initialized = false;
const modelCache = new Map();

const layerName = (value) => String(value || "").trim().toUpperCase();
const point = (entity) => entity.position || entity.startPoint || entity.vertices?.[0] || null;
const numberValue = (value) => Number(value).toFixed(4).replace(/\.0+$/, "");
const escapeText = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function isClosedPolygon(entity) {
  if (!["LWPOLYLINE", "POLYLINE"].includes(entity.type) || entity.vertices?.length < 3) return false;
  if (entity.shape) return true;
  const first = entity.vertices[0];
  const last = entity.vertices.at(-1);
  return Math.hypot(first.x - last.x, first.y - last.y) < 0.1;
}

function pointInPolygon(target, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const current = vertices[index];
    const prior = vertices[previous];
    const crosses = (current.y > target.y) !== (prior.y > target.y)
      && target.x < ((prior.x - current.x) * (target.y - current.y)) / (prior.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function boundsFromPoints(points) {
  return {
    minX: Math.min(...points.map((item) => item.x)), maxX: Math.max(...points.map((item) => item.x)),
    minY: Math.min(...points.map((item) => item.y)), maxY: Math.max(...points.map((item) => item.y)),
  };
}

function expanded(bounds, padding) {
  return { minX: bounds.minX - padding, maxX: bounds.maxX + padding, minY: bounds.minY - padding, maxY: bounds.maxY + padding };
}

function pathFromPoints(points, close = false) {
  if (!points?.length) return "";
  return `M ${points.map((item) => `${numberValue(item.x)} ${numberValue(item.y)}`).join(" L ")}${close ? " Z" : ""}`;
}

function curvedPoints(entity) {
  const start = entity.type === "CIRCLE" ? 0 : entity.startAngle || 0;
  let length = entity.type === "CIRCLE" ? Math.PI * 2 : entity.angleLength;
  if (!Number.isFinite(length) || length <= 0) length += Math.PI * 2;
  const segments = Math.max(12, Math.ceil(Math.abs(length) / (Math.PI / 18)));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + length * index / segments;
    return { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
  });
}

function entitySvg(entity, blocks, ancestors = []) {
  if (entity.inPaperSpace) return "";
  if (entity.type === "INSERT" || entity.type === "DIMENSION") {
    const name = entity.type === "INSERT" ? entity.name : entity.block;
    const block = blocks[name];
    if (!block || ancestors.includes(name) || ancestors.length >= 8) return "";
    const content = (block.entities || []).map((part) => entitySvg(part, blocks, [...ancestors, name])).join("");
    if (!content) return "";
    if (entity.type === "DIMENSION") return `<g>${content}</g>`;
    const position = entity.position || { x: 0, y: 0 };
    const base = block.position || { x: 0, y: 0 };
    return `<g transform="translate(${numberValue(position.x)} ${numberValue(position.y)}) rotate(${numberValue(entity.rotation || 0)}) scale(${numberValue(entity.xScale || 1)} ${numberValue(entity.yScale || 1)}) translate(${numberValue(-base.x)} ${numberValue(-base.y)})">${content}</g>`;
  }
  if (entity.type === "LINE") return `<path d="${pathFromPoints(entity.vertices)}" />`;
  if (["LWPOLYLINE", "POLYLINE"].includes(entity.type)) return `<path d="${pathFromPoints(entity.vertices, entity.shape)}" />`;
  if (["ARC", "CIRCLE"].includes(entity.type) && entity.center) return `<path d="${pathFromPoints(curvedPoints(entity), entity.type === "CIRCLE")}" />`;
  if (entity.type === "SPLINE" && entity.controlPoints?.length) return `<path d="${pathFromPoints(entity.controlPoints)}" />`;
  return "";
}

function buildModel(dxf) {
  const entities = (dxf.entities || []).filter((entity) => !entity.inPaperSpace);
  const polygons = entities.filter((entity) => layerName(entity.layer) === "CHAMBRE" && isClosedPolygon(entity));
  const texts = entities
    .filter((entity) => layerName(entity.layer) === "A-AREA-IDEN" && ["TEXT", "MTEXT"].includes(entity.type))
    .map((entity) => ({ location: point(entity), number: roomNumberFromText(cleanDxfText(entity.text)) }))
    .filter((item) => item.location && item.number);
  const uniqueTexts = [...new Map(texts.map((item) => [item.number, item])).values()].sort((a, b) => a.number - b.number);
  if (!uniqueTexts.length) throw new Error("Aucun numéro de chambre trouvé dans le plan DXF.");
  const textBounds = boundsFromPoints(uniqueTexts.map((item) => item.location));
  const polygonPoints = polygons.flatMap((polygon) => polygon.vertices || []);
  const baseBounds = polygonPoints.length ? boundsFromPoints(polygonPoints) : textBounds;
  const padding = Math.max(2.5, Math.min(baseBounds.maxX - baseBounds.minX, baseBounds.maxY - baseBounds.minY) * 0.04);
  const bounds = expanded(baseBounds, padding);
  const rooms = uniqueTexts.map((item) => ({
    number: item.number,
    labelPoint: item.location,
    polygon: polygons.find((polygon) => pointInPolygon(item.location, polygon.vertices))?.vertices || null,
  }));
  return { bounds, rooms, architecture: entities.map((entity) => entitySvg(entity, dxf.blocks || {})).join("") };
}

function colorMapFor(equipment) {
  const tips = [...new Set(EQUIPMENT_RECORDS.filter((record) => record.equipment === equipment && equipmentIsDefined(record)).map((record) => record.tipExcel))].sort();
  const hues = [45, 156, 216, 90, 198, 134, 234, 68, 178, 112, 270];
  const variants = [
    { saturation: 72, lightness: 46 },
    { saturation: 58, lightness: 62 },
    { saturation: 82, lightness: 34 },
    { saturation: 48, lightness: 74 },
  ];
  return new Map(tips.map((tip, index) => {
    const hue = hues[index % hues.length];
    const variant = variants[Math.floor(index / hues.length) % variants.length];
    return [tip, `hsl(${hue} ${variant.saturation}% ${variant.lightness}%)`];
  }));
}

function roomCategory(roomNumber) {
  return ROOMS_BY_FLOOR[selectedFloor]?.find((room) => room.number === roomNumber)?.roomType || "standard";
}

function equipmentUnavailable(roomNumber) {
  const category = roomCategory(roomNumber);
  return category === "executive" || (selectedEquipment === "vanity" && category === "standard");
}

function roomVisible(roomNumber, record) {
  if (selectedCategory !== "all" && roomCategory(roomNumber) !== selectedCategory) return false;
  return !selectedTip || record?.tipExcel === selectedTip;
}

function renderDetail(room) {
  const container = document.querySelector("#equipmentRoomDetail");
  if (!room) { container.innerHTML = "<strong>Sélectionnez une chambre sur le plan</strong>"; return; }
  const record = equipmentRecord(selectedEquipment, room);
  const defined = equipmentIsDefined(record);
  const category = roomCategory(room);
  const unavailable = equipmentUnavailable(room);
  const unavailableLabel = category === "executive" ? "Non prévu dans les tableaux fournis" : "Indisponible pour les chambres Standard";
  container.innerHTML = `<span class="eyebrow">Chambre sélectionnée</span><h3>Chambre ${room}</h3>
    <dl><div><dt>Type</dt><dd>${category === "executive" ? "Executive" : escapeText(record?.roomType || category)}</dd></div><div><dt>Typologie</dt><dd>${escapeText(record?.typology || "Non renseignée")}</dd></div><div><dt>PRODUCT CODE</dt><dd>${unavailable ? "Indisponible" : escapeText(record?.productCode || "Non défini")}</dd></div><div><dt>TIP EXCEL</dt><dd class="${defined || unavailable ? "" : "undefined"}">${unavailable ? unavailableLabel : escapeText(record?.tipExcel || "Non défini")}</dd></div></dl>`;
}

function renderLegend(model, colors) {
  const categoryRooms = model.rooms.filter((room) => selectedCategory === "all" || roomCategory(room.number) === selectedCategory);
  const visible = categoryRooms.filter((room) => !equipmentUnavailable(room.number)).map((room) => equipmentRecord(selectedEquipment, room.number));
  const grouped = new Map();
  let undefinedCount = 0;
  for (const record of visible) {
    if (!equipmentIsDefined(record)) { undefinedCount += 1; continue; }
    if (!grouped.has(record.productCode)) grouped.set(record.productCode, new Map());
    const tips = grouped.get(record.productCode);
    tips.set(record.tipExcel, (tips.get(record.tipExcel) || 0) + 1);
  }
  const groups = [...grouped.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([product, tips]) => `
    <section class="equipment-legend-group"><h3>${escapeText(product)}</h3>${[...tips.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([tip, count]) => `<button type="button" class="equipment-legend-item${selectedTip === tip ? " active" : ""}" data-equipment-tip="${escapeText(tip)}" aria-pressed="${selectedTip === tip}"><i style="--equipment-color:${colors.get(tip)}"></i><span>${escapeText(tip)}</span><strong>${count}</strong></button>`).join("")}</section>`).join("");
  const executiveCount = categoryRooms.filter((room) => roomCategory(room.number) === "executive").length;
  const unavailableCount = categoryRooms.filter((room) => roomCategory(room.number) !== "executive" && equipmentUnavailable(room.number)).length;
  const reset = selectedTip ? `<button type="button" class="equipment-filter-reset" data-equipment-tip="">Afficher toutes les typologies</button>` : "";
  const undefinedGroup = undefinedCount ? `<section class="equipment-legend-group undefined"><h3>Données à compléter</h3><div class="equipment-legend-item static"><i style="--equipment-color:${UNDEFINED_COLOR}"></i><span>Non défini</span><strong>${undefinedCount}</strong></div></section>` : "";
  const executiveGroup = executiveCount ? `<section class="equipment-legend-group executive"><h3>Chambres Executive</h3><div class="equipment-legend-item static"><i class="unavailable-swatch"></i><span>Hors de cet équipement</span><strong>${executiveCount}</strong></div></section>` : "";
  const unavailableGroup = unavailableCount ? `<section class="equipment-legend-group executive"><h3>Équipement indisponible</h3><div class="equipment-legend-item static"><i class="unavailable-swatch"></i><span>Ne fait pas partie de cet équipement</span><strong>${unavailableCount}</strong></div></section>` : "";
  document.querySelector("#equipmentLegend").innerHTML = `${reset}${groups}${undefinedGroup}${unavailableGroup}${executiveGroup}`;
}

function ensurePlanStructure(model) {
  const svg = document.querySelector("#equipmentPlan");
  if (svg.dataset.floor === selectedFloor) return svg;
  const width = model.bounds.maxX - model.bounds.minX;
  const height = model.bounds.maxY - model.bounds.minY;
  const labelSize = Math.max(0.34, Math.min(0.58, height * 0.012));
  svg.setAttribute("viewBox", `${numberValue(model.bounds.minX)} ${numberValue(-model.bounds.maxY)} ${numberValue(width)} ${numberValue(height)}`);
  const roomShapes = model.rooms.map((room) => {
    if (room.polygon) return `<path class="equipment-room" data-room="${room.number}" d="${pathFromPoints(room.polygon, true)}"><title></title></path>`;
    return `<circle class="equipment-room equipment-room-marker" data-room="${room.number}" cx="${numberValue(room.labelPoint.x)}" cy="${numberValue(room.labelPoint.y)}" r="${numberValue(labelSize * 1.5)}"><title></title></circle>`;
  }).join("");
  const labels = model.rooms.map((room) => `<text class="equipment-room-label" data-room-label="${room.number}" x="${numberValue(room.labelPoint.x)}" y="${numberValue(-room.labelPoint.y)}" font-size="${numberValue(labelSize)}" text-anchor="middle">${room.number}</text>`).join("");
  svg.innerHTML = `<defs><pattern id="equipment-unavailable-pattern" width="0.65" height="0.65" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.65" height="0.65" fill="#555c58"></rect><rect width="0.2" height="0.65" fill="#aeb4b1"></rect></pattern></defs><g transform="scale(1 -1)">${roomShapes}</g><g class="equipment-architecture" transform="scale(1 -1)">${model.architecture}</g><g>${labels}</g>`;
  svg.dataset.floor = selectedFloor;
  return svg;
}

function render(model) {
  const svg = ensurePlanStructure(model);
  const colors = colorMapFor(selectedEquipment);
  const roomsByNumber = new Map(model.rooms.map((room) => [room.number, room]));
  svg.querySelectorAll(".equipment-room").forEach((element) => {
    const roomNumber = Number(element.dataset.room);
    if (!roomsByNumber.has(roomNumber)) return;
    const record = equipmentRecord(selectedEquipment, roomNumber);
    const defined = equipmentIsDefined(record);
    const category = roomCategory(roomNumber);
    const unavailable = equipmentUnavailable(roomNumber);
    const color = unavailable ? EXECUTIVE_COLOR : defined ? colors.get(record.tipExcel) : UNDEFINED_COLOR;
    const label = category === "executive" ? "Executive" : unavailable ? "Indisponible" : record?.tipExcel || "Non défini";
    element.style.setProperty("--equipment-color", color);
    element.classList.toggle("undefined", !unavailable && !defined);
    element.classList.toggle("unavailable", unavailable);
    element.classList.toggle("selected", roomNumber === selectedRoom);
    element.classList.toggle("filtered-out", !roomVisible(roomNumber, record));
    const title = element.querySelector("title");
    if (title) title.textContent = `Chambre ${roomNumber} · ${label}`;
  });
  svg.querySelectorAll("[data-room-label]").forEach((label) => {
    const roomNumber = Number(label.dataset.roomLabel);
    label.classList.toggle("filtered-out", !roomVisible(roomNumber, equipmentRecord(selectedEquipment, roomNumber)));
  });
  const scopedRooms = model.rooms.filter((room) => roomVisible(room.number, equipmentRecord(selectedEquipment, room.number)));
  const undefinedCount = scopedRooms.filter((room) => !equipmentUnavailable(room.number) && !equipmentIsDefined(equipmentRecord(selectedEquipment, room.number))).length;
  const unavailableCount = scopedRooms.filter((room) => equipmentUnavailable(room.number)).length;
  const visibleTypeCount = new Set(scopedRooms.map((room) => equipmentRecord(selectedEquipment, room.number)).filter(equipmentIsDefined).map((record) => record.tipExcel)).size;
  const floor = projectDefinition.floors.find((item) => item.id === selectedFloor);
  document.querySelector("#equipmentPlanTitle").textContent = `${floor?.label || selectedFloor} · ${EQUIPMENT_LABELS[selectedEquipment]}`;
  document.querySelector("#equipmentSummary").textContent = `${scopedRooms.length} chambres affichées · ${visibleTypeCount} TIP EXCEL · ${undefinedCount} non définie${undefinedCount > 1 ? "s" : ""}${unavailableCount ? ` · ${unavailableCount} indisponible${unavailableCount > 1 ? "s" : ""}` : ""}`;
  document.querySelector("#equipmentPlanEmpty").hidden = true;
  renderLegend(model, colors);
  renderDetail(selectedRoom);
}

async function loadFloor() {
  const empty = document.querySelector("#equipmentPlanEmpty");
  empty.hidden = false;
  empty.textContent = "Chargement du plan…";
  const floor = projectDefinition.floors.find((item) => item.id === selectedFloor);
  if (!floor?.dxfPath) { empty.textContent = "Aucun plan DXF disponible pour cet étage."; return; }
  try {
    if (!modelCache.has(floor.id)) {
      const response = await fetch(`${floor.dxfPath}?v=${encodeURIComponent(floor.updatedAt || "equipment")}`);
      if (!response.ok) throw new Error(`Plan introuvable (${response.status})`);
      const source = await response.text();
      const Parser = window.DxfParser;
      if (!Parser) throw new Error("Le lecteur DXF n’est pas disponible.");
      modelCache.set(floor.id, buildModel(new Parser().parseSync(source)));
    }
    selectedRoom = null; selectedTip = null;
    render(modelCache.get(floor.id));
  } catch (error) {
    empty.textContent = `Impossible d’ouvrir le plan : ${error.message}`;
    const svg = document.querySelector("#equipmentPlan");
    svg.innerHTML = ""; delete svg.dataset.floor;
  }
}

function initialize() {
  if (initialized) return;
  initialized = true;
  document.querySelector("#equipmentFloorSelect").addEventListener("change", (event) => { selectedFloor = event.target.value; void loadFloor(); });
  document.querySelector("#equipmentKindSelect").addEventListener("change", (event) => { selectedEquipment = event.target.value; selectedTip = null; selectedRoom = null; const model = modelCache.get(selectedFloor); if (model) render(model); });
  document.querySelector("#equipmentCategorySelect").addEventListener("change", (event) => {
    selectedCategory = event.target.value; selectedTip = null; selectedRoom = null;
    const model = modelCache.get(selectedFloor); if (model) render(model);
  });
  document.querySelector("#equipmentLegend").addEventListener("click", (event) => {
    const button = event.target.closest("[data-equipment-tip]");
    if (!button) return;
    selectedTip = button.dataset.equipmentTip || null; selectedRoom = null;
    const model = modelCache.get(selectedFloor); if (model) render(model);
  });
  document.querySelector("#equipmentPlan").addEventListener("click", (event) => {
    const target = event.target.closest("[data-room]");
    if (!target) return;
    selectedRoom = Number(target.dataset.room);
    render(modelCache.get(selectedFloor));
  });
}

export async function openEquipmentMap(definition) {
  projectDefinition = definition;
  initialize();
  const select = document.querySelector("#equipmentFloorSelect");
  select.innerHTML = definition.floors.map((floor) => `<option value="${floor.id}">${escapeText(floor.label)}</option>`).join("");
  if (!definition.floors.some((floor) => floor.id === selectedFloor)) selectedFloor = definition.floors[0]?.id || "r2";
  select.value = selectedFloor;
  document.querySelector("#equipmentKindSelect").value = selectedEquipment;
  document.querySelector("#equipmentCategorySelect").value = selectedCategory;
  await loadFloor();
}
