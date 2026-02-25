-- Support printings and condition-based prices per printing.

create table if not exists public.tcg_conditions (
  id smallint primary key,
  name text not null unique,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_tcg_conditions on public.tcg_conditions;
create trigger set_updated_at_tcg_conditions
before update on public.tcg_conditions
for each row execute function public.set_updated_at();

create table if not exists public.product_printings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.pokemon_products(id) on delete cascade,
  printing text not null,
  image_url text,
  external_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, printing)
);

create index if not exists product_printings_product_idx
  on public.product_printings(product_id);

drop trigger if exists set_updated_at_product_printings on public.product_printings;
create trigger set_updated_at_product_printings
before update on public.product_printings
for each row execute function public.set_updated_at();

create table if not exists public.product_printing_condition_prices (
  id bigserial primary key,
  printing_id uuid not null references public.product_printings(id) on delete cascade,
  condition_id smallint not null references public.tcg_conditions(id) on delete restrict,
  source text not null default 'priceguide',
  currency text not null default 'USD',
  low_price numeric(10,2),
  market_price numeric(10,2),
  sales integer,
  captured_at timestamptz not null default now(),
  unique (printing_id, condition_id, source, captured_at)
);

create index if not exists product_printing_condition_prices_printing_idx
  on public.product_printing_condition_prices(printing_id);

create index if not exists product_printing_condition_prices_condition_idx
  on public.product_printing_condition_prices(condition_id);

create index if not exists product_printing_condition_prices_time_idx
  on public.product_printing_condition_prices(printing_id, captured_at desc);

create or replace view public.product_printing_condition_prices_latest as
select distinct on (printing_id, condition_id, source)
  id,
  printing_id,
  condition_id,
  source,
  currency,
  low_price,
  market_price,
  sales,
  captured_at
from public.product_printing_condition_prices
order by printing_id, condition_id, source, captured_at desc;

alter table public.tcg_conditions enable row level security;
alter table public.product_printings enable row level security;
alter table public.product_printing_condition_prices enable row level security;

drop policy if exists "Public read tcg conditions" on public.tcg_conditions;
create policy "Public read tcg conditions" on public.tcg_conditions
  for select using (true);

drop policy if exists "Public read product printings" on public.product_printings;
create policy "Public read product printings" on public.product_printings
  for select using (true);

drop policy if exists "Public read printing condition prices" on public.product_printing_condition_prices;
create policy "Public read printing condition prices" on public.product_printing_condition_prices
  for select using (true);

drop policy if exists "Authenticated can insert tcg conditions" on public.tcg_conditions;
create policy "Authenticated can insert tcg conditions" on public.tcg_conditions
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update tcg conditions" on public.tcg_conditions;
create policy "Authenticated can update tcg conditions" on public.tcg_conditions
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can insert product printings" on public.product_printings;
create policy "Authenticated can insert product printings" on public.product_printings
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update product printings" on public.product_printings;
create policy "Authenticated can update product printings" on public.product_printings
  for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated can insert printing condition prices" on public.product_printing_condition_prices;
create policy "Authenticated can insert printing condition prices" on public.product_printing_condition_prices
  for insert to authenticated with check (true);

drop policy if exists "Authenticated can update printing condition prices" on public.product_printing_condition_prices;
create policy "Authenticated can update printing condition prices" on public.product_printing_condition_prices
  for update to authenticated using (true) with check (true);
