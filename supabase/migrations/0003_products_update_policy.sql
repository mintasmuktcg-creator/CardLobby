-- Allow authenticated users (admin via client) to update products and product_prices
-- Needed for upsert operations from the admin CSV importer.

-- Ensure RLS is enabled
alter table public.products enable row level security;
alter table public.product_prices enable row level security;

-- Updates for products
drop policy if exists "Authenticated can update products" on public.products;
create policy "Authenticated can update products" on public.products
  for update to authenticated
  using (true)
  with check (true);

-- Upserts on product_prices may also trigger updates in the future; allow update as well.
drop policy if exists "Authenticated can update prices" on public.product_prices;
create policy "Authenticated can update prices" on public.product_prices
  for update to authenticated
  using (true)
  with check (true);
