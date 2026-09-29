# Security Policy

JK runs commands on your computer on behalf of ChatGPT, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:

**[Report a vulnerability](https://github.com/Anjingyeong/jk-mcp/security/advisories/new)**

Include the JK version, OS, what an attacker could do, and steps to reproduce. Never include your own Owner Token or tunnel credentials; if one was exposed, rotate it in Settings (or `jk setup --reset-code`) first.

You should get a response within a few days. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Scope

In scope, for example:

- Bypassing Owner Token / OAuth authorization on the MCP endpoint or Control Center
- Reading or writing outside the selected project folder
- Running network, destructive, or Git-publishing actions without the required approval
- Secrets leaking into tool output, logs, or the Control Center
- Issues in the installers or the update path

Out of scope: problems that require an already-leaked Owner Token, or attacks on a machine the attacker already controls.

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

---

## 보안 취약점 신고

**공개 issue에 올리지 마세요.** 위의 [비공개 신고 링크](https://github.com/Anjingyeong/jk-mcp/security/advisories/new)로 알려주세요. JK 버전, OS, 공격자가 할 수 있는 일, 재현 방법을 적어주시면 됩니다. 본인 Owner Token이나 터널 자격증명은 넣지 마세요. 유출됐다면 먼저 설정에서 새로 발급하세요.
