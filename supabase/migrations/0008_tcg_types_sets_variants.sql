-- TCG types, richer set metadata, and card variants
-- Adds a dedicated card_variants table while keeping existing cards/products intact.

-- Rename categories -> tcg_types if present (keep data)
do $$
begin
  if to_regclass('public.tcg_types') is null and to_regclass('public.categories') is not null then
    alter table public.categories rename to tcg_types;
  end if;
end $$;

-- Ensure tcg_types exists for fresh installs
create table if not exists public.tcg_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Rename category_id -> tcg_type_id in existing tables
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'card_sets' and column_name = 'category_id'
  ) then
    alter table public.card_sets rename column category_id to tcg_type_id;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'category_id'
  ) then
    alter table public.products rename column category_id to tcg_type_id;
  end if;
end $$;

-- TCG type metadata
alter table public.tcg_types
  add column if not exists slug text,
  add column if not exists abbreviation text,
  add column if not exists publisher text,
  add column if not exists description text,
  add column if not exists official_url text,
  add column if not exists icon_url text,
  add column if not exists logo_url text,
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_updated_at_tcg_types on public.tcg_types;
create trigger set_updated_at_tcg_types
before update on public.tcg_types
for each row execute function public.set_updated_at();

-- Enrich set metadata
alter table public.card_sets
  add column if not exists series text,
  add column if not exists subseries text,
  add column if not exists total_cards integer,
  add column if not exists printed_total integer,
  add column if not exists release_year integer,
  add column if not exists symbol_url text,
  add column if not exists logo_url text,
  add column if not exists icon_url text,
  add column if not exists official_url text,
  add column if not exists description text,
  add column if not exists ptcg_api_id text,
  add column if not exists tcgplayer_url text,
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_updated_at_card_sets on public.card_sets;
create trigger set_updated_at_card_sets
before update on public.card_sets
for each row execute function public.set_updated_at();

-- Enrich card metadata (base card details)
alter table public.cards
  add column if not exists card_type text,
  add column if not exists hp text,
  add column if not exists stage text,
  add column if not exists attack1 text,
  add column if not exists attack2 text,
  add column if not exists weakness text,
  add column if not exists resistance text,
  add column if not exists retreat_cost text,
  add column if not exists artist text,
  add column if not exists flavor_text text,
  add column if not exists rules_text text,
  add column if not exists image_count integer,
  add column if not exists external_url text,
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_updated_at_cards on public.cards;
create trigger set_updated_at_cards
before update on public.cards
for each row execute function public.set_updated_at();

-- Card variants: one-to-many per card
create table if not exists public.card_variants (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards(id) on delete cascade,
  name text not null, -- e.g., Normal, Holofoil, Reverse Holofoil
  finish text,
  tcg_product_id integer unique,
  image_url text,
  image_count integer,
  external_url text,
  is_foil boolean,
  is_promo boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (card_id, name)
);
create index if not exists card_variants_card_idx on public.card_variants(card_id);

drop trigger if exists set_updated_at_card_variants on public.card_variants;
create trigger set_updated_at_card_variants
before update on public.card_variants
for each row execute function public.set_updated_at();

-- Variant pricing snapshots
create table if not exists public.card_variant_prices (
  id bigserial primary key,
  variant_id uuid references public.card_variants(id) on delete cascade,
  source text not null default 'tcgplayer',
  currency text not null default 'USD',
  low_price numeric(10,2),
  mid_price numeric(10,2),
  high_price numeric(10,2),
  market_price numeric(10,2),
  direct_low_price numeric(10,2),
  captured_at timestamptz not null default now(),
  unique (variant_id, source, captured_at)
);
create index if not exists card_variant_prices_variant_time_idx
  on public.card_variant_prices (variant_id, captured_at desc);

-- RLS + policies
alter table public.tcg_types enable row level security;
alter table public.card_variants enable row level security;
alter table public.card_variant_prices enable row level security;

drop policy if exists "Public read tcg types" on public.tcg_types;
create policy "Public read tcg types" on public.tcg_types
  for select using (true);

drop policy if exists "Authenticated can insert tcg types" on public.tcg_types;
create policy "Authenticated can insert tcg types" on public.tcg_types
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update tcg types" on public.tcg_types;
create policy "Authenticated can update tcg types" on public.tcg_types
  for update to authenticated using (true) with check (true);

drop policy if exists "Public read card variants" on public.card_variants;
create policy "Public read card variants" on public.card_variants
  for select using (true);

drop policy if exists "Authenticated can insert card variants" on public.card_variants;
create policy "Authenticated can insert card variants" on public.card_variants
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update card variants" on public.card_variants;
create policy "Authenticated can update card variants" on public.card_variants
  for update to authenticated using (true) with check (true);

drop policy if exists "Public read card variant prices" on public.card_variant_prices;
create policy "Public read card variant prices" on public.card_variant_prices
  for select using (true);

drop policy if exists "Authenticated can insert card variant prices" on public.card_variant_prices;
create policy "Authenticated can insert card variant prices" on public.card_variant_prices
  for insert to authenticated with check (true);
