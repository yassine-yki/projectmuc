begin;

-- Keep the existing task ID and all its progress: only its trade was mislabeled.
update public.task_types
set label = 'Enduit ciment — NOUR INOV', group_label = 'Enduit ciment'
where zone = 'bathroom' and code = 'wall-render'
  and (label is distinct from 'Enduit ciment — NOUR INOV'
    or group_label is distinct from 'Enduit ciment');

-- New rooms and new task types use the corrected applicability immediately.
create or replace function private.generate_room_tasks() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null then
    if tg_table_name = 'rooms' then
      insert into public.room_tasks(project_id, room_id, task_type_id)
      select new.project_id, new.id, tt.id from public.task_types tt
      where tt.project_id = new.project_id and tt.archived_at is null
        and (tt.zone <> 'bathroom' or tt.code <> 'wall-render' or new.room_type = 'standard')
      on conflict (room_id, task_type_id) do nothing;
    else
      insert into public.room_tasks(project_id, room_id, task_type_id)
      select new.project_id, r.id, new.id from public.rooms r
      where r.project_id = new.project_id and r.archived_at is null
        and (new.zone <> 'bathroom' or new.code <> 'wall-render' or r.room_type = 'standard')
      on conflict (room_id, task_type_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

-- Suites keep only BENTHAMI. The former NOUR INOV suite rows are archived,
-- rather than deleted, so their history remains available for audit.
update public.room_tasks rt set archived_at = coalesce(rt.archived_at, now())
from public.task_types tt, public.rooms r
where rt.task_type_id = tt.id and rt.room_id = r.id
  and tt.zone = 'bathroom' and tt.code = 'wall-render'
  and r.room_type is distinct from 'standard' and rt.archived_at is null;

insert into public.room_tasks(project_id, room_id, task_type_id)
select r.project_id, r.id, tt.id
from public.rooms r
join public.task_types tt on tt.project_id = r.project_id
where r.archived_at is null and tt.archived_at is null
  and tt.zone = 'bathroom' and tt.code = 'wall-render-benthami'
on conflict (room_id, task_type_id) do update set archived_at = null;

insert into public.room_tasks(project_id, room_id, task_type_id)
select r.project_id, r.id, tt.id
from public.rooms r
join public.task_types tt on tt.project_id = r.project_id
where r.archived_at is null and r.room_type = 'standard'
  and tt.archived_at is null and tt.zone = 'bathroom' and tt.code = 'wall-render'
on conflict (room_id, task_type_id) do update set archived_at = null;

create or replace function private.sync_wall_finish_room_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null then
    insert into public.room_tasks(project_id, room_id, task_type_id)
    select new.project_id, new.id, tt.id from public.task_types tt
    where tt.project_id = new.project_id and tt.zone = 'bathroom'
      and tt.code in ('wall-render', 'wall-render-benthami')
      and tt.archived_at is null
      and (tt.code <> 'wall-render' or new.room_type = 'standard')
    on conflict (room_id, task_type_id) do update set archived_at = null;
  end if;

  if new.room_type is distinct from 'standard' then
    update public.room_tasks rt set archived_at = coalesce(rt.archived_at, now())
    from public.task_types tt
    where rt.room_id = new.id and rt.task_type_id = tt.id
      and tt.zone = 'bathroom' and tt.code = 'wall-render'
      and rt.archived_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists zz_sync_benthami_room_type on public.rooms;
drop trigger if exists zz_sync_wall_finish_room_type on public.rooms;
create trigger zz_sync_wall_finish_room_type after update of room_type on public.rooms
for each row when (old.room_type is distinct from new.room_type)
execute function private.sync_wall_finish_room_type();
drop function if exists private.sync_benthami_room_type();

notify pgrst, 'reload schema';
commit;
