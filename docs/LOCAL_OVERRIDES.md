# Local overrides

JK의 공개 코어와 개인/호스트별 운영 설정을 분리하기 위한 확장 지점입니다. 시작 훅은 JK 실행기 루트 아래에, Quick Links는 런타임 상태 디렉터리 아래에 둡니다. 개인 설정과 인증 정보는 공개 저장소에 커밋하지 않습니다.

## Linux startup hook

Linux 실행기는 JK 설치 또는 소스 실행기 루트(`ROOT`)의 startup hook을 실행합니다. 작업 대상으로 선택한 프로젝트 루트와는 다릅니다. 기본 경로는 다음과 같습니다:

```text
$ROOT/.jk/startup-hook.sh
```

기존 설치와의 호환성을 위해 hook이 없으면 레거시 경로를 fallback으로 확인합니다:

```text
$ROOT/.chatgpt2codex/startup-hook.sh
```

hook은 `bash`로 실행되며 launcher 경로 또는 원래 인수를 전달하지 않습니다. 훅은 백그라운드로 실행되고 출력은 같은 디렉터리의 `startup-hook.log`에 기록됩니다.

## Control Center Quick Links

Quick Links는 현재 JK 런타임이 선택한 상태 디렉터리 아래에 둡니다:

```text
<selected-state-dir>/control-center/quick-links.json
```

상태 디렉터리는 비어 있지 않은 `JK_STATE_DIR`, 비어 있지 않은 레거시 `CHATGPT2CODEX_STATE_DIR`, 이미 존재하는 `~/.local/share/jk`, 이미 존재하는 `~/.local/share/chatgpt2codex` 순으로 선택합니다. 모두 없으면 새 `~/.local/share/jk`를 사용합니다. Quick Links 파일은 선택된 디렉터리에서만 읽으며, 그 파일이 없다고 다른 상태 디렉터리의 파일을 대신 읽거나 합치지 않습니다.

예시:

```json
[
  {
    "title": "Internal dashboard",
    "note": "Host-local admin page",
    "badge": "Private",
    "badgeClass": "default",
    "href": "https://example.com/"
  }
]
```

허용되는 `badgeClass`는 `ok`, `warn`, `active`, `default`이며 링크는 `http://` 또는 `https://`만 허용됩니다. 파일이 없으면 JK 기본 Dashboard/Approvals 링크만 표시합니다.

## Boundary

이 override는 개인 배포 설정이나 credentials를 공개 `jk-mcp`에 커밋하지 않기 위한 장치입니다. 공개 코어는 특정 클라우드, reverse proxy, tunnel, systemd unit 또는 자동 배포 방식을 요구하지 않습니다.
