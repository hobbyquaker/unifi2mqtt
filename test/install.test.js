import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {unitFile, envFile, envVarName, instanceName} from '../lib/install.js';
import {SHARED_OPTIONS} from 'mqtt-interfaces-core';

// config.js parses the command line at import time; controller/username/password are mandatory
process.env.UNIFI2MQTT_CONTROLLER = 'https://192.168.1.1';
process.env.UNIFI2MQTT_USERNAME = 'unifi2mqtt';
process.env.UNIFI2MQTT_PASSWORD = 's3cret';
const {OPTIONS} = await import('../config.js');

describe('install', () => {
    test('unit is the shared template layout', () => {
        const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/unifi2mqtt/index.js');
        assert.match(unit, /^Description=unifi2mqtt %i - UniFi network controller to MQTT bridge$/m);
        assert.match(unit, /^Documentation=https:\/\/github\.com\/hobbyquaker\/unifi2mqtt$/m);
        assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/unifi2mqtt\/%i\.env$/m);
        assert.match(unit, /^Environment=UNIFI2MQTT_NAME=%i$/m);
        assert.match(unit, /^SyslogIdentifier=unifi2mqtt@%i$/m);
        assert.match(unit, /^StateDirectory=unifi2mqtt\/%i$/m);
        assert.match(unit, /^Restart=always$/m);
        assert.match(unit, /^User=unifi2mqtt$/m);
    });

    test('env file carries the set options as UNIFI2MQTT_* variables, never the name', () => {
        const argv = {
            name: 'unifi',
            controller: 'https://192.168.1.1',
            username: 'unifi2mqtt',
            password: 's3cret',
            site: 'default',
            insecure: true,
            pollInterval: 60,
            clients: ['aa:bb:cc:dd:ee:01', 'printer'],
            mqttUrl: 'mqtt://broker',
            publishRaw: undefined,
        };
        Object.defineProperty(argv, '$options', {value: {...OPTIONS, ...SHARED_OPTIONS}});
        const out = envFile(argv);
        assert.match(out, /^UNIFI2MQTT_CONTROLLER=https:\/\/192\.168\.1\.1$/m);
        assert.match(out, /^UNIFI2MQTT_USERNAME=unifi2mqtt$/m);
        assert.match(out, /^UNIFI2MQTT_PASSWORD=s3cret$/m);
        assert.match(out, /^UNIFI2MQTT_INSECURE=true$/m);
        assert.match(out, /^UNIFI2MQTT_POLL_INTERVAL=60$/m);
        assert.match(out, /^UNIFI2MQTT_CLIENTS=aa:bb:cc:dd:ee:01,printer$/m);
        assert.match(out, /^UNIFI2MQTT_MQTT_URL=mqtt:\/\/broker$/m);
        assert.doesNotMatch(out, /UNIFI2MQTT_NAME|PUBLISH_RAW/);
        assert.match(out, /unifi2mqtt@unifi\.service/);
    });

    test('helpers', () => {
        assert.equal(envVarName('pollInterval', 'UNIFI2MQTT'), 'UNIFI2MQTT_POLL_INTERVAL');
        assert.equal(instanceName('unifi-office'), 'unifi-office');
        assert.throws(() => instanceName('my site'), /instance name/);
    });
});
