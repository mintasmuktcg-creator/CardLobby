-- User-owned Pokemon Japan products (collections).

create table if not exists public.user_owned_pokemon_japan_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.pokemon_japan_products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create index if not exists user_owned_pokemon_japan_products_user_idx
  on public.user_owned_pokemon_japan_products(user_id);
create index if not exists user_owned_pokemon_japan_products_product_idx
  on public.user_owned_pokemon_japan_products(product_id);

drop trigger if exists set_updated_at_user_owned_pokemon_japan_products
  on public.user_owned_pokemon_japan_products;
create trigger set_updated_at_user_owned_pokemon_japan_products
before update on public.user_owned_pokemon_japan_products
for each row execute function public.set_updated_at();

alter table public.user_owned_pokemon_japan_products enable row level security;

drop policy if exists "User read own pokemon japan products" on public.user_owned_pokemon_japan_products;
create policy "User read own pokemon japan products" on public.user_owned_pokemon_japan_products
  for select using (auth.uid() = user_id);

drop policy if exists "User insert own pokemon japan products" on public.user_owned_pokemon_japan_products;
create policy "User insert own pokemon japan products" on public.user_owned_pokemon_japan_products
  for insert with check (auth.uid() = user_id);

drop policy if exists "User update own pokemon japan products" on public.user_owned_pokemon_japan_products;
create policy "User update own pokemon japan products" on public.user_owned_pokemon_japan_products
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "User delete own pokemon japan products" on public.user_owned_pokemon_japan_products;
create policy "User delete own pokemon japan products" on public.user_owned_pokemon_japan_products
  for delete using (auth.uid() = user_id);
