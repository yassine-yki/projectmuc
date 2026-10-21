-- Save a worker's personal ON/OFF choices in one transaction.
-- An absent preference uses the app's default task list; explicit ON and OFF
-- rows allow every assigned, admin-visible type to be changed afterward.
begin;

create or replace function public.set_my_task_visibility_bulk(
  p_project_id uuid, p_changes jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_change jsonb;
  v_type_id uuid;
  v_visible boolean;
  v_seen uuid[] := '{}';
begin
  if private.project_role(p_project_id) is distinct from 'worker' or not exists (
    select 1 from public.projects where id = p_project_id and archived_at is null
  ) then
    raise exception 'worker_access_required' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'invalid_changes';
  end if;
  if jsonb_array_length(p_changes) > 256 then raise exception 'too_many_changes'; end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change) is distinct from 'object'
      or jsonb_typeof(v_change->'visible') is distinct from 'boolean'
      or jsonb_typeof(v_change->'task_type_id') is distinct from 'string' then
      raise exception 'invalid_changes';
    end if;
    v_type_id := (v_change->>'task_type_id')::uuid;
    v_visible := (v_change->>'visible')::boolean;
    if v_type_id = any(v_seen) then raise exception 'duplicate_task_type'; end if;
    v_seen := array_append(v_seen, v_type_id);
    if not exists (
      select 1 from public.task_types tt
      where tt.id = v_type_id and tt.project_id = p_project_id
        and tt.archived_at is null and private.task_type_visible(tt.id)
        and exists (
          select 1 from public.room_tasks rt
          join public.task_assignments a on a.room_task_id = rt.id
          where rt.project_id = p_project_id and rt.task_type_id = tt.id
            and a.assignee_id = auth.uid() and a.ended_at is null
            and private.task_is_active(rt.id)
        )
    ) then
      raise exception 'assigned_visible_task_required' using errcode = '42501';
    end if;
  end loop;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    insert into public.member_task_preferences(project_id, user_id, task_type_id, hidden)
    values (p_project_id, auth.uid(), (v_change->>'task_type_id')::uuid, not (v_change->>'visible')::boolean)
    on conflict (project_id, user_id, task_type_id)
    do update set hidden = excluded.hidden, updated_at = now();
  end loop;
end $$;

revoke all on function public.set_my_task_visibility_bulk(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.set_my_task_visibility_bulk(uuid,jsonb) to authenticated;

-- Keep older browser versions consistent with explicit ON preferences.
create or replace function public.set_my_task_visibility(
  p_project_id uuid, p_task_type_id uuid, p_visible boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.set_my_task_visibility_bulk(
    p_project_id,
    jsonb_build_array(jsonb_build_object('task_type_id', p_task_type_id, 'visible', p_visible))
  );
end $$;

notify pgrst, 'reload schema';
commit;
