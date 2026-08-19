# JK 설치 / 연결 가이드

이 문서는 `jk-mcp` 공개판을 **처음 설치하는 사람**을 위한 절차입니다.

## 1. 설치

필요한 것:

- Git
- Node.js 22 이상
- npm
- ChatGPT 계정
- **개인 도메인 1개** (예: `example.com`)

```powershell
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
```

## 2. 실행

Windows:

```powershell
npm run chatgpt:windows
```

macOS/Linux:

```bash
npm run chatgpt
```

기본 workspace는 사용자 홈의 `workspace` 폴더입니다. 다른 경로를 쓰려면 Windows에서는 launcher를 직접 호출할 수 있습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-chatgpt.ps1 `
  -Workspace "C:\workspace"
```

정상 실행 시:

```text
MCP URL: http://127.0.0.1:7979/mcp
Dashboard: http://127.0.0.1:7979/
```

## 3. Owner Token

첫 설정에서 JK는 Owner Token을 자동 생성하고 **터미널에 한 번만 표시**합니다.

이 토큰은 다음 용도로 사용됩니다.

- Custom GPT Actions에서 Bearer API key로 인증
- JK OAuth 승인 화면에서 연결 승인

잃어버렸다면 새로 발급합니다.

```powershell
node dist/cli.js owner-token --generate
```

새 토큰 발급 시 기존 OAuth 연결은 다시 인증해야 할 수 있습니다.

## 4. 외부 HTTPS 연결

JK는 기본적으로 `127.0.0.1:7979`에만 바인딩합니다.

ChatGPT 웹 서비스는 사용자의 localhost에 직접 접근하지 못하므로 ChatGPT와 연결하려면 사용자가 관리하는 HTTPS endpoint가 필요합니다.

이 지인용 가이드에서는 **본인 소유 도메인 1개가 있다고 가정**합니다. 예를 들어 `example.com`을 소유하고 있다면 `jk.example.com` 같은 서브도메인을 JK 전용 주소로 구성하세요. 도메인 구매, DNS 설정, HTTPS 인증서, reverse proxy/tunnel 설정은 JK 공개판이 자동으로 처리하지 않습니다.

다른 방식으로 공개 HTTPS hostname을 이미 가지고 있다면 기술적으로 그것을 사용할 수도 있지만, 이 문서에서는 개인 도메인을 사용하는 구성을 기본 경로로 설명합니다.

공개판 `jk-mcp`는 tunnel, DNS, reverse proxy, cloud host를 자동 생성하지 않습니다.

외부 HTTPS 주소를 준비한 뒤 hostname을 JK에 알려줍니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-chatgpt.ps1 `
  -Workspace "C:\workspace" `
  -PublicHostname "jk.example.com"
```

이 경우:

```text
MCP endpoint:     https://jk.example.com/mcp
Actions OpenAPI:  https://jk.example.com/actions/openapi.json
```

`PublicHostname`은 메타데이터 설정일 뿐, JK가 해당 hostname을 인터넷에 공개해 주는 기능은 아닙니다.

## 5-A. ChatGPT Plus / Custom GPT Actions

개인 Plus 환경에서는 Custom GPT Actions 경로가 가장 간단합니다.

1. ChatGPT에서 새 GPT를 만듭니다.
2. Actions에서 `Create new action`을 선택합니다.
3. 아래 schema를 불러옵니다.

```text
https://jk.example.com/actions/openapi.json
```

4. Authentication을 `API Key` / `Bearer`로 설정합니다.
5. API key 값으로 JK Owner Token을 입력합니다.
6. Preview에서 harmless read-only 요청으로 연결을 확인합니다.

예:

```text
JK로 등록된 프로젝트 목록을 보여줘.
```

Actions API는 Owner Token Bearer 인증과 JK OAuth access token 인증을 모두 받을 수 있습니다.

## 5-B. ChatGPT Apps / MCP

계정/워크스페이스에서 custom MCP app과 필요한 권한이 지원되는 경우:

1. Developer Mode를 활성화합니다.
2. custom app을 만듭니다.
3. endpoint에 아래 주소를 넣습니다.

```text
https://jk.example.com/mcp
```

4. OAuth를 진행합니다.
5. JK 승인 화면에서 첫 실행 때 받은 Owner Token을 입력합니다.
6. 연결 후 tools를 scan/enable 합니다.

ChatGPT의 Apps/MCP 지원 범위는 플랜 및 워크스페이스 정책에 따라 달라질 수 있습니다.

## 6. 연결 후 사용

내부 도구 이름을 외울 필요 없이 자연어로 요청합니다.

```text
@JK 이 프로젝트 구조만 설명해줘. 파일은 수정하지 마.
```

```text
@JK 이 버그를 수정하고 관련 테스트까지 실행해줘.
```

```text
@JK 현재 diff를 리뷰하고 문제 없으면 커밋해줘.
```

## 7. 문제 해결

### 로컬 Dashboard부터 확인

```text
http://127.0.0.1:7979/
```

### Actions schema

```text
https://내주소/actions/openapi.json
```

### MCP endpoint

```text
https://내주소/mcp
```

로컬 Dashboard는 열리는데 ChatGPT에서만 실패하면 외부 HTTPS endpoint/reverse proxy/tunnel 설정을 우선 확인하세요.

---

# English quick install

```bash
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
npm run chatgpt
```

On Windows:

```powershell
npm run chatgpt:windows
```

The first setup prints an Owner Token once. Save it securely. For individual Custom GPT Actions, expose JK through an HTTPS endpoint, import `https://<host>/actions/openapi.json`, and configure API Key/Bearer authentication with that Owner Token. Where ChatGPT custom MCP apps are supported, connect `https://<host>/mcp` and approve the OAuth prompt with the same Owner Token.
