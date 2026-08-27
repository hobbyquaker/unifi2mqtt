#!/usr/bin/env node
/**
 * Controller dump: log in, fetch the api responses unifi2mqtt relies on (and a few it evaluates),
 * capture the event websocket for a while, and write everything **redacted** (see lib/redact.js)
 * to a directory — the raw material for fixtures from real controllers and for verifying the
 * assumptions listed in ROADMAP.md. No broker involved, nothing is written to the controller.
 *
 *   node scripts/dump.js -c https://192.168.1.1 --username … --password … -k [--seconds 120] [--out dump]
 *
 * The terminal summary (devices, wlans, clients with the topic keys unifi2mqtt would use) is NOT
 * redacted — it is for the operator; only the files in --out are meant to be shared.
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {parseConfig} from 'mqtt-interfaces-core';

import pkg from '../package.json' with {type: 'json'};
import {OPTIONS} from '../lib/options.js';
import {UnifiController} from '../lib/unifi.js';
import {EventStream} from '../lib/events.js';
import {createRedactor} from '../lib/redact.js';
import {topicKey} from '../lib/model.js';

const pick = (keys) => Object.fromEntries(keys.map((k) => [k, OPTIONS[k]]));
const config = parseConfig({
    pkg,
    scriptName: 'unifi2mqtt-dump',
    envPrefix: 'UNIFI2MQTT',
    options: {
        ...pick(['controller', 'username', 'password', 'site', 'mode', 'insecure', 'client-key']),
        seconds: {type: 'number', describe: 'seconds to capture the event websocket (0 = skip)', default: 60},
        out: {type: 'string', describe: 'output directory (created; existing files are overwritten)', default: 'dump'},
    },
    defaults: {name: 'unifi'},
    examples: [
        ['$0 -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k --seconds 120', 'dump to ./dump'],
    ],
    epilog: 'Reads UNIFI2MQTT_CONTROLLER, UNIFI2MQTT_USERNAME, UNIFI2MQTT_PASSWORD … like unifi2mqtt itself.',
});

const debug = config.verbosity === 'debug';
const log = {
    debug: (...a) => debug && console.error('  ', ...a),
    info: (...a) => console.error(...a),
    warn: (...a) => console.error('warn:', ...a),
    error: (...a) => console.error('error:', ...a),
};

const {redact, stats} = createRedactor({secrets: [config.password]});
const out = path.resolve(config.out);
fs.mkdirSync(out, {recursive: true});
const written = [];
function save(name, value) {
    const file = path.join(out, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(redact(value), null, 2) + '\n');
    written.push(name);
}

const controller = new UnifiController({
    url: config.controller,
    username: config.username,
    password: config.password,
    site: config.site,
    mode: config.mode,
    insecure: config.insecure,
    log,
});

const meta = {
    tool: `${pkg.name} ${pkg.version} scripts/dump.js`,
    node: process.version,
    date: new Date().toISOString(),
    controller: {url: controller.url, site: config.site, configuredMode: config.mode},
    requests: [],
};

/** GET an absolute path and store status + body under `name`; never throws. */
async function fetch(name, absPath, {method = 'GET', body} = {}) {
    const entry = {name, method, path: absPath};
    try {
        const res = await controller.raw(method, absPath, body);
        entry.status = res.status;
        entry.contentType = res.headers && res.headers['content-type'];
        let parsed;
        try {
            parsed = JSON.parse(res.body);
        } catch {
            parsed = undefined;
        }
        if (parsed !== undefined) {
            entry.items = Array.isArray(parsed.data) ? parsed.data.length : undefined;
            entry.meta = parsed.meta;
            save(`${name}.json`, parsed);
        } else {
            entry.bytes = (res.body || '').length;
            save(`${name}.txt`, redact(String(res.body || '').slice(0, 4000)));
        }
        log.info(`${entry.status} ${method} ${absPath}${entry.items !== undefined ? ` (${entry.items} items)` : ''}`);
        return parsed;
    } catch (err) {
        entry.error = err.message;
        log.warn(`${method} ${absPath}: ${err.message}`);
        return undefined;
    } finally {
        meta.requests.push(entry);
    }
}

const site = (p) => fetch(p.replace(/[/?].*$/, '').replace(/\//g, '_'), controller.sitePath(p));

async function main() {
    // flavour + login
    const root = await controller.raw('GET', '/');
    meta.detection = {getRoot: root.status, location: root.headers && root.headers.location};
    await controller.login();
    meta.controller.mode = controller.mode;
    meta.session = {
        cookies: [...controller.cookies.keys()],
        csrfToken: controller.csrfToken ? 'present' : 'none',
    };
    log.info(
        `logged in (${controller.mode}), cookies: ${meta.session.cookies.join(', ')}, csrf: ${meta.session.csrfToken}`,
    );

    // what unifi2mqtt uses
    const sysinfo = await site('stat/sysinfo');
    const self = await site('self');
    const devices = await site('stat/device');
    const clients = await site('stat/sta');
    const wlans = await site('rest/wlanconf');
    // what the roadmap wants
    const health = await site('stat/health');
    await site('rest/networkconf');
    await site('stat/event?_limit=100');
    await site('stat/alarm?_limit=20');
    const prefix = controller.apiPrefix;
    await fetch('v2_clients_active', `${prefix}/v2/api/site/${encodeURIComponent(config.site)}/clients/active`);
    await fetch('v2_devices', `${prefix}/v2/api/site/${encodeURIComponent(config.site)}/device`);
    await fetch('integration_info', `${prefix}/integration/v1/info`);
    await fetch('integration_openapi', `${prefix}/integration/openapi/document.json`);
    if (controller.mode === 'unifi-os') {
        await fetch('os_system', '/api/system');
        await fetch('os_users_self', '/api/users/self');
    } else {
        await fetch('legacy_self_sites', '/api/self/sites');
        await fetch('legacy_stat_sites', '/api/stat/sites');
    }

    // websocket
    if (config.seconds > 0) {
        await captureWebsocket(config.seconds);
    }

    meta.redaction = stats();
    save('meta.json', meta);
    await controller.logout();
    printSummary({sysinfo, self, devices, clients, wlans, health});
    log.info(`\nwritten to ${out}: ${written.join(', ')}`);
    log.info('files are redacted (macs keep their vendor part, public ips / names / ssids / secrets are replaced);');
    log.info('please skim them anyway before sharing. The summary above is NOT redacted.');
}

function captureWebsocket(seconds) {
    return new Promise((resolve) => {
        const frames = [];
        const keys = new Map();
        const stream = new EventStream({controller, log, WebSocket, reconnectDelay: 5000});
        const started = Date.now();
        const status = {connected: false, opens: 0, closes: [], errors: []};
        stream.on('open', () => {
            status.connected = true;
            status.opens += 1;
            log.info(`websocket connected, capturing ${seconds} s — now is the time to (dis)connect a client`);
        });
        stream.on('close', (c) => status.closes.push({...c, at: Date.now() - started}));
        stream.on('error', (err) => status.errors.push({message: err.message, at: Date.now() - started}));
        stream.on('message', (msg) => {
            frames.push({at: Date.now() - started, ...msg.raw});
            const label = msg.type + (msg.events.length ? `:${msg.events.map((e) => e.key).join(',')}` : '');
            keys.set(label, (keys.get(label) || 0) + 1);
            log.info(`ws < ${label}`);
        });
        stream.start();
        setTimeout(() => {
            stream.stop();
            meta.websocket = {
                url: controller.websocketUrl(),
                seconds,
                ...status,
                frames: frames.length,
                byType: Object.fromEntries(keys),
            };
            fs.writeFileSync(
                path.join(out, 'ws.jsonl'),
                frames.map((f) => JSON.stringify(redact(f))).join('\n') + (frames.length ? '\n' : ''),
            );
            written.push('ws.jsonl');
            log.info(
                `websocket: ${frames.length} frames, ${[...keys].map(([k, n]) => `${k}×${n}`).join(' ') || 'nothing'}`,
            );
            resolve();
        }, seconds * 1000);
    });
}

function printSummary({sysinfo, self, devices, clients, wlans, health}) {
    const p = (...a) => console.log(...a);
    const data = (x) => (x && Array.isArray(x.data) ? x.data : []);
    const info = data(sysinfo)[0] || {};
    p(
        `\n== controller: ${controller.mode}, version ${info.version || '?'}, ${info.name || ''} ${info.hostname || ''}`.trim(),
    );
    const me = data(self)[0] || {};
    p(
        `== user: ${me.name || config.username}, role ${me.site_role || me.role || '?'}, super admin: ${me.is_super || false}`,
    );
    p(`\n== devices (${data(devices).length})`);
    for (const d of data(devices)) {
        p(
            `  ${topicKey(d.name || d.mac)}: ${d.model || '?'} ${d.type || ''} v${d.version || '?'} state=${d.state}` +
                ` clients=${d.num_sta ?? '?'} led=${d.led_override || 'default'} upgradable=${d.upgradable ?? '?'}` +
                ` uplink=${(d.uplink && (d.uplink.uplink_mac || d.uplink.type)) || '?'} ports=${(d.port_table || []).length}`,
        );
    }
    p(`\n== wlans (${data(wlans).length})`);
    for (const w of data(wlans)) {
        p(`  ${topicKey(w.name)}: enabled=${w.enabled} guest=${w.is_guest || false}`);
    }
    const list = data(clients);
    p(`\n== clients (${list.length}) — key per --client-key ${config.clientKey}`);
    for (const c of list) {
        const key =
            config.clientKey === 'mac'
                ? c.mac
                : config.clientKey === 'hostname'
                  ? c.hostname || c.mac
                  : c.name || c.hostname || c.mac;
        p(
            `  ${topicKey(key)}: ${c.mac} ${c.is_wired ? 'wired' : `wifi ssid=${c.essid} ${c.radio || ''} ch${c.channel || '?'}`}` +
                ` ip=${c.ip || '-'} network=${c.network || '-'} vlan=${c.vlan ?? '-'} via=${c.ap_mac || c.sw_mac || '-'}` +
                ` signal=${c.signal ?? c.rssi ?? '-'} guest=${c.is_guest || false} last_seen=${c.last_seen || '-'}`,
        );
    }
    p(`\n== health`);
    for (const h of data(health)) {
        p(
            `  ${h.subsystem}: ${h.status}${h.wan_ip ? ` wan_ip=${h.wan_ip} latency=${h.latency}` : ''}${h.num_user !== undefined ? ` users=${h.num_user} guests=${h.num_guest}` : ''}`,
        );
    }
    p(`\n== endpoints`);
    for (const r of meta.requests) {
        p(
            `  ${r.status || 'ERR'} ${r.path}${r.items !== undefined ? ` ${r.items} items` : ''}${r.error ? ` ${r.error}` : ''}`,
        );
    }
}

main().catch((err) => {
    log.error(err.message);
    meta.error = err.message;
    save('meta.json', meta);
    process.exit(1);
});
