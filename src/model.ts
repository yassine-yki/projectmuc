export const CURRENT_FLOOR = "r2";
export const FLOOR_IDS = ["r2", "r3", "r4", "r5"] as const;
export const SCHEMA_VERSION = 1;

export type BlockId = string;
export type PlanAreaKind = "room" | "bathroom" | "loggia";
export type TrackingScope = PlanAreaKind;

export type RoomDefinition = {
  id: string;
  floorId: string;
  number: number;
  blockId: BlockId | null;
  roomType: string;
};

export type TaskDefinition = {
  id: string;
  code: string;
  label: string;
  scope: TrackingScope;
  planArea: PlanAreaKind;
  sourceColumn?: string;
};

export const tasksByZone = {
  bathroom: [
    { id: "plumbing-supply", label: "Passage EF/EC", sourceColumn: "E" },
    { id: "plumbing-drainage", label: "Passage évacuations", sourceColumn: "F" },
    { id: "plumbing-waterproofing-clearance", label: "Bon à étanché plomberie sol", sourceColumn: "G" },
    { id: "sdb-partitions", label: "Cloisons SDB posées", sourceColumn: "H" },
    { id: "sdb-electrical-rough-in", label: "Passage électricité cloisons", sourceColumn: "I" },
    { id: "sdb-electrical-plaster-clearance", label: "Bon à enduire électricité cloisons", sourceColumn: "J" },
    { id: "sdb-caulking", label: "Calfeutrement", sourceColumn: "K" },
    { id: "waterproofing", label: "Étanchéité SDB", sourceColumn: "L" },
    { id: "water-test", label: "Test mise en eau", sourceColumn: "M" },
    { id: "water-test-report", label: "PV test mise en eau", sourceColumn: "N" },
    { id: "wall-render", label: "Enduit ciment — NOUR INOV", sourceColumn: "O" },
    { id: "wall-render-benthami", label: "Dressage mur — BENTHAMI", sourceColumn: "O_B" },
    { id: "floor-screed", label: "Chape / forme de pente", sourceColumn: "P" },
    { id: "false-ceiling", label: "Structure faux plafond", sourceColumn: "Q" },
    { id: "ceiling-electrical", label: "Réseaux électricité plafond", sourceColumn: "R" },
    { id: "ceiling-hvac", label: "Réseaux clim / ventilation", sourceColumn: "S" },
    { id: "access-panel-approved", label: "Trappe de visite", sourceColumn: "T" },
    { id: "ceiling-close-clearance", label: "Bon à fermer faux plafond", sourceColumn: "U" },
    { id: "ceiling-close", label: "Fermeture faux plafond", sourceColumn: "V" },
    { id: "ceiling-finish", label: "Finition faux plafond", sourceColumn: "W" },
    { id: "ceiling-paint", label: "Peinture faux plafond", sourceColumn: "X" },
    { id: "wall-covering", label: "Pose revêtement toilette", sourceColumn: "Y" },
    { id: "shower-wall-covering", label: "Pose revêtement douche", sourceColumn: "Z" },
    { id: "floor-covering", label: "Pose revêtement sol", sourceColumn: "AA" },
    { id: "aluminium", label: "Faux cadres alu", sourceColumn: "AB" },
    { id: "shower-toilet-frames", label: "Pose châssis / cabine douche / cabine WC", sourceColumn: "AC" },
    { id: "woodwork", label: "Rail porte coulissante", sourceColumn: "AD" },
    { id: "sliding-door-partition-close", label: "Fermeture cloison porte coulissante", sourceColumn: "AE" },
    { id: "vanity", label: "Pose vanity", sourceColumn: "AF" },
    { id: "sanitary-fixtures", label: "Pose sanitaires / robinetterie", sourceColumn: "AG" },
    { id: "sdb-accessories", label: "Pose accessoires SDB", sourceColumn: "AH" },
    { id: "plumbing-tests", label: "Essais plomberie", sourceColumn: "AI" },
    { id: "electrical-tests", label: "Essais électricité", sourceColumn: "AJ" },
    { id: "hvac-tests", label: "Essais CVC", sourceColumn: "AK" },
    { id: "sdb-finishes", label: "Finitions SDB", sourceColumn: "AL" },
    { id: "sdb-internal-handover", label: "Réception interne SDB", sourceColumn: "AM" },
  ],
  bedroom: [
    { id: "partitions", label: "Cloisons chambre", sourceColumn: "AN" },
    { id: "aquapanel-replacement", label: "Changement d’aquapanel", sourceColumn: "AN_A" },
    { id: "electrical-rough-in", label: "Passage électricité cloisons", sourceColumn: "AO" },
    { id: "electrical-plaster-clearance", label: "Bon à enduire électricité cloisons", sourceColumn: "AP" },
    { id: "caulking", label: "Calfeutrement", sourceColumn: "AQ" },
    { id: "screed", label: "Chape chambre", sourceColumn: "AR" },
    { id: "false-ceiling", label: "Structure faux plafond", sourceColumn: "AS" },
    { id: "ceiling-electrical", label: "Réseaux électricité plafond", sourceColumn: "AT" },
    { id: "ceiling-fire", label: "Réseaux sprinklage / détection", sourceColumn: "AU" },
    { id: "ceiling-hvac", label: "Réseaux clim", sourceColumn: "AV" },
    { id: "ceiling-close-clearance", label: "Bon à fermer faux plafond", sourceColumn: "AW" },
    { id: "ceiling-close", label: "Fermeture faux plafond", sourceColumn: "AX" },
    { id: "ceiling-finish", label: "Finition faux plafond", sourceColumn: "AY" },
    { id: "ceiling-paint", label: "Peinture faux plafond", sourceColumn: "AZ" },
    { id: "entrance-door-frames", label: "Faux cadres porte entrée", sourceColumn: "BA" },
    { id: "entrance-door", label: "Pose porte entrée", sourceColumn: "BB" },
    { id: "bathroom-door", label: "Pose porte SDB", sourceColumn: "BC" },
    { id: "window-frames", label: "Pose fenêtres", sourceColumn: "BD" },
    { id: "skim-coat-1", label: "Enduit 1ère couche", sourceColumn: "BE" },
    { id: "skim-coat-2", label: "Enduit 2ème couche", sourceColumn: "BF" },
    { id: "paint", label: "Peinture 1ère couche", sourceColumn: "BG" },
    { id: "paint-coat-2", label: "Peinture 2ème couche", sourceColumn: "BH" },
    { id: "floor-finish", label: "Pose sol fini", sourceColumn: "BI" },
    { id: "skirting", label: "Pose plinthes", sourceColumn: "BJ" },
    { id: "wardrobe-bar", label: "Armoire / bar", sourceColumn: "BK" },
    { id: "headboard", label: "Tête de lit", sourceColumn: "BL" },
    { id: "tv-desk", label: "Meuble TV / bureau", sourceColumn: "BM" },
    { id: "electrical-devices", label: "Appareillage électrique", sourceColumn: "BN" },
    { id: "lights", label: "Luminaires / liseuses", sourceColumn: "BO" },
    { id: "electrical-tests", label: "Essais électricité", sourceColumn: "BP" },
    { id: "hvac-tests", label: "Essais climatisation", sourceColumn: "BQ" },
    { id: "card-lock-tests", label: "Essais serrure carte", sourceColumn: "BR" },
    { id: "frames", label: "Pose faux cadres", sourceColumn: "BS" },
    { id: "joinery", label: "Pose menuiserie", sourceColumn: "BT" },
  ],
  loggia: [],
} as const;

export type ZoneId = keyof typeof tasksByZone;

const taskGroupRanges: Record<ZoneId, { label: string; columns: string[] }[]> = {
  bathroom: [
    { label: "Plomberie sol", columns: ["E", "F", "G"] },
    { label: "Cloisons", columns: ["H"] },
    { label: "Électricité cloisons", columns: ["I", "J", "K"] },
    { label: "Étanchéité", columns: ["L", "M", "N"] },
    { label: "Enduit ciment", columns: ["O"] },
    { label: "Dressage", columns: ["O_B"] },
    { label: "Chape", columns: ["P"] },
    { label: "Faux plafond SDB", columns: ["Q", "R", "S", "T", "U", "V", "W"] },
    { label: "Peinture FP", columns: ["X"] },
    { label: "Revêtement mural", columns: ["Y", "Z"] },
    { label: "Revêtement sol", columns: ["AA"] },
    { label: "Menuiserie alu", columns: ["AB", "AC"] },
    { label: "Menuiserie bois", columns: ["AD", "AE"] },
    { label: "Agencement", columns: ["AF"] },
    { label: "Sanitaires", columns: ["AG"] },
    { label: "Accessoires", columns: ["AH"] },
    { label: "Tests", columns: ["AI", "AJ", "AK"] },
    { label: "Réception", columns: ["AL", "AM"] },
  ],
  bedroom: [
    { label: "Cloisons", columns: ["AN", "AN_A"] },
    { label: "Électricité cloisons", columns: ["AO", "AP", "AQ"] },
    { label: "Chape", columns: ["AR"] },
    { label: "Faux plafond chambre", columns: ["AS", "AT", "AU", "AV", "AW", "AX", "AY", "AZ"] },
    { label: "Menuiserie bois", columns: ["BA", "BB", "BC"] },
    { label: "Menuiserie alu", columns: ["BD"] },
    { label: "Peinture", columns: ["BE", "BF", "BG", "BH"] },
    { label: "Revêtement sol", columns: ["BI", "BJ"] },
    { label: "Agencement fixe", columns: ["BK", "BL", "BM"] },
    { label: "Appareillage", columns: ["BN", "BO"] },
    { label: "Tests", columns: ["BP", "BQ", "BR"] },
    { label: "LOGGIA", columns: ["BS", "BT"] },
  ],
  loggia: [],
};

export function taskGroup(zone: ZoneId, sourceColumn: string): string {
  return taskGroupRanges[zone].find((group) => group.columns.includes(sourceColumn))?.label || "Autres";
}
export function taskApplicable(roomType: string, zone: string, code: string): boolean {
  return !(zone === "bathroom" && code === "wall-render" && roomType !== "standard");
}
export type ProgressRecord = {
  progress: number;
  blocked: boolean;
  note: string;
  startDate: string;
  endDate: string;
  lastCorrectionReason?: "input-error" | "scope-change";
  lastCorrectionNote?: string;
  correctedAt?: string;
  confirmedDay?: string;
  confirmedProgress?: number;
  lockedProgress?: number;
  draft?: boolean;
  draftJustified?: boolean;
  draftBefore?: ProgressRecord;
};

export function projectDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Casablanca",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}
export function lockedProgress(record: ProgressRecord, day = projectDay()): number {
  return record.confirmedDay && record.confirmedDay < day ? (record.confirmedProgress ?? record.progress) : (record.lockedProgress ?? 0);
}
export function progressChangeAllowed(currentProgress: number, nextProgress: number, correctionAuthorized: boolean): boolean {
  if (currentProgress >= 100 && !correctionAuthorized) return false;
  if (nextProgress < currentProgress && !correctionAuthorized) return false;
  return true;
}
export type FloorData = { records: Record<string, ProgressRecord> };
export type ProjectData = {
  schemaVersion: typeof SCHEMA_VERSION;
  floors: Record<string, FloorData>;
};

export type ProgressUpdate = {
  id: string;
  roomId: string;
  taskId: string;
  previousProgress: number;
  newProgress: number;
  blocked: boolean;
  observation: string;
  changedAt: string;
  changedBy: string | null;
};

export type PhotoEvidence = {
  id: string;
  progressUpdateId: string;
  storagePath: string;
  capturedAt: string;
};

export function recordKey(room: number, zone: ZoneId, task: string): string {
  return `${room}:${zone}:${task}`;
}

export function emptyProject(): ProjectData {
  return { schemaVersion: SCHEMA_VERSION, floors: Object.fromEntries(FLOOR_IDS.map((floorId) => [floorId, { records: {} }])) };
}
