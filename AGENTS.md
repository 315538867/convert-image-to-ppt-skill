# 项目约定

- 全部沟通、说明和用户可见错误使用中文。
- Git 提交遵循 Conventional Commits，提交信息使用中文。
- `packages/core` 不得依赖任何 PPTX 后端、图片处理库或 Codex 宿主运行库。
- `packages/renderer-pptx` 只消费 Core 的 Render Plane，不得从图片猜测布局。
- `packages/cli` 负责编排、缓存和验收，不得修改源图事实来绕过验证。
- `skill-src` 是 Skill 模板源码，`dist/convert-image-to-ppt` 是生成物；禁止直接修改 `dist` 或已安装 Skill。
- 修改 Schema、编译器、渲染器或 Skill 模板后必须执行 `npm test` 和 `npm run audit`。
- 不得把整页截图、文字截图或简单图标截图作为可编辑重建的成功结果。
