-- Remove variants + variant price history.
-- Store current pricing on products instead.

drop table if exists public.variant_price_history cascade;
drop table if exists public.variants cascade;

alter table public.products
  add column if not exists low_price numeric(10,2),
  add column if not exists mid_price numeric(10,2),
  add column if not exists high_price numeric(10,2),
  add column if not exists market_price numeric(10,2),
  add column if not exists direct_low_price numeric(10,2),
  add column if not exists currency text not null default 'USD',
  add column if not exists price_updated_at timestamptz;
