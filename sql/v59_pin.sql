-- =============================================================
-- v59: تثبيت المحادثات فعليًا (بدل التخزين المحلي الشكلي)
-- =============================================================
alter table public.admin_conversation_prefs
  add column if not exists pinned boolean not null default false,
  add column if not exists pinned_at timestamptz;

-- إزالة النسخة القديمة (3 وسائط) حتى لا يقع التعارض بعد إضافة التثبيت
drop function if exists public.set_conversation_prefs(uuid, boolean, boolean);

create or replace function public.set_conversation_prefs(
  p_conversation_id uuid,
  p_muted    boolean default null,
  p_archived boolean default null,
  p_pinned   boolean default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.current_is_admin() then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  insert into public.admin_conversation_prefs
         (conversation_id, admin_id, muted, archived, pinned, pinned_at, updated_at)
  values (p_conversation_id, auth.uid(),
          coalesce(p_muted, false), coalesce(p_archived, false),
          coalesce(p_pinned, false),
          case when coalesce(p_pinned, false) then now() else null end,
          now())
  on conflict (conversation_id, admin_id) do update
     set muted      = coalesce(p_muted, public.admin_conversation_prefs.muted),
         archived   = coalesce(p_archived, public.admin_conversation_prefs.archived),
         pinned     = coalesce(p_pinned, public.admin_conversation_prefs.pinned),
         pinned_at  = case
                        when p_pinned is true  then now()
                        when p_pinned is false then null
                        else public.admin_conversation_prefs.pinned_at
                      end,
         updated_at = now();

  return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.admin_conversations_overview()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    from (
      select c.id                              as conversation_id,
             c.status                          as status,
             coalesce(ci.tags, '{}')           as tags,
             ci.note                           as note,
             coalesce(p.muted, false)          as muted,
             coalesce(p.archived, false)       as archived,
             coalesce(p.pinned, false)         as pinned,
             p.pinned_at                       as pinned_at
        from public.conversations c
        left join public.conversation_internal ci on ci.conversation_id = c.id
        left join public.admin_conversation_prefs p
               on p.conversation_id = c.id and p.admin_id = auth.uid()
       where public.current_is_admin()
    ) t;
$function$;
