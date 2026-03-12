create table if not exists public.api_keys (
  api_key_id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  rate_limit_per_min integer,
  is_unlimited boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_api_keys_active
  on public.api_keys (is_active);

alter table public.api_key_requests
  add column if not exists reviewed_by uuid references auth.users (id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists api_key_id uuid,
  add column if not exists issued_api_key text;

create unique index if not exists uq_api_key_requests_user_id
  on public.api_key_requests (user_id)
  where user_id is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'api_key_requests_status_check'
  ) then
    alter table public.api_key_requests
      add constraint api_key_requests_status_check
      check (status in ('pending', 'approved', 'denied'));
  end if;
end
$$;

select pg_notify('pgrst', 'reload schema');
