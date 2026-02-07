-- Allow authenticated users (admin via client) to insert/update catalog tables

alter table public.categories enable row level security;
alter table public.card_sets enable row level security;

-- Categories
drop policy if exists "Authenticated can insert categories" on public.categories;
create policy "Authenticated can insert categories" on public.categories
  for insert to authenticated
  with check (true);

drop policy if exists "Authenticated can update categories" on public.categories;
create policy "Authenticated can update categories" on public.categories
  for update to authenticated
  using (true)
  with check (true);

-- Card sets
drop policy if exists "Authenticated can insert sets" on public.card_sets;
create policy "Authenticated can insert sets" on public.card_sets
  for insert to authenticated
  with check (true);

drop policy if exists "Authenticated can update sets" on public.card_sets;
create policy "Authenticated can update sets" on public.card_sets
  for update to authenticated
  using (true)
  with check (true);
