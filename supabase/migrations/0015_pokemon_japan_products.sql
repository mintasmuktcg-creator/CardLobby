-- Create Pokemon Japan products table (separate from pokemon_products).

create table if not exists public.pokemon_japan_products (
  id uuid primary key default gen_random_uuid(),
  tcg_product_id integer not null unique,
  set_id uuid not null references public.pokemon_japan_sets(id) on delete cascade,
  name text not null,
  clean_name text,
  product_type text not null check (product_type in ('single','sealed')),
  subtype text,
  card_number text,
  rarity text,
  card_type text,
  hp text,
  stage text,
  attack1 text,
  attack2 text,
  weakness text,
  resistance text,
  retreat_cost text,
  image_url text,
  image_count integer,
  external_url text,
  modified_on timestamptz,
  created_at timestamptz not null default now(),
  low_price numeric(10,2),
  mid_price numeric(10,2),
  high_price numeric(10,2),
  market_price numeric(10,2),
  direct_low_price numeric(10,2),
  currency text not null default 'USD',
  price_updated_at timestamptz,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(clean_name,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(card_number,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(rarity,'')), 'C')
  ) stored
);

create index if not exists pokemon_japan_products_type_set_idx
  on public.pokemon_japan_products(product_type, set_id);
create index if not exists pokemon_japan_products_cardnum_idx
  on public.pokemon_japan_products(card_number);
create index if not exists pokemon_japan_products_search_idx
  on public.pokemon_japan_products using gin (search_vector);
create index if not exists pokemon_japan_products_name_trgm
  on public.pokemon_japan_products using gin (name gin_trgm_ops);

alter table public.pokemon_japan_products enable row level security;

drop policy if exists "Public read pokemon japan products" on public.pokemon_japan_products;
create policy "Public read pokemon japan products" on public.pokemon_japan_products
  for select using (true);

drop policy if exists "Authenticated can insert pokemon japan products" on public.pokemon_japan_products;
create policy "Authenticated can insert pokemon japan products" on public.pokemon_japan_products
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update pokemon japan products" on public.pokemon_japan_products;
create policy "Authenticated can update pokemon japan products" on public.pokemon_japan_products
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can delete pokemon japan products" on public.pokemon_japan_products;
create policy "Authenticated can delete pokemon japan products" on public.pokemon_japan_products
  for delete to authenticated using (true);
