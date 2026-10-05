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
  const palette = [
    "#FFD400", "#0057B8", "#7A1FA2", "#FF8C00", "#00B8D9", "#6B3E26", "#008F5A", "#2D2A8C",
    "#C79200", "#0081A7", "#A55D00", "#3A86FF", "#8C5E35", "#00AEEF", "#B8860B", "#1D4E89",
    "#C06C00", "#0077B6", "#7D4E24", "#4361EE", "#AA7C00", "#0096C7", "#4A4E69", "#F2C14E",
    "#003566", "#9C6644", "#4895EF", "#00B4D8", "#946B2D", "#264653", "#6C8CD5", "#D69E2E",
    "#004E89", "#B87333", "#1A759F", "#735751", "#2F6690", "#D4A017", "#3F37C9", "#007F9E",
  ];
  const overrides = new Map([
    ["RO.ML02-R-116", "#0057B8"],
    ["RO.ML05", "#FFD400"],
    ["RO.ML05.1-2-R", "#7A1FA2"],
  ]);
  const reserved = new Set(tips.map((tip) => overrides.get(tip)).filter(Boolean));
  const available = palette.filter((color) => !reserved.has(color));
  const rgb = (color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
  const distance = (first, second) => {
    const [r1, g1, b1] = rgb(first), [r2, g2, b2] = rgb(second);
    return Math.sqrt((r1 - r2) ** 2 * 0.3 + (g1 - g2) ** 2 * 0.59 + (b1 - b2) ** 2 * 0.11);
  };
  const spread = [];
  while (available.length) {
    if (!spread.length) { spread.push(available.shift()); continue; }
    let bestIndex = 0, bestDistance = -1;
    available.forEach((candidate, index) => {
      const nearest = Math.min(...[...spread, ...reserved].map((selected) => distance(candidate, selected)));
      if (nearest > bestDistance) { bestDistance = nearest; bestIndex = index; }
    });
    spread.push(available.splice(bestIndex, 1)[0]);
  }
  let colorIndex = 0;
  return new Map(tips.map((tip) => [tip, overrides.get(tip) || spread[colorIndex++ % spread.length]]));
}

function roomCategoryFor(floorId, roomNumber) {
  return ROOMS_BY_FLOOR[floorId]?.find((room) => room.number === roomNumber)?.roomType || "standard";
}

function roomCategory(roomNumber) {
  return roomCategoryFor(selectedFloor, roomNumber);
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

async function floorModel(floor) {
  if (modelCache.has(floor.id)) return modelCache.get(floor.id);
  if (!floor.dxfPath) throw new Error(`Aucun plan DXF disponible pour ${floor.label}.`);
  const response = await fetch(`${floor.dxfPath}?v=${encodeURIComponent(floor.updatedAt || "equipment")}`);
  if (!response.ok) throw new Error(`Plan ${floor.label} introuvable (${response.status})`);
  const source = await response.text();
  const Parser = window.DxfParser;
  if (!Parser) throw new Error("Le lecteur DXF n’est pas disponible.");
  const model = buildModel(new Parser().parseSync(source));
  modelCache.set(floor.id, model);
  return model;
}

async function loadFloor() {
  const empty = document.querySelector("#equipmentPlanEmpty");
  empty.hidden = false;
  empty.textContent = "Chargement du plan…";
  const floor = projectDefinition.floors.find((item) => item.id === selectedFloor);
  if (!floor?.dxfPath) { empty.textContent = "Aucun plan DXF disponible pour cet étage."; return; }
  try {
    await floorModel(floor);
    selectedRoom = null; selectedTip = null;
    render(modelCache.get(floor.id));
  } catch (error) {
    empty.textContent = `Impossible d’ouvrir le plan : ${error.message}`;
    const svg = document.querySelector("#equipmentPlan");
    svg.innerHTML = ""; delete svg.dataset.floor;
  }
}

function hslRgb(value) {
  const match = String(value).match(/hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)/);
  if (!match) {
    const hex = String(value).replace("#", "");
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const hue = Number(match[1]) / 360, saturation = Number(match[2]) / 100, lightness = Number(match[3]) / 100;
  const channel = (offset) => {
    const position = (offset + hue * 12) % 12;
    const amplitude = saturation * Math.min(lightness, 1 - lightness);
    return Math.round(255 * (lightness - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

function reportLegend(model, floorId, equipment, category) {
  const grouped = new Map();
  let undefinedCount = 0;
  let unavailableCount = 0;
  for (const room of model.rooms) {
    if (roomCategoryFor(floorId, room.number) !== category) { unavailableCount += 1; continue; }
    const record = equipmentRecord(equipment, room.number);
    if (!equipmentIsDefined(record)) { undefinedCount += 1; continue; }
    if (!grouped.has(record.productCode)) grouped.set(record.productCode, new Map());
    const tips = grouped.get(record.productCode);
    tips.set(record.tipExcel, (tips.get(record.tipExcel) || 0) + 1);
  }
  return { grouped, undefinedCount, unavailableCount };
}

function reportSvg(model, floorId, equipment, category) {
  const colors = colorMapFor(equipment);
  const width = model.bounds.maxX - model.bounds.minX;
  const height = model.bounds.maxY - model.bounds.minY;
  const labelSize = Math.max(0.34, Math.min(0.58, height * 0.012));
  const shapes = model.rooms.map((room) => {
    const applicable = roomCategoryFor(floorId, room.number) === category;
    const record = equipmentRecord(equipment, room.number);
    const defined = equipmentIsDefined(record);
    const fill = applicable ? (defined ? colors.get(record.tipExcel) : UNDEFINED_COLOR) : "url(#report-unavailable)";
    const stroke = applicable && !defined ? "#b9002c" : applicable ? "#34443b" : "#242a27";
    if (room.polygon) return `<path d="${pathFromPoints(room.polygon, true)}" fill="${fill}" fill-opacity="${applicable ? 0.82 : 1}" stroke="${stroke}" stroke-width="0.13"/>`;
    return `<circle cx="${numberValue(room.labelPoint.x)}" cy="${numberValue(room.labelPoint.y)}" r="${numberValue(labelSize * 1.5)}" fill="${fill}" stroke="${stroke}" stroke-width="0.13"/>`;
  }).join("");
  const labels = model.rooms.map((room) => `<text x="${numberValue(room.labelPoint.x)}" y="${numberValue(-room.labelPoint.y)}" font-size="${numberValue(labelSize)}" text-anchor="middle" font-family="Arial" font-weight="700" fill="#17231d" stroke="#ffffff" stroke-width="0.08" paint-order="stroke">${room.number}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${Math.round(1600 * height / width)}" viewBox="${numberValue(model.bounds.minX)} ${numberValue(-model.bounds.maxY)} ${numberValue(width)} ${numberValue(height)}"><rect width="100%" height="100%" fill="#fff"/><defs><pattern id="report-unavailable" width="0.65" height="0.65" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="0.65" height="0.65" fill="#555c58"/><rect width="0.2" height="0.65" fill="#aeb4b1"/></pattern></defs><g transform="scale(1 -1)">${shapes}</g><g transform="scale(1 -1)" fill="none" stroke="#7c8580" stroke-width="0.045" opacity="0.72">${model.architecture}</g><g>${labels}</g></svg>`;
}

async function svgJpeg(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(1800, image.naturalWidth || 1600);
    canvas.height = Math.max(1, Math.round(canvas.width * (image.naturalHeight || 1000) / (image.naturalWidth || 1600)));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Le plan ne peut pas être converti en image.");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL("image/jpeg", 0.9), width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}

async function logoData() {
  const response = await fetch("/muc-building.png");
  const blob = await response.blob();
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
}

function drawReportLegend(pdf, legend, colors) {
  const items = [];
  for (const [product, tips] of [...legend.grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.push({ heading: product });
    for (const [tip, count] of [...tips.entries()].sort(([a], [b]) => a.localeCompare(b))) items.push({ tip, count, color: colors.get(tip) });
  }
  if (legend.undefinedCount) items.push({ tip: "Non défini", count: legend.undefinedCount, color: UNDEFINED_COLOR });
  if (legend.unavailableCount) items.push({ tip: "Hors de cette famille", count: legend.unavailableCount, unavailable: true });
  const lineHeight = Math.max(3.2, Math.min(5, 162 / Math.max(1, items.length)));
  let y = 34;
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); pdf.setTextColor(31, 57, 39); pdf.text("Légende", 233, 28);
  for (const item of items) {
    if (item.heading) {
      pdf.setFillColor(239, 242, 238); pdf.rect(232, y - 2.7, 57, lineHeight, "F");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(Math.min(7.2, lineHeight + 1.8)); pdf.setTextColor(31, 48, 39);
      pdf.text(String(item.heading), 234, y, { maxWidth: 53 }); y += lineHeight;
      continue;
    }
    const [red, green, blue] = item.unavailable ? [85, 92, 88] : hslRgb(item.color);
    pdf.setFillColor(red, green, blue); pdf.setDrawColor(45, 55, 49); pdf.rect(234, y - 2.7, 3.2, 3.2, "FD");
    if (item.unavailable) { pdf.setDrawColor(180, 185, 182); pdf.line(234, y + 0.2, 237.2, y - 2.6); }
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(Math.min(6.8, lineHeight + 1.5)); pdf.setTextColor(35, 46, 40);
    pdf.text(String(item.tip), 239, y, { maxWidth: 43 }); pdf.setFont("helvetica", "bold"); pdf.text(String(item.count), 287, y, { align: "right" }); y += lineHeight;
  }
}

async function equipmentPdf(equipment, category, logo, onPage) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const colors = colorMapFor(equipment);
  for (let index = 0; index < projectDefinition.floors.length; index += 1) {
    const floor = projectDefinition.floors[index];
    const model = await floorModel(floor);
    const image = await svgJpeg(reportSvg(model, floor.id, equipment, category));
    if (index) pdf.addPage("a4", "landscape");
    pdf.setFillColor(39, 83, 47); pdf.rect(0, 0, 297, 19, "F");
    if (logo) pdf.addImage(logo, "PNG", 8, 2.5, 20, 14);
    pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(14);
    pdf.text(`MUC - ${EQUIPMENT_LABELS[equipment]} - ${category === "standard" ? "Chambres Standard" : "Suites Junior"}`, 33, 11.5);
    pdf.setFontSize(10); pdf.text(floor.label, 288, 11.5, { align: "right" });
    const maxWidth = 218, maxHeight = 170;
    const ratio = Math.min(maxWidth / image.width, maxHeight / image.height);
    const drawWidth = image.width * ratio, drawHeight = image.height * ratio;
    pdf.addImage(image.data, "JPEG", 8 + (maxWidth - drawWidth) / 2, 25 + (maxHeight - drawHeight) / 2, drawWidth, drawHeight, undefined, "FAST");
    pdf.setDrawColor(206, 214, 209); pdf.rect(7, 24, 220, 172);
    drawReportLegend(pdf, reportLegend(model, floor.id, equipment, category), colors);
    pdf.setTextColor(80, 91, 85); pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.text(String(index + 1), 148.5, 204, { align: "center" });
    onPage();
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

async function exportEquipmentPdfs() {
  const button = document.querySelector("#exportEquipmentPdfs");
  const status = document.querySelector("#equipmentExportStatus");
  const documents = [
    ["headboard", "standard", "Headboard-Standard.pdf"], ["wardrobe", "standard", "Armoire-Standard.pdf"], ["bar", "standard", "Bar-Standard.pdf"],
    ["headboard", "junior", "Headboard-Junior.pdf"], ["wardrobe", "junior", "Armoire-Junior.pdf"], ["bar", "junior", "Bar-Junior.pdf"], ["vanity", "junior", "Vanity-Junior.pdf"],
  ];
  const totalPages = documents.length * projectDefinition.floors.length;
  let completed = 0;
  button.disabled = true;
  try {
    status.textContent = `Préparation des plans : 0/${totalPages}`;
    const logo = await logoData();
    const files = {};
    for (const [equipment, category, name] of documents) {
      files[name] = await equipmentPdf(equipment, category, logo, () => { completed += 1; status.textContent = `Préparation des plans : ${completed}/${totalPages}`; });
    }
    const { zipSync } = await import("fflate");
    const archive = zipSync(files, { level: 6 });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
    link.download = "MUC-Reperage-Equipements-PDF.zip"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    status.textContent = "7 PDF générés : quatre pages par fichier, du R+2 au R+5.";
  } catch (error) {
    status.textContent = `Export impossible : ${error.message}`;
  } finally { button.disabled = false; }
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
  document.querySelector("#equipmentShowAll").addEventListener("click", () => {
    selectedCategory = "all"; selectedTip = null; selectedRoom = null;
    document.querySelector("#equipmentCategorySelect").value = "all";
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
  document.querySelector("#exportEquipmentPdfs").addEventListener("click", () => { void exportEquipmentPdfs(); });
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
