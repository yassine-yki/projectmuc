-- Start each project with only the requested bedroom and bathroom tasks ON.
-- Other task types and their progress remain available to administrators in
-- Gestion des tâches, where they can be turned ON individually later.
begin;

create or replace function private.default_tracking_task_visible(p_zone text, p_code text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_zone
    when 'bedroom' then p_code in ('partitions', 'screed')
    when 'bathroom' then p_code in ('waterproofing', 'wall-render', 'wall-render-benthami', 'floor-screed')
    else true
  end
$$;

create or replace function private.apply_default_tracking_task_visibility()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.hidden := not private.default_tracking_task_visible(new.zone, new.code);
  return new;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.task_types'::regclass
      and tgname = 'apply_default_tracking_task_visibility'
      and not tgisinternal
  ) then
    update public.task_types
    set hidden = not private.default_tracking_task_visible(zone, code)
    where zone in ('bedroom', 'bathroom')
      and hidden is distinct from not private.default_tracking_task_visible(zone, code);

    create trigger apply_default_tracking_task_visibility
      before insert on public.task_types
      for each row execute function private.apply_default_tracking_task_visibility();
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
