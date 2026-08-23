/**
 * Home Assistant MQTT discovery (device-based, HA >= 2024.11) — the device blocks for the core's
 * `discovery()` hook. Pure: the network state's client/device/wlan lists in, device blocks out.
 *
 * Three kinds of HA devices, all linked via `via_device` to the bridge:
 *   - the bridge (controller/site): client counts, one switch + count sensor per wlan
 *   - one device per UniFi device (ap, switch, gateway): connectivity, led select, client count
 *   - one device per client (--ha-clients): a router device_tracker with the details as attributes
 */

import {entity, discoveryId} from 'mqtt-interfaces-core';

export const ADAPTER = 'unifi2mqtt';

const DEVICE_TYPES = {uap: 'Access point', usw: 'Switch', ugw: 'Gateway', udm: 'Dream Machine', uxg: 'Gateway'};

function macId(mac) {
    return String(mac).replace(/[^0-9a-f]/gi, '');
}

/**
 * @param {object} input
 * @param {string} input.name instance name / topic prefix
 * @param {string} [input.site]
 * @param {Array<{mac, key, name, wired}>} [input.clients]
 * @param {Array<{mac, key, name, model, type, version}>} [input.devices]
 * @param {Array<{key, name, guest}>} [input.wlans]
 * @param {boolean} [input.jsonPayloads]
 * @param {boolean} [input.haClients] announce clients
 * @returns {Array<{id: string, device: object, components: object}>}
 */
export function discoveryModel({
    name,
    site = 'default',
    clients = [],
    devices = [],
    wlans = [],
    jsonPayloads = true,
    haClients = true,
}) {
    const bridgeId = discoveryId(ADAPTER, name);
    const e = (id, item, platform, label, more = {}) =>
        entity({id, name, item, platform, label, jsonPayloads, ...more});
    const bool = {pl_on: 'true', pl_off: 'false'};

    const bridge = {
        id: bridgeId,
        device: {name, mf: 'Ubiquiti', mdl: 'UniFi Network', ...(site !== 'default' && {hw: `site ${site}`})},
        components: {
            client_count: e(bridgeId, 'client_count', 'sensor', 'Clients', {
                icon: 'mdi:lan-connect',
                extra: {stat_cla: 'measurement'},
            }),
            client_count_wireless: e(bridgeId, 'client_count/wireless', 'sensor', 'Wireless clients', {
                icon: 'mdi:wifi',
                extra: {stat_cla: 'measurement'},
            }),
            client_count_wired: e(bridgeId, 'client_count/wired', 'sensor', 'Wired clients', {
                icon: 'mdi:ethernet',
                extra: {stat_cla: 'measurement'},
            }),
        },
    };
    for (const wlan of wlans) {
        bridge.components[`wifi_${wlan.key}_enabled`] = e(bridgeId, `wifi/${wlan.key}/enabled`, 'switch', wlan.name, {
            icon: wlan.guest ? 'mdi:wifi-lock-open' : 'mdi:wifi',
            category: 'config',
            command: true,
            extra: {...bool, stat_on: 'true', stat_off: 'false'},
        });
        bridge.components[`wifi_${wlan.key}_client_count`] = e(
            bridgeId,
            `wifi/${wlan.key}/client_count`,
            'sensor',
            `${wlan.name} clients`,
            {icon: 'mdi:account-multiple', extra: {stat_cla: 'measurement'}},
        );
    }

    const result = [bridge];

    for (const dev of devices) {
        const id = `${bridgeId}_dev_${macId(dev.mac)}`;
        result.push({
            id,
            device: {
                name: dev.name,
                mf: 'Ubiquiti',
                ...(dev.model && {mdl: dev.model}),
                ...(dev.version && {sw: dev.version}),
                ...(DEVICE_TYPES[dev.type] && {mdl_id: DEVICE_TYPES[dev.type]}),
                cns: [['mac', dev.mac]],
                via_device: bridgeId,
            },
            components: {
                online: e(id, `device/${dev.key}/online`, 'binary_sensor', 'Online', {
                    category: 'diagnostic',
                    extra: {...bool, dev_cla: 'connectivity'},
                }),
                led: e(id, `device/${dev.key}/led`, 'select', 'LED', {
                    icon: 'mdi:led-on',
                    category: 'config',
                    command: true,
                    extra: {options: ['on', 'off', 'default']},
                }),
                clients: e(id, `device/${dev.key}/clients`, 'sensor', 'Clients', {
                    icon: 'mdi:account-multiple',
                    extra: {stat_cla: 'measurement'},
                }),
            },
        });
    }

    if (haClients) {
        for (const client of clients) {
            const id = `${bridgeId}_client_${macId(client.mac)}`;
            result.push({
                id,
                device: {name: client.name, cns: [['mac', client.mac]], via_device: bridgeId},
                components: {
                    present: e(id, `client/${client.key}/present`, 'device_tracker', 'Presence', {
                        icon: client.wired ? 'mdi:ethernet' : 'mdi:wifi',
                        extra: {
                            val_tpl: jsonPayloads
                                ? "{{ 'home' if value_json.val else 'not_home' }}"
                                : "{{ 'home' if value == 'true' else 'not_home' }}",
                            pl_home: 'home',
                            pl_not_home: 'not_home',
                            src_type: 'router',
                            json_attr_t: `${name}/status/client/${client.key}/details`,
                            ...(jsonPayloads && {json_attr_tpl: '{{ value_json.val | tojson }}'}),
                        },
                    }),
                },
            });
        }
    }

    return result;
}
