## [1.19.9](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.8...v1.19.9) (2026-06-22)

### Bug Fixes

* **desktop:** tag-suggestion rows clipped to zero height (flexbox shrink) ([c681382](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/c681382fb0a2e74132b0ea66d058bf8301e20370))

## [1.19.8](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.7...v1.19.8) (2026-06-20)

### Bug Fixes

* **desktop:** strip the AW- prefix from Google Ads conversion ids ([8858387](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/8858387a0f9e5f4355a9ca8545edfc1e9c03fca9))

## [1.19.7](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.6...v1.19.7) (2026-06-19)

### Bug Fixes

* **desktop:** give the chat assistant the current date (was assuming its training cutoff) ([5957109](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/59571094b15195538ff9da1af5eccd72fc92e781))

## [1.19.6](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.5...v1.19.6) (2026-06-16)

### Bug Fixes

* **auth:** surface identity-resolution errors and gate on Google scopes ([a448d78](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/a448d783bab7398749c2ed7a8a2d25c80ed08f5c))

## [1.19.5](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.4...v1.19.5) (2026-06-15)

### Bug Fixes

* **auth:** advertise only grantable OIDC scopes (drop full_access/offline_access) ([ed190e3](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/ed190e31a7047d0560abbe13928fa7cd1a56ec01))

## [1.19.4](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.3...v1.19.4) (2026-06-15)

### Bug Fixes

* **auth:** preserve authorize request via sessionStorage and use a clean login redirect URL ([3623808](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/362380819e610890732fabe4410b244cc4cd296f))

## [1.19.3](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.2...v1.19.3) (2026-06-15)

### Bug Fixes

* **auth:** preserve OAuth authorize params through the login redirect ([42e35eb](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/42e35eb7937ea9ac6793b3c27baf28791c305384))

## [1.19.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.1...v1.19.2) (2026-06-15)

### Bug Fixes

* **auth:** serve complete RFC 8414 authorization-server metadata ([7dcf829](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/7dcf829b957ca6e45ccca6797759efc27eecc7a1))

## [1.19.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.19.0...v1.19.1) (2026-06-15)

### Bug Fixes

* **auth:** point authorize-app login redirect back to /oauth/authorize ([ac75818](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/ac758185c6cd57f2adaecea209aa2a253799f7fd))

## [1.19.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.18.0...v1.19.0) (2026-06-12)

### Features

* **http:** gate /mcp behind a bearer token and add Render blueprint ([b411616](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/b4116166cc92f36efb610520bcfd75bb89674dac))

## [1.18.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.17.2...v1.18.0) (2026-06-12)

### Features

* **release:** publish to npm with provenance and add npx binaries ([2556268](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/255626809d295a95e45d3679e416853ba6933ee3))
* retry transient Google API failures with backoff and add full-surface smoke test ([e98d23a](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/e98d23ae4f4dcbbc25327ac3b603f410266fc8b8))

### Bug Fixes

* **ci:** drop registry-url from setup-node so NPM_TOKEN auth works ([a686025](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/a686025bada7dd8cde1571f3fda59aa9e0f0cb1d))
* **test:** import compiled modules via file:// URLs for Windows ESM ([34048e8](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/34048e80bda948d724d1163e3d0d40487e891333))

## [1.17.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.17.1...v1.17.2) (2026-06-04)

### Bug Fixes

* **security:** harden runtime worker SSRF controls and bound request bodies ([e06e432](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/e06e432dea80a81b70b5e9090adb3dea8fab5b6a))

## [1.17.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.17.0...v1.17.1) (2026-06-04)

### Bug Fixes

* **production:** support portal TypeScript target in cache and jobs ([1741734](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/17417346f0492f47eac951538cc6bd61855ebbc1))

## [1.17.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.16.0...v1.17.0) (2026-06-04)

### Features

* **production:** add async job and cache foundation ([d57ce01](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/d57ce01874b354c00e93fd71c1d1d49420c62a46))

## [1.16.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.15.0...v1.16.0) (2026-06-04)

### Features

* **production:** add observability and alerting foundation ([ff4e205](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/ff4e2052e361640ef2a9ee1dbb5df9c67edde811))

## [1.15.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.14.2...v1.15.0) (2026-06-04)

### Features

* **production:** add durable storage and security foundation ([c740945](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/c7409454abc69e1f20e916567af7fffe2f020a4f))

## [1.14.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.14.1...v1.14.2) (2026-06-04)

### Bug Fixes

* **audit:** surface structured evidence, coverage explanations, and accuracy notes ([daadbfc](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/daadbfc2a4912b9869339a9c395c40719134551b))

## [1.14.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.14.0...v1.14.1) (2026-06-04)

### Bug Fixes

* **audit:** harden evidence-scoped accuracy invariants ([dd93f13](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/dd93f137228ca9093ffebf6a2e0869f9674993d0))

## [1.14.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.13.3...v1.14.0) (2026-06-04)

### Features

* **architecture:** add scalable production foundation ([c1f0532](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/c1f053245d5b65002045c4b2d5d7b834e641c38e))

## [1.13.3](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.13.2...v1.13.3) (2026-06-04)

### Performance Improvements

* optimize production hot paths across MCP, portal, and worker ([8d28197](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/8d281974dc06976e106682a4e5c7f292fade3dcd))

## [1.13.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.13.1...v1.13.2) (2026-06-03)

### Bug Fixes

* **mcp:** start server when no Google credentials are configured ([f5d94a2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/f5d94a2fcd1e7a6e8508551c5d9377bb3f9be1fe))

## [1.13.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.13.0...v1.13.1) (2026-06-02)

### Bug Fixes

* **portal:** repair Consent v2 audit execution ([b431f7c](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/b431f7c7f8967789b669febf9021f33df51b7a90))

## [1.13.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.12.2...v1.13.0) (2026-06-01)

### Features

* **portal:** add dedicated Consent Mode v2 audit section ([cb5c11d](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/cb5c11de141d1662505796b071c59653e9c31013))

## [1.12.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.12.1...v1.12.2) (2026-06-01)

### Bug Fixes

* **portal:** make audit coverage gaps actionable ([42b50ca](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/42b50ca228984c6cddc5ec970faec941e256a91d))

## [1.12.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.12.0...v1.12.1) (2026-06-01)

### Bug Fixes

* **portal:** keep consent audit route Vercel-safe ([1858235](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/18582358a2831d5d8624d3aeed996ef65c28b605)), closes [#2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/issues/2)

## [1.12.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.11.1...v1.12.0) (2026-06-01)

### Features

* **portal:** add Consent Mode v2 runtime proof engine ([75809aa](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/75809aa6c6a3b5a02df94fcdde3dd69afc5f1d9f))

## [1.11.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.11.0...v1.11.1) (2026-06-01)

### Bug Fixes

* **portal:** prevent audit page blank screen ([deabe28](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/deabe28575612f1b565159f95dd14cde7e434196))

## [1.11.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.10.0...v1.11.0) (2026-06-01)

### Features

* **mcp:** add read-only GA4 Data API reporting tools ([e91570e](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/e91570e30e72bf65d72fc07787a8d6c5d158b3af))
* **portal:** fold runtime, sGTM and GA4 Data API into the live audit ([54638c9](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/54638c93079e9e4737209b4a5bbb4f1446cb1c92))
* **runtime-worker:** add hosted read-only runtime capture worker ([2585aaf](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/2585aafac7bf34ec3f04e721289c9af4295bb25f))

## [1.10.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.9.0...v1.10.0) (2026-06-01)

### Features

* **portal:** add sGTM visibility and runtime capture harness ([de59dec](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/de59deca3a486205916abae01fcf5890ffb2e205))

## [1.9.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.8.0...v1.9.0) (2026-06-01)

### Features

* **portal:** add GA4 Admin audit coverage ([b1b14fe](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/b1b14fe960cafa5de2d36eeb4089aa85fada6320))

## [1.8.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.7.0...v1.8.0) (2026-06-01)

### Features

* **mcp:** add GA4 Admin read tools ([14daf2f](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/14daf2f5def71e88080e94eaa93d0712d445501d))

## [1.7.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.6.1...v1.7.0) (2026-06-01)

### Features

* **mcp:** expand GTM API v2 parity coverage ([41960b4](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/41960b48854b280db7ca7dbb05b2c61473e175f5))

## [1.6.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.6.0...v1.6.1) (2026-06-01)

### Bug Fixes

* **portal:** show live GTM containers responsively ([9552e07](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/9552e07cf7d27c3c8d4bb35d8aaee2320511eabd))

## [1.6.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.5.2...v1.6.0) (2026-05-29)

### Features

* **portal:** capability-aware senior audit mode for GTM QC ([6d57918](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/6d57918fdedf957ac214755a9ee2d61ff272b885))

## [1.5.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.5.1...v1.5.2) (2026-05-29)

### Bug Fixes

* **portal:** make GTM QC audit evidence based ([4d7bc87](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/4d7bc87e6940372a01eb25aff8896db4612a85ee))

## [1.5.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.5.0...v1.5.1) (2026-05-29)

### Bug Fixes

* **portal:** inline Vercel audit QC engine ([0f680e6](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/0f680e68898f4e7e2c2abc7549d1c05faf86386e))

## [1.5.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.8...v1.5.0) (2026-05-29)

### Features

* **portal:** add Google account profile and logout ([d302f21](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/d302f21075c2603faf0af414853140c0454c764d))

## [1.4.8](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.7...v1.4.8) (2026-05-29)

### Bug Fixes

* **portal:** make GTM API routes Vercel-safe ([4bc5fd1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/4bc5fd16653587862384175b116e7c13db5b29ef))

## [1.4.7](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.6...v1.4.7) (2026-05-29)

### Bug Fixes

* **portal:** harden GTM serverless routes ([09e49fa](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/09e49fafcb7b432d59f568ece174826d0866efd1))

## [1.4.6](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.5...v1.4.6) (2026-05-29)

### Bug Fixes

* **portal:** handle GTM API error responses once ([b50ed9e](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/b50ed9e740d4d6e785437c001f69e1fbc17d73bb))

## [1.4.5](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.4...v1.4.5) (2026-05-29)

### Bug Fixes

* **portal:** route OAuth callback to a valid hash-router URL ([d23ba1e](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/d23ba1e32607efdb904edc61beda3e1d2eb2648b))

## [1.4.4](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.3...v1.4.4) (2026-05-29)

### Bug Fixes

* **portal:** harden OAuth start/callback/logout routes on Vercel ([904b298](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/904b298b049b49994aa01d774d995b0b147f7009))

## [1.4.3](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.2...v1.4.3) (2026-05-29)

### Bug Fixes

* **portal:** stabilize OAuth status endpoint ([43424b3](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/43424b3ab7c1bec07417c49c5d43cb4ffea69bcf))

## [1.4.2](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.1...v1.4.2) (2026-05-29)

### Bug Fixes

* **portal:** harden Vercel API health and auth status ([d8d088c](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/d8d088c27082a0f16cf38be5c73e66218d68068a))

## [1.4.1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.4.0...v1.4.1) (2026-05-29)

### Bug Fixes

* **portal:** correct Vercel routing for Vite SPA and API functions ([59205a1](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/59205a1f3e6eb4a7639d235f0b66845ee06a30b6))

## [1.4.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.3.0...v1.4.0) (2026-05-29)

### Features

* **portal:** support Vercel deployment ([096ab9a](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/096ab9af6ea4ff0832d92037fe78637cb9331b25))

## [1.3.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.2.0...v1.3.0) (2026-05-29)

### Features

* **portal:** add live GTM QC flow ([3f32b73](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/3f32b730c15ceb0dab662260423ddaf19eeb0902))

## [1.2.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.1.0...v1.2.0) (2026-05-29)

### Features

* **portal:** add browser-based GTM approval portal ([5714731](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/5714731381222c4189d7c2a7ded7c25a9e7dcd9e))

## [1.1.0](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/compare/v1.0.0...v1.1.0) (2026-05-29)

### Features

* **auth:** simplify Google OAuth onboarding ([aa5f366](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/commit/aa5f366704a36f8f5e59b04935672d2d50d556f8))
