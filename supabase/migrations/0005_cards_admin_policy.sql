-- Allow authenticated users to insert/update cards (needed for admin CSV upserts)

alter table public.cards enable row level security;

drop policy if exists "Authenticated can insert cards" on public.cards;
create policy "Authenticated can insert cards" on public.cards
  for insert to authenticated
  with check (true);

drop policy if exists "Authenticated can update cards" on public.cards;
create policy "Authenticated can update cards" on public.cards
  for update to authenticated
  using (true)
  with check (true);
