# Agent instructions — unifi2mqtt

## What this is

unifi2mqtt is an MQTT interface ("bridge"/"adapter") for Ubiquiti UniFi network controllers: client
presence (wireless and wired), UniFi devices (access points, switches, gateways) and WLANs are
published to an MQTT broker; WLANs and device LEDs can be switched. It talks to the controller's
JSON API over HTTPS and listens on its event websocket.

It follows the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) architecture
and, since 2.0, is built on
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (`../mqtt-interfaces-core`
when checked out next to this repo — generic fixes go there; its README is the complete guide to
building an adapter). Consistency with the core's conventions and with lgtv2mqtt / lgsb2mqtt /
cul2mqtt is a hard requirement. ROADMAP.md lists what is planned and, above all, what still needs
verification on real controllers — **nothing has been run against hardware yet**.

## MQTT conventions (mqtt-smarthome)

Topic structure is `<name>/<function>/<item>`, `<name>` = `--name` (default `unifi`):

- `<name>/connected` — retained `0` (LWT) / `1` (broker only) / `2` (broker + controller: the last
  poll succeeded).
- `<name>/status/<item>` — retained `{val, ts, lc}` (plain with `--no-json-payloads`). Items:
  `client/<key>/present`, `client/<key>/details`, `client_count[/wireless|/wired]`,
  `wifi/<ssid>/enabled`, `wifi/<ssid>/client_count`, `device/<key>/{online,led,clients,details}`.
  `event/client` is an **event** (not retained, object value with `type`).
- `<name>/set/wifi/<ssid>/enabled`, `<name>/set/device/<key>/led` — the only commands.
- `<name>/raw` — every websocket frame, opt-in (`--publish-raw`).
- `<name>/info`, `<name>/maintenance/set/{loglevel,restart}` — from the core.

`<key>` / `<ssid>` are `topicKey()`-sanitised names (whitespace, `/`, `+`, `#` → `_`). Renaming
items is a breaking change — document in CHANGELOG (migration table) and README.

## Code layout (ES modules, node >= 20.19)

- `index.js` — `createAdapter()` from the core plus the controller part: poll loop
  (devices → wlans → clients each `--poll-interval`, 10 s retry while disconnected), event stream
  wiring, `apply()` (publishes the model's change lists, debounces discovery, schedules presence
  expiry), `handleSet`, shutdown (stop stream, logout).
- `lib/unifi.js` — `UnifiController`: HTTP client on `node:https` with an injectable `request`
  transport. Flavour detection (`GET /` 200 → unifi-os, else legacy), login, cookie jar, CSRF token,
  re-login on 401/403, `api()` on site paths, `clients()/devices()/wlans()`, `setWlanEnabled()`,
  `setDeviceLed()`, `websocketUrl()/websocketHeaders()`. No `ws` dependency here.
- `lib/events.js` — `normalizeEvent()` / `parseMessage()` (pure) and `EventStream` (the websocket,
  `ws` injected as `WebSocket`, fixed-delay reconnect, invalidates the session on a 401 handshake).
- `lib/model.js` — `NetworkState`: the pure network model. Feed `applyClients()`, `applyEvent()`,
  `applyDevices()`, `applyWlans()`, `expire()`; get `{changes, clear, discovery}` back. Only
  changed values are reported (JSON compare per item). Presence rules live here.
- `lib/hadiscovery.js` — `discoveryModel()`: array of device blocks (bridge, one per UniFi device,
  one per client) via the core's `entity()`.
- `lib/install.js` — the core installer (`createInstaller`) wired to unifi2mqtt.
- `lib/options.js` — the adapter's option definitions (`OPTIONS`, `check`); `config.js` runs the
  core's `parseConfig()` on them at import and exports the parsed config (camelCased) plus
  re-exports `OPTIONS`/`check`. `scripts/dump.js` reuses the definitions without parsing the
  adapter's argv.
- `lib/redact.js` — `createRedactor()`: consistent redaction (macs, public ips, names, SSIDs,
  serials, secrets) for controller dumps. `scripts/dump.js` — the dump tool (README "Controller
  compatibility"); not part of the npm package.
- `test/` — node:test unit tests, no network: `test/fixtures/*.json` are hand-written API
  responses shaped after the documented UniFi API (not captured from a controller).
- `deploy.sh [user@host]` — dev deploy by tarball; same script as lgsb2mqtt, keep in sync.

## Style & practices

- Plain JavaScript, ES modules, no build step. 4-space indentation, semicolons, prettier (120 cols).
- Keep dependencies minimal: `mqtt-interfaces-core` and `ws` — that is all. No axios, no
  `node-unifi` (stale since 2023, heavy), no cookie libraries.
- Never make default config values point at personal infrastructure.
- Log at `debug` with the `unifi >` / `unifi <` / `unifi ws <` prefixes for raw exchanges; an
  unreachable controller is `warn` once, then `debug` until the message changes.
- Breaking changes to topics, payloads or options must be called out in CHANGELOG + README.

## Running

```
node index.js -c https://192.168.1.1 --username unifi2mqtt --password … -k -u mqtt://broker -v debug
```

Lint: `npm run lint` (eslint + prettier check), `npm run format` to fix. Tests: `npm test`.
CI runs both on Node 20/22/24. `node index.js --config-schema` must print valid JSON.

## Known weak spots (be careful around these)

- **Unverified API details** — see ROADMAP.md "Verification on real controllers". Do not "fix"
  paths or field names from memory; get a debug log or a fixture from a real controller first.
- Presence vs. polling lag: a client that connects via an event may be missing from the next
  `stat/sta` for a moment, so `applyClients()` keeps event-sighted clients for `EVENT_GRACE_MS`
  (30 s) or `--presence-timeout`, whichever is longer. Poll-sighted clients drop after
  `--presence-timeout` only.
- Client keys depend on `--client-key`; a client whose alias/hostname changes moves to a new
  topic and the old topics are cleared (`assignKey()`), duplicates get a `_<mac suffix>`. HA ids
  are mac-based and therefore stable across renames.
- `stat/sta` is polled in full each interval; on large networks this is a few hundred KB per
  minute. Per-client items are only re-published when they change.
