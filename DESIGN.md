# Nudge Design System

## Overview

这套视觉体系命名为「赭墨纸感 UI」（Ochre Ink Paper UI），视觉北极星是 `https://invite.ioll.pp.ua/`。界面应像一张放在桌面上的温暖任务纸：安静的米白背景、暖白内容表面、深墨文字和少量赭橙动作提示。强交互感来自状态变化，而不是装饰性特效。

## Identity

- 识别词：赭墨纸感 UI。
- 核心印象：温暖纸张、深墨排版、赭橙动作痕迹、克制而明确的触感反馈。
- 当后续需求直接提到「赭墨纸感」时，默认沿用本文的色彩、字体、留白、圆角、阴影、动效和交互原则。

## Physical Scene

用户会在白天或暖色台灯下长时间使用电脑，也会在通勤或临时记录时使用手机和平板；界面需要不刺眼、不打断思路，并在完成、拖拽、生成和同步时给出明确回应，因此首版统一采用浅色主题。

## Color Strategy

Restrained。中性色承担绝大部分面积，赭橙只用于主要操作、选中、焦点和完成反馈。

### Core Tokens

- Background: `#f5f4ed` / `oklch(96.4% 0.012 91)`
- Surface: `#faf9f5` / `oklch(98.1% 0.008 91)`
- Surface warm: `#e8e6dc` / `oklch(91.7% 0.014 91)`
- Ink: `#141413` / `oklch(18.8% 0.003 91)`
- Ink secondary: `#5e5d59` / `oklch(47.5% 0.008 91)`
- Metadata: `#6f6d65` / `oklch(53.4% 0.012 95)`
- Accent: `#c96442` / `oklch(62.7% 0.142 39)`
- Accent strong: `#aa4e31` / `oklch(54.8% 0.139 39)`
- Accent deep: `#8f3f28` / `oklch(46.9% 0.115 37)`
- Accent wash: `#f4dfd6` / `oklch(90.5% 0.042 39)`
- Success: `#247a48` / `oklch(52.5% 0.11 153)`
- Warning: `#9a681b` / `oklch(55% 0.108 75)`
- Danger: `#a53b38` / `oklch(50.5% 0.137 27)`
- Border: `#d8d5ca` / `oklch(86.2% 0.014 91)`

## Typography

- Brand, headings and task titles: LXGW WenKai Screen, weights 500–700.
- Controls, dates, metadata and shortcuts: Segoe UI Variable, Segoe UI, system-ui.
- Fixed product scale: 0.75rem, 0.875rem, 1rem, 1.125rem, 1.375rem, 1.75rem.
- Body line height 1.55; headings 1.2–1.3; numeric timers use tabular numerals.

## Layout

- Window baseline: 1180 × 760; minimum 900 × 620.
- Title bar: 42px.
- Sidebar: 232px; primary timeline fills remaining space; detail drawer: 340px.
- Desktop learning pack: 30% resources / 30% videos / 40% roadmap.
- Tablet landscape: resources and videos share the first row; roadmap spans the second row.
- Tablet portrait and phone: full-screen learning workspace with three 44px tabs and safe-area padding.
- 4pt spacing scale: 4, 8, 12, 16, 24, 32, 48px.
- Product surfaces use 12–16px radii. Cards never nest inside cards.
- Under 1040px the detail drawer overlays; under 940px the sidebar becomes a compact rail.

## Components

- Primary buttons: 12px radius, solid accent, no border-plus-wide-shadow combination.
- Task rows: borderless by default, background tint and compact shadow only while hovering or dragging.
- Inputs: visible labels, warm-white fill, full perimeter border, 2px accent focus ring.
- Menus and command palette render in the top layer or portal to avoid clipping.
- Destructive actions use immediate removal plus a five-second undo toast.
- Learning resources expose actions on hover/focus and keep them visible in touch environments.
- Roadmap nodes support drag, connect, auto-layout, status cycling, undo and a list fallback.

## Motion

- Press feedback: 100–140ms.
- Hover and state changes: 160–220ms.
- Drawers and structural transitions: 240–320ms.
- Easing: ease-out-quart / ease-out-quint; no bounce or elastic easing.
- Signature moment: completing a task draws the check, strikes the title, releases three restrained accent ink dots, then collapses the row.
- Dragging raises the task by 2px and shows an explicit insertion line.
- Reduced motion converts movement to instant state changes or short crossfades.

## Content Voice

- Concise, specific, encouraging.
- Buttons use clear verb-object labels such as“添加任务”“保存更改”“开始专注”。
- Empty states explain the next useful action。
- Errors state what happened and how to recover, without blaming the user。
