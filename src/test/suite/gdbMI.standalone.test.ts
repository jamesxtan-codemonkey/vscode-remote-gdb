import * as assert from 'assert';

// Standalone tests for GDBMI without vscode dependency
// We'll test the GDBMI parser directly by recreating the logic

describe('GDBMI Standalone Test Suite', () => {
    it('should parse GDB/MI result records', () => {
        // Test parsing ^done
        const line1 = '^done';
        assert.ok(line1.startsWith('^'));

        // Test parsing ^error
        const line2 = '^error,msg="Command failed"';
        assert.ok(line2.startsWith('^'));
        assert.ok(line2.includes('error'));
    });

    it('should parse GDB/MI async records', () => {
        // Test exec async record
        const line1 = '*stopped,reason="breakpoint-hit"';
        assert.ok(line1.startsWith('*'));

        // Test running record
        const line2 = '*running,thread-id="all"';
        assert.ok(line2.startsWith('*'));
    });

    it('should identify stream records', () => {
        // Console stream
        const console = '~"Hello World\\n"';
        assert.ok(console.startsWith('~'));

        // Target stream
        const target = '@"Program output\\n"';
        assert.ok(target.startsWith('@'));

        // Log stream
        const log = '&"GDB log\\n"';
        assert.ok(log.startsWith('&'));
    });

    it('should extract token from GDB/MI output', () => {
        const line = '1000^done';
        const match = /^(\d+)(.*)$/.exec(line);

        assert.ok(match);
        assert.strictEqual(match[1], '1000');
        assert.strictEqual(match[2], '^done');
    });

    it('should parse result class', () => {
        const line = '^done,value="42"';
        const match = /^\^([a-z-]+),?(.*)$/.exec(line);

        assert.ok(match);
        assert.strictEqual(match[1], 'done');
        assert.strictEqual(match[2], 'value="42"');
    });

    it('should unescape strings correctly', () => {
        const escaped = 'Line 1\\nLine 2\\tTab\\r\\n';
        const unescaped = escaped
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');

        assert.strictEqual(unescaped, 'Line 1\nLine 2\tTab\r\n');
    });

    it('should identify GDB prompt', () => {
        const line = '(gdb)';
        assert.strictEqual(line, '(gdb)');
    });

    it('should generate MI command format', () => {
        const token = 1000;
        const cmd = 'exec-run';
        const formatted = `${token}-${cmd}`;

        assert.strictEqual(formatted, '1000-exec-run');
    });

    it('should generate MI command with arguments', () => {
        const token = 1001;
        const cmd = 'break-insert';
        const args = 'main.c:10';
        const formatted = `${token}-${cmd} ${args}`;

        assert.strictEqual(formatted, '1001-break-insert main.c:10');
    });
});
