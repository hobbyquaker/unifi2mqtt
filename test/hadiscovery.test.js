import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {devicePayload} from 'mqtt-interfaces-core';

import {discoveryModel} from '../lib/hadiscovery.js';

const pkg = {name: 'unifi2mqtt', version: '2.0.0', homepage: 'https://example.invalid'};

const clients = [
    {mac: 'aa:bb:cc:dd:ee:01', key: 'Basti_iPhone', name: 'Basti iPhone', wired: false},
    {mac: 'aa:bb:cc:dd:ee:02', key: 'printer', name: 'printer', wired: true},
];
const devices = [
    {
        mac: '78:8a:20:00:00:01',
        key: 'AP_Living_Room',
        name: 'AP Living Room',
        model: 'U6LR',
        type: 'uap',
        version: '6.6.77',
    },
];
const wlans = [
    {key: 'Home_WiFi', name: 'Home WiFi', guest: false},
    {key: 'Guests', name: 'Guests', guest: true},
];

/** What the core publishes for one block. */
function publish(block, name = 'unifi', prefix) {
    return devicePayload({pkg, name, prefix, ...block});
}

describe('discoveryModel', () => {
    test('bridge device: counts and one switch + sensor per wlan', () => {
        const [bridge] = discoveryModel({name: 'unifi', clients, devices, wlans});
        assert.equal(bridge.id, 'unifi2mqtt_unifi');
        const {topic, payload} = publish(bridge);
        assert.equal(topic, 'homeassistant/device/unifi2mqtt_unifi/config');
        assert.deepEqual(payload.dev, {ids: ['unifi2mqtt_unifi'], name: 'unifi', mf: 'Ubiquiti', mdl: 'UniFi Network'});
        assert.equal(payload.avty[0].t, 'unifi/connected');
        const c = bridge.components;
        assert.deepEqual(Object.keys(c), [
            'client_count',
            'client_count_wireless',
            'client_count_wired',
            'wifi_Home_WiFi_enabled',
            'wifi_Home_WiFi_client_count',
            'wifi_Guests_enabled',
            'wifi_Guests_client_count',
        ]);
        assert.equal(c.client_count.p, 'sensor');
        assert.equal(c.client_count.stat_t, 'unifi/status/client_count');
        assert.equal(c.client_count_wireless.stat_t, 'unifi/status/client_count/wireless');
        assert.equal(c.client_count_wireless.uniq_id, 'unifi2mqtt_unifi_client_count_wireless');
        assert.equal(c.wifi_Home_WiFi_enabled.p, 'switch');
        assert.equal(c.wifi_Home_WiFi_enabled.cmd_t, 'unifi/set/wifi/Home_WiFi/enabled');
        assert.equal(c.wifi_Home_WiFi_enabled.pl_on, 'true');
        assert.equal(c.wifi_Home_WiFi_enabled.name, 'Home WiFi');
        assert.equal(c.wifi_Guests_enabled.ic, 'mdi:wifi-lock-open');
        assert.equal(c.wifi_Guests_client_count.stat_t, 'unifi/status/wifi/Guests/client_count');
        assert.equal(c.client_count.val_tpl, '{{ value_json.val }}');
    });

    test('unifi devices: own HA device via the bridge with connectivity, led select, clients', () => {
        const model = discoveryModel({name: 'unifi', clients, devices, wlans});
        const ap = model.find((b) => b.id === 'unifi2mqtt_unifi_dev_788a20000001');
        assert.ok(ap);
        assert.deepEqual(ap.device, {
            name: 'AP Living Room',
            mf: 'Ubiquiti',
            mdl: 'U6LR',
            sw: '6.6.77',
            mdl_id: 'Access point',
            cns: [['mac', '78:8a:20:00:00:01']],
            via_device: 'unifi2mqtt_unifi',
        });
        assert.equal(ap.components.online.p, 'binary_sensor');
        assert.equal(ap.components.online.dev_cla, 'connectivity');
        assert.equal(ap.components.online.stat_t, 'unifi/status/device/AP_Living_Room/online');
        assert.equal(ap.components.led.p, 'select');
        assert.deepEqual(ap.components.led.options, ['on', 'off', 'default']);
        assert.equal(ap.components.led.cmd_t, 'unifi/set/device/AP_Living_Room/led');
        assert.equal(ap.components.clients.stat_t, 'unifi/status/device/AP_Living_Room/clients');
        const {payload} = publish(ap);
        assert.equal(payload.dev.ids[0], 'unifi2mqtt_unifi_dev_788a20000001');
    });

    test('clients: router device_tracker with details as attributes', () => {
        const model = discoveryModel({name: 'unifi', clients, devices, wlans});
        const phone = model.find((b) => b.id === 'unifi2mqtt_unifi_client_aabbccddee01');
        assert.deepEqual(phone.device, {
            name: 'Basti iPhone',
            cns: [['mac', 'aa:bb:cc:dd:ee:01']],
            via_device: 'unifi2mqtt_unifi',
        });
        const t = phone.components.present;
        assert.equal(t.p, 'device_tracker');
        assert.equal(t.stat_t, 'unifi/status/client/Basti_iPhone/present');
        assert.equal(t.val_tpl, "{{ 'home' if value_json.val else 'not_home' }}");
        assert.equal(t.pl_home, 'home');
        assert.equal(t.pl_not_home, 'not_home');
        assert.equal(t.src_type, 'router');
        assert.equal(t.json_attr_t, 'unifi/status/client/Basti_iPhone/details');
        assert.equal(t.json_attr_tpl, '{{ value_json.val | tojson }}');
        assert.equal(t.ic, 'mdi:wifi');
        assert.equal(t.cmd_t, undefined);
        assert.equal(t.uniq_id, 'unifi2mqtt_unifi_client_aabbccddee01_client_Basti_iPhone_present');
        const printer = model.find((b) => b.id === 'unifi2mqtt_unifi_client_aabbccddee02');
        assert.equal(printer.components.present.ic, 'mdi:ethernet');
        assert.equal(model.length, 4);
    });

    test('--no-ha-clients drops the client devices', () => {
        const model = discoveryModel({name: 'unifi', clients, devices, wlans, haClients: false});
        assert.deepEqual(
            model.map((b) => b.id),
            ['unifi2mqtt_unifi', 'unifi2mqtt_unifi_dev_788a20000001'],
        );
    });

    test('plain payloads: templates without value_json', () => {
        const model = discoveryModel({name: 'unifi', clients, jsonPayloads: false});
        assert.equal(model[0].components.client_count.val_tpl, undefined);
        const t = model[1].components.present;
        assert.equal(t.val_tpl, "{{ 'home' if value == 'true' else 'not_home' }}");
        assert.equal(t.json_attr_tpl, undefined);
    });

    test('unique ids are distinct and slash-free across all blocks', () => {
        const model = discoveryModel({name: 'unifi', clients, devices, wlans});
        const ids = model.flatMap((b) => Object.values(b.components).map((c) => c.uniq_id));
        assert.equal(new Set(ids).size, ids.length);
        assert.ok(ids.every((id) => !id.includes('/')));
    });

    test('site and odd names', () => {
        const [bridge] = discoveryModel({name: 'my unifi', site: 'office'});
        assert.equal(bridge.id, 'unifi2mqtt_my_unifi');
        assert.equal(bridge.device.hw, 'site office');
        assert.equal(publish(bridge, 'my unifi', 'ha').topic, 'ha/device/unifi2mqtt_my_unifi/config');
    });
});
