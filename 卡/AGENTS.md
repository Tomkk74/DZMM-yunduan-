# 角色卡本地写卡：给协作 Agent 的起步说明

本文件是**无对话记忆**时的入口。任何编辑器 / Agent 打开本仓库协助写卡时，先读这里，再改 `卡/<卡名>/` 下的文件。

## 这是什么

- 控制台（`console.py`，默认 http://127.0.0.1:8788）侧栏：**角色卡 → 本地写卡**。
- 每张卡一个文件夹：`卡/<卡名>/`，字段拆成 `.txt` / `.json`。
- 编辑区顶栏有 **Token 实时估算**（UTF-8÷4）：卡定义合计、常驻发送（每轮）、首轮约（常驻+开场+条件世界书上限）。
- **不要调用平台 AI 写卡**。由本机 Agent 或人手直接改文件；网页约每 700ms 轮询，文件变更会同步进表单。
- 云端保存 / 草稿 / 下线走控制台按钮：`uploadOrUpdate`、`saveDraft`、`hideCharacterCard` / `deleteDraft`。上架/下架请到官网操作。

## 标准工作流

1. 确认控制台已启动且已登录（侧栏账号）。
2. 在控制台「本地写卡」填**卡名**与**创意简述**（通用设定摘要，不是给某款工具的指令），点「创建卡夹并监听」或「新建空白」。
3. 打开 `卡/<卡名>/`，按下方文件表填写；优先改 `.txt`，不必手改 `card.json`（保存/同步时会重写）。
4. 网页表单若已打开该卡，保存后应能看到同步；也可在控制台点「保存到卡夹」。
5. 云端状态：**草稿**（可删）→ **已保存**（`uploadOrUpdate`；未上架可「隐藏」=删除）→ **审核中 / 已上架**（上架请去官网；过审后 `isPublic=true`，控制台绿标同步显示）。游戏卡不可拉到本地写卡目录。本地头像/立绘放 `assets/`，保存前会自动上传。

## 创意简述 `brief.txt`

写**角色与故事的通用摘要**：定位、时代/场景、关系与冲突、语气与尺度。  
不要写「给某某 AI 的提示」「在某某工具里打开」等工具指向性内容。

## 文件对应（对齐平台 studio/edit）

| 分类 | 主要文件 |
| --- | --- |
| 基础 | `name.txt` `description.txt` `personality.txt` `scenario.txt` `system_prompt.txt` `creator_notes.txt` `tags.txt` `creator.txt` `character_version.txt` `first_mes.txt` `brief.txt` `avatar_url.txt` |
| 世界书 | `character_book/name.txt`，条目在 `character_book/entries/001/`（`name/keys/content/enabled/constant/comment` 等） |
| 对话 | `chat_history.json`，`suggested_replies.txt`（一行一条） |
| 图片/音色 | `assets/`，`image_info.json`，`voice_settings.json` |

更细的平台字段说明：`docs/character-card-fields.md`。  
云端 tRPC 摸底（维护控制台时才需要）：`docs/character-card-local-api.md`。

## 改卡时注意

- 只改当前任务相关的卡目录；不要擅自改 `publish/` 游戏包，除非用户明确要求。
- 配置 ID、路径、命令可用英文；给创作者看的说明用中文。
- 发布/下线会动用户云端资产：未要求时不要批量隐藏或删除云端卡。
- 本地删除卡夹不可恢复；云端「下线」是 `hideCharacterCard`（公开页不可用），草稿用 `deleteDraft`。

## 和「游戏卡 / Game Studio」的区别

| | 角色卡（本目录） | 游戏卡 / 本地桥 |
| --- | --- | --- |
| 目录 | `卡/<名>/` | 项目里的 `publish/` 等 |
| 控制台入口 | 角色卡 → 本地写卡 | 游戏卡 / 云端桥接 |
| 同步对象 | 角色卡 JSON / 平台写卡 | Workbench 容器文件 |

用户若只说「写一张角色卡」，默认走本目录，不要去改游戏工程。
