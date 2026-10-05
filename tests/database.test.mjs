import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// PostgreSQL réel en WASM, sans serveur distant. Seul le contexte Auth Supabase est simulé.
// Ne couvre pas PostgREST, Storage, Realtime ou la concurrence entre plusieurs connexions.
test('PISTACHE schema, RLS and transactional RPCs', async (t) => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  const first = async (sql, params = []) => (await query(sql, params))[0];
  const login = async (user, role = 'authenticated') => {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
    await db.exec(`set role ${role}`);
  };
  const reject = async (sql, params, pattern) => assert.rejects(query(sql, params), pattern);
  const admin = randomUUID(), worker = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
  const device = randomUUID();
  const payload = (progress, extra = {}) => ({ progress, blocked: false, note: 'test', start_date: null, end_date: null, ...extra });
  const operation = (task, assignment, version, body, extra = {}) => ({
    id: randomUUID(), task, assignment, device, version, time: '2026-09-24T12:00:00Z', body, dependency: null, ...extra,
  });
  const submit = (o) => first('select * from public.submit_progress($1,$2,$3,$4,$5,$6,$7,$8)',
    [o.id, o.task, o.assignment, o.device, o.version, o.time, JSON.stringify(o.body), o.dependency]);
  let project, otherProject, floor, otherFloor, room, room2, type, task, assignment, accepted, reassigned;

  await t.test('migration runs unchanged and profiles are created for existing and new users', async () => {
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create schema auth;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb not null default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
    `);
    await query('insert into auth.users(id) values ($1)', [admin]);
    await db.exec(await readFile(new URL('../supabase/migrations/0001_initial_schema.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/0002_create_mixed_use.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/0003_assign_blocks.sql', import.meta.url), 'utf8'));
    for (const id of [worker, viewer, outsider]) await query('insert into auth.users(id) values ($1)', [id]);
    assert.equal((await query('select * from public.profiles')).length, 4);
    const tables = await query("select relname, relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r'");
    assert.equal(tables.length, 13);
    assert.ok(tables.every((table) => table.relrowsecurity));
  });
  await t.test('project creation bootstraps admin; membership changes require an admin', async () => {
    await login(admin);
    project = (await first("select public.create_project('Mixed Use') as id")).id;
    otherProject = (await first("select public.create_project('Other') as id")).id;
    assert.equal((await first('select role from public.project_members where project_id=$1', [project])).role, 'admin');
    for (const [id, role] of [[worker, 'worker'], [viewer, 'viewer']]) {
      await query('select public.set_project_member($1,$2,$3,$4)', [project, id, role, 'active']);
    }
    await reject('select public.set_project_member($1,$2,$3,$4)', [project, admin, 'worker', 'active'], /last_admin_required/);
    await login(worker);
    await reject('select public.set_project_member($1,$2,$3,$4)', [project, worker, 'admin', 'active'], /project_admin_required/);
    await reject("update public.project_members set role='admin' where user_id=$1", [worker], /permission denied/);
  });
  await t.test('task creation works in both directions and restoration preserves progress', async () => {
    await login(admin);
    floor = (await first("insert into public.floors(project_id,code,label) values ($1,'r2','R+2') returning id", [project])).id;
    otherFloor = (await first("insert into public.floors(project_id,code,label) values ($1,'r2','R+2') returning id", [otherProject])).id;
    room = (await first("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'201') returning id", [project, floor])).id;
    type = (await first("insert into public.task_types(project_id,code,label,zone) values ($1,'paint','Peinture','bedroom') returning id", [project])).id;
    task = (await first('select id from public.room_tasks where room_id=$1', [room])).id;
    room2 = (await first("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'202') returning id", [project, floor])).id;
    assert.equal((await query('select * from public.room_tasks where project_id=$1', [project])).length, 2);
    await query('update public.rooms set archived_at=now() where id=$1', [room]);
    await query('update public.rooms set archived_at=null where id=$1', [room]);
    assert.equal((await query('select * from public.room_tasks where project_id=$1', [project])).length, 2);
  });
  await t.test('cross-project and cross-floor references are rejected', async () => {
    await reject("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'999')", [project, otherFloor], /foreign key/);
    const floor2 = (await first("insert into public.floors(project_id,code,label) values ($1,'r3','R+3') returning id", [project])).id;
    const block = (await first("insert into public.blocks(project_id,floor_id,code,label) values ($1,$2,'A','A') returning id", [project, floor2])).id;
    await reject('update public.rooms set block_id=$1 where id=$2', [block, room], /foreign key/);
    await reject('update public.rooms set project_id=$1 where id=$2', [otherProject, room], /permission denied/);
  });
  await t.test('workers, viewers and outsiders have isolated read access and no direct task writes', async () => {
    for (const user of [worker, viewer]) {
      await login(user);
      assert.equal((await query('select * from public.projects')).length, 1);
      assert.equal((await query('select * from public.profiles')).length, 3);
      await reject('update public.room_tasks set progress=80 where id=$1', [task], /permission denied/);
      await reject('insert into public.floors(project_id,code,label) values ($1,\'bad\',\'bad\')', [project], /project_admin_required|row-level security/);
    }
    await login(outsider);
    for (const name of ['projects', 'project_members', 'floors', 'rooms', 'room_tasks', 'task_assignments', 'sync_operations', 'progress_updates']) {
      assert.equal((await query(`select * from public.${name}`)).length, 0, name);
    }
    await assert.rejects(submit(operation(task, null, 1, payload(10))), /project_access_denied/);
    await login(null, 'anon');
    await reject('select * from public.projects', [], /permission denied/);
    await reject("select public.create_project('bad')", [], /permission denied/);
  });
  await t.test('assignment is admin-only and increments task version', async () => {
    await login(worker);
    await reject('select public.assign_task($1,$2)', [task, worker], /project_admin_required/);
    await login(admin);
    await reject('select public.assign_task($1,$2)', [task, viewer], /active_worker_required/);
    assignment = (await first('select public.assign_task($1,$2) as id', [task, worker])).id;
    assert.equal(Number((await first('select version from public.room_tasks where id=$1', [task])).version), 2);
  });
  await t.test('accepted submission updates state, version, author and full history atomically', async () => {
    await login(worker);
    accepted = operation(task, assignment, 2, payload(60));
    assert.equal((await submit(accepted)).status, 'accepted');
    const current = await first('select * from public.room_tasks where id=$1', [task]);
    assert.equal(current.progress, 60);
    assert.equal(Number(current.version), 3);
    assert.equal(current.updated_by, worker);
    const history = await first('select * from public.progress_updates where operation_id=$1', [accepted.id]);
    assert.equal(history.before_state.progress, 0);
    assert.equal(history.after_state.progress, 60);
    assert.equal(history.changed_by, worker);
  });
  await t.test('retries are idempotent and changed envelopes cannot reuse operation IDs', async () => {
    assert.equal((await submit(accepted)).status, 'accepted');
    assert.equal((await query('select * from public.progress_updates')).length, 1);
    for (const change of [{ body: payload(70) }, { device: randomUUID() }, { version: 3 }, { assignment: null }]) {
      await assert.rejects(submit({ ...accepted, ...change }), /operation_id_reused/);
    }
  });
  await t.test('stale versions, malformed payloads and unauthorized corrections do not change progress', async () => {
    assert.equal((await submit(operation(task, assignment, 2, payload(70)))).error_code, 'version_conflict');
    for (const body of [payload(101), payload(60.5), payload(70, { progress: null }), payload(70, { blocked: null }),
      payload(70, { start_date: '2026-09-25', end_date: '2026-09-24' }), payload(70, { start_date: '2026-02-30' }),
      payload(70, { author: admin }), { progress: 70 }]) {
      assert.equal((await submit(operation(task, assignment, 3, body))).error_code, 'invalid_payload');
    }
    assert.equal((await submit(operation(task, assignment, 3, payload(50)))).error_code, 'correction_required');
    assert.equal((await submit(operation(task, assignment, 3, payload(50, { correction_reason: 'input-error', correction_note: 'test' })))).error_code, 'permission_denied');
    assert.equal((await first('select progress from public.room_tasks where id=$1', [task])).progress, 60);
    assert.equal((await query('select * from public.progress_updates')).length, 1);
  });
  await t.test('history write failure rolls back both task state and synchronization result', async () => {
    await db.exec('reset role');
    await db.exec('create trigger force_history_failure before insert on public.progress_updates for each row execute function private.immutable_history()');
    await login(worker);
    const failed = operation(task, assignment, 3, payload(70));
    await assert.rejects(submit(failed), /history_is_immutable/);
    assert.equal((await query('select * from public.sync_operations where id=$1', [failed.id])).length, 0);
    const current = await first('select progress, version from public.room_tasks where id=$1', [task]);
    assert.equal(current.progress, 60);
    assert.equal(Number(current.version), 3);
    await db.exec('reset role');
    await db.exec('drop trigger force_history_failure on public.progress_updates');
    await login(worker);
  });
  await t.test('offline dependencies can be retried after their predecessor is received', async () => {
    const predecessor = operation(task, assignment, 3, payload(70));
    const next = operation(task, assignment, 4, payload(80), { dependency: predecessor.id });
    await assert.rejects(submit(next), /dependency_pending/);
    assert.equal((await query('select * from public.sync_operations where id=$1', [next.id])).length, 0);
    assert.equal((await submit(predecessor)).status, 'accepted');
    assert.equal((await submit(next)).status, 'accepted');
    assert.equal(Number((await first('select version from public.room_tasks where id=$1', [task])).version), 5);
  });
  await t.test('reassignment closes history and rejects stale offline assignments', async () => {
    await login(admin);
    reassigned = (await first('select public.assign_task($1,$2) as id', [task, admin])).id;
    assert.ok((await first('select ended_at from public.task_assignments where id=$1', [assignment])).ended_at);
    assert.equal((await query('select * from public.task_assignments where room_task_id=$1 and ended_at is null', [task])).length, 1);
    await db.exec('reset role');
    await reject('insert into public.task_assignments(project_id,room_task_id,assignee_id,assigned_by) values ($1,$2,$3,$4)', [project, task, worker, admin], /task_assignments_one_active_idx/);
    await login(worker);
    assert.equal((await submit(operation(task, assignment, 5, payload(90)))).error_code, 'assignment_changed');
    assert.equal((await submit(operation(task, reassigned, 6, payload(90)))).error_code, 'assignment_changed');
  });
  await t.test('admin correction needs an explanation; completed tasks are protected', async () => {
    await login(admin);
    assert.equal((await submit(operation(task, null, 6, payload(50, { correction_reason: 'input-error', correction_note: ' ' })))).error_code, 'invalid_payload');
    assert.equal((await submit(operation(task, null, 6, payload(50, { correction_reason: 'input-error', correction_note: 'Saisie corrigée' })))).status, 'accepted');
    assert.equal((await submit(operation(task, reassigned, 7, payload(100)))).status, 'accepted');
    assert.equal((await submit(operation(task, reassigned, 8, payload(100, { note: 'changed' })))).error_code, 'correction_required');
  });
  await t.test('archival prevents submissions and restoration preserves state', async () => {
    await query('update public.rooms set archived_at=now() where id=$1', [room]);
    assert.equal((await submit(operation(task, null, 8, payload(90, { correction_reason: 'scope-change', correction_note: 'test' })))).error_code, 'task_archived');
    await reject('select public.assign_task($1,$2)', [task, worker], /task_archived/);
    await query('update public.rooms set archived_at=null where id=$1', [room]);
    assert.equal((await first('select progress from public.room_tasks where id=$1', [task])).progress, 100);
    assert.equal((await query('select * from public.room_tasks where room_id=$1', [room])).length, 1);
  });
  await t.test('deactivation closes assignments, increments versions and removes access', async () => {
    await query('select public.assign_task($1,$2)', [task, worker]);
    const before = Number((await first('select version from public.room_tasks where id=$1', [task])).version);
    await query('select public.set_project_member($1,$2,$3,$4)', [project, worker, 'worker', 'inactive']);
    assert.equal(Number((await first('select version from public.room_tasks where id=$1', [task])).version), before + 1);
    assert.equal((await query('select * from public.task_assignments where room_task_id=$1 and ended_at is null', [task])).length, 0);
    await login(worker);
    assert.equal((await query('select * from public.room_tasks')).length, 0);
    await assert.rejects(submit(accepted), /project_access_denied/);
  });
  await t.test('history and synchronization outcomes are immutable, including for maintenance writes', async () => {
    await login(admin);
    await reject('delete from public.rooms where id=$1', [room], /permission denied/);
    await reject('update public.progress_updates set after_state=\'{}\'', [], /permission denied/);
    await db.exec('reset role');
    await reject('update public.progress_updates set after_state=\'{}\'', [], /history_is_immutable/);
    await reject('delete from public.sync_operations', [], /history_is_immutable/);
    await reject('insert into public.task_assignments(project_id,room_task_id,assignee_id,assigned_by) values ($1,$2,$3,$4)', [otherProject, task, admin, admin], /foreign key/);
  });
  await t.test('Mixed Use setup creates 40 rooms, 68 types and 2720 independent tasks', async () => {
    await login(admin);
    const seeded=(await first('select public.create_mixed_use_project() as id')).id;
    assert.equal((await query('select * from public.rooms where project_id=$1',[seeded])).length,40);
    assert.equal((await query('select * from public.task_types where project_id=$1',[seeded])).length,68);
    const tasks=await query('select * from public.room_tasks where project_id=$1',[seeded]);
    assert.equal(tasks.length,2720);
    assert.ok(tasks.every(t=>t.progress===0));
    await query('select public.set_project_member($1,$2,$3,$4)',[seeded,worker,'worker','active']);
    await query('select public.set_project_member($1,$2,$3,$4)',[seeded,outsider,'worker','active']);
    const firstTask=tasks[0],sameRoom=tasks.find(t=>t.room_id===firstTask.room_id&&t.id!==firstTask.id);
    const firstAssignment=(await first('select public.assign_task($1,$2) as id',[firstTask.id,worker])).id;
    const secondAssignment=(await first('select public.assign_task($1,$2) as id',[sameRoom.id,outsider])).id;
    await login(worker);
    assert.equal((await submit(operation(firstTask.id,firstAssignment,2,payload(30)))).status,'accepted');
    assert.equal((await submit(operation(sameRoom.id,secondAssignment,2,payload(40)))).error_code,'assignment_changed');
    assert.equal((await first('select progress from public.room_tasks where id=$1',[sameRoom.id])).progress,0);
  });

  await t.test('block assignments span floors, preserve other blocks and enforce permissions atomically', async () => {
    await login(admin);
    const p=(await first("select public.create_project('Multi-floor') as id")).id;
    await query('select public.set_project_member($1,$2,$3,$4)',[p,worker,'worker','active']);
    const blocks=[];
    for(const code of ['r1','r2','r3']) {
      const f=(await first('insert into public.floors(project_id,code,label) values ($1,$2,$2) returning id',[p,code])).id;
      const b=(await first("insert into public.blocks(project_id,floor_id,code,label) values ($1,$2,'A','A') returning id",[p,f])).id;
      blocks.push(b);
      await query("insert into public.rooms(project_id,floor_id,block_id,number) values ($1,$2,$3,'101')",[p,f,b]);
    }
    await query("insert into public.task_types(project_id,code,label,zone) values ($1,'paint','Peinture','bedroom')",[p]);
    assert.equal((await first('select public.assign_blocks($1,$2,$3) as count',[p,blocks.slice(0,2),worker])).count,2);
    assert.equal((await first('select public.assign_blocks($1,$2,$3) as count',[p,blocks.slice(0,2),worker])).count,0);
    assert.equal((await first('select count(*)::int as n from public.task_assignments where project_id=$1 and ended_at is null',[p])).n,2);
    await reject('select public.assign_blocks($1,$2,$3)',[p,[blocks[2],randomUUID()],admin],/invalid_block/);
    assert.equal((await first('select count(*)::int as n from public.task_assignments where project_id=$1 and ended_at is null',[p])).n,2);
    await reject('select public.assign_blocks($1,$2,$3)',[p,[],worker],/blocks_required/);
    await login(worker);
    await reject('select public.assign_blocks($1,$2,$3)',[p,blocks,worker],/project_admin_required/);
    await login(admin);
    assert.equal((await first('select public.assign_blocks($1,$2,$3) as count',[p,[blocks[0]],null])).count,1);
    assert.equal((await first('select count(*)::int as n from public.task_assignments where project_id=$1 and ended_at is null',[p])).n,1);
  });

  await t.test('confirmed daily progress permits same-day decreases and requires worker justification on later days',async()=>{
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/migrations/0004_confirmed_progress.sql',import.meta.url),'utf8'));
    await login(admin);
    const p=(await first("select public.create_project('Daily') as id")).id;
    await query('select public.set_project_member($1,$2,$3,$4)',[p,worker,'worker','active']);
    const f=(await first("insert into public.floors(project_id,code,label) values ($1,'r2','R+2') returning id",[p])).id;
    await query("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'201')",[p,f]);
    await query("insert into public.task_types(project_id,code,label,zone) values ($1,'paint','Peinture','bedroom')",[p]);
    const taskId=(await first('select id from public.room_tasks where project_id=$1',[p])).id;
    const assignment=(await first('select public.assign_task($1,$2) as id',[taskId,worker])).id;
    await login(worker);
    const send=async(progress,extra={})=>{
      const version=Number((await first('select version from public.room_tasks where id=$1',[taskId])).version);
      return submit(operation(taskId,assignment,version,payload(progress,extra)));
    };
    assert.equal((await send(80)).status,'accepted');
    assert.equal((await send(50)).status,'accepted');
    await db.exec('reset role');
    await query("update public.room_tasks set confirmed_day=(now() at time zone 'Africa/Casablanca')::date-1 where id=$1",[taskId]);
    await login(worker);
    assert.equal((await send(40)).error_code,'correction_required');
    assert.equal((await send(70)).status,'accepted');
    assert.equal((await send(45)).error_code,'correction_required');
    assert.equal((await send(40,{correction_reason:'input-error',correction_note:'Mesure vérifiée sur place'})).status,'accepted');
  });

  await t.test('admin edits unassigned tasks across floors without taking the worker assignment', async()=>{
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/migrations/0005_admin_progress_access.sql',import.meta.url),'utf8'));
    await login(admin);
    const p=(await first("select public.create_project('Admin access') as id")).id;
    await query('select public.set_project_member($1,$2,$3,$4)',[p,worker,'worker','active']);
    await query("insert into public.task_types(project_id,code,label,zone) values ($1,'paint','Peinture','bedroom')",[p]);
    for(const code of ['r2','r5']) {
      const f=(await first('insert into public.floors(project_id,code,label) values ($1,$2,$2) returning id',[p,code])).id;
      const r=(await first("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'501') returning id",[p,f])).id;
      const taskId=(await first('select id from public.room_tasks where room_id=$1',[r])).id;
      assert.equal((await submit(operation(taskId,null,1,payload(20)))).status,'accepted');
      const a=(await first('select public.assign_task($1,$2) as id',[taskId,worker])).id;
      assert.equal((await submit(operation(taskId,null,3,payload(60)))).status,'accepted');
      assert.equal((await first('select assignee_id from public.task_assignments where id=$1',[a])).assignee_id,worker);
      await login(worker);
      assert.equal((await submit(operation(taskId,null,4,payload(70)))).error_code,'assignment_changed');
      await login(admin);
    }
  });

  await t.test('task visibility hides data from selected members including admins while preserving progress',async()=>{
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/migrations/0006_task_visibility.sql',import.meta.url),'utf8'));
    await login(admin);
    const p=(await first("select public.create_project('Visibility') as id")).id;
    for(const [u,r] of [[worker,'worker'],[viewer,'viewer'],[outsider,'admin']]) await query('select public.set_project_member($1,$2,$3,$4)',[p,u,r,'active']);
    const f=(await first("insert into public.floors(project_id,code,label) values ($1,'r2','R2') returning id",[p])).id;
    await query("insert into public.rooms(project_id,floor_id,number) values ($1,$2,'201')",[p,f]);
    const type=(await first("insert into public.task_types(project_id,code,label,zone) values ($1,'paint','Paint','bedroom') returning id",[p])).id;
    const task=(await first('select id from public.room_tasks where project_id=$1',[p])).id;
    const a=(await first('select public.assign_task($1,$2) as id',[task,worker])).id;
    await login(worker);
    assert.equal((await submit(operation(task,a,2,payload(35)))).status,'accepted');
    await reject('select public.manage_task_type($1,$2,$3,$4)',[type,'x',true,[]],/project_admin_required/);
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/migrations/0013_hide_tasks_from_admins.sql',import.meta.url),'utf8'));
    await login(admin);
    await query('select public.manage_task_type($1,$2,$3,$4)',[type,'New label',false,[worker]]);
    await login(worker);
    assert.equal((await query('select id from public.room_tasks where id=$1',[task])).length,0);
    assert.equal((await query('select id from public.progress_updates where room_task_id=$1',[task])).length,0);
    assert.equal((await submit(operation(task,a,3,payload(45)))).error_code,'task_hidden');
    await login(viewer);
    assert.equal((await submit(operation(task,null,3,payload(95)))).error_code,'permission_denied');
    assert.equal((await first('select progress from public.room_tasks where id=$1',[task])).progress,35);
    assert.equal((await query('select id from public.room_tasks where id=$1',[task])).length,1);
    await login(admin);
    await query('select public.manage_task_type($1,$2,$3,$4)',[type,'New label',false,[outsider]]);
    await login(outsider);
    assert.equal((await query('select id from public.task_types where id=$1',[type])).length,1);
    assert.equal((await query('select id from public.room_tasks where id=$1',[task])).length,0);
    assert.equal((await submit(operation(task,null,3,payload(50)))).error_code,'task_hidden');
    await login(admin);
    await query('select public.manage_task_type($1,$2,$3,$4)',[type,'New label',true,[]]);
    assert.equal((await query('select id from public.room_tasks where id=$1',[task])).length,1);
    await login(viewer);
    assert.equal((await query('select id from public.room_tasks where id=$1',[task])).length,0);
    await login(admin);
    await query('select public.manage_task_type($1,$2,$3,$4)',[type,'New label',false,[]]);
    await login(worker);
    assert.equal((await first('select progress from public.room_tasks where id=$1',[task])).progress,35);
    assert.equal((await first('select label from public.task_types where id=$1',[type])).label,'New label');
  });

  await t.test('tracking floors seed 129 rooms and support whole-floor assignment without resetting progress',async()=>{
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/migrations/0007_tracking_floors.sql',import.meta.url),'utf8'));
    await login(admin);
    const p=(await first('select public.create_mixed_use_project() as id')).id;
    assert.equal((await first('select count(*)::int as n from public.rooms where project_id=$1',[p])).n,129);
    const f=(await first("select id from public.floors where project_id=$1 and code='r5'",[p])).id;
    assert.equal((await first('select public.assign_floors($1,$2,$3) as n',[p,[f],admin])).n,1700);
    assert.equal((await first('select public.assign_floors($1,$2,$3) as n',[p,[f],admin])).n,0);
    await login(worker);
    await reject('select public.assign_floors($1,$2,$3)',[p,[f],worker],/project_admin_required/);
  });

  await t.test('upgrade script can be reapplied without removing visibility enforcement',async()=>{
    await db.exec('reset role');
    await db.exec(await readFile(new URL('../supabase/upgrade_existing_project.sql',import.meta.url),'utf8'));
    const body=(await first("select prosrc from pg_proc where oid='public.submit_progress(uuid,uuid,uuid,uuid,bigint,timestamptz,jsonb,uuid)'::regprocedure")).prosrc;
    assert.ok(body.includes('task_hidden'));
  });

 await t.test('upper floor typology migration preserves progress and seeds correct future rooms',async()=>{
  await db.exec('reset role');
  const before=await query('select id,progress,version from public.room_tasks order by id');
  await db.exec(await readFile(new URL('../supabase/migrations/0008_room_typologies.sql',import.meta.url),'utf8'));
  assert.deepEqual(await query('select id,progress,version from public.room_tasks order by id'),before);
  assert.equal((await first("select count(*)::int as n from public.rooms r join public.floors f on f.id=r.floor_id where f.code in ('r4','r5') and r.number in ('414','514') and r.room_type <> 'executive'")).n,0);
  await login(admin);
  const p=(await first('select public.create_mixed_use_project() as id')).id;
  assert.equal((await first("select room_type from public.rooms where project_id=$1 and number='525'",[p])).room_type,'junior');
  assert.equal((await first("select room_type from public.rooms where project_id=$1 and number='414'",[p])).room_type,'executive');
 });

 await t.test('input errors accept no explanation while scope changes still require one',async()=>{
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../supabase/migrations/0009_optional_input_error_note.sql',import.meta.url),'utf8'));
  await login(admin);
  const task=await first("select t.id,t.version from public.room_tasks t join public.project_members m on m.project_id=t.project_id where m.user_id=$1 and m.role='admin' and m.status='active' and t.archived_at is null limit 1",[admin]);
  const v=Number(task.version);
  assert.equal((await submit(operation(task.id,null,v,payload(10,{correction_reason:'scope-change',correction_note:''})))).error_code,'invalid_payload');
  assert.equal((await submit(operation(task.id,null,v,payload(10,{correction_reason:'input-error'})))).status,'accepted');
  assert.equal((await submit(operation(task.id,null,v+1,payload(5,{correction_reason:'input-error',correction_note:''})))).status,'accepted');
 });

 await t.test('single-use invitation gates account creation and keeps role server-controlled',async()=>{
  await db.exec('reset role');
  await db.exec("alter table auth.users add column raw_app_meta_data jsonb not null default '{}'; create role service_role nologin;");
  await db.exec(await readFile(new URL('../supabase/migrations/0010_invitation_accounts.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/0011_finalize_invitations_outside_auth_trigger.sql',import.meta.url),'utf8'));
  await login(admin);
  const p=(await first("select public.create_project('Invites') as id")).id;
  const inv=(await first('select public.create_account_invitation($1,$2) as data',[p,'viewer'])).data;
  await reject('select public.create_account_invitation($1,$2)',[p,'admin'],/invalid_role/);
  await login(worker);
  await reject('select public.create_account_invitation($1,$2)',[p,'worker'],/project_admin_required/);
  assert.equal((await query('select id from public.account_invitations')).length,0);
  await db.exec('reset role');
  const user=randomUUID();
  const uninvited=randomUUID();
  await query('insert into auth.users(id) values ($1)',[uninvited]);
  assert.equal((await query('select id from public.profiles where id=$1',[uninvited])).length,0);
  const hash=(await first("select encode(sha256(convert_to($1,'UTF8')),'hex') as h",[inv.token])).h;
  await query('insert into auth.users(id,raw_app_meta_data) values ($1,$2)',[user,JSON.stringify({invitation_hash:hash,username:'new.person'})]);
  await login(null,'service_role');
  await query('select public.complete_account_invitation($1,$2,$3)',[hash,user,'new.person']);
  await db.exec('reset role');
  assert.equal((await first('select role from public.project_members where project_id=$1 and user_id=$2',[p,user])).role,'viewer');
  await login(null,'service_role');
  await reject('select public.complete_account_invitation($1,$2,$3)',[hash,user,'new.person'],/invitation_invalid/);
  await login(admin);

  const expiry=(await first('select public.create_account_invitation($1,$2) as data',[p,'worker'])).data;
  const duplicate=(await first('select public.create_account_invitation($1,$2) as data',[p,'worker'])).data;
  await db.exec('reset role');
  const expiryHash=(await first("select encode(sha256(convert_to($1,'UTF8')),'hex') as h",[expiry.token])).h;
  await query("update public.account_invitations set expires_at=now()-interval '1 second' where id=$1",[expiry.id]);
  const expiredUser=randomUUID();await query('insert into auth.users(id,raw_app_meta_data) values ($1,$2)',[expiredUser,JSON.stringify({invitation_hash:expiryHash,username:'expired.person'})]);
  await login(null,'service_role');
  await reject('select public.complete_account_invitation($1,$2,$3)',[expiryHash,expiredUser,'expired.person'],/invitation_invalid/);
  await db.exec('reset role');
  const duplicateHash=(await first("select encode(sha256(convert_to($1,'UTF8')),'hex') as h",[duplicate.token])).h;
  const duplicateUser=randomUUID();await query('insert into auth.users(id,raw_app_meta_data) values ($1,$2)',[duplicateUser,JSON.stringify({invitation_hash:duplicateHash,username:'new.person'})]);
  await login(null,'service_role');
  await reject('select public.complete_account_invitation($1,$2,$3)',[duplicateHash,duplicateUser,'new.person'],/duplicate key/);
  await db.exec('reset role');
  assert.equal((await first('select used_at from public.account_invitations where id=$1',[duplicate.id])).used_at,null);
  await login(admin);
  const revoke=(await first('select public.create_account_invitation($1,$2) as data',[p,'worker'])).data;
  await query('select public.revoke_account_invitation($1)',[revoke.id]);
  await db.exec('reset role');
  const hash2=(await first("select encode(sha256(convert_to($1,'UTF8')),'hex') as h",[revoke.token])).h;
  const revokedUser=randomUUID();await query('insert into auth.users(id,raw_app_meta_data) values ($1,$2)',[revokedUser,JSON.stringify({invitation_hash:hash2,username:'revoked.person'})]);
  await login(null,'service_role');
  await reject('select public.complete_account_invitation($1,$2,$3)',[hash2,revokedUser,'revoked.person'],/invitation_invalid/);
 });

 await t.test('test progress reset clears entries and activity without changing project setup',async()=>{
  await db.exec('reset role');
  const before=await first(`select
    (select count(*)::int from public.projects) projects,
    (select count(*)::int from public.project_members) members,
    (select count(*)::int from public.task_assignments) assignments,
    (select count(*)::int from public.room_tasks) tasks,
    (select count(*)::int from public.progress_updates) updates`);
  assert.ok(before.updates>0);
  await db.exec(await readFile(new URL('../supabase/migrations/0016_reset_test_progress.sql',import.meta.url),'utf8'));
  const after=await first(`select
    (select count(*)::int from public.projects) projects,
    (select count(*)::int from public.project_members) members,
    (select count(*)::int from public.task_assignments) assignments,
    (select count(*)::int from public.room_tasks) tasks,
    (select count(*)::int from public.progress_updates) updates,
    (select count(*)::int from public.sync_operations) operations,
    (select count(*)::int from public.room_tasks where progress<>0 or blocked or note<>'' or start_date is not null or end_date is not null or locked_progress<>0) dirty`);
  assert.deepEqual({projects:after.projects,members:after.members,assignments:after.assignments,tasks:after.tasks},
    {projects:before.projects,members:before.members,assignments:before.assignments,tasks:before.tasks});
  assert.equal(after.updates,0);assert.equal(after.operations,0);assert.equal(after.dirty,0);
 });

 await t.test('Excel hidden columns are applied only to the matching administrator',async()=>{
  await db.exec('reset role');
  await query("update public.profiles set display_name='Merini Yassine' where id=$1",[admin]);
  await query("update public.task_types set source_column='E', hidden_user_ids='{}' where id=$1",[type]);
  const visibleType=(await first(`insert into public.task_types(project_id,code,label,zone,source_column,hidden_user_ids)
    values ($1,'visible-test','Visible','bathroom','K',$2) returning id`,[project,[admin]])).id;
  await db.exec(await readFile(new URL('../supabase/migrations/0017_apply_excel_visibility_to_merini.sql',import.meta.url),'utf8'));
  assert.deepEqual((await first('select hidden_user_ids from public.task_types where id=$1',[type])).hidden_user_ids,[admin]);
  assert.deepEqual((await first('select hidden_user_ids from public.task_types where id=$1',[visibleType])).hidden_user_ids,[]);
 });

 await t.test('corrective Excel visibility also works through the project owner fallback',async()=>{
  await db.exec('reset role');
  await query("update public.profiles set display_name='Nom différent' where id=$1",[admin]);
  await query("update public.task_types set hidden_user_ids='{}' where id=$1",[type]);
  await db.exec(await readFile(new URL('../supabase/migrations/0018_enforce_merini_excel_visibility.sql',import.meta.url),'utf8'));
  assert.deepEqual((await first('select hidden_user_ids from public.task_types where id=$1',[type])).hidden_user_ids,[admin]);
  await login(admin);
  assert.equal((await first('select private.task_type_visible($1) visible',[type])).visible,false);
  assert.equal((await query('select id from public.task_types where id=$1',[type])).length,0);
 });


 await t.test('task photos enforce membership, assignment and hidden-task access without changing progress',async()=>{
  await db.exec('reset role');
  await db.exec(`
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql immutable as
      $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select,insert,delete on storage.objects to authenticated;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/0019_task_photos.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/0020_photo_categories.sql',import.meta.url),'utf8'));
  await query("update public.task_types set hidden=false,hidden_user_ids='{}' where id=$1",[type]);
  await query("update public.rooms set archived_at=null where id=$1",[room]);
  const photo=randomUUID(), path=task+'/'+admin+'/'+photo+'.jpg';
  await login(admin);
  const before=await first('select progress from public.room_tasks where id=$1',[task]);
  await query("insert into storage.objects values('task-photos',$1)",[path]);
  await query("insert into public.task_photos(id,project_id,room_task_id,uploaded_by,storage_path,needs_review,photo_type) values($1,$2,$3,$4,$5,true,'issue')",[photo,project,task,admin,path]);
  assert.equal((await first('select photo_type from public.task_photos where id=$1',[photo])).photo_type,'issue');
  const invalidPhoto=randomUUID(), invalidPath=task+'/'+admin+'/'+invalidPhoto+'.jpg';
  await query("insert into storage.objects values('task-photos',$1)",[invalidPath]);
  await reject("insert into public.task_photos(id,project_id,room_task_id,uploaded_by,storage_path,photo_type) values($1,$2,$3,$4,$5,$6)",[invalidPhoto,project,task,admin,invalidPath,'unknown'],/check constraint/);
  assert.deepEqual(await first('select progress from public.room_tasks where id=$1',[task]),before);
  assert.equal((await query('select id from public.task_photos where id=$1',[photo])).length,1);
  await query("delete from storage.objects where name=$1",[path]);
  assert.equal((await query("select name from storage.objects where name=$1",[path])).length,1);
  await login(viewer);
  assert.equal((await query('select id from public.task_photos where id=$1',[photo])).length,1);
  assert.equal((await first('select private.can_add_task_photo($1) allowed',[task])).allowed,false);
  await reject("insert into storage.objects values('task-photos',$1)",[task+'/'+viewer+'/'+randomUUID()+'.jpg'],/row-level security/);
  await login(outsider);
  assert.equal((await query('select id from public.task_photos where id=$1',[photo])).length,0);
  await db.exec('reset role');
  await login(admin);
  await db.exec('reset role');
  await query("update public.task_types set hidden_user_ids=$2 where id=$1",[type,[admin]]);
  await login(admin);
  assert.equal((await query('select id from public.task_photos where id=$1',[photo])).length,0);
  assert.equal((await query("select name from storage.objects where name=$1",[path])).length,0);
  assert.equal((await first('select private.can_add_task_photo($1) allowed',[task])).allowed,false);
 });
 });



