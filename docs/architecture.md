# 核心架构

## 依赖方向

```text
skill-src --build--> dist/convert-image-to-ppt
                         |
Codex Skill ------------> CLI -> Core
                               -> Renderer Backend -> artifact-tool
                               -> Verification
```

`Core` 是稳定内核，不感知 Codex、PowerPoint 库、文件安装位置或图片分析模型。`Renderer Backend` 只消费已经确定的 Render Plane。`CLI` 负责绑定真实源文件、调用后端、生成证据并决定是否发布候选结果。

源码项目是唯一真相源。构建器把三个 workspace 包编译进 Skill 脚本，并从 Core 复制 Schema 与 authoring 示例。`~/.codex/skills` 中的目录只能由安装脚本生成，不允许反向修改源码。

## 六个平面

1. Source Plane：真实源文件、像素画布、摘要和来源。
2. Observation Plane：从图片测得的文字、图形、颜色、边缘和间距。
3. Ownership Plane：每个 Observation 唯一归属到语义节点。
4. Semantic Plane：递归节点树、完整样式、关系图和样式解析证明。
5. Render Plane：仅包含 text、path、image、connector、group 五种后端原语。
6. Verification Plane：候选文件、视觉、对象、编辑性和覆盖证据。

## 包边界

### `@image-to-ppt/core`

拥有 Schema、Artifact 内容寻址、任务束验证、语义到 Render Plane 编译和最终证据物化。该包不得依赖具体 PPTX 后端。

### `@image-to-ppt/renderer-pptx`

实现 PPTX 输出、OOXML 精确后处理、对象回读和编辑性探测。当前默认后端适配 Codex 提供的 `@oai/artifact-tool`；以后增加其他后端时不得修改 Core 协议。

### `@image-to-ppt/cli`

提供 `image2ppt` 与 `image2ppt-checkpoint`，负责源图绑定、资源加载、分析缓存、差异图、源覆盖、候选晋升和全部配套产物。

## 信任边界

authoring 端只能提供源事实和语义重建。实测值、证明状态、候选选择、终止状态和最终清单只能由执行器写入。任何覆盖不足、编辑性失败、包结构异常或视觉门槛失败都必须阻止成功产物发布。
