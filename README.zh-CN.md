# pi-typesafe-approve

**中文** | [English](README.md)

> **推广申明**：本项目完全开源（MIT），遵循 [LINUX DO](https://linux.do) 社区的开源推广规则进行公开版面推广。感谢社区与各位佬友的意见与支持。

用 **System One** 决策模型自动放行常规 Bash 命令，其余全部交给你判断。

System One 模型不写文本。它针对你给的一份状态（state）回答若干带类型的问题，为每个选项返回一个概率。这恰好适合做一层便宜、快速的分诊，挡在每条 shell 命令前面：

- `ls`、`git status`、`npm ci` 直接执行，不弹窗；
- 被判为有风险的一律停下来问你 —— 包括它能看穿的混淆写法（`$'\x72\x6d' -rf /`、`echo … | base64 -d | sh`）；
- 模型不可达时，绝不会把 agent 卡死。

端点、密钥、模型全部由你自己填，没有内置的服务商预设。

## 安装

```bash
pi install git:github.com/Davidasx/pi-typesafe-approve
```

然后 `/typesafe-approve` 设置端点、模型和密钥。开发时用 `pi -e ./` 单次运行一份检出，或 `pi install ./path` 就地加载，改完 `/reload` 即生效。

## 配置

配置文件在 `<agentDir>/extensions/pi-typesafe-approve/config.json`，所有键都可选，也都可以在 `/typesafe-approve` 里改。见 [`config.example.json`](./config.example.json)。

### 端点与模型

两个字符串。`endpoint` 就是完整的请求 URL。

| 部署 | `endpoint` | `model` |
|---|---|---|
| TypeSafe 官方 | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest`，或任意 System One 模型 |
| Ollama | `http://127.0.0.1:11434/v1/systemone` | 你的模型 |

这三者的请求体与响应体完全一致，所以只有这两个字符串会变。OpenRouter 已用 `inception/mercury-decide:free` 实测通过，账户余额为零时也能用。

### API 密钥

写字面值，或用 `${NAME}` 读环境变量：

```jsonc
"apiKey": "${TYPESAFE_API_KEY}"
"apiKey": "sk-live-abc123"
```

只有带花括号的形式才会被当作引用，`$NAME` 就是字面字符串。`/typesafe-approve status` 会告诉你解析成了哪一种；密钥不会被写进日志、不会被拼进报错，也不会预填进任何对话框。

### 越过阈值之后

```jsonc
{
  "thresholds": { "violation": 0.3 },
  "action": "escalate",
  "noUiFallback": "block",
  "promptTimeoutSeconds": 300,
  "failMode": "open"
}
```

| 键 | 含义 |
|---|---|
| `action` | `escalate`（问你）、`monitor`（只报告）、`block`（直接拒绝） |
| `noUiFallback` | `escalate` 但没人可问时：`block` 或 `allow` |
| `promptTimeoutSeconds` | 弹窗等人多久之后自行拒绝；`0` 表示一直等 |
| `failMode` | 模型不可达时 `open` 放行，`closed` 拒绝 |

没人应答的弹窗算作拒绝，因为这条命令不能跑 —— 但 agent 会被告知**是哪一种情况**。拒绝意味着你看过并说了不；超时意味着你不在，所以 agent 被要求把这条命令搁置、继续做别的、并通知你。

## 策略

`policy.json` 存放模型要在其中做选择的分类，首次运行时从内置集合生成。

```json
{
  "categories": [
    {
      "id": "secret_exposure",
      "polarity": "negative",
      "what": "Reads, prints, copies, or transmits a credential, private key, token, ...",
      "examples": ["cat ~/.ssh/id_ed25519", "env | sort"]
    },
    {
      "id": "permission_tightened",
      "polarity": "positive",
      "what": "Makes a file less accessible than it was, on a path already the user's: chmod 600 or 700.",
      "examples": ["chmod 600 ~/.ssh/id_ed25519"]
    }
  ]
}
```

`negative` 表示这类行为必须拦住。`positive` 表示命令可以执行。`polarity` 缺失按 negative 处理，且至少要有一个 positive 分类。

判定依据是**所有非 positive 概率之和**，与 `thresholds.violation` 比较。求和比只看最大项更可靠：两个违规各 0.4，谁都没过 0.3 的线，加起来却比「0.5 对 0.5 的干净分界」更像违规。

### 误判就用正面分类去修

把规则和例外写在同一句里是无效的。「绝对路径需要批准，但在自己的文件上收紧权限不算违规」依然会拦住 `chmod 600 ~/.ssh/id_ed25519`，因为两半出现的是同一批词，词面重合会压过否定。

单独开一个正面分类就能修好：模型是在两个各自成立的描述之间做选择，而不是去推理一个否定。

所以当某条命令反复被误停、而你认为它没问题时，**给它一个正面分类**，而不是去抬高阈值。

### 内置分类

八个拦停类 —— 不可恢复的破坏、凭据泄露、削弱安全、来自别处并直接运行的代码、提权、服务中断、越界写入、错放临时文件 —— 以及四个放行类：`credential_handled_safely`、`permission_tightened`、`scoped_process_control`、`routine_work`。

### 状态

```json
"state": {
  "context": "Reviewing one shell command an AI coding agent wants to run ...",
  "command": "${command}",
  "working_directory": "$(pwd -P)"
}
```

模型还需要什么才能正确读懂你的分类，就加什么 —— 临时目录、家目录、几个项目检出的位置。值都是扁平字符串，只有三种替换：

| 写法 | 变成 |
|---|---|
| `${NAME}` | 环境变量 `NAME` 的值（存在且非空时） |
| `${command}` | 正在被判定的那条命令 |
| `$(pwd)` / `$(pwd -P)` / `${PWD}` | 物理工作目录 |

只有带花括号的形式会展开。`$NAME`、`$HOME`、`~` 原样保留，正因如此，一段值才能描述某种写法而不被自己改写掉。其它 `$(…)` 在加载时被拒绝，而不是被执行：配置文本不是代码。

## 命令

| 命令 | 作用 |
|---|---|
| `/typesafe-approve` | 设置界面 |
| `/typesafe-approve status` | 一行状态 |
| `/typesafe-approve policy` | 实际发送的分类 |
| `/typesafe-approve test <command>` | 判定单条命令，并显示原始信号 |
| `/typesafe-approve on` / `off` | 开关闸门 |
| `/typesafe-approve path` | 配置路径 |

设置界面把所有选项和当前值放在同一个列表里；枚举项就地切换，其余打开单字段编辑器。

改动自动生效。`policy.json` 每条命令读一次且从不缓存，所以改完下一条命令就生效。`config.json` 变化时重读，并且做了保护，半个写入的文件不会悄无声息地把检查关掉。

## 工作原理

```text
bash 工具调用
      │
      ├─ 非 bash / 闸门关闭 / 未配置 ───────────────────────────► 放行
      ├─ 命中缓存 ─────────────────────────────────────────────► 复用判定
      ├─ POST {model, state, questions} ───────────────────────► 求和、比较、执行动作
      └─ 网络失败 ─────────────────────────────────────────────► failMode
```

闸门挂在 Pi 的 `tool_call` 事件上，而不是替换 Bash 工具。因此它能与其它闸门叠加，且只能**增加**拦截 —— 绝不可能削弱旁边那个硬策略扩展。同一条命令在一次会话内会被缓存，请求受 `timeoutMs` 和当轮的中断信号约束。

它刻意不带允许/拒绝的匹配列表。硬的确定性规则属于策略层，那里出 bug 不会只表现为一个概率。两个一起用：[pi-permission-system](https://github.com/gotgenes/pi-packages) 管规则，这个减少例行弹窗。

判定记录追加到配置旁的 `decisions.jsonl`，权限 `0600`，上限 20 MB。

## 局限

- System One 模型只有一步推理深度，且只看到命令本身。它分不清合法域名和恶意域名，也不知道通配符会展开成什么。这些属于 `policy.json` 或策略层的职责。
- 它会误判「看着吓人但很常规」的操作 —— 这也是默认动作是「问你」而不是「拒绝」的原因。
- 用 `/typesafe-approve test` 配合 `action: "monitor"` 调参，然后把反复出现的误停升级成一个正面分类。

## 测试

```bash
npm test        # 125 个测试，含一个针对本地 stub 的端到端用例
npm run check   # 附带类型检查
```

## 许可

MIT
