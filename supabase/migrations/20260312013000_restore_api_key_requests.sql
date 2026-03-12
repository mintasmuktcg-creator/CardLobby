create table if not exists public.api_key_requests (
  request_id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  email text,
  reason text not null,
  status text not null default 'pending',
  source_ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  admin_notes text
);

create index if not exists idx_api_key_requests_created_at
  on public.api_key_requests (created_at desc);

create index if not exists idx_api_key_requests_status
  on public.api_key_requests (status);

alter table public.api_key_requests enable row level security;

drop policy if exists "Authenticated can insert api key requests" on public.api_key_requests;
create policy "Authenticated can insert api key requests" on public.api_key_requests
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Authenticated can read own api key requests" on public.api_key_requests;
create policy "Authenticated can read own api key requests" on public.api_key_requests
  for select to authenticated
  using (auth.uid() = user_id);

select pg_notify('pgrst', 'reload schema');
