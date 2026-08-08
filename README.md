# DZMM 本地开发控制台

独立可分享的本地桥接工具：用网页填写邮箱/密码与项目信息并登录，连接 DZMM Game Studio。

## 别人怎么用

1. 安装 [Python 3](https://www.python.org/)（勾选 Add to PATH）
2. 解压/克隆本目录
3. 双击 `start.bat`（或 `python console.py`）
4. 浏览器打开自动弹出的页面：`http://127.0.0.1:8788/`
5. 填写：
   - 邮箱、密码
   - `character_id`（Workbench 地址栏里的卡 ID）
   - 本地项目路径（含 `publish/` 的游戏目录）
6. 点 **登录** → 再点 **连接编辑器** 验证
7. 需要整包本地开发时：点 **开始拉取**（容器完整项目下载到本地路径）
8. 点 **启动预览**：控制台内嵌本地预览，也可「新窗口打开」

凭据保存在本机 `.env`（已 gitignore），**不要把 `.env` 发给任何人**。

## 命令行（可选）

```bat
python lib\dzmm_studio.py login --email you@mail.com --password "***"
python lib\dzmm_studio.py status --character-id <CHARACTER_ID>
python lib\pull_container.py --character-id <CHARACTER_ID>
python lib\dzmm_studio.py sync --character-id <CHARACTER_ID> --message "sync"
```

也可双击 `pull.bat`。拉取/同步目录来自网页「本地项目路径」；留空则默认 `../{character_id}`。

## 目录

| 路径 | 说明 |
|---|---|
| `console.py` / `web/` | Web 登录与配置台 |
| `lib/dzmm_studio.py` | 登录、续期、sync、publish |
| `.env` | 本机密钥（勿分享） |
| `config.json` | character_id / 项目路径等 |

## 注意

- 需要对方自己的 DZMM 账号，且对该卡有 Studio 权限
- 对接的是平台私有接口，平台改版后可能要更新本工具
- 仅建议在受信任的人之间分享本仓库（不含 `.env`）
