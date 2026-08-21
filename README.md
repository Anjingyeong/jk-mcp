<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

<div align="center">

# 🎛️ JK

### ChatGPT ↔ Local Development Bridge

**ChatGPT가 허용된 로컬 프로젝트를 읽고, 수정하고, 테스트하고, Git 작업까지 수행할 수 있도록 연결하는 개발 실행 브리지입니다.**

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Tool_Bridge-111827?style=flat-square)
![Git](https://img.shields.io/badge/Git-Workspace_Automation-F05032?style=flat-square&logo=git&logoColor=white)
![Security](https://img.shields.io/badge/Security-Approval_Gates-2563EB?style=flat-square)

`Workspace · Terminal · Test · Git · Approval · Dashboard · Automation`

[English](README.en.md) | [한국어](README.md)

</div>

> JK는 OpenAI 공식 제품이 아닌 비공식 프로젝트입니다. `ezBuilder/chatgpt2codex`를 기반으로 확장한 포크이며, 원본 라이선스와 재배포 조건은 [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)를 먼저 확인하세요.

---

## 1. Why I built it

AI Coding Agent를 사용하면서 가장 반복적으로 느낀 병목은 **코드 생성 자체가 아니라 AI와 실제 개발 환경 사이의 단절**이었습니다.

```text
AI가 수정안을 만든다
      ↓
사람이 파일을 열고 옮긴다
      ↓
터미널에서 명령을 실행한다
      ↓
테스트 결과를 다시 AI에게 전달한다
      ↓
Git / 배포 / 상태를 다시 확인한다
```

모델은 점점 더 잘 코딩하지만, 실제 프로젝트를 수정하려면 결국 파일 시스템, 터미널, 테스트, Git, 승인 같은 **실행 계층**이 필요합니다.

그래서 JK는 새로운 AI 모델을 만드는 프로젝트가 아니라,

> **ChatGPT가 내가 허용한 개발 환경에서 실제 작업을 수행할 수 있도록 연결하는 실행·권한·상태 관리 계층**

을 목표로 만들었습니다.

핵심 역할은 단순합니다.

```text
ChatGPT가 판단한다.
JK가 실행한다.
```

---

## 2. Problem definition

AI에게 로컬 실행 권한을 연결할 때는 편의성만 높이면 안 됩니다.

해결해야 했던 문제는 크게 네 가지였습니다.

### 2.1 Context gap

AI가 프로젝트 구조와 현재 파일 상태를 모르면 실제 코드 수정으로 이어지기 어렵습니다.

### 2.2 Execution gap

파일 수정 이후 build / test / lint / shell / Git 검증을 다시 사람이 수행하면 자동화 효과가 줄어듭니다.

### 2.3 Permission risk

모든 명령을 무조건 허용하면 삭제, 네트워크, secret 노출, 잘못된 push 같은 위험이 생깁니다.

### 2.4 Long-task visibility

긴 작업에서는 지금 무엇을 실행 중인지, 어디에서 실패했는지, 어떤 승인이 필요한지 추적할 수 있어야 합니다.

JK는 이 네 문제를 하나의 bridge 안에서 다루는 방향으로 설계했습니다.

---

## 3. What JK is — and is not

JK는 두 번째 AI가 아닙니다.

```text
User
  ↓
ChatGPT
  ↓  Actions / MCP
JK
  ↓
Workspace / Terminal / Test / Git
```

- **ChatGPT**: 목표 해석, 코드 판단, 다음 행동 결정
- **JK**: 허용된 도구 실행, 파일 접근, 테스트, Git, 승인/상태 관리

즉 모델과 실행 환경을 분리합니다.

---

## 4. How it works

```text
┌──────────────┐
│   ChatGPT    │
└──────┬───────┘
       │ Actions / MCP
       ▼
┌──────────────────────────┐
│            JK            │
│                          │
│ Authentication           │
│ Workspace Registry       │
│ Tool / Permission Layer  │
│ Approval Gate            │
│ Task / Session State     │
└───────────┬──────────────┘
            │
            ├── Project Files
            ├── Terminal / Tests
            ├── Git
            ├── Dashboard
            └── Automation
```

백엔드 관점에서는 **외부 ChatGPT와 로컬 실행 환경 사이의 API/MCP bridge**이며, 인증과 실행 권한, 작업 상태, 결과 전달을 함께 다룹니다.

---

## 5. Design decisions

### 5.1 Model and executor separation

AI 모델 자체에 로컬 권한을 내장하는 대신, 실행을 JK라는 별도 계층으로 분리했습니다.

이렇게 하면 모델이 바뀌더라도 workspace / approval / execution policy를 같은 계층에서 관리할 수 있습니다.

### 5.2 Workspace-scoped access

PC 전체를 무제한 탐색하는 도구보다 **등록된 workspace/project 범위 중심으로 작업**하도록 설계했습니다.

목표는 "AI에게 PC를 준다"가 아니라:

```text
AI에게 필요한 프로젝트 범위의 도구만 연결한다.
```

입니다.

### 5.3 Approval for risky actions

모든 shell 명령을 동일하게 취급하지 않습니다.

민감하거나 파괴적인 작업에는 승인 gate를 두고, 일반적인 읽기/검증 작업과 위험한 작업을 구분할 수 있도록 구성했습니다.

### 5.4 State instead of blind execution

긴 작업에서는 단발성 명령 실행만으로 부족합니다. 작업 세션, 최근 검증 결과, 승인 상태를 남겨 **현재 작업의 상태를 다시 확인할 수 있는 구조**를 지향합니다.

### 5.5 Provider-neutral public deployment

공개판은 특정 tunnel/DNS/cloud provider를 자동 생성하지 않습니다. 외부 ChatGPT가 접근해야 할 경우 사용자가 관리하는 HTTPS reverse proxy 또는 tunnel을 연결하도록 분리했습니다.

---

## 6. Core capabilities

### Workspace

- 등록된 프로젝트 탐색
- 파일 읽기/수정
- project context 제공
- 기존 파일 변경 시 충돌 보호 지원

### Terminal / Verification

- build / test / lint 실행
- shell command 실행
- 실행 결과를 ChatGPT에 반환

### Git

- diff / status 확인
- commit 흐름 지원
- 명시적 의도에 따른 push 작업

### Approval & Safety

- Owner Token 인증
- 민감 명령에 대한 approval gate
- secret-like 값 redaction
- workspace 중심 접근
- 작업 결과/상태 저장

### Dashboard

- 프로젝트 및 runtime 상태 확인
- 승인 요청 확인
- 최근 작업과 실행 상태 확인

---

## 7. Connection modes

현재 공개판은 ChatGPT와 크게 두 방식으로 연결할 수 있습니다.

### ChatGPT Plus — Custom GPT + Actions

개인 Plus 환경에서는 Actions 방식이 설정이 단순합니다.

```text
ChatGPT
  ↓ HTTPS OpenAPI
JK Actions
  ↓
Local Workspace
```

### ChatGPT Apps / MCP

custom MCP app과 필요한 write action을 지원하는 Business / Enterprise / Edu 환경에서는 MCP endpoint를 사용할 수 있습니다.

```text
ChatGPT Apps
  ↓ MCP
JK
  ↓
Local Workspace
```

> ChatGPT의 기능 범위와 UI는 변경될 수 있으므로 실제 계정에서 제공되는 기능을 기준으로 사용하세요.

---

## 8. Tech stack

| Area | Stack |
| --- | --- |
| Runtime | Node.js 22+ |
| Language | TypeScript / JavaScript |
| External tool bridge | MCP / OpenAPI Actions |
| Local launcher | PowerShell / Node.js |
| Source control | Git |
| Authentication | Owner Token / OAuth-compatible flow |
| UI | Local web dashboard |
| Deployment boundary | User-managed HTTPS reverse proxy / tunnel |

---

## 9. Install

### Requirements

- Windows 10/11 권장
- Git
- Node.js 22+
- npm
- ChatGPT account
- 외부 연결 시 본인이 관리하는 HTTPS hostname

```powershell
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
```

### Run

Windows:

```powershell
npm run chatgpt:windows
```

macOS / Linux:

```bash
npm run chatgpt
```

정상 실행 시 기본적으로 로컬 loopback에서 동작합니다.

```text
MCP URL:   http://127.0.0.1:7979/mcp
Dashboard: http://127.0.0.1:7979/
```

---

## 10. Owner Token

첫 실행 시 Owner Token이 생성되고 한 번 표시됩니다.

```text
chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again)
```

이 값은 비밀번호처럼 관리해야 합니다.

- GitHub에 커밋하지 않기
- 스크린샷에 노출하지 않기
- 다른 사용자와 공유하지 않기
- 가능하면 password manager에 저장하기

재발급:

```powershell
node dist/cli.js owner-token --generate
```

새 토큰 발급 후 기존 OAuth 연결은 다시 인증이 필요할 수 있습니다.

---

## 11. Expose JK to ChatGPT

JK는 기본적으로 loopback에서만 실행됩니다.

```text
http://127.0.0.1:7979
```

ChatGPT 웹 서비스는 사용자의 `127.0.0.1`에 직접 접근할 수 없으므로 외부 연결에는 본인이 관리하는 HTTPS hostname이 필요합니다.

예:

```text
https://jk.example.com
```

공개판은 tunnel / DNS / cloud provider를 자동 구성하지 않습니다.

외부 hostname을 준비했다면 예를 들어:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-chatgpt.ps1 `
  -Workspace "C:\workspace" `
  -PublicHostname "jk.example.com"
```

주요 endpoint:

```text
MCP:     https://jk.example.com/mcp
Actions: https://jk.example.com/actions/openapi.json
```

---

## 12. Connect with Custom GPT Actions

1. ChatGPT에서 GPT 만들기
2. **Actions → Create new action**
3. 아래 OpenAPI schema 연결

```text
https://jk.example.com/actions/openapi.json
```

4. Authentication: **API Key → Bearer**
5. API Key에 Owner Token 입력
6. health/project 조회로 연결 테스트

예시 프롬프트:

```text
JK로 현재 등록된 프로젝트 목록 보여줘.
```

```text
JK로 이 프로젝트 구조만 확인해줘. 파일은 수정하지 마.
```

---

## 13. Connect with Apps / MCP

지원되는 ChatGPT 환경에서는:

1. Developer Mode 활성화
2. custom app 생성
3. MCP endpoint 입력

```text
https://jk.example.com/mcp
```

4. OAuth 인증
5. JK 승인 화면에서 Owner Token 검증
6. 도구 Scan / Connect

Owner Token은 승인 흐름에서 검증용으로 사용되며 평문 저장을 피하도록 설계되어 있습니다.

---

## 14. Usage examples

도구 이름을 외우기보다 **프로젝트 + 목표 + 제약 + 완료 조건**으로 요청하는 것이 안정적입니다.

```text
@JK 이 프로젝트 구조 설명해줘. 수정은 하지 마.
```

```text
@JK 이 오류 원인을 찾아서 수정하고 관련 테스트까지 돌려줘.
```

```text
@JK 지금 diff를 리뷰하고 문제 없으면 커밋해줘.
```

긴 작업 예:

```text
@JK paba 프로젝트에서 급여명세서 출력 오류를 고쳐줘.
기존 DB 구조는 가능한 건드리지 말고,
관련 테스트와 build가 통과하면 끝내줘.
```

---

## 15. Safety model

JK는 ChatGPT에게 PC 전체 권한을 무제한으로 주는 것을 목표로 하지 않습니다.

- 선택한 workspace/project 범위 중심 접근
- 기존 파일 수정 시 충돌 보호 가능
- secret-like 값 redaction
- 민감한 shell / network / destructive command에 safety gate
- commit / push는 명시적 의도 필요
- 작업 세션과 최근 검증 결과 저장

그럼에도 **Owner Token을 가진 사용자는 JK에 접근할 수 있으므로 토큰 관리가 가장 중요한 운영 보안 경계**입니다.

---

## 16. Verification mindset

JK에서 중요하게 보는 완료 조건은 "코드가 수정됨"이 아니라 **변경 후 검증까지 연결되었는가**입니다.

```text
Inspect
  ↓
Modify
  ↓
Build / Test / Lint
  ↓
Review Diff
  ↓
Commit / Deploy when intended
```

실행 도구를 붙인 이유도 AI가 코드를 제안하는 데서 끝나지 않고 실제 결과를 확인할 수 있게 하기 위해서입니다.

---

## 17. Limitations

- AI의 판단 자체를 더 정확하게 만드는 모델 프로젝트는 아닙니다.
- 외부 HTTPS 연결은 사용자가 직접 구성해야 합니다.
- 시스템 권한과 workspace 설정이 잘못되면 위험한 작업 가능성이 있으므로 approval/safety policy를 우회하면 안 됩니다.
- 모든 개발 환경과 shell command를 동일하게 추상화할 수 있는 것은 아닙니다.
- ChatGPT Apps/MCP 기능 지원 범위는 계정/제품 정책에 따라 달라질 수 있습니다.

---

## 18. What I learned

이 프로젝트를 만들면서 AI Coding의 병목이 반드시 **모델 성능**에만 있는 것은 아니라는 점을 배웠습니다.

실제로는 다음 요소가 함께 있어야 긴 작업이 안정적으로 이어집니다.

```text
Reasoning
+ Context
+ Execution
+ Permission
+ Verification
+ State
```

즉 좋은 코딩 에이전트 경험은 "더 강한 모델" 하나보다, **모델과 실제 개발 환경 사이를 어떻게 연결하고 통제하는가**에 크게 좌우됩니다.

---

## 19. Troubleshooting

### JK가 실행되지 않을 때

```powershell
npm ci
npm run build
npm run chatgpt:windows
```

### Owner Token 재발급

```powershell
node dist/cli.js owner-token --generate
```

### 로컬은 되는데 ChatGPT 연결이 안 될 때

먼저 로컬 dashboard를 확인합니다.

```text
http://127.0.0.1:7979/
```

로컬이 정상이라면 외부 HTTPS endpoint / reverse proxy / tunnel을 확인합니다.

### Actions schema

```text
https://내주소/actions/openapi.json
```

### MCP endpoint

```text
https://내주소/mcp
```

---

## 20. Documentation

- [설치 가이드](docs/INSTALL.md)
- [사용 가이드](docs/USAGE.ko.md)
- [실행/권한 정책](docs/EXECUTION_POLICY.md)
- [로컬 확장 설정](docs/LOCAL_OVERRIDES.md)
- [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)

---

## Attribution

JK는 [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex)를 기반으로 수정한 독립·비공식 포크입니다.

OpenAI, ChatGPT, GPT, Codex는 각 권리자의 상표입니다. JK는 OpenAI의 공식 제품, 공식 플러그인 또는 공식 파트너 프로젝트가 아닙니다.

---

<div align="center">

**Connect reasoning to a real development environment — with execution boundaries.**

</div>
