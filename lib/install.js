/**
 * --install / --uninstall: systemd template service unifi2mqtt@<name>, one instance per controller
 * or site (mqtt-interfaces-core installer): /etc/unifi2mqtt/<name>.env, /var/lib/unifi2mqtt/<name>/,
 * system user unifi2mqtt, optional shared /etc/mqtt-interfaces/broker.env.
 */

import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'unifi2mqtt';
export const ENV_PREFIX = 'UNIFI2MQTT';

const installer = createInstaller({
    service: SERVICE,
    envPrefix: ENV_PREFIX,
    description: `${SERVICE} %i - UniFi network controller to MQTT bridge`,
    documentation: 'https://github.com/hobbyquaker/unifi2mqtt',
});

export const {unitFile, envFile, installService, uninstallService, handle} = installer;
export {envVarName, instanceName} from 'mqtt-interfaces-core';
