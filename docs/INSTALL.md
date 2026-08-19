# JK 설치 가이드

JK 공개 배포판은 **로컬 MCP 하네스**입니다. Node.js 22+와 npm만 있으면 Windows, macOS, Linux에서 소스 기준으로 실행할 수 있습니다.

## 1. 설치

```bash
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
```

## 2. 실행

Linux/macOS:

```bash
npm run chatgpt
```

Windows PowerShell:

```powershell
npm run chatgpt:windows
```

직접 실행하려면 다음도 가능합니다.

```bash
node dist/cli.js init --workspace ~/workspace
node dist/cli.js serve --http --port 7979 --public-url http://127.0.0.1:7979 --workspace ~/workspace
```

기본 Dashboard와 MCP endpoint는 로컬 `127.0.0.1:7979`에서 동작합니다.

## 3. ChatGPT에서 사용

JK는 MCP 서버 자체를 제공합니다. 외부 ChatGPT 클라이언트가 로컬 머신에 직접 접근할 수 없는 환경이라면 **사용자가 별도로 관리하는** HTTPS reverse proxy 또는 tunnel이 필요할 수 있습니다.

공개 JK는 특정 프록시, tunnel 서비스, DNS 공급자 또는 클라우드 호스트를 설치·생성·관리하지 않습니다. 외부 HTTPS endpoint를 이미 운영한다면 launcher의 `PUBLIC_HOSTNAME`/`--public-hostname`으로 그 hostname을 알려 OAuth/MCP metadata에 사용할 수 있습니다.

예:

```bash
PUBLIC_HOSTNAME=mcp.example.com npm run chatgpt
```

이 값은 **메타데이터**일 뿐이며 JK가 해당 hostname을 인터넷에 노출해 주지는 않습니다.

## 4. Remote executor

다른 머신을 worker로 연결하려면 먼저 hub에서 executor token을 발급한 뒤 worker에서 실행합니다.

```bash
node dist/cli.js executor \
  --hub https://your-managed-mcp-host.example \
  --executor-id worker-1 \
  --workspace ~/workspace \
  --token-file /path/to/executor-token
```

Windows에서도 `start-chatgpt.ps1`의 `ExecutorHubUrl`, `ExecutorId`, `ExecutorWorkspace`, `ExecutorTokenFile` 옵션을 사용할 수 있습니다.

## 5. 개인/호스트 운영 설정 분리

개인 도메인, 상시 서버, 자동 배포, reverse proxy, 서비스 관리자 설정은 공개 저장소에 넣지 않는 것을 권장합니다.

JK가 제공하는 host-local 확장 지점:

- `~/.local/share/chatgpt2codex/local/launcher.sh`
- `~/.local/share/chatgpt2codex/control-center/quick-links.json`

자세한 내용은 `docs/LOCAL_OVERRIDES.md`와 `docs/EXECUTION_POLICY.md`를 참고하세요.

---

# JK Installation Guide

The public JK distribution is a **local MCP harness**. Node.js 22+ and npm are sufficient for the source-based install.

```bash
git clone https://github.com/Anjingyeong/jk-mcp.git
cd jk-mcp
npm ci
npm run build
npm run chatgpt
```

On Windows use:

```powershell
npm run chatgpt:windows
```

JK binds to loopback by default. If your ChatGPT client requires an internet-reachable HTTPS endpoint, configure that transport outside JK and pass its hostname through `PUBLIC_HOSTNAME` or `--public-hostname`. JK does not provision or operate a cloud host, DNS provider, reverse proxy, or tunnel in the public distribution.

For host-specific operations, see `docs/LOCAL_OVERRIDES.md`.
