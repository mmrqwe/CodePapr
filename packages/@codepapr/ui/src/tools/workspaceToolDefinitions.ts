import type { IToolDefinition } from '@codepapr/types';
import {
  WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS,
  MERGE_TOOL_DEFINITIONS,
} from '@codepapr/core';

const EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS = WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS.filter(
  (tool) =>
    tool.name !== 'workspace_project_graph' &&
    tool.name !== 'workspace_project_diagnostics'
);

const tools: IToolDefinition[] = [
  {
    name: 'workspace_list_files',
    description:
      '列出当前项目文件夹内的文件树。用于理解项目结构。路径必须是相对于项目文件夹的路径，不能使用绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '相对于项目文件夹的目录路径；省略或空字符串表示项目根目录。',
        },
        maxDepth: {
          type: 'number',
          description: '递归深度，默认 2，最大 6。',
        },
      },
    },
  },
  {
    name: 'workspace_read_file',
    description:
      '读取当前项目文件夹内的 UTF-8 文本文件。支持 startLine/endLine 范围读取，也支持 aroundLine/contextLines 窗口读取；优先传相对路径，也接受项目内绝对路径，以及末尾附带的 #L10 或 :10:2 这类定位后缀。路径不能跳出项目文件夹。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要读取的文件路径。优先相对路径；也接受项目内绝对路径或带行号锚点的路径。',
        },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数，默认 500000，最大 20000000。超出截断，可用 startLine/endLine 分块读取。',
        },
        startLine: {
          type: 'number',
          description: '可选。起始行号，从 1 开始。',
        },
        endLine: {
          type: 'number',
          description: '可选。结束行号，从 1 开始且必须不小于 startLine。',
        },
        aroundLine: {
          type: 'number',
          description: '可选。以指定行号为中心读取一个小窗口。',
        },
        contextLines: {
          type: 'number',
          description: '可选。aroundLine 或路径锚点前后各保留多少行，默认 20，最大 200。',
        },
        symbol: {
          type: 'string',
          description: '可选。按符号名（函数/类等）精确读取该符号代码片段（AST 定位，无 AST 时降级文本搜索）。传入后忽略 startLine/endLine/aroundLine。',
        },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_read_image',
    description:
      '读取项目中的图片文件（PNG、JPEG、WebP、GIF），返回 base64 编码的图片数据供多模态模型识别分析。支持 maxBytes 限制大小。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '图片文件相对路径。',
        },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数，默认 5000000（5MB）。',
        },
      },
      required: ['relativePath'],
    },
  },
  {
    name: 'workspace_write_file',
    description:
      '写入当前项目文件夹内的 UTF-8 文本文件。适合创建或替换源码文件。路径必须是相对于项目文件夹的路径，不能使用绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要写入的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
        },
        content: {
          type: 'string',
          description: '完整文件内容；该工具会替换目标文件内容。',
        },
      },
      required: ['relativePath', 'content'],
    },
  },
  {
    name: 'workspace_run_command',
    description:
      '在当前项目文件夹内运行短时开发命令或一次性脚本，例如测试、构建、lint、格式检查。默认允许绝大多数项目内开发命令；会阻止 shell 包装器、提权入口、远程登录命令，以及高危破坏性命令（如 rm -rf / 或 ~、磁盘格式化/裸写、git push --force、git reset --hard、关机重启等——这些会被直接拦截，如确需执行请提示用户手动操作）。不要传 shell 字符串；必须把命令和参数分开，例如 command=npm, args=["test"]。如果目标是启动 dev server、watcher、调试器或其他长驻进程，请改用 workspace_start_background_command。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令名或项目内脚本路径。会在当前项目文件夹作为 cwd 执行；仅阻止 bash/sh/zsh/powershell/sudo/ssh 等明显危险入口。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '超时时间秒数，默认 30，最大 600。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_run_shell_command',
    description:
      '在项目环境中穿过 shell 执行一条命令（支持管道、&&、变量展开），阻塞等待并返回完整 stdout/stderr 与退出码。高危破坏性命令（rm -rf / 或 ~、磁盘格式化/裸写、git push --force、git reset --hard、关机重启等）会被直接拦截。由 bash 工具调用。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的完整 shell 命令。',
        },
        workdir: {
          type: 'string',
          description: '工作目录（相对项目根或绝对路径），默认项目根。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '超时秒数，默认 30，最大 600。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_start_shell_background_command',
    description:
      '在项目环境中穿过 shell 后台执行一条命令，返回 pid；输出写入日志尾部，可用 workspace_list_background_processes 查看。高危破坏性命令会被直接拦截。由 bash 工具调用。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的完整 shell 命令。',
        },
        workdir: {
          type: 'string',
          description: '工作目录（相对项目根或绝对路径），默认项目根。',
        },
        previewUrl: {
          type: 'string',
          description: '后台服务启动后预览的 URL。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_search_text',
    description:
      '在当前项目文件夹内搜索文本内容，返回文件路径、行号、列号、上下文和匹配预览。支持 smart-case、正则，并默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的文本关键词，至少 2 个字符。',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写；默认按 smart-case 处理。',
        },
        isRegexp: {
          type: 'boolean',
          description: '是否把 query 当作正则表达式。',
        },
        contextLines: {
          type: 'number',
          description: '每个匹配前后额外返回多少行上下文，默认 0，最大 8。',
        },
        maxResults: {
          type: 'number',
          description: '最多返回多少条匹配，默认 80。',
        },
        maxMatchesPerFile: {
          type: 'number',
          description: '单个文件最多返回多少条匹配，默认 5，最大 20。',
        },
        maxBytesPerFile: {
          type: 'number',
          description: '搜索时单个文件最大读取字节数，默认 500000，最大 1000000。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'workspace_search_files',
    description:
      '按文件名或路径片段搜索当前项目内的文件和目录，返回匹配路径、名称、类型和字节数。支持 smart-case、正则，并默认遵守常见忽略目录与根级 .gitignore/.ignore。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的文件名或路径关键词。',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否区分大小写；默认按 smart-case 处理。',
        },
        isRegexp: {
          type: 'boolean',
          description: '是否把 query 当作正则表达式。',
        },
        maxResults: {
          type: 'number',
          description: '最多返回多少条匹配，默认 120。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_load',
    description:
      '加载当前项目 .CodePapr/skills 下某个 Skill 包的 Markdown 说明。适合在看到 Skill 目录摘要后，按需读取某个项目专属工作流、规范、角色或工具说明。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称或嵌套 id，例如 search 或 suite/article-illustrator。',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'websearch',
    description:
      '在线搜索公开网页，用于收集资料、查找文档或验证事实。聚合多源搜索结果；支持指定搜索分类（通用网页、图片、视频、新闻、科学论文等）、时间范围、语言过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。',
        },
        maxResults: {
          type: 'number',
          description: '返回结果数量，默认 5，最大 10。',
        },
        searxngCategory: {
          type: 'string',
          description:
            '搜索分类，留空则使用 SearXNG 默认分类（通常为通用网页）。可选：general(通用网页)、images(图片)、videos(视频)、' +
            'news(新闻)、science(科学论文)、map(地图)、it(IT技术)、music(音乐)、' +
            'files(文件)、social media(社交媒体)。用逗号组合，如 "news,images"。',
        },
        searxngTimeRange: {
          type: 'string',
          description:
            '时间范围，默认不限。可选：day(一天内)、week(一周内)、month(一月内)、year(一年内)。需要最新信息时使用。',
        },
        searxngLanguage: {
          type: 'string',
          description: '搜索语言，默认自动检测。可选：zh-CN(中文)、en(英文)、ja(日文)等。',
        },
        searxngSafeSearch: {
          type: 'number',
          description: '安全搜索等级，默认 1（与 SearXNG 内置默认一致）。0=关闭过滤，1=中等过滤，2=严格过滤。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch_url',
    description:
      '读取公开网页文本内容。适合在 web_search 找到链接后获取页面正文或文档片段。由本地后端请求，可绕过前端 CORS 限制；HTML 页面会尽量提取正文文本。支持 http 和 https URL。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要读取的 https URL。',
        },
        maxBytes: {
          type: 'number',
          description: '最大返回字符数，默认 20000，最大 100000。',
        },
      },
      required: ['url'],
    },
  },
  {
name: 'web_download_file',
      description:
        '把一个 http/https 网络文件下载到项目 .CodePapr/downloads/ 文件夹，适合下载在线图片、附件、示例文件或网页资源。relativePath 可选；省略时默认保存到 .CodePapr/downloads/ 目录并自动使用 URL 文件名。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要下载的 http/https URL。',
        },
        relativePath: {
          type: 'string',
          description: '可选。下载到项目内的相对路径，例如 assets/logo.png。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'workspace_start_background_command',
    description:
      '在当前项目文件夹内后台启动长驻命令，例如 npm run dev、vite dev、next dev、cargo tauri dev、文件 watcher 或调试器。调用后立即返回，不等待命令退出；后台日志会被托管，若提供 previewUrl，工作台会显示可打开的预览地址。同一工作区内相同 command + args 若已运行，会直接返回现有 PID，避免重复启动累积。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '命令名或项目内脚本路径。会在当前项目文件夹作为 cwd 启动。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        previewUrl: {
          type: 'string',
          description: '可选。若该后台服务对应可打开的网页地址，可传入 http://localhost:3000 这类 URL，供工作台展示预览入口。',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'workspace_start_preview_session',
    description:
      '在当前项目文件夹内启动一个需要长驻 server 的网页预览会话，并把指定 previewUrl 打开到应用内预览页。关闭内置预览页时，会自动停止关联后台进程。适合 npm run dev 后在应用内预览 http://localhost:3000。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '用于启动预览服务的命令名或项目内脚本路径。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数数组，不要包含 shell 拼接。',
        },
        previewUrl: {
          type: 'string',
          description: '应用内预览要加载的 http/https URL，通常是 localhost 地址。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题；默认使用 command + args。',
        },
      },
      required: ['command', 'previewUrl'],
    },
  },
  {
    name: 'workspace_list_background_processes',
    description:
      '列出当前项目文件夹内由 CodePapr 托管的后台进程，例如之前启动的 dev server、watcher 或调试器。适合在关闭、清理或排查重复启动前先查看当前列表。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_stop_background_process',
    description:
      '停止当前项目文件夹内某个已托管的后台进程。通常先通过 workspace_list_background_processes 取得 PID，再调用本工具关闭指定进程。',
    parameters: {
      type: 'object',
      properties: {
        pid: {
          type: 'number',
          description: '要停止的后台进程 PID。',
        },
      },
      required: ['pid'],
    },
  },
  {
    name: 'workspace_stop_all_background_processes',
    description:
      '停止当前项目文件夹内所有由 CodePapr 托管的后台进程。适合清空重复启动的 dev server、watcher 或调试器。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_open_preview',
    description:
      '在应用内预览页打开一个 URL。可选 linkedPid，用于把预览页和某个后台进程绑定；关闭预览时可顺带停掉这个 PID。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要在应用内预览中打开的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题。',
        },
        linkedPid: {
          type: 'number',
          description: '可选。与预览绑定的后台进程 PID。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_get_preview_session',
    description:
      '读取当前应用内预览页状态，包括 URL、标题和是否绑定后台进程。适合在导航或关闭前先确认当前浏览会话。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_navigate_preview',
    description:
      '把当前应用内预览页导航到新的 URL，并保留当前绑定的后台进程 PID。若当前没有预览，则会新建一个。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '新的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。新的预览标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_reload_preview',
    description:
      '重新加载当前应用内预览页。适合在 dev server 热更新异常、样式未刷新或页面卡住时手动刷新。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_close_preview',
    description:
      '关闭当前应用内预览页。默认会一并停止它绑定的后台进程；如果 stopLinkedProcess=false，则只关闭预览不停止服务。',
    parameters: {
      type: 'object',
      properties: {
        stopLinkedProcess: {
          type: 'boolean',
          description: '是否同时停止已绑定的后台进程，默认 true。',
        },
      },
    },
  },
  {
    name: 'shell_open_session',
    description:
      '在当前项目文件夹启动一个托管 Shell 会话，用于多步命令、原始 shell 字符串或需要持续上下文的终端操作。注意：后续输入会原样交给真实 shell 解析。',
    parameters: {
      type: 'object',
      properties: {
        shell: {
          type: 'string',
          description: '可选。指定 shell 路径；省略时使用系统默认 shell。',
        },
      },
    },
  },
  {
    name: 'shell_list_sessions',
    description:
      '列出当前项目文件夹的托管 Shell 会话，返回会话 ID、shell、启动时间和最近输出尾部。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'shell_read_output',
    description:
      '读取某个托管 Shell 会话的最近输出尾部，适合在发送命令后检查执行结果。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'shell_send_input',
    description:
      '向某个托管 Shell 会话发送一行输入。优先传 command 和 args，让系统按当前 shell 自动完成安全转义；只有在回复交互式提示、发送单个确认字符或继续 REPL 时才传原始 input。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
        command: {
          type: 'string',
          description: '可选。要在当前 Shell 会话中执行的命令名。优先使用此字段。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。命令参数数组；和 command 配合使用。',
        },
        input: {
          type: 'string',
          description: '可选。要原样发送到 Shell 的输入内容，仅用于回复交互提示或继续 REPL。若末尾没有换行，系统会自动补一行结束。',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'shell_close_session',
    description:
      '关闭某个托管 Shell 会话。适合在终端任务完成后回收会话，避免后台残留。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Shell 会话 ID。',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_open_page',
    description:
      '打开一个可交互的浏览页会话，并把同一 URL 同步到应用内预览。适合后续需要点击、输入、抓 DOM 或截图的网页任务。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要打开的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。预览页标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_navigate_page',
    description:
      '把当前可交互浏览页导航到新的 URL，并同步刷新应用内预览。若当前没有浏览页会话，会自动创建一个。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '新的 http/https URL。',
        },
        title: {
          type: 'string',
          description: '可选。新的预览标题。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_reload_page',
    description:
      '刷新当前可交互浏览页，并同步刷新应用内预览。适合页面脚本、热更新或重定向后手动重载。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_click',
    description:
      '在当前可交互浏览页点击一个元素。默认使用 CSS 选择器，也支持 xpath。若点击后页面会跳转，可设置 waitForNavigation=true。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '要点击的元素选择器。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        waitForNavigation: {
          type: 'boolean',
          description: '可选。点击后是否等待页面跳转完成。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现或跳转的超时秒数，默认 10，最大 30。',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_input_text',
    description:
      '在当前可交互浏览页中向某个输入元素填入文本。默认会先清空原值；若 submit=true，会在输入后按 Enter。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '输入元素选择器。',
        },
        text: {
          type: 'string',
          description: '要输入的文本。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        clear: {
          type: 'boolean',
          description: '可选。输入前是否清空元素现有值，默认 true。',
        },
        submit: {
          type: 'boolean',
          description: '可选。输入后是否按 Enter。',
        },
        waitForNavigation: {
          type: 'boolean',
          description: '可选。提交后是否等待页面跳转完成。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现或跳转的超时秒数，默认 10，最大 30。',
        },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_read_dom',
    description:
      '抓取当前可交互浏览页的 DOM 内容。selector 为空时读取整页；contentType 可选 html 或 text。',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '可选。只读取某个元素；省略时读取整页。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        contentType: {
          type: 'string',
          description: '可选。html 或 text，默认 html。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现的超时秒数，默认 10，最大 30。',
        },
      },
    },
  },
  {
    name: 'browser_take_screenshot',
    description:
      '对当前可交互浏览页截图，可截整页或某个元素。默认把图片保存到项目内 .CodePapr/browser 目录。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '可选。项目内保存路径。',
        },
        selector: {
          type: 'string',
          description: '可选。若提供，只截该元素。',
        },
        selectorType: {
          type: 'string',
          description: '可选。css 或 xpath，默认 css。',
        },
        format: {
          type: 'string',
          description: '可选。png 或 jpeg，默认 png。',
        },
        timeoutSeconds: {
          type: 'number',
          description: '可选。等待元素出现的超时秒数，默认 10，最大 30。',
        },
      },
    },
  },
  {
    name: 'browser_close_page',
    description:
      '关闭当前可交互浏览页会话，并关闭应用内预览。若 stopLinkedProcess=true，则会一并停止当前预览绑定的后台进程。',
    parameters: {
      type: 'object',
      properties: {
        stopLinkedProcess: {
          type: 'boolean',
          description: '是否同时停止当前预览绑定的后台进程，默认 false。',
        },
      },
    },
  },
  {
    name: 'workspace_project_graph',
    description:
      '生成统一 ProjectGraph。它同时返回目录树、代码结构骨架摘要和文件/符号关系图，是默认的项目理解工具；`view=overview` 偏向轻量概览，默认 `view=full` 返回完整语义图。桌面端会优先复用真实 LSP documentSymbol 结果。',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: '视图模式：`full` 或 `overview`。默认 `full`。full 默认深度10/文件数120/符号24/关系边960；overview 默认深度6/文件数48/符号12/关系边240。',
        },
        relativePath: {
          type: 'string',
          description: '可选。只为某个子目录生成 ProjectGraph。',
        },
        maxDepth: {
          type: 'number',
          description: '目录树深度，默认 full=10、overview=6。0 表示不限制。',
        },
        maxFiles: {
          type: 'number',
          description: '抽取源码文件数量，默认 120。0 表示不限制。',
        },
        maxTreeEntries: {
          type: 'number',
          description: '目录树最多展示的节点数，默认 320。0 表示不限制。',
        },
        maxSymbolsPerFile: {
          type: 'number',
          description: '每个文件最多返回多少条符号，默认 24。0 表示不限制。',
        },
        maxEdges: {
          type: 'number',
          description: '最多返回多少条图关系，默认 960。0 表示不限制。',
        },
        maxBytes: {
          type: 'number',
          description: '单个源码文件最多读取多少字节用于建图，默认 180000。0 表示不限制。',
        },
      },
    },
  },
  {
    name: 'workspace_git_status',
    description:
      '读取当前工作区的 Git 状态，返回分支信息以及已暂存、未暂存、未跟踪或重命名的文件列表。适合把最近改动作为高优先级上下文。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_git_diff',
    description:
      '读取当前工作区的 Git diff，返回 diff --stat 和精简补丁正文。可选 staged=true 查看暂存区，也可传 pathspecs 只看部分路径。',
    parameters: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description: '是否读取暂存区 diff，默认 false。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。只查看这些相对路径的 diff。',
        },
      },
    },
  },
  {
    name: 'workspace_git_history',
    description: '读取当前工作区最近的 Git 提交历史，适合选择审查、回退或恢复目标。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '最多返回多少条提交记录，默认 20，最大 100。',
        },
      },
    },
  },
  {
    name: 'workspace_git_branch_checkout',
    description: '切换到指定 Git 分支，也可按需创建新分支，用于隔离沙盒式改动。',
    parameters: {
      type: 'object',
      properties: {
        branchName: {
          type: 'string',
          description: '目标分支名。',
        },
        startPoint: {
          type: 'string',
          description: '可选。创建分支时的起点引用，如 main、HEAD 或某个提交。',
        },
        create: {
          type: 'boolean',
          description: '是否显式创建新分支。',
        },
        createIfMissing: {
          type: 'boolean',
          description: '分支不存在时是否自动创建，默认 true。',
        },
      },
      required: ['branchName'],
    },
  },
  {
    name: 'workspace_git_stage',
    description: '暂存 Git 改动，可暂存全部或指定路径，为原子提交准备内容。',
    parameters: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: '是否暂存全部改动。默认当 pathspecs 为空时为 true。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '要暂存的相对路径列表。',
        },
      },
    },
  },
  {
    name: 'workspace_git_commit',
    description: '创建本地 Git 提交。可选先自动暂存全部或指定路径，再执行原子提交。',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '提交说明。',
        },
        stageAll: {
          type: 'boolean',
          description: '提交前是否先暂存全部改动。',
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '提交前只暂存这些相对路径。',
        },
        allowEmpty: {
          type: 'boolean',
          description: '是否允许空提交。',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'workspace_git_restore',
    description: '恢复工作区改动到干净状态。默认先创建安全 stash 快照，避免误伤。',
    parameters: {
      type: 'object',
      properties: {
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: '只恢复这些相对路径；留空表示整个工作区。',
        },
        snapshot: {
          type: 'boolean',
          description: '恢复前是否先创建安全快照，默认 true。',
        },
        includeUntracked: {
          type: 'boolean',
          description: '创建快照时是否包含未跟踪文件，默认 true。',
        },
        source: {
          type: 'string',
          description: '可选。恢复内容来源，默认 HEAD。',
        },
      },
    },
  },
  {
    name: 'workspace_git_reset',
    description: '安全回退到指定提交。会先创建备份引用和自动安全快照，可通过 workspace_restore_undo 撤销。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要回退到的提交 SHA 或其他 Git 引用。',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'workspace_restore_undo',
    description: '撤销上一次 workspace_git_reset 或恢复操作，通过备份引用恢复。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_apply_patch',
    description:
      '对项目内现有文本文件做局部 SEARCH/REPLACE 补丁修改。适合只改一个代码块，不必整文件重写。若 search 匹配多处，默认报错，除非设置 replaceAll=true。',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: '要修改的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
        },
        search: {
          type: 'string',
          description: '要精确匹配的原始文本块。',
        },
        replace: {
          type: 'string',
          description: '替换后的文本块。',
        },
        replaceAll: {
          type: 'boolean',
          description: '是否替换全部匹配，默认 false。',
        },
        expectedOccurrences: {
          type: 'number',
          description: '可选。要求 search 恰好匹配多少次，否则报错。',
        },
      },
      required: ['relativePath', 'search', 'replace'],
    },
  },
  {
    name: 'workspace_project_diagnostics',
    description:
      '运行项目级诊断，优先执行 lint 和 typecheck；若没有独立 typecheck 脚本，则回退到 build 作为类型检查近似验证。返回每个阶段的命令、退出码和输出摘要。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'local_time_now',
    description:
      '读取当前设备的本地时间、日期和时区。适合股票、基金、汇率、市场开闭盘、财报日期、活动截止时间等时效问题。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'question',
    description:
      '向用户提出明确的问题以收集需求、确认决策或消除歧义。仅在 Plan 模式下使用，当需求不明确或需要用户做关键选择时调用。如果不需要用户选择，不传 options 则用户可自由输入文本回答。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，清晰描述需要确认的内容。',
        },
        header: {
          type: 'string',
          description: '简短标题（最多30字符），用于在UI中标识此问题。',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: '选项的显示文字（1-5个词，简洁）。',
              },
              description: {
                type: 'string',
                description: '选项的详细说明。',
              },
            },
            required: ['label'],
          },
          description: '可选的预定义选项。如果提供，用户只能从这些选项中选择（单选或多选）；如果不提供，用户可自由输入文本回答。',
        },
        multiple: {
          type: 'boolean',
          description: '是否允许多选（仅在提供options时有效）。默认 false 为单选。',
        },
      },
      required: ['question', 'header'],
    },
  },
  {
    name: 'workspace_apply_diff',
    description:
      '按顺序应用多文件、多块 SEARCH/REPLACE Diff。会先读取并校验所有 patch，全部能精确匹配后才写入文件；任意一块失败则不写入。适合 YOLO 模式下一次提交多个局部修改。',
    parameters: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          description: '按应用顺序排列的 patch 列表。',
          items: {
            type: 'object',
            properties: {
              relativePath: {
                type: 'string',
                description: '要修改的相对文件路径。路径分隔符用 /，不要包含 \\ 或控制字符。',
              },
              search: {
                type: 'string',
                description: '要精确匹配的原始文本块。',
              },
              replace: {
                type: 'string',
                description: '替换后的文本块。',
              },
              replaceAll: {
                type: 'boolean',
                description: '是否替换全部匹配，默认 false。',
              },
              expectedOccurrences: {
                type: 'number',
                description: '可选。要求 search 恰好匹配多少次，否则报错。',
              },
            },
            required: ['relativePath', 'search', 'replace'],
          },
        },
      },
      required: ['patches'],
    },
  },
  {
    name: 'app_render',
    description:
      '生成一个交互式 HTML 应用到应用面板。用于数据分析可视化、仪表盘、关系图等。自动写入 manifest.json 和 index.html 到 .CodePapr/apps/<appId>/ 目录，并注册到应用管理面板。相同 appId 会覆盖已有应用。\n\n📦 Papr SDK 可用：生成的 HTML 可通过 window.papr 调用 CodePapr 能力：\n  • papr.db.get(key) / papr.db.set(key, value) / papr.db.delete(key) / papr.db.keys() — 键值持久化存储（应用内数据持久化默认用它）\n  • papr.agent.run({agent, task}) — 调用 AI Agent（Agent 读不到 papr.db，需要的数据要放进 task）\n  • papr.http.get(url) / papr.http.post(url, body) — HTTP 请求（仅限公网地址）\n  • papr.fs.readFile(path) / papr.fs.writeFile(path, content) / papr.fs.list(path) / papr.fs.delete(path) — 文件读写（限定 app data 目录）\n  • papr.app.info() — 获取应用信息\n⚠️ 使用前必须在 permissions 参数中声明对应权限（storage:read, storage:write, http:get, http:post, fs:read, fs:write, workspace:read, workspace:write, workspace:exec, agent:run:<name>）。',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: '应用唯一标识符，kebab-case（仅小写字母、数字、连字符）。相同 appId 会覆盖已有应用。例如：history-explorer、stock-dashboard。',
        },
        title: {
          type: 'string',
          description: '应用标题，显示在应用标签上。',
        },
        html: {
          type: 'string',
          description: '前端 HTML 文档内容（index.html）。可以内联 CSS/JS，可以引用 CDN（D3、ECharts、Mermaid、MapLibre、Leaflet、Three.js）。可使用 window.papr SDK 调用 CodePapr 能力（需声明 permissions）。',
        },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。应用需要的权限列表（必须是 level 允许范围内的子集）。可选值：storage:read, storage:write, http:get, http:post, fs:read, fs:write, agent:run:<agentName>, workspace:read, workspace:write, workspace:exec。',
        },
        level: {
          type: 'number',
          description: '权限级别 0-3。L0=纯计算, L1=Runtime（存储+文件+AI Agent+只读工作区，默认）, L2=联网（+HTTP+搜索+MCP）, L3=系统（+文件写入+终端执行，需用户全局开启）。',
        },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Agent 名称（如 assistant）' },
              model: { type: 'string', description: '模型：main（默认，使用用户主模型）、fast（快速模型）、mentor（Mentor 模型）、或具体模型 ID' },
              systemPrompt: { type: 'string', description: '系统提示词' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Agent 可用的工具白名单（可选）。可用工具名：read, grep, list, lsp, diagnostics, read_image, skill_load, todo, local_time_now, websearch, webfetch（L2+）, write, edit, patch, bash（L3）。不声明 = 使用当前级别允许的全部工具。始终排除 task 和 app_render。高危工具（write/edit/patch/bash）需 manifest.permissions 中声明 workspace:write/exec。',
              },
              maxToolRounds: {
                type: 'number',
                description: '最大工具调用轮数，默认 50，上限 50',
              },
              inheritContext: {
                type: 'object',
                properties: {
                  skills: { type: 'boolean', description: '继承主会话的技能（skills）' },
                  projectRules: { type: 'boolean', description: '继承项目规则（AGENTS.md 等）' },
                  projectMemory: { type: 'boolean', description: '继承项目记忆' },
                  customPrompt: { type: 'boolean', description: '继承用户自定义系统提示词' },
                },
                description: '可选。继承主会话上下文的哪些部分（默认全不继承）。',
              },
            },
            required: ['name'],
          },
          description: '可选。应用可调用的 Agent 定义列表。每个 Agent 可在 HTML 中通过 papr.agent.run({agent: name, task}) 调用。',
        },
        icon: {
          type: 'string',
          description: '可选。应用图标，支持 emoji 或 1-2 个字符。例如：📊、📈、🗺️。',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string', description: '相对于 .CodePapr/apps/<appId>/ 的文件路径。例如：server.js、package.json。' },
              content: { type: 'string', description: '文件完整内容。' },
            },
            required: ['relativePath', 'content'],
          },
          description: '可选。额外的后端文件列表（server.js、package.json 等）。每个文件包含 relativePath 和 content。',
        },
        command: {
          type: 'string',
          description: '可选。后端启动命令名。例如：node。如果提供，应用将具有后端服务，用户可点击"运行"启动。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。后端启动命令参数。例如：["server.js"]。仅在提供 command 时有效。',
        },
        port: {
          type: 'number',
          description: '可选。后端服务端口号。例如：3456。如果提供 command，必须同时提供 port。',
        },
      },
      required: ['appId', 'title', 'html'],
    },
  },
  ...EXTENDED_WORKSPACE_INTELLIGENCE_TOOL_DEFINITIONS,
  ...MERGE_TOOL_DEFINITIONS,
];

function toolByName(name: string): IToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具定义不存在: ${name}`);
  }
  return tool;
}

export { tools, toolByName };
