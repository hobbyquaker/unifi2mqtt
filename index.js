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

handleInstall(config);

const RETRY_INTERVAL = 10000;

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

/*
 * polling
 */

async function poll() {
    if (polling || adapter.shuttingDown) {
        return;
    }
    polling = true;
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
        if (!adapter.deviceConnected) {
            log.info('unifi controller', controller.url, 'connected');
        }
        lastError = null;
        setDeviceConnected(true);
        adapter.publishInfo();
        if (stream && !stream.connected) {
            stream.connect();
        }
    } catch (err) {
        const message = (err && err.message) || String(err);
        if (message !== lastError) {
            log.warn('unifi controller', controller.url, 'poll failed:', message);
            lastError = message;
        } else {
            log.debug('unifi poll failed again:', message);
        }
        if (adapter.deviceConnected) {
            log.info('unifi controller', controller.url, 'disconnected');
        }
        setDeviceConnected(false);
    } finally {
        polling = false;
        schedulePoll();
    }
}

function schedulePoll() {
    if (adapter.shuttingDown) {
        return;
    }
    if (pollTimer) {
        clearTimeout(pollTimer);
    }
    const interval = config.pollInterval * 1000;
    const delay = adapter.deviceConnected ? interval : Math.min(interval, RETRY_INTERVAL);
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
