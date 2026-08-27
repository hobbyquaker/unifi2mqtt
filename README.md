# unifi2mqtt

[![npm](https://img.shields.io/npm/v/unifi2mqtt.svg)](https://www.npmjs.com/package/unifi2mqtt)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Ubiquiti UniFi network controller to MQTT: client presence, devices, WLANs

Connects to a UniFi Network controller — a UniFi OS console (Dream Machine, Dream Router,
Cloud Key Gen2, Cloud Gateway) or a self-hosted legacy controller — and bridges it to an MQTT
broker, following the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome)
architecture. Every wireless and wired client gets a retained presence topic, connect/disconnect
events arrive instantly over the controller's event websocket, WLANs and device LEDs can be
switched, and everything is announced to Home Assistant via MQTT discovery (one `device_tracker`
per client).

**Status: 2.0.0 is a complete rewrite that has not yet been verified against a real controller.**
It follows the documented UniFi OS and legacy APIs and is tested against fixture responses; see
[Controller compatibility](#controller-compatibility) and please report what works and what does
not. 1.x users: see [Upgrading from 1.x](#upgrading-from-1x).

## Install

```
npm install -g unifi2mqtt
```

Requires Node.js ^20.19, ^22.12 or >= 24. unifi2mqtt 2 is built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (mqtt-smarthome spec
2.x) like the author's other adapters.

Create a **local** user on the controller for unifi2mqtt (UniFi OS: Settings → Admins & Users →
Admin, "Restrict to local access only"; a read-only role is enough for status, the `set` topics
need an admin). Cloud/SSO accounts and MFA do not work with the API.

## Usage

```
unifi2mqtt --controller https://192.168.1.1 --username unifi2mqtt --password s3cret -k --mqtt-url mqtt://broker
```

| option                               | default            | description                                                                                                    |
| ------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `-c, --controller`                   |                    | controller url, required: `https://<console>` (UniFi OS) or `https://<host>:8443` (legacy controller)          |
| `--username`, `--password`           |                    | controller credentials, required: a local account without 2fa (not a Ubiquiti sso login)                       |
| `--site`                             | `default`          | site id (the part after `/site/` in the controller url; not the display name)                                  |
| `--mode`                             | `auto`             | api flavour: `unifi-os` (UDM, UDR, UCK G2, Cloud Gateway) or `legacy` (self-hosted controller); `auto` detects |
| `-k, --insecure`                     | off                | accept the controller's tls certificate without validation (consoles ship self-signed certificates)            |
| `--events`                           | on                 | subscribe to the controller's event websocket for instant client events; `--no-events` for polling only        |
| `--poll-interval`                    | `60`               | seconds between polls of clients, devices and wlans (min 5)                                                    |
| `--presence-timeout`                 | `0`                | seconds a client may be gone before it is reported absent (`0` = immediately)                                  |
| `--clients`                          | all                | only publish these clients: mac addresses, names or hostnames, comma separated                                 |
| `--client-key`                       | `name`             | how clients are named in topics: `name` (alias, else hostname, else mac), `hostname` or `mac`                  |
| `--ha-clients`                       | on                 | announce a `device_tracker` per client to Home Assistant; `--no-ha-clients` for controller and devices only    |
| `--publish-raw`                      | off                | additionally publish every websocket frame of the controller as `<name>/raw`                                   |
| `-u, --mqtt-url`                     | `mqtt://localhost` | broker URL, see [MQTT.js](https://github.com/mqttjs/MQTT.js#connect-using-a-url)                               |
| `--mqtt-username`, `--mqtt-password` |                    | broker credentials                                                                                             |
| `--mqtt-tls-ca`                      |                    | CA certificate file for `mqtts://`                                                                             |
| `-n, --name`                         | `unifi`            | instance name, used as topic prefix                                                                            |
| `--json-payloads`                    | on                 | status as `{"val", "ts", "lc"}` JSON; `--no-json-payloads` for plain values                                    |
| `--ha-discovery`                     | on                 | Home Assistant MQTT discovery (`--no-ha-discovery` disables and clears it)                                     |
| `--ha-prefix`                        | `homeassistant`    | discovery prefix                                                                                               |
| `--maintenance`                      | on                 | accept `<name>/maintenance/set/{loglevel,restart}`; `--no-maintenance` disables                                |
| `-v, --verbosity`                    | `info`             | `error`, `warn`, `info`, `debug`                                                                               |
| `--install` / `--uninstall`          |                    | install/remove the systemd service `unifi2mqtt@<name>`                                                         |
| `--config-schema`                    |                    | print the JSON Schema of all options and exit                                                                  |

Every option can also be set via environment variable with the prefix `UNIFI2MQTT_`, e.g.
`UNIFI2MQTT_CONTROLLER=https://192.168.1.1 UNIFI2MQTT_PASSWORD=… unifi2mqtt`; the broker settings
fall back to the unprefixed `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`.

### Run as a systemd service

```
sudo unifi2mqtt --install --name unifi -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k -u mqtt://192.168.1.2
```

`--install` creates a system user `unifi2mqtt`, writes the given options to
`/etc/unifi2mqtt/<name>.env` (`UNIFI2MQTT_*` variables, `0640 root:unifi2mqtt` — edit and
`systemctl restart unifi2mqtt@<name>` to change), installs the template unit
`/etc/systemd/system/unifi2mqtt@.service` and enables + starts `unifi2mqtt@<name>`. The instance
name is the `--name` option, i.e. the MQTT topic prefix. Broker settings shared by all
mqtt-interfaces adapters on the host can go to `/etc/mqtt-interfaces/broker.env` (`MQTT_URL`,
`MQTT_USERNAME`, `MQTT_PASSWORD`). Logs: `journalctl -u unifi2mqtt@<name> -f`.

**Several sites or controllers**: run `--install` once per site with a different `--name` —
each becomes its own instance with its own config and topic prefix, sharing one template unit and
one system user:

```
sudo unifi2mqtt --install --name unifi        -c https://192.168.1.1 --site default …
sudo unifi2mqtt --install --name unifi-office -c https://192.168.1.1 --site office …
systemctl status 'unifi2mqtt@*'
```

`sudo unifi2mqtt --uninstall --name unifi-office` removes one instance (the template unit goes
with the last one). [she](https://github.com/hobbyquaker/she) can install, configure and update
instances from its Services page (config form from `--config-schema`, the password masked).

### Docker

```
docker run -d --name unifi2mqtt --restart unless-stopped \
  -e UNIFI2MQTT_CONTROLLER=https://192.168.1.1 \
  -e UNIFI2MQTT_USERNAME=unifi2mqtt \
  -e UNIFI2MQTT_PASSWORD=s3cret \
  -e UNIFI2MQTT_INSECURE=true \
  -e UNIFI2MQTT_MQTT_URL=mqtt://broker \
  ghcr.io/hobbyquaker/unifi2mqtt
```

## Topics

`<name>` defaults to `unifi`. Names of clients, devices and WLANs are used as topic levels after
sanitising: whitespace, `/`, `+` and `#` become `_` (`Home WiFi` → `Home_WiFi`); duplicate client
names get a `_<last 4 mac digits>` suffix.

### `<name>/connected`

Retained. `0` = not connected to the broker (set via last will), `1` = connected to the broker
but not to the controller (login failed, controller unreachable, last poll failed), `2` = the
controller answers.

### `<name>/info` and `<name>/maintenance/set/…`

`<name>/info` (retained JSON) describes the running instance: package name and version,
mqtt-smarthome spec version, node version, host, pid, start time, controller url, site, detected
api flavour (`mode`), whether the event websocket is connected (`events`), poll interval.
`<name>/maintenance/set/loglevel` (`error|warn|info|debug`) changes the log level at runtime,
`<name>/maintenance/set/restart` exits cleanly so the service manager restarts the process;
`--no-maintenance` turns both off.

### `<name>/status/<item>`

Retained status reports (except events), published after every poll and instantly on websocket
events — only when the value changed. Every status is `{"val": <value>, "ts": <ms received>,
"lc": <ms last changed>}`; with `--no-json-payloads` the plain value (objects as JSON).

| item                       | type   | notes                                                                                                                                                                          |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/<key>/present`     | bool   | `true` while the controller lists the client (or a connect event arrived), `false` after a disconnect or a poll without it (see below)                                         |
| `client/<key>/details`     | object | `{mac, name, hostname, ip, wired, ssid, band, channel, ap, network}` — `band` is `2.4 GHz` / `5 GHz` / `6 GHz`, `ap` the access point / switch name, `null` fields are unknown |
| `event/client`             | object | **not retained**: `{type, client, mac, hostname, ssid, ap, wired, guest, time, msg}`; `type` is `connected`, `disconnected`, `roam`, `roam_radio`                              |
| `client_count`             | int    | clients present, all networks                                                                                                                                                  |
| `client_count/wireless`    | int    | wireless clients present                                                                                                                                                       |
| `client_count/wired`       | int    | wired clients present                                                                                                                                                          |
| `wifi/<ssid>/enabled`      | bool   | WLAN enabled — settable                                                                                                                                                        |
| `wifi/<ssid>/client_count` | int    | clients on this SSID                                                                                                                                                           |
| `device/<key>/online`      | bool   | access point / switch / gateway is connected to the controller                                                                                                                 |
| `device/<key>/led`         | string | `on`, `off` or `default` (site setting) — settable                                                                                                                             |
| `device/<key>/clients`     | int    | clients on this device                                                                                                                                                         |
| `device/<key>/details`     | object | `{mac, name, model, type, ip, version}`                                                                                                                                        |

`<key>` of a client is, with the default `--client-key name`, the alias set in the controller,
else the hostname, else the mac address (`--client-key hostname` / `mac` to choose). A client that
was seen once keeps its topics; when it is renamed the old topics are cleared and the new ones
published. With `--clients` only the listed clients get topics (counts still cover everyone).

**Presence** comes from two sources: the client list (`stat/sta`) polled every `--poll-interval`
seconds, and the controller's event websocket (connect / disconnect / roam events, instant). A
client disappears (`present: false`) when a disconnect event arrives or a poll no longer lists
it — immediately with the default `--presence-timeout 0`, or after that many seconds without a
sighting, which smooths phones that drop off the WLAN for a moment. Devices and WLANs are polled
with the clients; device events (adopted, restarted, …) trigger an extra refresh.

### `<name>/set/<item>`

Change requests. Payload is a plain value or mqtt-smarthome style JSON (`{"val": true}`).

| topic                               | payload                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `<name>/set/wifi/<ssid>/enabled`    | `true`/`false`, `1`/`0`, `on`/`off`                                                                   |
| `<name>/set/device/<key>/led`       | `on`, `off`, `default` (booleans map to on/off)                                                       |
| `<name>/set/device/<key>/provision` | any payload — force-provision the device (`cmd/devmgr`), for an AP that did not pick up a WLAN change |

```
mosquitto_pub -t unifi/set/wifi/Guests/enabled -m false
mosquitto_pub -t unifi/set/device/AP_Living_Room/led -m off
```

The status is re-read from the controller after the command; a rejected command is logged at
`warn`.

### `<name>/raw`

With `--publish-raw` every frame the controller sends on its event websocket is published as
`<name>/raw` (not retained) — useful to see what your controller version emits (`sta:sync`,
`device:sync`, `alert`, `events`, …) and to collect fixtures.

## Home Assistant

MQTT discovery is on by default (HA ≥ 2024.11, device-based discovery). The controller/site
appears as a device with client count sensors and one switch (enabled) + one sensor (clients) per
WLAN. Every access point, switch and gateway is its own device (linked via the bridge) with a
connectivity sensor, an LED select (`on`/`off`/`default`) and a client count. Every client is a
device with a `device_tracker` entity (`source_type: router`, `home`/`not_home`) whose attributes
are the client's details (mac, ip, ssid, ap, …); `--no-ha-clients` skips the clients,
`--clients` limits them. Availability follows `<name>/connected`.

Device and entity ids are based on mac addresses (`unifi2mqtt_<name>_client_<mac>`), so renaming
a client in the controller keeps its HA history. `--no-ha-discovery` disables discovery and removes
the announcements on startup; `--ha-prefix` changes the discovery prefix.

## Controller compatibility

unifi2mqtt talks to the controller directly (no `node-unifi`, no `ubnt-unifi`): `POST
/api/auth/login` + `/proxy/network/api/s/<site>/…` on UniFi OS, `POST /api/login` +
`/api/s/<site>/…` on legacy controllers, the session cookie and CSRF token as the ui uses them,
the event websocket at `…/wss/s/<site>/events`. The account must be a **local** controller user
without two-factor authentication — a Ubiquiti SSO login does not work with the local login
endpoints, and a 2FA challenge cannot be answered non-interactively; the adapter says so in the
log instead of retrying. `--mode auto` decides by `GET /`: a UniFi OS
console answers 200, a legacy controller redirects to `/manage`. `--mode unifi-os` / `legacy`
overrides.

| controller                                             | status                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| UniFi OS consoles (UDM, UDM Pro/SE, UDR, UCK G2+, UCG) | implemented after the documented api, **not yet verified**        |
| legacy self-hosted Network application (:8443)         | implemented after the 1.x adapter's api use, **not yet verified** |

Run with `--verbosity debug` to see every request and websocket frame; ROADMAP.md lists the
assumptions to check. Reports (controller model + version, what worked, debug log with
credentials removed) are very welcome as GitHub issues.

## Upgrading from 1.x

unifi2mqtt 2.0 is a rewrite on mqtt-interfaces-core; the topic layout changed:

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
| pm2                                                         | `sudo unifi2mqtt --install --name unifi …` or Docker                          |

Wired clients, UniFi OS consoles, `<name>/info`, maintenance topics, `--presence-timeout`,
`--clients`, Home Assistant discovery and the systemd installer are new. See CHANGELOG.md.

## License

MIT © Sebastian Raff
