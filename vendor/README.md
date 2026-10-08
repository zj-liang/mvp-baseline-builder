# Official Sign in with ChatGPT DevKit

Source: https://github.com/openai/sign-in-with-chatgpt-devkit

Pinned upstream commit: `f723814abdccec135b519c451fb6e1992ee5e933`.

The `packages/local/src` and `packages/react/src` sources and licenses are included for a reproducible local installation. See the accompanying noncommercial licenses before redistribution. No Electron/native paste example is included.

Local modifications (2026-10-04): package manifests expose TypeScript sources for tsx/Vite; `StreamResponseOptions` and the request serializer accept optional strict JSON Schema `text.format` and `reasoning.effort` (low/medium/high), as documented by the public Responses API. The inference transport deadline is ten minutes to accommodate high-effort full reviews; caller cancellation and shorter caller deadlines still apply. OAuth, ID-token validation, storage, refresh, revocation and stream completion checks are unchanged.

Documentation clarification (2026-10-08): [ASSETS.md](./ASSETS.md) now describes the assets actually included here. [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) is a retained upstream snapshot and includes notices for upstream examples that are not part of this application; its licence/copyright text remains unchanged. Upstream gallery, provenance helper files and notice-generation scripts are not vendored. Use [../package.json](../package.json) and [../pnpm-lock.yaml](../pnpm-lock.yaml) for this application's dependencies; this documentation update does not change vendored code, assets or licences.

Publication notices (2026-10-09): the two modified package manifests now carry a description identifying their local source-export modifications. The previously modified `siwc-local/src/types.ts` and `siwc-local/src/responses.ts` carry prominent source comments identifying the changes and original licence. These notices do not change executable logic, dependencies or exports. DevKit files and their modifications remain subject to the included upstream licence, separately from the application's [licensing scope](../docs/LICENSING.md).
