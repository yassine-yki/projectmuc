-- OFF hides a task from tracking for every role. Administrators still use
-- list_task_types_for_management to see and reactivate hidden task types.
begin;

create or replace function private.task_type_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.project_role(project_id) is not null
      and not hidden
      and not (auth.uid() = any(hidden_user_ids))
    from public.task_types where id = p_id
  ), false)
$$;

drop policy if exists task_visibility on public.task_types;
create policy task_visibility on public.task_types as restrictive for select to authenticated
using (
  private.project_role(project_id) is not null
  and not hidden
  and not (auth.uid() = any(hidden_user_ids))
);

notify pgrst, 'reload schema';
commit;
