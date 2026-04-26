# Windows 多文件打包说明

这个项目现在支持打包成 **Windows 可直接运行的多文件版本（onedir）**。

## 生成结果

运行打包后会产出：

- `dist/流绘/`
  - `流绘.exe`
  - `frontend/`
  - `_internal/` 或其他 PyInstaller 依赖文件

注意：**这是多文件分发版，必须整个文件夹一起带走，不能只复制 exe。**

---

## 打包环境

建议：

- 在 **Windows 系统** 上打包 Windows exe
- Python 3.10+（与你当前项目兼容即可）

先安装依赖：

```bash
pip install -r requirements.txt
```

---

## 打包命令

在项目根目录执行：

```bash
python build_windows_onedir.py
```

打包完成后，输出目录在：

```bash
dist/流绘/
```

---

## 运行方式

在 Windows 上：

1. 把整个 `dist/流绘` 文件夹打包成 zip 或直接复制过去
2. 解压后双击：

```bash
流绘.exe
```

程序启动后：

- 会自动寻找可用端口（优先 8000，若占用则顺延）
- 会自动打开浏览器访问本地页面
- 前端静态资源从打包目录读取
- `model_configs.json` 会生成在 exe 同目录
- `canvas_data/` 会生成在 exe 同目录

---

## 重要提醒

### 1）不要在 Linux 上直接打 Windows exe
PyInstaller **不能可靠跨平台产物**。如果你要 Windows exe，最好在 Windows 上打包。

### 2）如果杀毒软件拦截
这是 PyInstaller 常见情况，尤其是未签名程序。
可以：
- 保留多文件 onedir 版本（比 onefile 更少误报）
- 避免过度压缩和壳
- 后续有需要再加图标和签名

### 3）如果想自动打开浏览器
当前 `run.py` 支持：

```bash
OPEN_BROWSER=1
```

但打成 exe 后通常建议保持现在这种默认行为，先启动服务，再由用户自行打开页面或你后续再做自动跳转。

---

## 你现在可用的文件

- `build_windows_onedir.py`：Windows 多文件打包脚本
- `build_exe.py`：旧的单文件打包脚本（onefile）

如果你之后想要，我还可以继续帮你加：

- 自定义 exe 图标（已配置 `frontend/assets/app-icon.ico`）
- 打包后自动复制 README / 启动说明
- 一键生成 zip 分发包
- 启动时自动打开浏览器
