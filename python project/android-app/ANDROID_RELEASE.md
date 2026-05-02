# Android 发布说明

这份文档用于把 `android-app/` 从可运行工程推进到 **可发布 APK / AAB**。

## 1. 包名（Application ID）

当前默认包名：

```text
com.liuhui.app
```

你可以改成自己的，例如：

```text
com.yourname.liuhui
```

### 需要同步修改的地方

#### 1）`capacitor.config.ts`

```ts
appId: 'com.liuhui.app'
```

改成你的包名。

#### 2）Android Studio / Gradle 工程里的 `applicationId`

通常在：

```text
android/app/build.gradle
```

找到：

```gradle
applicationId "com.liuhui.app"
```

改成同一个包名。

#### 3）如有需要，调整 Java/Kotlin 包路径

Capacitor 默认会按 appId 生成对应包路径；如果后续手动改过包结构，要在 Android Studio 里同步重构。

---

## 2. 应用名

默认应用名：

```text
流绘
```

可修改：

```text
android-config/app/src/main/res/values/strings.xml
```

把：

```xml
<string name="app_name">流绘</string>
```

改成你想显示的名称。

---

## 3. 图标

当前已经给了一个可用的占位图标模板：

- `mipmap-anydpi-v26/ic_launcher.xml`
- `drawable/ic_launcher_foreground.xml`

### 更推荐的正式做法

在 Android Studio 中使用：

- `File`
- `New`
- `Image Asset`

然后导入你正式的图标 PNG / SVG，生成多尺寸 launcher icon。

这样会比手工改资源更稳。

---

## 4. 网络请求

当前模板已加：

- `INTERNET` 权限
- `network_security_config`

默认建议：

- API Base 尽量使用 `https://...`

如果你要连本地开发服务，已经给以下地址留了例外：

- `10.0.2.2`
- `127.0.0.1`
- `localhost`

---

## 5. 生成 Release 签名

发布 APK / AAB 前，需要先准备 keystore。

### 创建 keystore

在终端执行：

```bash
keytool -genkeypair -v \
  -keystore liuhui-release.keystore \
  -alias liuhui \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

执行后会让你填写：

- 密码
- 姓名
- 组织
- 国家等信息

### 注意

- keystore 一定要保管好
- 丢了以后，应用更新会非常麻烦
- 不要把 keystore 提交到 Git 仓库

---

## 6. 配置 Android Studio 的签名

在 Android Studio：

- `Build`
- `Generate Signed Bundle / APK`

然后：

- 选择 `APK` 或 `Android App Bundle`
- 选择你的 `liuhui-release.keystore`
- 输入 alias 和密码
- 选择 `release`

---

## 7. 生成 APK

### 方式 A：Android Studio 图形界面

- `Build`
- `Build Bundle(s) / APK(s)`
- `Build APK(s)`

### 方式 B：签名 APK

- `Build`
- `Generate Signed Bundle / APK`
- 选择 `APK`

生成后可用于直接安装测试。

---

## 8. 生成 AAB（推荐上架）

如果你未来要上架应用市场，更推荐生成：

- `Android App Bundle (.aab)`

步骤：

- `Build`
- `Generate Signed Bundle / APK`
- 选择 `Android App Bundle`

AAB 更适合正式发布。

---

## 9. 每次前端修改后的正确流程

如果你改了 `web/` 里的内容，正确流程是：

```bash
npx cap sync android
```

然后再回 Android Studio：

- 运行
- 或重新打包 APK / AAB

否则 Android 工程里还是旧前端资源。

---

## 10. 推荐发布前检查

发布前至少检查：

- 应用名是否正确
- 图标是否正确
- 包名是否正确
- API 是否能正常访问
- 首次启动是否会提示配置
- 聊天 / 图片 / 画布功能是否可用
- 真机深色模式是否正常
- 旋转屏幕时是否可接受

---

## 11. 当前建议

现阶段最适合的发布流程是：

1. 在正常磁盘复制 `android-app/`
2. `npm install`
3. `npx cap add android`
4. `npx cap sync android`
5. 覆盖 `android-config/` 模板
6. 在 Android Studio 里联调真机
7. 生成 Signed APK
8. 没问题后再导出 AAB
