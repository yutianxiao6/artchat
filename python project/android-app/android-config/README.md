# Android 原生配置模板

这个目录是给 `npx cap add android` 生成出来的原生工程做**后续覆盖/参考**的模板，目的是让你更快补好：

- 应用名
- 图标
- 颜色
- 启动页主题
- 网络安全配置
- Manifest 基础项

## 使用方式

当你在正常磁盘执行完：

```bash
npm install
npx cap add android
npx cap sync android
```

生成出原生工程后，把这里的文件按相同相对路径复制进 Android 工程。

### 资源文件覆盖到

```text
android/app/src/main/res/...
```

### Manifest 参考片段

查看：

```text
android-config/AndroidManifest.snippet.xml
```

把其中关键属性同步到：

```text
android/app/src/main/AndroidManifest.xml
```

---

## 当前包含

### 资源
- `app/src/main/res/values/strings.xml`
- `app/src/main/res/values/colors.xml`
- `app/src/main/res/values/themes.xml`
- `app/src/main/res/values-night/themes.xml`
- `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- `app/src/main/res/drawable/ic_launcher_foreground.xml`
- `app/src/main/res/xml/network_security_config.xml`

### 参考模板
- `AndroidManifest.snippet.xml`

---

## 推荐同步到 AndroidManifest.xml 的内容

### 权限

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

### application 关键属性

```xml
android:icon="@mipmap/ic_launcher"
android:roundIcon="@mipmap/ic_launcher"
android:label="@string/app_name"
android:networkSecurityConfig="@xml/network_security_config"
android:theme="@style/AppTheme.NoActionBarLaunch"
```

---

## 说明

- 默认应用名：`流绘`
- 默认包名：`com.liuhui.app`
- 默认禁止明文流量，但给 `10.0.2.2 / 127.0.0.1 / localhost` 留了例外
- 已提供基础 Splash Theme
- 图标目前是一个可用的矢量占位版本，后续可以再换成正式图标

---

## 推荐落地顺序

1. 在正常磁盘运行 `npm install`
2. 执行 `npx cap add android`
3. 执行 `npx cap sync android`
4. 用本目录的 `res/` 模板覆盖 Android 工程对应目录
5. 按 `AndroidManifest.snippet.xml` 手动同步 Manifest 关键项
6. 用 Android Studio 打开并运行
7. 最后再生成 APK
