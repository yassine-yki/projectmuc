import { CURRENT_FLOOR, emptyProject, projectDay, lockedProgress, taskGroup, tasksByZone } from "./model.js";
import { cleanDxfText, roomNumberFromText } from "./dxf-identification.js";
import { createProjectRepository } from "./repositories/index.js";
import { ROOMS_BY_FLOOR } from "./project-data.js";
import { PROJECT_CATALOG } from "./project-catalog.js";
import { downloadProgressWorkbook } from "./excel-export.js";
import { dailyProgressLines, downloadDailyProgressPdfs } from "./pdf-export.js";
import { cloudConfigured, login, logout, restoreWorkspace, acceptInvitation } from "./cloud/workspace.js";
import { editable } from "./cloud/types.js";
import { openProjectPhotos, openTaskPhotos } from "./task-photos.js";
import { openBoh } from "./boh.js";
import { openDxfWorkshop } from "./dxf-workshop.js";
import { openEquipmentMap } from "./equipment-map.js";
import { findPinnedTask } from "./task-pin.js";



let activeProjectDefinition = null;
let projectRepository = null;
let project = emptyProject();
let saveQueue = Promise.resolve();
const guestModeKey = "pistache-guest-mode";
const localMode = !cloudConfigured || sessionStorage.getItem(guestModeKey) === "true";
let cloud = null;
let synchronizing = false;
let currentUser = null;
let accessReady = false;
let saving = false;
let adminPage = "dashboard";
let trackingMode = null;
let taskManagementZone = "bedroom";
let invitationToken=new URLSearchParams(location.hash.slice(1)).get("invite") || "";
if(invitationToken) history.replaceState(null,"",location.pathname+location.search);
let registrationMode = Boolean(invitationToken);

function persistProject(key, correction = null, previousRecord = null) {
  if(localMode || !currentUser || currentUser.role==="viewer") return Promise.resolve();
  if (!projectRepository && !cloud) return Promise.resolve();
  if(localMode) { if(!previousRecord?.draft && previousRecord) state.records[key].draftBefore={...previousRecord};state.records[key].draftJustified=Boolean(correction)||(state.records[key].draft&&state.records[key].draftJustified);state.records[key].draft=true; }
  const record = { ...state.records[key] };
  saving = true;
  document.querySelector("#saveStatus").textContent = "Enregistrement sur cet appareil…";
  saveQueue = saveQueue.then(async () => {
    if (localMode) {
      await projectRepository.save(project);
      document.querySelector("#saveStatus").textContent="Brouillon enregistré sur cet appareil — non partagé";
    } else {
      project=await cloud.enqueue(key,record,correction,previousRecord);
      state.records=currentFloorRecords();
      state.records[key]={...(state.records[key] || {}),...record};
      await renderSync();
    }
  }).catch(error => {
    if(previousRecord) state.records[key]=previousRecord;
    document.querySelector("#saveStatus").textContent="Non enregistré : "+error.message;
    state.progressRuleMessage=error.message;
  }).finally(()=>{saving=false;render();});
  return saveQueue;
}

let rooms = ROOMS_BY_FLOOR[CURRENT_FLOOR];
const loggiaRooms = new Set([203, 206, 209, 210, 212, 214, 217, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236]);

const state = {
  selectedRoom: 203,
  selectedFloor: CURRENT_FLOOR,
  selectedZone: "bedroom",
  selectedTask: "",
  pinnedTask: null,
  selectedType: "all",
  selectedBlock: "all",
  taskQuery: "",
  correctionAuthorization: null,
  correctionPanelOpen: false,
  progressRuleMessage: "",
  zoom: 100,
  panX: 16,
  panY: 16,
  planAspect: 1.676,
  dxfModel: null,
  importedTypes: {},
  records: project.floors[CURRENT_FLOOR].records,
};

function floorDefinition() {
  return activeProjectDefinition?.floors?.find((floor) => floor.id === state.selectedFloor) || activeProjectDefinition?.floors?.[0] || null;
}

function roomDefinitions() {
  return new Map((ROOMS_BY_FLOOR[state.selectedFloor] || []).map((room) => [room.number, room]));
}

function currentFloorRecords() {
  project.floors[state.selectedFloor] ||= { records: {} };
  return project.floors[state.selectedFloor].records;
}

const elements = {
  planContent: document.querySelector("#planContent"),
  planViewport: document.querySelector("#planViewport"),
  dxfPlan: document.querySelector("#dxfPlan"),
  planEmpty: document.querySelector("#planEmpty"),
  roomSelect: document.querySelector("#roomSelect"),
  importStatus: document.querySelector("#importStatus"),
  taskSelect: document.querySelector("#taskSelect"),
  summaryStrip: document.querySelector("#summaryStrip"),
  roomTitle: document.querySelector("#roomTitle"),
  roomType: document.querySelector("#roomType"),
  taskList: document.querySelector("#taskList"),
  taskEditor: document.querySelector("#taskEditor"),
  editorTaskTitle: document.querySelector("#editorTaskTitle"),
  percentOutput: document.querySelector("#percentOutput"),
  percentInput: document.querySelector("#percentInput"),
  progressRange: document.querySelector("#progressRange"),
  blockedInput: document.querySelector("#blockedInput"),
  noteInput: document.querySelector("#noteInput"),
  zoomRange: document.querySelector("#zoomRange"),
  zoomValue: document.querySelector("#zoomValue"),
  projectDialog: document.querySelector("#projectDialog"),
  projectList: document.querySelector("#projectList"),
  projectSubtitle: document.querySelector("#projectSubtitle"),
  floorSelect: document.querySelector("#floorSelect"),
  taskSearch: document.querySelector("#taskSearch"),
  taskLock: document.querySelector("#taskLock"),
  correctionTrigger: document.querySelector("#correctionTrigger"),
  correctionPanel: document.querySelector("#correctionPanel"),
  correctionReason: document.querySelector("#correctionReason"),
  correctionNote: document.querySelector("#correctionNote"),
  correctionError: document.querySelector("#correctionError"),
  authorizeCorrection: document.querySelector("#authorizeCorrection"),
  cancelCorrection: document.querySelector("#cancelCorrection"),
  correctionAuthorized: document.querySelector("#correctionAuthorized"),
  correctionHistory: document.querySelector("#correctionHistory"),
  progressRuleMessage: document.querySelector("#progressRuleMessage"),
};

function normalizedLayer(name) {
  return String(name || "").trim().toUpperCase();
}

function trackedRoomNumber(number) {
  return Number.isInteger(number) && number >= 201 && number <= 540;
}

function entityPoint(entity) {
  return entity.position || entity.startPoint || entity.vertices?.[0] || null;
}

function isPolygon(entity) {
  if (!["LWPOLYLINE", "POLYLINE"].includes(entity.type) || !entity.vertices?.length) return false;
  if (entity.shape) return true;
  const first = entity.vertices[0];
  const last = entity.vertices.at(-1);
  const tolerance = ["CHAMBRE", "SDB", "LOGGIA"].includes(normalizedLayer(entity.layer)) ? 0.1 : 0.05;
  return entity.vertices.length >= 3 && Math.hypot(first.x - last.x, first.y - last.y) < tolerance;
}

function pointInPolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const currentPoint = vertices[index];
    const previousPoint = vertices[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonCenter(vertices) {
  return vertices.reduce((center, point) => ({ x: center.x + point.x / vertices.length, y: center.y + point.y / vertices.length }), { x: 0, y: 0 });
}

function boundsFromPoints(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function expandBounds(bounds, padding) {
  return {
    minX: bounds.minX - padding,
    maxX: bounds.maxX + padding,
    minY: bounds.minY - padding,
    maxY: bounds.maxY + padding,
  };
}

function entityBounds(entity) {
  if (entity.vertices?.length) return boundsFromPoints(entity.vertices);
  if (entity.controlPoints?.length) return boundsFromPoints(entity.controlPoints);
  if (entity.center && Number.isFinite(entity.radius)) {
    return { minX: entity.center.x - entity.radius, maxX: entity.center.x + entity.radius, minY: entity.center.y - entity.radius, maxY: entity.center.y + entity.radius };
  }
  return null;
}

function boundsIntersect(first, second) {
  return first && first.maxX >= second.minX && first.minX <= second.maxX && first.maxY >= second.minY && first.minY <= second.maxY;
}

function numberValue(value) {
  return Number(value).toFixed(4).replace(/\.0+$/, "");
}

function pointsPath(points, close = false) {
  if (!points?.length) return "";
  return `M ${points.map((point) => `${numberValue(point.x)} ${numberValue(point.y)}`).join(" L ")}${close ? " Z" : ""}`;
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

function entitySvg(entity, detailBounds, blocks, ancestors = []) {
  if (entity.inPaperSpace) return "";
  if (entity.type === "INSERT" || entity.type === "DIMENSION") {
    const name = entity.type === "INSERT" ? entity.name : entity.block;
    const block = blocks[name];
    if (!block || ancestors.includes(name) || ancestors.length >= 8) return "";
    const content = (block.entities || []).map((part) => entitySvg(part, null, blocks, [...ancestors, name])).join("");
    if (!content) return "";
    if (entity.type === "DIMENSION") return `<g>${content}</g>`;
    const position = entity.position || { x: 0, y: 0 };
    const base = block.position || { x: 0, y: 0 };
    const mirror = entity.extrusionDirection?.z < 0 ? "scale(-1 1) " : "";
    const transform = `${mirror}translate(${numberValue(position.x)} ${numberValue(position.y)}) rotate(${numberValue(entity.rotation || 0)}) scale(${numberValue(entity.xScale || 1)} ${numberValue(entity.yScale || 1)}) translate(${numberValue(-base.x)} ${numberValue(-base.y)})`;
    return `<g transform="${transform}">${content}</g>`;
  }
  if (detailBounds && !boundsIntersect(entityBounds(entity), detailBounds)) return "";
  if (entity.type === "LINE") return `<path class="dxf-detail" d="${pointsPath(entity.vertices)}" />`;
  if (["LWPOLYLINE", "POLYLINE"].includes(entity.type)) return `<path class="dxf-detail" d="${pointsPath(entity.vertices, entity.shape)}" />`;
  if (["ARC", "CIRCLE"].includes(entity.type) && entity.center) return `<path class="dxf-detail" d="${pointsPath(curvedPoints(entity), entity.type === "CIRCLE")}" />`;
  if (entity.type === "SPLINE" && entity.controlPoints?.length) return `<path class="dxf-detail" d="${pointsPath(entity.controlPoints)}" />`;
  return "";
}

function layoutViewBounds(source) {
  const viewports = [...source.matchAll(/(?:^|\r?\n)\s*0\r?\nVIEWPORT\r?\n([\s\S]*?)(?=\r?\n\s*0\r?\n)/g)];
  for (const viewport of viewports) {
    const lines = viewport[1].split(/\r?\n/);
    const groups = new Map();
    for (let index = 0; index + 1 < lines.length; index += 2) {
      groups.set(Number(lines[index].trim()), Number(lines[index + 1].trim()));
    }
    const paperWidth = groups.get(40);
    const paperHeight = groups.get(41);
    const viewHeight = groups.get(45);
    const centerX = groups.get(12);
    const centerY = groups.get(22);
    if (groups.get(67) !== 1 || groups.get(69) <= 1 || !paperWidth || !paperHeight || !viewHeight || !Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
    if (Math.abs(groups.get(51) || 0) > 0.001) continue;
    const viewWidth = viewHeight * paperWidth / paperHeight;
    return {
      minX: centerX - viewWidth / 2,
      maxX: centerX + viewWidth / 2,
      minY: centerY - viewHeight / 2,
      maxY: centerY + viewHeight / 2,
    };
  }
  return null;
}

function buildDxfModel(dxf, layoutBounds = null) {
  const entities = (dxf.entities || []).filter((entity) => !entity.inPaperSpace);
  const roomShapes = entities.filter((entity) => normalizedLayer(entity.layer) === "CHAMBRE" && isPolygon(entity));
  const bathrooms = entities.filter((entity) => normalizedLayer(entity.layer) === "SDB" && isPolygon(entity));
  const loggias = entities.filter((entity) => normalizedLayer(entity.layer) === "LOGGIA" && isPolygon(entity));
  const textEntities = entities
    .filter((entity) => normalizedLayer(entity.layer) === "A-AREA-IDEN" && ["TEXT", "MTEXT"].includes(entity.type))
    .map((entity) => ({ ...entity, point: entityPoint(entity), cleanText: cleanDxfText(entity.text) }))
    .filter((entity) => entity.point);
  const numberedTexts = [...new Map(textEntities.map((text) => {
    const number = roomNumberFromText(text.cleanText);
    return trackedRoomNumber(number) ? [number, { ...text, roomNumber: number }] : [null, null];
  }).filter(([number]) => number)).values()].sort((first, second) => first.roomNumber - second.roomNumber);

  if (!numberedTexts.length) throw new Error("Aucun numéro de chambre suivi trouvé dans A-AREA-IDEN");

  const rawBounds = boundsFromPoints(numberedTexts.map((text) => text.point));
  const width = rawBounds.maxX - rawBounds.minX;
  const height = rawBounds.maxY - rawBounds.minY;
  const padding = Math.max(2.5, Math.min(width, height) * 0.12);
  const labelBounds = expandBounds(rawBounds, padding);
  const shapePoints = [...roomShapes, ...bathrooms, ...loggias].flatMap((shape) => shape.vertices || []);
  const shapeBounds = shapePoints.length ? expandBounds(boundsFromPoints(shapePoints), Math.max(2.5, Math.min(width, height) * 0.08)) : null;
  const detailBounds = layoutBounds || shapeBounds || labelBounds;
  const loggiaLabels = entities
    .filter((entity) => ["A-AREA-IDEN", "LOGGIA"].includes(normalizedLayer(entity.layer)) && ["TEXT", "MTEXT"].includes(entity.type))
    .map((entity) => {
      const label = cleanDxfText(entity.text);
      const match = label.match(/^(?:(?:CHAMBRE|LOGGIA)\s*[-:]?\s*)?(\d{3})(?!\d)(?:$|\^J|\\P)/i);
      return { point: entityPoint(entity), number: match ? Number(match[1]) : null };
    })
    .filter((label) => label.point && trackedRoomNumber(label.number));
  const loggiaItems = loggias.map((shape) => {
    const numbers = [...new Set(loggiaLabels.filter((label) => pointInPolygon(label.point, shape.vertices)).map((label) => label.number))];
    return { polygon: shape.vertices, number: numbers.length === 1 ? numbers[0] : null, center: polygonCenter(shape.vertices) };
  });
  const typeTexts = textEntities.filter((text) => /STANDARD|JUNIOR|EXECUTIVE|EXÉCUTIVE|SUITE/i.test(text.cleanText));

  const detectedRooms = numberedTexts.map((numberText) => {
    const polygonEntity = roomShapes.find((shape) => pointInPolygon(numberText.point, shape.vertices));
    const nearestType = typeTexts
      .map((text) => ({ text, distance: Math.hypot(text.point.x - numberText.point.x, text.point.y - numberText.point.y) }))
      .sort((first, second) => first.distance - second.distance)[0];
    const polygon = polygonEntity?.vertices || null;
    return {
      number: numberText.roomNumber,
      typeText: nearestType?.distance < 2 ? nearestType.text.cleanText : "",
      polygon,
      center: polygon ? polygonCenter(polygon) : numberText.point,
      labelPoint: numberText.point,
      bathrooms: polygon ? bathrooms.filter((shape) => pointInPolygon(polygonCenter(shape.vertices), polygon)).map((shape) => shape.vertices) : [],
      loggias: polygon ? loggias.filter((shape) => pointInPolygon(polygonCenter(shape.vertices), polygon)).map((shape) => shape.vertices) : [],
    };
  });

  const architecture = entities.map((entity) => entitySvg(entity, detailBounds, dxf.blocks || {})).join("");
  const annotations = textEntities
    .filter((entity) => boundsIntersect({ minX: entity.point.x, maxX: entity.point.x, minY: entity.point.y, maxY: entity.point.y }, detailBounds))
    .filter((entity) => !/^(?:CHAMBRE|LOGGIA)\s*\d{3}/i.test(entity.cleanText))
    .map((entity) => `<text class="dxf-annotation" x="${numberValue(entity.point.x)}" y="${numberValue(-entity.point.y)}" font-size="${numberValue(Math.max(0.32, entity.height || 0.2))}">${escapeSvgText(entity.cleanText)}</text>`).join("");
  return { dxf, rooms: detectedRooms, loggias: loggiaItems, bounds: detailBounds, architecture, annotations };
}

function escapeSvgText(value) {
  return String(value).replace(/\^J/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDxfBase() {
  const model = state.dxfModel;
  if (!model) return;
  const width = model.bounds.maxX - model.bounds.minX;
  const height = model.bounds.maxY - model.bounds.minY;
  state.planAspect = width / height;
  elements.planContent.style.setProperty("--plan-aspect", state.planAspect);
  elements.dxfPlan.setAttribute("viewBox", `${numberValue(model.bounds.minX)} ${numberValue(-model.bounds.maxY)} ${numberValue(width)} ${numberValue(height)}`);
  const labelSize = Math.max(0.32, Math.min(0.55, height * 0.012));
  const labels = model.rooms.map((room) => {
    const x = numberValue(room.labelPoint.x);
    const y = numberValue(-room.labelPoint.y);
    return `<g class="dxf-room-marker" data-room-marker data-room="${room.number}" role="button" tabindex="0" aria-label="Chambre ${room.number}">
      <circle class="dxf-room-hit" cx="${x}" cy="${y}" r="${numberValue(labelSize * 1.8)}" />
      <text class="dxf-label" x="${x}" y="${y}" font-size="${numberValue(labelSize)}" text-anchor="middle">${room.number}</text>
      <title>Chambre ${room.number}</title>
    </g>`;
  }).join("");
  elements.dxfPlan.innerHTML = `<g transform="scale(1 -1)">${model.architecture}</g><g id="dxfZoneLayer" transform="scale(1 -1)"></g><g>${model.annotations}${labels}</g><g id="dxfZoneLabels"></g>`;
  elements.planEmpty.hidden = true;
}

function statusClass(record) {
  if (record.blocked) return "status-blocked";
  if (record.progress >= 100) return "status-done";
  if (record.progress > 0) return "status-in-progress";
  return "status-not-started";
}

function renderDxfZones() {
  const model = state.dxfModel;
  const layer = document.querySelector("#dxfZoneLayer");
  const labelLayer = document.querySelector("#dxfZoneLabels");
  if (!model || !layer || !labelLayer) return;
  if (state.selectedZone === "loggia") {
    layer.innerHTML = model.loggias.map((loggia) => {
      const assigned = loggia.number !== null;
      const task = state.selectedTask;
      const record = assigned && task ? getRecord(loggia.number, "loggia", task) : null;
      const zoneClass = (state.selectedType !== "all" || state.selectedBlock !== "all") && (!assigned || !roomMatchesFilters(loggia.number))
        ? "filtered-out" : record ? statusClass(record) : "unassigned";
      const selectedClass = assigned && loggia.number === state.selectedRoom ? " selected" : "";
      const roomAttribute = assigned ? ` data-room="${loggia.number}"` : "";
      const label = assigned ? `Loggia de la chambre ${loggia.number}` : "Loggia non attribuée";
      return `<path class="dxf-zone ${zoneClass}${selectedClass}"${roomAttribute} d="${pointsPath(loggia.polygon, true)}"><title>${label}</title></path>`;
    }).join("");
    const height = model.bounds.maxY - model.bounds.minY;
    const labelSize = Math.max(0.32, Math.min(0.55, height * 0.012));
    labelLayer.innerHTML = model.loggias.filter((loggia) => loggia.number !== null).map((loggia) =>
      `<text class="dxf-loggia-label${roomMatchesFilters(loggia.number) ? "" : " filtered-out"}" x="${numberValue(loggia.center.x)}" y="${numberValue(-loggia.center.y)}" font-size="${numberValue(labelSize)}" text-anchor="middle">${loggia.number}</text>`).join("");
    return;
  }
  labelLayer.innerHTML = "";
  layer.innerHTML = model.rooms.map((room) => {
    const task = state.selectedTask;
    const record = task ? getRecord(room.number, state.selectedZone, task) : null;
    const activeClass = room.number === state.selectedRoom ? " selected" : "";
    let paths = [];
    if (state.selectedZone === "bathroom") paths = room.bathrooms.map((polygon) => pointsPath(polygon, true));
    if (state.selectedZone === "bedroom" && room.polygon) paths = [`${pointsPath(room.polygon, true)} ${[...room.bathrooms, ...room.loggias].map((polygon) => pointsPath(polygon, true)).join(" ")}`];
    const zoneClass = roomMatchesFilters(room.number) ? (record ? statusClass(record) : "unassigned") : "filtered-out";
    return paths.map((path) => `<path class="dxf-zone ${zoneClass}${activeClass}" data-room="${room.number}" d="${path}" fill-rule="evenodd"><title>Chambre ${room.number}</title></path>`).join("");
  }).join("");
}

function getRecord(room, zone, task) {
  return state.records[`${room}:${zone}:${task}`] || { progress: 0, blocked: false, note: "", startDate: "", endDate: "" };
}

function resetCorrectionState() {
  state.correctionAuthorization = null;
  state.correctionPanelOpen = false;
  state.progressRuleMessage = "";
  elements.correctionReason.value = "";
  elements.correctionNote.value = "";
  elements.correctionError.hidden = true;
}

function updateRecord(changes) {
  if (!canEditSelectedRoom() || saving) return;
  const key = `${state.selectedRoom}:${state.selectedZone}:${state.selectedTask}`;
  const current = getRecord(state.selectedRoom, state.selectedZone, state.selectedTask);
  state.records[key] = { ...current, ...changes };
  void persistProject(key, state.correctionAuthorization, current);
  render();
}

function updateProgress(value) {
  if (!canEditSelectedRoom() || saving) return;
  const progress = Math.max(0, Math.min(100, Number(value || 0)));
  const key = `${state.selectedRoom}:${state.selectedZone}:${state.selectedTask}`;
  const current = getRecord(state.selectedRoom, state.selectedZone, state.selectedTask);
  if (progress < lockedProgress(current) && !state.correctionAuthorization) {
    state.progressRuleMessage = current.progress >= 100
      ? "Une valeur validée un jour précédent nécessite une justification pour être diminuée."
      : "Cette diminution passe sous l’avancement validé un jour précédent. Justifiez la correction.";
    renderEditor();
    return;
  }
  const correction = progress < current.progress && state.correctionAuthorization ? {
    lastCorrectionReason: state.correctionAuthorization.reason,
    lastCorrectionNote: state.correctionAuthorization.note,
    correctedAt: new Date().toISOString(),
  } : {};
  state.records[key] = { ...current, ...correction, progress };
  const authorization = state.correctionAuthorization;
  if (progress < current.progress || progress >= 100) resetCorrectionState();
  else state.progressRuleMessage = "";
  void persistProject(key, authorization, current);
  elements.percentOutput.textContent = `${progress} %`;
  elements.percentInput.value = progress;
  elements.progressRange.value = progress;
  renderSummary();
  renderTaskList();
  renderDxfZones();
  renderEditor();
}

function roomAccessible(number) {
  const room=rooms.find(r=>r.number===number);
  if(!accessReady || !room)return false;
  if(localMode || currentUser?.role==="admin" || currentUser?.role==="viewer")return true;
  return cloud?.snapshot?.tasks.some(t=>t.key.startsWith(number+":") && editable(cloud.snapshot,currentUser.id,t.key)) || false;
}

function canEditSelectedRoom() {
  if(localMode || !currentUser || currentUser.role==="viewer")return false;
  return Boolean(cloud?.snapshot && editable(cloud.snapshot,currentUser?.id,
    state.selectedRoom+":"+state.selectedZone+":"+state.selectedTask,Boolean(state.correctionAuthorization)));
}

function roomTypeId(number) {
  const configuredType = rooms.find((room) => room.number === number)?.roomType;
  if (configuredType) return configuredType;
  const importedType = state.importedTypes[number] || "";
  if (/EXECUTIVE|EXÉCUTIVE/i.test(importedType)) return "executive";
  if (/JUNIOR|SUITE/i.test(importedType)) return "junior";
  if (/STANDARD/i.test(importedType)) return "standard";
  return "standard";
}

function roomType(number) {
  return { executive: "Exécutive", junior: "Junior Suite", standard: "Standard" }[roomTypeId(number)];
}

function roomMatchesType(number) {
  return state.selectedType === "all" || roomTypeId(number) === state.selectedType;
}

function roomMatchesBlock(number) {
  const blockId = rooms.find((room) => room.number === number)?.blockId;
  return state.selectedBlock === "all" || blockId === state.selectedBlock;
}

function roomMatchesFilters(number) {
  return roomAccessible(number) && roomMatchesType(number) && roomMatchesBlock(number);
}

function currentTasks(zone=state.selectedZone) {
  const base=tasksByZone[zone];
  if(localMode || !cloud?.snapshot?.taskTypes) return base;
  return base.flatMap(task=>{
    const type=cloud.snapshot.taskTypes.find(t=>t.zone===zone && t.code===task.id);
    return type ? [{...task,label:type.label}] : [];
  });
}

function taskCandidate(zone,task) { return {id:task.id,label:task.label,group:taskGroup(zone,task.sourceColumn)}; }
function selectedTaskCandidate() {
  const task=currentTasks().find(item=>item.id===state.selectedTask);
  return task?taskCandidate(state.selectedZone,task):null;
}
function selectTask(taskId) {
  resetCorrectionState();state.selectedTask=taskId;
  if(state.pinnedTask&&taskId)state.pinnedTask=selectedTaskCandidate();
  render();
}

function taskTypeOrder(type) {
  const definitions=tasksByZone[type.zone] || [];
  const definitionIndex=definitions.findIndex(task=>task.id===type.code);
  if(definitionIndex >= 0)return definitionIndex;
  const storedOrder=Number(type.sort_order);
  return Number.isFinite(storedOrder) ? storedOrder : Number.MAX_SAFE_INTEGER;
}

function normalizeTaskSelection() {
  const tasks = currentTasks();
  if (!tasks.some((task) => task.id === state.selectedTask)) state.selectedTask = "";
}

function renderTypeTabs() {
  document.querySelectorAll("[data-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === state.selectedType);
    button.classList.toggle("filtered-out", state.selectedType !== "all" && button.dataset.type !== "all" && button.dataset.type !== state.selectedType);
    button.disabled = button.dataset.type !== "all" && !rooms.some((room) => roomMatchesBlock(room.number) && roomTypeId(room.number) === button.dataset.type);
  });
}

function renderBlockTabs() {
  document.querySelectorAll("[data-block]").forEach((button) => {
    button.classList.toggle("active", button.dataset.block === state.selectedBlock);
    button.classList.toggle("filtered-out", state.selectedBlock !== "all" && button.dataset.block !== "all" && button.dataset.block !== state.selectedBlock);
    button.disabled = (button.dataset.block !== "all" && !rooms.some((room) => room.blockId === button.dataset.block && roomMatchesType(room.number)));
  });
}

function renderRoomSelect() {
  const options = rooms.filter((room) => roomMatchesFilters(room.number));
  elements.roomSelect.innerHTML = options.map((room) => `<option value="${room.number}">${room.number} - ${roomType(room.number)}</option>`).join("");
  elements.roomSelect.value = String(state.selectedRoom);
}

function renderZoneTabs() {
  document.querySelectorAll("[data-zone]").forEach((button) => {
    const zone = button.dataset.zone;
    button.classList.toggle("active", zone === state.selectedZone);
    if (button.closest("#detailZoneTabs") && zone === "loggia") {
      button.disabled = !loggiaRooms.has(state.selectedRoom);
      button.title = button.disabled ? "Cette chambre n'a pas de loggia" : "";
    }
  });
}

function renderTaskSelect() {
  const tasks = currentTasks();
  const groups = new Map();
  for (const task of tasks) {
    const group = taskGroup(state.selectedZone, task.sourceColumn);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(task);
  }
  elements.taskSelect.innerHTML = tasks.length ? '<option value="">Choisir une tâche</option>'+[...groups.entries()].map(([group, groupTasks]) =>
    `<optgroup label="${group}">${groupTasks.map((task) => `<option value="${task.id}">${escapeSvgText(task.label)}</option>`).join("")}</optgroup>`).join("")
    : '<option value="">Tâches à définir</option>';
  elements.taskSelect.disabled = !tasks.length;
  elements.taskSelect.value = state.selectedTask;
}

function renderTaskPin() {
  const selected=selectedTaskCandidate(),button=document.querySelector("#taskPinButton"),label=document.querySelector("#taskPinLabel");
  button.disabled=!selected&&!state.pinnedTask;
  button.setAttribute("aria-pressed",String(Boolean(state.pinnedTask)));
  button.textContent=state.pinnedTask?"Tâche fixée":"Garder fixe";
  label.textContent=selected?`${selected.group} — ${selected.label}`:state.pinnedTask?`${state.pinnedTask.group} — indisponible dans cette zone`:"Aucune tâche sélectionnée";
}

function filteredRooms() {
  return rooms.filter((room) => roomMatchesFilters(room.number) && (state.selectedZone !== "loggia" || loggiaRooms.has(room.number)));
}

function renderSummary() {
  const availableRooms = filteredRooms();
  if (!state.selectedTask) {
    elements.summaryStrip.innerHTML = `<span class="summary-item"><strong>${availableRooms.length}</strong> ${state.selectedZone === "loggia" ? "loggias" : "chambres"}</span>
      <span class="summary-item">Choisissez une tâche pour afficher son avancement</span>`;
    return;
  }
  const records = availableRooms.map((room) => getRecord(room.number, state.selectedZone, state.selectedTask));
  const done = records.filter((record) => record.progress >= 100).length;
  const inProgress = records.filter((record) => record.progress > 0 && record.progress < 100).length;
  const blocked = records.filter((record) => record.blocked).length;
  const notStarted = records.filter((record) => record.progress === 0).length;
  elements.summaryStrip.innerHTML = `<span class="summary-item"><strong>${availableRooms.length}</strong> ${state.selectedZone === "loggia" ? "loggias" : "chambres"}</span>
    <span class="summary-item"><strong>${done}</strong> terminées</span>
    <span class="summary-item"><strong>${inProgress}</strong> en cours</span>
    <span class="summary-item"><strong>${notStarted}</strong> non commencées</span>
    <span class="summary-item"><strong>${blocked}</strong> bloquées</span>`;
}

function renderRoomHeading() {
  elements.roomTitle.textContent = `Chambre ${state.selectedRoom}`;
  elements.roomType.textContent = roomType(state.selectedRoom);
}

function renderTaskList() {
  // Keep the existing editor and its event listeners when rebuilding task rows.
  elements.taskList.after(elements.taskEditor);
  const expandedGroups=new Set([...elements.taskList.querySelectorAll("details[open]")].map(group=>group.dataset.group));
  if (!roomAccessible(state.selectedRoom)) {
    elements.taskList.innerHTML = '<div class="empty-state">Votre administrateur doit vous affecter une tâche pour commencer.</div>';
    elements.taskEditor.hidden = true;
    return;
  }
  const tasks = currentTasks();
  if (!tasks.length) {
    elements.taskList.innerHTML = '<div class="empty-state">Les tâches de la loggia seront ajoutées lors de la prochaine définition.</div>';
    elements.taskEditor.hidden = true;
    return;
  }
  elements.taskEditor.hidden = !currentUser || !state.selectedTask;
  const query = state.taskQuery.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const visibleTasks = tasks.filter((task) => task.label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(query));
  const groups = new Map();
  for (const task of visibleTasks) {
    const group = taskGroup(state.selectedZone, task.sourceColumn);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(task);
  }
  elements.taskSearch.value = state.taskQuery;
  elements.taskList.innerHTML = groups.size ? [...groups.entries()].map(([group, groupTasks]) => `
    <details class="task-group" data-group="${group}" ${query || expandedGroups.has(group) || groupTasks.some(task=>task.id===state.selectedTask) ? "open" : ""}>
      <summary>${group}<span>${groupTasks.length}</span></summary>
      <div class="task-group-items">${groupTasks.map((task) => {
        const record = getRecord(state.selectedRoom, state.selectedZone, task.id);
        const active = task.id === state.selectedTask ? " active" : "";
        const complete = record.progress >= 100 ? " complete" : "";
        return `<button class="task-row${active}" type="button" data-task="${task.id}">
          <span class="task-name">${escapeSvgText(task.label)}</span><span class="task-percent">${record.progress} %</span>
          ${record.blocked ? '<span class="blocked-tag">Bloquée</span>' : ""}
          <span class="task-track"><i class="${complete}" style="width:${record.progress}%"></i></span>
        </button>`;
      }).join("")}</div>
    </details>`).join("") : '<div class="empty-state">Aucune tâche trouvée.</div>';
  elements.taskList.querySelector(".task-row.active")?.after(elements.taskEditor);
}

function renderEditor() {
  const task = currentTasks().find((item) => item.id === state.selectedTask);
  if (!task) return;
  const record = getRecord(state.selectedRoom, state.selectedZone, state.selectedTask);
  elements.editorTaskTitle.textContent = task.label;
  elements.percentOutput.textContent = `${record.progress} %`;
  elements.percentInput.value = record.progress;
  elements.progressRange.value = record.progress;
  elements.blockedInput.checked = record.blocked;
  elements.noteInput.value = record.note;
  const correctionAuthorized = Boolean(state.correctionAuthorization);
  document.querySelector("#correctionNoteLabel").textContent=elements.correctionReason.value==="input-error" ? "Explication (facultative)" : "Explication (obligatoire)";
  elements.correctionNote.required=elements.correctionReason.value!=="input-error";
  const locked = !canEditSelectedRoom() || saving;
  document.querySelector("#addTaskPhoto").disabled = locked || !cloud;
  document.querySelector("#viewTaskPhotos").disabled = !cloud;
  elements.taskLock.hidden = !locked;
  elements.correctionTrigger.hidden = (!canEditSelectedRoom() && currentUser?.role !== "admin") || record.progress <= 0 || correctionAuthorized || state.correctionPanelOpen;
  elements.correctionPanel.hidden = (!canEditSelectedRoom() && currentUser?.role !== "admin") || !state.correctionPanelOpen;
  elements.correctionAuthorized.hidden = !correctionAuthorized;
  elements.correctionAuthorized.textContent = correctionAuthorized
    ? `Correction autorisée : ${state.correctionAuthorization.reason === "input-error" ? "Erreur de saisie" : "Élément oublié ou ajouté"}`
    : "";
  elements.correctionHistory.hidden = !record.lastCorrectionReason;
  elements.correctionHistory.textContent = record.lastCorrectionReason
    ? `Dernière correction : ${record.lastCorrectionReason === "input-error" ? "Erreur de saisie" : "Élément oublié ou ajouté"} - ${record.lastCorrectionNote || "Sans détail"}`
    : "";
  elements.progressRuleMessage.hidden = !state.progressRuleMessage;
  elements.progressRuleMessage.textContent = state.progressRuleMessage;
  elements.progressRange.disabled = locked;
  elements.percentInput.disabled = locked;
  elements.blockedInput.disabled = locked;
  elements.noteInput.disabled = locked;
  document.querySelectorAll("[data-progress]").forEach((button) => { button.disabled = locked; });
}

function renderZoom() {
  elements.planContent.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom / 100})`;
  elements.zoomRange.value = state.zoom;
  elements.zoomValue.textContent = `${Math.round(state.zoom)} %`;
}

function renderRoomSelection() {
  elements.dxfPlan.querySelectorAll("[data-room-marker]").forEach((marker) => {
    const number = Number(marker.dataset.room);
    marker.classList.toggle("selected", number === state.selectedRoom);
    marker.classList.toggle("filtered-out", !roomMatchesFilters(number));
  });
}

function render() {
  normalizeTaskSelection();
  renderBlockTabs();
  renderTypeTabs();
  renderRoomSelect();
  renderZoneTabs();
  renderTaskSelect();
  renderTaskPin();
  renderSummary();
  renderRoomHeading();
  renderTaskList();
  renderEditor();
  renderDxfZones();
  renderRoomSelection();
  renderZoom();
  renderAccessShell();
}

function centerOnRoom(number) {
  const model = state.dxfModel;
  const room = model?.rooms.find((item) => item.number === number);
  if (!room) return;
  const width = model.bounds.maxX - model.bounds.minX;
  const height = model.bounds.maxY - model.bounds.minY;
  const planX = (room.labelPoint.x - model.bounds.minX) / width * elements.planContent.clientWidth;
  const planY = (model.bounds.maxY - room.labelPoint.y) / height * elements.planContent.clientHeight;
  state.zoom = Math.max(state.zoom, 170);
  const scale = state.zoom / 100;
  state.panX = elements.planViewport.clientWidth / 2 - planX * scale;
  state.panY = elements.planViewport.clientHeight / 2 - planY * scale;
  renderZoom();
}

function selectRoom(number, center = false) {
  if (!roomAccessible(number)) return;
  resetCorrectionState();
  state.selectedRoom = number;
  if(!state.pinnedTask)state.selectedTask = "";
  if (!roomMatchesType(number)) state.selectedType = "all";
  render();
  if (center) centerOnRoom(number);
  if (currentUser) localStorage.setItem(`pistache-room:${currentUser.id}`, String(number));
}

function setZone(zone) {
  const pinned=state.pinnedTask || selectedTaskCandidate();
  resetCorrectionState();
  state.selectedZone = zone;
  state.selectedTask = state.pinnedTask&&pinned ? findPinnedTask(pinned,currentTasks(zone).map(task=>taskCandidate(zone,task)))?.id || "" : "";
  state.taskQuery = "";
  render();
}

function setType(type) {
  if (type !== "all" && !rooms.some((room) => roomMatchesBlock(room.number) && roomTypeId(room.number) === type)) return;
  resetCorrectionState();
  state.selectedType = type;
  const changedRoom = !roomMatchesFilters(state.selectedRoom);
  if (changedRoom) {
    state.selectedRoom = rooms.find((room) => roomMatchesFilters(room.number))?.number ?? null;
    if(!state.pinnedTask)state.selectedTask = "";
  }
  render();
}

function setBlock(block) {
  if (block !== "all" && !rooms.some((room) => room.blockId === block && roomMatchesType(room.number))) return;
  resetCorrectionState();
  state.selectedBlock = block;
  const changedRoom = !roomMatchesFilters(state.selectedRoom);
  if (changedRoom) {
    state.selectedRoom = rooms.find((room) => roomMatchesFilters(room.number))?.number ?? null;
    if(!state.pinnedTask)state.selectedTask = "";
  }
  render();
}

function setZoom(value, anchorX = elements.planViewport.clientWidth / 2, anchorY = elements.planViewport.clientHeight / 2) {
  const oldScale = state.zoom / 100;
  const nextZoom = Math.max(10, Math.min(400, Number(value)));
  const newScale = nextZoom / 100;
  state.panX = anchorX - ((anchorX - state.panX) * newScale / oldScale);
  state.panY = anchorY - ((anchorY - state.panY) * newScale / oldScale);
  state.zoom = nextZoom;
  renderZoom();
}

function fitPlan() {
  const viewportWidth = elements.planViewport.clientWidth;
  const viewportHeight = elements.planViewport.clientHeight;
  const planWidth = Math.max(1, viewportWidth - 32);
  const planHeight = planWidth / state.planAspect;
  const widePlanBoost = state.planAspect > 2.35 && viewportWidth < 700
    ? Math.min(2.4, Math.max(1, (viewportHeight * 0.62) / planHeight))
    : 1;
  const scale = Math.min(widePlanBoost, (viewportWidth - 32) / planWidth * widePlanBoost, (viewportHeight - 32) / planHeight);
  state.zoom = Math.max(10, Math.floor(scale * 10) * 10);
  const fittedScale = state.zoom / 100;
  state.panX = (viewportWidth - planWidth * fittedScale) / 2;
  state.panY = (viewportHeight - planHeight * fittedScale) / 2;
  renderZoom();
}

document.addEventListener("click", (event) => {
  if (suppressPlanClick && event.target.closest("#planViewport")) {
    suppressPlanClick = false;
    return;
  }
  const typeButton = event.target.closest("[data-type]");
  if (typeButton) setType(typeButton.dataset.type);
  const blockButton = event.target.closest("[data-block]");
  if (blockButton) setBlock(blockButton.dataset.block);
  const zoneButton = event.target.closest("[data-zone]");
  if (zoneButton && !zoneButton.disabled) setZone(zoneButton.dataset.zone);
  const roomShape = event.target.closest("[data-room]");
  if (roomShape) selectRoom(Number(roomShape.dataset.room));
  const taskButton = event.target.closest("[data-task]");
  if (taskButton) selectTask(taskButton.dataset.task);
  const quickButton = event.target.closest("[data-progress]");
  if (quickButton) updateProgress(quickButton.dataset.progress);
});

document.addEventListener("keydown", (event) => {
  const marker = event.target.closest?.("[data-room-marker]");
  if (marker && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    selectRoom(Number(marker.dataset.room));
  }
});

elements.taskSelect.addEventListener("change", (event) => selectTask(event.target.value));
document.querySelector("#taskPinButton").addEventListener("click",()=>{
  const selected=selectedTaskCandidate();
  if(state.pinnedTask)state.pinnedTask=null;
  else if(selected)state.pinnedTask=selected;
  renderTaskPin();
});
elements.taskSearch.addEventListener("input", (event) => {
  state.taskQuery = event.target.value;
  renderTaskList();
});
elements.correctionTrigger.addEventListener("click", () => {
  if (!canEditSelectedRoom() && currentUser?.role !== "admin") return;
  state.correctionPanelOpen = true;
  state.progressRuleMessage = "";
  elements.correctionError.hidden = true;
  renderEditor();
});
elements.correctionReason.addEventListener("change", renderEditor);

elements.authorizeCorrection.addEventListener("click", () => {
  if (!canEditSelectedRoom() && currentUser?.role !== "admin") return;
  const reason = elements.correctionReason.value;
  const note = elements.correctionNote.value.trim();
  if (!reason || (reason !== "input-error" && !note)) {
    elements.correctionError.textContent = "Choisissez un motif. Une explication est obligatoire pour un élément oublié ou ajouté.";
    elements.correctionError.hidden = false;
    return;
  }
  state.correctionAuthorization = { reason, note };
  state.correctionPanelOpen = false;
  state.progressRuleMessage = "Vous pouvez maintenant saisir une valeur inférieure.";
  elements.correctionError.hidden = true;
  renderEditor();
});
elements.cancelCorrection.addEventListener("click", () => {
  resetCorrectionState();
  renderEditor();
});
elements.roomSelect.addEventListener("change", (event) => {
  selectRoom(Number(event.target.value), true);
});
elements.progressRange.addEventListener("change", (event) => {
  updateProgress(event.target.value);
});
elements.percentInput.addEventListener("change", (event) => updateProgress(event.target.value));
elements.blockedInput.addEventListener("change", (event) => updateRecord({ blocked: event.target.checked }));
elements.noteInput.addEventListener("change", (event) => updateRecord({ note: event.target.value.trim() }));
document.querySelector("#zoomIn").addEventListener("click", () => setZoom(state.zoom + 25));
document.querySelector("#zoomOut").addEventListener("click", () => setZoom(state.zoom - 25));
document.querySelector("#fitPlan").addEventListener("click", fitPlan);
elements.zoomRange.addEventListener("input", (event) => setZoom(event.target.value));
elements.planViewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = elements.planViewport.getBoundingClientRect();
  setZoom(state.zoom + (event.deltaY < 0 ? 20 : -20), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

let dragState = null;
let suppressPlanClick = false;

elements.planViewport.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" || event.button !== 0) return;
  dragState = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false };
});

elements.planViewport.addEventListener("pointermove", (event) => {
  if (!dragState) return;
  const distance = Math.hypot(event.clientX - dragState.x, event.clientY - dragState.y);
  if (!dragState.moved && distance < 4) return;
  if (!dragState.moved) {
    dragState.moved = true;
    elements.planViewport.setPointerCapture(event.pointerId);
    elements.planViewport.classList.add("dragging");
  }
  state.panX = dragState.panX + event.clientX - dragState.x;
  state.panY = dragState.panY + event.clientY - dragState.y;
  renderZoom();
});

function stopDragging(event) {
  if (!dragState) return;
  if (elements.planViewport.hasPointerCapture(event.pointerId)) elements.planViewport.releasePointerCapture(event.pointerId);
  if (dragState.moved) {
    suppressPlanClick = true;
    window.setTimeout(() => { suppressPlanClick = false; }, 0);
  }
  dragState = null;
  elements.planViewport.classList.remove("dragging");
}

elements.planViewport.addEventListener("pointerup", stopDragging);
elements.planViewport.addEventListener("pointercancel", stopDragging);

// One finger pans the plan; two fingers pinch around their midpoint.
let pinchState=null, touchPan=null, touchMoved=false;
function touchGeometry(touches) {
  const rect=elements.planViewport.getBoundingClientRect(),[a,b]=touches;
  return {x:(a.clientX+b.clientX)/2-rect.left,y:(a.clientY+b.clientY)/2-rect.top,
    distance:Math.max(1,Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY))};
}
function beginPlanTouch(event) {
  if(event.touches.length===2) {
    event.preventDefault();pinchState=touchGeometry(event.touches);touchPan=null;touchMoved=true;suppressPlanClick=true;
  } else if(event.touches.length===1) {
    const t=event.touches[0];touchPan={x:t.clientX,y:t.clientY};pinchState=null;
  }
}
elements.planViewport.addEventListener('touchstart',beginPlanTouch,{passive:false});
elements.planViewport.addEventListener('touchmove',event=>{
  event.preventDefault();
  if(event.touches.length===2) {
    const next=touchGeometry(event.touches);
    if(pinchState) {
      setZoom(state.zoom*next.distance/pinchState.distance,pinchState.x,pinchState.y);
      state.panX+=next.x-pinchState.x;state.panY+=next.y-pinchState.y;
    }
    pinchState=next;touchPan=null;touchMoved=true;
  } else if(event.touches.length===1 && touchPan) {
    const t=event.touches[0],dx=t.clientX-touchPan.x,dy=t.clientY-touchPan.y;
    if(!touchMoved && Math.hypot(dx,dy)<4)return;
    state.panX+=dx;state.panY+=dy;touchPan={x:t.clientX,y:t.clientY};touchMoved=true;
  }
  if(touchMoved)suppressPlanClick=true;
  renderZoom();
},{passive:false});
function endPlanTouch(event) {
  if(touchMoved && event.cancelable)event.preventDefault();
  pinchState=null;touchPan=null;
  if(event.type!=='touchcancel' && event.touches.length) {beginPlanTouch(event);return;}
  if(touchMoved)window.setTimeout(()=>{suppressPlanClick=false;},350);
  touchMoved=false;
}
elements.planViewport.addEventListener('touchend',endPlanTouch,{passive:false});
elements.planViewport.addEventListener('touchcancel',endPlanTouch,{passive:false});

let planLoadVersion = 0;
async function loadDxfSource(source, name, size, version = ++planLoadVersion) {
  elements.importStatus.classList.remove("error");
  elements.importStatus.textContent = "Analyse du DXF...";
  await new Promise((resolve) => window.setTimeout(resolve, 20));

  try {
    if (version !== planLoadVersion) return;
    const parser = new window.DxfParser();
    const dxf = parser.parseSync(source);
    const model = buildDxfModel(dxf, layoutViewBounds(source));
    state.dxfModel = model;
    state.importedTypes = Object.fromEntries(model.rooms.map((room) => [room.number, room.typeText]));
    const definitions=roomDefinitions();
    rooms = model.rooms.map((room) => definitions.get(room.number) || {
      id: `${state.selectedFloor}-${room.number}`,
      floorId: state.selectedFloor,
      number: room.number,
      blockId: null,
      roomType: "standard",
    });
    loggiaRooms.clear();
    model.loggias.filter((loggia) => loggia.number !== null).forEach((loggia) => loggiaRooms.add(loggia.number));
    state.selectedRoom = rooms[0].number;
    if(!state.pinnedTask)state.selectedTask = "";
    state.selectedType = "all";
    renderDxfBase();
    render();
    window.requestAnimationFrame(fitPlan);

    const bathroomCount = model.rooms.reduce((count, room) => count + room.bathrooms.length, 0);
    const loggiaCount = model.rooms.reduce((count, room) => count + room.loggias.length, 0);
    const metadata = { name, size, extension: "dxf", rooms: model.rooms.length, bathroomCount, loggiaCount };
    if (activeProjectDefinition) {
      localStorage.setItem(`suivi-hotel-import-meta:${activeProjectDefinition.id}:${state.selectedFloor}`, JSON.stringify(metadata));
    }
    elements.importStatus.textContent = "";
    elements.importStatus.title = `${name} - ${bathroomCount} SDB - ${loggiaCount} loggias associées`;
  } catch (error) {
    console.error(error);
    elements.importStatus.textContent = error.message || "DXF illisible";
    elements.importStatus.classList.add("error");
  }
}

function clearPlan(message) {
  state.dxfModel = null;
  state.importedTypes = {};
  rooms = ROOMS_BY_FLOOR[state.selectedFloor] || [];
  loggiaRooms.clear();
  state.selectedRoom = rooms[0]?.number ?? null;
  state.selectedBlock = "all";
  state.selectedType = "all";
  state.selectedZone = "bedroom";
  if(!state.pinnedTask)state.selectedTask = "";
  elements.dxfPlan.innerHTML = "";
  elements.planEmpty.hidden = false;
  elements.planEmpty.textContent = message;
  render();
}

async function loadConfiguredPlan(projectDefinition) {
  const version = ++planLoadVersion;
  const floor=floorDefinition();
  if (!floor?.dxfPath) {
    clearPlan("Le plan DXF de cet étage n'est pas encore configuré pour ce projet.");
    elements.importStatus.textContent = "Plan à configurer";
    elements.importStatus.classList.add("error");
    return;
  }
  state.dxfModel = null;
  state.importedTypes = {};
  elements.dxfPlan.innerHTML = "";
  elements.planEmpty.hidden = false;
  elements.planEmpty.textContent = "Chargement du plan " + (floor.label || state.selectedFloor) + "...";
  elements.importStatus.classList.remove("error");
  elements.importStatus.textContent = "Chargement du plan " + (floor.label || state.selectedFloor) + "...";
  try {
    const response = await fetch(`${floor.dxfPath}?v=${encodeURIComponent(String(floor.updatedAt || ""))}`);
    if (!response.ok) throw new Error(`Plan introuvable (${response.status})`);
    const source = await response.text();
    const name = floor.dxfPath.split("/").at(-1) || "plan.dxf";
    if (version !== planLoadVersion) return;
    await loadDxfSource(source, name, source.length, version);
  } catch (error) {
    if (version !== planLoadVersion) return;
    console.error("Plan DXF du projet illisible", error);
    clearPlan("Le plan DXF configuré pour ce projet ne peut pas être chargé.");
    elements.importStatus.textContent = error instanceof Error ? error.message : "Plan DXF illisible";
    elements.importStatus.classList.add("error");
  }
}

async function openProject(projectId) {
  showAppLoading(localMode?"Préparation du plan…":"Chargement de vos données…");
  if(localMode) {
    const definition=PROJECT_CATALOG.find(p=>p.id===projectId);if(!definition)return;
    activeProjectDefinition=definition;
    projectRepository=createProjectRepository(localStorage,definition.id);
    project=await projectRepository.load();
  } else {
    project=await cloud.open(projectId);
    currentUser={...cloud.user,role:cloud.snapshot.role};
    activeProjectDefinition={...PROJECT_CATALOG[0],id:projectId,name:cloud.snapshot.name};
  }
  const floors=activeProjectDefinition.floors || [{id:CURRENT_FLOOR,label:"R+2"}];
  if(!floors.some((floor)=>floor.id===state.selectedFloor)) state.selectedFloor=floors[0].id;
  elements.floorSelect.innerHTML=floors.map((floor)=>'<option value="'+floor.id+'">'+escapeSvgText(floor.label)+'</option>').join("");
  elements.floorSelect.value=state.selectedFloor;
  state.records=currentFloorRecords();
  elements.projectSubtitle.textContent=activeProjectDefinition.name+" — "+(floorDefinition()?.label || state.selectedFloor);
  elements.projectDialog.close();
  accessReady=true;trackingMode=null;adminPage="dashboard";state.selectedBlock="all";state.selectedType="all";
  state.selectedRoom=rooms.find(r=>roomAccessible(r.number))?.number ?? null;
  render();
  hideAppLoading();
  if(!localMode){await renderSync();void syncCloud();}
  document.querySelector("#trackingModeDialog").showModal();
}

async function changeFloor(floorId) {
  await saveQueue;
  if (floorId === state.selectedFloor) return;
  state.selectedFloor=floorId;
  elements.floorSelect.value=floorId;
  state.records=currentFloorRecords();
  state.selectedBlock="all";
  state.selectedType="all";
  if(!state.pinnedTask)state.selectedTask="";
  elements.projectSubtitle.textContent=activeProjectDefinition.name+" — "+(floorDefinition()?.label || state.selectedFloor);
  await loadConfiguredPlan(activeProjectDefinition);
  state.selectedRoom=rooms.find(r=>roomAccessible(r.number))?.number ?? null;
  render();
}

elements.floorSelect.addEventListener("change", () => { void changeFloor(elements.floorSelect.value); });
elements.floorSelect.addEventListener("input", () => { void changeFloor(elements.floorSelect.value); });

elements.projectList.innerHTML = PROJECT_CATALOG.map((definition) => `
  <button class="project-choice" type="button" data-project-id="${definition.id}">
    <strong>${definition.name}</strong>
    <span>${definition.description}</span>
  </button>`).join("");

elements.projectList.addEventListener("click", (event) => {
  const choice = event.target.closest("[data-project-id]");
  if (choice) void openProject(choice.dataset.projectId).catch(error => { hideAppLoading();const message=document.querySelector("#projectMessage"); if(message)message.textContent=error.message; });
});

elements.projectDialog.addEventListener("cancel", (event) => {
  if (!activeProjectDefinition) event.preventDefault();
});


function renderAccessShell() {
  const admin = currentUser?.role === "admin";
  const roomsMode=trackingMode==="rooms",equipmentMode=trackingMode==="equipment",bohMode=trackingMode==="boh",workshopMode=trackingMode==="workshop";
  document.body.dataset.role = localMode ? "viewer" : !accessReady ? "signed-out" : currentUser?.role || "signed-out";
  document.querySelector("#mainWorkspace").hidden = !accessReady || !roomsMode || (!localMode && admin && adminPage !== "dashboard");
  document.querySelector("#equipmentWorkspace").hidden = !accessReady || !equipmentMode;
  document.querySelector("#bohWorkspace").hidden = !accessReady || !bohMode;
  document.querySelector("#dxfWorkshop").hidden = !accessReady || !workshopMode || !admin || localMode;
  document.querySelector("#adminNavigation").hidden = !accessReady || !roomsMode || !admin || localMode;
  document.querySelector("#adminTeam").hidden = !roomsMode || !admin || adminPage !== "team" || localMode;
  document.querySelector("#adminTasks").hidden = !roomsMode || !admin || adminPage !== "tasks" || localMode;
  document.querySelector("#adminActivity").hidden = !roomsMode || !admin || adminPage !== "history" || localMode;
  document.querySelector("#adminPhotos").hidden = !roomsMode || !admin || adminPage !== "photos" || localMode;
  document.querySelector("#profileButton").hidden = !accessReady || localMode;
  document.querySelector("#signInButton").hidden = !cloudConfigured || !localMode || !accessReady;
  document.querySelector("#modeSwitchButton").hidden = !accessReady;
  document.querySelector("#syncButton").hidden = !cloud || !roomsMode;
  document.querySelector("#draftActions").hidden=!accessReady || !roomsMode || localMode || currentUser?.role==="viewer";
  document.querySelectorAll("[data-admin-only]").forEach(element=>element.hidden=!admin || localMode);
  document.querySelector("#sessionRole").textContent = localMode ? "Visiteur — lecture seule" : admin ? "Administrateur" : currentUser?.role === "viewer" ? "Lecture seule" : "Intervenant";
  document.querySelectorAll("[data-admin-page]").forEach(b=>b.classList.toggle("active",b.dataset.adminPage===adminPage));
  if(!roomAccessible(state.selectedRoom)) { elements.roomTitle.textContent="En attente d'affectation"; elements.roomType.textContent=""; }
}
function showAppLoading(message="Chargement des données du chantier…") {
  document.querySelector("#appLoadingText").textContent=message;
  document.querySelector("#appLoading").hidden=false;
}
function hideAppLoading() { document.querySelector("#appLoading").hidden=true; }
function showLogin(message="") {
  hideAppLoading();
  accessReady=false; renderAccessShell();
  setRegistrationMode(false);
  document.querySelector("#loginError").textContent=message;
  document.querySelector("#loginError").hidden=!message;
  document.querySelector("#loginPassword").value="";
  document.querySelector("#loginDialog").showModal();
}
async function chooseProject() {
  const projects=await cloud.projects();
  if(projects.length) {
    await openProject(projects[0].id);
    return;
  }
  elements.projectList.innerHTML=projects.map(p=>'<button type="button" class="project-choice" data-project-id="'+escapeSvgText(p.id)+'"><strong>'+escapeSvgText(p.name)+'</strong><span>Ouvrir le projet partagé</span></button>').join("")
    + '<p>Aucun projet n’est encore associé à ce compte. Un administrateur peut vous attribuer un rôle depuis l’onglet Équipe.</p>'
    + '<p>Votre identifiant reste disponible si besoin : <code>'+escapeSvgText(cloud.user.id)+'</code></p>'
    + '<button type="button" class="button secondary" id="createSharedProject">Créer un projet Mixed Use</button>'
    + '<p>Un nouveau projet démarre à 0 %. Les anciennes saisies locales ne sont pas importées automatiquement.</p><p id="projectMessage" role="status"></p>'
    + '<button type="button" class="text-button" id="projectLogout">Changer de compte</button>';
  elements.projectDialog.showModal();
  document.querySelector("#projectLogout").onclick=async()=>{await logout(); cloud=null;currentUser=null;state.records={};elements.projectDialog.close();showLogin();};
  document.querySelector("#createSharedProject").onclick=async(event)=>{
    event.target.disabled=true;
    try { const id=await cloud.createProject(); await openProject(id); }
    catch(error){hideAppLoading();document.querySelector("#projectMessage").textContent=error.message;event.target.disabled=false;}
  };
}
async function beginCloud(workspace) {
  cloud=workspace;
  currentUser={...cloud.user,role:"worker"};
  document.querySelector("#loginDialog").close();
  document.querySelector("#loginPassword").value="";
  showAppLoading("Récupération de votre chantier…");
  await chooseProject();
}
function operationContext(operation) {
  const [room,zone,code]=operation.key.split(":"),task=cloud.snapshot.tasks.find(item=>item.id===operation.taskId)||cloud.snapshot.tasks.find(item=>item.key===operation.key);
  const definition=tasksByZone[zone]?.find(item=>item.id===code),type=cloud.snapshot.taskTypes?.find(item=>item.zone===zone&&item.code===code);
  const floor=activeProjectDefinition?.floors?.find(item=>item.id===task?.floorCode)?.label || task?.floorCode?.toUpperCase() || "";
  return {room,zone,code,task,floor,zoneLabel:zone==="bathroom"?"Salle de bain":zone==="bedroom"?"Chambre":"Loggia",group:type?.group_label || (definition?taskGroup(zone,definition.sourceColumn):"Tâche"),label:type?.label || definition?.label || code};
}
function payloadRecord(payload) { return {progress:Number(payload.progress)||0,blocked:Boolean(payload.blocked),note:payload.note||"",startDate:payload.start_date||"",endDate:payload.end_date||""}; }
function operationBefore(operation,operations) {
  const context=operationContext(operation),previous=operations.filter(item=>item.taskId===operation.taskId&&item.id!==operation.id&&item.baseVersion<operation.baseVersion&&["pending","draft"].includes(item.state)).sort((a,b)=>b.baseVersion-a.baseVersion)[0];
  return previous?payloadRecord(previous.payload):(context.task?.record || {progress:0,blocked:false,note:"",startDate:"",endDate:""});
}
function operationChanges(operation,operations) {
  const before=operationBefore(operation,operations),after=payloadRecord(operation.payload),changes=[];
  if(Number(before.progress||0)!==after.progress)changes.push(`Avancement : ${Number(before.progress||0)} % → ${after.progress} %`);
  if(Boolean(before.blocked)!==after.blocked)changes.push(after.blocked?"Tâche signalée bloquée":"Blocage retiré");
  if((before.note||"")!==after.note)changes.push(after.note?`Observation : ${after.note}`:"Observation supprimée");
  if((before.startDate||"")!==after.startDate)changes.push(`Début : ${after.startDate||"retiré"}`);
  if((before.endDate||"")!==after.endDate)changes.push(`Fin : ${after.endDate||"retirée"}`);
  return changes.length?changes:["Aucune différence avec la valeur actuellement connue"];
}
function operationReviewCard(operation,operations,{problem=false,draft=false}={}) {
  const context=operationContext(operation),created=new Intl.DateTimeFormat("fr-FR",{dateStyle:"short",timeStyle:"short"}).format(new Date(operation.createdAt));
  return '<article class="activity-item sync-review-item"><header><strong>Chambre '+escapeSvgText(context.room)+'</strong><span>'+escapeSvgText([context.floor,context.zoneLabel].filter(Boolean).join(" · "))+'</span></header><dl><div><dt>Tâche</dt><dd>'+escapeSvgText(context.group)+'</dd></div><div><dt>Sous-tâche</dt><dd>'+escapeSvgText(context.label)+'</dd></div></dl><div class="activity-changes"><b>Modification</b>'+operationChanges(operation,operations).map(change=>'<span>'+escapeSvgText(change)+'</span>').join("")+'</div><footer><time>'+escapeSvgText(created)+'</time></footer>'+(draft?'<button type="button" class="button secondary draft-delete" data-discard-draft="'+escapeSvgText(operation.id)+'">Supprimer ce brouillon</button>':"")+(problem?'<p class="sync-error">'+escapeSvgText(syncError(operation.error))+'</p><button type="button" class="button secondary" data-discard-task="'+escapeSvgText(operation.taskId)+'">Conserver la valeur du serveur</button>':"")+'</article>';
}
async function renderSync() {
  if(!cloud?.snapshot) return;
  const operations=await cloud.engine.operations(cloud.snapshot.projectId);
  const pending=operations.filter(o=>o.state==="pending").length;
  const drafts=operations.filter(o=>o.state==="draft").length;
  const problems=operations.filter(o=>o.state!=="pending"&&o.state!=="draft");
  document.querySelector("#saveStatus").textContent=problems.length ? problems.length+" modification(s) à examiner"
    : drafts ? drafts+" brouillon(s) sur cet appareil — non partagés"
    : pending ? pending+" modification(s) en attente de synchronisation"
    : navigator.onLine ? "Synchronisé" : "Hors connexion — copie locale";
  const pendingOperations=operations.filter(o=>o.state==="pending");
  const section=(title,items,options={})=>items.length?'<section class="sync-review-section"><h3>'+title+' <span>'+items.length+'</span></h3>'+items.map(item=>operationReviewCard(item,operations,options)).join("")+'</section>':"";
  document.querySelector("#syncProblems").innerHTML=section("Brouillons non partagés",operations.filter(o=>o.state==="draft"),{draft:true})
    +section("Validées, en attente d’envoi",pendingOperations)
    +section("Modifications à examiner",problems,{problem:true})
    +(operations.length?'':'<p class="empty-state">Aucune modification en attente sur cet appareil.</p>')
    +(drafts?'<p class="sync-review-help">Les brouillons ci-dessus ne seront partagés qu’après avoir utilisé le bouton « Valider » sur le plan.</p>':"");
}
function syncError(code) {
  return ({assignment_changed:"L'affectation a changé.",version_conflict:"Une autre modification a été enregistrée.",
    permission_denied:"Vos droits ne permettent pas cette modification.",dependency_failed:"Une saisie précédente doit être résolue.",
    task_archived:"Cette tâche a été archivée.",invalid_payload:"La saisie n'est pas valide.",
    correction_required:"Une correction administrative est nécessaire."})[code] || code || "Modification refusée.";
}
function cloudErrorMessage(error) {
  const message=String(error?.message || error || "Erreur inconnue.");
  if(/statement timeout|canceling statement/i.test(message))return "Le serveur a mis trop de temps à répondre. Relancez la synchronisation.";
  if(/timeout|aborted/i.test(message))return "La connexion a expiré. Relancez la synchronisation.";
  return message;
}
function activityChanges(before={},after={}) {
  const changes=[];
  if(before.progress!==after.progress)changes.push(`Avancement : ${before.progress ?? 0} % → ${after.progress ?? 0} %`);
  if(Boolean(before.blocked)!==Boolean(after.blocked))changes.push(after.blocked ? "Tâche signalée bloquée" : "Blocage retiré");
  if((before.note || "")!==(after.note || ""))changes.push(after.note ? `Observation : ${after.note}` : "Observation supprimée");
  if((before.start_date || "")!==(after.start_date || ""))changes.push(`Début : ${after.start_date || "retiré"}`);
  if((before.end_date || "")!==(after.end_date || ""))changes.push(`Fin : ${after.end_date || "retirée"}`);
  return changes.length ? changes : ["Mise à jour enregistrée"];
}
async function syncCloud({refresh=true,closeDialog=false,refreshActivity=false,retryInvalid=false}={}) {
  if(!cloud?.snapshot || synchronizing || !navigator.onLine) { await renderSync(); return; }
  const workspace=cloud; synchronizing=true;
  try {
    await saveQueue;
    if(retryInvalid)await workspace.retryInvalidOperations();
    await workspace.sync(refresh);
    if(cloud!==workspace) return;
    currentUser={...workspace.user,role:workspace.snapshot.role};
    project=await workspace.project();state.records=currentFloorRecords();
    if(!roomAccessible(state.selectedRoom)) state.selectedRoom=rooms.find(r=>roomAccessible(r.number))?.number ?? null;
    render(); await renderSync();
    if(refreshActivity && currentUser.role==="admin" && adminPage==="history") {
      try{await renderAdminPage();}
      catch(error){document.querySelector("#activityList").innerHTML='<p class="empty-state">'+escapeSvgText(cloudErrorMessage(error))+'</p>';}
    }
    const dialog=document.querySelector("#syncDialog");
    if(closeDialog && dialog.open)dialog.close();
    return true;
  } catch(error) {
    if(cloud===workspace) { currentUser={...workspace.user,role:workspace.snapshot.role}; render(); await renderSync(); document.querySelector("#saveStatus").textContent="Synchronisation en attente : "+cloudErrorMessage(error); }
    return false;
  } finally { synchronizing=false; }
}
async function renderAdminPage() {
  if(!cloud || currentUser?.role!=="admin") return;
  if(adminPage==="tasks") {
    const groups=new Map();
    const orderedTypes=[...(cloud.snapshot.taskTypes || [])].sort((a,b)=>{
      const zoneOrder={bathroom:0,bedroom:1,loggia:2};
      return (zoneOrder[a.zone] ?? 3)-(zoneOrder[b.zone] ?? 3)
        || taskTypeOrder(a)-taskTypeOrder(b)
        || a.label.localeCompare(b.label,"fr",{numeric:true});
    });
    for(const type of orderedTypes) {
      const definition=tasksByZone[type.zone]?.find(task=>task.id===type.code);
      const title=type.group_label || (definition ? taskGroup(type.zone,definition.sourceColumn) : "Autres");
      const key=type.zone+'|'+title;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(type);
    }
    const list=document.querySelector("#taskManagementList");
    list.innerHTML=[...groups].map(([key,types])=>{
      const [zone,title]=key.split('|');
      const people=cloud.snapshot.members.filter(m=>m.status==='active');
      const personLabel=m=>m.name+(m.role==='admin'?' · Admin':'')+(m.user_id===currentUser.id?' · Vous':'');
      const hiddenCount=types.filter(type=>type.hidden).length;
      const personalCount=types.filter(type=>(type.hidden_user_ids || []).length).length;
      const summary=[types.length+' tâches',hiddenCount?hiddenCount+' OFF':'',personalCount?personalCount+' ciblée'+(personalCount>1?'s':''):''].filter(Boolean).join(' · ');
      const controls='<details class="task-group-bulk"><summary>Réglages pour tout le groupe</summary><div class="task-group-controls"><label><input type="checkbox" data-group-hidden> Masquer tout le groupe pour le projet</label><details><summary>Choisir les personnes exclues du groupe</summary>'+people.map(m=>'<label class="task-member-option"><input type="checkbox" data-group-user="'+m.user_id+'"> '+escapeSvgText(personLabel(m))+'</label>').join('')+'</details><button type="button" class="button primary" data-save-group>Enregistrer le groupe</button><p role="status" data-group-status></p></div></details>';
      return '<details class="management-group" data-task-zone="'+zone+'"><summary><strong>'+escapeSvgText(title)+'</strong><span data-group-summary>'+summary+'</span></summary>'+controls+'<div class="management-task-grid">'+types.map(type=>{
        const hiddenUsers=type.hidden_user_ids || [];
        return '<div class="management-task"><form class="task-management-form" data-type-id="'+escapeSvgText(type.id)+'"><div class="task-visibility-row"><input class="task-inline-label" aria-label="Intitulé de la tâche" name="label" required maxlength="200" value="'+escapeSvgText(type.label)+'"><fieldset class="task-on-off"><legend class="sr-only">Visibilité de la tâche</legend><label><input type="radio" name="visibility" value="on" '+(!type.hidden?'checked':'')+'> ON</label><label><input type="radio" name="visibility" value="off" '+(type.hidden?'checked':'')+'> OFF</label></fieldset><input type="checkbox" name="hidden" hidden '+(type.hidden?'checked':'')+'><button type="submit" class="button secondary task-save-button">Sauver</button></div><div class="task-compact-status"><small data-task-visibility></small><p role="status"></p></div><details class="task-people-details"><summary>OFF pour certains <span data-hidden-user-count>'+hiddenUsers.length+'</span></summary><fieldset class="task-off-people"><legend class="sr-only">Utilisateurs qui ne voient pas cette tâche</legend>'+people.map(m=>'<label class="task-person-chip"><input type="checkbox" name="hiddenUser" value="'+m.user_id+'" '+(hiddenUsers.includes(m.user_id)?'checked':'')+'> '+escapeSvgText(personLabel(m))+'</label>').join('')+(people.length?'':'<span class="access-hint">Aucun membre actif dans le projet.</span>')+'</fieldset></details></form></div>';
      }
      ).join('')+'</div></details>';
    }).join('');
    document.querySelectorAll('[data-task-zone-tab]').forEach(button=>{
      const active=button.dataset.taskZoneTab===taskManagementZone;
      button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));
    });
    list.querySelectorAll('.management-group').forEach(updateManagementGroup);
    filterTaskManagement();
  } else if(adminPage==="team") {
    void renderInvitations();
    const snapshot=cloud.snapshot;
    const people=await cloud.people().catch(()=>snapshot.members.map(member=>({id:member.user_id,name:member.name})));
    const known=new Map(snapshot.members.map(member=>[member.user_id,member]));
    const listed=[...people].sort((a,b)=>{
      const memberA=known.get(a.id), memberB=known.get(b.id);
      if(Boolean(memberA)!==Boolean(memberB)) return memberA ? -1 : 1;
      return a.name.localeCompare(b.name,"fr");
    });
    document.querySelector("#teamList").innerHTML=listed.map(person=>{
      const member=known.get(person.id);
      const role=member?.role || "";
      const status=member?.status || "inactive";
      const statusText=member ? (status==="active"?"Actif":"Désactivé") : "Non affecté au projet";
      return '<article class="team-member" data-user-id="'+person.id+'"><div><h3>'+escapeSvgText(person.name)+'</h3><p>'+escapeSvgText(statusText)+'</p><small>'+escapeSvgText(person.id)+'</small></div><label class="field compact-field"><span>Rôle</span><select data-member-role><option value="">À définir</option><option value="worker" '+(role==="worker"?"selected":"")+'>Intervenant</option><option value="viewer" '+(role==="viewer"?"selected":"")+'>Lecture seule</option><option value="admin" '+(role==="admin"?"selected":"")+'>Administrateur</option></select></label><label class="field compact-field"><span>Accès</span><select data-member-status '+(!member?"disabled":"")+'><option value="active" '+(status==="active"?"selected":"")+'>Actif</option><option value="inactive" '+(status==="inactive"?"selected":"")+'>Désactivé</option></select></label></article>';
    }).join("") || '<p class="empty-state">Aucun compte créé pour le moment.</p>';
    const scope=await cloud.assignmentScope();
    const activeFloors=scope.floors.filter(f=>!f.archived_at).sort((a,b)=>a.code.localeCompare(b.code,"fr",{numeric:true}));
    const responsibleWorkers=new Map(snapshot.members.filter(m=>m.status==="active" && m.role==="worker").map(m=>[m.user_id,m]));
    document.querySelector("#assignmentBlocks").innerHTML='<legend>Étages et blocs</legend>'+activeFloors.map(f=>
      '<details class="assignment-floor"><summary>'+escapeSvgText(f.label)+'</summary><label class="block-assignment"><input type="checkbox" name="assignmentFloor" value="'+f.id+'"><span>Tout cet étage</span></label>'+scope.blocks.filter(b=>b.floor_id===f.id&&!b.archived_at).sort((a,b)=>a.code.localeCompare(b.code,"fr",{numeric:true})).map(b=>{
        const roomIds=new Set(scope.rooms.filter(r=>r.block_id===b.id&&!r.archived_at).map(r=>r.id));
        const taskIds=new Set(scope.tasks.filter(t=>roomIds.has(t.room_id)&&!t.archived_at).map(t=>t.id));
        const people=[...new Set(scope.assignments.filter(a=>!a.ended_at&&taskIds.has(a.room_task_id)&&responsibleWorkers.has(a.assignee_id)).map(a=>responsibleWorkers.get(a.assignee_id).name))];
        return '<label class="block-assignment"><input type="checkbox" name="assignmentBlock" value="'+b.id+'" '+(!taskIds.size?'disabled':'')+'><span>Bloc '+escapeSvgText(b.label)+'<small>'+escapeSvgText(people.join(', ')||'Non affecté')+' · '+taskIds.size+' tâches</small></span></label>';
      }).join('')+'</details>').join('');
    document.querySelector("#assignmentPerson").innerHTML='<option value="">Retirer les affectations</option>'+[...responsibleWorkers.values()].map(m=>'<option value="'+m.user_id+'">'+escapeSvgText(m.name)+'</option>').join('');
  } else if(adminPage==="photos") {
    await openProjectPhotos(cloud.snapshot, Object.fromEntries((activeProjectDefinition?.floors || []).map(floor => [floor.id, floor.label])));
  } else if(adminPage==="history") {
    const list=document.querySelector("#activityList");
    list.innerHTML='<p class="empty-state">Chargement de l’activité…</p>';
    const history=await cloud.history();
    const days=new Map();
    for(const item of history) {
      const createdAt=new Date(item.created_at);
      const dayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Casablanca",year:"numeric",month:"2-digit",day:"2-digit"}).format(createdAt);
      if(!days.has(dayKey))days.set(dayKey,{label:new Intl.DateTimeFormat("fr-FR",{timeZone:"Africa/Casablanca",weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(createdAt),items:[]});
      const task=cloud.snapshot.tasks.find(t=>t.id===item.room_task_id);
      const member=cloud.snapshot.members.find(m=>m.user_id===item.changed_by);
      const [roomNumber,zone,code]=(task?.key || "").split(":");
      const definition=tasksByZone[zone]?.find(entry=>entry.id===code);
      const type=cloud.snapshot.taskTypes?.find(entry=>entry.zone===zone && entry.code===code);
      const group=type?.group_label || (definition ? taskGroup(zone,definition.sourceColumn) : "Tâche");
      const subtask=type?.label || definition?.label || code || "Tâche supprimée";
      const zoneLabel=zone==="bathroom" ? "Salle de bain" : zone==="bedroom" ? "Chambre" : "Loggia";
      const floorLabel=(activeProjectDefinition?.floors || []).find(floor=>floor.id===task?.floorCode)?.label || task?.floorCode?.toUpperCase() || "";
      const changes=activityChanges(item.before_state,item.after_state);
      const time=new Intl.DateTimeFormat("fr-FR",{timeZone:"Africa/Casablanca",hour:"2-digit",minute:"2-digit"}).format(createdAt);
      days.get(dayKey).items.push('<article class="activity-item"><header><strong>Chambre '+escapeSvgText(roomNumber || "—")+'</strong><span>'+escapeSvgText([floorLabel,zoneLabel].filter(Boolean).join(" · "))+'</span></header><dl><div><dt>Tâche</dt><dd>'+escapeSvgText(group)+'</dd></div><div><dt>Sous-tâche</dt><dd>'+escapeSvgText(subtask)+'</dd></div></dl><div class="activity-changes"><b>Saisie</b>'+changes.map(change=>'<span>'+escapeSvgText(change)+'</span>').join('')+'</div><footer><span>'+escapeSvgText(member?.name || "Import")+'</span><time datetime="'+escapeSvgText(item.created_at)+'">'+escapeSvgText(time)+'</time></footer></article>');
    }
    list.innerHTML=days.size ? [...days].map(([day,{label,items}],index)=>'<details class="activity-day" data-activity-day="'+escapeSvgText(day)+'" '+(index===0?'open':'')+'><summary><strong>'+escapeSvgText(label)+'</strong><span>'+items.length+' changement'+(items.length>1?'s':'')+'</span></summary><div class="activity-day-grid">'+items.join('')+'</div></details>').join('') : '<p class="empty-state">Aucune modification enregistrée.</p>';
  }
}
document.querySelector("#assignmentForm").onsubmit=async(event)=>{
  event.preventDefault();const button=event.currentTarget.querySelector("button");button.disabled=true;
  const label=button.textContent;button.textContent="Enregistrement…";
  document.querySelector("#assignmentMessage").textContent="Enregistrement des affectations en cours…";
  try {
    const blockIds=[...document.querySelectorAll('input[name="assignmentBlock"]:checked')].map(input=>input.value);
    const floorIds=[...document.querySelectorAll('input[name="assignmentFloor"]:checked')].map(input=>input.value);
    if(!blockIds.length && !floorIds.length) throw new Error("Sélectionnez au moins un étage ou un bloc.");
    const person=document.querySelector("#assignmentPerson").value||null;
    let count=0;
    if(blockIds.length) count+=await cloud.assignBlocks(blockIds,person);
    if(floorIds.length) count+=await cloud.assignFloors(floorIds,person);
    await renderAdminPage();
    const message=count ? count+" affectations de tâches enregistrées." : "Affectations déjà à jour pour les blocs sélectionnés.";
    document.querySelector("#assignmentMessage").textContent=message;
    document.querySelector("#saveStatus").textContent=message;
    document.querySelector("#assignmentMessage").classList.add("success");
  } catch(error){document.querySelector("#assignmentMessage").classList.remove("success");document.querySelector("#assignmentMessage").textContent=error.message;}finally{button.disabled=false;button.textContent=label;}
};
document.querySelector("#memberDirectory").onchange=async(event)=>{
  const control=event.target.closest("[data-member-role],[data-member-status]");
  if(!control)return;
  const row=control.closest("[data-user-id]");
  const role=row.querySelector("[data-member-role]").value;
  const statusControl=row.querySelector("[data-member-status]");
  const status=statusControl.value;
  if(!role){document.querySelector("#teamMessage").classList.remove("success");document.querySelector("#teamMessage").textContent="Choisissez un rôle pour activer ce compte dans le projet.";return;}
  control.disabled=true;
  try {
    await cloud.member(row.dataset.userId,role,statusControl.disabled?"active":status);
    await renderAdminPage();
    const message="Membre mis à jour.";
    document.querySelector("#teamMessage").textContent=message;
    document.querySelector("#saveStatus").textContent=message;
    document.querySelector("#teamMessage").classList.add("success");
  } catch(error){document.querySelector("#teamMessage").classList.remove("success");document.querySelector("#teamMessage").textContent=error.message;}
  finally{control.disabled=false;}
};
document.querySelector("#adminNavigation").onclick=async(event)=>{
  const button=event.target.closest("[data-admin-page]");if(!button)return;
  adminPage=button.dataset.adminPage;renderAccessShell();
  try{await renderAdminPage();if(adminPage==="dashboard")requestAnimationFrame(fitPlan);}
  catch(error){
    const message=cloudErrorMessage(error);
    document.querySelector("#saveStatus").textContent=message;
    if(adminPage==="history")document.querySelector("#activityList").innerHTML='<p class="empty-state">'+escapeSvgText(message)+'</p>';
  }
};
document.querySelector("#exportExcel").onclick=async(event)=>{
  if(!cloud?.snapshot || currentUser?.role!=="admin")return;
  const button=event.currentTarget;const label=button.textContent;
  button.disabled=true;button.textContent="Préparation…";
  document.querySelector("#saveStatus").textContent="Actualisation des résultats avant export…";
  try{
    const synced=await syncCloud({refresh:true});
    if(!synced)throw new Error("La synchronisation doit réussir avant l’export.");
    const visibleColumns=(cloud.snapshot.taskTypes || []).map(type=>type.source_column).filter(Boolean);
    await downloadProgressWorkbook(cloud.snapshot.tasks,{visibleColumns});
    document.querySelector("#saveStatus").textContent="Export Excel téléchargé";
  }catch(error){document.querySelector("#saveStatus").textContent="Export impossible : "+cloudErrorMessage(error);}
  finally{button.disabled=false;button.textContent=label;}
};
function reportPlanSvg(model,zone,code,taskByKey) {
  const width=model.bounds.maxX-model.bounds.minX,height=model.bounds.maxY-model.bounds.minY;
  const zonePaths=model.rooms.map(room=>{
    const record=taskByKey.get(`${room.number}:${zone}:${code}`)?.record;
    const className=record?statusClass(record):"unassigned";
    let paths=[];
    if(zone==="bathroom")paths=room.bathrooms.map(polygon=>pointsPath(polygon,true));
    if(zone==="bedroom"&&room.polygon)paths=[`${pointsPath(room.polygon,true)} ${[...room.bathrooms,...room.loggias].map(polygon=>pointsPath(polygon,true)).join(" ")}`];
    return paths.map(path=>`<path class="dxf-zone ${className}" d="${path}" fill-rule="evenodd"/>`).join("");
  }).join("");
  const labelSize=Math.max(.32,Math.min(.55,height*.012));
  const labels=model.rooms.map(room=>`<text class="dxf-label" x="${numberValue(room.labelPoint.x)}" y="${numberValue(-room.labelPoint.y)}" font-size="${numberValue(labelSize)}" text-anchor="middle">${room.number}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="${Math.max(600,Math.round(1800/Math.max(.1,width/height)))}" viewBox="${numberValue(model.bounds.minX)} ${numberValue(-model.bounds.maxY)} ${numberValue(width)} ${numberValue(height)}" preserveAspectRatio="xMidYMid meet"><style>
    .dxf-line{vector-effect:non-scaling-stroke;stroke:#4d5653;stroke-width:.7;fill:none}
    .dxf-detail{vector-effect:non-scaling-stroke;stroke:#626d68;stroke-width:.55;fill:none}
    .dxf-annotation{fill:#3c6590;font-family:Arial,sans-serif;font-weight:500}
    .dxf-zone{vector-effect:non-scaling-stroke;stroke-width:1.1;fill-opacity:.28}
    .dxf-zone.unassigned{fill:#aab8b3;stroke:#397c80;fill-opacity:.24}
    .dxf-zone.status-not-started{fill:#c94043;stroke:#9e292c}
    .dxf-zone.status-in-progress{fill:#e38b22;stroke:#a75e0d}
    .dxf-zone.status-done{fill:#16835d;stroke:#0e5e43}
    .dxf-zone.status-blocked{fill:#8f334e;stroke:#672037}
    .dxf-label{font-family:Arial,sans-serif;fill:#173c3e;paint-order:stroke;stroke:#fff;stroke-width:.12;font-weight:700}
  </style><rect x="${numberValue(model.bounds.minX)}" y="${numberValue(-model.bounds.maxY)}" width="${numberValue(width)}" height="${numberValue(height)}" fill="#fff"/><g transform="scale(1 -1)">${model.architecture}</g><g transform="scale(1 -1)">${zonePaths}</g><g>${model.annotations}${labels}</g></svg>`;
}
const reportModelCache=new Map();
async function reportFloorModel(floor) {
  if(!floor.dxfPath)throw new Error(`Le plan ${floor.label} n’est pas configuré.`);
  const cacheKey=`${floor.dxfPath}?v=${encodeURIComponent(String(floor.updatedAt||""))}`;
  if(reportModelCache.has(cacheKey))return reportModelCache.get(cacheKey);
  const response=await fetch(cacheKey);
  if(!response.ok)throw new Error(`Le plan ${floor.label} est indisponible (${response.status}).`);
  const source=await response.text();
  const model=buildDxfModel(new window.DxfParser().parseSync(source),layoutViewBounds(source));
  reportModelCache.set(cacheKey,model);
  return model;
}
document.querySelector("#exportDailyPdf").onclick=async(event)=>{
  if(!cloud?.snapshot || currentUser?.role!=="admin")return;
  const button=event.currentTarget,label=button.textContent;button.disabled=true;button.textContent="Préparation…";
  document.querySelector("#saveStatus").textContent="Préparation du rapport journalier…";
  try {
    const synced=await syncCloud({refresh:true});
    if(!synced)throw new Error("La synchronisation doit réussir avant l’export.");
    const reportDate=new Date(),day=projectDay(reportDate);
    const history=(await cloud.recentHistory()).filter(item=>projectDay(new Date(item.created_at))===day);
    const describe=(zone,code)=>{
      const type=cloud.snapshot.taskTypes?.find(entry=>entry.zone===zone&&entry.code===code);
      const definition=tasksByZone[zone]?.find(entry=>entry.id===code);
      if(!type&&!definition)return null;
      return {group:type?.group_label||(definition?taskGroup(zone,definition.sourceColumn):"Tâche"),label:type?.label||definition?.label||code};
    };
    const visibleTypes=new Set((cloud.snapshot.taskTypes||[]).filter(type=>!type.hidden).map(type=>`${type.zone}:${type.code}`));
    const visibleTasks=cloud.snapshot.tasks.filter(task=>{
      const [,zone,code]=task.key.split(":");
      return visibleTypes.has(`${zone}:${code}`);
    });
    const lines=dailyProgressLines(history,visibleTasks,describe);
    if(!lines.length)throw new Error("Aucun avancement positif enregistré aujourd’hui sur les tâches visibles.");
    const floorDefinitions=[...(activeProjectDefinition?.floors||[])].sort((a,b)=>a.id.localeCompare(b.id,"fr",{numeric:true}));
    const floorModels=new Map();
    const changedFloors=new Set(lines.map(line=>line.floorCode));
    for(const floor of floorDefinitions)if(changedFloors.has(floor.id))floorModels.set(floor.id,await reportFloorModel(floor));
    const zoneOrder={bedroom:0,bathroom:1,loggia:2};
    const orderedTypes=[...(cloud.snapshot.taskTypes||[])].filter(type=>!type.hidden).sort((a,b)=>(zoneOrder[a.zone]??3)-(zoneOrder[b.zone]??3)
      || Number(a.sort_order||0)-Number(b.sort_order||0)||a.label.localeCompare(b.label,"fr",{numeric:true}));
    const taskByKey=new Map(visibleTasks.map(task=>[task.key,task]));
    const taskById=new Map(visibleTasks.map(task=>[task.id,task]));
    const reports=[];
    for(const type of orderedTypes) {
      const floors=[];
      for(const floor of floorDefinitions) {
      const sectionLines=lines.filter(line=>line.floorCode===floor.id&&line.zone===type.zone&&taskById.get(line.taskId)?.key.endsWith(`:${type.code}`));
      if(!sectionLines.length)continue;
      const definition=tasksByZone[type.zone]?.find(entry=>entry.id===type.code);
      const group=type.group_label||(definition?taskGroup(type.zone,definition.sourceColumn):"Tâche");
      const model=floorModels.get(floor.id);if(!model)continue;
      floors.push({code:`${floor.id}:${type.zone}:${type.code}`,label:`${floor.label} - ${group} - ${type.label}`,planSvg:reportPlanSvg(model,type.zone,type.code,taskByKey),lines:sectionLines});
    }
      if(floors.length)reports.push({id:type.id,label:`${type.zone==="bathroom"?"SDB":"Chambre"} - ${type.label}`,floors});
    }
    await downloadDailyProgressPdfs(reportDate,reports,(done,total)=>{button.textContent=`PDF : ${done}/${total}`;});
    document.querySelector("#saveStatus").textContent="PDF téléchargé : toutes les sous-tâches et les quatre étages";
  } catch(error) { document.querySelector("#saveStatus").textContent="Export PDF impossible : "+cloudErrorMessage(error); }
  finally {button.disabled=false;button.textContent=label;}
};
function profileResponsibilityHtml() {
  if(currentUser?.role==="admin")return '<p class="profile-scope-summary">Accès administrateur à tout le projet, sauf aux tâches qui vous sont explicitement masquées.</p>';
  if(currentUser?.role==="viewer")return '<p class="profile-scope-summary">Consultation du projet uniquement.</p>';
  const snapshot=cloud?.snapshot;
  if(!snapshot)return '<p class="profile-scope-summary">Aucune zone affectée pour le moment.</p>';
  const taskById=new Map(snapshot.tasks.map(task=>[task.id,task]));
  const assignedByScope=new Map();
  const totalByScope=new Map();
  const scopeDetails=new Map();
  for(const task of snapshot.tasks.filter(task=>task.active)) {
    const roomNumber=Number(task.key.split(":",1)[0]);
    const floorCode=task.floorCode || CURRENT_FLOOR;
    const blockCode=(ROOMS_BY_FLOOR[floorCode] || []).find(room=>room.number===roomNumber)?.blockId || "—";
    const scopeKey=floorCode+":"+blockCode;
    totalByScope.set(scopeKey,(totalByScope.get(scopeKey)||0)+1);
    scopeDetails.set(scopeKey,{floorCode,blockCode});
  }
  for(const assignment of snapshot.assignments) {
    if(assignment.ended_at || assignment.assignee_id!==cloud.user.id)continue;
    const task=taskById.get(assignment.room_task_id);if(!task?.active)continue;
    const roomNumber=Number(task.key.split(":",1)[0]);
    const floorCode=task.floorCode || CURRENT_FLOOR;
    const blockCode=(ROOMS_BY_FLOOR[floorCode] || []).find(room=>room.number===roomNumber)?.blockId || "—";
    const scopeKey=floorCode+":"+blockCode;
    assignedByScope.set(scopeKey,(assignedByScope.get(scopeKey)||0)+1);
    scopeDetails.set(scopeKey,{floorCode,blockCode});
  }
  if(!assignedByScope.size)return '<p class="profile-scope-summary">Aucune zone affectée pour le moment.</p>';
  const floorLabels=new Map((PROJECT_CATALOG[0].floors || []).map(floor=>[floor.id,floor.label]));
  const rows=[...assignedByScope].map(([key,count])=>{
    const scope=scopeDetails.get(key);const total=totalByScope.get(key)||0;
    return {...scope,count,total,label:floorLabels.get(scope.floorCode)||scope.floorCode.toUpperCase()};
  }).sort((a,b)=>a.label.localeCompare(b.label,"fr",{numeric:true})||a.blockCode.localeCompare(b.blockCode,"fr"));
  return '<ul class="profile-scope-list">'+rows.map(scope=>'<li><strong>'+escapeSvgText(scope.label)+' — Bloc '+escapeSvgText(scope.blockCode)+'</strong><span>'+(scope.count===scope.total?'Responsabilité complète':scope.count+' tâche'+(scope.count>1?'s':'')+' affectée'+(scope.count>1?'s':''))+'</span></li>').join("")+'</ul>';
}
document.querySelector("#profileButton").onclick=()=>{
  const user=cloud.user;
  document.querySelector("#profileMetadata").innerHTML='<dt>Nom</dt><dd>'+escapeSvgText(user.user_metadata?.display_name || user.email || "")+'</dd><dt>Responsabilités</dt><dd>'+profileResponsibilityHtml()+'</dd>';
  document.querySelector("#profileDialog").showModal();
};
document.querySelector("#closeProfile").onclick=()=>document.querySelector("#profileDialog").close();
document.querySelector("#logoutButton").onclick=async()=>{
  await saveQueue;
  const pending=cloud?.snapshot ? await cloud.engine.operations(cloud.snapshot.projectId) : [];
  if(pending.length && !confirm("Des modifications restent sur cet appareil. Elles seront conservées pour ce compte. Se déconnecter ?"))return;
  await logout();cloud=null;currentUser=null;state.records={};accessReady=false;
  document.querySelector("#profileDialog").close();showLogin();
};
document.querySelector("#continueAsGuest").onclick=()=>{
  sessionStorage.setItem(guestModeKey,"true");
  location.reload();
};
document.querySelector("#signInButton").onclick=async()=>{
  await saveQueue;
  sessionStorage.removeItem(guestModeKey);
  location.reload();
};
document.querySelector("#loginDialog").addEventListener("cancel",event=>event.preventDefault());
function setRegistrationMode() {
  registrationMode=Boolean(invitationToken);
  document.querySelector("#loginError").hidden=true;
  document.querySelector("#loginTitle").textContent=registrationMode?"Créez votre compte invité.":"Retrouvez votre chantier.";
  document.querySelector("#loginDescription").textContent=registrationMode?"Choisissez votre nom d’utilisateur et votre mot de passe. Aucun e-mail requis.":"Connectez-vous pour reprendre vos tâches et vos avancements.";
  document.querySelector("#loginIdentifierLabel").textContent=registrationMode?"Nom d’utilisateur":"Nom d’utilisateur ou e-mail existant";
  document.querySelector("#loginSubmit").textContent=registrationMode?"Créer mon compte":"Se connecter";
  document.querySelector("#loginPassword").autocomplete=registrationMode?"new-password":"current-password";
  document.querySelector("#continueAsGuest").hidden=registrationMode;
  document.querySelector("#guestModeDescription").hidden=registrationMode;
}
document.querySelector("#loginForm").onsubmit=async(event)=>{
  event.preventDefault();const button=document.querySelector("#loginSubmit");
  const identifier=document.querySelector("#loginEmail").value.trim();
  const password=document.querySelector("#loginPassword").value;
  const loginError=document.querySelector("#loginError");
  loginError.hidden=true;
  if(registrationMode&&password.length<8) {
    loginError.textContent="Le mot de passe doit contenir au moins 8 caractères. Le lien d’invitation reste valide.";
    loginError.hidden=false;
    return;
  }
  button.disabled=true;
  button.textContent=registrationMode?"Création en cours…":"Connexion en cours…";
  try {
    if(registrationMode) {
      await acceptInvitation(invitationToken,identifier,password);
      invitationToken="";setRegistrationMode();
      document.querySelector("#loginTitle").textContent="Compte créé. Connectez-vous.";
      document.querySelector("#loginPassword").value="";
      sessionStorage.removeItem(guestModeKey);
      return;
    }
    sessionStorage.removeItem(guestModeKey);
    const workspace=await login(identifier,password);
    if(!workspace)throw new Error("Connexion impossible.");
    if(localMode){location.reload();return;}
    await beginCloud(workspace);
  }catch(error){document.querySelector("#loginError").textContent=error.message;document.querySelector("#loginError").hidden=false;}
  finally{button.disabled=false;button.textContent=registrationMode?"Créer mon compte":"Se connecter";}
};

document.querySelector("#syncButton").onclick=()=>{document.querySelector("#syncDialog").showModal();void renderSync();};
document.querySelector("#closeSync").onclick=()=>document.querySelector("#syncDialog").close();
document.querySelector("#retrySync").onclick=()=>void syncCloud({refresh:true,closeDialog:true,refreshActivity:true,retryInvalid:true});
document.querySelector("#syncProblems").onclick=async(event)=>{
  const draftButton=event.target.closest("[data-discard-draft]");
  if(draftButton){
    if(!confirm("Supprimer uniquement ce brouillon ? La dernière valeur validée sera restaurée pour cette tâche."))return;
    draftButton.disabled=true;
    await cloud.exclusive(()=>cloud.engine.discardDraft(cloud.snapshot.projectId,draftButton.dataset.discardDraft));
    project=await cloud.project();state.records=currentFloorRecords();render();await renderSync();
    return;
  }
  const button=event.target.closest("[data-discard-task]");if(!button)return;
  if(!confirm("Conserver la valeur du serveur pour cette tâche ? Votre proposition restera archivée localement."))return;
  await cloud.exclusive(()=>cloud.engine.discard(cloud.snapshot.projectId,button.dataset.discardTask));
  project=await cloud.project();state.records=currentFloorRecords();render();await renderSync();
};
window.addEventListener("online",()=>void syncCloud());
window.addEventListener("offline",()=>void renderSync());
setInterval(()=>{if(document.visibilityState==="visible")void syncCloud();},30000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void syncCloud();});
async function initializeAccess() {
  renderAccessShell();
  if(invitationToken){showLogin();return;}
  if(localMode){currentUser={id:"local",role:"viewer"};await openProject("mixed-use");return;}
  try{const workspace=await restoreWorkspace();if(workspace)await beginCloud(workspace);else showLogin();}
  catch(error){showLogin(error.message);}
}
void initializeAccess();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // Ask the browser to check the worker itself on every load. When an already
  // controlled tab receives a newer worker, reload once so it cannot keep
  // running an obsolete application bundle after a deployment.
  const controlledAtStartup=Boolean(navigator.serviceWorker.controller);
  let reloadingForUpdate=false;
  if(controlledAtStartup)navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(reloadingForUpdate)return;
    reloadingForUpdate=true;
    window.location.reload();
  });
  navigator.serviceWorker.register("/sw.js",{updateViaCache:"none"})
    .then(registration=>registration.update())
    .catch(error => console.error("Cache hors connexion indisponible", error));
}

// Presentation only: collapse secondary filters on narrow screens.
const compactLayout=window.matchMedia("(max-width: 820px)");
function updateFilterLayout() { document.querySelector("#secondaryFilters").open=!compactLayout.matches; }
compactLayout.addEventListener("change",updateFilterLayout);
updateFilterLayout();

document.querySelector("#confirmProgress").onclick=async()=>{
  if(localMode || !currentUser || currentUser.role==="viewer") return;
  await saveQueue;
  const button=document.querySelector("#confirmProgress");
  const count=localMode?Object.values(state.records).filter(r=>r.draft).length:(await cloud.engine.operations(cloud.snapshot.projectId)).filter(o=>o.state==="draft").length;
  if(!count){document.querySelector("#saveStatus").textContent="Aucun brouillon à valider.";return;}
  if(!confirm("Valider les "+count+" saisies de ce projet enregistrées sur cet appareil ? "+(localMode?"Elles resteront locales, car vous n’êtes pas connecté.":"Elles seront partagées avec l’équipe dès que la connexion le permettra.")))return;
  button.disabled=true;document.querySelector("#cancelProgress").disabled=true;saving=true;
  try{
    if(localMode){
      const next=structuredClone(project);
      for(const record of Object.values(next.floors[state.selectedFloor].records))if(record.draft){
        if(record.progress<lockedProgress(record)&&!record.draftJustified)throw new Error("Justifiez les diminutions avant de valider.");
        record.lockedProgress=lockedProgress(record);record.confirmedProgress=record.progress;record.confirmedDay=projectDay();record.draft=false;record.draftJustified=false;delete record.draftBefore;
      }
      await projectRepository.save(next);project=next;state.records=currentFloorRecords();
      document.querySelector("#saveStatus").textContent="Saisies validées sur cet appareil — non partagées";
    }else{
      await cloud.confirmDrafts();
      const synced=await syncCloud({refresh:false,closeDialog:true,refreshActivity:true});
      if(!synced)throw new Error("La synchronisation reste en attente. Réessayez avec le bouton Synchronisation.");
    }
    render();
  }catch(error){document.querySelector("#saveStatus").textContent="Validation interrompue : "+error.message;}
  finally{button.disabled=false;document.querySelector("#cancelProgress").disabled=false;saving=false;renderEditor();}
};

document.querySelector("#cancelProgress").onclick=async()=>{
  if(localMode || !currentUser || currentUser.role==="viewer") return;
  await saveQueue;
  if(!confirm("Annuler les brouillons non validés de ce projet sur cet appareil ? Les saisies déjà validées seront conservées."))return;
  saving=true;
  document.querySelector("#confirmProgress").disabled=true;
  document.querySelector("#cancelProgress").disabled=true;
  try{
    if(localMode){
      const next=structuredClone(project);
      for(const [key,record] of Object.entries(next.floors[state.selectedFloor].records))if(record.draft){
        if(!record.draftBefore)throw new Error("Un ancien brouillon ne possède pas de copie antérieure. Il est conservé pour éviter une perte de données.");
        next.floors[state.selectedFloor].records[key]=record.draftBefore;
      }
      await projectRepository.save(next);project=next;
    }else{await cloud.cancelDrafts();project=await cloud.project();}
    state.records=currentFloorRecords();
    resetCorrectionState();render();
    document.querySelector("#saveStatus").textContent="Brouillons annulés — valeurs validées conservées";
  }catch(error){document.querySelector("#saveStatus").textContent=error.message;}
  finally{saving=false;document.querySelector("#confirmProgress").disabled=false;document.querySelector("#cancelProgress").disabled=false;renderEditor();}
};

function filterTaskManagement() {
  const list=document.querySelector('#taskManagementList');
  if(!list)return;
  const search=(document.querySelector('#taskManagementSearch')?.value||'').trim().toLocaleLowerCase('fr');
  const filter=document.querySelector('#taskManagementFilter')?.value||'all';
  list.querySelectorAll('.management-group').forEach(group=>{
    if(group.dataset.taskZone!==taskManagementZone){group.hidden=true;return;}
    const groupMatches=(group.querySelector(':scope > summary strong')?.textContent||'').toLocaleLowerCase('fr').includes(search);
    let visibleCount=0;
    group.querySelectorAll('.management-task').forEach(task=>{
      const form=task.querySelector('.task-management-form');
      const hidden=form.elements.hidden.checked;
      const personal=!!form.querySelector('[name="hiddenUser"]:checked');
      const label=form.elements.label.value.toLocaleLowerCase('fr');
      const matchesSearch=!search||groupMatches||label.includes(search);
      const matchesFilter=filter==='all'||(filter==='visible'&&!hidden)||(filter==='hidden'&&hidden)||(filter==='people'&&personal);
      task.hidden=!(matchesSearch&&matchesFilter);
      if(!task.hidden)visibleCount++;
    });
    group.hidden=visibleCount===0;
  });
}

document.querySelector("#taskManagementList").addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.target.closest(".task-management-form");if(!form)return;
  const button=form.querySelector("button");const status=form.querySelector('[role="status"]');
  button.disabled=true;status.textContent="Enregistrement…";
  try{
    await cloud.manageTaskType(form.dataset.typeId,form.elements.label.value,form.elements.hidden.checked,[...form.querySelectorAll('[name="hiddenUser"]:checked')].map(input=>input.value));
    status.textContent="Modifications enregistrées.";

    updateManagementGroup(form.closest(".management-group"));filterTaskManagement();render();
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});

function updateManagementGroup(group) {
  const forms=[...group.querySelectorAll('.task-management-form')];
  const set=(control,values)=>{control.checked=values.every(Boolean);control.indeterminate=values.some(Boolean)&&!control.checked;};
  set(group.querySelector('[data-group-hidden]'),forms.map(f=>f.elements.hidden.checked));
  group.querySelectorAll('[data-group-user]').forEach(control=>set(control,forms.map(f=>[...f.querySelectorAll('[name="hiddenUser"]')].find(input=>input.value===control.dataset.groupUser)?.checked)));
  forms.forEach(f=>{
    const personal=f.querySelectorAll('[name="hiddenUser"]:checked').length;
    f.querySelector('[name="visibility"][value="on"]').checked=!f.elements.hidden.checked;
    f.querySelector('[name="visibility"][value="off"]').checked=f.elements.hidden.checked;
    f.querySelector('[data-hidden-user-count]').textContent=personal;
    f.querySelector('[data-task-visibility]').textContent=f.elements.hidden.checked?'Masquée pour le projet':personal?'Masquée pour '+personal+' personne'+(personal>1?'s':''):'Visible';
  });
  const hidden=forms.filter(f=>f.elements.hidden.checked).length;
  const personal=forms.filter(f=>f.querySelector('[name="hiddenUser"]:checked')).length;
  group.querySelector('[data-group-summary]').textContent=forms.length+' tâche'+(forms.length>1?'s':'')+(hidden?' · '+hidden+' OFF':'')+(personal?' · '+personal+' ciblée'+(personal>1?'s':''):'');
}
document.querySelector('#taskManagementList').addEventListener('change',event=>{
  const group=event.target.closest('.management-group');if(!group)return;
  if(event.target.matches('[name="visibility"]')) event.target.closest('form').elements.hidden.checked=event.target.value==='off';
  const groupChange=event.target.matches('[data-group-hidden],[data-group-user]');
  if(groupChange) {
    group.querySelectorAll('.task-management-form').forEach(form=>{
      const input=event.target.matches('[data-group-hidden]')?form.elements.hidden:[...form.querySelectorAll('[name="hiddenUser"]')].find(input=>input.value===event.target.dataset.groupUser);
      if(input)input.checked=event.target.checked;
    });
  }
  updateManagementGroup(group);
  if(groupChange)group.querySelector('[data-group-status]').textContent='Modifications à enregistrer.';
  else {
    const status=event.target.closest('form')?.querySelector('[role="status"]');
    if(status)status.textContent='À enregistrer.';
  }
  filterTaskManagement();
});
document.querySelector('#taskManagementList').addEventListener('input',event=>{
  if(!event.target.matches('[name="label"]'))return;
  const status=event.target.closest('form').querySelector('[role="status"]');
  status.textContent='À enregistrer.';
  filterTaskManagement();
});
document.querySelector('#taskManagementList').addEventListener('toggle',event=>{
  if(!event.target.matches('.management-group')||!event.target.open)return;
  document.querySelectorAll('#taskManagementList > .management-group[open]').forEach(group=>{if(group!==event.target)group.open=false;});
},true);
document.querySelector('#taskManagementSearch').addEventListener('input',filterTaskManagement);
document.querySelector('#taskManagementFilter').addEventListener('change',filterTaskManagement);
document.querySelector('.task-zone-tabs').addEventListener('click',event=>{
  const button=event.target.closest('[data-task-zone-tab]');if(!button)return;
  taskManagementZone=button.dataset.taskZoneTab;
  document.querySelectorAll('[data-task-zone-tab]').forEach(tab=>{
    const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));
  });
  document.querySelectorAll('#taskManagementList > .management-group[open]').forEach(group=>group.open=false);
  filterTaskManagement();
});
document.querySelector('#collapseTaskGroups').addEventListener('click',()=>{
  document.querySelectorAll('#taskManagementList details[open]').forEach(details=>details.open=false);
});
document.querySelector('#taskManagementList').addEventListener('click',async event=>{
  const button=event.target.closest('[data-save-group]');if(!button)return;
  const group=button.closest('.management-group'),status=group.querySelector('[data-group-status]');
  const controls=[...group.querySelectorAll('input,button')];
  for(const form of group.querySelectorAll('.task-management-form')) { if(!form.reportValidity())return; }
  controls.forEach(c=>c.disabled=true);
  let saved=0;
  try {
    for(const form of group.querySelectorAll('.task-management-form')) {
      if(!form.reportValidity())throw new Error('Vérifiez les intitulés des tâches.');
    }
    for(const form of group.querySelectorAll('.task-management-form')) {
      status.textContent='Enregistrement du groupe…';
      await cloud.manageTaskType(form.dataset.typeId,form.elements.label.value,form.elements.hidden.checked,[...form.querySelectorAll('[name="hiddenUser"]:checked')].map(i=>i.value));

      saved++;
    }
    status.textContent=saved+' tâches enregistrées.';filterTaskManagement();render();
  }catch(error){status.textContent=saved+' tâches enregistrées. '+error.message+' Vous pouvez réessayer pour terminer.';}
  finally{controls.forEach(c=>c.disabled=false);updateManagementGroup(group);}
});

async function renderInvitations() {
  const list=document.querySelector('#invitationList');
  try {
    const rows=await cloud.invitations();
    list.innerHTML=rows.map(inv=>{
      const status=inv.used_at?'Utilisé':inv.revoked_at?'Révoqué':Date.parse(inv.expires_at)<=Date.now()?'Expiré':'Disponible';
      return '<div class="invitation-row"><span>'+escapeSvgText(inv.role==='viewer'?'Lecture seule':'Intervenant')+' · '+status+' · '+new Date(inv.created_at).toLocaleString('fr-FR')+'</span>'+(status==='Disponible'?'<button type="button" class="button secondary" data-revoke-invitation="'+inv.id+'">Révoquer</button>':'')+'</div>';
    }).join('') || '<p>Aucune invitation.</p>';
  }catch {list.textContent='Les invitations nécessitent la mise à jour Supabase.';}
}
document.querySelector('#createInvitation').onclick=async()=>{
  const button=document.querySelector('#createInvitation'),message=document.querySelector('#invitationMessage');
  button.disabled=true;message.textContent='Création du lien…';
  try {
    const inv=await cloud.createInvitation(document.querySelector('#invitationRole').value);
    document.querySelector('#invitationLink').value=location.origin+location.pathname+'#invite='+inv.token;
    document.querySelector('#invitationResult').hidden=false;
    message.textContent='Lien créé. Copiez-le maintenant : il ne sera plus affiché après fermeture de la page.';
    await renderInvitations();
  }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
};
document.querySelector('#copyInvitation').onclick=async()=>{
  try{await navigator.clipboard.writeText(document.querySelector('#invitationLink').value);document.querySelector('#invitationMessage').textContent='Lien copié.';}
  catch{document.querySelector('#invitationLink').select();document.querySelector('#invitationMessage').textContent='Copiez le lien sélectionné.';}
};
document.querySelector('#invitationList').onclick=async event=>{
  const button=event.target.closest('[data-revoke-invitation]');if(!button)return;
  button.disabled=true;
  try{await cloud.revokeInvitation(button.dataset.revokeInvitation);await renderInvitations();document.querySelector('#invitationMessage').textContent='Invitation révoquée.';}
  catch(error){button.disabled=false;document.querySelector('#invitationMessage').textContent=error.message;}
};

for (const [id, readOnly] of [["addTaskPhoto", false], ["viewTaskPhotos", true]]) {
  document.getElementById(id).addEventListener("click", () => {
    if (!cloud || !currentUser) return;
    const task = currentTasks().find(item => item.id === state.selectedTask);
    if (!task) return;
    openTaskPhotos({
      snapshot: cloud.snapshot, userId: cloud.snapshot.userId,
      key: state.selectedRoom + ":" + state.selectedZone + ":" + state.selectedTask,
      label: floorDefinition().label + " · Chambre " + state.selectedRoom + " · " + (state.selectedZone === "bedroom" ? "Chambre" : "Salle de bain") + " · " + task.label
    }, readOnly);
  });
}

async function activateTrackingMode(mode) {
  if(mode==="workshop"&&(localMode||currentUser?.role!=="admin"))return;
  trackingMode=mode;adminPage="dashboard";
  document.querySelector("#trackingModeDialog").close();
  renderAccessShell();
  if(mode==="rooms") {
    elements.projectSubtitle.textContent=activeProjectDefinition.name+" — "+(floorDefinition()?.label || state.selectedFloor);
    await loadConfiguredPlan(activeProjectDefinition);requestAnimationFrame(fitPlan);
  } else if(mode==="equipment") {
    elements.projectSubtitle.textContent=activeProjectDefinition.name+" — Repérage des équipements";
    showAppLoading("Chargement du repérage des équipements…");
    try{await openEquipmentMap(activeProjectDefinition);}finally{hideAppLoading();}
  } else if(mode==="boh") {
    elements.projectSubtitle.textContent=activeProjectDefinition.name+" — BOH Carrelage";
    showAppLoading("Chargement du suivi BOH…");
    try{await openBoh(cloud?.snapshot || null,currentUser?.role || "viewer");}finally{hideAppLoading();}
  } else if(mode==="workshop") {
    elements.projectSubtitle.textContent=activeProjectDefinition.name+" — Préparation AutoCAD";
    openDxfWorkshop(cloud?.snapshot?.projectId || activeProjectDefinition.id,true);
  }
}
document.querySelector("#trackingModeDialog").addEventListener("cancel",event=>event.preventDefault());
document.querySelector("#trackingModeDialog").addEventListener("click",event=>{const button=event.target.closest("[data-tracking-mode]");if(button)void activateTrackingMode(button.dataset.trackingMode);});
document.querySelector("#modeSwitchButton").addEventListener("click",()=>document.querySelector("#trackingModeDialog").showModal());
