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

## Open

### Verification on real controllers (nothing has been verified yet)

The implementation follows the widely documented API surface; every item below is an assumption
until someone runs it against hardware. Run with `--verbosity debug` and compare.

- **UniFi OS** (UDM / UDR / UCK G2 / Cloud Gateway): `GET /` → 200 for detection,
  `POST /api/auth/login` with `{username, password, rememberMe}` → `TOKEN` cookie +
  `x-csrf-token` header, api under `/proxy/network/api/s/<site>/…`, websocket at
  `/proxy/network/wss/s/<site>/events` accepting the `TOKEN` cookie, `POST /api/auth/logout`.
  Whether a read-only local user is enough for `stat/sta`, `stat/device`, `rest/wlanconf`.
- **Legacy controller** (self-hosted 5.x/6.x/7.x+, port 8443): `GET /` → 302 for detection
  (older versions may answer differently — `--mode legacy` is the escape hatch),
  `POST /api/login` → `unifises` + `csrf_token` cookies, `X-Csrf-Token` header on PUT.
- **Websocket event payloads**: field names (`user`, `guest`, `hostname`, `ssid`, `ap`, `time`)
  and keys (`EVT_WU_Connected`, `EVT_WU_Disconnected`, `EVT_WU_Roam`, `EVT_LU_*`, `EVT_LG_*`) —
  from the 1.x adapter and `ubnt-unifi`; `EVT_LU_*`/`EVT_LG_*` for wired clients need confirming.
  Whether the controller also pushes `sta:sync` / `client:sync` frames that could replace polling.
- **`stat/sta` field names** on current firmware: `name` (alias), `hostname`, `essid`, `ap_mac`,
  `sw_mac`, `is_wired`, `is_guest`, `network`, `last_seen`. Newer UniFi OS versions also offer
  `/proxy/network/v2/api/site/<site>/clients/active` — evaluate as alternative.
- **`stat/device`**: `state === 1` for online, `led_override` values, `num_sta`; `PUT
rest/device/<id> {led_override}` still accepted (the 1.x adapter used it).
- **WLAN toggle**: `PUT rest/wlanconf/<id> {enabled}` (1.x used `POST upd/wlanconf/<id>`); how
  long the controller takes to reflect the change in `rest/wlanconf`.
- **Session lifetime** of a UniFi OS token with `rememberMe: false` and whether the websocket is
  closed when it expires (the re-login path exists, the trigger is unverified).
- Multi-site legacy controllers (`--site` other than `default`) and site ids vs. display names.

### Features

- `set/device/<key>/restart` and `set/device/<key>/locate` (`cmd/devmgr` `restart` / `set-locate`)
  as HA buttons; `set/client/<key>/block` (`cmd/stamgr` `block-sta`) for parental-control style
  automations — opt-in, they are actions with consequences.
- Per-client signal strength (`client/<key>/signal`, dBm) and uptime as optional items /
  HA diagnostic sensors — off by default, they churn on every poll.
- `--forget-after <days>`: clear the retained topics of clients that have not been seen for a long
  time (today a client that was seen once keeps its `present: false` topics forever).
- Use `sta:sync` websocket frames (if they exist) to shorten the poll interval to a safety net.
- Device stats (`uptime`, `cpu`, `mem`, `temperature`, port/radio counters) behind an option.
- `--ha-clients` as a list (`all`, `none`, or the same filter syntax as `--clients`) so the
  presence topics can cover everyone while HA only gets a few trackers.
- Track guests separately (`client_count/guest`, `guest: true` in details is already there).

### Housekeeping

- Deprecate `ubnt-unifi` on npm (`npm deprecate ubnt-unifi "unifi2mqtt 2 talks to the controller
directly"`) once 2.0 is out and confirmed working.
- A `scripts/dump.js` that logs in and prints the raw `stat/sta`, `stat/device`, `rest/wlanconf`
  responses plus a minute of websocket frames (secrets redacted) to collect fixtures from real
  controllers.
