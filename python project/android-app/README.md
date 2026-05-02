# Android 版本（独立目录）

这个目录用于制作 **安卓 App 内显示版** 的流绘，**不影响现有 Windows 版本**。

## 路线

- 现有 Windows 版：保留 `python project/` 的 Python + FastAPI + 浏览器/桌面打包方案
- 安卓版：使用 `android-app/` 独立实现
  - App 内 WebView 显示
  - 不打开系统浏览器
  - 前端直连 API
  - 配置保存在本地

## 当前目录结构

- `web/`：安卓端静态前端
- `package.json`：Capacitor 依赖定义
- `capacitor.config.ts`：Capacitor 配置

## 重要说明

**不要在 VMware 共享目录里执行 `npm install`。**

这个目录所在的共享盘不支持 npm 创建 symlink，所以会报：

- `ENOTSUP: operation not supported on socket, symlink ...`

正确做法是：

1. 把 `android-app/` 复制到你本机正常磁盘
2. 在正常磁盘里执行 npm / Capacitor / Android Studio 操作

例如复制到：

- Windows: `D:\liuhui-android-app\`
- Linux: `/home/你的用户名/liuhui-android-app/`

---

# 一步一步生成 Android App

## 1）准备环境

你需要先装好：

- Node.js 20+
- npm 10+
- Android Studio
- Android SDK
- JDK 17（Android Studio 一般自带）

可选检查：

```bash
node -v
npm -v
```

---

## 2）复制目录到正常磁盘

把这个目录复制出去：

```text
python project/android-app/
```

例如复制后变成：

```text
D:\liuhui-android-app
```

---

## 3）安装依赖

进入安卓目录执行：

```bash
cd android-app
npm install
```

如果你已经复制到了新目录，比如 Windows：

```bash
cd D:\liuhui-android-app
npm install
```

---

## 4）创建 Android 原生工程

如果 `npx cap add android` 报 `defineConfig is not a function`，说明本地 Capacitor CLI 对 `capacitor.config.ts` 的写法兼容性有差异。当前仓库已经改成更兼容的纯对象导出写法。确保你复制的是最新 `android-app/` 目录后，再执行：

```bash
npx cap add android
```

如果之前已经 add 过，就不用重复执行。

---

## 5）同步 Web 资源到 Android 工程

```bash
npx cap sync android
```

每次你修改 `web/` 里的前端内容后，都要重新执行一次：

```bash
npx cap sync android
```

---

## 6）用 Android Studio 打开

```bash
npx cap open android
```

然后 Android Studio 会打开原生工程。

---

## 7）运行到手机或模拟器

在 Android Studio 里：

- 连接安卓手机（打开开发者模式 + USB 调试）
- 或启动模拟器
- 点击 Run

---

## 8）生成 APK

在 Android Studio 菜单里：

- `Build`
- `Build Bundle(s) / APK(s)`
- `Build APK(s)`

生成后可以在提示里找到 APK 输出位置。

---

# 常见问题

## 1）页面打开但功能异常

先确认你已经重新同步：

```bash
npx cap sync android
```

否则 Android 工程里还是旧前端资源。

## 2）首次打开没有配置

这是正常的。安卓版现在默认：

- 不带真实配置
- 首次启动让你自己填写 API Base / Key / Model

## 3）图片或聊天请求失败

先检查：

- API Base 是否正确
- Key 是否正确
- 模型名是否正确
- 供应商是否支持 OpenAI 兼容接口

## 4）如果要访问非 HTTPS 接口

安卓 WebView 对明文 HTTP 更敏感。建议优先使用：

- `https://...`

如果必须用 `http://`，后面可能还要加 Android 明文流量配置。

---

# 当前已完成的安卓适配

- 独立安卓目录
- WebView App 内显示路线
- 本地配置存储
- 聊天直连 API
- 图片直连 API
- 画布状态本地存储
- 第一轮移动端样式适配
- 第二轮移动端交互优化
- 安卓运行时补丁

# 后续建议

接下来最值得做的是：

1. 真机联调聊天流式显示
2. 真机联调图片生成返回格式
3. 优化画布触摸交互（拖拽 / 长按 / 缩放）
4. 补 App 图标、启动页、包名、签名配置

## 发布说明

详细发布流程见：

- `ANDROID_RELEASE.md`
