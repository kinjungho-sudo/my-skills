-- Second Brain 스키마 (Supabase project2에 sb_ 접두어로 적용된 최종 상태)
-- 새 프로젝트에 다시 만들 때 이 파일을 SQL Editor에서 한 번에 실행하면 된다.

-- 초대 목록: 이 이메일 + Google 로그인 계정만 회원이 될 수 있다
create table public.sb_invites (
  email text primary key,
  display_name text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

-- 회원: 계정 고유 ID로 고정 (이메일만으로는 권한을 주지 않는다)
create table public.sb_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.sb_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) > 0 and title !~ '[][|#^]'),
  content text not null default '',
  link_keys text[] not null default '{}',   -- 본문의 [[링크]] 대상 (소문자). Obsidian metadataCache 역할
  version int not null default 1,           -- 동시 편집 충돌 감지용
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz                   -- 보관(목록에서 숨김)
);
create unique index sb_notes_title_ci on public.sb_notes (lower(title));
create index sb_notes_updated_at on public.sb_notes (updated_at desc);
create index sb_notes_link_keys on public.sb_notes using gin (link_keys);

create table public.sb_revisions (
  id bigint generated always as identity primary key,
  note_id uuid not null references public.sb_notes(id) on delete cascade,
  version int not null,
  title text not null,
  content text not null,
  edited_by uuid not null references auth.users(id),
  edited_at timestamptz not null default now()
);
create index sb_revisions_note on public.sb_revisions (note_id, edited_at desc);

-- 권한 확인
create or replace function public.sb_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sb_members where user_id = auth.uid());
$$;

-- 첫 로그인 시 회원 등록: 초대된 이메일 + Google로 검증된 계정일 때만
create or replace function public.sb_claim_membership() returns boolean
language plpgsql security definer set search_path = '' as $$
declare u record; inv record;
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from public.sb_members where user_id = auth.uid()) then return true; end if;
  select id, email, email_confirmed_at, raw_app_meta_data into u from auth.users where id = auth.uid();
  if u.email is null or u.email_confirmed_at is null then return false; end if;
  if not coalesce((u.raw_app_meta_data -> 'providers') @> '["google"]'::jsonb, false) then return false; end if;
  select * into inv from public.sb_invites where lower(email) = lower(u.email) and claimed_at is null;
  if not found then return false; end if;
  insert into public.sb_members (user_id, email, display_name) values (u.id, lower(u.email), inv.display_name);
  update public.sb_invites set claimed_at = now() where email = inv.email;
  return true;
end $$;

-- 본문에서 [[대상]], [[대상#소제목]], [[대상|별칭]] 추출
create or replace function public.sb_extract_links(p_content text)
returns table (target_key text, target_text text, cnt int)
language sql immutable set search_path = '' as $$
  select lower(t), min(t), count(*)::int
  from (
    select btrim(m[1]) as t
    from regexp_matches(p_content, '\[\[([^]|#^]+)(?:[#^][^]|]*)?(?:\|[^]]*)?\]\]', 'g') as m
  ) s
  where length(t) > 0
  group by lower(t);
$$;

-- 특정 제목을 가리키는 [[링크]]의 정규식
create or replace function public.sb_link_pattern(p_title text) returns text
language sql immutable set search_path = '' as $$
  select '\[\[\s*' || regexp_replace(btrim(p_title), '([.^$*+?(){}|\\[\]])', '\\\1', 'g') || '\s*(?=[]|#^])';
$$;

-- 저장 전: 버전 증가, 링크 색인 갱신, 수정자 기록
create or replace function public.sb_notes_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.title := btrim(new.title);
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if tg_op = 'INSERT' or new.content is distinct from old.content then
    new.link_keys := coalesce((select array_agg(l.target_key order by l.target_key) from public.sb_extract_links(new.content) l), '{}');
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;

-- 저장 후: 수정 이력 (같은 사람이 5분 안에 다시 저장하면 마지막 이력을 갱신)
create or replace function public.sb_notes_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare last_rev record;
begin
  if tg_op = 'UPDATE' and new.content = old.content and new.title = old.title then
    return null;
  end if;
  select id, edited_by, edited_at into last_rev from public.sb_revisions
    where note_id = new.id order by edited_at desc limit 1;
  if found and last_rev.edited_by = new.updated_by and last_rev.edited_at > now() - interval '5 minutes' then
    update public.sb_revisions set version = new.version, title = new.title, content = new.content, edited_at = now()
      where id = last_rev.id;
  else
    insert into public.sb_revisions (note_id, version, title, content, edited_by)
      values (new.id, new.version, new.title, new.content, new.updated_by);
  end if;
  return null;
end $$;

create trigger sb_notes_before before insert or update on public.sb_notes
  for each row execute function public.sb_notes_before();
create trigger sb_notes_after after insert or update on public.sb_notes
  for each row execute function public.sb_notes_after();

-- 이름 변경 미리보기: 영향받는 링크 수 / 노트 수
create or replace function public.sb_rename_preview(p_note uuid)
returns table (link_count int, note_count int)
language plpgsql stable security definer set search_path = '' as $$
declare v_title text;
begin
  if not public.sb_is_member() then raise exception 'not a member'; end if;
  select title into v_title from public.sb_notes where id = p_note;
  return query
    select coalesce(sum((select count(*) from regexp_matches(n.content, public.sb_link_pattern(v_title), 'gi'))), 0)::int,
           count(*)::int
    from public.sb_notes n
    where n.link_keys @> array[lower(v_title)];
end $$;

-- 이름 변경 + (선택) 다른 노트의 링크 재작성 : 한 트랜잭션
create or replace function public.sb_rename_note(p_note uuid, p_new_title text, p_update_links boolean)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_old text; v_new text := btrim(p_new_title);
  v_pattern text; v_links int := 0; v_notes int := 0;
begin
  if not public.sb_is_member() then raise exception 'not a member'; end if;
  select title into v_old from public.sb_notes where id = p_note for update;
  if not found then raise exception 'note not found'; end if;
  if v_new = v_old then return json_build_object('links', 0, 'notes', 0); end if;
  if exists (select 1 from public.sb_notes where lower(title) = lower(v_new) and id <> p_note) then
    raise exception 'title already exists' using errcode = '23505';
  end if;

  update public.sb_notes set title = v_new where id = p_note;

  if p_update_links then
    v_pattern := public.sb_link_pattern(v_old);
    select coalesce(sum((select count(*) from regexp_matches(n.content, v_pattern, 'gi'))), 0), count(*)
      into v_links, v_notes
      from public.sb_notes n where n.link_keys @> array[lower(v_old)];
    update public.sb_notes n
      set content = regexp_replace(n.content, v_pattern, '[[' || replace(v_new, '\', '\\'), 'gi')
      where n.link_keys @> array[lower(v_old)];
  end if;
  return json_build_object('links', v_links, 'notes', v_notes);
end $$;

-- 제목·본문 검색
create or replace function public.sb_search(p_query text)
returns table (id uuid, title text, snippet text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(p_query));
begin
  if not public.sb_is_member() then raise exception 'not a member'; end if;
  if length(q) = 0 then return; end if;
  return query
    select n.id, n.title,
      case when strpos(lower(n.content), q) > 0
        then substr(n.content, greatest(1, strpos(lower(n.content), q) - 40), 120)
        else left(n.content, 120) end,
      n.updated_at
    from public.sb_notes n
    where n.archived_at is null and (strpos(lower(n.title), q) > 0 or strpos(lower(n.content), q) > 0)
    order by (strpos(lower(n.title), q) > 0) desc, n.updated_at desc
    limit 50;
end $$;

-- RLS: 회원만 읽고 쓴다. 삭제 정책은 두지 않는다(보관만 가능).
alter table public.sb_invites enable row level security;
alter table public.sb_members enable row level security;
alter table public.sb_notes enable row level security;
alter table public.sb_revisions enable row level security;

create policy sb_members_read on public.sb_members for select to authenticated using (public.sb_is_member());
create policy sb_notes_read on public.sb_notes for select to authenticated using (public.sb_is_member());
create policy sb_notes_insert on public.sb_notes for insert to authenticated with check (public.sb_is_member());
create policy sb_notes_update on public.sb_notes for update to authenticated using (public.sb_is_member()) with check (public.sb_is_member());
create policy sb_revisions_read on public.sb_revisions for select to authenticated using (public.sb_is_member());

revoke all on public.sb_invites, public.sb_members, public.sb_notes, public.sb_revisions from anon;
revoke execute on function public.sb_is_member(), public.sb_claim_membership(), public.sb_rename_preview(uuid),
  public.sb_rename_note(uuid, text, boolean), public.sb_search(text), public.sb_extract_links(text),
  public.sb_link_pattern(text), public.sb_notes_before(), public.sb_notes_after() from public, anon;
revoke execute on function public.sb_notes_before(), public.sb_notes_after() from authenticated;
grant execute on function public.sb_is_member(), public.sb_claim_membership(), public.sb_rename_preview(uuid),
  public.sb_rename_note(uuid, text, boolean), public.sb_search(text),
  public.sb_extract_links(text), public.sb_link_pattern(text) to authenticated;

alter publication supabase_realtime add table public.sb_notes;

-- 초대 (재한님 이메일은 확인 후 추가)
insert into public.sb_invites (email, display_name) values ('kinjungho@gmail.com', '준호');
-- insert into public.sb_invites (email, display_name) values ('재한님@gmail.com', '재한');

-- ===== v2: 폴더 =====
-- 노트의 폴더 경로 ('' = 최상위, 예: '리서치/메커니즘'). 링크는 제목으로만 이어지므로 폴더를 옮겨도 링크는 그대로다.
alter table public.sb_notes add column if not exists folder text not null default ''
  check (folder = '' or (folder !~ '(^/|/$|//)' and folder !~ '[][|#^\\]'));

-- 빈 폴더도 남도록 폴더 목록을 따로 둔다. 지우기는 hidden_at 표시로만 한다.
create table if not exists public.sb_folders (
  path text primary key check (path <> '' and path !~ '(^/|/$|//)' and path !~ '[][|#^\\]'),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  hidden_at timestamptz
);
alter table public.sb_folders enable row level security;
create policy sb_folders_read on public.sb_folders for select to authenticated using (public.sb_is_member());
create policy sb_folders_insert on public.sb_folders for insert to authenticated with check (public.sb_is_member());
create policy sb_folders_update on public.sb_folders for update to authenticated using (public.sb_is_member()) with check (public.sb_is_member());
revoke all on public.sb_folders from anon;
alter publication supabase_realtime add table public.sb_folders;

-- 폴더 이름 바꾸기/옮기기: 하위 폴더와 안의 노트 경로를 한 트랜잭션에서 바꾼다
create or replace function public.sb_rename_folder(p_old text, p_new text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_count int; v_pre text := p_old || '/';
begin
  if not public.sb_is_member() then raise exception 'not a member'; end if;
  if p_new = '' or p_new ~ '(^/|/$|//)' or p_new ~ '[][|#^\\]' then raise exception 'invalid folder name'; end if;
  if p_new = p_old or left(p_new, length(v_pre)) = v_pre then raise exception 'invalid target'; end if;
  insert into public.sb_folders (path)
    select p_new || substr(f.path, length(p_old) + 1) from public.sb_folders f
    where (f.path = p_old or left(f.path, length(v_pre)) = v_pre) and f.hidden_at is null
    on conflict (path) do update set hidden_at = null;
  insert into public.sb_folders (path) values (p_new) on conflict (path) do update set hidden_at = null;
  update public.sb_folders set hidden_at = now() where path = p_old or left(path, length(v_pre)) = v_pre;
  update public.sb_notes set folder = p_new || substr(folder, length(p_old) + 1)
    where folder = p_old or left(folder, length(v_pre)) = v_pre;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.sb_rename_folder(text, text) from public, anon;
grant execute on function public.sb_rename_folder(text, text) to authenticated;
