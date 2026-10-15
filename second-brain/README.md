# Second Brain

준호 · 재한 두 사람만 쓰는 공유 노트 앱입니다. Obsidian 1.14.4를 REA로 분석해 알아낸
**동작 원리와 구조**를 참고해 처음부터 새로 만들었습니다. Obsidian의 코드는 쓰지 않았습니다.

## 기능

**편집**
- Live Preview 편집기 (CodeMirror 6): 커서가 없는 줄은 마크다운 기호를 숨기고 서식만 보여 줍니다. 제목, 굵게, 링크, 체크박스, 콜아웃, 코드 블록, 이미지가 대상입니다.
- 읽기 보기 전환 (Ctrl+E), 1초 안에 자동 저장
- `[[노트]]` · `[[노트#소제목]]` · `[[노트|별칭]]` · `![[노트]]` 임베드, `[[` 자동완성 (소제목까지), `#태그` 자동완성
- `> [!tip]` 콜아웃, `==형광펜==`, `- [ ]` 체크박스 클릭 토글
- 링크 위에 마우스를 올리면 노트 미리보기
- 서식 단축키: Ctrl+B / I, Ctrl+Shift+H, Ctrl+L(체크박스), Ctrl+F(노트 안 찾기)

**작업공간**
- 탭 (여러 노트 동시에 열기, Ctrl+클릭으로 새 탭), 뒤로/앞으로
- 파일 탐색기: 폴더, 드래그로 이동, 정렬, 우클릭 메뉴
- 빠른 이동 (Ctrl+O), 명령 팔레트 (Ctrl+P), 데일리 노트 (Alt+D)
- 검색: `"구절"` `tag:#할일` `path:폴더` `file:제목` `-제외`
- 태그 목록, 개요(소제목), 로컬 그래프, 그래프 뷰 (필터, 태그/고아/없는 노트 표시, 수정자별 색)
- 백링크: 링크된 언급 + **링크되지 않은 언급** (버튼 한 번으로 링크로 바꾸기)
- 어두운/밝은 테마, 글자 크기, 읽기 폭 설정

**함께 쓰기**
- 상대가 고친 내용이 실시간으로 반영되고, 상대가 지금 어떤 노트를 보고 있는지 표시됩니다
- 같은 노트를 동시에 고치면 충돌을 감지해 어느 쪽을 남길지 고릅니다
- 수정 이력: 누가 언제 고쳤는지, 지금과의 차이를 보고 되돌리기
- 이름을 바꾸면 다른 노트의 링크도 함께 갱신 ([항상 / 이번만 / 안 함])
- 보관함: 지운 노트는 보관만 되고 언제든 되돌릴 수 있습니다

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
├── app.js             작업공간 (탭, 파일 탐색기, 검색, 백링크, 실시간, 명령)
├── editor.js          CodeMirror Live Preview 편집기
├── render.js          읽기 보기 렌더러 (위키링크, 임베드, 콜아웃)
├── graph.js           그래프 뷰 (d3-force + canvas)
├── icons.js           아이콘
├── style.css          스타일 (라이트/다크)
├── config.js          Supabase 주소와 공개 키
├── vendor.js          외부 라이브러리 묶음 (supabase-js, CodeMirror 6, marked, DOMPurify, d3-force)
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
