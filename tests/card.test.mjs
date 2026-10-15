// Смоук-тесты карточки в Node без браузера: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "devices-table-card.js"), "utf8");

// --- минимальные заглушки DOM ---
const mkEl = () => ({
  innerHTML: "", textContent: "", style: {}, dataset: {},
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
});
globalThis.HTMLElement = class {
  attachShadow() {
    const els = {};
    const root = { innerHTML: "", getElementById(id) { return els[id] || (els[id] = mkEl()); } };
    this.shadowRoot = root;
    return root;
  }
  dispatchEvent() {}
};
globalThis.customElements = { _m: {}, get(n) { return this._m[n]; }, define(n, c) { this._m[n] = c; } };
globalThis.window = {};
globalThis.console.info = () => {};
(0, eval)(src.replace("class DevicesTableCard", "globalThis.DTC = class DevicesTableCard").replace(
  'customElements.define("devices-table-card", DevicesTableCard)', 'customElements.define("devices-table-card", globalThis.DTC)'));
const DTC = globalThis.DTC;

const NOW = Date.parse("2026-10-15T06:00:00Z");
Date.now = () => NOW;

function hassNetwork() {
  const st = (state, attrs, lc = "2026-10-15T05:00:00Z") => ({ state, attributes: attrs, last_changed: lc });
  return {
    config: { time_zone: "Asia/Yekaterinburg" },
    user: { is_admin: true },
    states: {
      "device_tracker.wifi_a": st("home", { friendly_name: "Kettle", mac: "98:88:E0:D9:C0:1C", ip: "Unknown IP", ssid: "BridHouse 2.4", connection_type: "wireless" }),
      "device_tracker.wifi_b": st("home", { friendly_name: "Phone", mac: "7E:A3:39:D3:52:FA", ip: "192.168.10.103", ssid: "BridHouse 5.0" }),
      "device_tracker.wifi_c": st("not_home", { friendly_name: "Camera", mac: "04:7E:4A:A1:B5:F1", ssid: "BridHouse 2.4" }, "2026-10-15T04:00:00Z"),
      "device_tracker.lan_d": st("home", { friendly_name: "LAN 00:e0", mac: "00:e0:4c:73:36:d5", ip: "192.168.0.100", port: "LAN1", connection_type: "wired" }),
      "device_tracker.iphone_x": st("home", { friendly_name: "iPhone app", source_type: "gps" }),
      "sensor.res": st("30", { hosts: { "98:88:E0:D9:C0:1C": { ip: "192.168.10.211", name: "kettle" } } }),
    },
    entities: {
      "device_tracker.wifi_a": { platform: "openwrt_ubus", labels: ["izvestnoe_ustroistvo"] },
      "device_tracker.wifi_b": { platform: "openwrt_ubus", labels: [] },
      "device_tracker.wifi_c": { platform: "openwrt_ubus", labels: ["izvestnoe_ustroistvo"] },
      "device_tracker.lan_d": { platform: "mqtt", labels: ["izvestnoe_ustroistvo"] },
      "device_tracker.iphone_x": { platform: "mobile_app", labels: [] },
    },
  };
}

test("network: отбор по platforms/include, IP из резервации, сеть и метки", () => {
  const c = new DTC();
  c.setConfig({ mode: "network", reservations_entity: "sensor.res" });
  c.hass = hassNetwork();
  const by = Object.fromEntries(c._rows.map((r) => [r.id, r]));
  assert.equal(c._rows.length, 4, "мобильный трекер не попадает");
  assert.equal(by["device_tracker.wifi_a"].ip, "192.168.10.211");
  assert.equal(by["device_tracker.wifi_a"].reserved, true);
  assert.equal(by["device_tracker.wifi_a"].net, "2.4 ГГц");
  assert.equal(by["device_tracker.wifi_b"].net, "5 ГГц");
  assert.equal(by["device_tracker.wifi_b"].known, false);
  assert.equal(by["device_tracker.wifi_b"].random, true);
  assert.equal(by["device_tracker.lan_d"].net, "LAN1");
  assert.equal(by["device_tracker.lan_d"].wired, true);
  assert.equal(by["device_tracker.wifi_c"].online, false);
});

test("network: сортировка по IP числовая, пустые в конце; фильтры и поиск", () => {
  const c = new DTC();
  c.setConfig({ mode: "network", reservations_entity: "sensor.res" });
  c.hass = hassNetwork();
  assert.deepEqual(c._visible().map((r) => r.ip), ["192.168.0.100", "192.168.10.103", "192.168.10.211", ""]);
  c._filter = "unknown";
  assert.deepEqual(c._visible().map((r) => r.name), ["Phone"]);
  c._filter = "offline";
  assert.deepEqual(c._visible().map((r) => r.name), ["Camera"]);
  c._filter = "lan";
  assert.equal(c._visible().length, 1);
  c._filter = "all";
  c._query = "c0:1c";
  assert.deepEqual(c._visible().map((r) => r.name), ["Kettle"]);
});

test("network: перерисовка только при изменениях", () => {
  const c = new DTC();
  c.setConfig({ mode: "network" });
  let n = 0;
  const orig = c._renderBody.bind(c);
  c._renderBody = () => { n++; orig(); };
  const h = hassNetwork();
  c.hass = h;
  c.hass = { ...h };
  assert.equal(n, 1);
  h.states["device_tracker.wifi_b"] = { ...h.states["device_tracker.wifi_b"], state: "not_home" };
  c.hass = { ...h };
  assert.equal(n, 2);
});

test("availability: строки из атрибута, тип ключа", () => {
  const c = new DTC();
  c.setConfig({ mode: "availability", entity: "sensor.off" });
  c.hass = {
    config: { time_zone: "Asia/Yekaterinburg" }, user: { is_admin: true }, entities: {},
    states: { "sensor.off": { state: "3", attributes: { devices: [
      { key: "f159df4b138dab4309b280ad1231477f", name: "Water Heater 2", kind: "ESPHome", since: "2026-10-14T19:44:36Z" },
      { key: "hub:zigbee", name: "Zigbee2MQTT", kind: "Шлюз", since: "2026-10-15T05:00:00Z" },
      { key: "device_tracker.wifi_c", name: "Camera", kind: "Wi-Fi", since: "2026-10-15T04:00:00Z" },
    ] } } },
  };
  const rows = c._visible();
  assert.deepEqual(rows.map((r) => r.name), ["Water Heater 2", "Camera", "Zigbee2MQTT"]);
  assert.equal(rows[0].isDevice, true);
  assert.equal(rows[2].isHub, true);
  assert.equal(rows[1].isEntity, true);
});

test("availability: пустой список и недоступный сенсор", () => {
  const c = new DTC();
  c.setConfig({ mode: "availability", entity: "sensor.off" });
  c.hass = { config: {}, user: {}, entities: {}, states: { "sensor.off": { state: "0", attributes: { devices: [] } } } };
  assert.match(c.shadowRoot.getElementById("body").innerHTML, /Все устройства в сети/);
  c.hass = { config: {}, user: {}, entities: {}, states: {} };
  assert.match(c.shadowRoot.getElementById("body").innerHTML, /недоступен/);
});

test("setConfig: ошибки конфигурации", () => {
  const c = new DTC();
  assert.throws(() => c.setConfig({ mode: "xxx" }), /Unknown mode/);
  assert.throws(() => c.setConfig({ mode: "availability" }), /entity/);
});

test("availability: плитки источников и фильтры по типу", () => {
  const c = new DTC();
  c.setConfig({ mode: "availability", entity: "sensor.off", sources: [
    { name: "ESPHome", platform: "esphome" },
    { name: "Сеть", kinds: ["Wi-Fi", "LAN"], label: "izvestnoe_ustroistvo", domain: "device_tracker" },
  ] });
  c.hass = {
    config: {}, user: { is_admin: false },
    entities: {
      "sensor.a": { platform: "esphome", device_id: "d1" }, "sensor.b": { platform: "esphome", device_id: "d1" },
      "sensor.c": { platform: "esphome", device_id: "d2" },
      "device_tracker.x": { platform: "openwrt_ubus", labels: ["izvestnoe_ustroistvo"] },
      "device_tracker.y": { platform: "mqtt", labels: ["izvestnoe_ustroistvo"] },
    },
    states: { "sensor.off": { state: "1", attributes: { devices: [{ key: "d2", name: "Heater", kind: "ESPHome", since: "2026-10-14T19:44:36Z" }] } } },
  };
  assert.deepEqual(c._stats, [{ name: "ESPHome", total: 2, off: 1 }, { name: "Сеть", total: 2, off: 0 }]);
  assert.deepEqual(c._filters().map((f) => f.key), ["all", "k:ESPHome"]);
});

test("availability show_all: все устройства из sources, статусы, метка, шлюзы без дублей", () => {
  const c = new DTC();
  c.setConfig({ mode: "availability", entity: "sensor.off", show_all: true, sources: [
    { name: "ESPHome", platform: "esphome" },
    { name: "Сеть", kinds: ["Wi-Fi", "LAN"], label: "izvestnoe_ustroistvo", domain: "device_tracker", count: "entities" },
    { name: "Шлюзы", kinds: ["Шлюз"], include: "sensor.ont_hb", count: "entities", names: { "sensor.ont_hb": "ONT" } },
  ] });
  const h = {
    config: {}, user: { is_admin: true },
    devices: { d1: { name: "Boiler" }, d2: { name: "Heater", name_by_user: "Нагреватель" }, d3: { name: "Old", labels: ["ne_otslezhivat_dostupnost"] } },
    entities: {
      "sensor.a": { platform: "esphome", device_id: "d1" }, "sensor.c": { platform: "esphome", device_id: "d2" },
      "sensor.e": { platform: "esphome", device_id: "d3" },
      "device_tracker.x": { platform: "openwrt_ubus", labels: ["izvestnoe_ustroistvo"] },
      "device_tracker.lan_y": { platform: "mqtt", labels: ["izvestnoe_ustroistvo"] },
    },
    states: {
      "device_tracker.x": { state: "home", attributes: { friendly_name: "Kettle" } },
      "device_tracker.lan_y": { state: "home", attributes: { friendly_name: "NAS", connection_type: "wired" } },
      "sensor.ont_hb": { state: "unavailable", attributes: {} },
      "sensor.off": { state: "2", attributes: { devices: [
        { key: "d2", name: "Нагреватель", kind: "ESPHome", since: "2026-10-14T19:44:36Z" },
        { key: "hub:ont", entity: "sensor.ont_hb", name: "ONT", kind: "Шлюз", since: "2026-10-15T05:00:00Z" },
      ] } },
    },
  };
  c.hass = h;
  const by = Object.fromEntries(c._rows.map((r) => [r.name, r]));
  assert.equal(c._rows.length, 6, "d1, d2, d3, x, lan_y, hub — без дубля шлюза");
  assert.equal(by["Boiler"].state, "online");
  assert.equal(by["Нагреватель"].state, "offline");
  assert.equal(by["Old"].state, "ignored");
  assert.equal(by["Kettle"].kind, "Wi-Fi");
  assert.equal(by["NAS"].kind, "LAN");
  assert.deepEqual(c._stats.map((s) => [s.total, s.off]), [[3, 1], [2, 0], [1, 1]]);
  // сортировка по статусу: сначала не в сети, в конце не отслеживаемые
  const order = c._visible().map((r) => r.state);
  assert.deepEqual(order, ["offline", "offline", "online", "online", "online", "ignored"]);
  assert.deepEqual(c._filters().map((f) => f.key).slice(0, 3), ["all", "offline", "ignored"]);
  c._filter = "offline";
  assert.equal(c._visible().length, 2);
  assert.equal(c._columns().some((x) => x.key === "status"), true);
  // без show_all колонки «Статус» нет
  const c2 = new DTC();
  c2.setConfig({ mode: "availability", entity: "sensor.off" });
  assert.equal(c2._columns().some((x) => x.key === "status"), false);
});
