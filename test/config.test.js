import {test, describe} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {configSchema} from 'mqtt-interfaces-core';

import pkg from '../package.json' with {type: 'json'};

// config.js parses the command line at import time; controller/username/password are mandatory
process.env.UNIFI2MQTT_CONTROLLER = 'https://192.168.1.1';
process.env.UNIFI2MQTT_USERNAME = 'unifi2mqtt';
process.env.UNIFI2MQTT_PASSWORD = 's3cret';
const {OPTIONS, check} = await import('../config.js');

describe('config schema', () => {
    const schema = configSchema({pkg, envPrefix: 'UNIFI2MQTT', options: OPTIONS, defaults: {name: 'unifi'}});

    test('adapter metadata', () => {
        assert.equal(schema.title, 'unifi2mqtt');
        assert.equal(schema['x-adapter'].name, 'unifi2mqtt');
        assert.equal(
            schema['x-adapter'].version,
            JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
        );
        assert.equal(schema['x-adapter'].envPrefix, 'UNIFI2MQTT');
        assert.deepEqual(schema['x-adapter'].mqttInterfaces, {
            spec: '2.0',
            envPrefix: 'UNIFI2MQTT',
            needs: ['network'],
            serviceExtra: [],
        });
    });

    test('mandatory options and secrets', () => {
        assert.deepEqual(schema.required, ['controller', 'username', 'password']);
        assert.equal(schema.properties.password['x-secret'], true);
        assert.equal(schema.properties.password['x-env'], 'UNIFI2MQTT_PASSWORD');
        assert.equal(schema.properties.username['x-secret'], undefined);
        assert.equal(schema.properties['mqtt-password']['x-secret'], true);
    });

    test('adapter options with env names, defaults and enums', () => {
        const p = schema.properties;
        assert.equal(p.controller['x-env'], 'UNIFI2MQTT_CONTROLLER');
        assert.equal(p['poll-interval']['x-env'], 'UNIFI2MQTT_POLL_INTERVAL');
        assert.equal(p['poll-interval'].default, 60);
        assert.equal(p['presence-timeout'].default, 0);
        assert.deepEqual(p.mode.enum, ['auto', 'unifi-os', 'legacy']);
        assert.deepEqual(p['client-key'].enum, ['name', 'hostname', 'mac']);
        assert.equal(p.insecure.default, false);
        assert.equal(p.events.default, true);
        assert.equal(p['ha-clients'].default, true);
        assert.equal(p['publish-raw'].default, false);
        assert.equal(p.clients.type, 'array');
        assert.equal(p.name.default, 'unifi');
        assert.equal(p.site.default, 'default');
    });

    test('shared options are present, meta options are not', () => {
        const keys = Object.keys(schema.properties);
        for (const k of ['mqtt-url', 'mqtt-username', 'name', 'json-payloads', 'ha-discovery', 'verbosity']) {
            assert.ok(keys.includes(k), k);
        }
        for (const k of ['install', 'uninstall', 'config-schema', 'help']) {
            assert.ok(!keys.includes(k), k);
        }
    });

    test('check() rejects nonsense intervals', () => {
        assert.equal(check({pollInterval: 60, presenceTimeout: 0}), true);
        assert.throws(() => check({pollInterval: 1, presenceTimeout: 0}), /poll-interval/);
        assert.throws(() => check({pollInterval: 60, presenceTimeout: -1}), /presence-timeout/);
    });
});
