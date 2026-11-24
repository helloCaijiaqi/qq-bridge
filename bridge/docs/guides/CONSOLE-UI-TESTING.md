# 控制台离线预览与回归测试

这些脚本只读取控制台 HTML，使用内存中的演示数据模拟 API。不会加载项目入口、配置文件、真实 state，也不会连接 QQ 或网关。重启、清空、发送消息等按钮只改变内存或返回模拟结果。

## 启动预览

在项目根目录执行：

```sh
npm run preview:console          # 等价于 node scripts/console-ui-fixture.mjs
```

浏览器访问 `http://127.0.0.1:4173`。写请求会打印到终端，也可以访问 `/__fixture/requests` 查看记录。服务只监听 loopback 地址。按 `Ctrl+C` 退出，演示数据随之丢弃。

可用选项：

```sh
node scripts/console-ui-fixture.mjs --port=4174
node scripts/console-ui-fixture.mjs --html=path/to/console.html
```

## 浏览器回归

```sh
npm run test:console-ui          # 等价于 node scripts/test-console-ui.mjs
node scripts/test-console-ui.mjs --artifacts=docs/ui-verification
```

脚本使用 Playwright 和 Chromium。优先使用项目内安装的 `playwright`；Windows 上若未安装 Playwright，会自动改用本机 Chrome / Edge，无需下载浏览器。其他环境可安装 Playwright 及其浏览器，或通过以下环境变量指定：

- `PLAYWRIGHT_MODULE`：Playwright 模块目录（例如 `npm install --no-save playwright` 后指向 `node_modules/playwright`）。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`：Chromium / Chrome 可执行文件。

测试自行启动随机端口的 fixture，并在退出时关闭浏览器和服务。浏览器请求被限制到该 fixture 的 origin，外部请求会被阻止并使检查失败。

覆盖范围：

- 契约文件钉住的控制台元素 ID 全部保留，DOM ID 唯一。
- 四个导航视图（运行总览 / 访问与安全 / 调试与运维 / 工具参考）及切换后草稿保留，跨越实际的 3 秒状态轮询。
- 白名单数字解析与管理员字段、安全设置。
- state 目录未收紧时的显式告警条（路径 + 可复制的 icacls 提权命令），「重新检测」的请求契约与成功态切换。
- 二代仿真配置上下两个保存按钮的完整 payload：时间单位换算、零值、关键词解析、工具开关、暂停及恢复。
- 语音调试面板：库列表渲染、dry-run 校验（不发真实 QQ 消息）。
- 测试消息仅发送到 mock API。
- 全部写请求按「端点 × 次数」与 `console-ui-contracts.json` 基线对账（载荷契约由各点击断言钉死）。
- 手机 390px 与平板 768px 下四个视图没有页面级横向溢出。
- 深色模式：切换生效、写入 `localStorage`、刷新后保持、`aria-pressed` 与 `color-scheme` 同步、正文对比度 ≥ 7:1、深色下 390 / 768px 无横向溢出。
- 未做选择时跟随系统 `prefers-color-scheme`。
- `prefers-reduced-motion: reduce` 下关闭背景动效、页面切换动画与过渡。
- 无 JavaScript 错误、未知 API 或外部网络请求。

新增的控制台 API 都已在 `console-ui-fixture.mjs` 里 mock；**改动控制台时若加了新接口，必须同步补 mock**，否则本套件会在「未知 API」这一项失败。

`--artifacts` 会保存检查结果 JSON、模拟写请求记录和桌面 / 手机截图（浅色与深色各一组），截图时会静止动画以保证可复现。默认不生成额外文件。

## 基线说明

两份基线都在 `scripts/` 下：

- `console-ui-legacy-ids.json`：控制台元素 ID 清单（从当前 `public/console.html` 生成，防止重构时无意丢掉被测试或其他工具引用的元素）。
- `console-ui-contracts.json`：写端点计数基线（`POST /api/... → 次数`）。载荷契约由测试里每个点击的 deepEqual 钉死；这份基线只保证控制台**不多出**任何未预期的写请求。

控制台 DOM 或写行为经过明确调整时才重新生成基线（重新生成方式见 `scripts/test-console-ui.mjs` 顶部的两个契约文件读取点，手工维护即可——都是纯 JSON）。不要用真实的 `test-console.mjs` 替代本脚本：那个脚本面向真实运行的桥接。

此回归验证前端行为和提交契约，不能替代真实 QQ / 网关集成测试。
