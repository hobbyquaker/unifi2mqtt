/**
 * The controller's event websocket (`/wss/s/<site>/events`, `/proxy/network/…` on UniFi OS): JSON
 * frames `{meta: {rc, message}, data: [...]}`. `meta.message === 'events'` carries the log events
 * the ui shows (client connected / disconnected / roamed, device adopted / restarted, ...); other
 * messages (`sta:sync`, `device:sync`, `alert`, ...) are periodic state dumps. Only `events` are
 * interpreted here; the rest is available raw via --publish-raw.
 *
 * Event keys look like EVT_WU_Connected: subject WU/WG/LU/LG = wireless/lan user/guest (clients),
 * AP/SW/GW/DM = devices, AD = admin. Client events carry `user` (mac), `hostname`, `ssid`, `ap`.
 */

import {EventEmitter} from 'node:events';

export const CLIENT_SUBJECTS = {WU: 'wireless', WG: 'wireless', LU: 'wired', LG: 'wired'};
export const DEVICE_SUBJECTS = {AP: 'ap', SW: 'switch', GW: 'gateway', DM: 'dream-machine'};

function snake(s) {
    return String(s)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toLowerCase();
}

/**
 * One raw event → {kind, subject, type, mac, hostname, ssid, ap, wired, guest, time, key, msg}.
 * Returns null for entries without an EVT_* key.
 */
export function normalizeEvent(raw) {
    if (!raw || typeof raw.key !== 'string') {
        return null;
    }
    const m = /^EVT_([A-Z]+)_(.+)$/.exec(raw.key);
    if (!m) {
        return null;
    }
    const [, subject, action] = m;
    const type = snake(action);
    const time = typeof raw.time === 'number' ? raw.time : Date.parse(raw.datetime) || undefined;
    const base = {key: raw.key, subject, type, time, msg: raw.msg};
    if (CLIENT_SUBJECTS[subject]) {
        const mac = raw.user || raw.guest || raw.client;
        return {
            kind: 'client',
            ...base,
            mac: mac ? String(mac).toLowerCase() : undefined,
            hostname: raw.hostname,
            ssid: raw.ssid,
            ap: raw.ap,
            wired: CLIENT_SUBJECTS[subject] === 'wired',
            guest: subject.endsWith('G'),
        };
    }
    if (DEVICE_SUBJECTS[subject]) {
        const mac = raw.ap || raw.sw || raw.gw || raw.dm;
        return {kind: 'device', ...base, mac: mac ? String(mac).toLowerCase() : undefined};
    }
    return {kind: 'other', ...base};
}

/** Parse one websocket frame → {type: meta.message, data: [...], events: [normalized...]} or null. */
export function parseMessage(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const type = (parsed.meta && parsed.meta.message) || 'unknown';
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const events = type === 'events' ? data.map(normalizeEvent).filter(Boolean) : [];
    return {type, data, events, raw: parsed};
}

/**
 * Keeps the websocket open: reconnects with a fixed delay, asks the controller for a fresh session
 * when the handshake is refused. Emits `open`, `close`, `message` ({type, data, events, raw}),
 * `event` (one normalized event) and `error`.
 */
export class EventStream extends EventEmitter {
    /**
     * @param {object} o
     * @param {import('./unifi.js').UnifiController} o.controller
     * @param {object} [o.log]
     * @param {Function} o.WebSocket ws-compatible constructor (url, {headers, rejectUnauthorized})
     * @param {number} [o.reconnectDelay] ms (default 10000)
     */
    constructor({controller, log, WebSocket, reconnectDelay = 10000}) {
        super();
        this.controller = controller;
        this.log = log || {debug() {}, info() {}, warn() {}, error() {}};
        this.WebSocket = WebSocket;
        this.reconnectDelay = reconnectDelay;
        this.ws = null;
        this.connected = false;
        this.stopped = true;
        this.timer = null;
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            try {
                ws.close();
            } catch {
                // already gone
            }
        }
        this.connected = false;
    }

    scheduleReconnect() {
        if (this.stopped || this.timer) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.connect();
        }, this.reconnectDelay);
        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    connect() {
        if (this.stopped || this.ws) {
            return;
        }
        if (!this.controller.loggedIn) {
            // the poll loop logs in; try again later instead of racing it
            this.scheduleReconnect();
            return;
        }
        const url = this.controller.websocketUrl();
        this.log.debug('unifi websocket connecting', url);
        let ws;
        try {
            ws = new this.WebSocket(url, {
                headers: this.controller.websocketHeaders(),
                rejectUnauthorized: !this.controller.insecure,
            });
        } catch (err) {
            this.emit('error', err);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.on('open', () => {
            this.connected = true;
            this.log.info('unifi websocket connected', url);
            this.emit('open');
        });
        ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (!msg) {
                this.log.debug('unifi websocket ignoring non-json frame');
                return;
            }
            this.log.debug('unifi ws <', msg.type, msg.events.length ? `${msg.events.length} events` : '');
            this.emit('message', msg);
            for (const evt of msg.events) {
                this.emit('event', evt);
            }
        });
        ws.on('unexpected-response', (_req, res) => {
            const status = res && res.statusCode;
            this.log.warn('unifi websocket handshake refused', status ? `http ${status}` : '');
            if (status === 401 || status === 403) {
                this.controller.invalidateSession();
            }
            // ws emits close/error after this; nothing else to do here
        });
        ws.on('error', (err) => {
            this.emit('error', err);
        });
        ws.on('close', (code, reason) => {
            if (this.ws === ws) {
                this.ws = null;
            }
            const was = this.connected;
            this.connected = false;
            if (was) {
                this.log.info('unifi websocket closed', code, String(reason || ''));
            }
            this.emit('close', {code, reason: String(reason || '')});
            this.scheduleReconnect();
        });
    }
}
