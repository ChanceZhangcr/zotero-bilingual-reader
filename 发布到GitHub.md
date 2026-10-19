# 发布到 GitHub（一步步来，照抄就行）

下面假设你已经装了 [Git](https://git-scm.com/downloads)（Windows 装完有个 Git Bash，
或者在 PowerShell 里也能用）。没装也能发 —— 见最后的「不想用命令行」。

---

## 一、先把占位地址改掉

插件里有三处写着 `local` 的占位地址，改成你自己的 GitHub 用户名和仓库名：

1. `src/manifest.json` 里 `applications.zotero.update_url`
   ```json
   "update_url": "https://raw.githubusercontent.com/你的用户名/仓库名/main/update.json"
   ```
2. `src/manifest.json` 里 `homepage_url`
3. `update.json` 里两个 `YOUR_NAME` / `YOUR_REPO`

改完重新打包：

```bash
node build.mjs
```

> `build.mjs` 会在 update_url 还是占位地址时提醒你一句。

---

## 二、建仓库并推上去

在 GitHub 上点 **New repository**，名字比如 `zotero-bilingual-reader`，
**不要**勾选 "Add a README file"（我们本地已经有了）。

然后在插件目录里：

```bash
cd C:\Users\22124\Documents\deepseek-harness\default-workspace\zotero-bilingual

git init
git add .
git commit -m "双语论文助手 v1.4.1：一键把英文论文翻成中文，左右对照 + 导出中英对照 PDF"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

推上去之后打开仓库首页，就是你想要的那个页面了（README.md 自动渲染）。

`.gitignore` 已经把 `build/`、`dist/*.xpi`、`recon/` 排除掉了，
所以仓库里只会有源码和文档。

---

## 三、发 Release（xpi 放这里）

1. 仓库页面右侧点 **Releases** → **Draft a new release**
2. **Choose a tag** 输入 `v1.4.1` → 点 "Create new tag"
3. 标题填 `v1.4.1`
4. 说明随便写，或者直接把 `CHANGELOG.md` 里这一版的内容贴过去
5. **Attach binaries** 把 `build/bilingual-reader_1.4.1.xpi` 拖进去
6. Publish release

⚠️ 文件名必须和 `update.json` 里 `update_link` 写的一致：

```
https://github.com/你的用户名/仓库名/releases/download/v1.4.1/bilingual-reader_1.4.1.xpi
```

---

## 四、确认自动更新能用

把 `update.json` 单独推一次（改过的话）：

```bash
git add update.json src/manifest.json
git commit -m "填上真实的仓库地址"
git push
```

在浏览器里打开这个地址，应该能看到 JSON：

```
https://raw.githubusercontent.com/你的用户名/仓库名/main/update.json
```

以后发新版本时：改 `manifest.json` 的 version → `node build.mjs` → 发新 Release
→ 更新 `update.json` 里的 `version` 和 `update_link` → push。
已经装了插件的人，Zotero 里就会提示升级。

---

## 五、不想用命令行？

也能发：在 GitHub 网页上 **Add file → Upload files**，
把插件目录里除了 `build/`、`dist/`、`recon/` 之外的文件拖进去就行。
Release 也是网页上点几下的事。

只是没有 `.gitignore` 帮你过滤，注意**别把 `recon/`**（里面是别人的插件包）
**和 `build/`** 传上去。

---

## 顺手可以做的

- 仓库 **About** 里填一句简介 + 话题标签：
  `zotero` `zotero-plugin` `translation` `chinese` `pdf` `bilingual`
- 在 README 顶部把 star / release 徽章换成动态的：
  ```markdown
  ![release](https://img.shields.io/github/v/release/你的用户名/仓库名)
  ![stars](https://img.shields.io/github/stars/你的用户名/仓库名)
  ![downloads](https://img.shields.io/github/downloads/你的用户名/仓库名/total)
  ```
- 想收 issue 的话，`Issues` 保持开启，模板可以以后再加
