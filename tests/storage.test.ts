import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_FLOOR, emptyProject, progressChangeAllowed, recordKey, tasksByZone } from "../src/model.js";
import { BACKUP_FORMAT, LEGACY_KEY, PROJECT_KEY, R2_EXCEL_IMPORT_KEY, createBackup, loadProject, parseBackup, saveProject } from "../src/storage.js";
import { R2_EXCEL_RECORDS } from "../src/r2-excel-seed.js";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const sampleRecord = {
  progress: 45,
  blocked: true,
  note: "Attente de matériau",
  startDate: "",
  endDate: "",
};

test("migrates existing R+2 progress without deleting the legacy data", () => {
  const key = recordKey(214, "bedroom", "paint");
  const legacy = JSON.stringify({ [key]: sampleRecord });
  const storage = memoryStorage({ [LEGACY_KEY]: legacy });

  const project = loadProject(storage);
  assert.deepEqual(project.floors.r2.records[key], sampleRecord);
  assert.equal(storage.getItem(LEGACY_KEY), legacy);
  assert.ok(storage.getItem(PROJECT_KEY));
  assert.deepEqual(loadProject(storage), project);
});

test("imports the R+2 Excel snapshot once without overwriting local progress", () => {
  assert.equal(Object.keys(R2_EXCEL_RECORDS).length, 186);
  const localKey = recordKey(201, "bathroom", "waterproofing");
  const storage = memoryStorage({
    [PROJECT_KEY]: JSON.stringify({
      schemaVersion: 1,
      floors: { r2: { records: { [localKey]: sampleRecord } } },
    }),
  });

  const project = loadProject(storage);
  assert.deepEqual(project.floors.r2.records[localKey], sampleRecord);
  assert.equal(project.floors.r2.records[recordKey(223, "bedroom", "partitions")].progress, 80);
  assert.equal(project.floors.r2.records[recordKey(214, "bathroom", "floor-screed")].note, "Valeur Excel à vérifier");
  assert.equal(storage.getItem(R2_EXCEL_IMPORT_KEY), "1");

  project.floors.r2.records = {};
  saveProject(storage, project);
  assert.deepEqual(loadProject(storage).floors.r2.records, {});
});

test("keeps each floor's progress separate", () => {
  const project = emptyProject();
  const key = recordKey(214, "bedroom", "paint");
  project.floors.r2.records[key] = sampleRecord;
  project.floors.r3 = { records: { [key]: { ...sampleRecord, progress: 90 } } };
  const storage = memoryStorage();

  saveProject(storage, project);
  const loaded = loadProject(storage);
  assert.equal(loaded.floors.r2.records[key].progress, 45);
  assert.equal(loaded.floors.r3.records[key].progress, 90);
  assert.equal(CURRENT_FLOOR, "r2");
});

test("round-trips a backup and rejects malformed files", () => {
  const project = emptyProject();
  project.floors.r2.records[recordKey(203, "loggia", "paint")] = sampleRecord;
  const backup = createBackup(project, new Date("2026-09-20T12:00:00Z"));
  assert.equal(JSON.parse(backup).format, BACKUP_FORMAT);
  assert.deepEqual(parseBackup(backup), project);
  assert.throws(() => parseBackup("{}"), /sauvegarde Suivi Hôtel/);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, project: { schemaVersion: 99, floors: {} } })), /Format de projet/);
});

test("the task catalogue matches the R+2 workbook structure", () => {
  assert.equal(tasksByZone.bathroom.length, 36);
  assert.equal(tasksByZone.bedroom.length, 33);
  assert.deepEqual(tasksByZone.bedroom.slice(-2).map((task) => task.label), ["Pose faux cadres", "Pose menuiserie"]);
  assert.deepEqual(tasksByZone.bedroom.slice(-2).map((task) => task.sourceColumn), ["BS", "BT"]);
  assert.equal(tasksByZone.loggia.length, 0);
});

test("completed tasks and decreases require an authorized correction", () => {
  assert.equal(progressChangeAllowed(50, 75, false), true);
  assert.equal(progressChangeAllowed(50, 25, false), false);
  assert.equal(progressChangeAllowed(50, 25, true), true);
  assert.equal(progressChangeAllowed(100, 100, false), false);
  assert.equal(progressChangeAllowed(100, 80, false), false);
  assert.equal(progressChangeAllowed(100, 80, true), true);
});
