# Test fixtures

## stape-data-client.template.tpl

An unmodified copy of `template.tpl` from [stape-io/data-client](https://github.com/stape-io/data-client)
at commit `70522367b20028dc8639776755f4ef0455b96f69`, the commit the template-source registry
(`src/shared/gtm-template-sources.ts`) pins. Its SHA-256 is
`78ed188c307974de345d51493b8ee822ff2001464a5c536f507b5b11e7a22d86`, and
`src/__tests__/templateInstall.test.ts` checks that the pin, this file and the installer agree, offline.

Copyright Stape, licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>). It is used here only as test data and is not
part of the published package.

`.gitattributes` marks `*.tpl` fixtures as `-text` so line-ending conversion can never change their
bytes, and therefore their hash. When the registry pin is bumped, replace this file with the new
commit's `template.tpl` and update this note.
