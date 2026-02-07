-- Pokemon catalog + pricing schema, tailored to TCGplayer CSV fields
-- Safe to run after 0001_cardlobby_schema.sql

create extension if not exists "pg_trgm";

-- Sets: link to external TCG identifiers for easier imports
alter table if exists public.card_sets
  add column if not exists tcg_group_id integer,
  add column if not exists tcg_category_id integer;
create index if not exists card_sets_group_idx on public.card_sets(tcg_group_id);

-- Unified products table for both singles and sealed items
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tcg_product_id integer unique,
  category_id uuid references public.categories(id) on delete set null,
  set_id uuid references public.card_sets(id) on delete set null,
  name text not null,
  clean_name text,
  product_type text not null check (product_type in ('single','sealed')),
  subtype text,                  -- e.g., Normal, Holofoil, Reverse Holofoil, Tech Sticker
  card_number text,              -- e.g., 180/217
  rarity text,
  card_type text,                -- e.g., Fire, Trainer
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
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(clean_name,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(card_number,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(rarity,'')), 'C')
  ) stored
);

create index if not exists products_type_set_idx on public.products(product_type, set_id);
create index if not exists products_cardnum_idx on public.products(card_number);
create index if not exists products_search_idx on public.products using gin (search_vector);
create index if not exists products_name_trgm on public.products using gin (name gin_trgm_ops);

-- Pricing snapshots per product
create table if not exists public.product_prices (
  id bigserial primary key,
  product_id uuid references public.products(id) on delete cascade,
  source text not null default 'tcgplayer',
  currency text not null default 'USD',
  low_price numeric(10,2),
  mid_price numeric(10,2),
  high_price numeric(10,2),
  market_price numeric(10,2),
  direct_low_price numeric(10,2),
  captured_at timestamptz not null default now(),
  unique (product_id, source, captured_at)
);
create index if not exists product_prices_product_time_idx on public.product_prices (product_id, captured_at desc);

-- Row Level Security
alter table public.products enable row level security;
alter table public.product_prices enable row level security;

-- Public can read catalog and prices
drop policy if exists "Public read products" on public.products;
create policy "Public read products" on public.products
  for select using (true);
drop policy if exists "Public read product prices" on public.product_prices;
create policy "Public read product prices" on public.product_prices
  for select using (true);

-- Optional admin-only inserts/updates: replace auth.role() check with your admin UID logic if needed
drop policy if exists "Authenticated can insert products" on public.products;
create policy "Authenticated can insert products" on public.products
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "Authenticated can insert prices" on public.product_prices;
create policy "Authenticated can insert prices" on public.product_prices
  for insert with check (auth.role() = 'authenticated');
