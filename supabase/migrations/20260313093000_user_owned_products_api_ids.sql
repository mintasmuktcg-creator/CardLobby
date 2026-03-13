-- Move user-owned rows to API product identifiers and store variant dimensions.

alter table public.user_owned_products
  add column if not exists api_product_id bigint,
  add column if not exists region text,
  add column if not exists condition_id smallint,
  add column if not exists rarity_id smallint,
  add column if not exists printing_id smallint;

-- Backfill from legacy UUID product references when possible.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'product_id'
      and udt_name = 'uuid'
  ) then
    update public.user_owned_products as u
    set
      api_product_id = p.tcg_product_id,
      region = coalesce(u.region, p.region, 'EN')
    from public.pokemon_products as p
    where u.api_product_id is null
      and u.product_id = p.id;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'product_id'
      and udt_name = 'int8'
  ) then
    update public.user_owned_products
    set api_product_id = coalesce(api_product_id, product_id);
  end if;
end $$;

update public.user_owned_products
set region = 'EN'
where region is null;

update public.user_owned_products
set
  condition_id = coalesce(condition_id, 0),
  rarity_id = coalesce(rarity_id, 0),
  printing_id = coalesce(printing_id, 0);

-- Rows that cannot be backfilled to API product IDs are not usable after this migration.
delete from public.user_owned_products
where api_product_id is null;

alter table public.user_owned_products
  alter column api_product_id set not null,
  alter column region set not null,
  alter column condition_id set not null,
  alter column rarity_id set not null,
  alter column printing_id set not null;

alter table public.user_owned_products
  alter column condition_id set default 0,
  alter column rarity_id set default 0,
  alter column printing_id set default 0;

alter table public.user_owned_products
  drop constraint if exists user_owned_products_product_id_fkey;

alter table public.user_owned_products
  drop constraint if exists user_owned_products_user_id_product_id_key;

drop index if exists user_owned_products_product_idx;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'product_id'
      and udt_name = 'uuid'
  ) then
    alter table public.user_owned_products
      drop column product_id;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'api_product_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'product_id'
  ) then
    alter table public.user_owned_products
      rename column api_product_id to product_id;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'api_product_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_owned_products'
      and column_name = 'product_id'
  ) then
    update public.user_owned_products
    set product_id = coalesce(product_id, api_product_id)
    where api_product_id is not null;

    alter table public.user_owned_products
      drop column api_product_id;
  end if;
end $$;

alter table public.user_owned_products
  alter column product_id set not null;

alter table public.user_owned_products
  drop constraint if exists user_owned_products_region_check;

alter table public.user_owned_products
  add constraint user_owned_products_region_check
  check (region in ('EN', 'JP'));

create index if not exists user_owned_products_product_idx
  on public.user_owned_products(product_id);

create unique index if not exists user_owned_products_user_product_variant_key
  on public.user_owned_products (
    user_id,
    product_id,
    region,
    condition_id,
    rarity_id,
    printing_id
  );
