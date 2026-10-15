# Devices Table Card

A Lovelace card for Home Assistant: a **devices table** with sorting, filters and search.

- **`network`** — network devices from `device_tracker` entities: IP, Wi-Fi 2.4/5 GHz or LAN port, MAC, status.
  Known devices are marked with a label, unknown ones are highlighted; a button in each row adds or removes the label.
- **`availability`** — "offline" devices from a list in a sensor attribute, "online / total" tiles per source,
  and a "don't monitor" button. With `show_all: true` it lists **all** devices of the sources with a status:
  offline, online, not monitored.

![Network devices](docs/screenshot-network.png)

Single JS file, no dependencies. Sister project of [stats-table-card](https://github.com/Lordhmen/stats-table-card).

## Install

HACS → ⋮ → Custom repositories → `https://github.com/Lordhmen/devices-table-card`, type **Dashboard**.
Or download `devices-table-card.js` from Releases into `/config/www/` and add it as a JavaScript module resource.

## Examples

See [`examples/network.yaml`](examples/network.yaml) and [`examples/availability.yaml`](examples/availability.yaml).
The full option reference is in the [Russian README](README.md#параметры).

## License

MIT
