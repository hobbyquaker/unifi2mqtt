#!/usr/bin/env node

import WebSocket from 'ws';
import {createAdapter, toBoolean} from 'mqtt-interfaces-core';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {UnifiController} from './lib/unifi.js';
import {EventStream} from './lib/events.js';
import {NetworkState} from './lib/model.js';
import {discoveryModel} from './lib/hadiscovery.js';
import {retryDelay} from './lib/retry.js';

handleInstall(config);

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'unifi',
    info: () => ({
        controller: controller.url,
        site: config.site,
        mode: controller.mode || config.mode,
        events: config.events ? Boolean(stream && stream.connected) : false,
        pollInterval: config.pollInterval,
    }),
    discovery: () =>
        discoveryModel({
            name: config.name,
            site: config.site,
            clients: state.clientList(),
            devices: state.deviceList(),
            wlans: state.wlanList(),
            jsonPayloads: config.jsonPayloads,
            haClients: config.haClients,
        }),
    onSet: handleSet,
    onShutdown: shutdownDevice,
    // what a previous run left retained on the broker: reconciled after the first poll
    readback: true,
});
const {log, pubStatus, clearStatus, setDeviceConnected} = adapter;

const controller = new UnifiController({
    url: config.controller,
    username: config.username,
    password: config.password,
    site: config.site,
    mode: config.mode,
    insecure: config.insecure,
    log,
});

const state = new NetworkState({
    clientKey: config.clientKey,
    clients: config.clients,
    presenceTimeout: config.presenceTimeout,
});

let stream = null;
let pollTimer = null;
let expiryTimer = null;
let discoveryTimer = null;
let polling = false;
let lastError = null;
let rateLimited = 0; // consecutive logins the controller answered with 429
let reconciled = false; // the retained leftovers of a previous run were cleared

/*
 * publishing
 */

function apply({changes, clear, discovery}) {
    for (const item of clear) {
        clearStatus(item);
    }
    for (const {item, value, retain} of changes) {
        pubStatus(item, value, {retain: retain !== false});
    }
    if (discovery) {
        scheduleDiscovery();
    }
    scheduleExpiry();
}

function scheduleDiscovery() {
    adapter.markDiscoveryDirty();
    if (discoveryTimer) {
        return;
    }
    discoveryTimer = setTimeout(() => {
        discoveryTimer = null;
        adapter.publishDiscovery();
    }, 1000);
}

function scheduleExpiry() {
    if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
    const due = state.nextExpiry();
    if (due === null) {
        return;
    }
    expiryTimer = setTimeout(() => {
        expiryTimer = null;
        apply(state.expire());
    }, due + 50);
}

/**
 * Once, after the first complete poll: every client, device and wlan topic that a previous run
 * left retained on the broker and that this run has not published is gone from the controller's
 * point of view (a client that left while the adapter was down, a renamed client, a client now
 * excluded by --clients) — clear it, so nothing stays `present: true` from a previous life.
 */
function reconcileRetained() {
    if (typeof adapter.readbackDone !== 'function') {
        return; // mqtt-interfaces-core < 0.16: no readback
    }
    adapter.readbackDone().then(() => {
        if (adapter.shuttingDown) {
            return;
        }
        const stale = adapter.staleStatus().filter((item) => /^(client|device|wifi)\//.test(item));
        for (const item of stale) {
            clearStatus(item);
        }
        if (stale.length > 0) {
            log.info(
                'unifi cleared',
                stale.length,
                'retained item(s) of a previous run the controller no longer reports',
            );
        }
    });
}

/*
 * polling
 */

async function poll() {
    if (polling || adapter.shuttingDown) {
        return;
    }
    polling = true;
    let nextDelay = null;
    try {
        const [devices, wlans, clients] = await Promise.all([
            controller.devices(),
            controller.wlans(),
            controller.clients(),
        ]);
        log.debug('unifi got', devices.length, 'devices,', wlans.length, 'wlans,', clients.length, 'clients');
        apply(state.applyDevices(devices));
        apply(state.applyWlans(wlans));
        apply(state.applyClients(clients));
        if (!reconciled) {
            reconciled = true;
            reconcileRetained();
        }
        if (!adapter.deviceConnected) {
            log.info('unifi controller', controller.url, 'connected');
        }
        lastError = null;
        rateLimited = 0;
        setDeviceConnected(true);
        adapter.publishInfo();
        if (stream && !stream.connected) {
            stream.connect();
        }
    } catch (err) {
        const message = (err && err.message) || String(err);
        if (err && err.status === 429) {
            // a locked account: retrying quickly keeps it locked, so wait long and say so every time
            rateLimited += 1;
            nextDelay = retryDelay({
                status: 429,
                retryAfter: err.retryAfter,
                attempt: rateLimited,
                interval: config.pollInterval * 1000,
            });
            log.warn(
                'unifi controller',
                controller.url,
                'login rate-limited, next attempt in',
                Math.round(nextDelay / 1000),
                's:',
                message,
            );
            lastError = message;
        } else {
            rateLimited = 0;
            if (message !== lastError) {
                log.warn('unifi controller', controller.url, 'poll failed:', message);
                lastError = message;
            } else {
                log.debug('unifi poll failed again:', message);
            }
        }
        if (adapter.deviceConnected) {
            log.info('unifi controller', controller.url, 'disconnected');
        }
        setDeviceConnected(false);
    } finally {
        polling = false;
        schedulePoll(nextDelay);
    }
}

function schedulePoll(delay = null) {
    if (adapter.shuttingDown) {
        return;
    }
    if (pollTimer) {
        clearTimeout(pollTimer);
    }
    const interval = config.pollInterval * 1000;
    if (delay === null) {
        delay = adapter.deviceConnected ? interval : retryDelay({interval});
    }
    pollTimer = setTimeout(poll, delay);
}

async function refreshDevices() {
    apply(state.applyDevices(await controller.devices()));
}

async function refreshWlans() {
    apply(state.applyWlans(await controller.wlans()));
}

/*
 * events
 */

if (config.events) {
    stream = new EventStream({controller, log, WebSocket});
    stream.on('open', () => adapter.publishInfo());
    stream.on('close', () => adapter.publishInfo());
    stream.on('error', (err) => log.warn('unifi websocket', err.message || err));
    stream.on('message', (msg) => {
        if (config.publishRaw) {
            adapter.publish(adapter.topic('raw'), JSON.stringify(msg.raw));
        }
    });
    stream.on('event', (evt) => {
        log.debug('unifi event', evt.key, evt.mac || '', evt.msg || '');
        if (evt.kind === 'client') {
            apply(state.applyEvent(evt));
        } else if (evt.kind === 'device') {
            refreshDevices().catch((err) => log.debug('unifi device refresh failed:', err.message));
        }
    });
    // the stream connects once the poll loop has logged in (and is nudged after every poll)
    stream.start();
}

/*
 * set handling
 */

async function handleSet(parts, value, topic) {
    if (value === undefined) {
        log.warn('mqtt ignoring empty payload on', topic);
        return;
    }
    const [kind, key, item] = parts;

    if (kind === 'wifi' && parts.length === 3 && item === 'enabled') {
        const wlan = state.wlanByKey(key);
        if (!wlan) {
            throw new Error(`unknown wlan ${key}`);
        }
        const enabled = toBoolean(value);
        if (enabled === undefined) {
            throw new Error(`not a boolean: ${value}`);
        }
        log.info('unifi wlan', wlan.name, enabled ? 'enable' : 'disable');
        await controller.setWlanEnabled(wlan.id, enabled);
        await refreshWlans();
        return;
    }

    if (kind === 'device' && parts.length === 3 && item === 'led') {
        const device = state.deviceByKey(key);
        if (!device) {
            throw new Error(`unknown device ${key}`);
        }
        let mode = String(value).trim().toLowerCase();
        const asBool = toBoolean(value);
        if (asBool !== undefined) {
            mode = asBool ? 'on' : 'off';
        }
        if (!['on', 'off', 'default'].includes(mode)) {
            throw new Error(`led mode must be on, off or default: ${value}`);
        }
        log.info('unifi device', device.name, 'led', mode);
        await controller.setDeviceLed(device.id, mode);
        await refreshDevices();
        return;
    }

    if (kind === 'device' && parts.length === 3 && item === 'provision') {
        const device = state.deviceByKey(key);
        if (!device) {
            throw new Error(`unknown device ${key}`);
        }
        log.info('unifi device', device.name, 'force-provision');
        await controller.forceProvision(device.mac);
        return;
    }

    throw new Error(`unknown item ${parts.join('/')}`);
}

/*
 * lifecycle
 */

async function shutdownDevice() {
    for (const t of [pollTimer, expiryTimer, discoveryTimer]) {
        if (t) {
            clearTimeout(t);
        }
    }
    if (stream) {
        stream.stop();
    }
    await controller.logout();
}

adapter.start();
log.info('unifi controller', controller.url, 'site', config.site, '- trying to connect');
poll();
