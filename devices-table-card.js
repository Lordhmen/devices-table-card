/*
 * devices-table-card — таблица устройств для Home Assistant.
 *
 * Два режима:
 *   network      — сетевые устройства из трекеров (device_tracker): IP, сеть/порт, MAC, статус,
 *                  известные/неизвестные по метке, кнопка «в известные» прямо в строке;
 *   availability — устройства «не в сети» из атрибута-списка сенсора (например, sensor.offline_devices),
 *                  кнопка «не отслеживать» ставит метку на устройство.
 *
 * Сортировка по клику на заголовок, фильтры, поиск, экспорт CSV, тема HA (тёмная и светлая).
 *
 * https://github.com/Lordhmen/devices-table-card
 * Лицензия: MIT. История изменений — CHANGELOG.md.
 */
const DTC_VERSION = "0.2.1";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "device_tracker.lan_*" -> RegExp
function globRe(g) {
  return new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

// IP -> строка для сортировки; пустой IP уходит в конец
function ipKey(ip) {
  if (!ip) return "~";
  const p = String(ip).split(".");
  if (p.length !== 4) return "}" + ip;
  return p.map((x) => String(parseInt(x, 10) || 0).padStart(3, "0")).join(".");
}

// Локально администрируемый (случайный) MAC: второй символ 2, 6, A или E
function isRandomMac(mac) {
  return /^.[26AE]/i.test(mac || "");
}

const DTC_STRINGS = {
  online: "в сети",
  offline: "не в сети",
  nodata: "нет данных",
  ago: "назад",
  m: "мин",
  h: "ч",
  d: "д",
  justnow: "только что",
  ignored: "не отслеживается",
};

function relTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return DTC_STRINGS.justnow;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${DTC_STRINGS.m}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${DTC_STRINGS.h}${m % 60 && h < 10 ? ` ${m % 60} ${DTC_STRINGS.m}` : ""}`;
  return `${Math.floor(h / 24)} ${DTC_STRINGS.d}`;
}

const MODES = {
  network: {
    columns: [
      { key: "name", title: "Устройство", cls: "c-name" },
      { key: "ip", title: "IP", cls: "c-ip", sort: (r) => ipKey(r.ip) },
      { key: "net", title: "Сеть", cls: "c-net" },
      { key: "mac", title: "MAC", cls: "c-mac" },
      { key: "status", title: "Статус", cls: "c-st", sort: (r) => (r.online ? "0" : r.state === "unavailable" ? "2" : "1") + String(r.name).toLowerCase() },
    ],
    filters: [
      { key: "all", title: "Все", fn: () => true },
      { key: "unknown", title: "Неизвестные", fn: (r) => !r.known },
      { key: "offline", title: "Не в сети", fn: (r) => !r.online },
      { key: "wifi", title: "Wi-Fi", fn: (r) => !r.wired },
      { key: "lan", title: "Провод", fn: (r) => r.wired },
    ],
    defaultSort: "ip",
  },
  availability: {
    columns: [
      { key: "name", title: "Устройство", cls: "c-name" },
      { key: "kind", title: "Тип", cls: "c-net" },
      { key: "status", title: "Статус", cls: "c-st", all: true,
        sort: (r) => (r.state === "offline" ? "0" : r.state === "online" ? "1" : "2") + String(r.name).toLowerCase() },
      { key: "since", title: "Не в сети с", cls: "c-ip", sort: (r) => String(r.since).padStart(16, "0") },
      { key: "dur", title: "Длительность", cls: "c-st", sort: (r) => String(r.since).padStart(16, "0") },
    ],
    filters: [{ key: "all", title: "Все", fn: () => true }],
    defaultSort: "since",
  },
};

class DevicesTableCard extends HTMLElement {
  static getStubConfig() {
    return { mode: "network", title: "Сетевые устройства", platforms: ["openwrt_ubus"], include: ["device_tracker.lan_*"] };
  }

  setConfig(config) {
    if (!config) throw new Error("No configuration.");
    const mode = config.mode || "network";
    if (!MODES[mode]) throw new Error(`Unknown mode "${mode}" (network | availability)`);
    if (mode === "availability" && !config.entity) throw new Error("availability: укажите entity (сенсор со списком в атрибуте)");
    this._config = {
      known_label: "izvestnoe_ustroistvo",
      ignore_label: "ne_otslezhivat_dostupnost",
      attribute: "devices",
      platforms: mode === "network" ? ["openwrt_ubus"] : [],
      include: mode === "network" ? ["device_tracker.lan_*"] : [],
      exclude: [],
      actions: true,
      csv: true,
      search: true,
      ...config,
      mode,
    };
    this._mode = MODES[mode];
    this._incRe = (this._config.include || []).map(globRe);
    this._excRe = (this._config.exclude || []).map(globRe);
    this._filter = this._config.default_filter || "all";
    this._sortKey = this._config.sort || (mode === "availability" && this._config.show_all ? "status" : this._mode.defaultSort);
    this._sortDir = this._config.sort_desc ? -1 : 1;
    this._query = "";
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._renderShell();
  }

  set hass(hass) {
    this._hass = hass;
    let rows = this._collect();
    const stats = this._sources(rows);
    if (this._config.mode === "availability" && this._config.show_all && this._members) rows = this._mergeAll(rows);
    const sig = JSON.stringify([!!this._unavailable, hass?.user?.is_admin, stats, rows.map((r) => [r.id, r.state, r.since, r.ip, r.known, r.name, r.net, r.kind])]);
    if (sig === this._sig) return;
    this._sig = sig;
    this._rows = rows;
    this._stats = stats;
    this._renderBody();
  }

  // Плитки «источник: в сети / всего» (режим availability, параметр sources)
  _sources(rows) {
    const list = this._config.sources;
    if (!Array.isArray(list) || !list.length) return null;
    const h = this._hass;
    const ents = h.entities || {};
    const members = new Map();
    this._members = members;
    return list.map((s) => {
      const ids = new Set();
      const kinds0 = s.kinds || [s.name];
      const add = (id) => {
        const reg = ents[id];
        const byEntity = s.count === "entities" || !reg?.device_id;
        const key = byEntity ? id : reg.device_id;
        ids.add(key);
        if (members.has(key)) return;
        let kind = kinds0[0];
        if (kinds0.length > 1 && id.startsWith("device_tracker.")) {
          const a = h.states[id]?.attributes || {};
          const wired = a.connection_type === "wired" || /^device_tracker\.lan_/.test(id);
          kind = kinds0.find((k) => (wired ? /lan|провод/i : /wi-?fi/i).test(k)) || kind;
        }
        const dev = byEntity ? null : h.devices?.[key];
        const name = s.names?.[id] || s.names?.[key]
          || (byEntity ? (h.states[id]?.attributes?.friendly_name || id) : (dev?.name_by_user || dev?.name || key));
        const labels = byEntity ? (reg?.labels || []) : (dev?.labels || []);
        members.set(key, { key, name, kind, noAct: s.actions === false, ignored: labels.includes(this._config.ignore_label) });
      };
      if (s.platform) for (const id of Object.keys(ents)) if (ents[id].platform === s.platform && !ents[id].hidden) add(id);
      if (s.include) {
        const res = [].concat(s.include).map(globRe);
        for (const id of Object.keys(h.states)) if (res.some((re) => re.test(id))) add(id);
      }
      if (s.label) {
        const dom = s.domain ? `${s.domain}.` : "";
        for (const id of Object.keys(ents)) if ((ents[id].labels || []).includes(s.label) && id.startsWith(dom)) add(id);
      }
      const kinds = s.kinds || [s.name];
      const off = rows.filter((r) => kinds.includes(r.kind)).length;
      return { name: s.name, total: ids.size, off };
    });
  }

  // Все устройства из sources: офлайн берём из сенсора, остальные — «в сети» или «не отслеживается»
  _mergeAll(offline) {
    const byKey = new Set(offline.flatMap((r) => [r.id, r.entity]).filter(Boolean));
    const out = [...offline];
    for (const m of this._members.values()) {
      if (byKey.has(m.key)) continue;
      out.push({
        id: m.key,
        name: m.name,
        kind: m.kind,
        state: m.ignored ? "ignored" : "online",
        online: !m.ignored,
        ignored: m.ignored,
        since: 0,
        isHub: false,
        noAct: m.noAct,
        isEntity: m.key.includes("."),
        isDevice: /^[0-9a-f]{32}$/i.test(m.key),
      });
    }
    return out;
  }

  _columns() {
    const all = this._config.mode === "availability" && this._config.show_all;
    return this._mode.columns.filter((c) => !c.all || all);
  }

  _renderStats() {
    const el = this.shadowRoot.getElementById("stats");
    if (!el) return;
    el.innerHTML = (this._stats || []).map((s) =>
      `<div class="stat${s.off ? " bad" : ""}"><div class="k">${esc(s.name)}</div><div class="v">${s.off ? `${s.off} не в сети` : `${s.total - s.off}`}<span class="of">${s.off ? ` из ${s.total}` : " в сети"}</span></div></div>`).join("");
  }

  connectedCallback() {
    // Относительное время («5 мин назад») обновляем раз в минуту, даже если состояния не менялись
    if (!this._timer) this._timer = setInterval(() => this._rows && this._renderBody(), 60000);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 2 + Math.min(this._rows ? this._rows.length : 8, 20);
  }
  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  get _tz() {
    return this._config.time_zone || this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  _fmtDate(ms) {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("ru-RU", { timeZone: this._tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        .format(new Date(ms)).replace(",", "");
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }

  // ---------- данные ----------

  _collect() {
    return this._config.mode === "availability" ? this._collectAvailability() : this._collectNetwork();
  }

  _matches(id) {
    if (this._excRe.some((re) => re.test(id))) return false;
    if (this._incRe.some((re) => re.test(id))) return true;
    const plat = this._hass.entities?.[id]?.platform;
    return !!plat && (this._config.platforms || []).includes(plat);
  }

  _collectNetwork() {
    const h = this._hass;
    const c = this._config;
    const hosts = (c.reservations_entity && h.states[c.reservations_entity]?.attributes?.hosts) || {};
    const out = [];
    for (const id of Object.keys(h.states)) {
      if (!id.startsWith("device_tracker.") || !this._matches(id)) continue;
      const st = h.states[id];
      const a = st.attributes || {};
      const reg = h.entities?.[id] || {};
      const mac = String(a.mac || "").toUpperCase();
      let ip = a.ip && a.ip !== "Unknown IP" ? String(a.ip) : "";
      let reserved = false;
      if (!ip && mac && hosts[mac]?.ip) {
        ip = hosts[mac].ip;
        reserved = true;
      }
      const wired = a.connection_type === "wired" || /^device_tracker\.lan_/.test(id);
      let net = "";
      if (wired) net = a.port || "LAN";
      else if (a.ssid) net = /5([.,]\d)?\s*(G|ГГц|GHz)?$/i.test(String(a.ssid).trim()) ? "5 ГГц" : "2.4 ГГц";
      out.push({
        id,
        name: a.friendly_name || id,
        state: st.state,
        online: st.state === "home",
        since: Date.parse(st.last_changed) || 0,
        ip,
        reserved,
        mac,
        random: isRandomMac(mac),
        wired,
        net,
        known: (reg.labels || []).includes(c.known_label),
        deviceId: reg.device_id || null,
      });
    }
    return out;
  }

  _collectAvailability() {
    const st = this._hass.states[this._config.entity];
    const list = st?.attributes?.[this._config.attribute];
    this._unavailable = !st || st.state === "unavailable" || st.state === "unknown";
    if (!Array.isArray(list)) return [];
    return list.map((d) => {
      const key = String(d.key ?? "");
      return {
        id: key,
        name: d.name || key,
        kind: d.kind || "",
        state: "offline",
        online: false,
        since: Date.parse(d.since) || 0,
        isHub: key.startsWith("hub:"),
        entity: d.entity || "",
        isEntity: key.includes("."),
        isDevice: /^[0-9a-f]{32}$/i.test(key),
      };
    });
  }

  _cell(r, key) {
    switch (key) {
      case "since": return r.since;
      case "dur": return r.since;
      case "status": return r.ignored ? DTC_STRINGS.ignored : r.online ? DTC_STRINGS.online : r.state === "unavailable" ? DTC_STRINGS.nodata : DTC_STRINGS.offline;
      default: return r[key] ?? "";
    }
  }

  _filters() {
    if (this._config.mode !== "availability") return this._mode.filters;
    const kinds = [...new Set(this._rows.map((r) => r.kind).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const extra = this._config.show_all
      ? [{ key: "offline", title: "Не в сети", fn: (r) => r.state === "offline" },
         ...(this._rows.some((r) => r.ignored) ? [{ key: "ignored", title: "Не отслеживаются", fn: (r) => r.ignored }] : [])]
      : [];
    return [this._mode.filters[0], ...extra, ...kinds.map((k) => ({ key: `k:${k}`, title: k, fn: (r) => r.kind === k }))];
  }

  _visible() {
    const fl = this._filters();
    const f = fl.find((x) => x.key === this._filter) || fl[0];
    const q = this._query.trim().toLowerCase();
    let rows = this._rows.filter(f.fn);
    if (q) rows = rows.filter((r) => [r.name, r.ip, r.mac, r.net, r.kind, r.id].some((v) => String(v || "").toLowerCase().includes(q)));
    const cols = this._columns();
    const col = cols.find((x) => x.key === this._sortKey) || cols[0];
    const key = col.sort || ((r) => String(this._cell(r, col.key)).toLowerCase());
    const dir = this._sortDir;
    return rows.slice().sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -dir;
      if (ka > kb) return dir;
      return String(a.name).localeCompare(String(b.name), "ru");
    });
  }

  // ---------- действия ----------

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  _navigate(path) {
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _openRow(r) {
    if (this._config.mode === "availability") {
      if (r.isDevice) this._navigate(`/config/devices/device/${r.id}`);
      else if (r.isEntity) this._moreInfo(r.id);
      return;
    }
    this._moreInfo(r.id);
  }

  async _toggleLabel(r) {
    const h = this._hass;
    const c = this._config;
    try {
      if (c.mode === "network") {
        const label = c.known_label;
        const add = !r.known;
        if (!confirm(add ? `Добавить «${r.name}» в известные?` : `Убрать «${r.name}» из известных?`)) return;
        const reg = await h.callWS({ type: "config/entity_registry/get", entity_id: r.id });
        const labels = add ? [...new Set([...(reg.labels || []), label])] : (reg.labels || []).filter((l) => l !== label);
        await h.callWS({ type: "config/entity_registry/update", entity_id: r.id, labels });
      } else {
        const label = c.ignore_label;
        const add = !r.ignored;
        if (!confirm(add ? `Не отслеживать доступность «${r.name}»?\nБудет поставлена метка, её можно снять той же кнопкой (в режиме show_all) или в настройках.`
          : `Снова отслеживать доступность «${r.name}»?`)) return;
        const apply = (cur) => (add ? [...new Set([...(cur || []), label])] : (cur || []).filter((l) => l !== label));
        if (r.isDevice) {
          await h.callWS({ type: "config/device_registry/update", device_id: r.id, labels: apply(h.devices?.[r.id]?.labels) });
        } else if (r.isEntity) {
          const reg = await h.callWS({ type: "config/entity_registry/get", entity_id: r.id });
          await h.callWS({ type: "config/entity_registry/update", entity_id: r.id, labels: apply(reg.labels) });
        }
      }
      this._toast("Сохранено. Список обновится в течение минуты.");
    } catch (e) {
      this._toast(`Не получилось: ${e.message || e}`);
    }
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  _csv() {
    const cols = this._columns();
    const rows = this._visible();
    const val = (r, k) => {
      if (k === "since") return r.since ? this._fmtDate(r.since) : "";
      if (k === "dur") return r.since ? relTime(r.since) : "";
      if (k === "status") return r.ignored ? DTC_STRINGS.ignored : r.online ? DTC_STRINGS.online : `${DTC_STRINGS.offline} ${this._fmtDate(r.since)}`;
      if (k === "name" && this._config.mode === "network") return r.name;
      return this._cell(r, k);
    };
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    let out = cols.map((c) => q(c.title)).join(";");
    if (this._config.mode === "network") out += ";" + q("Известное");
    out += "\r\n";
    for (const r of rows) {
      out += cols.map((c) => q(val(r, c.key))).join(";");
      if (this._config.mode === "network") out += ";" + q(r.known ? "да" : "нет");
      out += "\r\n";
    }
    const blob = new Blob([String.fromCharCode(0xfeff) + out], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(this._config.title || "devices").replace(/[^\wа-яё -]+/gi, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- отрисовка ----------

  _renderShell() {
    const c = this._config;
    const fs = c.font_size || ".9em";
    this.shadowRoot.innerHTML = `
      <style>
        :host { --dtc-line: rgba(127,127,127,.35); --dtc-row-line: rgba(127,127,127,.15); --dtc-hover: rgba(127,127,127,.08);
          --dtc-ok: var(--success-color, #4caf50); --dtc-bad: var(--error-color, #f44336); --dtc-warn: var(--warning-color, #ff9800);
          --dtc-chip-on: rgba(3,169,244,.18); }
        @supports (color: color-mix(in srgb, red, blue)) {
          :host {
            --dtc-line: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 25%, transparent);
            --dtc-row-line: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 10%, transparent);
            --dtc-hover: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 6%, transparent);
            --dtc-chip-on: color-mix(in srgb, var(--primary-color, #03a9f4) 20%, transparent);
          }
        }
        ha-card { display: block; padding: 16px; container-type: inline-size; }
        .top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .title { flex: 1; font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; min-width: 0; }
        .title ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
        .tbtn { background: none; border: 1px solid var(--divider-color); color: var(--primary-text-color); border-radius: 8px;
          padding: 4px 10px; font: inherit; font-size: .8em; cursor: pointer; }
        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; }
        .chip { font: inherit; font-size: .82em; cursor: pointer; color: var(--primary-text-color); background: none;
          border: 1px solid var(--divider-color); border-radius: 16px; padding: 4px 12px; display: inline-flex; gap: 6px; align-items: center; }
        .chip .n { color: var(--secondary-text-color); }
        .chip.on { background: var(--dtc-chip-on); border-color: var(--primary-color); }
        .chip.on .n { color: var(--primary-text-color); }
        .chip.warn .n { color: var(--dtc-warn); } .chip.bad .n { color: var(--dtc-bad); }
        .search { flex: 0 1 220px; min-width: 120px; font: inherit; font-size: .85em; padding: 5px 10px; border-radius: 8px;
          color: var(--primary-text-color); background: var(--secondary-background-color, transparent); border: 1px solid var(--divider-color); }
        table { width: 100%; border-collapse: collapse; font-size: ${fs}; table-layout: auto; }
        th { text-align: left; font-weight: 500; font-size: .85em; color: var(--secondary-text-color); padding: 6px 8px;
          border-bottom: 1px solid var(--dtc-line); cursor: pointer; user-select: none; white-space: nowrap; }
        th.on { color: var(--primary-text-color); }
        th .ar { font-size: .85em; margin-left: 2px; }
        td { padding: 7px 8px; border-bottom: 1px solid var(--dtc-row-line); vertical-align: middle; }
        tbody tr { cursor: pointer; }
        tbody tr:hover { background: var(--dtc-hover); }
        .c-name { width: 100%; }
        .c-ip, .c-mac, .c-st, .c-net { white-space: nowrap; }
        .c-mac { font-family: var(--code-font-family, monospace); font-size: .88em; color: var(--secondary-text-color); }
        .c-ip .r { color: var(--secondary-text-color); font-size: .8em; margin-left: 4px; }
        .nm { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .nm ha-icon { --mdc-icon-size: 20px; flex: none; }
        .nm .tx { min-width: 0; }
        .nm .t1 { overflow-wrap: break-word; }
        .nm .sub { display: none; font-size: .8em; color: var(--secondary-text-color); white-space: nowrap; }
        .badge { font-size: .7em; padding: 0 5px; border-radius: 5px; margin-left: 6px; white-space: nowrap; vertical-align: 1px;
          border: 1px solid var(--divider-color); color: var(--secondary-text-color); }
        .legend { display: inline-flex; gap: 12px; align-items: center; }
        .legend span { display: inline-flex; gap: 4px; align-items: center; }
        .i-ok { color: var(--dtc-ok); } .i-bad { color: var(--dtc-bad); } .i-unk { color: var(--dtc-warn); } .i-na { color: var(--disabled-text-color, #888); }
        .st { display: inline-flex; align-items: center; gap: 6px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
        .dot.ok { background: var(--dtc-ok); } .dot.bad { background: var(--dtc-bad); } .dot.na { background: var(--disabled-text-color, #888); }
        .st .ago { color: var(--secondary-text-color); font-size: .88em; }
        .c-act { width: 1%; text-align: right; padding-right: 0; }
        .act { background: none; border: none; cursor: pointer; color: var(--secondary-text-color); padding: 4px; border-radius: 6px; line-height: 0; opacity: .45; }
        tr:hover .act { opacity: 1; }
        .act:hover { color: var(--primary-color); background: var(--dtc-hover); }
        @media (hover: none) { .act { opacity: .8; } }
        .act ha-icon { --mdc-icon-size: 20px; }
        .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .stats:empty { display: none; }
        .stat { flex: 1 1 110px; padding: 8px 12px; border-radius: 10px; background: var(--dtc-hover); min-width: 0; }
        .stat .k { font-size: .78em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stat .v { font-size: 1.25em; font-weight: 500; }
        .stat .v .of { font-size: .65em; color: var(--secondary-text-color); font-weight: 400; margin-left: 2px; }
        .stat.bad .v { color: var(--dtc-bad); }
        .msg { padding: 18px 8px; text-align: center; color: var(--secondary-text-color); }
        .msg.ok { color: var(--dtc-ok); }
        .foot { margin-top: 8px; font-size: .75em; color: var(--secondary-text-color); display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        @container (max-width: 560px) { .c-mac, .c-dur { display: none; } }
        @container (max-width: 430px) {
          .c-net, .c-ip { display: none; }
          .nm .sub { display: block; }
          .c-st .lbl { display: none; }
          td.c-st, th.c-st { padding-left: 2px; padding-right: 2px; }
          .search { flex-basis: 100%; }
        }
      </style>
      <ha-card>
        <div class="top">
          <div class="title">${c.icon ? `<ha-icon icon="${esc(c.icon)}"></ha-icon>` : ""}<span>${esc(c.title || "")}</span></div>
          ${c.csv ? `<button class="tbtn" id="csv" title="Скачать CSV">CSV</button>` : ""}
        </div>
        <div class="stats" id="stats"></div>
        <div class="bar">
          <div class="chips" id="chips"></div>
          ${c.search ? `<input class="search" id="q" type="search" placeholder="${c.mode === "network" ? "Поиск: имя, IP, MAC" : "Поиск"}">` : ""}
        </div>
        <div id="body"></div>
        <div class="foot"><span id="cnt"></span>${c.mode === "network" ? `<span class="legend">
          <span><ha-icon class="i-ok" icon="mdi:circle" style="--mdc-icon-size:10px"></ha-icon>известное</span>
          <span><ha-icon class="i-unk" icon="mdi:circle" style="--mdc-icon-size:10px"></ha-icon>неизвестное</span>
          <span><ha-icon class="i-bad" icon="mdi:circle" style="--mdc-icon-size:10px"></ha-icon>не в сети</span></span>` : ""}<span id="hint"></span></div>
      </ha-card>`;
    const root = this.shadowRoot;
    root.getElementById("csv")?.addEventListener("click", () => this._csv());
    const q = root.getElementById("q");
    if (q) q.addEventListener("input", () => { this._query = q.value; this._renderBody(); });
    root.getElementById("chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      this._filter = b.dataset.f;
      this._renderBody();
    });
    root.getElementById("body").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]");
      if (th) {
        const k = th.dataset.k;
        if (this._sortKey === k) this._sortDir = -this._sortDir;
        else { this._sortKey = k; this._sortDir = 1; }
        this._renderBody();
        return;
      }
      const act = e.target.closest(".act");
      const tr = e.target.closest("tr[data-i]");
      if (!tr) return;
      const r = this._shown?.[+tr.dataset.i];
      if (!r) return;
      if (act) {
        e.stopPropagation();
        this._toggleLabel(r);
        return;
      }
      this._openRow(r);
    });
  }

  _renderChips() {
    const fl = this._filters();
    const counts = {};
    for (const f of fl) counts[f.key] = this._rows.filter(f.fn).length;
    const html = fl.map((f) => {
      const n = counts[f.key];
      if (f.key !== "all" && f.key !== this._filter && n === 0 && f.key !== "unknown") return "";
      const cls = ["chip", f.key === this._filter ? "on" : "", f.key === "unknown" && n ? "warn" : "", f.key === "offline" && n ? "bad" : ""].join(" ");
      return `<button class="${cls}" data-f="${f.key}">${esc(f.title)} <span class="n">${n}</span></button>`;
    }).join("");
    this.shadowRoot.getElementById("chips").innerHTML = fl.length > 2 || (fl.length > 1 && this._config.mode === "network") ? html : "";
  }

  _nameCell(r) {
    const c = this._config;
    if (c.mode === "availability") {
      const icon = r.isHub ? "mdi:router-network" : r.kind === "Zigbee" ? "mdi:zigbee" : r.kind === "ESPHome" ? "mdi:chip"
        : r.kind === "Wi-Fi" ? (r.online ? "mdi:wifi" : "mdi:wifi-off") : r.kind === "LAN" ? (r.online ? "mdi:ethernet" : "mdi:ethernet-off")
        : r.online ? "mdi:lan-connect" : "mdi:lan-disconnect";
      const sub = [r.kind, r.since ? this._fmtDate(r.since) : r.ignored ? DTC_STRINGS.ignored : ""].filter(Boolean).join(" · ");
      const icls = r.ignored ? "i-na" : r.online ? "i-ok" : "i-bad";
      return `<div class="nm"><ha-icon class="${icls}" icon="${icon}"></ha-icon><div class="tx"><div class="t1">${esc(r.name)}</div><div class="sub">${esc(sub)}</div></div></div>`;
    }
    const icon = r.wired ? (r.online ? "mdi:ethernet" : "mdi:ethernet-off") : (r.online ? "mdi:wifi" : "mdi:wifi-off");
    const cls = r.state === "unavailable" ? "i-na" : !r.online ? "i-bad" : r.known ? "i-ok" : "i-unk";
    const badges = r.random && !r.known
      ? `<span class="badge" title="Локально администрируемый MAC — обычно телефон или ноутбук с приватным адресом">случайный MAC</span>` : "";
    const sub = [r.ip, r.net, !r.online && r.since ? `${DTC_STRINGS.offline} ${relTime(r.since)}` : ""].filter(Boolean).join(" · ");
    return `<div class="nm"><ha-icon class="${cls}" icon="${icon}"></ha-icon><div class="tx"><div class="t1">${esc(r.name)}${badges}</div><div class="sub">${esc(sub)}</div></div></div>`;
  }

  _statusCell(r) {
    if (r.ignored) return `<span class="st" title="${DTC_STRINGS.ignored}"><span class="dot na"></span><span class="lbl">${DTC_STRINGS.ignored}</span></span>`;
    if (r.online) return `<span class="st" title="${DTC_STRINGS.online}"><span class="dot ok"></span><span class="lbl">${DTC_STRINGS.online}</span></span>`;
    if (r.state === "unavailable") return `<span class="st" title="${DTC_STRINGS.nodata}"><span class="dot na"></span><span class="lbl">${DTC_STRINGS.nodata}</span></span>`;
    return `<span class="st" title="${DTC_STRINGS.offline}"><span class="dot bad"></span><span class="lbl">${DTC_STRINGS.offline}${r.since ? ` <span class="ago">${relTime(r.since)}</span>` : ""}</span></span>`;
  }

  _actCell(r) {
    const c = this._config;
    if (!c.actions || !this._hass?.user?.is_admin) return "";
    if (c.mode === "network") {
      const icon = r.known ? "mdi:close-network-outline" : "mdi:check-network-outline";
      const title = r.known ? "Убрать из известных" : "Добавить в известные";
      return `<td class="c-act"><button class="act" title="${title}" aria-label="${title}"><ha-icon icon="${icon}"></ha-icon></button></td>`;
    }
    if (r.isHub || r.noAct || (!r.isDevice && !r.isEntity)) return `<td class="c-act"></td>`;
    const t = r.ignored ? "Снова отслеживать доступность" : "Не отслеживать доступность";
    return `<td class="c-act"><button class="act" title="${t}" aria-label="${t}"><ha-icon icon="${r.ignored ? "mdi:bell-outline" : "mdi:bell-off-outline"}"></ha-icon></button></td>`;
  }

  _renderBody() {
    if (!this._rows || !this.shadowRoot) return;
    const c = this._config;
    const body = this.shadowRoot.getElementById("body");
    this._renderStats();
    this._renderChips();
    const rows = this._visible();
    this._shown = rows;
    const cntEl = this.shadowRoot.getElementById("cnt");
    const hintEl = this.shadowRoot.getElementById("hint");

    if (c.mode === "availability" && this._unavailable) {
      body.innerHTML = `<div class="msg">Сенсор ${esc(c.entity)} недоступен</div>`;
      cntEl.textContent = "";
      hintEl.textContent = "";
      return;
    }
    if (!this._rows.length) {
      body.innerHTML = c.mode === "availability"
        ? `<div class="msg ok">${esc(c.empty_text || "Все устройства в сети")}</div>`
        : `<div class="msg">${esc(c.empty_text || "Устройства не найдены — проверьте platforms / include")}</div>`;
      cntEl.textContent = "";
      hintEl.textContent = "";
      return;
    }

    const cols = this._columns();
    const hasAct = c.actions && this._hass?.user?.is_admin;
    const head = cols.map((col) => {
      const on = col.key === this._sortKey;
      return `<th class="${col.cls}${on ? " on" : ""}" data-k="${col.key}">${esc(col.title)}${on ? `<span class="ar">${this._sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
    }).join("") + (hasAct ? `<th class="c-act"></th>` : "");

    const tr = rows.map((r, i) => {
      const tds = cols.map((col) => {
        switch (col.key) {
          case "name": return `<td class="c-name">${this._nameCell(r)}</td>`;
          case "ip": return `<td class="c-ip">${esc(r.ip || "—")}${r.reserved ? `<span class="r" title="IP из статической DHCP-резервации роутера, аренды нет">резерв</span>` : ""}</td>`;
          case "status": return `<td class="c-st">${this._statusCell(r)}</td>`;
          case "since": return `<td class="c-ip">${r.since ? esc(this._fmtDate(r.since)) : "—"}</td>`;
          case "dur": return `<td class="c-st c-dur">${r.since ? esc(relTime(r.since)) : "—"}</td>`;
          default: return `<td class="${col.cls}">${esc(r[col.key] || "—")}</td>`;
        }
      }).join("");
      return `<tr data-i="${i}">${tds}${this._actCell(r)}</tr>`;
    }).join("");

    body.innerHTML = rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${tr}</tbody></table>`
      : `<div class="msg">Ничего не найдено</div>`;

    cntEl.textContent = rows.length === this._rows.length ? `Всего: ${rows.length}` : `Показано ${rows.length} из ${this._rows.length}`;
    hintEl.textContent = c.mode === "network"
      ? (hasAct ? "Строка — карточка, кнопка справа — в известные" : "")
      : (hasAct ? `Строка — страница устройства, кнопка справа — ${c.show_all ? "отслеживать / не отслеживать" : "не отслеживать"}` : "");
  }
}

if (!customElements.get("devices-table-card")) {
  customElements.define("devices-table-card", DevicesTableCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "devices-table-card",
    name: "Devices Table Card",
    description: "Таблица сетевых устройств и устройств не в сети: сортировка, фильтры, поиск, метки",
    preview: false,
    documentationURL: "https://github.com/Lordhmen/devices-table-card",
  });
  console.info(`%c DEVICES-TABLE-CARD %c v${DTC_VERSION} `, "background:#009688;color:#fff", "");
}
