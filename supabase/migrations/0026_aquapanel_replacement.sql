-- Track Aquapanel replacement independently under bedroom partitions.
-- AN_A is intentionally outside the original Excel template's columns.
begin;

create or replace function private.add_aquapanel_task_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.zone = 'bedroom' and new.code = 'partitions' and new.archived_at is null then
    insert into public.task_types
      (project_id, code, label, zone, group_label, source_column, sort_order, hidden, hidden_user_ids)
    values
      (new.project_id, 'aquapanel-replacement', 'Changement d’aquapanel',
       'bedroom', 'Cloisons', 'AN_A', new.sort_order + 1, new.hidden, new.hidden_user_ids)
    on conflict (project_id, zone, code) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists zz_add_aquapanel_task_type on public.task_types;
create trigger zz_add_aquapanel_task_type after insert on public.task_types
for each row execute function private.add_aquapanel_task_type();

insert into public.task_types
  (project_id, code, label, zone, group_label, source_column, sort_order, hidden, hidden_user_ids)
select parent.project_id, 'aquapanel-replacement', 'Changement d’aquapanel',
       'bedroom', 'Cloisons', 'AN_A', parent.sort_order + 1, parent.hidden, parent.hidden_user_ids
from public.task_types parent
where parent.zone = 'bedroom' and parent.code = 'partitions' and parent.archived_at is null
on conflict (project_id, zone, code) do nothing;

-- Existing room responsibility carries over; progress starts at zero.
insert into public.task_assignments
  (project_id, room_task_id, assignee_id, assigned_by, reason)
select newer.project_id, newer.id, assignment.assignee_id, assignment.assigned_by,
       'Affectation reprise des cloisons chambre'
from public.room_tasks newer
join public.task_types new_type on new_type.id = newer.task_type_id
join public.room_tasks older on older.room_id = newer.room_id
join public.task_types old_type on old_type.id = older.task_type_id
join public.task_assignments assignment on assignment.room_task_id = older.id and assignment.ended_at is null
where new_type.zone = 'bedroom' and new_type.code = 'aquapanel-replacement'
  and old_type.zone = 'bedroom' and old_type.code = 'partitions'
  and newer.archived_at is null
on conflict do nothing;

notify pgrst, 'reload schema';
commit;
