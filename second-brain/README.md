# Second Brain

준호 · 재한 두 사람만 쓰는 공유 노트 앱입니다. Obsidian 1.14.4를 REA로 분석해 알아낸
**동작 원리와 구조**를 참고해 처음부터 새로 만들었습니다. Obsidian의 코드는 쓰지 않았습니다.

## 기능

- 마크다운 노트 작성, 1초 뒤 자동 저장
- `[[노트]]`, `[[노트#소제목]]`, `[[노트|별칭]]` 링크와 `[[` 입력 시 자동완성
- 백링크 / 나가는 링크 (아직 없는 노트는 회색으로 표시하고, 누르면 새로 만들기)
- **이름 바꿀 때 링크 자동 갱신**: 영향받는 링크 수를 보여주고 [항상 / 이번만 / 안 함] 중에서 선택
- 제목·본문 검색
- 그래프 뷰 (마지막으로 고친 사람에 따라 색 구분)
- 작성자와 수정 이력 (이전 버전으로 되돌리기 가능)
- 두 사람이 같은 노트를 동시에 고칠 때 충돌 감지 + 실시간 반영
- 보관 (목록에서 숨김. 실제로 지우지는 않음)

## Obsidian 구조와의 대응

| Obsidian (분석 결과) | 이 앱 |
|---|---|
| `metadataCache`: 링크 색인 | `sb_notes.link_keys`: 저장할 때 DB 트리거가 `[[링크]]`를 추출 |
| `getBacklinksForFile` | `link_keys`에 내 제목이 들어 있는 노트 (GIN 인덱스) |
| `renameFile` → `runAsyncLinkUpdate`: 이름 변경 전후를 비교해 바뀐 링크만 수정 | `sb_rename_note()`: 한 트랜잭션에서 제목 변경과 링크 재작성 |
| 확인창 [항상 업데이트 / 이번만 / 업데이트 안 함] + `alwaysUpdateLinks` 설정 | 같은 확인창, "항상" 선택은 브라우저에 저장 |
| `vault.process()`: 읽기·고치기·쓰기를 한 번에 | `version` 비교로 저장 (동시 편집 충돌 감지) |
| 렌더러(UI)와 메인 프로세스 분리 (IPC) | 정적 UI(`app.js`)와 DB 함수(RPC) 분리 |

## 구성

```
second-brain/
├── index.html         화면 뼈대
├── app.js             앱 로직
├── style.css          스타일 (라이트/다크)
├── config.js          Supabase 주소와 공개 키
├── vendor.js          외부 라이브러리 묶음 (supabase-js, marked, DOMPurify, d3-force)
├── build-vendor.sh    vendor.js 재생성 스크립트
├── vercel.json        보안 헤더 (CSP 등)
└── supabase/schema.sql  DB 스키마 전체
```

빌드 단계가 없는 정적 사이트입니다. 폴더를 그대로 Vercel에 올리면 됩니다.

## 보안 모델

- **로그인:** Google 계정만 받습니다. project2는 이메일 가입이 자동 승인되는 설정이라, 이메일만으로 권한을 주면 다른 사람이 같은 이메일로 먼저 가입해 들어올 수 있습니다.
- **회원 등록:** `sb_invites`에 있는 이메일이 Google로 처음 로그인할 때 `sb_members`에 **계정 고유 ID**로 고정됩니다. 그 뒤로는 ID로만 권한을 확인합니다.
- **접근 통제:** 모든 테이블에 RLS를 걸어 회원이 아니면 0건이 보입니다(테스트로 확인). 브라우저에는 공개 키만 들어 있습니다.
- **삭제 정책 없음:** 노트는 보관만 할 수 있고, 수정 이력이 모두 남습니다.
- **XSS 방지:** 마크다운 결과는 DOMPurify로 정리합니다. CSP로 자기 도메인 스크립트만 허용하고, 데이터 통신은 Supabase로만 허용합니다.

## 처음 설정 (한 번만)

1. **Supabase 리디렉션 URL 등록**
   Supabase 대시보드 → project2 → Authentication → URL Configuration → Redirect URLs에
   배포된 주소(예: `https://second-brain-xxxx.vercel.app`)를 추가합니다.
   이걸 안 하면 Google 로그인 뒤 project2의 기본 사이트로 이동해 버립니다.
2. **재한님 초대**: SQL Editor에서 실행합니다.
   ```sql
   insert into public.sb_invites (email, display_name) values ('재한님의_구글_이메일', '재한');
   ```
3. 두 분이 각자 Google로 로그인하면 끝입니다.

## 정리할 것 (선택)

개발 중에 쓰지 않게 된 객체가 둘 남아 있습니다. 동작에는 영향이 없습니다. 지우려면 SQL Editor에서 실행하세요.

```sql
drop table if exists public.sb_links;
drop function if exists public.sb_tmp_probe();
```
