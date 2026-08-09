# 空白卡应有文件

新建 `卡/<卡名>/` 时按此清单建空文件（内容按 `填写顺序.md` 填写）。  
`_模板` 本身不是一张卡，不要往本目录写角色正文。

```
卡/<卡名>/
  brief.txt
  name.txt
  description.txt
  personality.txt
  scenario.txt
  system_prompt.txt
  creator_notes.txt
  tags.txt
  creator.txt
  character_version.txt
  first_mes.txt
  suggested_replies.txt
  avatar_url.txt
  chat_history.json          # [] 或合法开场结构
  alternate_greetings.json   # []
  image_info.json            # []
  voice_settings.json        # null 或 {}
  character_book/
    name.txt                 # 世界设定
    entries/
      001/                   # 常驻：世界观 / 核心关系
        name.txt             # 例：核心关系
        keys.txt             # 常驻可空
        content.txt
        enabled.txt          # true
        constant.txt         # true
        comment.txt
        insertion_order.txt
        position.txt
        priority.txt
        entry.json           # 可选；无则控制台同步时生成
      002/                   # 常驻：玩家设定（{{user}}）——必写
        name.txt             # 玩家设定
        keys.txt             # 可空
        content.txt          # 关系 + 可覆盖默认 +「玩家优先」
        enabled.txt          # true
        constant.txt         # true
        comment.txt
        insertion_order.txt
        position.txt
        priority.txt
      003/                   # 起：触发条（constant=false，必填 keys）
  assets/                    # 头像/立绘
  README.md                  # 可选
```

玩家设定写法见 `_模板/写作规范.md`「玩家设定（常驻世界书）」；顺序见 `填写顺序.md` 第 2 步。

`chat_history.json` 最小合法例：

```json
[
  {
    "id": "1",
    "name": "开场对话",
    "messages": [
      {"role": "assistant", "content": "（开场白）"}
    ]
  }
]
```
