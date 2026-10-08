# Vendored design assets

This repository includes the assets used by the vendored `@siwc/react` components from the pinned DevKit source documented in [README.md](./README.md). It does not include the upstream component gallery, Electron example, README screenshots, or original Figma designs.

| Local directory | Included contents | Usage |
| --- | --- | --- |
| [siwc-react/src/assets/brand/](./siwc-react/src/assets/brand/) | Six ChatGPT SVG variants for buttons, connection cards, callouts, dialogs and usage UI | Follow the [OpenAI brand guidelines](https://openai.com/brand/). |
| [siwc-react/src/assets/icons/](./siwc-react/src/assets/icons/) | Three external-link SVG variants | Used by the vendored React components. |
| [siwc-react/src/assets/fonts/](./siwc-react/src/assets/fonts/) | Inter and Open Sans WOFF2 files and their OFL licences | Preserve the corresponding OFL files when distributing fonts. |

The local font imports are in [tokens.css](./siwc-react/src/tokens.css). Font versions, source URLs and SHA-256 hashes are retained in the upstream [third-party notices](./THIRD_PARTY_NOTICES.md); the font and OFL files are unchanged.

The upstream `fonts/provenance.json`, `fonts/google-fonts-latin.css`, dependency inventory and `licenses:check` / `licenses:generate` tooling were not included in this source subset. These are upstream references, not runnable commands or existing files in MVP Baseline Builder. Before replacing bundled assets, verify the replacement's source and licence and update the local attribution records.

The source-code licence does not grant rights to OpenAI trademarks or imply endorsement. Consult the applicable brand guidelines when adapting marks or presentation.
