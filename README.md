# DZMM 本地开发控制台

**交流群（Discord）**：[https://discord.gg/da9PMeAGGK](https://discord.gg/da9PMeAGGK)

独立可分享的 **Local Bridge**：在浏览器里登录 DZMM 账号、绑定 Workbench 角色卡、拉取云端容器到本机，并内嵌启动本地预览。适合需要「改本地文件 → 预览 → 同步/发布」的创作者。

> 仓库地址：<https://github.com/Tomkk74/DZMM-yunduan->

---

## 界面预览

### 总览 · 云端桥接

左侧功能区 + 右侧大屏预览。未启动预览时中间为空；连接云端并启动预览后，可在此直接看游戏画面。

![总览：云端桥接](docs/images/01-overview.png)

### 账号登录

填写 DZMM 邮箱与密码。可勾选「保存密码到本机 `.env`」（默认勾选）。凭据只写在本机，不会上传到本仓库。

![账号登录](docs/images/02-login.png)

### 项目配置

三项核心配置：

| 字段 | 说明 |
|---|---|
| `character_id` | Workbench 地址栏里的角色卡 ID |
| 本地项目路径 | 含 `publish/` 的游戏根目录 |
| 预览端口 | 默认 `8791`，需端口空闲 |

保存后可点 **连接编辑器** 验证权限，或打开 **Workbench**。

![项目配置](docs/images/03-project.png)

### 拉取容器

把云端容器整包下载到本地路径。路径留空时默认 `../{character_id}`。支持进度条与「重拉失败文件」。

![拉取容器](docs/images/04-pull.png)

### 运行状态

查看当前登录态、配置与桥接摘要（只读诊断）。

![运行状态](docs/images/05-status.png)

### 全屏预览 · 悬浮球

点 **收起 / 全屏** 后侧栏隐藏，左下角出现可拖动的悬浮菜单：**菜单 / 刷新 / 发布**。

![全屏与悬浮发布](docs/images/06-fullscreen-fab.png)

---

## 能做什么

1. **登录续期** — 邮箱密码登录，自动维护 cookie / token  
2. **绑定项目** — `character_id` + 本地目录 + 预览端口  
3. **拉取容器** — 云端 Files 整包落到本地，便于离线改资源  
4. **本地预览** — 控制台内嵌 iframe，或新窗口打开  
5. **同步 / 发布** — 改完后可 sync 回容器；确认后再「发布到线上」

---

## 快速开始

### 环境

- Windows（附带 `.bat`；其它系统可直接 `python console.py`）
- [Python 3](https://www.python.org/)（安装时勾选 *Add to PATH*）
- 自己的 DZMM 账号，且对该角色卡有 Game Studio 权限

### 启动控制台

```bat
git clone https://github.com/Tomkk74/DZMM-yunduan-.git
cd DZMM-yunduan-
start.bat
```

或：

```bat
python console.py --port 8788
```

浏览器打开：`http://127.0.0.1:8788/`  
（加 `--no-open` 可禁止自动弹窗）

### 推荐操作顺序

1. **账号登录** → 登录成功（左上角状态灯变化）  
2. **项目配置** → 填 `character_id`、本地路径、预览端口 → **保存配置** → **连接编辑器**  
3. （可选）**拉取容器** → **开始拉取**，等进度完成  
4. **启动预览** → 右侧出现本地游戏；可 **刷新预览 / 新窗口 / 全屏**  
5. 本地改 `publish/` 等文件后，用命令行 `sync`（见下）推回容器；确认无误再点 **发布到线上**

---

## 命令行（可选）

双击脚本或在仓库根目录执行：

| 脚本 | 作用 |
|---|---|
| `start.bat` | 打开 Web 控制台 |
| `status.bat` | 查看当前配置 / 登录态 |
| `pull.bat` | 拉取容器 |
| `sync.bat` | 同步本地到容器 |
| `preview.bat` | 单独起本地预览服务 |

示例：

```bat
python lib\dzmm_studio.py login --email you@mail.com --password "***"
python lib\dzmm_studio.py status --character-id <CHARACTER_ID>
python lib\pull_container.py --character-id <CHARACTER_ID>
python lib\dzmm_studio.py sync --character-id <CHARACTER_ID> --message "sync"
```

拉取/同步目录取自网页保存的「本地项目路径」；留空则默认 `../{character_id}`。

---

## 目录结构

```text
.
├── console.py              # Web 控制台入口
├── start.bat / sync.bat …  # 快捷脚本
├── web/                    # 控制台前端
├── lib/
│   ├── dzmm_studio.py      # 登录、续期、sync、publish
│   ├── pull_container.py   # 整包拉取
│   └── dzmm_preview_server.py
├── config.example.json     # 配置示例（复制为 config.json）
├── .env.example            # 凭据示例（复制为 .env）
├── docs/images/            # README 截图
└── LICENSE                 # MIT
```

| 本机文件（勿提交） | 说明 |
|---|---|
| `.env` | 邮箱 / 密码 / cookie |
| `config.json` | character_id、项目路径、端口 |

`.gitignore` 已忽略上述文件。分享仓库前请确认没有误加。

---

## 配置示例

复制示例后按自己的环境修改：

```bat
copy config.example.json config.json
copy .env.example .env
```

`config.example.json`：

```json
{
  "character_id": 0,
  "project_path": "D:\\path\\to\\your-game",
  "preview_port": 8791
}
```

也可只在网页里填写并保存，无需手改文件。

---

## 安全与注意

- **不要把 `.env` 发给任何人**，也不要提交到 Git  
- 发布会把容器内容正式上线，操作前请自行确认  
- 对接的是平台私有接口，平台改版后本工具可能需要更新  
- 建议仅在受信任的协作者之间分享本仓库  

---

## 常见问题

**打不开 `8788`？**  
确认已装 Python 3，且端口未被占用；可改：`python console.py --port 8790`。

**连接编辑器失败？**  
检查账号是否对该 `character_id` 有 Studio 权限；Workbench 是否已选过模板。

**预览空白？**  
本地路径是否指向含 `publish/index.html` 的目录；先 **停止** 再 **启动预览**；看「运行状态」有无报错。

**拉取很慢 / 部分失败？**  
可点「重拉失败文件」；网络不稳时多试一次。

---

## License

MIT © Tomkk74
