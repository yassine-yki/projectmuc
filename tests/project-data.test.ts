import test from "node:test";
import assert from "node:assert/strict";
import { R2_BLOCKS, R2_ROOMS, ROOMS_BY_FLOOR } from "../src/project-data.js";
import { taskApplicable, taskGroup, tasksByZone } from "../src/model.js";

test("aquapanel replacement is a separate bedroom task in Cloisons",()=>{
  const tasks=tasksByZone.bedroom;
  assert.deepEqual(tasks.slice(0,2).map(task=>task.label),["Cloisons chambre","Changement d’aquapanel"]);
  assert.equal(taskGroup("bedroom",tasks[1].sourceColumn),"Cloisons");
});

test("NOUR INOV enduit is standard-only while BENTHAMI dressage covers suites",()=>{
  assert.deepEqual(tasksByZone.bathroom.filter(task=>task.id.startsWith("wall-render")).map(task=>task.label),[
    "Enduit ciment — NOUR INOV","Dressage mur — BENTHAMI",
  ]);
  assert.equal(taskGroup("bathroom","O"),"Enduit ciment");
  assert.equal(taskGroup("bathroom","O_B"),"Dressage");
  assert.equal(taskApplicable("standard","bathroom","wall-render-benthami"),true);
  assert.equal(taskApplicable("junior","bathroom","wall-render-benthami"),true);
  assert.equal(taskApplicable("executive","bathroom","wall-render-benthami"),true);
  assert.equal(taskApplicable("standard","bathroom","wall-render"),true);
  assert.equal(taskApplicable("junior","bathroom","wall-render"),false);
  assert.equal(taskApplicable("executive","bathroom","wall-render"),false);
});

test("R+2 room definitions match the workbook", () => {
  assert.equal(R2_ROOMS.length, 40);
  assert.deepEqual(R2_BLOCKS, ["A", "B", "C"]);
  assert.equal(R2_ROOMS.filter((room) => room.blockId === "A").length, 16);
  assert.equal(R2_ROOMS.filter((room) => room.blockId === "B").length, 12);
  assert.equal(R2_ROOMS.filter((room) => room.blockId === "C").length, 12);
  assert.equal(R2_ROOMS.filter((room) => room.roomType === "junior").length, 8);
  assert.equal(R2_ROOMS.filter((room) => room.roomType === "executive").length, 1);
  assert.equal(R2_ROOMS.find((room) => room.number === 214)?.blockId, "B");
});

test('upper floor room typologies match DXF suite labels',()=>{
 assert.deepEqual(ROOMS_BY_FLOOR.r4.filter(r=>r.roomType==='junior').map(r=>r.number),[403,406,409,410,412,417,418]);
 assert.deepEqual(ROOMS_BY_FLOOR.r5.filter(r=>r.roomType==='junior').map(r=>r.number),[503,506,509,510,512,517,518,525]);
 for(const [floor,executive] of [['r4',414],['r5',514]] as const) assert.deepEqual(ROOMS_BY_FLOOR[floor].filter(r=>r.roomType==='executive').map(r=>r.number),[executive]);
});
