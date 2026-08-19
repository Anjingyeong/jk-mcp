<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**ChatGPT가 내 PC의 프로젝트를 읽고, 수정하고, 테스트하고, Git 작업까지 할 수 있게 연결하는 로컬 코딩 브리지입니다.**

[English](README.en.md) | [한국어](README.md)

> JK는 OpenAI 공식 제품이 아닌 비공식 프로젝트입니다. `ezBuilder/chatgpt2codex`를 기반으로 수정한 포크이며, 원본 코드의 라이선스/재배포 조건은 [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)를 먼저 확인하세요.

## 가장 먼저 알아둘 것

JK는 두 번째 AI가 아닙니다.

```text
나
→ ChatGPT
→ JK
→ 내 PC의 프로젝트 / 터미널 / Git / 테스트
```

ChatGPT가 판단하고, JK가 내 PC에서 실제 작업을 수행합니다.

그리고 예전 표현인 **“ChatGPT 플러그인”** 대신 현재는 아래 두 방식 중 하나로 연결합니다.

1. **개인 Plus 사용자에게 권장:** Custom GPT + Actions
2. **지원되는 Business / Enterprise / Edu 환경:** ChatGPT Apps + MCP

둘 다 JK의 **Owner Token**으로 소유자 인증을 할 수 있습니다.

---

# 1. 설치

## 준비물

- Windows 10/11 권장
- Git
- Node.js 22 이상
- npm
- ChatGPT 계정
- **개인 도메인 1개** (예: `example.com` — ChatGPT 웹에서 JK로 접근할 HTTPS 주소를 만들 때 사용)

설치:

```powershell
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
```

## 실행

Windows:

```powershell
npm run chatgpt:windows
```

macOS / Linux:

```bash
npm run chatgpt
```

첫 실행이 정상이라면 대략 다음 정보가 표시됩니다.

```text
JK is ready
MCP URL: http://127.0.0.1:7979/mcp
Dashboard: http://127.0.0.1:7979/
```

브라우저에서 아래 주소도 열 수 있습니다.

```text
http://127.0.0.1:7979/
```

---

# 2. Owner Token 저장

JK는 첫 실행 시 **Owner Token을 자동 생성하고 터미널에 한 번만 보여줍니다.**

```text
chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again)
```

이 토큰은 비밀번호처럼 보관하세요.

- GitHub에 올리지 마세요.
- 스크린샷에 노출하지 마세요.
- 다른 사람과 공유하지 마세요.
- 가능하면 비밀번호 관리자에 저장하세요.

토큰을 잃어버렸다면 새 토큰을 발급할 수 있습니다.

```powershell
node dist/cli.js owner-token --generate
```

새 토큰을 만들면 기존 OAuth 연결은 다시 인증해야 할 수 있습니다.

> 예전 JK 개인용 데스크톱판처럼 GUI에서 토큰을 꺼내는 방식이 아닙니다. 현재 공개판 `jk-mcp`에서는 **첫 실행 CLI/launcher가 토큰을 발급**합니다.

---

# 3. ChatGPT와 연결하기

## 중요한 조건: 인터넷에서 접근 가능한 HTTPS 주소가 필요합니다

> **지인용 설치 가이드에서는 개인 도메인 1개를 필수 준비물로 봅니다.** 예를 들어 `example.com`을 가지고 있다면 `jk.example.com` 같은 서브도메인을 JK 연결용으로 사용합니다. JK는 도메인을 구매하거나 DNS/HTTPS를 자동 구성해 주지 않습니다.

기술적으로는 본인이 관리하는 다른 공개 HTTPS hostname을 사용할 수도 있지만, 이 README의 지인 배포 절차는 **본인 소유 도메인을 사용한다는 전제**로 설명합니다.

JK는 기본적으로 아래 로컬 주소에서만 실행됩니다.

```text
http://127.0.0.1:7979
```

ChatGPT 웹 서비스는 사용자의 `127.0.0.1`에 직접 접속할 수 없으므로, 실제 ChatGPT 연결에는 예를 들어 아래와 같은 주소가 필요합니다.

```text
https://내가-관리하는-주소.example.com
```

공개판 JK는 특정 터널, DNS, 클라우드 서비스를 자동으로 만들지 않습니다. HTTPS reverse proxy 또는 tunnel은 사용자가 별도로 준비해야 합니다.

외부 주소가 준비됐다면 JK 실행 시 hostname을 알려줍니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-chatgpt.ps1 `
  -Workspace "C:\workspace" `
  -PublicHostname "jk.example.com"
```

그러면 주요 URL은 다음처럼 됩니다.

```text
MCP:     https://jk.example.com/mcp
Actions: https://jk.example.com/actions/openapi.json
```

---

# 4-A. ChatGPT Plus: Custom GPT Actions로 연결

개인 Plus 사용자는 이 방식이 가장 단순합니다.

1. ChatGPT에서 **GPT 만들기**로 들어갑니다.
2. 새 GPT의 **Actions**에서 `Create new action`을 선택합니다.
3. Schema에 아래 주소의 OpenAPI를 불러옵니다.

```text
https://jk.example.com/actions/openapi.json
```

4. Authentication은 **API Key → Bearer** 방식으로 설정합니다.
5. API Key 값에 JK 첫 실행 때 받은 **Owner Token**을 입력합니다.
6. Preview에서 `action_health` 또는 간단한 프로젝트 조회를 테스트합니다.

JK Actions 서버는 다음 두 인증을 모두 받을 수 있습니다.

- Owner Token을 직접 Bearer token으로 사용
- JK OAuth access token 사용

지인용 개인 설치에서는 **Bearer Owner Token 방식이 설정이 가장 적습니다.**

### 연결 확인용 프롬프트

```text
JK로 현재 등록된 프로젝트 목록 보여줘.
```

또는:

```text
JK로 이 프로젝트 구조만 확인해줘. 파일은 수정하지 마.
```

정상 연결되면 ChatGPT가 JK Action을 호출해 로컬 프로젝트 정보를 가져옵니다.

---

# 4-B. ChatGPT Apps / MCP로 연결

ChatGPT 계정/워크스페이스에서 custom MCP app과 필요한 write action이 지원되는 경우 사용할 수 있습니다.

1. ChatGPT의 Developer Mode를 활성화합니다.
2. Apps에서 custom app을 만듭니다.
3. MCP endpoint에 아래 주소를 입력합니다.

```text
https://jk.example.com/mcp
```

4. OAuth 인증을 진행합니다.
5. JK 승인 페이지가 열리면 **Owner Token**을 입력합니다.
6. 승인 후 JK 도구를 Scan/Connect 합니다.

JK의 OAuth 승인 화면에서 Owner Token은 로컬에서 해시로 검증되며 평문으로 저장되지 않습니다.

> ChatGPT의 Apps/MCP 기능 범위와 요금제 지원은 바뀔 수 있습니다. 현재 제품 UI에서 기능이 보이지 않으면 Custom GPT Actions 방식을 먼저 확인하세요.

---

# 5. 실제 사용법

연결이 끝난 뒤에는 JK 내부 도구 이름을 외울 필요가 없습니다.

그냥 원하는 결과를 자연어로 말하면 됩니다.

```text
@JK 이 프로젝트 구조 설명해줘. 수정은 하지 마.
```

```text
@JK 이 오류 원인 찾아서 수정하고 관련 테스트까지 돌려줘.
```

```text
@JK 지금 diff 리뷰하고 문제 없으면 커밋해줘.
```

```text
@JK e2e 테스트하고 화면 확인해줘.
```

긴 작업은 아래 네 가지를 같이 말하면 안정적입니다.

```text
프로젝트 + 목표 + 제약 + 완료 조건
```

예:

```text
@JK paba 프로젝트에서 급여명세서 출력 오류를 고쳐줘.
기존 DB 구조는 가능한 건드리지 말고,
관련 테스트와 build가 통과하면 끝내줘.
```

---

# 6. 안전장치

JK는 ChatGPT에게 PC 전체 권한을 무제한으로 주는 도구가 아닙니다.

- 선택한 workspace/project 범위 중심으로 접근
- 기존 파일 수정 시 해시 기반 충돌 보호 가능
- secret 값 redaction
- 민감한 shell / 네트워크 / 파괴적 명령에 안전 게이트 적용
- commit / push는 사용자의 명시적 의도 필요
- 작업 세션과 최근 검증 결과 저장

그래도 **Owner Token을 가진 사람은 JK에 접근할 수 있으므로 토큰은 반드시 비밀로 관리해야 합니다.**

---

# 7. 문제가 생겼을 때

## JK가 안 켜짐

```powershell
npm ci
npm run build
npm run chatgpt:windows
```

## Owner Token을 잃어버림

```powershell
node dist/cli.js owner-token --generate
```

## ChatGPT가 JK에 연결되지 않음

먼저 로컬에서 확인합니다.

```text
http://127.0.0.1:7979/
```

로컬은 열리는데 ChatGPT만 연결되지 않는다면 대부분 **외부 HTTPS endpoint / reverse proxy / tunnel** 쪽을 확인해야 합니다.

## Actions schema 확인

```text
https://내주소/actions/openapi.json
```

## MCP endpoint

```text
https://내주소/mcp
```

---

# 더 자세한 문서

- [설치 가이드](docs/INSTALL.md)
- [사용 가이드](docs/USAGE.ko.md)
- [실행/권한 정책](docs/EXECUTION_POLICY.md)
- [로컬 확장 설정](docs/LOCAL_OVERRIDES.md)
- [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md)

## Attribution

JK는 [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex)를 기반으로 수정한 독립·비공식 포크입니다.

OpenAI, ChatGPT, GPT, Codex는 각 권리자의 상표입니다. JK는 OpenAI의 공식 제품, 공식 플러그인 또는 공식 파트너 프로젝트가 아닙니다.
