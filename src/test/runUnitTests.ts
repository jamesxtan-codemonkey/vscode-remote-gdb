import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

async function main() {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 10000
    });

    const testsRoot = path.resolve(__dirname, './suite');

    try {
        const files = fs.readdirSync(testsRoot);

        files
            .filter(f => f.includes('.test.js'))
            .forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

        const failures = await new Promise<number>((resolve) => {
            mocha.run(failures => resolve(failures));
        });

        if (failures > 0) {
            console.error(`\n${failures} tests failed.`);
            process.exit(1);
        } else {
            console.log('\nAll tests passed!');
            process.exit(0);
        }
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
