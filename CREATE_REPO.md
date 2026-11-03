# 请先在 GitHub 上建空仓库

Cursor / 本助手**不能**替你在 GitHub 上「新建」空仓库。请用账号 **keblue** 建一个公开空仓，然后再把本目录推上去。

## 步骤

1. 打开 https://github.com/new
2. Owner：`keblue`
3. Repository name：`pi-bot-cn`
4. 选 **Public**
5. **不要**勾选 “Add a README / .gitignore / license”（本地已有，避免首推冲突）
6. 点 Create repository

建好后在本机（或服务器）执行类似：

```bash
cd /path/to/pi-bot-cn/repo   # 即本骨架目录
git init
git add .
git commit -m "chore: initial public skeleton for pi-bot-cn"
git branch -M main
git remote add origin https://github.com/keblue/pi-bot-cn.git
git push -u origin main
```

README 与 package.json 已标明由微信公众号「AI之境」设计与维护。

> 本文件仅给仓库维护者看；推送到 GitHub 后可保留或删除。
