-- A worker can hide or show assigned task types in their own tracking view.
-- Admin OFF and admin per-user exclusions remain authoritative.
begin;

create table if not exists public.member_task_preferences (
  project_id uuid not null,
  user_id uuid not null,
  task_type_id uuid not null,
  hidden boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id, task_type_id),
  foreign key (project_id, user_id) references public.project_members(project_id, user_id) on delete cascade,
  foreign key (project_id, task_type_id) references public.task_types(project_id, id) on delete cascade
);

alter table public.member_task_preferences enable row level security;
revoke all on public.member_task_preferences from public, anon, authenticated;
grant select on public.member_task_preferences to authenticated;
drop policy if exists member_task_preferences_own_read on public.member_task_preferences;
create policy member_task_preferences_own_read on public.member_task_preferences
  for select to authenticated
  using (user_id = auth.uid() and private.project_role(project_id) = 'worker');

create or replace function public.set_my_task_visibility(
  p_project_id uuid, p_task_type_id uuid, p_visible boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_visible is null then raise exception 'invalid_visibility'; end if;
  if private.project_role(p_project_id) is distinct from 'worker' or not exists (
    select 1 from public.projects where id = p_project_id and archived_at is null
  ) then
    raise exception 'worker_access_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.task_types tt
    where tt.id = p_task_type_id and tt.project_id = p_project_id
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
  if p_visible then
    delete from public.member_task_preferences
    where project_id = p_project_id and user_id = auth.uid() and task_type_id = p_task_type_id;
  else
    insert into public.member_task_preferences(project_id, user_id, task_type_id, hidden)
    values (p_project_id, auth.uid(), p_task_type_id, true)
    on conflict (project_id, user_id, task_type_id)
    do update set hidden = true, updated_at = now();
  end if;
end $$;

revoke all on function public.set_my_task_visibility(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.set_my_task_visibility(uuid,uuid,boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
