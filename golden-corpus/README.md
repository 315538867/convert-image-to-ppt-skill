# Independent Golden Corpus

该目录只收录来自 renderer 之外的独立源图、参考图和作者契约。`manifest.json` 是样例入口，后续 runner 必须以 `independentReference: true` 和 corpus 内路径为前提。

`packages/core/examples/v2`、`tests/unit` 和 `dist/convert-image-to-ppt/examples` 仅用于开发 smoke 或契约测试，不得作为 golden corpus 的参考结果。

`npm run test:golden-corpus` 运行审计所需的快速子集；`npm run test:golden-corpus:full` 显式检查全部样例。两者只验证独立输入和质量门配置，转换验收必须通过 corpus runner 产生对应的 Verification Result。
