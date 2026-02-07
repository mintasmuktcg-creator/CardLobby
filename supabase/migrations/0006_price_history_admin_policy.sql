-- Allow authenticated users to insert/update price history (needed for admin CSV upserts)

alter table public.price_history enable row level security;

drop policy if exists "Authenticated can insert price history" on public.price_history;
create policy "Authenticated can insert price history" on public.price_history
  for insert to authenticated
  with check (true);

drop policy if exists "Authenticated can update price history" on public.price_history;
create policy "Authenticated can update price history" on public.price_history
  for update to authenticated
  using (true)
  with check (true);
