# DZMM 写卡本地化：API 摸底（只读探测）

探测时间：本机登录态对 `https://www.dzmm.ai/studio/edit` 前端包反查 + tRPC 实测。  
入口页：[studio/edit](https://www.dzmm.ai/studio/edit)

## 结论

**可以本地写、本地发。**  
写卡不是 Game Studio 的 `gamefy/editor` + 容器文件，而是 **tRPC `studio.*` / `card.*`**，载荷为 **SillyTavern 风格 `chara_card_v3` JSON**（字段含 `name/description/personality/scenario/first_mes/character_book/...`，另有 `gamefy` 扩展）。

## 已确认可用的读接口（HTTP 200）

| Procedure | 作用 | 示例入参 |
|---|---|---|
| `studio.getCharacters` | 我的角色列表（含草稿/卡） | `{}` |
| `studio.getCharacterCard` | 按 ID 取完整卡 | `{ "id": 3374995 }` |
| `studio.getDraft` | 取草稿 | `{ "id": <draftId> }`（无效 id → 404「草稿不存在」） |
| `studio.getGameStats` | 创作侧统计 | `{}` |
| `studio.getMyVoices` / `studio.getVoices` | 音色 | `{}` |
| `card.getForChat` | 聊天用卡摘要 | `{ "cardId": 3374995 }` |

调用形态：

```
GET  /api/trpc/<procedure>?batch=1&input=<urlenc {"0":{"json":{...}}}>
POST /api/trpc/<procedure>?batch=1   body: {"0":{"json":{...}}}
```

鉴权：现有 `.env` cookie + Bearer（与本地桥相同）。

## 写/发（从前端包确认，尚未做写入实测）

| Procedure | 前端用途 |
|---|---|
| `studio.saveDraft` | 自动保存草稿 `{ rawData, id?, baseVersion? }` |
| `studio.deleteDraft` | 删草稿 `{ id }` |
| `studio.uploadOrUpdate` | **发布/更新角色卡** `{ rawData, db_id? }`（`createOrUpdateCharacter`） |
| `studio.hideCharacterCard` | 隐藏卡 `{ id }` |
| `studio.uploadCharacterImage` | 上传立绘/封面 |

图片相关：

- 公共桶：`pub_card_images`（Supabase storage）
- 辅助：`/api/character-card-image`

## 编辑模式（前端状态机）

- `create`：新建
- `draft:<id>`：草稿
- `character:<id>`：已发布卡再编辑  
发布成功后跳转 `/character/$id`。

## 与现有本地桥的关系

| 现有 `dzmm-local-dev` | 写卡 |
|---|---|
| `POST /api/gamefy/editor` + 容器 sync | **另一条产品线**（游戏包） |
| 需要已有 `character_id` | 写卡可先 `uploadOrUpdate` 拿新 ID，再绑 Game Studio |

## 已落地（本地控制台）

1. `lib/dzmm_character.py`：本地 `cards/*.json` + AI completions 写卡 + 云端只读 list/pull
2. 控制台侧栏「角色卡 → 本地写卡」：AI 写卡并保存、编辑、刷新列表、拉取云端到本地
3. API：`/api/card/list|get|new|save|ai|cloud|pull`
4. 云端写入已接：`POST /api/card/publish` → 本地图 + `uploadOrUpdate` / `saveDraft`；上架/下架请官网（控制台不提供按钮）；列表绿标读角色页 `isPublic`/`publishStatus`；游戏卡 pull 会被拒绝

## 探测产物目录

`dzmm-local-dev/.probe-character-api/`（JS 包、probe JSON；勿提交敏感卡内容到公开仓库）
