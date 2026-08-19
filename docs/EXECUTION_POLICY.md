# JK Execution Policy

JK의 공개 배포판은 **로컬 MCP 하네스**를 기본으로 합니다. 특정 클라우드 공급자, 상시 서버, 개인 도메인, 자동 배포 환경은 공개 코어의 전제 조건이 아닙니다.

## 1. Local first

- 프로젝트는 기본적으로 현재 JK 인스턴스의 local workspace에서 실행합니다.
- 원격 executor는 사용자가 별도로 연결한 경우에만 사용합니다.
- GUI, 디바이스, 서명 키, 로컬 전용 파일 등 플랫폼 종속 작업은 해당 환경에서 실행합니다.
- 원격 worker가 없거나 offline이면 가능한 local project를 사용합니다.

## 2. Git handoff

여러 executor가 같은 Git 저장소를 다룬다면 configured upstream을 durable source of truth로 사용합니다.

- 원격 checkout은 작업 전 clean 상태와 upstream 관계를 확인합니다.
- 자동 동기화가 필요한 배포 follower는 fast-forward-only 방식만 사용해야 합니다.
- dirty, diverged, local-only commit 상태는 자동으로 정리하지 않습니다.
- 자동 `stash`, `reset`, `rebase`, force update는 하지 않습니다.
- 같은 branch를 여러 executor에서 독립적으로 동시에 수정하지 않습니다.
- Windows working copy는 사용자가 명시적으로 요청하지 않는 한 자동 pull하지 않습니다.

## 3. Remote workers

Remote executor 기능은 범용 실행 수단입니다. 공개 JK는 특정 서버 공급자나 배포 토폴로지를 강제하지 않습니다.

예를 들어 사용자는 별도 머신, VM, 사내 서버 또는 개인 호스트에 worker를 구성할 수 있습니다. 그 호스트의 서비스 관리, reverse proxy, tunnel, 배포 자동화, 비용 정책은 host-local 운영 설정으로 관리합니다.

## 4. Private host overrides

공개 저장소에 개인 운영 로직을 넣지 않고도 host별 동작을 추가할 수 있습니다.

- launcher override: `~/.local/share/chatgpt2codex/local/launcher.sh`
- Control Center quick links: `~/.local/share/chatgpt2codex/control-center/quick-links.json`

이 파일들은 Git 저장소 밖의 로컬 상태이며 공개 배포판에 포함되지 않습니다. 자세한 내용은 `docs/LOCAL_OVERRIDES.md`를 참고하세요.

## 5. Public distribution boundary

공개 `jk-mcp`의 책임 범위는 MCP 서버, 프로젝트/Role/Approval, goal loop, 로컬·원격 executor, 안전한 Git 도구와 Control Center 같은 **하네스 기능**입니다.

다음은 공개 코어에 포함하지 않습니다.

- 개인 도메인과 개인 서비스 링크
- 특정 클라우드 공급자용 provisioning/인증 UI
- 개인 서버 systemd unit과 tunnel 설정
- 특정 서버로의 자동 배포 스크립트
- 개인 프로젝트별 운영 정책과 credentials
