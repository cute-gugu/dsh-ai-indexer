# dsh-ai-indexer

给 AI 一份**受 token 预算约束的项目索引**，而不是每个会话重新读完整个代码库。

它做四件事：

1. **增量扫描**：只看改动过的文件，把项目折叠成「模块 + 契约 + 风险」三张表。
2. **受控注入**：把索引压缩成一份几百 token 的快照，按需前置给模型；全量索引留在磁盘上，不占上下文。
3. **交付后复盘**：本轮改动完成后，用宿主原生的问答卡片问你几个最该确认的问题，结论落盘可查。
4. **避免重复造轮子**：动手实现通用设施（配置、事件总线、序列化、UI 基类…）之前，先确认有没有现成的。

索引的事实来源是**你源码里的注释标记**，不是插件的数据库。插件不修改任何源码。

## 安装

```bash
dsh plugin --profile <profile> add link:<本目录绝对路径>
```

或在本仓库工作区里用 harness 的 `plugin_manager` 安装 `install_bundle`，目标填本目录。

安装后重启（或热载）一次宿主。左侧栏会出现「项目索引」入口，设置 → 插件里也会多一页。

## 标记规范

在源码注释里写（任何语言都可以，插件按注释语法抓）：

| 标记 | 作用 |
| --- | --- |
| `@ai:module <名字>` | 把这个文件归到哪个模块；省略时按所在目录自动归组 |
| `@ai:status done\|wip\|planned\|blocked\|deprecated\|frozen` | 模块状态，进进度看板 |
| `@ai:contract <说明或 函数名()>` | 对外承诺；函数名会被拿去和源码里的符号核对，不一致就报风险 |
| `@ai:risk <一句话>` | 已知风险，直接进风险面板 |
| `@ai:note <一句话>` | 给下一位读者留的说明 |
| `@ai:deps <名字或相对路径>` | 依赖项；写成项目内相对路径而磁盘上不存在时会告警 |
| `@ai:ref <项目或链接>` | 同类实现 / 参考来源 |
| `@ai:ecosystem <标签>` | 生态标签，用作轮子检索的关键词 |
| `@ai:owner <子系统或人>` | 归属 |

例子（Lua / JS / Python / Go / Rust / C 系都吃同一套）：

```lua
--[[
@ai:module OptionsPanel
@ai:status wip
@ai:contract 输出:RegisterOption() 入参:table
@ai:risk 界面缩放未兼容多分辨率
@ai:ref PigOptions
]]
```

```js
/**
 * @ai:module auth/token
 * @ai:status done
 * @ai:contract 输出:issueToken(userId) verify(token)
 * @ai:deps ./storage
 */
```

一个文件都不写标记也能用：没有标记的文件会按目录自动归组成模块，先给你一张结构图。

## 工具（模型调用）

| 工具 | 用途 |
| --- | --- |
| `ai_index_scan` | 扫描/增量更新索引。改了模块接口、状态或依赖之后调用 |
| `ai_index_query` | 按模块名或关键词查模块、符号、契约、风险、依赖 |
| `ai_index_review` | 交付后复盘，走原生问答卡片 |
| `ai_index_wheel` | 通用设施动手前的轮子检索；可回写检索结论做缓存 |

## 命令（人用）

```
/ai-index scan      # 扫描
/ai-index status    # 看状态
/ai-index review    # 复盘说明
```

设置 → 插件 → 项目索引，或是左侧栏图标，可以打开完整面板：指纹、模块表、风险面板、变更切片、快照预览、复盘结论。

## 产生的文件

| 文件 | 谁写 | 会不会进对话 |
| --- | --- | --- |
| `.ai-index/meta.json` | **只有你** | 否 |
| `.ai-index/index.json` | 插件 | 否 |
| `.ai-index/snapshot.md` | 插件 | 是（只有稳定段） |
| `.ai-index/master.md` | 插件 | 需要时读 |
| `.ai-index/cache.json` | 插件 | 否 |
| `.ai-index/decisions.json` | 插件（追加） | 否 |
| `README.md` 里的 `<!-- ai-index:sync -->` 区块 | 插件 | 否 |

`meta.json` 第一次扫描时创建，之后**永不覆盖**——你对它的修改是权威的。常用的几个开关：

```jsonc
{
  "enabled": true,             // 整个插件开关
  "injectSnapshot": true,      // 是否把快照前置进对话
  "snapshotBudgetTokens": 1200,// 快照的硬 token 上限
  "snapshotTemplate": "general", // general | minimal | deep
  "injectOrder": 60,           // 快照在提示词里的排序
  "watch": false,              // 监听文件变化自动重扫
  "advisor": { "enabled": true, "maxQuestions": 4, "timeoutMs": 180000 },
  "wheel": { "enabled": true, "cacheDays": 7 }
}
```

## 设计取舍

- **索引 100% 派生自源码。** 没有第二份需要同步的手写真相，因此不存在"索引和代码不一致"的修复流程——改源码标记，重扫即可。
- **快照是注入用的唯一形态。** 全量索引再大也不进上下文；快照按硬预算裁剪，装不下就少放几段，绝不无限增长。
- **复盘是工具触发的，不是钩子触发的。** 用钩子会在每次交付后强制多跑一轮模型，正好抵消这个插件省下的开销。
- **不写源码。** 复盘结论进 `decisions.json`，需要落到源码的 `@ai:` 标记由模型用普通编辑路径改，你能看到、能回滚。
- **不 import 任何 `@deepseek-ai/*` 包。** 两个半边只依赖 node 内置模块与浏览器 `react`，安装不需要联网取包。
