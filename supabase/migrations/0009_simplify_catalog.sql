-- Simplified catalog schema: tcg_types -> card_sets -> products -> variants -> variant_price_history
-- Clears existing records and removes legacy tables.

-- Drop legacy tables that are no longer used.
drop table if exists public.card_variant_prices cascade;
drop table if exists public.product_prices cascade;
drop table if exists public.price_history cascade;
drop table if exists public.card_variants cascade;
drop table if exists public.cards cascade;
drop table if exists public.user_collections cascade;

-- Clear existing records in the core tables (fresh import expected).
truncate table public.products, public.card_sets, public.tcg_types restart identity cascade;

-- Ensure tcg_types exists and has the extended metadata columns.
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

-- Ensure card_sets is wired to tcg_types and keeps metadata columns.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'card_sets' and column_name = 'category_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'card_sets' and column_name = 'tcg_type_id'
  ) then
    alter table public.card_sets rename column category_id to tcg_type_id;
  end if;
end $$;

alter table public.card_sets
  add column if not exists tcg_type_id uuid,
  add column if not exists tcg_group_id integer,
  add column if not exists tcg_category_id integer,
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

alter table public.card_sets drop constraint if exists card_sets_category_id_fkey;
alter table public.card_sets drop constraint if exists card_sets_tcg_type_id_fkey;
alter table public.card_sets
  add constraint card_sets_tcg_type_id_fkey foreign key (tcg_type_id)
  references public.tcg_types(id) on delete cascade;

drop table if exists public.categories cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'card_sets_tcg_type_name_key'
  ) then
    alter table public.card_sets
      add constraint card_sets_tcg_type_name_key unique (tcg_type_id, name);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'card_sets_code_key'
  ) then
    alter table public.card_sets
      add constraint card_sets_code_key unique (code);
  end if;
end $$;

drop trigger if exists set_updated_at_card_sets on public.card_sets;
create trigger set_updated_at_card_sets
before update on public.card_sets
for each row execute function public.set_updated_at();

-- Products belong to sets only.
alter table public.products drop constraint if exists products_category_id_fkey;
alter table public.products drop constraint if exists products_tcg_type_id_fkey;
alter table public.products drop column if exists tcg_type_id;
alter table public.products drop column if exists category_id;
alter table public.products
  alter column set_id set not null,
  alter column product_type set not null,
  alter column tcg_product_id set not null;

-- Variants (current price lives here).
drop table if exists public.variants cascade;
create table public.variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  subtype_name text not null,
  image_url text,
  image_count integer,
  external_url text,
  low_price numeric(10,2),
  mid_price numeric(10,2),
  high_price numeric(10,2),
  market_price numeric(10,2),
  direct_low_price numeric(10,2),
  currency text not null default 'USD',
  price_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, subtype_name)
);
create index if not exists variants_product_idx on public.variants(product_id);

drop trigger if exists set_updated_at_variants on public.variants;
create trigger set_updated_at_variants
before update on public.variants
for each row execute function public.set_updated_at();

-- Variant price history (time series).
drop table if exists public.variant_price_history cascade;
create table public.variant_price_history (
  id bigserial primary key,
  variant_id uuid not null references public.variants(id) on delete cascade,
  source text not null default 'csv',
  currency text not null default 'USD',
  low_price numeric(10,2),
  mid_price numeric(10,2),
  high_price numeric(10,2),
  market_price numeric(10,2),
  direct_low_price numeric(10,2),
  captured_at timestamptz not null default now(),
  unique (variant_id, source, captured_at)
);
create index if not exists variant_price_history_variant_time_idx
  on public.variant_price_history (variant_id, captured_at desc);

-- Enable RLS
alter table public.tcg_types enable row level security;
alter table public.card_sets enable row level security;
alter table public.products enable row level security;
alter table public.variants enable row level security;
alter table public.variant_price_history enable row level security;

-- Public read policies
drop policy if exists "Public read tcg types" on public.tcg_types;
create policy "Public read tcg types" on public.tcg_types
  for select using (true);

drop policy if exists "Public read sets" on public.card_sets;
create policy "Public read sets" on public.card_sets
  for select using (true);

drop policy if exists "Public read products" on public.products;
create policy "Public read products" on public.products
  for select using (true);

drop policy if exists "Public read variants" on public.variants;
create policy "Public read variants" on public.variants
  for select using (true);

drop policy if exists "Public read variant price history" on public.variant_price_history;
create policy "Public read variant price history" on public.variant_price_history
  for select using (true);

-- Authenticated write policies
drop policy if exists "Authenticated can insert tcg types" on public.tcg_types;
create policy "Authenticated can insert tcg types" on public.tcg_types
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update tcg types" on public.tcg_types;
create policy "Authenticated can update tcg types" on public.tcg_types
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can insert sets" on public.card_sets;
create policy "Authenticated can insert sets" on public.card_sets
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update sets" on public.card_sets;
create policy "Authenticated can update sets" on public.card_sets
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can insert products" on public.products;
create policy "Authenticated can insert products" on public.products
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update products" on public.products;
create policy "Authenticated can update products" on public.products
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can delete products" on public.products;
create policy "Authenticated can delete products" on public.products
  for delete to authenticated using (true);

drop policy if exists "Authenticated can insert variants" on public.variants;
create policy "Authenticated can insert variants" on public.variants
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update variants" on public.variants;
create policy "Authenticated can update variants" on public.variants
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can delete variants" on public.variants;
create policy "Authenticated can delete variants" on public.variants
  for delete to authenticated using (true);

drop policy if exists "Authenticated can insert variant price history" on public.variant_price_history;
create policy "Authenticated can insert variant price history" on public.variant_price_history
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update variant price history" on public.variant_price_history;
create policy "Authenticated can update variant price history" on public.variant_price_history
  for update to authenticated using (true) with check (true);
