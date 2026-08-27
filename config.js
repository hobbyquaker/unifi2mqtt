import {parseConfig} from 'mqtt-interfaces-core';
import {OPTIONS, check} from './lib/options.js';
import pkg from './package.json' with {type: 'json'};

export {OPTIONS, check} from './lib/options.js';

export default parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'unifi'},
    check,
    examples: [
        [
            '$0 -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k -u mqtt://broker',
            'run in the foreground',
        ],
        [
            'sudo $0 --install -n unifi -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k -u mqtt://broker',
            'install as service unifi2mqtt@unifi',
        ],
    ],
});
