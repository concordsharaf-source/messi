-- ============================================================================
--  00_supabase_stub.sql — محاكاة الكائنات التي يديرها Supabase تلقائياً
--  الغرض: اختبار sql/schema.sql و sql/fcm_and_rls.sql محلياً قبل لمس المشروع
--  ⚠️ هذا الملف للاختبار المحلي فقط ولا يُشغَّل على Supabase أبداً.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- الأدوار ----
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role','supabase_admin','authenticator']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------- مخطط auth.users -----
create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  encrypted_password  text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  email_confirmed_at  timestamptz,
  phone               text,
  is_sso_user         boolean not null default false,
  is_anonymous        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- auth.uid(): نفس منطق Supabase — يقرأ الـ sub من claims التوكن
create or replace function auth.uid()
returns uuid
language plpgsql
stable
as $$
declare
  v text;
begin
  begin
    v := current_setting('request.jwt.claims', true);
    if v is not null and v <> '' then
      return nullif(v::jsonb ->> 'sub', '')::uuid;
    end if;
  exception when others then
    null;
  end;

  v := nullif(current_setting('request.jwt.claim.sub', true), '');
  if v is not null and v <> '' then
    return v::uuid;
  end if;

  return null;
end;
$$;

-- auth.jwt(): يُرجع claims التوكن كـ jsonb (نفس دلالة Supabase)
create or replace function auth.jwt()
returns jsonb
language plpgsql
stable
as $$
declare
  v text;
begin
  v := current_setting('request.jwt.claims', true);
  if v is null or v = '' then
    return '{}'::jsonb;
  end if;
  return v::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

-- ----------------------------------------------------- مخطط storage --------
create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  public             boolean not null default false,
  avif_autodetection boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id                 uuid primary key default gen_random_uuid(),
  bucket_id          text references storage.buckets(id),
  name               text,
  owner              uuid,
  owner_id           text,
  version            text,
  metadata           jsonb,
  path_tokens        text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_accessed_at   timestamptz not null default now()
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- نفس دلالة Supabase: تُرجع كل المقاطع عدا اسم الملف الأخير
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  if name is null or name = '' then
    return array[]::text[];
  end if;
  parts := string_to_array(name, '/');
  return parts[1:greatest(array_length(parts, 1) - 1, 0)];
end;
$$;

create or replace function storage.filename(name text)
returns text
language sql
immutable
as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
$$;

-- ------------------------------------------------ منشور Realtime ----------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- إعدادات Supabase الافتراضية على مخطط public
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on functions to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- ------------------------------------------- صلاحيات تشبه Supabase الحقيقي ---
-- في Supabase الحقيقي: anon/authenticated/service_role يملكون صلاحيات على
-- جداول public عبر default privileges، والـ RLS هو ما يحدّد الصفوف المسموحة.
alter default privileges in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

grant usage on schema storage to anon, authenticated, service_role;
grant all on all tables in schema storage to authenticated, service_role;
grant select on all tables in schema storage to anon;
