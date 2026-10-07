begin;

-- A separate room task is needed for each contractor. The existing task and
-- its progress remain attached to NOUR INOV.
create or replace function private.generate_room_tasks() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.archived_at is null then
    if tg_table_name = 'rooms' then
      insert into public.room_tasks(project_id, room_id, task_type_id)
      select new.project_id, new.id, tt.id from public.task_types tt
      where tt.project_id = new.project_id and tt.archived_at is null
        and (tt.code <> 'wall-render-benthami' or new.room_type = 'standard')
      on conflict (room_id, task_type_id) do nothing;
    else
      insert into public.room_tasks(project_id, room_id, task_type_id)
      select new.project_id, r.id, new.id from public.rooms r
      where r.project_id = new.project_id and r.archived_at is null
        and (new.code <> 'wall-render-benthami' or r.room_type = 'standard')
      on conflict (room_id, task_type_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.add_benthami_task_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.zone = 'bathroom' and new.code = 'wall-render' then
    insert into public.task_types
      (project_id, code, label, zone, group_label, source_column, sort_order, hidden, hidden_user_ids)
    values
      (new.project_id, 'wall-render-benthami', 'Dressage mur — BENTHAMI',
       'bathroom', 'Dressage', 'O_B', new.sort_order + 1, new.hidden, new.hidden_user_ids)
    on conflict (project_id, zone, code) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists zz_add_benthami_task_type on public.task_types;
create trigger zz_add_benthami_task_type after insert on public.task_types
for each row execute function private.add_benthami_task_type();

create or replace function private.sync_benthami_room_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.room_type = 'standard' then
    insert into public.room_tasks(project_id, room_id, task_type_id)
    select new.project_id, new.id, tt.id from public.task_types tt
    where tt.project_id = new.project_id and tt.zone = 'bathroom'
      and tt.code = 'wall-render-benthami' and tt.archived_at is null
    on conflict (room_id, task_type_id) do update set archived_at = null;
  else
    update public.room_tasks rt set archived_at = coalesce(rt.archived_at, now())
    from public.task_types tt
    where rt.room_id = new.id and rt.task_type_id = tt.id
      and tt.zone = 'bathroom' and tt.code = 'wall-render-benthami'
      and rt.archived_at is null;
  end if;
  return new;
end;
$$;
drop trigger if exists zz_sync_benthami_room_type on public.rooms;
create trigger zz_sync_benthami_room_type after update of room_type on public.rooms
for each row when (old.room_type is distinct from new.room_type)
execute function private.sync_benthami_room_type();

update public.task_types set label = 'Dressage mur — NOUR INOV'
where zone = 'bathroom' and code = 'wall-render' and label = 'Dressage mur';

insert into public.task_types
  (project_id, code, label, zone, group_label, source_column, sort_order, hidden, hidden_user_ids)
select project_id, 'wall-render-benthami', 'Dressage mur — BENTHAMI',
       'bathroom', 'Dressage', 'O_B', sort_order + 1, hidden, hidden_user_ids
from public.task_types parent
where parent.zone = 'bathroom' and parent.code = 'wall-render' and parent.archived_at is null
on conflict (project_id, zone, code) do nothing;

-- Repair any pre-existing BENTHAMI rows in suites; they must not be editable.
update public.room_tasks rt set archived_at = coalesce(rt.archived_at, now())
from public.task_types tt, public.rooms r
where rt.task_type_id = tt.id and rt.room_id = r.id
  and tt.zone = 'bathroom' and tt.code = 'wall-render-benthami'
  and r.room_type is distinct from 'standard' and rt.archived_at is null;

-- Keep current block responsibility on newly created standard-room tasks.
insert into public.task_assignments
  (project_id, room_task_id, assignee_id, assigned_by, reason)
select newer.project_id, newer.id, assignment.assignee_id, assignment.assigned_by,
       'Affectation reprise du dressage mur existant'
from public.room_tasks newer
join public.task_types new_type on new_type.id = newer.task_type_id
join public.room_tasks older on older.room_id = newer.room_id
join public.task_types old_type on old_type.id = older.task_type_id
join public.task_assignments assignment on assignment.room_task_id = older.id and assignment.ended_at is null
where new_type.zone = 'bathroom' and new_type.code = 'wall-render-benthami'
  and old_type.zone = 'bathroom' and old_type.code = 'wall-render'
  and newer.archived_at is null
on conflict do nothing;

-- Task management needs the full catalogue even when the current admin is
-- personally excluded from a task in the ordinary tracking view.
create or replace function public.list_task_types_for_management(p_project_id uuid)
returns setof public.task_types language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage(p_project_id) then
    raise exception 'project_admin_required' using errcode = '42501';
  end if;
  return query select tt.* from public.task_types tt
    where tt.project_id = p_project_id and tt.archived_at is null
    order by tt.zone, tt.sort_order, tt.id;
end;
$$;
revoke all on function public.list_task_types_for_management(uuid) from public, anon;
grant execute on function public.list_task_types_for_management(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
