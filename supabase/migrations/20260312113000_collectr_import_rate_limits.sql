create table if not exists public.collectr_import_rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  window_start date not null,
  request_count integer not null default 0 check (request_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, window_start)
);

create index if not exists idx_collectr_import_rate_limits_window_start
  on public.collectr_import_rate_limits (window_start);

create or replace function public.consume_collectr_import_quota(
  p_user_id uuid,
  p_limit integer,
  p_now timestamptz default now()
)
returns table (
  used_count integer,
  limit_count integer,
  remaining integer,
  window_start date,
  reset_at timestamptz,
  allowed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start date;
  v_reset_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'p_limit must be greater than 0';
  end if;

  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden';
  end if;

  v_window_start := (p_now at time zone 'utc')::date;
  v_reset_at := ((v_window_start + 1)::timestamp at time zone 'utc');

  insert into public.collectr_import_rate_limits (
    user_id,
    window_start,
    request_count,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    v_window_start,
    1,
    p_now,
    p_now
  )
  on conflict (user_id, window_start)
  do update
    set request_count = public.collectr_import_rate_limits.request_count + 1,
        updated_at = p_now
  returning public.collectr_import_rate_limits.request_count into used_count;

  limit_count := p_limit;
  remaining := greatest(0, limit_count - used_count);
  window_start := v_window_start;
  reset_at := v_reset_at;
  allowed := used_count <= limit_count;

  return next;
end;
$$;

revoke all on table public.collectr_import_rate_limits from anon, authenticated;
grant all on table public.collectr_import_rate_limits to service_role;

revoke all on function public.consume_collectr_import_quota(uuid, integer, timestamptz) from public;
grant execute on function public.consume_collectr_import_quota(uuid, integer, timestamptz) to service_role;

