<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**ChatGPT가 로컬 프로젝트를 안전하고 검증 가능하게 다룰 수 있게 해주는 로컬 코딩 브리지입니다.**

[English](README.md) | [한국어](README.ko.md)

JK는 [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex)를 기반으로 수정한 독립·비공식 포크입니다. ChatGPT를 로컬 MCP / Actions 런타임과 연결해, 사용자가 선택한 프로젝트 안에서 코드 탐색, 파일 수정, 테스트 실행, Git 작업, E2E 검증과 실행 증거 수집을 수행할 수 있게 합니다.

이 포크는 특히 Windows에서 실제 개발 루프를 이어가기 위한 기능에 초점을 맞췄습니다. 작업 세션 유지, 빠른 resume, 해시 기반 패치 보호, JK 네이티브 오케스트레이션, 선택적 OMO 위임, Windows 브라우저 E2E, 개발/포터블 런타임의 명확한 분리가 핵심입니다.

> **비공식 프로젝트:** JK는 OpenAI와 제휴·후원·승인·공식 파트너 관계가 없습니다. ChatGPT, GPT, Codex 및 기타 OpenAI 상표는 OpenAI에 귀속됩니다.
>
> **라이선스 주의:** 원본 저장소에는 현재 루트 소프트웨어 `LICENSE`가 보이지 않고, 패키지 메타데이터에는 `Copyright 2026 ezBuilder. All rights reserved.`라고 적혀 있습니다. 따라서 JK는 원본 기반 코드를 MIT, Apache 등의 오픈소스 라이선스라고 주장하지 않습니다. 파생 소스나 바이너리를 재배포하기 전 [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)를 확인하세요.

## 지인용 빠른 시작

필요한 것은 **Git, Node.js 22 이상, npm**뿐입니다. JK 공개판은 로컬 MCP 하네스이며 상시 서버·터널·개인 배포 자동화는 포함하지 않습니다.

```powershell
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
npm run chatgpt:windows
```

기본 실행 주소는 `http://127.0.0.1:7979`이고 MCP endpoint는 `http://127.0.0.1:7979/mcp`입니다. 외부 ChatGPT 클라이언트가 로컬 주소에 직접 접근할 수 없다면 HTTPS transport는 사용자가 별도로 준비해야 합니다. 자세한 설치/연결 절차는 [설치 가이드](docs/INSTALL.md)를 참고하세요.

## 30초 사용법

JK는 내부 tool 이름을 외워서 쓰는 것보다 **ChatGPT에 자연어로 목표와 완료 조건을 말하는 방식**이 기본입니다.

```text
@jk 이 프로젝트 구조 뜯어서 설명해줘. 수정은 하지 마.
@jk 이 버그 원인 찾아서 고치고 관련 테스트까지 해줘.
@jk 아까 하던 작업 이어서 마무리해줘.
@jk e2e 테스트하고 데스크톱/모바일 스크린샷 보여줘.
@jk 현재 diff 리뷰하고 문제 없으면 커밋해줘.
@jk 테스트 통과하면 커밋하고 jk-mcp에 푸시해줘.
```

긴 작업은 **프로젝트 + 목표 + 제약 + 검증/마무리 조건** 순으로 말하면 가장 안정적입니다. `goal_loop`, `workSessionId`, lease, 파일 해시 같은 내부 상태는 보통 사용자가 직접 관리할 필요가 없습니다.

실전 패턴, 이어서 작업하는 법, `AGENTS.md` 계층 규칙, E2E, Git, OMO 사용 기준은 [JK 사용 가이드](docs/USAGE.ko.md)를 참고하세요.

## 작동 방식

JK는 두 번째 AI 모델이 아닙니다. 현재 ChatGPT 세션이 추론을 담당하고, JK는 프로젝트 범위가 제한된 로컬 도구, 지속 상태, 안전 게이트, 실행 증거를 제공합니다.

```text
사용자
  -> ChatGPT 웹 세션 (추론 / 계획)
  -> MCP 또는 GPT Actions
  -> JK HTTP 런타임
  -> 공통 tool registry
  -> project lease + safety guard
  -> code / state / shell / Git / E2E
  -> 선택한 로컬 프로젝트
```

`goal_intake`와 `goal_loop`는 현재 ChatGPT 세션 안에서 코딩 루프를 조정합니다. OMO는 별도 로컬 agent runtime을 원하는 경우 사용할 수 있는 선택적 위임 경로이며, 일반적인 JK 네이티브 코딩은 OMO나 두 번째 모델 provider 인증에 의존하지 않습니다.

## JK에서 추가한 핵심 기능

### 1. 지속되는 작업 세션

후속 요청이 들어올 때 매번 저장소를 처음부터 다시 조사하지 않도록 프로젝트 단위·작업 세션 단위 상태를 유지할 수 있습니다.

예를 들어 다음 정보를 기억할 수 있습니다.

- 현재 작업 중인 파일과 최근 접근 파일
- 현재 목표와 작업
- 완료 항목과 남은 항목
- 주요 구현 결정
- 최근 체크포인트와 검증 결과
- 빠른 소스 복원을 위한 라인 범위

`workSessionId`로 같은 저장소 안에서도 서로 다른 작업 흐름을 분리합니다.

### 2. CAS 방식의 안전한 resume / 패치

resume 시 저장된 상태를 그대로 믿지 않고 현재 디스크 상태를 다시 확인합니다.

```text
resume
  -> 현재 파일 검증
  -> 최신 소스 범위 다시 읽기
  -> 현재 전체 파일 SHA-256 반환
  -> 해당 해시를 패치 precondition으로 사용
  -> 중간에 파일이 바뀌었다면 패치 거부
```

대화 사이에 파일이 수정된 경우 이전 문맥으로 덮어쓰는 사고를 줄이는 구조입니다.

### 3. JK 네이티브 오케스트레이션

JK는 기본적으로 현재 ChatGPT 웹 세션 자체에서 오케스트레이션을 수행합니다. 일반적인 코딩 루프에는 별도 모델 provider, API key, 별도 agent runtime이 필요하지 않습니다.

`goal_intake`와 `goal_loop`는 매 턴을 다음 역할 렌즈로 라우팅합니다.

- Explorer: 주장/수정 전에 저장소를 검색하고 읽어 근거 확보
- Oracle: 가정을 반박하고 가장 작은 타당한 전략 선택
- Implementer: 한 번에 하나의 응집된 변경 수행
- Reviewer: 회귀, 보안, 유지보수성, 실제 목표 적합성 검토
- Verifier: 테스트/typecheck/build/E2E 근거가 있어야 완료 처리
- Recovery: 같은 실패를 반복하지 않고 새로운 근거 기반 가설로 전환

검증 실패도 구조적으로 승격됩니다. 첫 실패는 원인과 가정을 재검토하고, 두 번째 실패는 다른 접근으로 전환하며, 세 번 이상 실패하면 Recovery 단계로 들어갑니다.

### 4. 선택적 OMO 위임

JK는 로컬에 설치된 OMO / Oh My OpenAgent CLI에 분석 또는 코딩 작업을 위임할 수 있습니다.

OMO runner는 다음을 수행합니다.

- 설치된 OMO 버전 탐색
- `omo run --help`로 JK에 필요한 플래그 호환성 검사
- 가장 최신의 호환 버전 선택
- 최신 버전이 깨졌다면 설치된 이전 호환 버전으로 자동 fallback
- 프롬프트를 shell 문자열이 아닌 argv로 전달
- agent를 지정하지 않으면 `general`을 기본값으로 사용
- OMO session ID를 회수해 후속 실행에 재사용 가능

현재 JK가 요구하는 OMO 플래그는 다음과 같습니다.

```text
--json
--directory
--agent
--model
--session-id
--verbose
```

OMO는 자체적으로 설정된 모델 provider와 인증을 사용합니다. 따라서 JK와 로컬 OMO CLI가 정상이어도 외부 provider 장애가 있으면 OMO 실행은 실패할 수 있습니다.

### 5. 로컬 MCP / Actions 실행 브리지

연결 후 ChatGPT는 JK를 통해 다음 작업을 수행할 수 있습니다.

- 로컬 프로젝트 탐색 및 선택
- 저장소 규칙 확인
- 코드 검색
- 좁은 범위의 파일 읽기
- 파일 생성 및 보호된 패치 적용
- 프로젝트 명령/테스트 실행
- 제한된 로컬 shell 실행
- Git 상태와 diff 확인
- 사용자가 명시적으로 요청한 경우 commit / push
- 개발 서버 실행
- E2E 테스트
- 지원 환경에서 브라우저/앱 스크린샷 캡처
- 생성 이미지의 프로젝트 저장

전체 구조는 다음과 같습니다.

```text
사용자
  -> ChatGPT
  -> MCP / Actions
  -> JK 로컬 런타임
  -> 파일 / shell / Git / E2E / OMO
```

추론의 중심은 ChatGPT이고, JK는 로컬 실행 계층입니다.

### 6. Windows 중심 개발 흐름

이 포크에는 Windows 관련 개선이 많이 포함되어 있습니다.

- JK 이름을 사용하는 Windows launcher / installer 경로
- 프로젝트 폴더 선택
- Owner Token 승인 흐름
- ChatGPT 웹 connector 지원
- stale process 정리
- Edge / Chrome 기반 로컬 웹 E2E 캡처
- 데스크톱·모바일 viewport 스크린샷 증거
- E2E 과정에서 브라우저 console / 실패 네트워크 요청 수집
- 개발 패키지에서 source checkout으로 자동 동기화

상세 구현 과정은 [docs/HARNESS_DEVLOG.md](docs/HARNESS_DEVLOG.md)에 기록되어 있습니다.

## 로컬 성능 측정

아래 수치는 **2026-08-13** 유지보수자의 Windows 개발 환경에서 JK 로컬 런타임을 실행한 상태로 측정했습니다. 구현 상태를 확인하기 위한 로컬 측정값이며, 다른 PC에서도 동일한 성능을 보장하는 SLA는 아닙니다.

| 작업 | 측정 결과 |
| --- | ---: |
| `goal_intake` 직접 handler | 평균 1.35 ms |
| `goal_loop` 첫 턴 handler | 평균 1.43 ms |
| `goal_loop` 50턴 연속 상태 갱신 | 초반 평균 2.11 ms -> 후반 평균 2.74 ms |
| `file_read_slice` 100줄 + 해시 계산 | 평균 2.32 ms / p95 3.39 ms |
| 저장된 세션 읽기 + 검증 | 평균 0.634 ms / p95 1.045 ms |
| ripgrep 기반 `code_search` | 평균 48.62 ms / p95 60.15 ms |
| 로컬 `gitRepositoryStatus` | 평균 182.18 ms / p95 191.03 ms |
| localhost `/healthz` | 평균 14.20 ms |
| localhost Actions OpenAPI | 평균 15.13 ms |

같은 점검 시점의 Node 런타임은 약 **124 MB working set**, 13 threads였습니다. 실제 작업에서 체감 지연을 만드는 주된 요소는 JK 네이티브 오케스트레이션 자체보다 반복적인 ChatGPT-tool 왕복, child process 시작, Git, typecheck/test/build, 브라우저 E2E입니다.

## 보안 모델

JK는 신뢰할 수 있는 로컬 개발 환경을 대상으로 하며, 임의의 공개 자동화를 목표로 하지 않습니다.

- 파일 접근은 선택한 workspace/project 범위로 제한됩니다.
- 로컬 상태, MCP 설정, 로그, `.env`, 생성 런타임 상태는 Git에서 제외됩니다.
- secret으로 보이는 값은 도구 출력에서 redaction됩니다.
- 기존 파일 수정에는 해시 precondition을 사용할 수 있습니다.
- 네트워크, 파괴적 작업, commit, push 등 민감 작업은 사용자 의도/승인 게이트를 거칩니다.
- 원격 ChatGPT 연결은 Owner Token 승인 모델을 사용합니다.
- 웹 connector/tunnel을 켜지 않으면 기본적으로 로컬/loopback 중심으로 동작합니다.

Owner Token은 비밀번호처럼 취급하세요. Issue, 스크린샷, 로그, 문서에 공개하면 안 됩니다.

## 소스에서 빌드하기

### 요구사항

- Node.js 22 이상
- npm
- Windows에서는 PowerShell
- 선택: ChatGPT 클라이언트가 localhost에 직접 접근할 수 없을 때 사용자가 별도로 관리하는 HTTPS reverse proxy 또는 tunnel
- 선택: `omo_run`을 사용할 경우 호환되는 OMO 설치

공개 저장소의 범위는 MCP 하네스/코어입니다. 상시 클라우드 호스팅, 특정 공급자 provisioning, 개인 도메인, 자동 배포는 공개 배포판에서 의도적으로 분리합니다. 호스트별 개인 동작은 `docs/LOCAL_OVERRIDES.md`의 local override 경계로 추가할 수 있습니다.

### 설치 및 검증

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### Windows 실행

```powershell
npm run chatgpt:windows
```

### macOS / Linux 소스 환경 실행

```bash
npm run chatgpt
```

또는:

```bash
npm run chatgpt:linux
```

기존 설치/런타임 문서는 [docs/INSTALL.md](docs/INSTALL.md), [windows/README.md](windows/README.md)를 참고하세요.

## 주요 검증 명령

```bash
npm run typecheck
npm test
npm run build
```

OMO runner 전용 테스트:

```bash
npx vitest run src/exec/omo-runner.test.ts
```

MCP / Actions 카탈로그 테스트:

```bash
npx vitest run src/server/tools-catalog.test.ts src/server/http-actions.test.ts
```

## 저장소 구조

```text
src/
  auth/       OAuth / Owner Token
  code/       검색, 읽기, 패치
  control/    선택적 데스크톱 제어 안전 계층
  e2e/        로컬 E2E 자동화와 스크린샷 증거
  exec/       command, shell, OMO runner
  server/     MCP tools / Actions bridge
  state/      프로젝트·작업 세션 상태
  workspace/  프로젝트 registry / lease

windows/      Windows launcher / tray / installer
macos/        macOS status-bar 앱
linux/        Linux 실행/설치 경로
scripts/      build, package, 검증 스크립트
docs/         설치, 개발 로그, compliance 문서
assets/       공개 UI / README 리소스
```

## 처음 써볼 프롬프트

기본 저장소 점검:

```text
@jk 내 프로젝트를 선택하고 상태와 규칙을 확인한 뒤,
가장 안전한 관련 검증을 실행하고 근거와 함께 결과를 요약해줘.
```

OMO 위임:

```text
@jk OMO를 사용해서 이 프로젝트를 분석하고 우선순위가 높은 문제부터 정리해줘.
```

화면 검증:

```text
@jk E2E 테스트하고 통과한 화면을 캡처해서 증거까지 보여줘.
```

## 출처와 라이선스

원본 프로젝트와 기본 런타임은 **ezBuilder**가 만들었습니다.

- Upstream: [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex)
- 원본 패키지 메타데이터: `Copyright 2026 ezBuilder. All rights reserved.`

이 포크는 **Anjingyeong/jk-mcp**에서 관리하며, 지속 작업 세션, fast resume, CAS patch handoff, Windows E2E, JK 브랜딩, 개발/포터블 런타임 분리, 선택적 OMO 연동 등 추가 harness engineering을 포함합니다.

현재 확인된 upstream GitHub 저장소에는 루트 소프트웨어 라이선스가 보이지 않습니다. GitHub에서 소스를 볼 수 있거나 fork할 수 있다는 사실을 독립적인 재배포·재라이선스 허가로 해석하면 안 됩니다. JK는 원본과 결합된 코드 전체에 새로운 라이선스를 부여하지 않습니다.

자세한 내용은 [docs/ATTRIBUTION_AND_COMPLIANCE.md](docs/ATTRIBUTION_AND_COMPLIANCE.md)를 확인하세요.

## 상태

JK는 현재 개발 중인 engineering fork입니다. 주된 초점은 소스 레벨 워크플로우입니다. 수정된 바이너리 재배포는 위의 upstream 라이선스 불확실성과 별도로 판단해야 합니다.
