---
name: Nudge
description: 赭墨纸感 UI：以温暖纸张、文楷任务标题和明确状态反馈组织日常任务与学习。
colors:
  bg: "#f5f4ed"
  surface: "#faf9f5"
  surface-warm: "#e8e6dc"
  surface-hover: "#f1eee5"
  field-paper: "#fffefa"
  ink: "#141413"
  ink-secondary: "#5e5d59"
  meta: "#6f6d65"
  border: "#d8d5ca"
  border-strong: "#c7c3b5"
  accent: "#c96442"
  accent-strong: "#aa4e31"
  accent-deep: "#8f3f28"
  accent-wash: "#f4dfd6"
  accent-on: "#faf9f5"
  success: "#247a48"
  success-wash: "#dcebdd"
  warning: "#9a681b"
  danger: "#a53b38"
  danger-wash: "#f1ddda"
typography:
  headline:
    fontFamily: "'LXGW WenKai Screen', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'LXGW WenKai Screen', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "1.0625rem"
    lineHeight: 1.5
  content-input:
    fontFamily: "'LXGW WenKai Screen', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
  body:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  label:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
  metadata:
    fontFamily: "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif"
    fontSize: "0.6875rem"
rounded:
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  pill: "999px"
  circle: "50%"
spacing:
  space-1: "0.25rem"
  space-2: "0.5rem"
  space-3: "0.75rem"
  space-4: "1rem"
  space-6: "1.5rem"
  space-8: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.accent-on}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
  button-danger-hover:
    backgroundColor: "{colors.danger-wash}"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.meta}"
    rounded: "{rounded.sm}"
    padding: "0"
  text-field:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
    height: "2.35rem"
  text-field-focus:
    backgroundColor: "{colors.field-paper}"
  navigation-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 0.5rem"
  status-chip:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 0.55rem"
  task-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "0.5rem 0.5rem 0.5rem 0"
  task-row-hover:
    backgroundColor: "{colors.surface-hover}"
  roadmap-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
    width: "11.875rem"
  learning-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
  learning-tab-selected:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-deep}"
---

# Design System: Nudge

## Overview

**Creative North Star: "赭墨纸感 UI"**

Nudge 延续 [参考界面](https://invite.ioll.pp.ua/) 确立的温暖纸张感：米白底、暖白纸面、深墨文字与少量赭橙动作提示。它服务于长时间阅读和连续记录，气质克制、手作、灵动；文楷任务标题是阅读锚点，日期、表单和快捷键信息保持系统控件的清晰度。

当前实现把日常任务和学习工作区放在同一纸面应用框架内。任务按细分隔线排列，主要操作清楚可见，辅助操作通过菜单收拢。触感来自悬停、焦点、按下、保存、完成和撤销等真实状态，避免与用户操作无关的装饰动画。

**Key Characteristics:**

- 温暖浅色纸面、深墨排版、赭橙强调；状态色承担明确含义。
- 文楷突出任务内容，Segoe UI Variable 承担控件、日期、数字和辅助说明。
- 纸面容器保留留白，任务与资料使用紧凑的分隔行。
- 每项操作有可见结果、进行中状态或可恢复的失败反馈。

本文件记录当前渲染器的设计系统。颜色与基础控件来自 `src/renderer/src/styles.css`，日常任务和学习布局分别由 `features/tasks/tasks.css`、`features/learning/workspace.css` 修正。原有身份约定保留，布局与交互以实际使用的组件和最终样式层叠为准。

## Colors

主调是温暖中性色；赭橙承担动作和注意力，不铺满内容区。前置 YAML 是颜色值的唯一规范来源。

### Primary

- **赭橙 / accent**：品牌标记、焦点轮廓、进度和少量动作图形。
- **深赭 / accent-strong**：带浅色文字的主要操作，包括普通添加、生成推荐与紧凑主按钮。
- **浓赭 / accent-deep**：主要按钮悬停、赭橙浅底上的文字、学习入口和原计划日期。
- **浅赭 / accent-wash**：选中标签、学习图标底和焦点相关的轻量提示。
- **纸白反色 / accent-on**：实色按钮与完成标记上的前景。

**The Readable Action Rule.** 带浅色文字的主要操作使用深赭，悬停使用浓赭；品牌赭橙保留在标记和强调处。禁用按钮的减淡是状态表达，不是正常操作的颜色基准。

### Neutral

- **背景纸 / bg**：应用框架、侧栏、专注栏和常规表单底色。
- **内容纸 / surface**：主纸面、详情抽屉、菜单、学习工作区和选中导航项。
- **叠纸 / surface-warm**：状态胶囊和轻量分组底。
- **轻扫纸 / surface-hover**：任务、资源、次要按钮和搜索结果的悬停底。
- **亮纸 / field-paper**：快速输入、聚焦字段和路线画布等需要更明确边界的区域；它是重复使用的字面量色，不是现有 CSS 自定义属性。
- **墨 / ink、次墨 / ink-secondary、注记 / meta**：依次承担主要内容、辅助控件和元数据。
- **纸边 / border、深纸边 / border-strong**：分隔线、字段轮廓、菜单和路线节点边界。

### Status

成功绿用于完成和可用状态，警示棕用于警告与中等优先级，错误红及浅红底用于失败、删除和需要重试的反馈。状态同时配合文字、图标、勾选或删除线表达。学习状态胶囊可以使用这些语义色；不要把它们扩展为第二套品牌配色。

`.impeccable/design.json` 的八阶色带供设计面板比较颜色，属于合成预览，不新增应用颜色令牌。

## Typography

**Display / content font:** LXGW WenKai Screen，回退 Microsoft YaHei UI、system-ui、sans-serif。品牌、页面标题、任务标题、子任务标题、快速捕获输入和学习内容标题使用文楷。

**Control / body font:** Segoe UI Variable，回退 Segoe UI、Microsoft YaHei UI、system-ui、sans-serif。全局正文、表单控件、说明、日期、统计和快捷键使用这组字体。当前实现没有把所有正文统一为文楷。

### Hierarchy

- 页面标题使用前置 `headline`；紧凑高度及移动布局缩至（1.5rem）。
- 任务标题使用 `title`，允许任意位置换行；移动布局缩至（1rem）。
- 文楷输入使用 `content-input`；详情标题采用更强层级（1.35rem、700、1.25 行高）。
- 学习分栏标题保持紧凑（0.875rem、1.2 行高）；路线节点标题更小（0.8125rem），应通过合理视口保持可读。
- 控件多采用 `label` 或（0.8125rem）；元数据采用 `metadata`，不承担主要任务信息。
- 全局正文行高为（1.5），备注字段为（1.6）；计时、数量与键帽使用等宽数字。

**The Two Voices Rule.** 让文楷讲述任务，让 UI 字体解释操作；日期、设置与快捷键不跟随标题更换字体。

## Layout

桌面使用全窗口框架，内部是一张有圆角、边界和留白的主纸面。标题栏高（2.625rem），侧栏宽（14.5rem），详情抽屉占（21.25rem）；主纸面填充剩余空间，外边距主要为（0.75rem），工具区和任务区使用（1.5rem）内边距。它不是网页式窄栏居中卡片墙。

日常页面为纵向弹性布局：标题和快速输入在上，可滚动的任务区在中，专注栏在下。今天把任务分成“此前未完成”和“今天安排”，原计划日期在任务元数据中保留。切入学习工作区时隐藏日常视图，返回恢复之前的列表滚动位置；切换任务视图会重置滚动。

学习工作区独立占用主纸面的内容区，不在任务行下展开。宽容器采用资料、视频、路线三栏（1fr / 1fr / 1.25fr），各栏内容独立滚动，分隔线划分区域。其容器宽度不超过（54rem）时改为三个可键盘切换的标签页，只展示当前栏；该判断使用容器宽度，因此侧栏和抽屉占据的空间也会影响布局。当前工作区没有平板双排模式。

| 条件 | 实际布局 |
| --- | --- |
| 视口宽度不超过 68rem | 详情改为右侧覆盖层，宽度为 min(23rem, 100vw − 6rem)。 |
| 视口宽度不超过 58.75rem | 桌面侧栏收为 4.75rem 图标栏；移动条件优先。 |
| 宽度不超过 56rem，或不超过 64rem 且为竖屏 | 保留移动顶栏搜索与设置入口，隐藏侧栏；下方显示五项导航，详情改为全屏。 |
| 移动顶栏与底部导航 | 顶栏为 3rem 加顶部安全区；主内容预留底部导航与安全区，专注操作保持可达。 |
| 视口高度不超过 42rem | 压缩工具区上边距、标题和专注栏高度。 |
| 学习工作区容器不超过 54rem | 显示三个至少 2.75rem 高的标签按钮，隐藏非当前学习栏。 |

间距以现有（0.25rem）步进为基础，复用前置 spacing 中的刻度；局部控件允许更细的间距调整。触摸布局保留常驻菜单入口，将学习与专注等任务操作收进同一菜单，不依赖悬停发现。

**The Available Width Rule.** 学习栏数由工作区可用宽度决定，不由设备名称决定。

样式顺序是布局约束：`main.tsx` 先导入 `styles.css`，再导入 `features/tasks/tasks.css`，最后导入 `features/learning/workspace.css`。ReactFlow 的基础样式随 `RoadmapColumn` 所在学习模块延迟导入。维护时检查最终层叠，不能把基础样式里已被覆盖的行内工作区、平板双排或隐藏移动顶栏规则当作当前设计。

## Elevation & Depth

纸面颜色、细边线和有限阴影共同表达层次。主纸面与任务行通常保持平整；阴影用于选中导航、聚焦捕获区、实色主按钮、拖拽对象以及浮层。普通任务悬停只改变底色，不产生阴影。命令面板和专注切换对话框使用半透明深墨遮罩，内容表面保持实色纸面。

### Shadow Vocabulary

- 选中导航：`0 2px 5px rgb(20 20 19 / 7%)`。
- 聚焦快速输入：`0 4px 8px rgb(90 47 31 / 9%)`。
- 主要按钮：`0 3px 6px rgb(120 52 29 / 16%)`。
- 拖拽任务：`0 6px 8px rgb(20 20 19 / 14%)`。
- 任务菜单：`0 6px 24px rgb(20 20 19 / 14%)`。
- 路线节点：`0 3px 6px rgb(20 20 19 / 8%)`。
- 命令面板：`0 8px 14px rgb(20 20 19 / 20%)`。

**The State Earns Depth Rule.** 用深度解释选中、聚焦、拖拽或覆盖关系；常规任务列表依靠纸色和分隔线组织信息。

## Shapes

主纸面、详情和对话框使用较大圆角（lg，16px）；快速输入、任务菜单、专注栏和路线节点使用中圆角（md，12px）；按钮、字段与导航主要使用小圆角（sm，8px）。不要把“12–16px 纸面圆角”误用为所有小控件的统一尺寸。

任务行是平直底边的分隔行，圆角为零；拖拽时恢复中圆角。完成、进度和状态开关使用圆形；紧凑状态标签使用胶囊形。资料和视频也按底边分隔的行组织，路线节点才使用独立小卡片。

## Components

### Buttons

按钮短而明确，文本动作优先。主要按钮采用深赭底与纸白文字，悬停加深，按下轻缩；常规最小高度（2.25rem）、水平内边距（0.75rem）。普通添加和学习生成复用相同颜色语义，各自保留紧凑尺寸。

次要按钮采用透明底、纸边与次墨文字，悬停加入轻扫纸底；危险按钮使用错误色文字和轻边框，悬停为浅红底。图标按钮默认透明，悬停显底色，必须保留可访问名称。禁用态降低不透明度（0.48），提交中继续显示动作状态。

### Inputs / Quick capture

快速输入是日常页面最主要的动作：输入和普通“添加”位于第一行；展开后的第二行容纳日期、清单、语法提示与次要的“添加并规划学习”。普通添加先完成本地任务捕获，不要求进入学习。新增成功后保持输入焦点，支持连续记录，并尊重中文输入法的组合状态。

快速输入采用亮纸底、完整细边和中圆角；聚焦时边框转为赭橙、轻升（1px）并出现短阴影。普通字段使用背景纸底与小圆角，聚焦时转为亮纸底。字段保留可见标签；通用键盘焦点为赭橙轮廓（2px、外偏移 2px），输入组合可由外层聚焦样式承接。

### Task rows and shared actions

任务行以完成圆钮、文楷任务标题、紧凑元数据和尾部操作构成，最小高度（4rem）。标题可换行；完成态使用勾选、删除线与注记色。桌面学习、专注和更多操作常驻，拖拽把手在悬停或键盘焦点下显现；触摸布局由常驻更多菜单承接学习与专注。

更多菜单使用浏览器 popover 顶层，包含日期安排、详情、学习、专注、完成与删除等任务动作；清单归属在详情中编辑。列表和详情共享完成、安排与删除行为。成功操作提供默认（5秒）撤销提示；悬停、键盘焦点或正在执行撤销时暂停消失计时，失败保留可重试信息。

拖拽使用实际排序位移、抓取光标、亮纸底和阴影反馈。当前实现不承诺插入线、墨点喷散或完成后的专用折叠动画；已不被组件使用的旧动画样式不是设计规范。

### Detail and save feedback

详情在标题区显示“等待保存…”、“保存中…”、“已保存”或“保存失败”。编辑停顿（600ms）或字段失焦触发保存；失败时草稿保留，并显示“重试保存”。

错误条是标题下独立的自动高度网格行，正文仍占可滚动的剩余空间，底部动作保持可见。默认详情为标题、正文、页脚三行；错误态增加一行，不把错误内容塞进正文的弹性行。任务标题、备注、日期、清单等编辑和学习入口共同遵守此结构。

### Navigation and global search

桌面选中导航使用内容纸底、轻阴影、加粗文字与赭橙小点；移动导航使用图标和文字，选中态为浓赭。顶部搜索入口在移动端仍可见。

搜索与命令共用居中的顶层面板，可通过 Ctrl/Cmd+K 或 Ctrl/Cmd+F 打开；任务搜索覆盖标题、备注与标签，包含完成任务和子任务，排除已删除任务。结果支持方向键选择、Enter 打开、Esc 关闭，关闭后恢复触发前焦点。命令面板使用暖纸底和可滚动结果区，搜索范围覆盖所有未删除的任务。

### Learning workspace

学习页先提供“返回任务列表”，再显示当前任务标题与生成动作；不增加“学习包”装饰眉题。三栏使用共用的紧凑标题、工具操作、进度和失败重试模式。窄容器标签通过左右方向键、Home 和 End 切换，并同步键盘焦点。

资源行在悬停与焦点时显示操作，触摸环境保留可达操作。路线图初始以（zoom 1）围绕首节点显示，保持文字可读；“显示全图”是明确操作，不在每次进入时自动缩小所有节点。图表和列表可切换，节点支持拖动、连线、自动布局、状态切换和撤销。ReactFlow 提供缩放控件，范围为（0.35–1.8）。

生成时显示正在规划、取消入口与各栏进度；单栏失败可单独重试。首次联网生成的信息确认位于工作区内，用户能看到即将发送的信息范围。学习加载失败仍保留返回和重试入口。

### Focus and motion

专注栏呈现当前任务、阶段、稳定宽度的计时和操作。空闲态显示自由计时与设置中的番茄时长；正在专注时切到另一任务，先通过对话框“保存并切换”。失败显示可重试反馈，进行中的操作避免重复提交。

控件悬停和颜色变化主要为（150–180ms），按下反馈为（100–120ms）；学习页及提示进入为（200ms），详情过渡为（260ms），框架列宽调整与勾选反馈为（280ms）。主要 CSS 缓动使用现有 quart / quint 自然减速曲线，局部采用 ease-out；不把所有动画误写成同一个时长或缓动。

系统减少动画由 MotionConfig 与 CSS 共同处理：保留最终状态，关闭或近乎即时完成过渡、旋转和骨架动效，取消依赖位移的反馈。状态文字、轮廓与图标仍然可辨认。

## Do's and Don'ts

### Do:

- **Do** 沿用赭墨纸感身份和现有令牌，保持暖纸面积与深墨阅读层级。
- **Do** 用文楷突出任务内容，用 Segoe UI Variable 呈现控件、日期与快捷键。
- **Do** 以最终样式层叠和容器实际宽度确认布局，保持独立学习工作区与返回位置。
- **Do** 为悬停、焦点、按下、加载、保存、完成和撤销提供与操作对应的反馈。
- **Do** 让错误与重试占据稳定空间，保留草稿和可恢复的任务操作。
- **Do** 为触摸和键盘保留操作路径，并尊重系统减少动画设置。

### Don't:

- **Don't** 引入玻璃内容表面、霓虹渐变、Windows 默认蓝、企业 SaaS 卡片墙或过度阴影。
- **Don't** 把普通任务改成无分隔卡片，或为每个任务悬停添加浮起阴影。
- **Don't** 恢复任务下方行内学习区、平板双排布局或自动缩小到全图的初始路线视口。
- **Don't** 用品牌赭橙替换带浅色文字的深赭主按钮，削弱正常状态的可读性。
- **Don't** 把未渲染的墨点、插入线、装饰眉题或旧样式当作已实现的品牌交互。
- **Don't** 只用颜色表示状态，或在移动端将关键操作藏到悬停后。
