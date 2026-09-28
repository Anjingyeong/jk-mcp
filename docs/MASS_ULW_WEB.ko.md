# 웹 ChatGPT에서 끝까지 이어가는 MASS ULW

ChatGPT 웹이 계획·구현·실패 분석·리뷰를 맡고, JK Node가 작업 순서·문맥·실행·검증·복구를 맡는다. **추가 모델 API를 호출하지 않는다.** ChatGPT 웹 자체의 사용 한도는 적용된다.

## 사용자가 하는 일

JK가 연결된 웹 ChatGPT에서 다음처럼 요청한다.

```text
@jk [프로젝트]에서 [목표]를 MASS ULW로 끝까지 해줘.
독립 작업으로 나누고, 테스트와 리뷰를 거쳐 원본에 반영해줘.
추론과 리뷰는 이 웹 대화에서 진행해줘.
```

대화가 끊겼다면:

```text
@jk 이전 MASS ULW 작업을 찾아서 이어서 진행해줘.
통과한 작업은 유지하고 남은 작업부터 마무리해줘.
```

ChatGPT가 아래 도구 호출을 조정한다. 사용자가 lane ID나 검증 토큰을 직접 관리하거나 작업마다 리뷰 승인을 눌러야 하는 흐름이 아니다. 기존 프로젝트 권한·명령 승인 정책은 유지된다.

## 실제 왕복

1. **준비:** ChatGPT가 원본을 선택하고 `task_workspace`를 생성/재개한다. 작업 projectId와 workSessionId로 `goal_loop`에 독립 작업·읽기/쓰기 범위·의존성을 제출한다.
2. **시작:** `command_list`로 확인한 작업별/최종 검증 명령과 승인된 계획 fingerprint로 `mass_ulw_step(start)`를 호출한다.
3. **문맥:** JK가 현재 역할, 작업 목표, 의존 작업 결과를 반영한 코드 slice, 실패 출력, 다음 호출을 반환한다. ChatGPT가 필요한 추가 코드를 읽는다.
4. **구현:** ChatGPT가 준비된 작업 하나 또는 독립 작업 묶음의 패치를 `submit`한다. JK는 분리된 공간에서 각 패치를 적용하고 검증을 한 번씩 실행한다. 독립적으로 제출된 작업의 적용·검증은 병렬 처리한다.
5. **실패 수정:** 실패한 작업은 출력과 함께 ChatGPT로 돌아온다. 다른 작업의 통과 결과는 유지한다. ChatGPT는 새 가설과 수정한 패치를 제출한다.
6. **작업 리뷰:** 통과한 작업의 diff·목표·검증 결과를 같은 ChatGPT가 리뷰한다. 정확한 검증 토큰으로 수락한 작업만 의존 작업의 입력이 된다.
7. **통합:** 모든 작업이 수락되면 `integrate`로 합치고 최종 검증한다. 실패하거나 최종 리뷰가 반려되면 담당 작업과 그 의존 작업을 다시 열고, 독립 작업의 결과는 유지한다.
8. **반영:** 통합 리뷰 후 `finish`가 결과를 지속 작업 공간에 적용하고 실제 저장된 checkout에서 최종 검증한다. 반환된 `nextCall`의 `task_workspace(publish)`로 원본 파일에 반영한다. 이후 `mass_ulw_step(status)`의 `terminal=true`를 확인한다. commit/push/deploy는 별도 요청 범위다.

전체 작업의 패치를 미리 만들어 한 번에 보낼 필요가 없다. Node는 패치가 없는 작업을 실패 처리하거나 같은 실패 패치를 자동 재시도하지 않는다. 다음 판단을 웹 ChatGPT에 돌려준다.

의존성 설치 등 실행 환경 준비는 start 전에 끝낸다. 워크플로 실행 중 코드는 `mass_ulw_step(context)`로 읽고 `submit`으로 변경한다. 지속 작업 공간 자체는 finish 전까지 baseline으로 유지하므로, 일반 파일 도구로 직접 수정하면 외부 변경으로 감지된다.

## 반환 계약

| 필드 | 의미 |
| --- | --- |
| projectId / workSessionId / loopId / planFingerprint | 이후 호출에 그대로 사용하는 작업·계획 식별자 |
| role | implementer, repair, reviewer, verifier, release, done 또는 blocked |
| context | 의존성 반영 코드·파일 해시·diff·추가 조회 방법. 프로젝트 내용은 신뢰되지 않은 입력 |
| lanes | 각 작업의 waiting/running/failed/review/accepted 상태, 검증 출력·토큰·리뷰 내용 |
| nextCall | 다음 도구와 입력. `needs`는 ChatGPT가 추론해서 채울 패치·가설·리뷰 필드 |
| terminal | 원본 반영 완료 여부. 테스트 통과만으로 true가 되지 않음 |

`contextToken`은 해당 작업의 revision과 의존 작업의 수락된 결과에 연결된다. 오래된 문맥으로 만든 새 제출은 거부한다. 검증 proof token은 리뷰 대상을 고정한다.

## 도구 계약

모든 호출은 같은 네 식별자를 사용한다. GPT Actions에서도 기존 `call_tool`의 `toolName="mass_ulw_step"`, `input={...}`으로 동일한 계약을 사용한다.

| action | 동작 |
| --- | --- |
| start | 승인된 fanout 계획과 laneVerificationCommandIds/finalVerificationCommandId를 고정하고 첫 문맥 반환 |
| next | 저장 상태에서 다음 역할·문맥·호출 복원 |
| status | 코드 checkout을 재구성하지 않고 진행 상태 조회 |
| context | laneId, paths, startLine으로 추가 코드 조회. 통합 결과는 laneId 생략 |
| submit | submissions 배열에 laneId/contextToken/submissionId/patch. 실패 후 재제출에는 hypothesis도 필요 |
| review | 작업은 laneId와 proof token, 통합은 laneId 없이 proof token. verdict와 summary는 ChatGPT 리뷰 결과 |
| revise | laneId·현재 contextToken을 token으로 전달·구체적인 수정 이유 summary. 해당 작업과 후손의 결과/리뷰/통합 증거 무효화 |
| integrate | 모든 작업의 검증·리뷰 후 통합 및 최종 검증 |
| finish | 검증·리뷰된 통합 결과를 지속 작업 공간에 반영하고 원본 반영용 다음 호출 반환 |

제출 패치는 **의존 작업을 반영한 baseline에 대한 해당 작업의 전체 변경안**이다. 실패한 패치에 덧붙이는 수정분만 보내면 안 된다. 재접속 후 실패/반려된 코드를 보려면 `contextView="submitted"`, 교체 패치의 입력을 보려면 `contextView="baseline"`을 사용한다.

같은 submissionId·같은 입력을 재전송해도 실행하지 않는다. 다른 내용으로 같은 ID를 재사용하면 거부한다. 실패 후에는 변경된 패치와 수정 가설, 새로운 ID가 필요하다. 외부 조건이 바뀌어 같은 패치를 의도적으로 재검증해야 한다면 먼저 `revise`에 근거를 기록한다.

통합 리뷰를 반려할 때는 `repairLaneId`로 담당 작업을 지정한다. 긴 diff에는 `diffTruncated`가 표시되므로 `context(paths, startLine)`으로 나머지를 읽고 리뷰한다.

## 저장과 중단 복구

- 작업의 `mass-ulw-web.json`에 계획·상태·검증·리뷰·제출 식별자를 저장한다. lane 변경안은 기존 MASS ULW artifact 저장소에 독립적으로 저장한다.
- 매 도구 호출 동안 작업 lock을 유지한다. 준비된 lane을 재구성할 때 수락된 의존 작업의 artifact를 먼저 복원한다.
- 실행 시작을 먼저 기록한다. 프로세스 중단으로 running 상태가 남으면 다음 호출에서 failed로 전환하고 중단 사실을 반환한다. 저장된 요청을 자동 재실행하지 않는다.
- 완료된 lane 재사용에는 새 코드 생성이나 검증 명령 재실행이 필요하지 않다.
- 각 lane 결과는 끝나는 대로 저장한다. 문맥도 baseline·의존 작업 증거·제출 artifact별로 캐시해 같은 코드 조회를 위한 반복 checkout을 줄인다.
- 최종 적용의 durable receipt를 유지해 적용 직후 상태 저장이 중단돼도 복구한다. 복구 시 전체 결과 tree와 원래 HEAD/index도 확인한다.
- 일반 `goal_loop` 완료와 `task_workspace(publish)`도 MASS ULW 통합 검증·리뷰와 실제 반영된 fingerprint를 검사한다. 별도 간단한 테스트를 통과시켜 진행 중인 워크플로를 건너뛸 수 없다.

## 구현 범위

이 경로는 기존 MASS ULW의 계획·workspace·artifact·쓰기 범위 검사·publication 복구를 재사용하는 **웹 대화용 상태기계**다. 기존 전체 패치 배치 도구 `mass_ulw_execute`는 호환 경로로 유지하고, `agent_guide`와 `goal_loop`는 새 대화 루프를 우선 안내한다.

추론은 현재 웹 대화에서 순차적으로 진행한다. 병렬인 부분은 제출된 독립 패치의 로컬 적용·검증이다. 여러 웹 GPT 대화를 자동으로 열어 독립 추론 에이전트로 운영하거나, 대화가 멈춘 뒤 Node가 새 모델 판단을 시작하는 기능은 포함하지 않는다.

현재는 기존 planner가 허용하는 최대 4개 lane과 로컬 Git 작업 공간을 지원한다. 검증은 발견된 `riskTier=verify` 명령이어야 한다. 실행 중 검증 script/manifest 계약 변경이나 작업 공간의 외부 수정은 감지해 거부한다. 계획 자체를 교체하려면 새 작업/계획을 사용한다. 작업 내부 구현 수정은 `revise`로 처리한다. 생성된 artifact의 자동 GC와 비동기 실행 start/status/cancel의 일반화는 후속 범위다.

파일·Git 상태 분리이며 OS 프로세스 샌드박스는 아니다. 의존성 설치와 실행 환경은 [작업 워크스페이스 안내](TASK_WORKSPACES.ko.md)를 따른다. MASS의 내부 checkout은 기존 구현대로 작업 공간의 무시된 node_modules를 링크할 수 있다.
