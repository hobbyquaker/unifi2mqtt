/**
 * The network state as MQTT items — pure, clock injected, no I/O. Feed it controller responses
 * (stat/sta, stat/device, rest/wlanconf) and websocket events; it answers with the status items that
 * changed, the items to clear and whether the Home Assistant model needs re-publishing.
 *
 * Items (see README "Topics"):
 *   client/<key>/present            bool           presence, the device_tracker source
 *   client/<key>/details            object         mac, name, hostname, ip, wired, ssid, band, channel, ap, network
 *   event/client                    object, event  {type, client, mac, hostname, ssid, ap, wired, guest, time}
 *   client_count, client_count/wireless, client_count/wired
 *   wifi/<ssid>/enabled, wifi/<ssid>/client_count
 *   device/<key>/online, /led, /clients, /details
 *
 * Presence: a client is present when the last poll listed it or a connect/roam event arrived; it
 * becomes absent when a disconnect event arrives or a poll misses it — after `presenceTimeout`
 * seconds without a sighting (0 = at once). A client first seen through an event keeps a grace
 * period against the next poll, because the controller lists new clients with some delay.
 */

export const EVENT_GRACE_MS = 30000;

/** Topic level from a free-form name: no separators or wildcards, no whitespace. */
export function topicKey(name) {
    return (
        String(name || '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f]/g, '')
            .replace(/[\s/+#]+/g, '_')
            .replace(/^_+|_+$/g, '')
    );
}

export function normalizeMac(mac) {
    const hex = String(mac || '')
        .toLowerCase()
        .replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) {
        return String(mac || '').toLowerCase();
    }
    return hex.match(/.{2}/g).join(':');
}

/** Values from the CLI: `--clients a,b` arrives as ['a,b']. */
export function splitList(list) {
    return (Array.isArray(list) ? list : [list])
        .flatMap((v) => String(v ?? '').split(/[,\s]+/))
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Wifi band from the controller's radio code (ng = 2.4 GHz, na = 5 GHz, 6e = 6 GHz). */
export function bandOf(radio) {
    switch (radio) {
        case 'ng':
            return '2.4 GHz';
        case 'na':
            return '5 GHz';
        case '6e':
            return '6 GHz';
        default:
            return null;
    }
}

export class NetworkState {
    /**
     * @param {object} [o]
     * @param {'name' | 'hostname' | 'mac'} [o.clientKey]
     * @param {string[]} [o.clients] publish only these (mac, name or hostname; case-insensitive)
     * @param {number} [o.presenceTimeout] seconds
     * @param {() => number} [o.now]
     */
    constructor({clientKey = 'name', clients = [], presenceTimeout = 0, now = Date.now} = {}) {
        this.clientKey = clientKey;
        this.filter = new Set(splitList(clients).map((s) => s.toLowerCase()));
        this.presenceTimeout = Math.max(0, Number(presenceTimeout) || 0) * 1000;
        this.now = now;
        this.clients = new Map(); // mac → client
        this.devices = new Map(); // mac → device
        this.wlans = new Map(); // id → wlan
        this.published = new Map(); // item → JSON of last value
        this.keys = new Map(); // client key → mac
    }

    /*
     * helpers
     */

    /** Collects changes; `set` only reports a value when it differs from what was reported before. */
    collector() {
        const changes = [];
        const cleared = [];
        let discovery = false;
        return {
            changes,
            set: (item, value) => {
                const json = JSON.stringify(value);
                if (this.published.get(item) !== json) {
                    this.published.set(item, json);
                    changes.push({item, value});
                }
            },
            event: (item, value) => changes.push({item, value, retain: false}),
            clear: (item) => {
                if (this.published.delete(item)) {
                    cleared.push(item);
                }
            },
            discovery: () => {
                discovery = true;
            },
            result: () => ({changes, clear: cleared, discovery}),
        };
    }

    included(client) {
        if (this.filter.size === 0) {
            return true;
        }
        return [client.mac, client.name, client.hostname]
            .filter(Boolean)
            .some((v) => this.filter.has(String(v).toLowerCase()));
    }

    keyFor(client) {
        let base;
        if (this.clientKey === 'mac') {
            base = client.mac;
        } else if (this.clientKey === 'hostname') {
            base = client.hostname || client.mac;
        } else {
            base = client.name || client.hostname || client.mac;
        }
        let key = topicKey(base) || client.mac;
        const owner = this.keys.get(key);
        if (owner && owner !== client.mac) {
            key = `${key}_${client.mac.replace(/:/g, '').slice(-4)}`;
        }
        return key;
    }

    /** (Re)assign the topic key of a client; clears the old topics when it changes. */
    assignKey(client, c) {
        const key = this.keyFor(client);
        if (client.key && client.key !== key) {
            this.keys.delete(client.key);
            c.clear(`client/${client.key}/present`);
            c.clear(`client/${client.key}/details`);
            c.discovery();
        }
        if (!client.key || client.key !== key) {
            client.key = key;
            this.keys.set(key, client.mac);
            c.discovery();
        }
    }

    deviceName(mac) {
        const dev = mac && this.devices.get(normalizeMac(mac));
        return dev ? dev.name : mac || undefined;
    }

    details(client) {
        return {
            mac: client.mac,
            name: client.name || null,
            hostname: client.hostname || null,
            ip: client.ip || null,
            wired: Boolean(client.wired),
            ssid: client.wired ? null : client.ssid || null,
            band: client.wired ? null : bandOf(client.radio),
            channel: client.wired ? null : (client.channel ?? null),
            ap: this.deviceName(client.apMac) || null,
            network: client.network || null,
        };
    }

    publishClient(client, c) {
        if (!this.included(client)) {
            return;
        }
        this.assignKey(client, c);
        c.set(`client/${client.key}/present`, client.present);
        c.set(`client/${client.key}/details`, this.details(client));
    }

    publishCounts(c) {
        let wired = 0;
        let wireless = 0;
        const perSsid = new Map([...this.wlans.values()].map((w) => [w.name, 0]));
        for (const client of this.clients.values()) {
            if (!client.present) {
                continue;
            }
            if (client.wired) {
                wired += 1;
            } else {
                wireless += 1;
                if (client.ssid) {
                    perSsid.set(client.ssid, (perSsid.get(client.ssid) || 0) + 1);
                }
            }
        }
        c.set('client_count', wired + wireless);
        c.set('client_count/wireless', wireless);
        c.set('client_count/wired', wired);
        for (const [ssid, count] of perSsid) {
            c.set(`wifi/${topicKey(ssid)}/client_count`, count);
        }
    }

    /*
     * clients
     */

    upsertClient(mac, fields) {
        let client = this.clients.get(mac);
        if (!client) {
            client = {mac, present: false, lastSeen: 0, seenBy: null, key: null};
            this.clients.set(mac, client);
        }
        for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined) {
                client[k] = v;
            }
        }
        return client;
    }

    /** Full client list from stat/sta. Clients missing from it are absent (after the timeout). */
    applyClients(list) {
        const c = this.collector();
        const now = this.now();
        const seen = new Set();
        for (const raw of list || []) {
            if (!raw || !raw.mac) {
                continue;
            }
            const mac = normalizeMac(raw.mac);
            seen.add(mac);
            const client = this.upsertClient(mac, {
                name: raw.name || undefined,
                hostname: raw.hostname || undefined,
                ip: raw.ip || undefined,
                wired: Boolean(raw.is_wired),
                ssid: raw.essid || undefined,
                radio: raw.radio || undefined,
                channel: Number.isInteger(raw.channel) ? raw.channel : undefined,
                apMac: raw.ap_mac ? normalizeMac(raw.ap_mac) : raw.sw_mac ? normalizeMac(raw.sw_mac) : undefined,
                network: raw.network || undefined,
                guest: raw.is_guest === true ? true : undefined,
            });
            if (!client.name && raw.name === '') {
                client.name = undefined;
            }
            client.present = true;
            client.pendingAbsent = false;
            client.lastSeen = now;
            client.seenBy = 'poll';
            this.publishClient(client, c);
        }
        for (const client of this.clients.values()) {
            if (seen.has(client.mac) || !client.present) {
                continue;
            }
            const grace =
                client.seenBy === 'event' ? Math.max(this.presenceTimeout, EVENT_GRACE_MS) : this.presenceTimeout;
            if (now - client.lastSeen >= grace) {
                client.present = false;
                this.publishClient(client, c);
            }
        }
        this.publishCounts(c);
        return c.result();
    }

    /** One normalized websocket event (see events.js). Device events only refresh nothing here. */
    applyEvent(evt) {
        const c = this.collector();
        if (!evt || evt.kind !== 'client' || !evt.mac) {
            return c.result();
        }
        const now = this.now();
        const mac = normalizeMac(evt.mac);
        const client = this.upsertClient(mac, {
            hostname: evt.hostname || undefined,
            wired: evt.wired,
            ssid: evt.wired ? undefined : evt.ssid || undefined,
            apMac: evt.ap ? normalizeMac(evt.ap) : undefined,
            guest: evt.guest || undefined,
        });
        const time = typeof evt.time === 'number' && evt.time > 0 ? Math.min(evt.time, now) : now;
        switch (evt.type) {
            case 'connected':
            case 'roam':
            case 'roam_radio':
                client.present = true;
                client.pendingAbsent = false;
                client.lastSeen = Math.max(time, client.lastSeen);
                client.seenBy = 'event';
                break;
            case 'disconnected':
                client.lastSeen = Math.max(time, client.lastSeen);
                client.seenBy = 'event';
                if (this.presenceTimeout === 0 || now - client.lastSeen >= this.presenceTimeout) {
                    client.present = false;
                    client.pendingAbsent = false;
                } else {
                    client.pendingAbsent = client.present;
                }
                break;
            default:
                break;
        }
        this.publishClient(client, c);
        if (this.included(client)) {
            c.event('event/client', {
                type: evt.type,
                client: client.key,
                mac: client.mac,
                hostname: client.hostname || null,
                ssid: client.wired ? null : client.ssid || null,
                ap: this.deviceName(client.apMac) || null,
                wired: Boolean(client.wired),
                guest: Boolean(client.guest),
                time: time,
                msg: evt.msg || null,
            });
        }
        if (evt.type === 'connected' || evt.type === 'disconnected') {
            this.publishCounts(c);
        }
        return c.result();
    }

    /** Report clients whose presence timeout elapsed since their disconnect event. */
    expire() {
        const c = this.collector();
        const now = this.now();
        let changed = false;
        for (const client of this.clients.values()) {
            if (client.present && client.pendingAbsent && now - client.lastSeen >= this.presenceTimeout) {
                client.present = false;
                client.pendingAbsent = false;
                this.publishClient(client, c);
                changed = true;
            }
        }
        if (changed) {
            this.publishCounts(c);
        }
        return c.result();
    }

    /** ms until the next pending presence expiry, or null. */
    nextExpiry() {
        const now = this.now();
        let next = null;
        for (const client of this.clients.values()) {
            if (client.present && client.pendingAbsent) {
                const due = Math.max(0, client.lastSeen + this.presenceTimeout - now);
                next = next === null ? due : Math.min(next, due);
            }
        }
        return next;
    }

    /*
     * devices
     */

    applyDevices(list) {
        const c = this.collector();
        const seen = new Set();
        for (const raw of list || []) {
            if (!raw || !raw.mac) {
                continue;
            }
            const mac = normalizeMac(raw.mac);
            seen.add(mac);
            const key = topicKey(raw.name) || mac;
            const previous = this.devices.get(mac);
            const device = {
                mac,
                id: raw._id,
                key,
                name: raw.name || mac,
                model: raw.model || null,
                type: raw.type || null,
                ip: raw.ip || null,
                version: raw.version || null,
                online: raw.state === 1,
                led: raw.led_override || 'default',
                clients: typeof raw.num_sta === 'number' ? raw.num_sta : null,
            };
            this.devices.set(mac, device);
            if (previous && previous.key !== key) {
                for (const item of ['online', 'led', 'clients', 'details']) {
                    c.clear(`device/${previous.key}/${item}`);
                }
                c.discovery();
            }
            if (
                !previous ||
                previous.name !== device.name ||
                previous.model !== device.model ||
                previous.version !== device.version
            ) {
                c.discovery();
            }
            c.set(`device/${key}/online`, device.online);
            c.set(`device/${key}/led`, device.led);
            if (device.clients !== null) {
                c.set(`device/${key}/clients`, device.clients);
            }
            c.set(`device/${key}/details`, {
                mac,
                name: device.name,
                model: device.model,
                type: device.type,
                ip: device.ip,
                version: device.version,
            });
        }
        for (const [mac, device] of this.devices) {
            if (!seen.has(mac)) {
                this.devices.delete(mac);
                for (const item of ['online', 'led', 'clients', 'details']) {
                    c.clear(`device/${device.key}/${item}`);
                }
                c.discovery();
            }
        }
        return c.result();
    }

    deviceByKey(key) {
        for (const device of this.devices.values()) {
            if (device.key === key) {
                return device;
            }
        }
        return undefined;
    }

    /*
     * wlans
     */

    applyWlans(list) {
        const c = this.collector();
        const seen = new Set();
        for (const raw of list || []) {
            if (!raw || !raw._id || !raw.name) {
                continue;
            }
            seen.add(raw._id);
            const previous = this.wlans.get(raw._id);
            const wlan = {
                id: raw._id,
                name: raw.name,
                key: topicKey(raw.name),
                enabled: raw.enabled !== false,
                guest: raw.is_guest === true,
            };
            this.wlans.set(raw._id, wlan);
            if (previous && previous.key !== wlan.key) {
                c.clear(`wifi/${previous.key}/enabled`);
                c.clear(`wifi/${previous.key}/client_count`);
            }
            if (!previous || previous.key !== wlan.key) {
                c.discovery();
            }
            c.set(`wifi/${wlan.key}/enabled`, wlan.enabled);
        }
        for (const [id, wlan] of this.wlans) {
            if (!seen.has(id)) {
                this.wlans.delete(id);
                c.clear(`wifi/${wlan.key}/enabled`);
                c.clear(`wifi/${wlan.key}/client_count`);
                c.discovery();
            }
        }
        this.publishCounts(c);
        return c.result();
    }

    wlanByKey(key) {
        for (const wlan of this.wlans.values()) {
            if (wlan.key === key) {
                return wlan;
            }
        }
        return undefined;
    }

    /*
     * views
     */

    /** Published clients (filter applied, key assigned) for discovery. */
    clientList() {
        return [...this.clients.values()]
            .filter((c) => c.key && this.included(c))
            .map((c) => ({mac: c.mac, key: c.key, name: c.name || c.hostname || c.mac, wired: Boolean(c.wired)}));
    }

    deviceList() {
        return [...this.devices.values()];
    }

    wlanList() {
        return [...this.wlans.values()];
    }
}
