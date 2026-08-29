# Changelog

## 2.0.3

- mqtt-interfaces-core 0.8: the instance publishes `<name>/maintenance/stats` (memory, CPU share, event loop lag) every 60 s — `--stats-interval`, 0 = off; she shows it on the Instances tab.

## 2.0.2

- mqtt-interfaces-core 0.8: the instance publishes `<name>/maintenance/stats` (memory, CPU share, event loop lag) every 60 s — `--stats-interval`, 0 = off; she shows it on the Instances tab.

## 2.0.1

- `client/<key>/details` carries `band` (`2.4 GHz` / `5 GHz` / `6 GHz`, from the controller's `radio`) and `channel` (#1).
- `set/device/<key>/provision` force-provisions a device — the controller sometimes leaves an AP behind after a WLAN change (#5).
- An expired session that the Network application reports as HTTP 200 with `meta.msg: api.err.LoginRequired` (not only as 401/403) is renewed transparently.
- Login rejections are classified in the error message: invalid credentials (UniFi OS `403 AUTHENTICATION_FAILED_INVALID_CREDENTIALS`, legacy `api.err.Invalid`) with a hint that a local account is needed, and accounts with two-factor authentication (HTTP 499, `MFA_AUTH_REQUIRED` / `api.err.Ubic2faTokenRequired`), which cannot be used non-interactively.
- `scripts/dump.js`: logs in, fetches the api responses unifi2mqtt relies on (plus site health, networks, event history, the v2 and Integration API endpoints for evaluation), captures the event websocket for a while and writes everything redacted to a directory — the way to get fixtures from real controllers (README "Controller compatibility").
- The CSRF token is also taken from the `csrfToken` claim of the UniFi OS `TOKEN` cookie when the console sends no `x-csrf-token` header.

## 2.0.0

Complete rewrite on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core)
(mqtt-smarthome spec 2.x), like the author's other xyz2mqtt adapters. The 2018 code base
(`ubnt-unifi`, `mqtt@2`, `yargs@12`, CommonJS) is gone; the topic layout changed — see the
migration section below. **Nothing has been verified against a real controller yet** (the
implementation follows the documented UniFi OS and legacy APIs and is tested against fixtures);
see README "Controller compatibility" and ROADMAP.md.

### Breaking

- **Topics.** Clients are no longer nested under their SSID by hostname
  (`status/wifi/<ssid>/client/<hostname>`) but live under `status/client/<key>/present` (bool)
  and `status/client/<key>/details` (object), wired clients included; `<key>` is the client's
  alias, hostname or mac (`--client-key`). Connect/disconnect events moved from
  `status/wifi/<ssid>/event/{connected,disconnected}` to one `status/event/client` topic with an
  object payload (`type`, `client`, `mac`, `ssid`, `ap`, …). `clientCount` is `client_count`
  (now all clients; `client_count/wireless` matches the old wifi-only sum) and
  `wifi/<ssid>/clientCount` is `wifi/<ssid>/client_count`. SSID and device names are sanitised
  for topics (whitespace, `/`, `+`, `#` → `_`).
- **Payloads** are `{val, ts, lc}` JSON by default (`--no-json-payloads` for plain values); the
  old `{val, mac, ts}` client payload is gone — the mac is in `details` and in the event object.
- **Options.** `--unifi-host`/`--unifi-port` are one `--controller` url (`-c`), `--unifi-user` is
  `--username`, `--unifi-password` is `--password`, `--unifi-site` is `--site`; the broker url is
  `--mqtt-url` (`-u`/`--url` still work). `--username` and `--controller` are mandatory (no
  `admin`/`127.0.0.1` defaults). Environment variables are prefixed `UNIFI2MQTT_`
  (previously unprefixed yargs `.env()`). Unknown options are rejected.
- Node ^20.19, ^22.12 or >= 24; the package is an ES module.
- `--insecure` is still off by default; UniFi consoles with their self-signed certificate need
  `-k` as before.

### Added

- UniFi OS consoles (UDM, UDR, UCK G2, Cloud Gateways) next to legacy self-hosted controllers;
  auto-detected, `--mode` overrides. Session renewal on 401, CSRF handling for both.
- Wired clients, `details` per client (mac, name, hostname, ip, wired, ssid, ap, network),
  `--presence-timeout`, `--clients` filter, `--client-key`.
- UniFi devices: `device/<key>/online`, `/clients`, `/details` next to the `led` item; device
  events (adopted, restarted, …) trigger a device refresh.
- Home Assistant MQTT discovery (device-based): a `device_tracker` per client
  (`--no-ha-clients` to skip), an HA device per access point / switch / gateway (connectivity,
  LED select, client count), client count sensors and one switch per WLAN on the bridge device.
- `<name>/info`, `<name>/maintenance/set/loglevel` and `…/restart`, `--config-schema`
  (`x-env`/`x-secret`), `--mqtt-username`/`--mqtt-password`/`--mqtt-tls-ca`, `MQTT_*` fallback
  variables, journald-aware logging, `mqttInterfaces` package field — everything
  [she](https://github.com/hobbyquaker/she)'s Services page needs.
- `--install`/`--uninstall` as systemd template service `unifi2mqtt@<name>` via the core.
- `--events`/`--no-events` (event websocket with polling fallback), `--poll-interval`,
  `--publish-raw` (`<name>/raw`: every websocket frame).
- Unit tests (`node --test`) with fixture API responses, eslint + prettier, CI and release
  workflows, Docker image on `node:22-alpine`, `deploy.sh`.

### Changed

- WLAN enable/disable uses `PUT rest/wlanconf/<id>` (was `POST upd/wlanconf/<id>`).
- The retained-client discovery at start (subscribing to the adapter's own status topics for two
  seconds to find clients that went away while it was down) is gone: presence is derived from
  the controller alone, and a client is reported absent when it disappears from the client list.

### Migration from 1.x

| 1.x                                                         | 2.0                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `status/wifi/<ssid>/client/<hostname>` `{val, mac, ts}`     | `status/client/<key>/present` `{val, ts, lc}` + `status/client/<key>/details` |
| `status/wifi/<ssid>/event/connected` `{val: hostname, …}`   | `status/event/client` `{val: {type: "connected", client, mac, ssid, ap, …}}`  |
| `status/wifi/<ssid>/event/disconnected`                     | `status/event/client` with `type: "disconnected"`                             |
| `status/wifi/<ssid>/clientCount`                            | `status/wifi/<ssid>/client_count`                                             |
| `status/wifi/<ssid>/enabled`, `set/wifi/<ssid>/enabled`     | unchanged (SSID sanitised: `Home WiFi` → `Home_WiFi`)                         |
| `status/clientCount` (wireless)                             | `status/client_count` (all), `status/client_count/wireless`, `…/wired`        |
| `status/device/<name>/led`, `set/device/<name>/led`         | unchanged (name sanitised) + `device/<name>/online`, `/clients`, `/details`   |
| `-a/--unifi-host`, `-p/--unifi-port`                        | `-c/--controller https://host[:port]`                                         |
| `-c/--unifi-user`, `-s/--unifi-password`, `-w/--unifi-site` | `--username`, `--password`, `--site`                                          |
| `-u/--url`                                                  | `-u/--mqtt-url` (`--url` alias kept)                                          |
| env `unifi-password=…`                                      | `UNIFI2MQTT_PASSWORD=…` (see `--config-schema`)                               |
| pm2                                                         | `sudo unifi2mqtt --install --name unifi …` (systemd template unit) or Docker  |

## 1.1.0

- Last release of the 1.x line (2018): `ubnt-unifi` websocket events, wifi/device topics.
