alter table public.api_keys enable row level security;

revoke all on table public.api_keys from public;
revoke all on table public.api_keys from anon;
revoke all on table public.api_keys from authenticated;

grant select, insert, update, delete on table public.api_keys to service_role;

drop policy if exists "Service role manage api keys" on public.api_keys;
create policy "Service role manage api keys" on public.api_keys
  for all to service_role
  using (true)
  with check (true);

select pg_notify('pgrst', 'reload schema');
