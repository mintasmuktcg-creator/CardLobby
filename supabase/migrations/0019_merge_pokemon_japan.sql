-- Merge Pokemon Japan tables into unified Pokemon tables.

-- Add region to sets/products so JP and EN can coexist.
alter table public.pokemon_sets
  add column if not exists region text;

alter table public.pokemon_products
  add column if not exists region text;

update public.pokemon_sets set region = 'EN' where region is null;
update public.pokemon_products set region = 'EN' where region is null;

alter table public.pokemon_sets
  alter column region set default 'EN',
  alter column region set not null;

alter table public.pokemon_products
  alter column region set default 'EN',
  alter column region set not null;

alter table public.pokemon_sets
  drop constraint if exists pokemon_sets_region_check;
alter table public.pokemon_sets
  add constraint pokemon_sets_region_check check (region in ('EN', 'JP'));

alter table public.pokemon_products
  drop constraint if exists pokemon_products_region_check;
alter table public.pokemon_products
  add constraint pokemon_products_region_check check (region in ('EN', 'JP'));

-- Update uniqueness to be region-aware.
alter table public.pokemon_sets
  drop constraint if exists card_sets_tcg_type_name_key;
alter table public.pokemon_sets
  drop constraint if exists pokemon_sets_tcg_type_name_key;
alter table public.pokemon_sets
  drop constraint if exists card_sets_code_key;
alter table public.pokemon_sets
  drop constraint if exists pokemon_sets_code_key;

alter table public.pokemon_sets
  add constraint pokemon_sets_tcg_type_name_region_key unique (tcg_type_id, name, region),
  add constraint pokemon_sets_code_region_key unique (code, region);

alter table public.pokemon_products
  drop constraint if exists products_tcg_product_id_key;
alter table public.pokemon_products
  drop constraint if exists pokemon_products_tcg_product_id_key;

alter table public.pokemon_products
  add constraint pokemon_products_tcg_product_region_key unique (tcg_product_id, region);

create index if not exists pokemon_sets_region_idx
  on public.pokemon_sets(region);
create index if not exists pokemon_products_region_idx
  on public.pokemon_products(region);

-- Copy Japan sets into unified table.
do $$
begin
  if to_regclass('public.pokemon_japan_sets') is not null then
    insert into public.pokemon_sets (
      id,
      tcg_type_id,
      name,
      code,
      release_date,
      created_at,
      tcg_group_id,
      tcg_category_id,
      series,
      subseries,
      total_cards,
      printed_total,
      release_year,
      symbol_url,
      logo_url,
      icon_url,
      official_url,
      description,
      ptcg_api_id,
      tcgplayer_url,
      updated_at,
      generation,
      abbreviation,
      is_supplemental,
      published_on,
      modified_on,
      name_other,
      region
    )
    select
      id,
      tcg_type_id,
      name,
      code,
      release_date,
      created_at,
      tcg_group_id,
      tcg_category_id,
      series,
      subseries,
      total_cards,
      printed_total,
      release_year,
      symbol_url,
      logo_url,
      icon_url,
      official_url,
      description,
      ptcg_api_id,
      tcgplayer_url,
      updated_at,
      generation,
      abbreviation,
      is_supplemental,
      published_on,
      modified_on,
      name_other,
      'JP'
    from public.pokemon_japan_sets
    on conflict (id) do nothing;
  end if;
end $$;

-- Copy Japan products into unified table.
do $$
begin
  if to_regclass('public.pokemon_japan_products') is not null then
    insert into public.pokemon_products (
      id,
      tcg_product_id,
      set_id,
      name,
      clean_name,
      product_type,
      subtype,
      card_number,
      rarity,
      card_type,
      hp,
      stage,
      attack1,
      attack2,
      weakness,
      resistance,
      retreat_cost,
      image_url,
      image_count,
      external_url,
      modified_on,
      created_at,
      low_price,
      mid_price,
      high_price,
      market_price,
      direct_low_price,
      currency,
      price_updated_at,
      region
    )
    select
      id,
      tcg_product_id,
      set_id,
      name,
      clean_name,
      product_type,
      subtype,
      card_number,
      rarity,
      card_type,
      hp,
      stage,
      attack1,
      attack2,
      weakness,
      resistance,
      retreat_cost,
      image_url,
      image_count,
      external_url,
      modified_on,
      created_at,
      low_price,
      mid_price,
      high_price,
      market_price,
      direct_low_price,
      currency,
      price_updated_at,
      'JP'
    from public.pokemon_japan_products
    on conflict (id) do nothing;
  end if;
end $$;

-- Merge owned Japan products into unified owned table.
do $$
begin
  if to_regclass('public.user_owned_pokemon_japan_products') is not null then
    insert into public.user_owned_products (
      user_id,
      product_id,
      quantity,
      created_at,
      updated_at
    )
    select
      user_id,
      product_id,
      quantity,
      created_at,
      updated_at
    from public.user_owned_pokemon_japan_products
    on conflict (user_id, product_id) do nothing;
  end if;
end $$;

-- Drop Japan-specific tables after merge.
drop table if exists public.user_owned_pokemon_japan_products cascade;
drop table if exists public.pokemon_japan_products cascade;
drop table if exists public.pokemon_japan_sets cascade;
