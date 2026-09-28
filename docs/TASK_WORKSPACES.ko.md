# ChatGPT 웹 기반 지속 작업 워크스페이스

ChatGPT 웹이 요구 해석·계획·코드 작성·리뷰를 담당하고, JK Node가 별도 Git 작업 공간과 실행 증거를 관리한다. 추가 모델 API나 OMO/Senpi 설치 없이 사용할 수 있다. ChatGPT 웹 자체의 이용 한도는 그대로 적용된다.

이 작업 공간 위에서 작업별 구현·검증·수정·리뷰를 이어가는 기본 흐름은 [웹 ChatGPT MASS ULW](MASS_ULW_WEB.ko.md)의 `mass_ulw_step`이다. 이 문서는 그 기반인 작업 공간 수명주기를 설명한다.

```text
ChatGPT 웹 → MCP / GPT Actions → JK Node
                                 ├─ 원본 프로젝트와 baseline
                                 ├─ 작업 A: 별도 checkout + 상태 + 검증 증거
                                 └─ 작업 B: 별도 checkout + 상태 + 검증 증거
검증된 변경 + ChatGPT 리뷰 → baseline 충돌 검사 → 원본 파일에 반영
```

## 자연어 사용

```text
@jk 이 프로젝트를 별도 작업 워크스페이스에서 고도화해줘.
테스트와 리뷰가 끝나면 원본에 반영해줘.

@jk 이전 작업 워크스페이스를 찾아서 이어서 진행해줘.

@jk 이 작업은 보관해둬. 나중에 같은 파일 상태에서 이어갈게.
```

`agent_guide`는 새 격리 작업에 `task_workspace`를 안내한다. 기존 원본 프로젝트 직접 작업 경로도 유지된다. 기존 세션이 자동으로 별도 checkout으로 이동하는 것은 아니다.

## 하네스 계약

1. 원본 프로젝트를 `project_select`의 `full-write`로 선택한다.
2. `task_workspace(action=create, projectId=원본ID, goal=목표, workSessionId=고정작업ID)`를 호출한다. 생략한 작업 ID는 생성된다.
3. 반환된 `jk-task-…` **projectId**를 모든 파일·검색·명령·Git·체크포인트·메모리·E2E·목표 도구에 사용한다. `workSessionId`를 전달한다면 생성 시 받은 값을 사용한다.
4. ChatGPT가 `goal_intake` / `goal_loop`를 통해 탐색·구현·수정을 이어간다.
5. `command_list`에서 `riskTier=verify` 명령을 고르고 `task_workspace(action=verify, projectId=작업ID, commandId=명령ID)`로 검증한다.
6. 반환된 검증 출력과 변경 diff를 ChatGPT가 리뷰한다. 워크스페이스 내부에서 커밋했다면 `baselineCommit` 이후의 변경도 리뷰 범위에 포함한다.
7. `task_workspace(action=publish, projectId=작업ID, verificationId=검증ID, reviewSummary=리뷰내용)`로 원본 파일에 반영한다. 원본에 대한 commit/push/deploy는 수행하지 않는다.

GPT Actions에서는 기존 `call_tool`을 사용하므로 별도 OpenAPI operation을 추가할 필요가 없다.

```json
{
  "toolName": "task_workspace",
  "input": {
    "action": "create",
    "projectId": "my-project",
    "workSessionId": "ws_feature_a",
    "goal": "기능 구현 및 테스트"
  }
}
```

| action | 동작 / 필수 입력 |
| --- | --- |
| create | 원본 projectId와 goal. 같은 작업 ID·같은 목표로 재호출하면 같은 활성 공간 반환 |
| list | 저장된 작업 목록. projectId로 원본 또는 특정 작업 필터 |
| status | 작업 projectId. 상태·경로·fingerprint·검증 출력·다음 행동 |
| archive | 작업 projectId. checkout 보존, 일반 프로젝트 도구에서 제외 |
| resume | 작업 projectId. 동일 checkout 재활성화. 해당 작업 또는 원본의 쓰기 lease 필요 |
| verify | 작업 projectId와 commandId. 선택적 timeoutSec(1–300) |
| publish | 작업 projectId, verificationId, reviewSummary. 반영 완료 재호출은 중복 적용하지 않음 |
| discard | 작업 projectId, confirmDiscard=true, status에서 받은 expectedFingerprint. checkout 삭제, 상태 기록 보존 |

## 저장·검증·복구

- 저장 위치는 `<stateDir>/task-workspaces/<projectId>/merged`다. 원본 Git 저장소 바깥의 stateDir가 필요하다.
- 로컬 private clone에 원본의 tracked 파일, staged/dirty 상태에 따른 내용, Git이 무시하지 않는 untracked 파일을 반영해 작업 baseline을 만든다. 원본 index와 HEAD는 건드리지 않는다. clone의 origin도 제거한다.
- 작업 생성은 임시 디렉터리에서 완료한 후 공개한다. 일반 실패는 임시 파일을 정리하며, 생성 중 프로세스 강제 종료로 남은 `.creating-*`는 활성 작업으로 등록되지 않는다. 이 잔여 공간의 자동 GC는 아직 없다.
- 서버 재시작과 프로젝트 재검색 후에도 durable state에서 활성 프로젝트를 복원한다. 작업 ID마다 상태·역할·권한·캐시 키가 분리된다.
- 작업 도구와 승인 후 실행되는 로컬 작업은 같은 프로세스 간 lock을 사용한다. 사용 중이면 수명주기 작업을 거부한다. 보관·폐기 이후 승인된 대기 작업은 실행하지 않는다.
- 검증 명령 실행 전후의 HEAD·index·파일 fingerprint가 같고 exit code가 0이어야 증거를 발급한다. 이후 수정하면 증거가 무효화된다. 새 검증 시도는 기존 증거를 먼저 지워 타임아웃·프로세스 중단 후 이전 통과 결과를 재사용하지 못하게 한다.
- 작업의 `publish`는 현재 변경에 맞는 검증 증거를 요구한다. 검증만 끝난 작업의 `goal_loop`는 성공 완료로 표시하지 않으며, 원본 반영을 위한 다음 호출을 안내한다.
- 반영 후에는 기존 작업·세션·루프의 `projectId`, `workSessionId`, `loopId`와 `phase=release`, `verificationStatus=pass`, `reviewVerdict=approve`, `pending=[]`로 읽기 전용 완료 확인을 할 수 있다. 새 목표·진행 상태·권한 변경은 허용하지 않으며, 저장된 안전 조건이 충족되지 않았다면 완료로 표시하지 않는다.
- 원본 반영은 commit/push/deploy의 증거가 아니다. 일반 원본 프로젝트의 `goal_loop` 규칙은 유지한다. 리뷰는 ChatGPT가 작성하며, Node가 별도의 모델 리뷰를 실행하거나 리뷰 품질을 인증하는 것은 아니다.
- 원본이 baseline 이후 변경됐으면 덮어쓰지 않고 반영을 거부한다. 자동 충돌 병합은 제공하지 않는다.
- 반영은 기존 MASS ULW의 durable journal·복구 receipt를 재사용한다. 반영 후 상태 저장이 중단되어도 재호출로 결과를 복구한다. 폐기 중 삭제가 중단된 경우에도 재호출로 남은 checkout을 정리한다.

## 현재 범위

첫 단계는 **지속 워크스페이스·도구 연결·증거 기반 완료·원본 반영**이다. OMO Native 전체 포팅이나 독립적인 추론 에이전트 실행은 포함하지 않는다.

로컬 Git 저장소의 최상위 디렉터리와 유효한 HEAD가 필요하다. 비 Git·원격 worker·중첩 task workspace는 생성 대상이 아니다. `node_modules`, 무시된 산출물·환경 파일은 공유하거나 복제하지 않으므로 작업 공간에서 필요한 의존성과 설정을 준비해야 한다. 발견 가능한 verify 명령이 없는 프로젝트에는 먼저 적절한 검증 명령을 추가해야 한다.

이는 도구의 작업 경로 분리이며 OS 보안 샌드박스는 아니다. 임의 shell의 절대경로 접근, 외부 프로세스의 파일 변경, detached dev server의 수명주기까지 격리하지 않는다. 장기 실행 서버는 폐기 전에 종료해야 한다. Windows 명령 타임아웃의 하위 프로세스 정리 문제는 검증 기록에 별도로 남겼다.

다음 확장 범위는 [OMO Native 비교 보고서](JK_OMO_NATIVE_BETA_GAP_ANALYSIS.ko.md)의 workflow 전이·비동기 명령 start/status/events/cancel·역할별 문맥·LSP/AST 순으로 정리되어 있다.
