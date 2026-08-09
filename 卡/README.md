# 本地角色卡目录

每个角色：`卡/<卡名>/`  
规范与冷启动模板：仓库根目录 [`_模板/`](../_模板/README.md)

## 新对话 / 换 AI

1. 打开 [`../_模板/README.md`](../_模板/README.md)  
2. 复制 [`../_模板/开聊提示词.txt`](../_模板/开聊提示词.txt)  
3. 填上卡名和简述发送即可  

Agent 入口：[`AGENTS.md`](./AGENTS.md) → [`_模板/AGENTS.md`](../_模板/AGENTS.md)

## 分类（成品卡）

| 平台步骤 | 本地文件 |
| --- | --- |
| 基础 basic | `name/description/personality/scenario/system_prompt/creator_notes/tags/...txt` |
| 世界书 worldbook | `character_book/`：`001` 世界观常驻、`002` 玩家设定常驻、`003+` 触发 |
| 对话 dialogue | `chat_history.json`、`first_mes.txt`、`suggested_replies.txt` |
| 图片/音色 | `avatar_url.txt`、`image_info.json`、`voice_settings.json`、`assets/` |

字段结构：`docs/character-card-fields.md`  
创作规范：`_模板/写作规范.md`（与 `docs/character-card-writing-guide.md` 同源）
