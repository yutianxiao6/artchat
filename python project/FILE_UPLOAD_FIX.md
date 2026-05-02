# 文件上传功能修复说明

## 问题描述
Windows 版本的后端在处理文件上传时，只能识别文件名和大小，无法识别文件内容。

## 原因分析
- 前端已经正确读取文件内容并存储在 `text_content` 字段
- 前端已经正确发送包含 `text_content` 的数据到后端
- 但后端在处理时只使用了文件元数据，没有正确提取和使用 `text_content` 的实际内容

## 修复内容

### 1. 更新数据模型 (`backend/models/schemas.py`)
为 `SmartUploadedFile` 添加了图片相关字段：
- `image_url`: 图片的 base64 data URL
- `preview_url`: 预览 URL
- `preview_path`: 本地路径

### 2. 优化文件处理逻辑 (`backend/api/chat_router.py`)
在 `smart_chat` 函数中：
- 区分图片文件和文本文件
- 图片文件：收集 `image_url` 用于多模态模型
- 文本文件：完整提取 `text_content` 内容（最多 12000 字符）
- 在 `files_summary` 中正确展示文件内容

### 3. 支持多模态消息格式
- 当上传图片时，使用 OpenAI Vision API 兼容的多模态格式
- 图片通过 `image_url` 字段传递给支持视觉的模型
- 文本文件内容通过 system 消息传递

## 测试建议
1. 上传文本文件（.txt, .md, .json 等），验证 AI 能读取并分析内容
2. 上传图片文件，验证 AI 能识别图片（需要支持视觉的模型）
3. 同时上传多个文件，验证混合处理

## 技术细节
- 前端文件读取限制：150,000 字符（约 37K tokens）
- 后端文件内容限制：100,000 字符（约 25K tokens）
- 图片格式：base64 data URL
- 消息格式：符合 OpenAI Chat Completions API 规范

## 字符限制说明
现代 AI 模型上下文窗口参考：
- GPT-4/Claude 3: 128K-200K tokens（约 40-60 万字符）
- 国产模型（GLM-4、Qwen）: 32K-128K tokens
- 1 token ≈ 4 字符（中文）或 0.75 个单词（英文）

当前限制（150K 字符）可以处理大部分常见文件，如果需要处理更大的文件，可以根据使用的模型调整限制。
