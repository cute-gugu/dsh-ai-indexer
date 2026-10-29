/**
 * dsh-ai-indexer — browser half.
 *
 * Loaded through the host's module loader as a static bundle. The only things
 * available here are `require` (the browser module table) and the client
 * `apply(ctx)` context; data comes from this package's own HTTP routes.
 *
 * @module dsh-ai-indexer/client
 */
window.__ModuleLoader__.load({
  id: "dsh-ai-indexer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let reactModule = require("react");
    const React = reactModule && reactModule.default ? reactModule.default : reactModule;
    const h = React.createElement;

    const NS = "dsh-ai-indexer";
    const PACKAGE_NAME = "dsh-ai-indexer";
    const PANEL_ID = "ai-indexer";
    const API = "/ai-indexer/api";
    const REFRESH_MS = 20000;

    const name = "ai-indexer";
    const inject = ["slots", "locale", "theme"];

    const DICT = {
      zh: {
        title: "AI 项目索引",
        nav: "项目索引",
        pluginCard: "AI 项目索引",
        subtitle: "增量扫描代码库，给模型一份受预算约束的项目快照",
        rescan: "重新扫描",
        scanning: "扫描中…",
        copySnapshot: "复制快照",
        copied: "已复制快照",
        empty: "还没有索引。点「重新扫描」建立第一份索引。",
        unavailable: "无法读取索引服务（插件可能未挂载或宿主无 webServer）。",
        fingerprint: "指纹",
        scannedAt: "扫描时间",
        modules: "模块",
        files: "文件",
        marked: "带标记模块",
        pending: "未完成标记",
        snapshot: "快照",
        tokens: "tokens",
        risks: "风险与告警",
        noRisks: "没有告警。",
        progress: "进度看板",
        changes: "最近变化",
        decisions: "复盘结论",
        noDecisions: "还没有复盘结论。交付完成后让模型调用 ai_index_review。",
        markers: "标记规范",
        module: "模块",
        status: "状态",
        deps: "依赖",
        contracts: "契约",
        refs: "参考",
        owner: "归属",
        filesCount: "个文件",
        archived: "归档",
        injected: "已注入对话",
        notInjected: "未注入对话",
        error: "错误",
        workspace: "工作区",
        language: "zh",
      },
      en: {
        title: "AI Project Index",
        nav: "Project index",
        pluginCard: "AI Project Index",
        subtitle: "Incremental code scan that hands the model a budgeted project snapshot",
        rescan: "Rescan",
        scanning: "Scanning…",
        copySnapshot: "Copy snapshot",
        copied: "Snapshot copied",
        empty: "No index yet. Press Rescan to build the first one.",
        unavailable: "Index service unreachable (plugin not mounted, or no webServer on this host).",
        fingerprint: "Fingerprint",
        scannedAt: "Scanned",
        modules: "Modules",
        files: "Files",
        marked: "Marked modules",
        pending: "Open markers",
        snapshot: "Snapshot",
        tokens: "tokens",
        risks: "Risks",
        noRisks: "No warnings.",
        progress: "Progress",
        changes: "Recent changes",
        decisions: "Review decisions",
        noDecisions: "No decisions yet. Call ai_index_review after a delivery.",
        markers: "Marker reference",
        module: "Module",
        status: "Status",
        deps: "Deps",
        contracts: "Contracts",
        refs: "Refs",
        owner: "Owner",
        filesCount: "files",
        archived: "archived",
        injected: "injected into prompts",
        notInjected: "not injected",
        error: "Error",
        workspace: "Workspace",
        language: "en",
      },
    };

    const BORDER = "1px solid rgba(127,127,127,0.28)";
    const SOFT = "rgba(127,127,127,0.10)";

    const css = {
      panel: { display: "flex", flexDirection: "column", gap: "14px", padding: "18px 20px", color: "inherit", font: "inherit", overflowY: "auto", height: "100%", boxSizing: "border-box" },
      head: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
      title: { fontSize: "17px", fontWeight: 600, margin: 0 },
      sub: { opacity: 0.62, fontSize: "12px", margin: 0 },
      spacer: { flex: 1 },
      button: { padding: "5px 12px", borderRadius: "7px", border: BORDER, background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12px" },
      buttonDisabled: { opacity: 0.5, cursor: "default" },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" },
      card: { border: BORDER, borderRadius: "9px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "3px" },
      cardLabel: { fontSize: "11px", opacity: 0.6 },
      cardValue: { fontSize: "16px", fontWeight: 600 },
      section: { display: "flex", flexDirection: "column", gap: "8px" },
      sectionTitle: { fontSize: "13px", fontWeight: 600, margin: 0, opacity: 0.9 },
      list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "5px", fontSize: "12.5px" },
      row: { display: "flex", gap: "8px", alignItems: "baseline", border: BORDER, borderRadius: "8px", padding: "7px 10px" },
      badge: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: BORDER, whiteSpace: "nowrap", opacity: 0.9 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px" },
      pre: { border: BORDER, borderRadius: "8px", padding: "10px 12px", background: SOFT, overflow: "auto", maxHeight: "320px", margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "11.5px" },
      table: { width: "100%", borderCollapse: "collapse", fontSize: "12.5px" },
      th: { textAlign: "left", padding: "6px 8px", borderBottom: BORDER, fontWeight: 600, opacity: 0.75, fontSize: "11.5px" },
      td: { padding: "6px 8px", borderBottom: `1px solid ${SOFT}`, verticalAlign: "top" },
      strip: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11.5px", border: BORDER, borderRadius: "8px", padding: "3px 9px", color: "inherit", background: "transparent", cursor: "pointer" },
      detail: { opacity: 0.65, fontSize: "11.5px", marginTop: "2px" },
      logo: { display: "block", color: "currentColor" },
    };

    function makeT(ctx) {
      const local = (key) => {
        const locale = (ctx && ctx.__aiIndexerLocale) || "zh";
        const table = DICT[locale] || DICT.zh;
        return table[key] || DICT.zh[key] || key;
      };
      try {
        const bound = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : null;
        if (bound) {
          return (key) => {
            try {
              const value = typeof bound === "function" ? bound(key) : bound[key];
              if (typeof value === "string" && value.length > 0 && value !== key) return value;
            } catch {
              /* fall through to the local table */
            }
            return local(key);
          };
        }
      } catch {
        /* locale service unavailable; the local table still renders fine */
      }
      return local;
    }

    function statusIcon(status) {
      if (status === "done") return "✅";
      if (status === "wip") return "🚧";
      if (status === "planned") return "📝";
      if (status === "blocked") return "⛔";
      if (status === "deprecated") return "🗑️";
      if (status === "frozen") return "🧊";
      return "❔";
    }

    function riskIcon(severity) {
      if (severity === "error") return "⛔";
      if (severity === "warn") return "⚠️";
      return "ℹ️";
    }

    function useIndexState() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(() => {
        let cancelled = false;
        fetch(`${API}/state`, { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((payload) => {
            if (!cancelled) {
              setState(payload);
              setError(null);
            }
          })
          .catch((cause) => {
            if (!cancelled) setError(String((cause && cause.message) || cause));
          });
        return () => {
          cancelled = true;
        };
      }, []);

      React.useEffect(() => {
        const cancel = load();
        const timer = setInterval(load, REFRESH_MS);
        return () => {
          cancel();
          clearInterval(timer);
        };
      }, [load]);

      const rescan = React.useCallback(() => {
        setBusy(true);
        fetch(`${API}/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then((response) => response.json())
          .then((payload) => {
            if (payload && payload.state) setState(payload.state);
            else load();
            if (payload && payload.ok === false) setError(payload.error || "scan failed");
          })
          .catch((cause) => setError(String((cause && cause.message) || cause)))
          .finally(() => setBusy(false));
      }, [load]);

      return { state, error, busy, load, rescan };
    }

    function card(t, label, value) {
      return h("div", { style: css.card, key: label }, [
        h("span", { style: css.cardLabel, key: "l" }, label),
        h("span", { style: css.cardValue, key: "v" }, value),
      ]);
    }

    function StatusStrip({ t }) {
      const { state, busy, rescan } = useIndexState();
      if (!state || !state.ok || !state.fingerprint) return null;
      const warnings = (state.stats && state.stats.risks && state.stats.risks.warn) || 0;
      const label = busy ? t("scanning") : `${t("fingerprint")} ${String(state.fingerprint).slice(0, 8)}　${state.stats.modules} ${t("modules")}　${warnings} ${t("risks")}`;
      return h(
        "button",
        { style: css.strip, onClick: rescan, title: state.root || "", type: "button" },
        [
          h("span", { key: "a" }, "🧭"),
          h("span", { key: "b" }, label),
          h("span", { key: "c", style: { opacity: 0.5 } }, state.snapshotTokens ? `${state.snapshotTokens} ${t("tokens")}` : ""),
        ],
      );
    }

    function RiskList({ t, risks, limit }) {
      const list = (risks || []).filter((risk) => risk.severity !== "info").slice(0, limit || 20);
      if (list.length === 0) return h("p", { style: css.detail }, t("noRisks"));
      return h(
        "ul",
        { style: css.list },
        list.map((risk, index) =>
          h("li", { style: css.row, key: `${risk.kind}-${index}` }, [
            h("span", { key: "i" }, riskIcon(risk.severity)),
            h("span", { key: "b", style: css.badge }, risk.kind),
            h("span", { key: "m" }, `${risk.module ? `${risk.module}：` : ""}${risk.message}`),
          ]),
        ),
      );
    }

    function ModuleTable({ t, modules }) {
      const list = (modules || []).slice(0, 200);
      if (list.length === 0) return h("p", { style: css.detail }, t("noRisks"));
      return h(
        "table",
        { style: css.table },
        [
          h("thead", { key: "h" }, h("tr", null, [
            h("th", { style: css.th, key: "m" }, t("module")),
            h("th", { style: css.th, key: "s" }, t("status")),
            h("th", { style: css.th, key: "f" }, t("files")),
            h("th", { style: css.th, key: "c" }, t("contracts")),
            h("th", { style: css.th, key: "d" }, t("deps")),
          ])),
          h("tbody", { key: "b" }, list.map((module) =>
            h("tr", { key: module.id }, [
              h("td", { style: css.td, key: "m" }, [
                h("span", { key: "n", style: css.mono }, module.id),
                module.marker ? h("span", { key: "k", style: { ...css.badge, marginLeft: "6px" } }, "@ai") : null,
              ]),
              h("td", { style: css.td, key: "s" }, `${statusIcon(module.status)} ${module.status}`),
              h("td", { style: css.td, key: "f" }, `${module.files} ${t("filesCount")}${module.pending ? ` · ${module.pending} ${t("pending")}` : ""}`),
              h("td", { style: css.td, key: "c" }, (module.contracts || []).length === 0 ? "-" : h("div", { style: css.detail }, module.contracts.map((contract) => h("div", { key: contract.rel }, contract.text)))),
              h("td", { style: css.td, key: "d" }, (module.deps || []).length === 0 ? "-" : h("span", { style: css.mono }, module.deps.join(", "))),
            ]),
          )),
        ],
      );
    }

    function Panel({ t }) {
      const { state, error, busy, rescan } = useIndexState();
      const [notice, setNotice] = React.useState(null);
      const copy = React.useCallback(() => {
        if (!state || !state.snapshotPreview) return;
        try {
          navigator.clipboard.writeText(state.snapshotPreview).then(() => setNotice(t("copied"))).catch(() => setNotice(null));
        } catch {
          setNotice(null);
        }
      }, [state, t]);

      const header = h("div", { style: css.head, key: "h" }, [
        h("div", { key: "t" }, [
          h("h2", { style: css.title }, t("title")),
          h("p", { style: css.sub }, t("subtitle")),
        ]),
        h("span", { style: css.spacer, key: "sp" }),
        h("button", { style: { ...css.button, ...(busy ? css.buttonDisabled : {}) }, onClick: rescan, disabled: busy, type: "button", key: "r" }, busy ? t("scanning") : t("rescan")),
        h("button", { style: css.button, onClick: copy, type: "button", key: "c" }, notice || t("copySnapshot")),
      ]);

      if (!state) {
        return h("div", { style: css.panel }, [header, h("p", { style: css.detail }, error ? `${t("error")}: ${error}` : t("unavailable"))]);
      }
      if (!state.fingerprint) {
        return h("div", { style: css.panel }, [
          header,
          h("p", { style: css.detail }, error ? `${t("error")}: ${error}` : t("empty")),
          state.root ? h("p", { style: css.detail }, `${t("workspace")}: ${state.root}`) : null,
        ]);
      }

      const stats = state.stats || {};
      const statuses = stats.statuses || {};
      const progress = Object.keys(statuses).filter((key) => statuses[key] > 0).map((key) => `${statusIcon(key)} ${key} ${statuses[key]}`);

      return h("div", { style: css.panel }, [
        header,
        h("p", { style: css.sub, key: "meta" }, `${t("workspace")}: ${state.root}　${t("scannedAt")}: ${state.at || "-"}　${state.injectSnapshot ? t("injected") : t("notInjected")}`),
        state.lastError ? h("p", { style: { ...css.detail, color: "inherit" }, key: "err" }, `${t("error")}: ${state.lastError}`) : null,

        h("div", { style: css.grid, key: "grid" }, [
          card(t, t("fingerprint"), String(state.fingerprint).slice(0, 10)),
          card(t, t("modules"), `${stats.modules || 0} / ${t("marked")} ${stats.markedModules || 0}`),
          card(t, t("files"), String(stats.files || 0)),
          card(t, t("pending"), String(stats.pending || 0)),
          card(t, t("snapshot"), `${state.snapshotTokens || 0} ${t("tokens")}`),
          card(t, t("risks"), String(((stats.risks || {}).warn || 0))),
        ]),

        h("div", { style: css.section, key: "prog" }, [
          h("h3", { style: css.sectionTitle }, t("progress")),
          h("div", { style: css.detail }, progress.length > 0 ? progress.join("　") : "-"),
        ]),

        h("div", { style: css.section, key: "risks" }, [
          h("h3", { style: css.sectionTitle }, t("risks")),
          h(RiskList, { t, risks: state.risks, limit: 30 }),
        ]),

        h("div", { style: css.section, key: "modules" }, [
          h("h3", { style: css.sectionTitle }, t("modules")),
          h(ModuleTable, { t, modules: state.modules }),
        ]),

        (state.changes || []).length > 0 ? h("div", { style: css.section, key: "changes" }, [
          h("h3", { style: css.sectionTitle }, t("changes")),
          h("ul", { style: css.list }, state.changes.slice(0, 12).map((change, index) =>
            h("li", { style: css.row, key: `${change.rel}-${index}` }, [
              h("span", { key: "k", style: css.badge }, change.kind),
              h("span", { key: "r", style: css.mono }, change.rel),
            ]),
          )),
        ]) : null,

        h("div", { style: css.section, key: "decisions" }, [
          h("h3", { style: css.sectionTitle }, t("decisions")),
          (state.decisions || []).length === 0
            ? h("p", { style: css.detail }, t("noDecisions"))
            : h("ul", { style: css.list }, state.decisions.slice(0, 12).map((decision, index) =>
                h("li", { style: css.row, key: `d-${index}` }, [
                  h("span", { key: "k", style: css.badge }, decision.kind || "review"),
                  h("span", { key: "m" }, `${decision.module ? `${decision.module}：` : ""}${decision.choice || ""}`),
                ]),
              )),
        ]),

        h("div", { style: css.section, key: "snap" }, [
          h("h3", { style: css.sectionTitle }, `${t("snapshot")} (${t("tokens")})`),
          h("pre", { style: css.pre }, state.snapshotPreview || ""),
        ]),

        h("div", { style: css.section, key: "markers" }, [
          h("h3", { style: css.sectionTitle }, t("markers")),
          h("ul", { style: css.list }, (state.markerSpec || []).map(([syntax, meaning], index) =>
            h("li", { style: css.row, key: `m-${index}` }, [
              h("span", { key: "s", style: css.mono }, syntax),
              h("span", { key: "t", style: css.detail }, meaning),
            ]),
          )),
        ]),
      ]);
    }

    function SettingsCard({ t, view }) {
      if (view === "summary") return null;
      return h(Panel, { t });
    }

    function Logo({ size }) {
      const s = size || 16;
      return h(
        "svg",
        { width: s, height: s, viewBox: "0 0 32 32", style: css.logo, "aria-hidden": "true" },
        [
          h("rect", { key: "r", x: 3, y: 4, width: 26, height: 24, rx: 4, fill: "none", stroke: "currentColor", strokeWidth: 2 }),
          h("line", { key: "l1", x1: 9, y1: 11, x2: 23, y2: 11, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }),
          h("line", { key: "l2", x1: 9, y1: 16, x2: 19, y2: 16, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }),
          h("line", { key: "l3", x1: 9, y1: 21, x2: 15, y2: 21, stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }),
          h("circle", { key: "c", cx: 24, cy: 21, r: 3, fill: "currentColor" }),
        ],
      );
    }

    function apply(ctx) {
      let t = makeT(ctx);
      try {
        ctx.effect(() => {
          ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
          t = makeT(ctx);
        }, "dsh-ai-indexer: dictionaries");
      } catch (error) {
        console.error("[dsh-ai-indexer] locale registration failed; using the built-in table", error);
      }

      const register = (options, component) => {
        try {
          ctx.slots.register(options, component);
        } catch (error) {
          console.error(`[dsh-ai-indexer] slot ${options.name} registration failed`, error);
        }
      };

      register({ name: "settings.plugins.tab", id: PANEL_ID, order: 30, label: () => t("nav"), locale: NS, inject: () => ({ t }) }, () => h(Panel, { t }));
      register({ name: "main", key: PANEL_ID, locale: NS, inject: () => ({ t }) }, () => h(Panel, { t }));
      register({ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => t("nav"), locale: NS }, (owner) => h(Logo, { size: (owner && owner.size) || 16 }));
      register({ name: "plugins.bundle.config", key: PACKAGE_NAME, locale: NS, inject: () => ({ t }) }, (ownerProps) => h(SettingsCard, { t, view: ownerProps && ownerProps.view }));
      register({ name: "plugins.item", id: PANEL_ID, order: 40, label: () => t("pluginCard"), locale: NS, inject: () => ({ t }) }, () => h(SettingsCard, { t, view: "card" }));
      register({ name: "conversation.composer.dock", id: PANEL_ID, order: 40, locale: NS, inject: () => ({ t }) }, () => h(StatusStrip, { t }));

      if (typeof ctx.provide === "function") {
        try {
          ctx.provide("aiIndexer", { open: () => undefined });
        } catch {
          /* providing a handle is a nicety, not a requirement */
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.DICT = DICT;

    return module.exports;
  },
});
