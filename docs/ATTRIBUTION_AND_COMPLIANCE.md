# Attribution, licensing, and OpenAI compliance notes

_Last reviewed: 2026-08-27. This document is a project-maintainer note, not legal advice._

## 1. Upstream origin

This repository is a modified GitHub fork of the original **ChatGPT To Codex** project by **ezBuilder**:

- Upstream repository: https://github.com/ezBuilder/chatgpt2codex
- Upstream author metadata: `ezBuilder`
- Upstream package metadata currently states: `Copyright 2026 ezBuilder. All rights reserved.`

The base local MCP/Actions runtime, desktop launchers, project-scoped coding tools, connector model, and related product structure originated in the upstream project.

This fork, maintained at `Anjingyeong/jk-mcp`, adds substantial follow-on work including persistent project/work-session state, structured goal/task/pending/decision tracking, same-project work-session isolation, fast resume and source hydration, SHA-256/CAS patch handoff, bounded/lazy validation, session ranking/fused select+resume flows, serialized session updates, Windows browser E2E work, host-local runtime overrides, JK branding, and OMO delegation. See `docs/HARNESS_DEVLOG.md` for the implementation history.

Attribution does **not** transfer ownership of the upstream code and does **not** create a software license.

## 2. Upstream licensing status

As of 2026-08-27, the upstream repository does not expose a root `LICENSE` file, and its `package.json` says `All rights reserved`.

GitHub's Terms of Service allow users to view and fork public repositories through GitHub's service. However, GitHub's own licensing documentation also states that, without a software license, default copyright law applies and others generally do not receive the usual open-source rights to reproduce, distribute, or prepare derivative works outside the rights granted by GitHub's service.

Relevant sources:

- GitHub Terms of Service, D.5 (public repository fork rights): https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- GitHub Docs, "Licensing a repository": https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- Upstream repository: https://github.com/ezBuilder/chatgpt2codex

### Practical consequence for this fork

The JK maintainer has obtained direct permission from ezBuilder to redistribute this modified fork. The private permission correspondence is retained by the maintainer and is not reproduced in this public repository.

That permission addresses JK's redistribution of the modified fork; it does **not** change the upstream repository's public license status, does not make the upstream code MIT/Apache/open source, and should not be presented as a general relicensing grant to third parties. Attribution to the upstream author remains in package and repository metadata.

The npm distribution and optional binary releases should therefore retain the upstream attribution and this compliance notice. If the scope of distribution changes materially (for example, commercial sublicensing or relicensing), re-check the permission terms before making that change.

## 3. OpenAI / ChatGPT / MCP usage

The runtime is designed as a user-directed local MCP/Actions execution harness. It does not embed an OpenAI LLM API client for its coding loop; ChatGPT performs the model reasoning and sends user-authorized App/MCP requests to the local runtime.

OpenAI's current App Developer Terms expressly cover custom apps, connectors, actions, and MCP servers. They require, among other things, that apps comply with law and policy, maintain appropriate security, avoid deceptive behavior, and not access OpenAI systems in an unauthorized manner.

Relevant sources:

- OpenAI App Developer Terms (updated 2026-07-09): https://openai.com/policies/developer-apps-terms/
- OpenAI Terms of Use (effective 2026-01-01): https://openai.com/policies/terms-of-use/
- OpenAI Brand Guidelines: https://openai.com/brand/

### Intended compliance boundary

This project is **not intended to**:

- bypass or circumvent ChatGPT/Codex rate limits, usage limits, safety systems, or protective measures;
- automatically or programmatically extract ChatGPT conversations or model Output from private ChatGPT interfaces;
- reverse engineer OpenAI models or private service internals;
- share user account credentials;
- imply that OpenAI created, certifies, supports, sponsors, or endorses this project.

The phrase "no separate per-token API billing path" means only that this local runtime does not itself make an additional metered LLM API call for the coding loop. ChatGPT usage still remains subject to the user's plan, model availability, usage limits, and OpenAI terms. It must not be marketed as "unlimited," "tokenless AI," or a way to evade product limits.

## 4. Trademark / product-name concern

`ChatGPT`, `GPT`, `Codex`, OpenAI names/logos, and other OpenAI marks belong to OpenAI. The current project name was inherited from the upstream repository.

OpenAI's App Developer Terms prohibit implying endorsement or partnership, and the Brand Guidelines restrict use of OpenAI marks. The Brand Guidelines specifically state that OpenAI does not permit the GPT brand to be used in app, product, developer, or company names and cautions against model names in app titles.

Because the inherited name **"ChatGPT To Codex"** contains OpenAI marks, a disclaimer alone may not eliminate trademark/brand-guideline risk. Before independently branding, listing, marketing, or commercially distributing this fork, the safer path is to rename the fork to a neutral project name and describe compatibility with ChatGPT/OpenAI services factually in the documentation, or obtain permission from OpenAI.

This fork should therefore be described as:

> An independent, unofficial modified fork. Not affiliated with, endorsed by, sponsored by, or partnered with OpenAI.

## 5. What is reasonably supportable today

Based on the cited terms, the **technical pattern** of a user-authorized MCP/Actions server that receives requests from ChatGPT and performs local project actions is within the category contemplated by OpenAI's App Developer Terms. Nothing reviewed here says that a normal MCP connector must use a separate LLM API key.

The primary issues identified are not the basic MCP architecture. They are:

1. **upstream copyright/licensing uncertainty** because ezBuilder currently publishes no software license while stating `All rights reserved`;
2. **branding/trademark risk** from the inherited `ChatGPT To Codex` name;
3. wording that could suggest **quota/rate-limit circumvention**, which this fork should avoid;
4. normal privacy/security obligations for any connector that handles user files and App Requests.

This is a good-faith compliance review of publicly available terms as of the date above, not a legal opinion. Terms and policies can change.