# Roadmap — unifi2mqtt

## Done in 2.0.0

- Rewrite on mqtt-interfaces-core 0.6: config (`--config-schema`, `UNIFI2MQTT_*`), MQTT,
  `{val, ts, lc}` payloads, `<name>/info`, maintenance topics, discovery publishing, installer,
  journald logging.
- Own UniFi client on `node:https` (`lib/unifi.js`): UniFi OS and legacy flavours, auto-detection,
  cookie + CSRF session, re-login on 401. Event websocket (`lib/events.js`, `ws`) with polling
  fallback.
- Network state model (`lib/model.js`): clients (presence with timeout and event grace, details,
  key collisions, filter), devices, WLANs, counts — all pure and fixture-tested.
- Home Assistant discovery: bridge, one device per UniFi device, one `device_tracker` per client.

## Unreleased

- `client/<key>/details` carries `band` and `channel` (#1).
- `set/device/<key>/provision` (#5).

## Open

### Verification on real controllers (nothing has been verified yet)

The implementation follows the widely documented API surface; every item below is an assumption
until someone runs it against hardware. Run with `--verbosity debug` and compare.

- **UniFi OS** (UDM / UDR / UCK G2 / Cloud Gateway / UniFi OS Server on port 11443): `GET /` → 200
  for detection, `POST /api/auth/login` with `{username, password, rememberMe}` → `TOKEN` cookie +
  `x-csrf-token` header, api under `/proxy/network/api/s/<site>/…`, websocket at
  `/proxy/network/wss/s/<site>/events` accepting the `TOKEN` cookie, `POST /api/auth/logout`.
  Whether a read-only local user is enough for `stat/sta`, `stat/device`, `rest/wlanconf`.
- **Login failure modes** worth distinguishing in the log instead of "login failed": wrong
  credentials on UniFi OS come back as **403** `AUTHENTICATION_FAILED_INVALID_CREDENTIALS`
  (legacy: 401) — that must not trigger a flavour retry; an account with 2FA answers **HTTP 499**
  / `meta.msg: api.err.Ubic2faTokenRequired` — unusable non-interactively, say so once and stop;
  Ubiquiti SSO accounts never work, only local accounts (document in README). Some versions ship
  the CSRF token only as the `TOKEN` cookie (a JWT whose payload carries `csrfToken`), not as a
  header; and a refreshed token may arrive on any response.
- **Session expiry** is not always a 401: the Network application also reports it as HTTP 200
  with `meta.rc: "error"`, `meta.msg: "api.err.LoginRequired"`. `api()` must treat that as
  "re-login once, then retry". Session lifetime of a `rememberMe: false` token and whether the
  websocket is closed when it expires (the re-login path exists, the trigger is unverified).
- **Legacy controller** (self-hosted 5.x/6.x/7.x+, port 8443): `GET /` → 302 for detection
  (older versions may answer differently — `--mode legacy` is the escape hatch),
  `POST /api/login` → `unifises` + `csrf_token` cookies, `X-Csrf-Token` header on PUT.
- **Websocket event payloads**: field names (`user`, `guest`, `hostname`, `ssid`, `ap`, `time`)
  and keys (`EVT_WU_Connected`, `EVT_WU_Disconnected`, `EVT_WU_Roam`, `EVT_LU_*`, `EVT_LG_*`) —
  from the 1.x adapter and `ubnt-unifi`; `EVT_LU_*`/`EVT_LG_*` for wired clients need confirming.
  Whether the controller also pushes `sta:sync` / `client:sync` frames that could replace polling.
- **`stat/sta` field names** on current firmware: `name` (alias), `hostname`, `essid`, `ap_mac`,
  `sw_mac`, `is_wired`, `is_guest`, `network`, `vlan`, `last_seen`, `blocked`; signal strength is
  `signal` on some versions/radios and `rssi` on others (both dBm) — read whichever is present.
  Newer UniFi OS versions also offer `/proxy/network/v2/api/site/<site>/clients/active` — evaluate
  as alternative.
- **`stat/device`**: `state === 1` for online, `led_override` values, `num_sta`, `upgradable`,
  `uplink.uplink_mac`, `port_table[]` (`port_idx`, `up`, `speed`, `poe_enable`, `poe_mode`,
  `poe_power` — a **string** like `"7.40"`, `"0.00"` or absent on idle ports), `radio_table[]`
  (`radio`, `channel`); `PUT rest/device/<id> {led_override}` still accepted (the 1.x adapter
  used it).
- **WLAN toggle**: `PUT rest/wlanconf/<id> {enabled}` (1.x used `POST upd/wlanconf/<id>`); how
  long the controller takes to reflect the change in `rest/wlanconf`.
- Multi-site legacy controllers (`--site` other than `default`) and site ids vs. display names.

### The official Integration API (Network 10.5+)

Since Network 10.5 every console serves a documented, versioned REST API next to the classic
one: `/proxy/network/integration/v1/…` on UniFi OS, `/integration/v1/…` on a standalone
controller, authenticated with a static `X-API-KEY` (Settings → Control Plane → Integrations;
the key inherits the creating admin's permissions, read-only is enough for status). No session,
no cookies, no CSRF, no 2FA problem — and it will not be reshaped with the next controller
update. The console even serves its own OpenAPI document at
`…/integration/openapi/document.json`, which is the way to verify field names without guessing.

What it covers, and what it does **not**, decides the design:

| data                                                     | Integration API                                           | classic API                |
| -------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| sites, devices, clients, networks (VLANs), WLANs (SSIDs) | yes                                                       | yes                        |
| device statistics (uptime, cpu, mem, load, uplink rates) | yes, `/devices/{id}/statistics/latest`                    | inline in `stat/device`    |
| device details (uplink, ports, radios)                   | yes, but only in `/devices/{id}`, **not** in the list     | inline in `stat/device`    |
| restart device, power-cycle PoE port, authorize guest    | yes (`…/actions`)                                         | `cmd/devmgr`, `cmd/stamgr` |
| per-client SSID, signal, hostname, blocked               | **no** (client = type, id, name, ip, mac, uplink, access) | `stat/sta`                 |
| site / WAN health                                        | **no** (`/wans` is id + name only)                        | `stat/health`              |
| PoE power draw                                           | **no**                                                    | `stat/device` `poe_power`  |
| block client, toggle WLAN, locate LED, LED override      | **no** (WLAN `PUT` wants the whole object)                | yes                        |
| event websocket                                          | **no**                                                    | yes                        |

So it cannot replace the classic client — presence via events, SSID per client and the WLAN
switch all need the session login. Plan:

- `--api-key` as an **additional** credential; `--username`/`--password` become optional when
  it is set. With only the key: devices, clients (presence by polling), networks, WLAN status,
  restart / power-cycle / authorize. With only username/password: everything as today. With
  both: the documented endpoints for what they cover, classic for the rest. Capabilities are
  detected, and items / HA entities that cannot be served are simply not announced (no
  "switch that fails on click").
- Prefix probe like the flavour detection: `GET …/v1/info` on both prefixes; a 401 means a wrong
  key and stops the probe. `applicationVersion` from `/v1/info` goes into `<name>/info`; warn
  below 10.5.
- Pagination (`offset`/`limit`/`totalCount`) on every list. The device list omits `uplink` and
  `interfaces`, the network list omits `ipv4Configuration` — those need one detail call per
  object, so they belong on a slow cadence (see "Polling cadences"). Client `type` is `WIRED` /
  `WIRELESS` / `VPN` / `TELEPORT` (the last two have no mac — key them by id or skip them),
  guests are `access.type === "GUEST"`.
- Identity stays the mac: the Integration API's UUIDs change on re-adopt / restore, the classic
  `_id` too. Both are carried in the model for actuator calls but never appear in a topic or HA
  id (already the case for HA ids).
- Fixtures: `scripts/dump.js` (below) should pull the OpenAPI document and the responses with
  the same redaction, so schema drift between Network versions shows up in the repo.

### Site health

`stat/health` (classic) is the only source for WAN state; new items on the bridge:
`health/wan/{state,ip,latency,rx_bps,tx_bps,uptime}`, `health/{lan,wlan,vpn}/state`
(`ok`/`warning`/`error`), `client_count/guest` and `client_count/iot` from `num_user` /
`num_guest` / `num_iot`, `device_count/{ap,switch,gateway}`. `rx_bytes-r`/`tx_bytes-r` are
bytes/s — publish bit/s like the device uplink rates. HA: `binary_sensor` connectivity for WAN,
`sensor` with `device_class: data_rate` / `duration` and `state_class: measurement`.

### Device statistics, ports, radios

- `device/<key>/details` grows `uptime`, `cpu`, `mem`, `load`, `uplink` (mac), `firmware_update`
  (`upgradable` / `firmwareUpdatable`) — separate items `device/<key>/{uptime,cpu,mem}` behind
  `--device-stats` because they churn on every poll; `firmware_update` is cheap and always on
  (HA `update`/`binary_sensor` with `device_class: update`).
- `device/<key>/port/<idx>/{link,speed,poe,poe_power}` from `port_table` and
  `device/<key>/radio/<band>/{channel,width,tx_retries}` from `radio_table` — `--ports` opt-in,
  a 48-port switch is 200 topics.
- Device state beyond online/offline: the Integration API knows `ONLINE OFFLINE
PENDING_ADOPTION UPDATING GETTING_READY ADOPTING DELETING CONNECTION_INTERRUPTED ISOLATED`;
  keep `online` boolean and add `state` to details, unknown values pass through.
- `--device-stats-interval` separate from `--poll-interval` for consoles under load.

### More commands

All opt-in via `--commands <list>` (default: `led,wifi,provision` — what 2.0 has today); a
command that is not enabled is neither subscribed nor announced to HA. Whoever can publish to
the broker can restart the network once these are on — say so in the README, point at broker
ACLs. Retained `set` messages replayed on subscribe must be ignored (`retain` flag on the
packet), or a stale `mosquitto_pub -r` power-cycles a port on every start — this belongs in the
core.

- `set/device/<key>/restart` (`cmd/devmgr` `restart`, HA button), `set/device/<key>/locate`
  (`set-locate` / `unset-locate`, HA switch, state from `stat/device` `locating`).
- `set/device/<key>/port/<idx>/power_cycle` (`cmd/devmgr` `power-cycle` with `mac`, `port_idx`;
  HA button per PoE port).
- `set/client/<key>/blocked` (`cmd/stamgr` `block-sta` / `unblock-sta`, state from `stat/sta`
  `blocked`, HA switch), `set/client/<key>/kick` (`kick-sta`), `set/client/<key>/authorize`
  (`authorize-guest` with `minutes`; HA button) for guest portals.
- No optimistic state: after a command, re-poll the affected object and publish what the
  controller says, so a failed command snaps back instead of lying (today `set/wifi` waits for
  the next poll; make it an immediate targeted refresh).

### Client filtering and presence

- `--clients` grows from a name/mac list to dimensions: `--client-types wired,wireless`,
  `--client-ssids`, `--client-networks` (name or VLAN id — via `network`/`vlan` in `stat/sta`,
  or by matching the ip against the network subnets when only the Integration API is available),
  `--no-client-guests`, `--client-exclude <macs>` (highest priority), `--client-max <n>` (sorted
  by mac before truncation so the set is stable; one warning per poll when it bites). A filter
  on a dimension the current credentials cannot serve is a startup error, not a silently empty
  filter.
- `--ha-clients` as a list (`all`, `none`, or the same filter syntax) so the presence topics
  cover everyone while HA only gets a few trackers. Clients are the entity explosion: a busy
  network is hundreds of HA devices.
- Consider a non-zero default for `--presence-timeout` (300 s) once a real controller shows how
  often power-saving phones drop out of `stat/sta` between polls; warn when it is below
  `2 × --poll-interval`.
- Per-client signal strength (`client/<key>/signal`, dBm, HA `signal_strength` diagnostic
  sensor) and uptime as optional items — off by default, they churn on every poll.
- Track guests separately (`client_count/guest`; `guest: true` in details is already there).
- `--forget-after <days>`: clear the retained topics of clients that have not been seen for a
  long time (today a client that was seen once keeps its `present: false` topics forever).
- Use `sta:sync` websocket frames (if they exist) to shorten the poll interval to a safety net;
  the event stream stays "event as trigger, poll as truth".

### Home Assistant

- **Topology**: `via_device` should follow the real network — client → its AP / switch, AP →
  switch, switch → gateway (from `uplink.uplink_mac` / `uplinkDeviceId`) — instead of every
  device hanging off the bridge. The gateway is the root; the bridge device keeps the site-wide
  entities.
- Device entities get a second availability source (`device/<key>/online`), so a switch that
  went offline shows `unavailable` rather than stale CPU numbers.
- `device_class` / `state_class` wherever they apply (`connectivity`, `update`, `duration`,
  `data_rate`, `signal_strength`, `power` for PoE watts); never `total_increasing` — UniFi
  reports rates, not counters.
- Stable, readable entity ids: seed `default_entity_id` (and `object_id` for HA < 2026.4) from
  the device name + english key, so an automation references
  `sensor.unifi_office_switch_cpu` and not a mac — core `entity()` feature, shared with the
  other adapters.
- Discovery hygiene (core): republish after HA's birth message on `homeassistant/status`
  (with a grace of a few seconds); an opt-out cross-run **orphan sweep** on start — read what is
  retained under `<ha-prefix>/device/+/config`, clear the announcements this instance owns (id
  prefix **and** availability topic must match, so a second instance on the same broker is left
  alone) but no longer publishes — gated per class on that class having been polled at least
  once, an empty poll result is more often a permission problem than an empty site.

### Diagnostics and robustness

- `--once` / `scripts/dump.js`: log in, print the inventory (devices with uplink and ports,
  networks with VLANs, WLANs, clients with their key, SSID, network, VLAN and whether the
  current filter would publish them), the raw `stat/sta`, `stat/device`, `rest/wlanconf`,
  `stat/health` responses, a minute of websocket frames and the OpenAPI document — redacted
  (macs, ips, names, serials with a fixed substitution) — without a broker. This is how fixtures
  from real controllers get into `test/fixtures/` and how users check filters before enabling
  client publication.
- Rate limits: honour `429` + `Retry-After`; exponential backoff with jitter on 5xx / network
  errors instead of the fixed 10 s retry; one re-login per burst of concurrent 401s (some
  versions lock the account after a few failed logins).
- `--ca-file` as the better alternative to `-k`: keep verification on and trust the console's
  own certificate. Warn once at startup when `-k` is used.
- An unreachable console for > 5 min sets every device to `online: false` (entities go
  unavailable) instead of keeping stale values forever; `connected` already drops to `1`.
- Credentials never in logs, `<name>/info`, `--config-schema` output (`x-secret` is there) or
  error messages — `node:https` errors can carry the full url.
- Multi-site: one instance per site (`--site`) stays the model; if several sites per instance are
  wanted, the topic layout would need `<site>/` as a prefix, which is a breaking change — decide
  before 2.1.

### Polling cadences

Today everything is one `--poll-interval`. Split by how often it changes: clients (presence
latency, 30 s), devices (state, `upgradable`, 60 s), health (60 s), and a slow loop (1 h) for the
things that need one request per object (device details / ports, network subnets, WLAN and
network catalogue). With the classic API a single `stat/device` returns list, details and stats
in one request — prefer it when available. A bounded concurrency (4) for any per-object fan-out:
the console also routes the household's traffic.

### Housekeeping

- Deprecate `ubnt-unifi` on npm (`npm deprecate ubnt-unifi "unifi2mqtt 2 talks to the controller
directly"`) once 2.0 is out and confirmed working.
- Forced periodic republish of all retained items (core `republishStatus()` on a timer, e.g.
  every 10 min) for subscribers without retained support.
