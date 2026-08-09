# 本地角色卡（对齐平台写卡分类）

## 基础 basic
- `name.txt` `description.txt` `personality.txt` `scenario.txt`
- `system_prompt.txt` `creator_notes.txt` `tags.txt` `creator.txt` `character_version.txt`
- `first_mes.txt` `brief.txt` `avatar_url.txt`

## 世界书 worldbook
- `character_book/name.txt`
- `character_book/entries/001/`：`name.txt` `keys.txt` `content.txt` `enabled.txt` `constant.txt` `comment.txt` …

## 对话 dialogue
- `chat_history.json`
- `suggested_replies.txt`（一行一条）

## 图片 / 音色
- `image_info.json` `voice_settings.json`

编辑本目录文件后，控制台网页会实时同步。
