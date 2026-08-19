# ChatGPT To Codex — Harness Engineering Development Log

이 문서는 `chatgpt2codex`를 단순한 로컬 MCP 브리지에서 **작업 상태를 이어받는 로컬 코딩 에이전트 하네스**로 개선하는 과정을 기록한다.

목적은 단순 변경 목록이 아니라 다음 질문에 답할 수 있는 개발 이력을 남기는 것이다.

- 기존에는 어떻게 동작했는가?
- 실제 사용에서 어떤 불편을 발견했는가?
- 원인을 코드 구조에서 어떻게 확인했는가?
- 어떤 설계 선택을 했고, 왜 그렇게 했는가?
- 구현 중 어떤 문제가 생겼고 어떻게 수정했는가?
- 무엇으로 검증했는가?
- 아직 남아 있는 위험과 다음 단계는 무엇인가?

향후 하네스 개선은 모두 이 파일에 Phase 단위로 누적한다.

---

## 전체 개선 방향

```text
Phase 0  기존 chatgpt2codex 구조 파악
   ↓
Phase 1  Persistent Work Context / Session Resume
   ↓
Phase 2  Project별 Working Session + Last Diff / Verification
   ↓
Phase 3  Goal / Pending Task와 작업 세션 연결
   ↓
Phase 4  ChatGPT 대화와 로컬 작업 세션 매핑
   ↓
Phase 5  Context 압축 / 자동 요약 / 장기 세션 복원
   ↓
Phase 6  병렬 세션 / worktree / multi-agent 확장
```

설계 원칙:

1. **모델 성능보다 하네스 재탐색 비용을 먼저 줄인다.**
2. 이전 컨텍스트는 힌트이지 진실이 아니다. 파일 hash를 통해 반드시 재검증한다.
3. 대화 전체를 무작정 저장하지 않고, 작업에 필요한 구조화된 상태를 저장한다.
4. 기존 MCP 안전 정책(프로젝트 confinement, secret guard, lease, hash precondition)을 우회하지 않는다.
5. 각 Phase는 작은 변경으로 구현하고 타입체크/테스트/빌드 후 다음 단계로 넘어간다.

---

# Phase 0 — 기존 동작 분석

**기록일:** 2026-08-08  
**상태:** 분석 완료

## 문제를 발견한 사용 시나리오

실제 포트폴리오 HTML 작업 중 같은 ChatGPT 대화에서 직전에 수정하던 파일을 다시 수정하라고 했을 때, 체감상 새 작업을 시작하는 것처럼 느린 경우가 있었다.

예:

```text
사용자: "아까 작업하던 HTML에서 10~11페이지 이미지만 다시 수정해"
```

사용자가 기대한 흐름:

```text
직전 작업 파일 기억
→ 최근 수정 영역 확인
→ 필요한 부분만 읽음
→ 바로 수정
```

기존 하네스가 유도하는 흐름:

```text
project_select
→ project_status / code_search
→ HTML 후보 탐색
→ 파일 다시 읽기
→ 구조 재파악
→ 수정
```

즉 모델이 대화 내용을 완전히 잊은 것이 아니라, **로컬 실행 하네스가 직전 작업 상태를 충분히 유지하지 못해 로컬 repo를 다시 탐색하는 비용**이 컸다.

## 기존 세션 상태

`src/state/store.ts`의 기존 `sessions.json`은 사실상 다음 상태만 저장했다.

```text
activeProjectId
mode
lease
```

`goal_loop`도 존재했지만 목적은 주로:

```text
inspect → edit → verify → continue
```

형태의 한 작업 루프를 유지하는 것이었다.

다음 턴에서 필요한 정보인:

- 최근 읽은 파일
- 방금 수정한 artifact
- 최근 읽은 줄 범위
- 그 파일이 외부에서 바뀌었는지
- 마지막 checkpoint

등은 세션에 연결되지 않았다.

## Phase 0 결론

첫 개선은 대화 전문 저장이나 LLM 요약이 아니라 **작업 컨텍스트 스냅샷**이어야 한다고 판단했다.

이유:

- 구현 복잡도가 낮다.
- 기존 Store/lease/checkpoint 구조를 재사용할 수 있다.
- HTML 같은 큰 파일에서 재탐색 비용을 즉시 줄일 수 있다.
- 잘못된 기억 문제를 hash 검증으로 방어할 수 있다.

---

# Phase 1 — Persistent Work Context / Session Resume

**구현일:** 2026-08-08  
**상태:** 구현 및 핵심 테스트 완료

## 목표

직전 작업의 최소 상태를 로컬 세션에 저장하고, 다음 요청에서 broad search를 하기 전에 이를 복원할 수 있게 한다.

목표 흐름:

```text
"아까 HTML 계속 수정해"
        ↓
project_select
        ↓
session_resume
        ↓
activeArtifact / recentFiles / hash 검증
        ↓
unchanged → 필요한 부분만 읽기
stale     → 해당 파일만 다시 읽기
```

## Before / After

### Before

```text
follow-up 요청
→ 프로젝트 선택
→ code_search
→ 관련 파일 후보 탐색
→ 파일 구조 재확인
→ 수정
```

### After

```text
follow-up 요청
→ 프로젝트 선택
→ session_resume
→ 최근 artifact와 읽은 범위 복원
→ 전체 파일 SHA-256 검증
→ 동일하면 바로 이어서 작업
→ 다르면 stale=true로 표시 후 재확인
```

## 구현 내용

### 1. Session schema v2

파일:

- `src/state/store.ts`
- `src/state/store.test.ts`

기존 Session에 `workContext`를 추가했다.

개념 구조:

```ts
workContext: {
  projectId,
  activeArtifact,
  recentFiles,
  lastCheckpointId,
  lastActivityAt
}
```

`recentFiles`는 최대 20개로 제한했다.

각 파일 기록에는 다음 정보를 유지한다.

```text
path
fileHash
lastAction
lastTouchedAt
start/end (읽은 범위가 있을 때)
```

### 2. v1 세션 하위 호환

기존 사용자의 `sessions.json`을 깨지 않도록:

- v1 세션에 `workContext`가 없어도 로드 가능
- 다음 `setSession()` 저장 때 version 2로 마이그레이션

되도록 구현했다.

즉 기존 설치 상태를 강제로 초기화할 필요가 없다.

### 3. `recordRecentWork()`

파일:

- `src/server/tools.ts`

파일 작업이 일어났을 때 최근 작업 상태를 저장하는 helper를 추가했다.

연결 대상:

- `file_read_slice`
- `file_apply_patch`
- `file_create`

현재 단계에서는 최근 파일을 LRU 형태로 앞쪽에 두고 최대 20개까지만 유지한다.

### 4. 같은 프로젝트 재선택 시 작업 컨텍스트 유지

기존 `project_select`는 세션을 새 객체로 저장하기 때문에 새 필드를 단순히 추가하면 work context가 사라질 수 있었다.

따라서 같은 프로젝트를 다시 선택할 경우 기존 `workContext`를 유지하도록 변경했다.

프로젝트가 바뀌는 경우에는 Phase 1에서는 보수적으로 기존 context를 버린다.

이 선택은 **cross-project contamination**을 막기 위한 것이다.

향후 Phase 2에서 프로젝트별 세션 저장으로 개선한다.

### 5. `session_resume` MCP / Action 도구 추가

파일:

- `src/server/tools.ts`
- `src/server/actions.ts`
- `src/server/http-actions.test.ts`

새 도구:

```text
session_resume
```

역할:

- 현재 또는 지정 프로젝트의 work context 조회
- 저장된 recent file들의 현재 hash 재계산
- `stale` 여부 반환
- active artifact의 stale 상태 반환

예상 응답 개념:

```text
activeProjectId: proj
hasContext: true
activeArtifact: portfolio.html
activeArtifactStale: false
recentFiles:
  - path: portfolio.html
    stale: false
    start: 1
    end: 120
```

### 6. OpenAPI Actions에도 노출

Custom GPT Actions에서도 직접 사용할 수 있도록:

```text
/actions/session-resume
```

를 추가하고 OpenAPI schema의 공개 tool set에도 포함했다.

따라서 웹 ChatGPT에서도 후속 작업 시 `project_select → session_resume` 흐름을 사용할 수 있다.

---

## 구현 중 발견한 문제 1 — `fileHash`의 의미가 달랐다

초기 구현에서는 기존 `file_read_slice`가 반환하는 `fileHash`를 그대로 stale 검사에 사용했다.

테스트 결과, 파일이 바뀌지 않았는데도:

```text
activeArtifactStale = true
```

가 나왔다.

원인을 확인한 결과 `readSlice()`의 기존 `fileHash`는 이름과 달리 **파일 전체 hash가 아니라 읽은 slice 범위의 hash**였다.

기존 구현:

```ts
const rangeText = sliceLines.join("\n");
fileHash = rangeHash(rangeText);
```

하지만 resume 시 계산한 값은 전체 파일 바이트 기준 SHA-256이었기 때문에 두 값이 항상 다를 수 있었다.

### 해결

resume/working-context 전용으로 전체 파일 bytes를 읽어 SHA-256을 계산하는 `hashProjectFile()`을 추가했다.

```text
readSlice.fileHash
= patch anchor / 읽은 범위 검증용

workContext.fileHash
= 전체 파일 stale 검증용
```

두 hash의 의미를 분리했다.

이 문제는 테스트를 먼저 작성했기 때문에 실제 사용 전에 발견할 수 있었다.

---

## 검증

### 타입체크

```text
npm run typecheck
```

결과:

```text
PASS
```

### 핵심 테스트

```text
vitest run
  src/state/store.test.ts
  src/server/http-actions.test.ts
  src/server/tools-catalog.test.ts
```

결과:

```text
46 passed / 46 total
```

검증된 시나리오:

```text
1. portfolio.html 생성
2. project_select
3. file_read_slice
4. 같은 프로젝트 project_select 재호출
5. session_resume
6. activeArtifact=portfolio.html 확인
7. stale=false 확인
8. 테스트 코드에서 파일을 외부 수정
9. session_resume 재호출
10. stale=true 확인
```

### 빌드

```text
npm run build
```

결과:

```text
PASS
```

### 전체 테스트 스위트 참고

전체 `npm test` 실행 결과:

```text
392 passed
18 failed
3 skipped
```

실패 항목은 이번 Phase 1 세션 변경과 직접 관련된 것이 아니라 기존 플랫폼/E2E 영역이었다.

대표적으로:

- Windows 환경에서 macOS synthetic input 테스트 실행
- Edge/Chrome isolated profile cleanup 중 `EBUSY`
- Windows에서 POSIX `0600` 권한을 그대로 기대하는 테스트
- 기존 desktop-control 플랫폼 가정

따라서 Phase 1 관련 핵심 테스트는 별도로 모두 통과시켰다.

---

## Phase 1의 한계

현재 개선만으로 Codex 수준의 세션 persistence가 완성된 것은 아니다.

### 1. 프로젝트별 세션이 아직 아니다

현재는 active session 안에 하나의 workContext가 존재한다.

프로젝트를 바꾸면 안전을 위해 이전 context를 비운다.

따라서:

```text
Portfolio 프로젝트 작업
→ chatgpt2codex 프로젝트 작업
→ 다시 Portfolio
```

시 Portfolio의 과거 working set을 자동으로 복원하지 못한다.

### 2. ChatGPT conversation과 직접 매핑되지 않는다

브라우저에서 ChatGPT 탭 A/B를 동시에 쓰더라도 로컬 runtime이 각 conversation을 확실히 구분하는 별도 session key는 아직 없다.

향후 잘못 설계하면:

```text
Chat A의 최근 작업
↕
Chat B의 최근 작업
```

이 서로 오염될 수 있다.

### 3. 최근 diff/test 결과는 아직 연결되지 않는다

현재 기록되는 핵심은:

- artifact
- recent files
- hash
- line range
- checkpoint id

이다.

아직 다음 정보는 구조화되어 있지 않다.

- 마지막 변경 요약
- 마지막 테스트 명령
- 마지막 테스트 성공/실패
- 마지막 E2E proof
- 현재 pending task

### 4. 자동 resume 우선순위는 하네스 instruction에 더 연결할 여지가 있다

도구 자체는 생겼지만 모델이 모든 follow-up에서 항상 `session_resume`을 최우선으로 사용하도록 하는 orchestration 개선은 다음 단계에서 다룬다.

---

## Phase 1 체감 기대 효과

특히 다음과 같은 큰 단일 artifact 작업에서 효과가 클 것으로 예상한다.

- HTML 포트폴리오
- 긴 React component
- 대형 config
- 긴 문서/스크립트

예:

```text
"11페이지 이미지 아직 이상해"
```

기존에는 파일 검색부터 시작할 가능성이 높았지만, 개선 후에는:

```text
session_resume
→ activeArtifact 확인
→ 최근 line range 확인
→ stale=false
→ 해당 범위 근처만 read
```

로 줄일 수 있다.

즉 모델 자체의 추론 속도가 빨라지는 것이 아니라 **로컬 repo 재탐색과 context reconstruction 비용이 줄어드는 것**이 핵심이다.

---

# 다음 단계 — Phase 2 예정

## 목표

**프로젝트별 Working Session + Last Diff / Verification State**

예상 구조:

```text
sessions
 ├─ chatgpt2codex
 │   ├─ activeArtifact
 │   ├─ recentFiles
 │   ├─ lastMutation
 │   └─ lastVerification
 │
 └─ portfolio
     ├─ activeArtifact
     ├─ recentFiles
     ├─ lastMutation
     └─ lastVerification
```

추가 후보:

```text
lastMutation
  checkpointId
  files
  summary

lastVerification
  type
  command
  success
  timestamp
```

Phase 2에서 해결하려는 문제:

- 프로젝트를 오갔다가 돌아와도 context 유지
- "아까 수정한 거"가 어떤 diff인지 빠르게 확인
- "테스트까지 했었나?"를 다시 추론하지 않음
- 불필요한 재테스트/재탐색 감소

---

# 누적 기록 템플릿

앞으로 각 Phase는 아래 형식을 사용한다.

```markdown
# Phase N — 이름

**구현일:** YYYY-MM-DD
**상태:** 계획 / 구현 중 / 완료

## 문제

## 기존 동작

## 목표 동작

## 설계 결정

## 변경 파일

## 구현 내용

## 구현 중 발견한 문제

## 검증

## Before / After

## 남은 위험

## 다음 단계
```

코드 변경 자체보다 **왜 이 변경을 했는지와 어떤 실패를 거쳐 현재 구조가 되었는지**가 나중에 다시 읽어도 보이도록 유지한다.

---

# Phase 2 — Per-Project Working Sessions + Mutation / Verification State

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 1에서는 최근 파일과 hash를 기억할 수 있게 되었지만, `sessions.json` 안에 실제 작업 컨텍스트가 하나뿐이었다.

따라서 다음 흐름에서는 이전 프로젝트의 맥락이 사라졌다.

```text
Portfolio 작업
→ chatgpt2codex 작업
→ Portfolio로 복귀
```

또한 `session_resume`이 알려주는 정보도 최근 artifact / 파일 / hash / checkpoint id 수준이라 다음 질문에 바로 답하지 못했다.

```text
"아까 정확히 뭘 바꿨지?"
"그 뒤에 테스트는 통과했었나?"
"E2E까지 확인한 상태였나?"
```

결과적으로 프로젝트에 다시 돌아온 뒤 diff와 테스트 상태를 재구성하기 위해 추가 탐색이 필요했다.

## 기존 동작

Phase 1의 세션은 개념적으로 다음과 같았다.

```text
Session
 ├─ activeProjectId
 ├─ lease
 └─ workContext
      ├─ activeArtifact
      ├─ recentFiles
      ├─ lastCheckpointId
      └─ lastActivityAt
```

프로젝트 A에서 B로 전환할 경우 안전하게 섞이지 않도록 기존 `workContext`를 비우는 방식이었다.

이는 cross-project contamination을 막는 데는 안전했지만, 다시 A로 돌아왔을 때 작업 상태를 복원하지 못하는 비용이 있었다.

## 목표 동작

프로젝트별로 독립적인 working context를 유지한다.

```text
Session
 ├─ activeProjectId
 ├─ lease
 └─ workContexts
      ├─ project-A
      │    ├─ activeArtifact
      │    ├─ recentFiles
      │    ├─ lastMutation
      │    ├─ lastVerification
      │    └─ lastActivityAt
      │
      └─ project-B
           ├─ activeArtifact
           ├─ recentFiles
           ├─ lastMutation
           ├─ lastVerification
           └─ lastActivityAt
```

프로젝트를 다시 선택했을 때 과거 context가 있으면 broad search보다 먼저 `session_resume`을 사용하도록 힌트를 반환한다.

## 설계 결정

### 1. Session schema v3 — 단일 context를 project map으로 변경

기존:

```text
workContext: WorkContext | null
```

변경:

```text
workContexts: Record<projectId, WorkContext>
```

이 방식은 아직 ChatGPT conversation 단위 분리는 아니지만, 프로젝트를 오가는 일반적인 사용 흐름에서 상태 손실을 제거할 수 있다.

### 2. v2 데이터를 버리지 않고 자동 migration

기존 사용자 로컬에 이미 v2 `sessions.json`이 존재할 수 있으므로 schema를 바로 깨지 않도록 했다.

읽을 때 기존 단일 `workContext`만 있으면 메모리상 다음 형태로 변환한다.

```text
workContext(project-A)
        ↓
workContexts[project-A]
```

다음 write부터는 version 3으로 저장하고 legacy `workContext` 필드는 `null`로 정리한다.

### 3. `lastMutation`은 전체 diff가 아니라 작은 resume summary

세션에 raw diff 전체를 넣으면 context가 빠르게 커질 수 있다.

따라서 세션에는 다음 정도만 저장한다.

```text
lastMutation
 ├─ checkpointId
 ├─ tool
 ├─ files[]
 │    ├─ path
 │    ├─ action
 │    ├─ added
 │    └─ removed
 └─ at
```

실제 복구 가능한 상세 diff는 기존 checkpoint가 담당하고, session은 빠른 방향 판단을 위한 index 역할만 한다.

### 4. `lastVerification`은 마지막 의미 있는 검증만 저장

구조:

```text
lastVerification
 ├─ tool
 ├─ command
 ├─ success
 ├─ exitCode
 ├─ durationMs
 └─ at
```

대상 도구:

- `command_run`
- `local_shell_run`
- `e2e_run_command`
- `e2e_test_and_show_screenshot`

명령 문자열은 기존 redaction 정책을 적용하고 최대 500자로 제한한다.

### 5. 모든 명령 실행을 verification으로 간주하지 않는다

초기 구현에서는 `command_run`이나 `local_shell_run`이 성공하면 전부 verification으로 저장하는 방향으로 연결했다.

하지만 다음과 같은 명령까지 "검증 성공"이라고 기록될 수 있다.

```text
npm run dev
node --version
단순 조회성 shell
```

의미가 과장될 수 있어 최종적으로 다음 조건으로 좁혔다.

- `command_run`: command catalog의 `riskTier === "verify"`일 때만 저장
- `local_shell_run`: workspace write가 아닌 검증/조회 실행일 때 저장
- E2E command: 결과를 verification으로 저장

즉 단순 프로세스 성공과 "변경 사항을 검증했다"는 상태를 가능한 한 구분한다.

## 변경 파일

### `src/state/store.ts`

- Session schema version 3
- `workContexts` 추가
- v1/v2 session 호환 로드
- v2 single context → v3 project map migration
- `LastMutationSchema`
- `LastVerificationSchema`

### `src/server/tools.ts`

- project별 context update
- `recordLastMutation()` 추가
- `recordVerification()` 추가
- `project_select`에서 과거 context 보존
- `project_select`가 `hasRecentContext`와 resume instruction 반환
- `session_resume`에 `lastMutation`, `lastVerification` 포함
- mutation / verification 도구와 session state 연결

### `src/state/store.test.ts`

- schema v3 migration 검증
- legacy v1 로딩 유지 검증
- persisted v2 single context migration 검증

### `src/server/http-actions.test.ts`

- 두 프로젝트를 오가는 실제 Action 흐름 추가
- 프로젝트 A → B → A 복귀 후 A context 유지 확인
- B context도 독립적으로 유지되는지 확인
- last mutation / last verification resume 확인
- project select의 resume hint 확인

## 구현 중 발견한 문제

### 문제 1 — mutation action의 TypeScript 타입이 너무 넓었다

`applyPatch()` 결과는 실제로 `add/update/delete/move`를 반환하지만 기존 `AppliedEntry.action` 타입은 `string`이었다.

Session의 mutation schema는 명시적인 union을 사용했기 때문에 첫 typecheck에서 다음 유형의 오류가 발생했다.

```text
Type 'string' is not assignable to
'add' | 'update' | 'delete' | 'move' | 'create'
```

런타임 값의 종류는 이미 patch parser에서 제한되어 있으므로 session 경계에서 허용된 union으로 명시했다.

이 문제를 통해 runtime contract와 TypeScript contract가 정확히 일치하지 않는 부분도 확인할 수 있었다.

### 문제 2 — 한 번에 큰 mutation patch를 적용하려다 도구 안전판에 걸림

`file_apply_patch`와 `file_create`의 mutation 기록을 한 요청에서 동시에 연결하려 했을 때 tool safety layer가 요청을 차단했다.

코드 내용 자체가 위험한 변경이라기보다는 한 요청의 변경 범위가 넓어 판단이 어려운 형태였다.

대응:

```text
큰 patch 1회
      ↓
함수 단위 작은 patch 여러 회
```

로 분리했다.

결과적으로 작은 inspect/edit/verify cycle이 하네스 개발 자체에도 더 안정적이었다.

### 문제 3 — 성공한 명령과 검증 성공은 같은 의미가 아님

초기에는 실행 결과 `exitCode === 0`이면 verification으로 저장했다.

하지만 개발 서버 실행이나 조회 명령의 성공을 최종 검증으로 해석하면 resume context가 잘못된 확신을 줄 수 있다.

따라서 command catalog의 risk tier와 write intent를 기준으로 기록 범위를 좁혔다.

## 검증

### TypeScript

```text
npm run typecheck
→ PASS
```

중간에 mutation action union 문제를 1회 발견했고 수정 후 통과했다.

### Phase 2 타깃 테스트

```text
npm test -- \
  src/state/store.test.ts \
  src/server/http-actions.test.ts \
  src/server/tools-catalog.test.ts
```

결과:

```text
3 test files passed
48 tests passed
0 failed
```

핵심 통합 시나리오:

```text
Project A select
→ A 파일 read
→ verification 실행
→ A 파일 create
→ Project B select
→ B 파일 read
→ Project A 재선택
→ hasRecentContext=true
→ session_resume
→ A activeArtifact 복원
→ A lastMutation 복원
→ A lastVerification 복원
→ Project B 재선택
→ B activeArtifact 독립 복원
```

### Build

```text
npm run build
→ PASS
```

### 전체 test suite

Phase 2 구현 후 Windows 환경 전체 테스트 결과:

```text
415 tests
395 passed
17 failed
3 skipped
```

Phase 1 당시:

```text
413 tests
392 passed
18 failed
3 skipped
```

실패는 계속 macOS desktop-control을 Windows에서 실행하는 테스트, Windows POSIX permission/symlink 차이, 기존 E2E/control 플랫폼 가정 등의 영역에 집중되어 있다.

Phase 2의 session/store/Actions 타깃 테스트는 전부 통과했고 새 핵심 회귀는 확인되지 않았다.

## Before / After

### 프로젝트 이동

Before:

```text
Project A
→ Project B
→ A context 손실
→ Project A
→ 다시 탐색
```

After:

```text
Project A context 저장
→ Project B context 저장
→ Project A 재선택
→ hasRecentContext=true
→ session_resume
→ A context 복원
```

### 직전 수정 확인

Before:

```text
lastCheckpointId = cp_xxx
```

After:

```text
lastMutation
  tool = file_create
  checkpointId = cp_xxx
  files = [{ path, action, added, removed }]
```

### 테스트 상태 확인

Before:

```text
"테스트 했었나?"
→ 로그/대화/명령을 다시 추론
```

After:

```text
session_resume
→ lastVerification
   command
   success
   exitCode
   durationMs
```

## 현재 체감 목표

사용자가 다음처럼 말했을 때:

```text
"아까 포트폴리오로 돌아가서 이미지 위치만 고쳐줘"
```

하네스가 유도하려는 흐름은 다음과 같다.

```text
project_select(portfolio)
→ hasRecentContext=true
→ session_resume
→ activeArtifact / recentFiles / lastMutation / lastVerification 확인
→ hash stale 여부 확인
→ 필요한 범위만 read
→ patch
```

Phase 1이 "파일을 기억하는 단계"였다면 Phase 2는 **"프로젝트의 직전 작업 상태를 기억하는 단계"**에 가깝다.

## 남은 위험

### 1. ChatGPT conversation 단위 격리는 아직 없음

`workContexts`는 project별이지만 동일 프로젝트를 ChatGPT 탭 A/B에서 서로 다른 목표로 작업하면 아직 같은 context를 공유한다.

```text
Chat A ─┐
        ├─ same project context
Chat B ─┘
```

이 문제는 conversation/session key 설계가 필요하다.

### 2. Session update race 가능성

현재 작업은 기본적으로:

```text
loadSession
→ modify
→ setSession
```

형태다.

서로 다른 tool call이 동시에 실행되면 마지막 writer가 다른 변경을 덮을 가능성이 있다. 파일 write 자체는 atomic이지만 read-modify-write 전체가 atomic인 것은 아니다.

향후 `updateSession(mutator)` + mutex/serialization을 고려해야 한다.

### 3. 프로젝트 context map의 장기 성장

각 프로젝트의 `recentFiles`는 최대 20개지만 project key 자체에는 아직 TTL/LRU 제한이 없다.

많은 프로젝트를 장기간 사용하면 오래된 context가 계속 남을 수 있다.

### 4. last state는 history가 아님

현재는 마지막 mutation과 마지막 verification만 보존한다.

이는 빠른 resume에는 적합하지만 작업 timeline 전체를 복원하는 기능은 아니다.

### 5. mutation summary는 checkpoint를 대체하지 않는다

세션에는 작은 summary만 있으므로 실제 전체 diff 복구/검토가 필요하면 checkpoint 또는 git diff를 확인해야 한다.

## 다음 단계 — Phase 3

**Goal / Pending Task와 Working Session 연결**

현재는 다음을 기억한다.

```text
어느 프로젝트
어느 파일
무엇을 마지막으로 수정
어떤 검증을 마지막으로 수행
```

다음 단계에서는 여기에 다음을 연결한다.

```text
현재 목표가 무엇인지
무엇을 완료했는지
무엇이 아직 남았는지
왜 특정 설계 결정을 했는지
```

예상 구조:

```text
workContext
 ├─ currentGoal
 ├─ currentTask
 ├─ completed[]
 ├─ pending[]
 ├─ decisions[]
 ├─ lastMutation
 └─ lastVerification
```

이 단계부터는 단순 파일 캐시를 넘어 **"어디까지 일했는지 알고 계속하는 에이전트"**에 가까워진다.

---

# Phase 3 — Goal / Task / Pending / Decision Persistence

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 2까지의 세션은 로컬 작업의 물리적인 상태를 상당 부분 기억할 수 있었다.

기억 가능한 정보:

```text
project
activeArtifact
recentFiles
file hash
lastMutation
lastVerification
```

하지만 다음 질문에는 여전히 직접 답하기 어려웠다.

```text
"지금 왜 이 파일을 수정하고 있었지?"
"현재 목표가 뭐였지?"
"어디까지 끝냈지?"
"아직 뭐가 남았지?"
"왜 이 구조를 선택했지?"
```

즉 Phase 2까지는 **workspace state**는 기억하지만 **semantic task state**는 기억하지 못했다.

이 차이는 긴 작업에서 중요하다.

예를 들어 포트폴리오 HTML을 수정하다가 세션을 다시 열었을 때 다음 정보만 있다고 하자.

```text
activeArtifact = portfolio.html
lastMutation = page 10-11 image layout edit
lastVerification = build success
```

이 정보만으로는 모델이 다음을 다시 대화에서 추론해야 한다.

```text
현재 목적은 무엇인가?
이미 끝낸 단계는 무엇인가?
이미지 수정 후 PDF 검증이 남았는가?
원본 이미지를 유지하기로 한 결정이 있었는가?
```

따라서 Phase 3의 목표를 다음처럼 정의했다.

> 파일을 기억하는 세션에서, 작업 의도와 진행도를 기억하는 세션으로 확장한다.

## 기존 동작

`goal_intake`와 `goal_loop`는 이미 존재했다.

그러나 두 도구는 별도 `goals/*.json`에 다음과 같은 루프 기록만 남겼다.

```text
goalPreview
projectId
mode
turn
lastResult
nextActions
```

반면 `sessions.json`의 프로젝트별 `workContext`와는 연결되어 있지 않았다.

구조적으로 보면 다음과 같았다.

```text
goal_loop
   ↓
goals/loop-....json

session_resume
   ↓
sessions.json
```

두 데이터 흐름이 분리되어 있었다.

따라서 `goal_loop`를 여러 차례 수행해도 `session_resume`은 현재 goal 또는 pending task를 알 수 없었다.

## 처음 고려한 방식 — lastResult 자동 파싱

처음에는 기존 `lastResult`를 그대로 분석하여 다음을 추출하는 방식도 고려할 수 있었다.

```text
"store schema implemented, resume wiring remains"
```

에서 자동으로:

```text
completed = ["store schema implemented"]
pending = ["resume wiring"]
```

을 추출하는 방식이다.

하지만 이 접근은 채택하지 않았다.

### 이유 1 — 문자열 해석이 불안정하다

동일한 의미라도 표현 방식이 매번 다를 수 있다.

```text
schema done
schema implemented
finished store schema
store work complete
```

이를 deterministic state로 사용하면 잘못된 완료 판정이 발생할 수 있다.

### 이유 2 — pending task 오판 위험

`lastResult`는 작업 결과 설명이지 task protocol이 아니다.

따라서 단순 문장에 등장했다고 해서 완료/미완료를 안전하게 구분할 수 없다.

### 이유 3 — 불필요한 모델 추론 의존

하네스의 상태 저장은 가능한 한 구조화되고 deterministic해야 한다.

그래서 Phase 3에서는 **prose를 자동 해석하지 않고, goal_loop 입력에 구조화된 진행 필드를 추가**했다.

## 목표 동작

새로운 흐름:

```text
goal_intake
   ↓
currentGoal + goalId 저장
   ↓
goal_loop
   ↓
currentTask / completed / pending / decisions 저장
   ↓
inspect → patch → verify
   ↓
goal_loop
   ↓
진행 상태 갱신
   ↓
다음 ChatGPT turn
   ↓
project_select
   ↓
session_resume
   ↓
파일 상태 + 작업 의미 상태 동시 복원
```

## 추가된 TaskState

`WorkContext` 내부에 `taskState`를 추가했다.

```text
taskState
 ├─ goalId
 ├─ loopId
 ├─ currentGoal
 ├─ currentTask
 ├─ lastProgressSummary
 ├─ completed[]
 ├─ pending[]
 ├─ decisions[]
 └─ updatedAt
```

### goalId

`goal_intake`가 생성한 goal identifier.

별도 goal 기록과 프로젝트 작업 세션을 연결하는 데 사용한다.

### loopId

현재 프로젝트가 어떤 `goal_loop`에 연결되어 있는지 기록한다.

### currentGoal

현재 작업의 상위 목적.

예:

```text
Improve chatgpt2codex session persistence
```

### currentTask

현재 수행 중인 가장 가까운 concrete task.

예:

```text
Wire task state into session_resume
```

### lastProgressSummary

기존 `lastResult`를 짧은 최근 진행 요약으로 저장한다.

중요한 점은 이것을 completed/pending으로 자동 파싱하지 않는다는 것이다.

### completed[]

완료된 작업 항목을 누적한다.

동일 문자열은 중복 제거한다.

최대 50개로 제한했다.

### pending[]

현재 남아 있는 작업의 **snapshot**이다.

`completed`와 달리 새 pending 배열이 전달되면 기존 배열을 교체한다.

이 차이는 의도적이다.

```text
completed = history
pending   = current snapshot
```

### decisions[]

다음 작업에서 다시 알아야 할 설계 결정을 저장한다.

각 항목은:

```text
summary
rationale
timestamp
```

구조를 가진다.

최대 30개의 최근 unique decision을 유지한다.

## 보안 및 크기 제한

작업 상태는 모델이 생성한 텍스트를 그대로 영구 저장하면 안 된다.

따라서 저장 전 기존 `redact()`를 재사용한다.

그리고 각 필드에 길이 제한을 둔다.

```text
currentGoal          1000 chars
currentTask           500 chars
lastProgressSummary  1000 chars
completed item        500 chars
pending item          500 chars
decision summary      500 chars
decision rationale   1000 chars
```

배열도 제한했다.

```text
completed <= 50
pending   <= 50
decisions <= 30 persisted
decisions <= 10 per goal_loop update
```

목적은 세션이 conversation transcript 저장소로 변하는 것을 방지하는 것이다.

## goal_intake 연결

기존:

```text
goal_intake
→ goals/*.json 기록
```

개선:

```text
goal_intake
→ goals/*.json 기록
→ projectId가 있으면 workContext.taskState에도 연결
```

저장되는 핵심:

```text
goalId
currentGoal
```

이 동작은 project_select 이전에도 가능하도록 했다.

왜냐하면 실제 workflow가 다음 순서이기 때문이다.

```text
goal_intake
→ project_select
```

따라서 goal을 저장하기 위해 active lease가 먼저 존재하도록 강제하면 현재 orchestration과 충돌한다.

## goal_loop 확장

기존 입력:

```text
goal
loopId
projectId
mode
maxTurns
lastResult
```

추가 입력:

```text
currentTask
completed[]
pending[]
decisions[]
```

예:

```text
goal_loop(
  loopId = loop_x,
  projectId = portfolio,
  lastResult = "image layout patched",
  currentTask = "verify PDF render",
  completed = ["fix page 10 image layout"],
  pending = ["verify page 10 PDF", "verify page 11 PDF"],
  decisions = [
    "keep original source images instead of regenerating"
  ]
)
```

이 호출 하나가 두 역할을 수행한다.

```text
1. 기존 goal loop continuity 유지
2. semantic task checkpoint 저장
```

즉 별도 progress tool call을 매 batch마다 추가하지 않아도 된다.

이는 tool round-trip을 줄이기 위한 의도적인 하네스 설계다.

## goal loop history와 current state를 분리

`goals/<loopId>.loop.json`에는 각 turn의 진행 필드도 함께 기록한다.

이는 timeline/audit 역할이다.

반면 `sessions.json`의 `taskState`는 최신 작업 상태를 나타낸다.

```text
goal loop JSON
= history

session taskState
= current resumable snapshot
```

둘을 같은 용도로 사용하지 않는다.

## session_resume 확장

기존 반환:

```text
activeArtifact
recentFiles
hash/stale
lastCheckpointId
lastMutation
lastVerification
```

Phase 3 이후:

```text
activeArtifact
recentFiles
hash/stale
lastCheckpointId
lastMutation
lastVerification
taskState
```

따라서 follow-up turn에서 한 번의 resume으로 다음 질문에 답할 수 있다.

```text
무슨 파일?
외부에서 바뀌었나?
직전에 뭘 수정했나?
테스트했나?
현재 목표는?
지금 할 일은?
끝낸 일은?
남은 일은?
왜 이렇게 설계했나?
```

## OpenAPI / Custom GPT Actions 반영

MCP tool schema만 변경하면 Custom GPT Action surface에서는 새 필드를 알 수 없다.

따라서 `src/server/actions.ts`의 `GoalLoopInput`에도 동일한 구조를 추가했다.

추가된 OpenAPI fields:

```text
currentTask
completed
pending
decisions
```

즉 MCP와 GPT Actions 양쪽에서 동일한 semantic progress protocol을 사용할 수 있다.

## agent_guide orchestration 변경

기존 안내:

```text
goal_loop → work → goal_loop(lastResult)
```

개선 안내:

```text
goal_loop
→ work
→ goal_loop(
     lastResult,
     currentTask,
     completed,
     pending,
     decisions
   )
```

필드가 알려진 경우에만 포함한다.

즉 모델에게 모든 turn마다 억지로 metadata를 만들어내라고 요구하지 않는다.

## 구현 중 발견한 문제 1 — slice hash와 patch precondition hash 혼동

Phase 1에서 이미 발견했던 문제가 Phase 3 구현 중 다시 재현되었다.

`file_read_slice` 응답의 `fileHash`를 patch의 전체-file precondition hash로 사용하려 했고:

```text
HASH_MISMATCH
```

으로 안전하게 거절되었다.

원인은 동일하다.

```text
file_read_slice.fileHash
= 읽은 range 기준 hash

file_apply_patch.preconditionHashes
= 전체 파일 hash 기대
```

따라서 slice hash를 전체 파일 optimistic lock token으로 재사용해서는 안 된다.

Phase 1의 stale validation에서는 별도 full-file SHA-256을 도입했지만, patch 호출 surface의 read 결과는 여전히 slice hash를 노출한다.

이 문제는 향후 API naming 개선 후보다.

예:

```text
rangeHash
fullFileHash
```

처럼 명시적으로 분리하면 호출자 실수를 줄일 수 있다.

## 구현 중 발견한 문제 2 — command id 추측 금지

검증 중 처음 다음 ID로 typecheck를 호출했다.

```text
typecheck
```

하지만 실제 allowlisted command id는:

```text
npm:typecheck
```

였다.

정책 layer가 임의 command id를 허용하지 않고 거절했다.

따라서 command execution에서도 하네스는 항상:

```text
command_list
→ exact commandId
→ command_run
```

을 따라야 한다.

## 구현 중 발견한 문제 3 — build 호출 surface 차이

`command_run`을 통한 build 검증 요청이 한 차례 상위 OpenAI security classification에서 차단되었다.

이는 로컬 build 실패가 아니었다.

동일 프로젝트 안에서 guarded `local_shell_run`으로:

```text
npm run build
```

을 실행했고 정상 통과했다.

이 기록은 tool surface 자체도 agent reliability에 영향을 준다는 사례로 남긴다.

## 검증

### TypeScript typecheck

```text
npm run typecheck
PASS
```

### Phase 3 targeted tests

검증 파일:

```text
src/state/store.test.ts
src/server/http-actions.test.ts
src/server/tools-catalog.test.ts
```

결과:

```text
3 test files passed
50 tests passed
0 failed
```

세부 수:

```text
store.test.ts        14 passed
tools-catalog.test   11 passed
http-actions.test    25 passed
```

### Build

```text
npm run build
PASS
```

### 전체 회귀 테스트

```text
417 tests

397 passed
17 failed
3 skipped
```

Phase 2 당시 전체 결과:

```text
415 tests

395 passed
17 failed
3 skipped
```

Phase 3에서 테스트 2개가 추가되면서 passed가 2개 증가했고, 기존 실패 수 17개는 그대로 유지되었다.

남은 실패는 기존 Windows/macOS 플랫폼 가정, symlink 권한, desktop-control, browser E2E cleanup/timeout 계열이며 Phase 3 semantic task-state 변경에서 새로 발생한 실패는 확인되지 않았다.

## 추가된 핵심 테스트

### 1. v4 schema migration

기존 single `workContext` 입력을 v4 per-project context로 migration하고 taskState default가 생성되는지 확인한다.

### 2. taskState round-trip

다음 정보가 sessions.json을 왕복해도 유지되는지 검증한다.

```text
goalId
loopId
currentGoal
currentTask
lastProgressSummary
completed
pending
decisions
```

### 3. goal_intake → taskState 연결

goal_intake 결과의 goalId/currentGoal이 프로젝트 task state에 즉시 연결되는지 확인한다.

### 4. goal_loop multi-turn progress

첫 turn:

```text
currentTask = wire structured task state
pending = [wire resume, run focused tests]
decision = use structured progress fields
```

두 번째 turn:

```text
currentTask = run focused tests
completed = [wire structured task state, wire resume]
pending = [run focused tests]
```

그 후:

```text
project_select
→ session_resume
```

을 수행하여 최신 semantic state가 정확히 복원되는지 검증했다.

### 5. tool catalog exposure

`goal_loop` MCP schema에 다음 필드가 실제 노출되는지 확인한다.

```text
currentTask
completed
pending
decisions
```

## Before / After

### Before Phase 3

사용자:

```text
"아까 하던 거 계속해"
```

하네스가 아는 것:

```text
최근 파일
최근 diff
최근 테스트
```

모델이 다시 추론해야 하는 것:

```text
왜 작업 중인지
뭘 끝냈는지
뭘 해야 하는지
어떤 설계 결정을 유지해야 하는지
```

### After Phase 3

```text
session_resume
   ↓
activeArtifact
recentFiles + stale validation
lastMutation
lastVerification
taskState
   ├─ currentGoal
   ├─ currentTask
   ├─ completed
   ├─ pending
   └─ decisions
```

이제 모델은 작업 파일뿐 아니라 **작업의 의미적 위치**까지 복원할 수 있다.

## 기대되는 실제 체감

예를 들어 이전 turn에서:

```text
goal: portfolio finalization
currentTask: fix page 10 image placement
completed:
  - RF-DETR image insertion
  - VAE diagram insertion
pending:
  - verify page 10 PDF render
  - verify page 11 PDF render
decisions:
  - preserve user-provided original images
```

가 저장되어 있다면 다음 turn의:

```text
"계속해"
```

에서 처음부터 포트폴리오 요구사항을 재구성할 필요가 줄어든다.

## 남은 위험

### 1. ChatGPT conversation identity는 아직 없다

프로젝트별 context는 유지되지만 동일 프로젝트를 두 개의 ChatGPT conversation에서 동시에 작업하면 semantic state를 공유한다.

```text
Chat A → project X / task A
Chat B → project X / task B
```

이면 마지막 업데이트가 같은 project taskState를 갱신한다.

이 문제는 project-level persistence와 conversation-level isolation의 차이다.

### 2. session read-modify-write race

Phase 2부터 남아 있는 문제다.

```text
loadSession
→ modify
→ setSession
```

전체가 atomic하지 않다.

병렬 tool call에서 last writer wins가 발생할 수 있다.

### 3. 완료 항목은 semantic identity가 아니라 string identity

현재 중복 제거는 정규화된 문자열 동일성 기준이다.

따라서:

```text
"wire resume"
"wire session resume"
```

는 서로 다른 completed item으로 남는다.

이를 embedding/LLM similarity로 합치는 것은 현재 단계에서는 과도한 복잡성이라 도입하지 않았다.

### 4. decision은 자동 추론하지 않는다

중요한 결정이 있었더라도 goal_loop 호출자가 `decisions`에 넣지 않으면 저장되지 않는다.

이는 일부 recall을 희생하고 deterministic state를 선택한 설계다.

### 5. task state가 실제 repo 상태를 보증하지 않는다

예:

```text
completed = ["typecheck passed"]
```

라는 문자열만으로 검증 성공을 신뢰해서는 안 된다.

실제 검증 사실은 Phase 2의 `lastVerification`을 사용해야 한다.

즉 역할을 분리한다.

```text
taskState.completed
= 작업 진행 의미

lastVerification
= 실제 실행 증거
```

## Phase 3에서 얻은 설계 원칙

### 원칙 1 — transcript memory보다 state memory

전체 대화 원문을 저장하는 대신 작은 구조화 상태를 유지한다.

### 원칙 2 — inferred completion보다 explicit completion

문장 분석으로 완료 여부를 추측하지 않는다.

### 원칙 3 — history와 snapshot 분리

goal loop JSON은 history, taskState는 current snapshot이다.

### 원칙 4 — semantic state와 proof state 분리

completed task와 test evidence를 같은 것으로 취급하지 않는다.

### 원칙 5 — 기존 orchestration call에 piggyback

매 turn마다 새 memory tool을 추가 호출하지 않고 기존 goal_loop에 progress payload를 실어 latency를 줄인다.

## 다음 단계 — Phase 4 후보

Phase 3 이후 가장 큰 구조적 리스크는 두 가지다.

```text
1. Session update concurrency
2. Conversation-level isolation
```

우선순위는 concurrency가 더 높다.

### Phase 4A — Atomic Session Update

예상 방향:

```text
Store.updateSession(mutator)
  ↓
per-store mutex / promise queue
  ↓
read latest
  ↓
mutate
  ↓
atomicWriteJson
```

목표:

```text
parallel tool calls
→ lost update 방지
```

### Phase 4B — Conversation / Work Session Identity

그 다음 단계에서 project context 위에 별도 work-session key를 추가하는 방식을 검토한다.

예상 구조:

```text
project
 ├─ workSession A
 │   └─ taskState
 └─ workSession B
     └─ taskState
```

다만 ChatGPT conversation id를 MCP surface에서 안정적으로 직접 받을 수 있다고 가정해서는 안 된다.

따라서 explicit workSession token 또는 locally generated session handle 같은 구조가 필요할 수 있다.

Phase 4에서도 기존 Phase 기록은 삭제하지 않고 실제 구현 결과와 예상 차이를 아래에 계속 누적한다.

---

# Phase 4A — Atomic / Serialized Session Update

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 1~3에서 세션에 저장하는 정보가 계속 늘었다.

```text
recentFiles
activeArtifact
lastMutation
lastVerification
taskState
```

하지만 저장 방식은 대부분 다음 패턴이었다.

```text
loadSession()
→ 필요한 필드 수정
→ setSession()
```

파일 자체의 저장은 임시 파일 + rename 방식으로 atomic했지만, **read-modify-write 전체 트랜잭션은 atomic하지 않았다.**

예를 들어 두 tool call이 거의 동시에 실행되면 다음 상황이 가능하다.

```text
Tool A                 Tool B
------                 ------
read session v10
                       read session v10
add lastMutation
                       add lastVerification
write session v11
                       write session v12
```

마지막 writer인 B가 v10을 기준으로 저장했다면 A의 `lastMutation`이 사라질 수 있다.

즉 JSON 파일이 깨지는 문제는 아니지만 **정상적인 두 업데이트 중 하나가 유실되는 lost-update race**가 존재했다.

하네스가 병렬 tool execution이나 장기 agent loop로 갈수록 이 문제는 더 중요해진다.

## 목표

세션 변경은 항상 다음 순서를 보장하도록 한다.

```text
queue
  ↓
read latest persisted session
  ↓
mutator(latest)
  ↓
schema validation
  ↓
atomic file replace
  ↓
next queued mutation
```

즉 concurrent caller가 있더라도 각 mutator는 직전 mutation 결과를 포함한 최신 세션을 보게 한다.

## Store.updateSession 도입

`Store`에 새로운 API를 추가했다.

개념적으로:

```text
updateSession(current => next)
```

형태다.

기존 `setSession()`은 caller가 완성된 document를 넘긴다.

반면 `updateSession()`은 Store가 큐 안에서 최신 상태를 읽은 다음 caller의 mutator를 실행한다.

이 차이가 핵심이다.

## 세션 write queue

`src/state/store.ts`에 stateDir 기준 promise queue를 추가했다.

```text
sessionWriteQueues
  key   = stateDir
  value = previous write tail Promise
```

단순히 `Store` 인스턴스의 private field로 두지 않고 module-level `Map`으로 둔 이유가 있다.

동일 Node runtime 안에서:

```text
Store instance A(stateDir X)
Store instance B(stateDir X)
```

가 만들어져도 같은 `sessions.json`을 수정한다면 같은 queue를 공유해야 하기 때문이다.

따라서 queue scope는:

```text
Store object
```

가 아니라:

```text
runtime process + stateDir
```

이다.

## setSession도 같은 queue 사용

`updateSession()`만 queue를 사용하고 `setSession()`은 기존 direct write를 유지하면 다음 race가 남는다.

```text
updateSession
↕
setSession
```

따라서 `setSession()`도 동일한 queue에 넣었다.

즉 하나의 runtime에서 sessions.json을 쓰는 Store API는 동일한 serialization boundary를 사용한다.

## queue failure 처리

Promise chain 기반 queue에서 중요한 문제는 앞 작업이 reject했을 때 다음 작업까지 영구적으로 reject chain에 묶이는 것이다.

따라서 queue tail은 다음 작업을 위해 failure를 소비하지만 실제 caller에게는 원래 exception을 그대로 전달하도록 분리했다.

개념적으로:

```text
run Promise
  ├─ caller: success/failure 그대로 수신
  └─ queue tail: failure를 삼키고 다음 operation 허용
```

그리고 마지막 operation이 끝나면 해당 stateDir의 queue entry도 제거한다.

이렇게 하지 않으면 사용한 stateDir key가 process lifetime 동안 계속 Map에 남을 수 있다.

## normalize / write 분리

Store의 session write 코드를 다음 책임으로 나눴다.

```text
normalizeSession
  → schema migration/default/version/timestamp

writeSessionNow
  → validation + atomicWriteJson

enqueueSessionWrite
  → serialization

setSession
  → queue + full replacement

updateSession
  → queue + latest read + mutator + write
```

이 구조로 migration/version logic을 set/update 양쪽에서 중복하지 않게 했다.

## ToolContext 확장

`ToolContext.store`에 다음 optional capability를 추가했다.

```text
updateSession?(mutator)
```

optional로 둔 이유는 테스트 mock과 외부 adapter 호환성 때문이다.

기존 테스트들은 작은 in-memory store object를 많이 사용하고 있었다.

모든 mock을 즉시 atomic Store로 강제하면 Phase 4A의 변경 범위가 불필요하게 커진다.

그래서 tool layer에는:

```text
if store.updateSession exists
  → atomic path
else
  → legacy get + set fallback
```

을 두었다.

실제 production CLI context에는 `Store.updateSession`을 명시적으로 연결했다.

따라서 optional은 **production에서 기능을 끄기 위한 것이 아니라 adapter backward compatibility를 위한 것**이다.

## 실제 production 배선 확인

`src/cli.ts`의 ToolContext 생성 부분은 Store method를 수동 wrapper로 노출한다.

초기 Phase 4A 구현 시 Store에는 `updateSession()`이 생겼지만 이 wrapper에는 아직 연결되지 않았다.

이 상태라면 source에는 atomic API가 있어도 실제 MCP/CLI tool context는 fallback path를 타게 된다.

그래서 다음 배선을 추가했다.

```text
updateSession: mutator => store.updateSession(mutator)
```

이 audit는 중요했다.

**기능을 구현한 것과 실제 runtime dependency graph에 연결한 것은 다른 문제**이기 때문이다.

## tool layer helper

`src/server/tools.ts`에 `updateSessionState()`를 추가했다.

역할:

```text
raw SessionDocument
→ SessionState로 coercion
→ atomic mutator 실행
→ SessionState 반환
```

Store implementation이 atomic API를 지원하지 않는 경우에만 기존 get/set path를 사용한다.

## atomic path로 옮긴 session mutation

다음 helper를 전환했다.

### recordRecentWork

이전:

```text
load session
check active project
calculate recent files
save
```

개선:

```text
updateSessionState(latest => {
  check active project
  calculate recent files from latest
  return next
})
```

active project 검사까지 mutator 안으로 옮겼다.

그렇지 않으면 check와 write 사이에 active project가 바뀌는 TOCTOU 문제가 남기 때문이다.

### recordLastMutation

`lastMutation`과 `lastCheckpointId`를 최신 project context 위에 병합하도록 변경했다.

### recordVerification

동시에 mutation update가 발생해도 latest context를 기준으로 `lastVerification`만 추가하도록 변경했다.

### recordTaskProgress

Phase 3에서 추가한 semantic state도 atomic mutator 안에서 merge한다.

특히 `completed[]`와 `decisions[]`는 기존 최신 배열을 읽은 뒤 merge해야 하므로 lost update의 영향을 받기 쉬운 필드였다.

### project_select

프로젝트 선택도 단순 replacement가 아니라 session mutation이다.

기존에는:

```text
load session
→ unexpired lease 확인
→ 새 lease 계산
→ save
```

이었는데 lease conflict check와 session update 사이 race가 가능했다.

이를:

```text
updateSessionState(latest => {
  check current active lease
  reject unless confirmSwitch
  set new active project + lease
})
```

로 옮겼다.

따라서 project switch 검사와 변경이 같은 serialization boundary 안에 들어갔다.

## direct saveSession audit

atomic migration 후 실제 source에서:

```text
rg "await saveSession(ctx" src/server/tools.ts
```

를 실행했다.

결과:

```text
1 match
```

남은 match는 `updateSessionState()`의 **legacy compatibility fallback 내부**뿐이다.

즉 production helper mutation이 실수로 direct save path를 사용하는 곳은 현재 audit 범위에서는 남아 있지 않다.

## 구현 중 발견한 문제 — TypeScript closure narrowing

`project_select` 전환 과정에서 처음에는 다음처럼 구현했다.

```text
let resumableContext = null

await updateSessionState(() => {
  resumableContext = ...
})

resumableContext.lastActivityAt
```

TypeScript가 async callback의 side-effect assignment를 원하는 방식으로 좁히지 못해 `never` 관련 type error가 발생했다.

해결은 side-effect variable을 없애고 `updateSessionState()`가 반환한 최종 session에서 다시 context를 가져오는 것이었다.

```text
const updatedSession = await updateSessionState(...)
const resumableContext = updatedSession.workContexts[projectId] ?? null
```

이 방식이 타입 측면뿐 아니라 데이터 의미 측면에서도 더 정확하다.

## 핵심 concurrency test

같은 `stateDir`을 사용하는 **서로 다른 Store 인스턴스 2개**를 생성했다.

초기 상태:

```text
activeProjectId = null
mode = observe
```

두 업데이트를 `Promise.all`로 동시에 실행했다.

Update A:

```text
40ms 의도적 delay
activeProjectId = alpha-app
```

Update B:

```text
mode = edit
```

naive read-modify-write라면 두 caller가 같은 초기 상태를 읽어 한쪽 필드를 덮어쓸 수 있다.

새 queue에서는:

```text
A reads state
A waits 40ms
A writes activeProjectId
B reads A result
B writes mode
```

가 되어 최종 결과가:

```text
activeProjectId = alpha-app
mode = edit
```

둘 다 유지됨을 확인했다.

## queue recovery test

첫 mutator가 의도적으로 exception을 throw하도록 했다.

```text
update 1
→ throw intentional update failure
```

caller에는 reject가 정상 전달되는지 확인했다.

그 직후 두 번째 update:

```text
update 2
→ activeProjectId = recovered-project
```

를 실행했다.

두 번째 update가 정상 완료되어 **failed mutation이 queue를 poison하지 않음**을 검증했다.

## 검증

### TypeScript

```text
npm run typecheck
PASS
```

### Targeted tests

최종 Phase 4A targeted 결과:

```text
3 test files passed
52 tests passed
0 failed
```

세부:

```text
store.test.ts        16 passed
tools-catalog.test   11 passed
http-actions.test    25 passed
```

### Build

```text
npm run build
PASS
```

### Full regression suite

queue recovery test 추가 전 마지막 전체 suite 결과:

```text
418 tests

398 passed
17 failed
3 skipped
```

Phase 3:

```text
417 tests
397 passed
17 failed
3 skipped
```

따라서 Phase 4A concurrency test 1개가 추가된 시점에 pass가 정확히 1개 증가했고 기존 실패 17개는 유지되었다.

마지막 queue-recovery test는 targeted suite에서 추가 검증하여 52/52가 통과했다.

기존 17개 실패군은 Phase 4A와 무관한 플랫폼성 테스트다.

## Before / After

### Before

```text
Tool A: load v10
Tool B: load v10
Tool A: write A(v11)
Tool B: write B(v12 based on v10)

→ A data can disappear
```

### After

```text
Tool A
  ↓
session queue
  ↓
read latest
  ↓
write
  ↓
Tool B
  ↓
read Tool A result
  ↓
write merged state
```

## 현재 보장 범위

현재 queue가 보장하는 범위:

```text
same Node.js process
+
same stateDir
```

즉 같은 runtime 프로세스 안의 여러 Store 인스턴스와 병렬 tool call에 대해서는 serialization을 제공한다.

## 아직 해결되지 않은 cross-process 문제

다음은 아직 보장하지 않는다.

```text
Process A
  Store(stateDir X)

Process B
  Store(stateDir X)
```

서로 다른 OS process는 JavaScript module-level Map을 공유하지 않는다.

따라서 동일 `sessions.json`을 여러 chatgpt2codex process가 동시에 쓰는 운영 구조라면 여전히 process-level race가 가능하다.

향후 필요할 경우 다음 후보가 있다.

```text
lock file + stale lock recovery
OS file lock library
SQLite transactional session store
single-writer local daemon
```

현재 runtime 사용 방식에서는 먼저 in-process lost update를 제거하는 것이 비용 대비 효과가 가장 높다고 판단했다.

## Phase 4A에서 얻은 설계 원칙

### 1. atomic file write와 atomic state update는 다르다

rename으로 JSON corruption을 막는 것과 concurrent semantic update의 lost-update를 막는 것은 별개다.

### 2. validation과 mutation은 같은 boundary 안에 있어야 한다

active project/lease check를 queue 밖에서 하면 TOCTOU가 남는다.

### 3. real dependency wiring을 반드시 audit한다

Store class에 method를 추가했다고 production runtime이 자동으로 쓰는 것은 아니다.

### 4. failure가 queue의 미래를 막으면 안 된다

operation error와 queue continuation state를 분리해야 한다.

### 5. compatibility fallback은 명확히 제한한다

test mock과 adapter는 fallback을 허용하지만 production CLI는 atomic API를 반드시 연결했다.

## 다음 단계 — Phase 4B

이제 큰 구조적 문제는 **동일 프로젝트의 서로 다른 ChatGPT 작업이 하나의 semantic taskState를 공유하는 것**이다.

현재:

```text
project X
  └─ one workContext
```

원하는 방향:

```text
project X
  ├─ workSession A
  │   ├─ taskState A
  │   └─ recent context A
  └─ workSession B
      ├─ taskState B
      └─ recent context B
```

다만 ChatGPT conversation ID가 MCP caller에게 안정적으로 주어진다고 가정하지 않는다.

따라서 다음 단계에서는 **명시적/local-generated work session handle**을 중심으로 설계하고, handle이 없을 때는 기존 project-default context를 유지하는 backward-compatible 방향이 필요하다.

---

# Phase 4B — Same-project Work Session Isolation

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 2에서 context를 프로젝트별로 분리했고 Phase 3에서 semantic task state를 추가했다.

하지만 동일 프로젝트 안에서는 여전히 하나의 context를 공유했다.

```text
project X
  └─ workContext
      ├─ recentFiles
      ├─ lastMutation
      ├─ lastVerification
      └─ taskState
```

따라서 ChatGPT 탭 A와 B가 같은 repo를 서로 다른 목적으로 작업하면 마지막 작업이 이전 작업의 의미 상태를 덮을 수 있었다.

```text
Chat A: portfolio HTML 수정
Chat B: portfolio build script 수정

같은 projectId
→ 같은 recentFiles/taskState
→ context contamination 가능
```

## conversation ID를 직접 사용하지 않은 이유

가장 단순해 보이는 해법은 ChatGPT conversation id를 session key로 사용하는 것이다.

하지만 MCP/GPT Actions caller가 안정적인 ChatGPT conversation id를 항상 제공한다고 가정할 근거가 없다.

하네스가 비공개/비보장 caller metadata에 의존하면 플랫폼 동작이 바뀔 때 persistence가 깨질 수 있다.

따라서 Phase 4B에서는 ChatGPT conversation 자체가 아니라 **chatgpt2codex가 직접 발급하는 local work-session handle**을 사용했다.

## 핵심 설계

새 goal 또는 새 coding loop가 시작될 때:

```text
ws_<epoch-ms>_<uuid8>
```

형태의 `workSessionId`를 발급한다.

예:

```text
ws_1786159000000_a1b2c3d4
```

이 ID는 모델이 이후 로컬 tool call에 계속 전달한다.

```text
goal_intake
  ↓ returns workSessionId
project_select(workSessionId)
session_resume(workSessionId)
file_read_slice(workSessionId)
file_apply_patch(workSessionId)
file_create(workSessionId)
command/local shell(workSessionId)
E2E(workSessionId)
goal_loop(workSessionId)
```

## Session schema v5

기존 프로젝트 기본 context는 호환성을 위해 유지했다.

```text
workContexts[projectId]
```

새 isolated context 저장소를 추가했다.

```text
workSessions[projectId][workSessionId]
```

전체 구조:

```text
sessions.json
├─ activeProjectId
├─ lease
├─ workContexts
│  └─ project X
│      └─ legacy/default context
└─ workSessions
   └─ project X
      ├─ ws_A
      │  ├─ activeArtifact
      │  ├─ recentFiles
      │  ├─ lastMutation
      │  ├─ lastVerification
      │  └─ taskState
      └─ ws_B
         ├─ activeArtifact
         ├─ recentFiles
         ├─ lastMutation
         ├─ lastVerification
         └─ taskState
```

Session schema version은 `4 → 5`로 올렸다.

## backward compatibility

`workSessionId`를 전달하지 않는 기존 호출은 계속:

```text
workContexts[projectId]
```

를 사용한다.

즉 새로운 isolated session 기능을 모르는 기존 client가 즉시 깨지지 않는다.

새 ID가 있으면:

```text
workSessions[projectId][workSessionId]
```

로 라우팅한다.

이를 위해 공통 helper를 추가했다.

```text
getWorkContext(...)
withWorkContext(...)
```

각 기록 함수가 저장 위치를 직접 판단하지 않고 이 helper를 사용한다.

## WorkContext 자체에도 ID 저장

각 isolated context에:

```text
workSessionId
```

를 저장한다.

따라서 nested map key뿐 아니라 context 자체도 자신이 어떤 작업 세션인지 식별할 수 있다.

## goal_intake 동작

프로젝트가 지정된 새 goal에서 caller가 기존 `workSessionId`를 주지 않으면 자동 생성한다.

```text
goal_intake(projectId, goal)
  ↓
createWorkSessionId()
  ↓
goal JSON에 저장
  ↓
taskState 저장
  ↓
response.workSessionId 반환
```

`nextActions`에도 ID를 명시해서 후속 호출이 이를 계속 전달하도록 했다.

## goal_loop 직접 시작도 자동 격리

초기 구현에서는 `goal_intake`만 ID를 자동 생성했다.

그러나 실제 하네스에서는 broad coding prompt에서 `goal_loop`가 첫 진입점이 될 수도 있다.

이 경우 ID가 없으면 새 기능이 있음에도 legacy project context를 사용하게 된다.

그래서 새 loop 첫 turn 조건:

```text
projectId exists
AND previousTurns === 0
AND caller workSessionId missing
AND loop JSON workSessionId missing
```

이면 자동으로 새 workSessionId를 발급하도록 보완했다.

두 번째 turn부터 caller가 ID를 생략해도 loop JSON에 저장된 ID를 다시 읽어 같은 작업 세션을 유지한다.

## 격리 범위

Phase 4B에서 단순히 taskState만 분리한 것이 아니다.

다음 전체 작업 context를 workSession 단위로 분리했다.

```text
activeArtifact
recentFiles
file hashes / ranges
lastCheckpointId
lastMutation
lastVerification
taskState
```

따라서 같은 프로젝트에서:

```text
Session A → alpha.html
Session B → beta.html
```

작업 시 각 세션의 resume 결과가 서로 다른 파일 및 작업 상태를 반환한다.

## work_session_list

새 read-only MCP tool을 추가했다.

목적은 **새 ChatGPT 대화가 과거 작업을 이어가고 싶지만 workSessionId를 모르는 경우**다.

반환 정보:

```text
workSessionId
currentGoal
currentTask
activeArtifact
lastActivityAt
pendingCount
```

최근 활동 순으로 정렬한다.

예상 흐름:

```text
"아까 포트폴리오 계속해"
  ↓
project identify
  ↓
work_session_list(project)
  ↓
최근 goal/task/artifact 비교
  ↓
best matching workSessionId 선택
  ↓
project_select + session_resume
```

이 방식은 conversation id를 몰라도 과거 로컬 작업을 복원할 수 있게 한다.

## Agent guide orchestration 변경

`agent_guide`에 다음 규칙을 추가했다.

1. goal_intake/goal_loop가 ID를 반환하면 같은 task의 후속 호출에 계속 전달한다.
2. follow-up인데 현재 chat이 ID를 모르면 `work_session_list`를 먼저 확인한다.
3. session list의 goal/task/artifact를 비교해 가장 맞는 handle을 선택한다.
4. 다른 작업의 project-default context를 무조건 재사용하지 않는다.

## Actions / OpenAPI 지원

다음 Actions schema에 optional `workSessionId`를 추가했다.

```text
GoalIntakeInput
GoalLoopInput
ProjectSelectInput
SessionResumeInput
FileReadSliceInput
FileApplyPatchInput
FileCreateInput
CommandRunInput
LocalShellRunInput
E2eRunCommandInput
E2eTestAndShowScreenshotInput
```

형식 검증:

```text
^ws_[A-Za-z0-9_.-]+$
maxLength = 120
```

## 구현 중 발견한 문제 1 — E2E schema propagation 누락

`e2e_run_command`의 내부 `recordVerification()` 호출에는 workSessionId를 연결했지만 처음 patch에서 실제 input schema 한 곳을 빠뜨렸다.

TypeScript가:

```text
Property 'workSessionId' does not exist
```

를 잡아냈고 schema를 보완했다.

이 사례는 ID propagation 기능에서는 **handler만 수정하는 것으로 충분하지 않고 input schema → handler → persistence 전체를 audit해야 함**을 보여준다.

## 구현 중 발견한 문제 2 — OpenAPI 30-operation limit

처음에는 `work_session_list`를 Custom GPT Actions의 전용 route로도 추가했다.

그러자 targeted test가 실패했다.

```text
expected 31 to be <= 30
```

프로젝트는 GPT Actions schema를 compact하게 유지하기 위해 최대 30 operation을 명시적으로 검증하고 있었다.

새 route 하나를 그대로 추가하면 이 invariant를 깨뜨린다.

### 선택지

1. 기존 전용 route 하나 제거 후 work_session_list 추가
2. operation limit 자체를 완화
3. MCP에는 direct tool 유지, Actions는 기존 generic `call_tool` 사용

3번을 선택했다.

이유:

- 기존 Actions surface를 제거하지 않는다.
- 30-operation contract를 유지한다.
- `call_tool`은 이미 hidden/less-common MCP tool fallback 용도로 존재한다.
- work session 복구는 일반 file edit보다 호출 빈도가 낮다.

최종 구조:

```text
MCP
→ work_session_list direct

Custom GPT Actions
→ call_tool(toolName="work_session_list", ...)
```

통합 테스트 역시 Actions fallback 경로를 실제 호출해 검증했다.

## 구현 중 발견한 문제 3 — Windows shell에서 quoted pipe pattern

소스 audit 중 다음처럼 `rg` pattern에 `|`를 포함한 shell 문자열을 사용했을 때 Windows shell이 pipe로 해석해 명령이 실패했다.

이를 여러 `-e` pattern으로 분리하여 해결했다.

하네스 개발 과정에서 shell command construction 역시 플랫폼별 quoting 차이를 고려해야 한다는 사례로 기록한다.

## 구현 중 발견한 문제 4 — write lease expiration

마지막 mutation/verification isolation test를 추가하는 도중 full-write lease가 만료되었다.

`file_apply_patch`는 다음으로 거절했다.

```text
LEASE_REQUIRED
Lease expired
```

프로젝트를 다시 `project_select(preset=full-write)`한 뒤 같은 patch를 재실행했다.

이는 장시간 autonomous coding loop에서 lease TTL이 실제로 동작한다는 검증 사례이기도 하다.

## 통합 격리 테스트

같은 `projectId = proj`에 두 goal을 생성했다.

```text
Alpha goal
→ ws_A

Beta goal
→ ws_B
```

두 ID가 서로 다름을 확인했다.

### Alpha session

```text
activeArtifact = alpha.html
currentGoal = Improve alpha portfolio layout
currentTask = verify alpha layout
pending = finish alpha.html
mutation file = alpha.html
verification command contains alpha-check
```

### Beta session

```text
activeArtifact = beta.html
currentGoal = Refactor beta harness code
currentTask = run beta tests
pending = finish beta.html
mutation file = beta.html
verification command contains beta-check
```

각각 `session_resume(workSessionId)`를 호출하여 파일, semantic task, mutation, verification이 서로 섞이지 않는지 확인했다.

또한 Actions의 generic `call_tool`로 `work_session_list`를 호출해 두 handle이 모두 발견되는 것도 검증했다.

## Store schema round-trip

v5 nested structure 자체도 별도 Store test를 추가했다.

```text
workSessions
  alpha-app
    ws_alpha → alpha.html / Alpha goal
    ws_beta  → beta.html  / Beta goal
```

저장 후 다시 읽었을 때 두 context가 독립적으로 유지되는 것을 검증했다.

## 검증 결과

### TypeScript

```text
npm run typecheck
PASS
```

### Targeted

```text
3 test files passed
54 tests passed
0 failed
```

세부:

```text
store.test.ts        17 passed
tools-catalog.test   11 passed
http-actions.test    26 passed
```

### Build

```text
npm run build
PASS
```

### Full regression

```text
421 tests

401 passed
17 failed
3 skipped
```

기존 Phase 4A 시점의 플랫폼성 실패 17개가 그대로 유지되었다.

이번 work-session isolation에서 새 regression은 확인되지 않았다.

## Before / After

### Before

```text
Project X
  one context

Chat A edits HTML
Chat B edits server

→ last task wins
→ recent artifact/task can be overwritten
```

### After

```text
Project X
  ws_A
    HTML work state

  ws_B
    server work state

→ independent resume
→ independent task/mutation/verification context
```

## 중요한 한계

### 1. ID propagation을 잃으면 legacy context로 떨어질 수 있다

workSession 격리는 caller가 ID를 후속 tool call에 계속 전달할 때 가장 강하게 보장된다.

이를 완화하기 위해 goal_loop JSON 복구와 agent_guide 규칙을 넣었지만 임의의 오래된 client가 ID를 무시하면 project-default context가 사용될 수 있다.

### 2. work-session isolation은 실제 파일 conflict lock이 아니다

두 세션이 서로 다른 memory를 갖더라도 같은 실제 파일을 동시에 수정할 수 있다.

```text
ws_A → app.ts edit
ws_B → app.ts edit
```

이 충돌은 기존 hash precondition, checkpoint, git diff로 처리해야 한다.

WorkSession은 **agent context isolation**이지 branch/worktree isolation은 아니다.

### 3. active project lease는 아직 project-global

work context는 여러 세션으로 나뉘지만 active project/lease 자체는 기존 session document의 global field다.

같은 프로젝트의 여러 work session에는 큰 문제가 없지만 서로 다른 프로젝트를 병렬로 적극 수정하는 구조까지 완전히 독립 lease를 제공하는 것은 아니다.

### 4. session lifecycle이 없다

현재 `workSessions`는 생성 후 자동 제거되지 않는다.

장기간 사용하면 오래된 session handle이 계속 남을 수 있다.

### 5. 자동 best-match는 규칙 수준

현재 `work_session_list`가 후보를 제공하고 agent guide가 goal/task/artifact를 비교하도록 지시한다.

runtime 자체가 score를 계산해 하나를 자동 선택하는 것은 아직 아니다.

## 다음 단계 — Phase 5

Phase 4B 이후 다음 체감 개선 후보는 **Work Session Lifecycle + Fast Resume Ranking**이다.

목표:

```text
오래된 session 무한 증가 방지
+
"아까 하던 거"에서 후보 탐색 비용 감소
```

후보 설계:

```text
work_session_list
  ↓
recent / active / pending 기준 score
  ↓
suggestedWorkSessionId

Session retention
  max sessions per project
  TTL or LRU
```

다음 Phase에서도 기존 기록은 삭제하지 않고 예상과 실제 구현 결과를 이어서 추가한다.

---

# Phase 5 — Work Session Lifecycle + Fast Resume Ranking

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 4B에서 같은 프로젝트의 작업을 `workSessionId`로 분리했지만 두 문제가 남았다.

```text
1. 새 workSession이 계속 쌓이면 sessions.json이 무한히 커질 수 있음
2. 새 대화가 workSessionId를 모를 때 어떤 세션을 이어야 하는지 후보를 다시 비교해야 함
```

즉 isolation은 생겼지만 lifecycle과 fast lookup이 없었다.

## 설계 결정 1 — TTL보다 LRU 상한

시간 기반 TTL도 고려했다.

예:

```text
30일 이상 사용하지 않은 session 삭제
```

하지만 오래된 작업이라도 사용자가 다시 이어가려는 경우가 있을 수 있다.

그래서 우선 더 예측 가능한 정책을 선택했다.

```text
MAX_WORK_SESSIONS_PER_PROJECT = 20
```

프로젝트마다 최근 20개 isolated session만 유지한다.

이 정책은 날짜가 오래됐다는 이유만으로 중요한 세션을 즉시 제거하지 않고, 실제로 더 최근 20개의 작업이 생겼을 때만 밀어낸다.

## 새 세션을 반드시 보존하는 LRU

단순히 모든 context를:

```text
sort(lastActivityAt desc)
slice(0, 20)
```

하는 방식은 사용하지 않았다.

여러 session이 같은 millisecond timestamp를 가질 경우 방금 갱신한 session이 정렬 안정성에 의존해 잘릴 가능성을 만들고 싶지 않았기 때문이다.

대신:

```text
현재 갱신 중인 workSessionId는 무조건 보존
+
나머지 session을 lastActivityAt 기준 정렬
+
최근 19개만 유지
```

한다.

즉 현재 mutation의 대상은 retention 경쟁에서 제외하고 나머지만 LRU pruning한다.

## 설계 결정 2 — transcript/embedding 없이 deterministic ranking

`work_session_list`가 단순 시간순 목록만 주면 모델이 다시 여러 후보를 읽고 판단해야 한다.

Phase 5에서는 runtime이 작은 deterministic score를 계산하도록 했다.

입력에 optional `hint`를 추가했다.

예:

```text
work_session_list(
  projectId = portfolio,
  hint = "SK쉴더스 포트폴리오 이미지"
)
```

검색 대상은:

```text
currentGoal
currentTask
activeArtifact
```

이다.

## Ranking score

### 최근성

```text
1시간 이내  +30
24시간 이내 +20
7일 이내    +10
```

### 미완료 작업

pending task가 존재하면 최대 +10을 준다.

이유는 "계속해"라는 요청에서는 완전히 끝난 session보다 남은 일이 있는 session일 가능성이 높기 때문이다.

### full hint match

정규화된 hint 전체가 goal/task/artifact 문자열에 포함되면:

```text
+80
```

### token hint match

hint를 2글자 이상 token으로 나눠 각 token이 검색 문자열에 존재하면:

```text
token 당 +15
최대 +60
```

을 부여한다.

결과에는 score뿐 아니라 이유도 반환한다.

```text
matchScore
matchReasons
```

예:

```text
active-within-1h
has-pending-work
hint-token-match:2/2
```

## 반환 구조 개선

`work_session_list`는 이제 다음을 반환한다.

```text
projectId
hintApplied
retentionLimit
totalWorkSessions
suggestedWorkSessionId
workSessions[]
```

각 candidate에는:

```text
workSessionId
currentGoal
currentTask
activeArtifact
lastActivityAt
pendingCount
matchScore
matchReasons
```

가 들어간다.

기본 반환 후보 수는 10개이며 caller가 `limit`을 1~50 사이에서 조절할 수 있다.

## hint는 저장하지 않는다

사용자가 그 순간 말한 follow-up 문장은 ranking input으로만 사용하고 session state에는 저장하지 않는다.

즉:

```text
hint = transient query
taskState = persisted state
```

로 분리한다.

resume 검색을 위해 사용자 문장을 새로운 memory로 누적하지 않는다.

## Agent guide 변경

이전:

```text
work_session_list
→ 모델이 goal/task/artifact 후보를 비교
```

개선:

```text
work_session_list(hint=user follow-up summary)
→ suggestedWorkSessionId
→ goal/task/artifact가 요청과 맞는지 sanity check
→ session_resume
```

runtime ranking을 맹신하지 않고 최종 의미 일치 여부는 모델이 확인하도록 했다.

## 테스트 — hint ranking

동일 프로젝트에 두 isolated session을 만들었다.

```text
Alpha
goal = Improve alpha portfolio layout
artifact = alpha.html

Beta
goal = Refactor beta harness code
artifact = beta.html
```

그 후:

```text
hint = "beta harness"
```

로 `work_session_list`를 호출했다.

검증:

```text
hintApplied = true
retentionLimit = 20
suggestedWorkSessionId = betaId
rank 1 = betaId
matchReasons contains hint-token-match
```

을 모두 확인했다.

## 테스트 — retention

같은 프로젝트에 goal 22개를 연속 생성해 workSession 22개를 만들었다.

그 뒤 목록을 확인했다.

예상:

```text
22 created
→ 20 retained
```

검증 결과:

```text
totalWorkSessions = 20
workSessions.length = 20
가장 최신 session 존재
가장 오래된 첫 2개 session 제거
```

를 확인했다.

## 검증 결과

### TypeScript

```text
npm run typecheck
PASS
```

### Targeted tests

```text
3 test files passed
55 tests passed
0 failed
```

세부:

```text
store.test.ts        17 passed
tools-catalog.test   11 passed
http-actions.test    27 passed
```

### Build

```text
npm run build
PASS
```

### Full regression

```text
422 tests

402 passed
17 failed
3 skipped
```

기존 Windows/macOS platform/control/symlink/browser-E2E 계열 실패 17개는 그대로 유지되었고 Phase 5의 새 regression은 확인되지 않았다.

## Before / After

### Before

```text
"아까 하던 거 계속해"
  ↓
work_session_list
  ↓
후보 여러 개 반환
  ↓
모델이 하나씩 비교
```

그리고 session 수가 계속 증가할 수 있었다.

### After

```text
"아까 beta harness 하던 거 계속해"
  ↓
work_session_list(hint="beta harness")
  ↓
runtime score
  ↓
suggestedWorkSessionId = ws_beta
  ↓
sanity check
  ↓
resume
```

프로젝트당 isolated session도 최대 20개로 제한된다.

## 현재 한계

### 1. semantic embedding ranking은 아니다

현재는 deterministic substring/token matching이다.

따라서 서로 의미는 비슷하지만 단어가 전혀 다른 표현에는 약하다.

이것은 일부러 선택한 trade-off다.

resume lookup 하나 때문에 embedding API, vector DB 또는 추가 모델 호출을 넣으면 latency/복잡도/비용이 다시 증가한다.

### 2. 한국어 합성 표현

공백이 적은 한국어 문장에서는 token 단위 매칭이 영어보다 덜 세밀할 수 있다.

다만 full substring과 최근성/task/artifact 정보가 함께 점수에 들어가므로 기본 follow-up에는 충분히 유용하다.

### 3. suggestedWorkSessionId는 권고값

score가 높다고 무조건 해당 세션을 실행하면 안 된다.

goal/task/artifact가 사용자 요청과 맞는지 확인하는 orchestration 규칙을 유지한다.

### 4. pruning은 session metadata만 제거한다

LRU에서 밀려난다고 repo 파일이나 Git history가 삭제되는 것은 아니다.

현재 implementation은 `sessions.json`의 isolated workContext entry만 제거한다.

별도 goal loop JSON/checkpoint lifecycle은 아직 독립적이다.

### 5. 상한은 현재 고정값

`20`은 코드 상수이며 사용자 설정값은 아니다.

운영 데이터가 쌓인 뒤 필요하면 config로 승격할 수 있다.

## 다음 단계 — Phase 6

이제 original UX 문제를 더 직접 건드린다.

현재 follow-up은 좋은 session을 찾더라도 보통:

```text
session_resume
→ recent file/range 확인
→ file_read_slice
→ 실제 코드 확인
```

두 번의 tool round-trip이 필요하다.

Phase 6 목표는 **Fast Resume Hydration**이다.

```text
session_resume(includeActiveSlice=true)
  ↓
hash validation
+
최근 active line range의 최신 파일 내용까지 한 번에 반환
```

단 raw source를 session JSON에 저장하지는 않는다.

resume 시 실제 디스크에서 fresh read하여 외부 수정도 반영하고, secret-path guard/redaction을 그대로 적용하는 방향으로 구현한다.

---

# Phase 6 — Fast Resume Hydration

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 5까지는 적절한 project/workSession을 찾는 비용을 줄였다.

하지만 실제 follow-up 작업은 여전히 보통 두 번의 inspect round-trip을 필요로 했다.

```text
session_resume
  ↓
activeArtifact + remembered line range 확인
  ↓
file_read_slice
  ↓
현재 코드 내용 확인
```

사용자가 느끼는 지연에서는 이 한 번의 추가 tool round-trip도 반복될수록 크게 체감된다.

특히 긴 HTML처럼 이전 turn에 이미 특정 범위를 읽었던 작업에서는 다시 같은 범위를 요청하기 위한 호출이 불필요한 orchestration overhead가 된다.

## 목표

```text
session_resume(includeActiveSlice=true)
  ↓
session metadata
+
hash validation
+
remembered active range의 최신 디스크 내용
```

을 한 번에 반환한다.

## 중요한 설계 결정 — source content는 session JSON에 저장하지 않는다

가장 단순한 방식은 읽었던 코드 내용을 `sessions.json`에 그대로 캐시하는 것이다.

채택하지 않았다.

이유:

- 파일이 외부 에디터에서 바뀌면 cached source가 즉시 stale해진다.
- session 파일 크기가 급격히 커질 수 있다.
- source/snippet이 별도 persistence surface에 중복 저장된다.
- secret/redaction 정책의 관리 지점이 늘어난다.

대신 session에는 기존처럼:

```text
path
start
end
fileHash
```

만 저장하고 resume 요청 순간 실제 project file을 다시 읽는다.

즉:

```text
stored memory = 위치 정보
hydrated source = fresh disk read
```

이다.

## 먼저 발견한 문제 — edit 후 remembered range가 사라짐

Phase 1의 `recordRecentWork`는 동일 파일을 다시 기록할 때 새 entry로 교체한다.

파일 read에서는:

```text
path
hash
start
end
```

가 저장된다.

그러나 이후 patch/create는 line range를 전달하지 않는다.

따라서 기존 구현에서는:

```text
read file lines 100-160
→ recentFiles entry has start/end

patch same file
→ recentFiles entry replaced
→ start/end lost
```

가 발생할 수 있었다.

이 상태에서는 hydration 기능을 추가해도 실제 수정 직후 hydrate할 범위를 잃는다.

## Range preservation

`recordRecentWork`에서 entry를 atomic mutator 바깥에서 미리 생성하던 구조를 바꿨다.

이제 최신 workContext를 읽은 뒤 같은 path의 이전 entry를 찾는다.

```text
previousForPath = recentFiles.find(path)
```

그리고 새 action에 explicit start/end가 없으면 이전 범위를 이어받는다.

```text
new start provided
  → new start
else previous start exists
  → preserve previous start

new end provided
  → new end
else previous end exists
  → preserve previous end
```

따라서:

```text
read 100-160
→ patch
→ verify
→ resume
```

후에도 마지막으로 읽었던 100-160 범위를 기억한다.

이 변경은 Phase 4A의 atomic update 안에서 수행되므로 concurrent update 시에도 최신 entry를 기준으로 merge한다.

## session_resume 확장

새 입력:

```text
includeActiveSlice?: boolean
maxActiveSliceLines?: 1..300
```

기본 최대 line 수:

```text
160
```

이다.

기존 호출은 `includeActiveSlice`를 주지 않으면 기존 metadata-only 동작을 그대로 유지한다.

## Hydration flow

`session_resume`은 먼저 기존대로 모든 recent file의 현재 SHA-256을 확인한다.

그 후 active artifact를 찾는다.

```text
activeArtifact
→ matching recent file
```

`includeActiveSlice=true`일 때 다음 조건을 확인한다.

```text
active entry exists?
file still exists?
remembered start/end exists?
```

가능하면:

```text
resolveInProject
→ guardSecretPath
→ readSlice(current disk)
→ redact(content)
→ response.activeSlice
```

를 수행한다.

## activeSlice 반환 구조

```text
path
start
end
rememberedStart
rememberedEnd
content
staleAtResume
currentHash
truncated
```

### rememberedStart / rememberedEnd

과거 작업에서 기억한 원래 범위다.

### start / end

이번 호출에서 실제 hydrate한 범위다.

line cap 때문에 더 짧을 수 있다.

### staleAtResume

저장된 file hash와 현재 disk hash가 다른지 나타낸다.

중요한 점은 stale이어도 hydration content 자체는 **현재 디스크에서 fresh read한 내용**이라는 것이다.

### truncated

remembered range가 maxActiveSliceLines보다 길어 잘렸는지 알려준다.

## stale 파일 처리

기존 Phase 1에서는 stale=true이면 "다시 읽어야 한다"고만 알려줬다.

Phase 6에서는 hydration을 요청했다면 이미 다시 읽는다.

예:

```text
stored hash = A
VS Code external edit
current hash = B

session_resume(includeActiveSlice=true)
```

결과:

```text
activeArtifactStale = true
activeSlice.staleAtResume = true
activeSlice.content = B의 현재 내용
```

따라서 모델은 stale 사실을 알고 있으면서도 별도의 `file_read_slice` 호출 없이 현재 코드를 바로 볼 수 있다.

단 stale 상태에서 patch를 적용할 때는 여전히 현재 파일을 기준으로 hash/precondition 등 기존 mutation safety를 따라야 한다.

## Hydration 실패 이유

hydration을 요청했지만 불가능한 경우 `activeSliceReason`을 반환한다.

현재 대표 값:

```text
active-artifact-not-in-recent-files
active-artifact-missing
no-remembered-line-range
```

이 경우 agent는 narrow read/search로 fallback할 수 있다.

## 보안 경계

`session_resume`가 source를 반환하게 되었기 때문에 기존 file read와 동일한 보안 검사를 다시 적용했다.

```text
resolveInProject(allowSymlink=false)
guardSecretPath
redact
```

즉 hydration은 별도의 우회 read path가 아니다.

## Actions/OpenAPI

`SessionResumeInput`에도 다음 필드를 노출했다.

```text
includeActiveSlice
maxActiveSliceLines
```

기존 operation을 확장한 것이므로 Phase 4B에서 지킨 Actions 30-operation 상한에는 영향을 주지 않는다.

OpenAPI test에서 두 property가 실제 schema에 존재하는 것도 확인했다.

## Agent guide 변경

follow-up recent work에서는 기본적으로:

```text
project_select
→ session_resume(includeActiveSlice=true)
```

를 먼저 사용하도록 안내를 바꿨다.

`activeSlice`가 있으면 그것을 바로 현재 코드 context로 사용할 수 있다.

없을 때만:

```text
narrow file_read_slice
or
code_search
```

로 fallback한다.

## 통합 테스트

8줄짜리 `hydration.html`을 만들었다.

### Step 1 — remembered range 생성

```text
file_read_slice
start = 2
end   = 5
```

### Step 2 — 같은 파일 overwrite

`file_create(overwrite=true)`로 전체 내용을 `edited-*`로 바꿨다.

새 mutation에는 line range가 없지만 Phase 6 range-preservation 로직 때문에 recent entry의 2~5가 유지되어야 한다.

### Step 3 — one-call hydration

```text
session_resume(includeActiveSlice=true)
```

검증:

```text
recent start/end = 2..5
activeSlice start/end = 2..5
stale = false
content contains edited-2 ... edited-5
```

을 확인했다.

### Step 4 — 외부 수정

테스트 코드에서 MCP 밖의 `fs.writeFile`로 내용을 `external-*`로 변경했다.

### Step 5 — stale + line cap hydration

```text
session_resume(
  includeActiveSlice=true,
  maxActiveSliceLines=2
)
```

검증:

```text
activeArtifactStale = true
activeSlice.staleAtResume = true
remembered range = 2..5
actual hydrated range = 2..3
truncated = true
content contains external-2, external-3
content does not contain external-4
```

즉 stale detection, fresh disk read, range preservation, line cap이 한 테스트에서 함께 검증됐다.

## 검증 결과

### Typecheck

```text
npm run typecheck
PASS
```

### Targeted

```text
3 test files passed
56 tests passed
0 failed
```

세부:

```text
store.test.ts        17
tools-catalog.test   11
http-actions.test    28
```

### Build

```text
npm run build
PASS
```

### Full regression

```text
423 tests

404 passed
16 failed
3 skipped
```

Phase 5 실행에서는 17개 platform failure가 남았지만 이번 실행에서는 기존 실패 중 하나가 통과해 16개가 남았다.

Phase 6와 관련된 새 failure는 확인되지 않았다. 남은 실패는 이전부터 존재한 Windows/macOS control, POSIX permission, symlink, E2E platform 계열이다.

## Before / After

### Before

```text
"아까 HTML 이미지 부분 계속 수정해"
  ↓
session_resume
  ↓
path/range 확인
  ↓
file_read_slice
  ↓
내용 확인
  ↓
patch
```

### After

```text
"아까 HTML 이미지 부분 계속 수정해"
  ↓
session_resume(includeActiveSlice=true)
  ↓
path + hash + task + diff + verification + current code range
  ↓
patch
```

한 번의 inspect round-trip을 제거한다.

## 현재 한계

### 1. remembered range가 있어야 한다

파일을 생성만 하고 한번도 range read하지 않았다면 hydrate할 line 범위가 없다.

### 2. edit로 line 위치가 크게 이동할 수 있다

기존 100~160줄을 읽은 뒤 파일 앞부분에 수백 줄이 삽입되면 기억된 line number가 의미상 같은 코드 위치를 가리킨다는 보장은 없다.

향후 symbol/anchor 기반 working-set memory가 개선 후보가 될 수 있다.

### 3. 한 번에 active artifact 하나만 hydrate

현재 fast path는 가장 최근 active artifact의 remembered range만 반환한다.

여러 파일을 동시에 수정하는 task에서는 추가 reads가 필요할 수 있다.

### 4. hydration은 read optimization이지 mutation bypass가 아니다

fresh source가 반환되더라도 write lease, hash precondition, secret guard, checkpoint 정책은 그대로 유지한다.

## 다음 단계 — Phase 7

Phase 6 이후 남는 일반적인 fresh-chat resume 흐름은:

```text
work_session_list(hint)
→ project_select(workSessionId)
→ session_resume(includeActiveSlice=true)
```

이다.

Phase 7에서는 **Select & Resume Fusion**을 검토한다.

목표는 사용자가 과거 project/task를 이어갈 때 project selection, session candidate resolution, context hydration을 가능한 한 한 호출에 합치는 것이다.

단 잘못된 workSession을 자동 선택하면 빠르지만 위험해지므로 lexical hint가 실제 goal/task/artifact와 매칭되는 경우에만 자동 resolve하고 애매하면 후보만 제시하는 안전 기준이 필요하다.

---

# Phase 7 — Select & Resume Fusion

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 6까지 workSessionId를 모르는 새 대화의 follow-up은 보통 다음 세 호출이 필요했다.

```text
work_session_list(hint)
→ project_select(workSessionId)
→ session_resume(includeActiveSlice=true)
```

사용자가 이미 project와 작업 힌트를 충분히 주는 경우에는 이 orchestration 자체가 다시 지연이 된다.

## 목표

`project_select` 한 호출에서 다음을 가능한 범위까지 합친다.

```text
lease 확보
+ work-session candidate ranking
+ confidence 판단
+ workSessionId resolve
+ hash validation
+ task / mutation / verification 복원
+ active source range hydration
```

새 입력:

```text
resumeHint
includeResumeContext
includeResumeSlice
maxResumeSliceLines
```

## 공통 resume snapshot 추출

`session_resume`의 hash/stale/hydration 로직을 복제하지 않고 `buildResumeSnapshot()`으로 추출했다.

이 helper를 `session_resume`와 fused `project_select`가 함께 사용한다.

또 Phase 5의 candidate scoring도 `rankWorkSessions()`로 공통화했다.

따라서 list/select/resume가 서로 다른 판단 규칙으로 drift하지 않는다.

## 자동 선택 안전 기준

최근성만 높다고 자동 선택하지 않는다.

상위 candidate가 반드시 다음 중 실제 lexical hint match를 가져야 한다.

```text
full-hint-match
hint-token-match
```

match가 없으면:

```text
autoResumeReason = no-hint-match
```

로 자동 선택하지 않는다.

## Ambiguity gate

상위 두 candidate 모두 hint match이고 점수 차이가 15 미만이면 자동 선택을 중단한다.

```text
topScore - secondScore < 15
→ autoResumeApplied = false
→ autoResumeAmbiguous = true
→ autoResumeReason = top-candidates-too-close
```

15는 Phase 5 scoring에서 token match 한 개가 +15인 scale에 맞춘 보수적 margin이다.

즉 잘못된 작업을 빠르게 여는 것보다 애매한 경우 한 번 더 판단하는 쪽을 선택했다.

## 반환 구조

`project_select`에 다음 정보가 추가되었다.

```text
workSessionId
autoResumeApplied
autoResumeAmbiguous
autoResumeReason
resumeCandidates
resumeContext
```

`resumeContext`는 Phase 6와 같은 validated/hydrated snapshot이다.

explicit workSessionId가 있으면 ranking을 건너뛰고 해당 ID를 사용한다.

## Agent guide 변경

known project + unknown workSession follow-up에서는 우선:

```text
project_select(
  resumeHint=<follow-up hint>,
  includeResumeContext=true,
  includeResumeSlice=true
)
```

를 사용하도록 변경했다.

애매하면 `resumeCandidates`를 비교한 뒤 explicit workSessionId로 재시도한다.

`work_session_list`는 active project를 변경하지 않는 read-only lookup이 필요할 때 유지한다.

## Actions/OpenAPI

기존 `ProjectSelectInput`을 확장했기 때문에 operation 수는 늘지 않는다.

OpenAPI와 MCP catalog test에서 다음 필드 노출을 확인했다.

```text
resumeHint
includeResumeContext
includeResumeSlice
maxResumeSliceLines
```

## 테스트 — confident fused resume

같은 project 안의 Alpha/Beta work session에서:

```text
resumeHint = "beta harness"
```

로 `project_select`를 호출했다.

결과:

```text
workSessionId = betaId
autoResumeApplied = true
autoResumeAmbiguous = false
autoResumeReason = confident-hint-match

resumeContext.activeArtifact = beta.html
resumeContext.activeArtifactStale = false
resumeContext.taskState.currentGoal = Refactor beta harness code
resumeContext.taskState.currentTask = run beta tests
resumeContext.activeSlice = beta의 현재 디스크 내용
```

을 확인했다.

즉 list/select/resume/slice를 따로 호출하지 않고 선택 호출 하나로 작업 context를 얻었다.

## 테스트 — ambiguity rejection

두 goal:

```text
Shared dashboard alpha task
Shared dashboard beta task
```

에 `resumeHint="shared dashboard"`를 사용했다.

두 후보가 거의 같은 점수로 full match되어:

```text
workSessionId = null
autoResumeApplied = false
autoResumeAmbiguous = true
autoResumeReason = top-candidates-too-close
resumeContext = null
resumeCandidates.length = 2
```

가 반환되는 것을 검증했다.

## 검증

```text
npm run typecheck
PASS

targeted
57 / 57 PASS

npm run build
PASS

full suite
424 tests
405 passed
16 failed
3 skipped
```

남은 16개는 기존 Windows/macOS control, POSIX permission, symlink, E2E platform 계열이다.

## Before / After

### Before

```text
fresh chat follow-up
→ work_session_list
→ project_select
→ session_resume + hydration
→ edit
```

### After — confident match

```text
fresh chat follow-up
→ project_select(resumeHint + fused hydration)
→ edit
```

inspect/orchestration 왕복을 최대 두 번 줄인다.

## 남은 위험

- lexical heuristic이라 의미는 같지만 단어가 크게 다르면 auto-resume하지 않을 수 있다.
- projectId 자체가 불명확하면 project discovery가 여전히 먼저 필요하다.
- `project_select`는 실제 active lease를 변경하므로 후보 조회만 원할 때는 `work_session_list`가 적절하다.
- 15점 ambiguity margin은 실사용 로그가 쌓이면 조정할 수 있는 heuristic이다.

## 다음 단계 — Phase 8

이제 tool round-trip뿐 아니라 resume 내부 I/O를 줄인다.

현재 `buildResumeSnapshot`은 최대 20개의 recent file에 대해 full SHA-256을 순차적으로 계산한다.

```text
for recent file:
  await full-file sha256
```

strict hash validation과 결과 순서는 유지하면서 bounded parallel hashing으로 wall-clock latency를 줄이는 방향으로 진행한다.

---

# Phase 8 — Bounded Parallel Resume Hash Validation

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

`buildResumeSnapshot()`은 최대 20개의 recent file을 순차적으로 full SHA-256 검증했다.

```text
file 1 hash 완료
→ file 2 hash 완료
→ ...
→ file 20 hash 완료
```

파일이 크거나 디스크 응답이 느리면 resume wall-clock latency가 각 파일 I/O의 합에 가까워질 수 있다.

## 설계 결정

strict full-file hash validation 자체는 제거하지 않았다.

대신 bounded concurrency를 도입했다.

```text
RESUME_HASH_CONCURRENCY = 4
```

무제한 `Promise.all`을 사용하지 않은 이유는 large working set에서 동시에 모든 파일을 읽어 디스크 압력을 과도하게 높이지 않기 위해서다.

## 구현

generic helper:

```text
mapWithConcurrency(items, concurrency, mapper)
```

를 추가했다.

worker가 shared next-index를 하나씩 가져가 처리하고 결과는 원래 index 위치에 저장한다.

따라서 실제 completion 순서와 관계없이 반환 배열 순서는 기존 recent-file 순서를 유지한다.

`buildResumeSnapshot()`은 이제:

```text
recentFiles
→ max 4 concurrent full-file hashes
→ ordered ResumeFileState[]
```

로 동작한다.

## 테스트

6개 파일을 순서대로 읽어 recent-file order를 만들었다.

```text
read 1 → 2 → 3 → 4 → 5 → 6
```

LRU order 예상:

```text
6, 5, 4, 3, 2, 1
```

그 뒤 3번 파일만 MCP 밖에서 수정해 stale 상태를 만들었다.

resume 결과에서 다음을 검증했다.

```text
returned order = 6,5,4,3,2,1
file 3 stale = true
others stale = false
all files exists = true
all currentHash values present
```

즉 병렬 completion timing이 결과 순서나 stale 판정을 바꾸지 않는다.

## 검증 결과

```text
npm run typecheck
PASS

targeted
58 / 58 PASS

npm run build
PASS

full suite
425 tests
406 passed
16 failed
3 skipped
```

남은 실패는 기존 플랫폼 계열이며 Phase 8 관련 새 regression은 없다.

## Before / After

### Before

```text
20 recent files
→ 20 full-file hash reads serial
```

### After

```text
20 recent files
→ max 4 full-file hash reads concurrently
→ output order preserved
```

## 남은 한계

Phase 8은 hash I/O를 병렬화했지만 fast follow-up에서 항상 recent file 20개 전체를 검증해야 하는지는 별도 문제다.

사용자가 당장 수정할 대상이 active artifact 하나라면 다른 19개 full hash는 현재 turn의 첫 patch 전에 필요하지 않을 수 있다.

## 다음 단계 — Phase 9

**Active-first / Lazy Recent Validation**을 검토한다.

fast resume에서는 active artifact를 strict하게 먼저 검증하고 hydrate하고, 나머지 recent file은 metadata로 반환하거나 caller가 full validation을 명시적으로 요청할 때 검증하는 방식으로 I/O를 더 줄인다.

---

# Phase 9 — Active-first / Lazy Recent Validation

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 8에서 hash를 최대 4개씩 병렬화했지만 fast follow-up에서도 최대 20개 파일을 모두 full SHA-256 하는 사실은 그대로였다.

사용자가 지금 수정할 대상이 active artifact 하나라면 나머지 recent file은 첫 patch 전에 반드시 검증할 필요가 없다.

## 설계

두 validation mode를 도입했다.

```text
recent
  → remembered recent file 전체 검증

active
  → active artifact만 full hash 검증
  → 나머지는 metadata만 반환
```

기존 `session_resume` 기본값은 `recent`로 유지하여 하위 호환을 지켰다.

Phase 7 fused `project_select`의 fast path 기본값만 `active`로 설정했다.

## 미검증 상태를 명시적으로 표현

가장 중요한 안전 조건은 **검사하지 않은 파일을 unchanged로 표시하지 않는 것**이다.

`ResumeFileState`에:

```text
validated
```

를 추가했다.

active-only mode에서 일반 recent file은:

```text
validated = false
currentHash = null
exists = null
stale = null
```

이다.

즉:

```text
stale = false
  → 실제 검증했고 동일

stale = null + validated=false
  → 아직 검사하지 않음
```

을 구분한다.

## ResumeSnapshot metadata

다음도 반환한다.

```text
validationScope
validatedRecentFileCount
```

fast fused resume에서 recent file 6개 중 active 하나만 검사했다면:

```text
validationScope = active
validatedRecentFileCount = 1
```

이다.

## public inputs

`session_resume`:

```text
validationScope = active | recent
```

`project_select` fused resume:

```text
resumeValidationScope = active | recent
```

fused path 기본은 `active`, standalone session_resume 기본은 `recent`이다.

## Agent rule

active-only fast resume 후 다음 변경이 여러 remembered file의 상호 일관성에 의존한다면:

```text
resumeValidationScope=recent
or
session_resume(validationScope=recent)
```

로 전체 검증하도록 안내했다.

또 `validated=false`인 파일을 unchanged로 취급하지 않도록 명시했다.

## 테스트

6개 recent file working set을 만든 뒤 3번 파일만 외부 수정했다.

active artifact는 6번 파일이었다.

### active-only resume

```text
validationScope = active
validatedRecentFileCount = 1

file 6:
  validated=true
  stale=false

file 3:
  validated=false
  stale=null
  exists=null
  currentHash=null
```

을 확인했다.

### default full resume

같은 상태에서 옵션 없이 다시 `session_resume`을 호출했다.

```text
validationScope = recent
validatedRecentFileCount = 6
file 3 stale=true
others stale=false
```

로 기존 strict behavior가 유지됨을 확인했다.

fused Beta resume도 기본:

```text
validationScope = active
validatedRecentFileCount = 1
```

임을 검증했다.

## 검증 결과

```text
npm run typecheck
PASS

targeted
58 / 58 PASS

npm run build
PASS

full suite
425 tests
406 passed
16 failed
3 skipped
```

기존 platform 계열 실패 외 새 regression은 없다.

## Before / After

### Before

```text
fast resume
→ up to 20 full SHA-256
→ hydrate active
```

### After

```text
fast fused resume
→ 1 active full SHA-256
→ hydrate active
→ other recent metadata remains explicitly unvalidated
```

필요할 때만 full recent validation으로 승격한다.

## 다음 단계 — Phase 10

Phase 6~9의 fast resume은 active file의 **현재 full SHA-256**까지 이미 계산한다.

이 값을 단순 상태 표시로 끝내지 않고 바로 다음 `file_apply_patch.preconditionHashes`에 넘길 수 있다.

즉:

```text
resume + fresh source + current hash
→ CAS-style patch
```

로 연결하여 추가 read 없이도 안전한 resume-to-edit handoff를 만드는 것이 다음 단계다.

---

# Phase 10 — Resume-to-Patch CAS Safety Handoff

**구현일:** 2026-08-08  
**상태:** 완료

## 문제

Phase 6~9에서 fast resume은 이미 다음 두 정보를 같은 시점에 얻는다.

```text
activeSlice = 현재 디스크의 source
currentHash = 현재 파일 전체 SHA-256
```

하지만 다음 patch에서 모델이 별도 read를 다시 하거나 currentHash를 직접 찾아 mapping해야 했다.

## 목표

resume 결과를 다음 write의 optimistic concurrency token으로 바로 사용할 수 있게 한다.

```text
resume
→ fresh source + full SHA-256
→ file_apply_patch(preconditionHashes)
```

## 구현

`ResumeSnapshot`에 다음을 추가했다.

```text
activePatchPreconditionHashes
```

형태는 `file_apply_patch` 입력과 동일하다.

```text
{
  "path/to/file": "<64-char full SHA-256>"
}
```

다음 조건에서만 생성한다.

```text
active file validated = true
file exists = true
current full hash exists
```

그 외에는 `null`이다.

중요한 점은 stored old hash가 아니라 **resume 순간 계산한 current full-file hash**를 반환한다는 것이다.

따라서 `activeArtifactStale=true`여도 fresh hydration과 current hash가 함께 있다면 그 현재 상태에 대한 안전한 CAS token을 제공할 수 있다.

## Agent guide 변경

resume 또는 fused resume에서 source slice와 `activePatchPreconditionHashes`가 같이 반환되면 다음 patch에 객체를 그대로 전달하도록 안내했다.

```text
file_apply_patch(
  patch=...,
  preconditionHashes=resume.activePatchPreconditionHashes
)
```

`HASH_MISMATCH`가 발생하면 patch를 강제로 재시도하지 않고 다시 resume/read하도록 한다.

## 통합 테스트 — 성공 경로

`hydration.html`을 MCP 외부에서 수정해 stored snapshot을 stale하게 만들었다.

그 후:

```text
session_resume(includeActiveSlice=true)
```

결과에서:

```text
activeArtifactStale = true
activeSlice = external-* 현재 내용
activePatchPreconditionHashes[hydration.html] = 64-char SHA-256
```

을 확인했다.

이 hash 객체를 그대로 `/actions/file-apply-patch`의 `preconditionHashes`에 전달했다.

```text
external-2
→ cas-patched-2
```

patch가 성공하고 실제 파일이 변경되는 것을 확인했다.

즉 stale 과거 snapshot에서 시작했더라도 resume이 fresh source/hash를 생성한 뒤에는 추가 read 없이 현재 상태를 기준으로 안전하게 수정할 수 있다.

## 통합 테스트 — race rejection

성공한 patch 뒤 다시 resume하여 새로운 current hash를 받았다.

그 직후 테스트에서 MCP 밖의 `fs.writeFile`로 파일을 다시 변경했다.

그리고 **변경 전 resume hash**를 precondition으로 재사용하여 patch를 시도했다.

결과:

```text
ok = false
code = HASH_MISMATCH
```

를 확인했다.

실제 파일에도 `should-not-apply` 내용이 들어가지 않았다.

즉 다음 race를 막는다.

```text
resume current state A
→ user/editor changes file to B
→ model tries patch based on A
→ HASH_MISMATCH
→ patch rejected
```

## 검증 결과

```text
npm run typecheck
PASS

targeted
58 / 58 PASS

npm run build
PASS

full suite
425 tests
406 passed
16 failed
3 skipped
```

남은 16개는 기존 Windows/macOS platform/control/permission/symlink 계열이다.

## Before / After

### Before

```text
resume + source
→ optional extra read/hash handling
→ patch
```

### After

```text
resume
→ source + activePatchPreconditionHashes
→ CAS patch
```

fast path의 속도를 유지하면서 resume 이후 외부 파일 변경에 대한 안전 장치를 강화했다.

## 현재 한계

- 하나의 active artifact에 대한 convenience precondition이다. multi-file patch는 각 대상 파일을 검증한 hash map이 필요하다.
- hash는 resume 시점 snapshot이므로 오래 들고 있으면 당연히 mismatch 가능성이 커진다. mismatch는 오류가 아니라 안전한 재검증 신호다.
- hydration된 line range가 patch에 충분하지 않으면 narrow read는 여전히 필요하다.

## 다음 개선 후보

이 시점부터는 같은 방식으로 기능을 계속 추가하기보다 실제 사용 로그에서 병목을 확인한 뒤 선택하는 편이 좋다.

후보:

```text
1. stale line-range를 symbol/anchor로 재배치하는 range relocation
2. multi-file resume hydration + multi-file precondition map
3. work-session lifecycle을 goal/checkpoint 파일까지 함께 정리하는 GC
4. resume/select 단계별 timing telemetry
5. cross-process session locking 또는 SQLite session store
```

특히 다음 실제 포트폴리오/HTML 작업에서 tool call 수와 resume latency를 계측하면 Phase 1~10 개선의 체감 효과를 수치화할 수 있다.

# Phase 11 — Windows Development Runtime Auto-Sync

## 문제

Phase 1~10 구현 후 source root에서 `npm run build`까지 성공했지만, Windows GUI를 재시작해도 새 MCP tool schema가 보이지 않았다.

실행 중인 프로세스를 확인한 결과 실제 runtime은 source root의 `dist/cli.js`가 아니라 다음 generated package를 사용하고 있었다.

```text
source checkout
  dist/cli.js                       <- 최신

build/windows/chatgpt2codex/
  chatgpt2codex.exe
  start-chatgpt.ps1
  dist/cli.js                       <- 이전 package 시점 복사본
```

즉 개발 중에는 두 개의 dist가 존재했고, TypeScript build와 Windows package build가 분리되어 있었다.

## 기존 동작

```text
src 수정
→ npm run build
→ source/dist 갱신
→ Windows EXE 재시작
→ build/windows/.../dist 실행
→ 구버전 MCP
```

최신 source를 실제 GUI runtime에서 사용하려면 Windows package를 다시 만들거나 generated dist를 수동 복사해야 했다.

이는 빠른 harness 반복 개발에 불필요한 packaging step을 추가한다.

## 설계 결정

배포 package와 개발 package의 의미를 섞지 않기 위해 **정확한 repository development layout에서만 source checkout으로 위임**한다.

개발 package로 인정하는 조건:

```text
runtime path == <sourceRoot>/build/windows/chatgpt2codex
AND <sourceRoot>/start-chatgpt.ps1 exists
AND <sourceRoot>/src exists
AND <sourceRoot>/package.json exists
```

일반 설치 폴더나 압축 해제 release에서는 이 조건이 성립하지 않으므로 bundled dist를 그대로 사용한다.

## 구현

### 1. packaged launcher -> source launcher delegation

`start-chatgpt.ps1`에 `Resolve-DevelopmentSourceRoot()`를 추가했다.

generated development package에서 실행되면:

```text
build/windows/chatgpt2codex/start-chatgpt.ps1
→ repository source root 감지
→ packaged bin을 PATH 앞에 보존
→ sourceRoot/start-chatgpt.ps1 호출
```

한다.

중요한 점은 source launcher를 **새 process로 띄우지 않고 같은 PowerShell process에서 호출**한다는 것이다.

따라서 기존 launcher lifecycle과 현재 PID 기반 stale-process 보호가 유지된다.

### 2. source가 dist보다 새로우면 자동 build

기존 launcher는 `dist/cli.js`가 아예 없을 때만 build했다.

Phase 11에서는 `Test-SourceBuildRequired()`를 추가해 다음을 감시한다.

```text
src/**
package.json
package-lock.json
tsconfig.json
```

이 중 하나라도 `dist/cli.js`보다 새로우면 시작 전에:

```text
npm run build
```

를 자동 실행한다.

따라서 개발 루프는 다음처럼 바뀐다.

```text
src 수정
→ Windows 앱 Restart MCP
→ source checkout 자동 감지
→ stale dist 자동 build
→ source/dist/cli.js 실행
```

Windows EXE 자체를 다시 컴파일하거나 portable package 전체를 다시 만들 필요가 없다.

### 3. bundled dependency fallback 유지

development package에는 bundled runtime dependency가 들어 있었다.

source launcher로 위임하기 전에 generated runtime의 `bin`을 PATH에 prepend하여, 개발 PC에 global runtime dependency가 없어도 기존 bundled dependency를 계속 사용할 수 있게 했다.

### 4. generated launcher one-time sync

현재 실행 중인 Windows EXE는 인접한 generated `start-chatgpt.ps1`을 호출하므로 이번 변경을 활성화하기 위해 source launcher를:

```text
build/windows/chatgpt2codex/start-chatgpt.ps1
```

에 한 번 동기화했다.

두 파일의 SHA-256이 동일한 것도 확인했다.

이 bootstrap이 한번 들어간 이후에는 generated launcher가 source launcher로 위임하므로 launcher 수정 때문에 매번 package를 다시 만들 필요가 없다.

## 테스트 추가

새 파일:

```text
scripts/test-windows-dev-launcher.ps1
```

검증 항목:

1. `start-chatgpt.ps1` PowerShell parser error 없음
2. repository의 `build/windows/chatgpt2codex`가 정확히 source root로 resolve됨
3. unrelated runtime 경로는 development source로 오인하지 않음
4. dist가 source보다 최신이면 rebuild 불필요
5. source가 dist보다 최신이면 rebuild 필요
6. dist가 없으면 rebuild 필요
7. generated launcher가 존재할 경우 source launcher와 SHA-256이 동일한지 확인

package script:

```text
npm run windows:launcher:test
```

## 구현 중 테스트 시행착오

처음 helper function만 안전하게 실행하기 위해 PowerShell AST의 `Find()`를 3개 인자로 호출했으나 현재 PowerShell API에는 해당 overload가 없어 테스트 command가 실패했다.

코드 문제가 아니라 테스트 harness 문제였으며 `FindAll()`로 모든 `FunctionDefinitionAst`를 가져온 뒤 이름으로 선택하는 방식으로 수정했다.

수정 후 exact helper implementation을 source script에서 추출하여 temp fixture에 실행했고 통과했다.

## Before / After

### Before

```text
source edit
→ npm run build
→ Windows package rebuild/copy
→ restart
```

### After

```text
source edit
→ restart MCP
→ dev source auto-detect
→ stale build auto-detect
→ npm run build when needed
→ latest source runtime
```

## 안전 경계

- source delegation은 정확한 `build/windows/chatgpt2codex` layout에서만 활성화한다.
- 일반 release/install package는 bundled dist를 계속 사용한다.
- 자동 build는 source checkout에서만 의미가 있으며 release package에 `src`가 없으면 stale-source scan을 하지 않는다.
- 현재 연결된 MCP는 구현/검증 중 강제로 종료하지 않았다. 다음 사용자가 Restart MCP를 수행할 때 새 bootstrap 경로가 처음 적용된다.

# Phase 12 — Public Positioning and Repository Release Hygiene

Date: 2026-08-08  
Status: implemented and prepared for GitHub publication

## 목표

Phase 1~11에서 만든 harness 기능을 README 첫 화면에서 이해할 수 있게 정리하고,
프로젝트의 차별점을 과장 없이 설명한 뒤 의미 있는 소스/문서/테스트만 GitHub에 게시한다.

## 포지셔닝 결정

`tokenless agent`라는 표현은 사용하지 않는다. ChatGPT 자체의 모델 추론에는 여전히
모델 사용량과 플랜 제한이 존재하기 때문이다.

대신 README에서 다음 구조를 명시한다.

```text
ChatGPT = reasoning engine
chatgpt2codex = local execution harness
```

즉 chatgpt2codex 자체는 별도 LLM provider API를 호출하지 않으며, 로컬 실행 기능을
붙이기 위해 별도의 OpenAI/Anthropic/Gemini API key나 추가 per-token API billing
경로를 요구하지 않는다.

## README에 추가한 내용

- typical coding-agent runtime과 ChatGPT To Codex 구조 비교
- 별도 LLM API client를 내장하지 않는다는 점
- ChatGPT 모델 사용량 자체는 존재한다는 정확성 문구
- ChatGPT 전체 대화 기록을 로컬 runtime이 임의로 읽지 않는다는 경계
- project/work-session scoped persistent state
- goal/current task/completed/pending/decisions
- fast resume + source hydration
- SHA-256 CAS-style patch handoff
- bounded-parallel validation / lazy validation / session isolation
- Windows development runtime auto-sync
- 상세 구현 과정은 이 HARNESS_DEVLOG로 연결

## Repository hygiene

커밋 대상은 실제 제품 소스, 테스트, 문서 및 실행에 필요한 새 파일로 제한한다.

다음과 같은 작업 중간 산출물은 GitHub 커밋에서 제외한다.

```text
*.before-windows-e2e
WINDOWS-E2E-PATCH-README.txt
apply-windows-e2e-patch.cmd
restore-windows-e2e-patch.cmd
patch-chatgpt2codex-windows-e2e.mjs
```

반면 `src/e2e/cdp-websocket.ts`는 실제 Windows E2E 구현이 import하는 제품 코드이므로
반드시 함께 게시해야 한다.

## Pre-push verification

```text
npm run typecheck
PASS

npm run build
PASS

npm run windows:launcher:test
PASS

npx vitest run src/state/store.test.ts src/server/http-actions.test.ts src/server/tools-catalog.test.ts
58 / 58 PASS
```

전체 suite에는 기존 Windows/macOS platform-specific 실패군이 별도로 존재하며,
이번 harness targeted suite에서는 새 regression이 확인되지 않았다.

# Phase 13 — Upstream Attribution / License / OpenAI Compliance Review

## 왜 이 검토를 추가했는가

Phase 1~12의 harness 개선을 GitHub에 공개한 뒤, 현재 저장소가 원본
`ezBuilder/chatgpt2codex`를 기반으로 한 modified fork라는 사실과 새로 추가한
작업의 경계를 README에서 더 명확히 보여줄 필요가 생겼다.

단순 출처 표기만으로 끝낼 수 없는 이유도 확인했다. 2026-08-08 기준 upstream에는
root `LICENSE`가 확인되지 않았고 `package.json`에는 다음 저작권 표기가 있다.

```text
Copyright 2026 ezBuilder. All rights reserved.
```

따라서 GitHub 안에서 public repository를 fork할 수 있다는 것과, upstream 코드를
독립적으로 재배포·재라이선스·상업화할 수 있는 소프트웨어 라이선스를 받았다는 것은
구분해야 한다.

## 적용한 attribution 경계

README에 다음을 명시했다.

- 원본 프로젝트와 base runtime의 저자: `ezBuilder`
- upstream: `https://github.com/ezBuilder/chatgpt2codex`
- 현재 저장소는 modified fork
- 이 fork에서 추가한 persistent work session / semantic task state / fast resume /
  CAS patch / Windows E2E / dev auto-sync 등은 별도 follow-on engineering
- attribution 자체는 upstream code의 소유권이나 재배포 라이선스를 만들지 않음

상세 검토는 `docs/ATTRIBUTION_AND_COMPLIANCE.md`에 분리했다.

## OpenAI 약관/브랜드 검토

OpenAI의 현재 App Developer Terms는 custom apps, connectors, actions, MCP servers를
명시적으로 다룬다. 따라서 user-authorized MCP/Actions local execution server라는
기술 패턴 자체는 약관이 예상하는 integration 범주와 맞닿아 있다.

반면 Terms of Use와 App Developer Terms의 경계를 고려해 다음 표현은 제거하거나
중립화했다.

```text
when Codex quota is unavailable
does not spend Codex quota
wrong quota path
```

대신 다음 의도를 명시한다.

```text
ChatGPT remains the reasoning surface.
chatgpt2codex is a local execution harness.
It is not intended to bypass rate limits, usage limits, or safety restrictions.
```

즉 차별점은 product limit 우회가 아니라 **별도의 embedded LLM client/API billing
layer를 하나 더 두지 않는 architecture**다.

## 이름에 대한 리스크

현재 `ChatGPT To Codex` 이름은 upstream에서 상속됐다. 그러나 OpenAI Brand
Guidelines는 OpenAI/GPT 관련 mark를 product/app/developer 이름에 사용하는 것을
제한하고 endorsement/partnership 오인을 금지한다.

따라서 README와 compliance note에 다음을 명시했다.

```text
Independent / unofficial modified fork.
Not affiliated with, endorsed by, sponsored by, or partnered with OpenAI.
```

그리고 이 disclaimer만으로 naming risk가 완전히 사라진다고 단정하지 않고,
독립 branding·상업 배포 전에는 neutral project name으로 변경하거나 별도 권한을
확인하는 방향을 권고했다.

## 검증

첫 targeted test에서 한 assertion이 과거 문구 `Do not call Codex`를 exact match하고
있어 실패했다. 기능 regression은 아니었고, 새 compliance 문구
`Do not call a separate Codex or OpenAI Images API`를 검증하도록 assertion을 갱신했다.

최종 검증:

```text
npm run typecheck
PASS

npm run build
PASS

npx vitest run src/server/tools-catalog.test.ts src/server/http-actions.test.ts
41 / 41 PASS
```

## 남은 결정

1. ezBuilder에게 derivative redistribution / binary release에 대한 명시적 허가 또는
   upstream license 추가를 요청할지 결정
2. 독립 public branding을 계속할 경우 OpenAI mark를 쓰지 않는 neutral rename 검토
3. terms/brand policy가 변경될 수 있으므로 compliance note의 review date를 유지

이 문서는 법률 의견이 아니라 공개 약관과 repository metadata를 바탕으로 한
engineering/compliance 기록이다.
