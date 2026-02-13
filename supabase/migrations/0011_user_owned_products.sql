-- User-owned products (collections)

create table if not exists public.user_owned_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create index if not exists user_owned_products_user_idx on public.user_owned_products(user_id);
create index if not exists user_owned_products_product_idx on public.user_owned_products(product_id);

drop trigger if exists set_updated_at_user_owned_products on public.user_owned_products;
create trigger set_updated_at_user_owned_products
before update on public.user_owned_products
for each row execute function public.set_updated_at();

alter table public.user_owned_products enable row level security;

drop policy if exists "User read own owned products" on public.user_owned_products;
create policy "User read own owned products" on public.user_owned_products
  for select using (auth.uid() = user_id);

drop policy if exists "User insert own owned products" on public.user_owned_products;
create policy "User insert own owned products" on public.user_owned_products
  for insert with check (auth.uid() = user_id);

drop policy if exists "User update own owned products" on public.user_owned_products;
create policy "User update own owned products" on public.user_owned_products
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "User delete own owned products" on public.user_owned_products;
create policy "User delete own owned products" on public.user_owned_products
  for delete using (auth.uid() = user_id);
